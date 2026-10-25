/**
 * Tests d'intégration repost.js — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/repost-tests.js
 *
 * Simule la grille garde-robe Vinted (SSR), mocke fetch (pagination), charge
 * repost.js, puis vérifie : lecture de l'id dans l'URL, boucle de pagination
 * jusqu'à total_pages, remplacement du contenu de la grille, format prix,
 * recherche, tri et sélection locaux, repli sans card modèle, erreurs.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  console.error(
    "jsdom absent — lancez :  npm i --no-save jsdom  puis  node test/repost-tests.js"
  );
  process.exit(2);
}

const { SOURCES } = require("./sources");
const REPOST_SRC = fs.readFileSync(SOURCES.repost, "utf8");

// Card SSR reproduite à partir de vinted-pages/govaaaaa - member profile _ Vinted.htm
// (classes conservées pour le clonage, testids simplifiés).
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>govaaaaa - member profile | Vinted</title></head>
<body>
  <div class="site-content">
    <div class="u-flexbox" data-testid="closet-seller-filters">
      <button type="button" data-testid="closet-seller-filters-active" aria-pressed="true">
        <div class="web_ui__Chip__text">
          <span data-testid="closet-seller-filters-active--text">Actifs</span>
        </div>
      </button>
      <button type="button" data-testid="closet-seller-filters-hidden" aria-pressed="false">
        <div class="web_ui__Chip__text">
          <span data-testid="closet-seller-filters-hidden--text">Masqués</span>
        </div>
      </button>
    </div>
    <div class="u-ui-margin-horizontal-regular@portables" id="closet">
      <div class="Grid-module-scss-module__HmDNda__feed-grid">
        <div data-testid="grid-item" class="Grid-module-scss-module__HmDNda__feed-grid__item Grid-module-scss-module__HmDNda__feed-grid__item--one-fifth">
          <div class="Grid-module-scss-module__HmDNda__feed-grid__item-content">
            <div class="u-flex-grow u-fill-width">
              <div class="SellerItemBox-module-scss-module__l0NZ1G__new-item-box__container" data-testid="product-item-id-10409527710">
                <div class="u-position-relative SellerItemBox-module-scss-module__l0NZ1G__new-item-box__image-container">
                  <div class="web_ui__Image__image web_ui__Image__cover" data-testid="product-item-id-10409527710--image">
                    <img alt="Chemise blanche" class="web_ui__Image__content" data-testid="product-item-id-10409527710--image--img" src="old.jpg">
                  </div>
                  <a href="https://www.vinted.fr/items/10409527710" class="SellerItemBox-module-scss-module__l0NZ1G__new-item-box__overlay" data-testid="product-item-id-10409527710--overlay-link" title="Chemise blanche"><div></div></a>
                </div>
                <div class="SellerItemBox-module-scss-module__l0NZ1G__new-item-box__summary">
                  <div data-testid="product-item-id-10409527710--description">
                    <p data-testid="product-item-id-10409527710--description-title">1 vue</p>
                    <p data-testid="product-item-id-10409527710--description-subtitle">0 favoris</p>
                  </div>
                  <div data-testid="product-item-id-10409527710--title-container">
                    <p data-testid="product-item-id-10409527710--price-text">45,64&nbsp;€</p>
                  </div>
                  <div data-testid="product-item-id-10409527710--footer">
                    <button type="button" class="web_ui__Button__button web_ui__Button__outlined" data-testid="bump-button">
                      <span class="web_ui__Button__content">
                        <span class="web_ui__Button__label">Booster</span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// Fixture minimaliste : conteneur + grille vide (aucune card modèle).
const FIXTURE_NO_CARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Vinted</title></head>
<body>
  <div class="site-content">
    <div class="u-ui-margin-horizontal-regular@portables" id="closet">
      <div class="Grid-module-scss-module__HmDNda__feed-grid"></div>
    </div>
  </div>
</body>
</html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("condition non satisfaite : " + label);
}

function makeItem(overrides) {
  return Object.assign(
    {
      id: 1,
      title: "Article",
      price: { amount: "12.50", currency_code: "EUR" },
      path: "/items/1",
      url: "https://www.vinted.fr/items/1",
      view_count: 1,
      photos: [
        {
          is_main: true,
          url: "https://img.example/thumb.jpg",
          full_size_url: "https://img.example/full.jpg",
        },
      ],
    },
    overrides
  );
}

function pageBody(items, page, totalPages, totalEntries) {
  return {
    success: true,
    data: null,
    items,
    pagination: {
      current_page: page,
      total_pages: totalPages,
      total_entries: totalEntries == null ? items.length : totalEntries,
      per_page: 20,
    },
    code: 0,
  };
}

function boot({
  url = "https://www.vinted.fr/member/251881314",
  pages = {},
  images = {},
  detnivApi,
  html,
  cookie,
  runtimeCookie,
  runtimeHandler,
  runtimeUnresponsive,
  permissionGranted,
  seedStore,
  autoWardrobe,
  activePressed,
  ownProfile,
  csrf,
} = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html || FIXTURE_HTML, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;
  const fetchLog = [];
  const messages = [];
  const store = Object.assign({}, seedStore);
  let failNext = null;

  win.browser = {
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: store[key] } : {};
        },
        async set(obj) {
          Object.assign(store, obj);
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
    runtime:
      runtimeCookie === undefined &&
      !runtimeHandler &&
      !runtimeUnresponsive
        ? undefined
        : {
            async sendMessage(message) {
              messages.push(message);
              if (runtimeUnresponsive) return undefined;
              if (runtimeHandler) {
                const result = await runtimeHandler(message);
                if (result !== undefined) return result;
              }
              return { ok: true, value: runtimeCookie };
            },
          },
    permissions:
      permissionGranted === undefined && !runtimeHandler && !runtimeUnresponsive
        ? undefined
        : {
            async contains() {
              return permissionGranted !== false;
            },
            async request() {
              return permissionGranted !== false;
            },
          },
  };
  if (cookie) win.document.cookie = "v_uid=" + cookie + "; path=/";
  if (autoWardrobe) {
    win.sessionStorage.setItem("detnivRepostAuto", String(autoWardrobe));
  }
  if (ownProfile) {
    const filters = win.document.querySelector(
      '[data-testid="closet-seller-filters"]'
    );
    if (filters) {
      const draft = win.document.createElement("button");
      draft.type = "button";
      draft.setAttribute("data-testid", "closet-seller-filters-draft");
      draft.setAttribute("aria-pressed", "false");
      draft.innerHTML =
        '<div class="web_ui__Chip__text">' +
        '<span data-testid="closet-seller-filters-draft--text">Brouillons</span>' +
        "</div>";
      filters.appendChild(draft);
    }
  }
  if (csrf) {
    const script = win.document.createElement("script");
    script.textContent =
      'self.__next_f.push([1,"\\"CSRF_TOKEN\\":\\"' + csrf + '\\""])';
    win.document.body.appendChild(script);
  }

  const filterClicks = { active: 0, hidden: 0, draft: 0 };
  const filterButtons = {
    active: win.document.querySelector(
      '[data-testid="closet-seller-filters-active"]'
    ),
    hidden: win.document.querySelector(
      '[data-testid="closet-seller-filters-hidden"]'
    ),
    draft: win.document.querySelector(
      '[data-testid="closet-seller-filters-draft"]'
    ),
  };
  if (filterButtons.active && activePressed !== undefined) {
    filterButtons.active.setAttribute(
      "aria-pressed",
      activePressed ? "true" : "false"
    );
  }
  for (const [condition, button] of Object.entries(filterButtons)) {
    if (!button) continue;
    button.addEventListener("click", () => {
      filterClicks[condition]++;
      for (const [key, other] of Object.entries(filterButtons)) {
        if (!other) continue;
        other.setAttribute("aria-pressed", key === condition ? "true" : "false");
        other.classList.toggle("web_ui__Chip__activated", key === condition);
      }
    });
  }

  win.fetch = (fetchUrl, options) => {
    fetchLog.push({ url: String(fetchUrl), options });
    if (failNext) {
      const { status, message } = failNext;
      failNext = null;
      return Promise.resolve({
        ok: false,
        status,
        json: async () => ({ message }),
      });
    }
    const image = images[String(fetchUrl)];
    if (image) {
      const spec = typeof image === "function" ? image() : image;
      const status = spec.status || 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        blob: async () =>
          new win.Blob([spec.bytes || "image-bytes"], {
            type: spec.type || "image/jpeg",
          }),
      });
    }
    const route = pages[String(fetchUrl)];
    if (!route) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ message: "route inconnue : " + fetchUrl }),
      });
    }
    const body = typeof route === "function" ? route() : route;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };

  if (detnivApi) win.DetnivApi = detnivApi;
  win.eval(REPOST_SRC);
  return {
    win,
    doc: win.document,
    fetchLog,
    messages,
    store,
    failWith(status, message) {
      failNext = { status, message };
    },
    repost: () => win.DetnivRepost,
    closet: () => win.document.getElementById("closet"),
    activeFilterClicks: () => filterClicks.active,
    filterClicks: () => ({ ...filterClicks }),
  };
}

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    failures++;
    results.push({ name, ok: false, err });
  }
}

const WARDROBE = "https://www.vinted.fr/api/v2/wardrobe/251881314/items";
const FILTERS_SEL = '[data-testid="closet-seller-filters"]';
const GRID_SEL = '[class*="feed-grid"]';

(async () => {
  await test("repost : id de garde-robe lu dans l'URL", () => {
    const env = boot();
    assert.strictEqual(env.repost().wardrobeIdFromLocation(), "251881314");
  });

  await test("repost : URL non membre → id null", () => {
    const env = boot({ url: "https://www.vinted.fr/items/new" });
    assert.strictEqual(env.repost().wardrobeIdFromLocation(), null);
  });

  await test("repost : formatPrice (EUR, autre devise, invalide)", () => {
    const env = boot();
    const f = env.repost().formatPrice;
    assert.strictEqual(f({ amount: "45.64", currency_code: "EUR" }), "45,64 €");
    assert.strictEqual(f({ amount: "10", currency_code: "USD" }), "10,00 USD");
    assert.strictEqual(f(null), "");
    assert.strictEqual(f({ amount: "abc" }), "abc");
  });

  await test("repost : photoUrl préfère full_size_url de la photo principale", () => {
    const env = boot();
    const photoUrl = env.repost().photoUrl;
    assert.strictEqual(
      photoUrl(
        makeItem({
          photos: [
            { is_main: false, url: "https://img.example/other.jpg" },
            { is_main: true, url: "https://img.example/t.jpg", full_size_url: "https://img.example/f.jpg" },
          ],
        })
      ),
      "https://img.example/f.jpg"
    );
    assert.strictEqual(photoUrl(makeItem({ photos: [] })), "");
  });

  await test("repost : run boucle sur toutes les pages puis remplace la grille", async () => {
    const base = WARDROBE + "?page=";
    const suffix = "&per_page=20&cond=active";
    const env = boot({
      pages: {
        [base + "1" + suffix]: pageBody(
          [makeItem({ id: 11, title: "Chemise", price: { amount: "45.64", currency_code: "EUR" }, view_count: 1 }),
            makeItem({ id: 12, title: "Jean", price: { amount: "20", currency_code: "EUR" }, view_count: 42 })],
          1, 3, 45
        ),
        [base + "2" + suffix]: pageBody([makeItem({ id: 13 })], 2, 3, 45),
        [base + "3" + suffix]: pageBody([makeItem({ id: 14 }), makeItem({ id: 15 })], 3, 3, 45),
      },
    });

    const result = await env.repost().run();
    assert.strictEqual(result.count, 5);
    assert.strictEqual(result.pages, 3);

    // 3 requêtes, dans l'ordre des pages
    assert.strictEqual(env.fetchLog.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(env.fetchLog[i].url, base + (i + 1) + suffix);
      assert.strictEqual(env.fetchLog[i].options.headers.Accept, "application/json");
    }

    // Grille remplacée : 5 cards, aucune trace de l'ancien article SSR
    const items = env.closet().querySelectorAll('[data-testid="grid-item"]');
    assert.strictEqual(items.length, 5, "nombre de cards incorrect");
    assert.ok(!env.doc.body.textContent.includes("Chemise blanche"), "ancien contenu conservé");
    const ids = [...items].map(
      (n) => n.querySelector("[data-testid^='product-item-id-']").getAttribute("data-testid")
    );
    assert.deepStrictEqual(ids, [
      "product-item-id-11",
      "product-item-id-12",
      "product-item-id-13",
      "product-item-id-14",
      "product-item-id-15",
    ]);
  });

  await test("repost : run envoie le jeton CSRF lu dans la page", async () => {
    const env = boot({
      csrf: "test-csrf-token",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 16 })], 1, 1, 1
        ),
      },
    });
    await env.repost().run();
    assert.strictEqual(env.fetchLog.length, 1);
    assert.strictEqual(
      env.fetchLog[0].options.headers["X-CSRF-Token"],
      "test-csrf-token"
    );
  });

  await test("repost : run sélectionne Actifs avant de charger la garde-robe", async () => {
    const env = boot({
      activePressed: false,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 17, title: "Veste", brand_title: "Carhartt", size_title: "L" })],
          1, 1, 1
        ),
      },
    });

    const result = await env.repost().run();
    assert.strictEqual(env.activeFilterClicks(), 1, "Actifs non cliqué");
    assert.strictEqual(
      env.doc
        .querySelector('[data-testid="closet-seller-filters-active"]')
        .getAttribute("aria-pressed"),
      "true"
    );
    assert.strictEqual(env.fetchLog.length, 1, "fetch avant sélection du filtre");
    assert.strictEqual(result.count, 1);
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Veste");
  });

  await test("repost : recherche locale par titre, casse et accents ignorés", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({ id: 101, title: "Robe rouge", brand_title: "Zara", size_title: "M" }),
            makeItem({ id: 102, title: "Jean bleu", brand_title: "Levi's", size_title: "40" }),
            makeItem({ id: 103, title: "Écharpe en laine", brand_title: "COS", size_title: "Unique" }),
          ],
          1,
          1,
          3
        ),
      },
    });
    await env.repost().run();

    const filters = env.doc.querySelector(FILTERS_SEL);
    const input = filters.querySelector("#detniv-repost-search input");
    assert.ok(input, "champ de recherche absent");
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-search").length,
      1,
      "champ de recherche dupliqué"
    );

    const cards = () =>
      [...env.closet().querySelectorAll('[data-detniv-repost="1"]')];
    const visibleTitles = () =>
      cards()
        .filter((card) => !card.classList.contains("detniv-repost-hidden"))
        .map((card) => card.querySelector(".detniv-repost-name").textContent);

    input.value = "ROBE";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    assert.deepStrictEqual(visibleTitles(), ["Robe rouge"]);

    input.value = "echarpe";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    assert.deepStrictEqual(visibleTitles(), ["Écharpe en laine"]);

    input.value = "  ";
    input.dispatchEvent(new env.win.Event("input", { bubbles: true }));
    assert.strictEqual(visibleTitles().length, 3);
  });

  await test("repost : recherche conservée après re-rendu React et réinjectée", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({ id: 111, title: "Robe rouge" }),
            makeItem({ id: 112, title: "Jean bleu" }),
            makeItem({ id: 113, title: "Écharpe en laine" }),
          ],
          1,
          1,
          3
        ),
      },
    });
    const ssrCard = env.closet()
      .querySelector('[data-testid="grid-item"]')
      .cloneNode(true);
    await env.repost().run();

    const input = () => env.doc.querySelector("#detniv-repost-search input");
    input().value = "jean";
    input().dispatchEvent(new env.win.Event("input", { bubbles: true }));

    // React remplace toute la grille par sa card SSR.
    const grid = env.closet().querySelector(GRID_SEL);
    grid.replaceChildren(ssrCard.cloneNode(true));
    await sleep(250);

    const cards = () => [
      ...env.closet().querySelectorAll('[data-detniv-repost="1"]'),
    ];
    const visibleTitles = () =>
      cards()
        .filter((card) => !card.classList.contains("detniv-repost-hidden"))
        .map((card) => card.querySelector(".detniv-repost-name").textContent);

    assert.strictEqual(cards().length, 3, "grille non restaurée");
    assert.deepStrictEqual(visibleTitles(), ["Jean bleu"]);
    assert.strictEqual(input().value, "jean");

    // React remplace la barre de filtres : le champ doit revenir avec la saisie.
    env.doc.getElementById("detniv-repost-search").remove();
    await sleep(250);
    assert.ok(input(), "champ de recherche non réinjecté");
    assert.strictEqual(input().value, "jean");
    assert.deepStrictEqual(visibleTitles(), ["Jean bleu"]);
  });

  await test("repost : tri local par ID et prix, ordre par défaut rétabli", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 102,
              title: "B",
              price: { amount: "30", currency_code: "EUR" },
            }),
            makeItem({
              id: 101,
              title: "A",
              price: { amount: "10", currency_code: "EUR" },
            }),
            makeItem({
              id: 103,
              title: "C",
              price: { amount: "20", currency_code: "EUR" },
            }),
          ],
          1,
          1,
          3
        ),
      },
    });
    await env.repost().run();

    const select = () => env.doc.querySelector("#detniv-repost-sort");
    assert.ok(select(), "select de tri absent");
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-sort").length,
      1,
      "select de tri dupliqué"
    );
    assert.deepStrictEqual(
      [...select().options].map((option) => option.value),
      ["default", "id-desc", "id-asc", "price-asc", "price-desc"]
    );
    assert.strictEqual(select().value, "default");

    const names = () =>
      [...env.closet().querySelectorAll('[data-detniv-repost="1"]')].map(
        (card) => card.querySelector(".detniv-repost-name").textContent
      );
    const choose = async (value) => {
      select().value = value;
      select().dispatchEvent(new env.win.Event("change", { bubbles: true }));
      await sleep(20);
      return names();
    };

    assert.deepStrictEqual(names(), ["B", "A", "C"]);
    assert.deepStrictEqual(await choose("id-desc"), ["C", "B", "A"]);
    assert.deepStrictEqual(await choose("id-asc"), ["A", "B", "C"]);
    assert.deepStrictEqual(await choose("price-asc"), ["A", "C", "B"]);
    assert.deepStrictEqual(await choose("price-desc"), ["B", "C", "A"]);
    assert.deepStrictEqual(await choose("default"), ["B", "A", "C"]);
  });

  await test("repost : tri prix place les montants absents en fin de liste", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({ id: 401, title: "Sans prix", price: null }),
            makeItem({
              id: 402,
              title: "Dix",
              price: { amount: "10", currency_code: "EUR" },
            }),
            makeItem({
              id: 403,
              title: "Vingt",
              price: { amount: "20", currency_code: "EUR" },
            }),
            makeItem({ id: 404, title: "Sans prix 2", price: {} }),
          ],
          1,
          1,
          4
        ),
      },
    });
    await env.repost().run();

    const select = () => env.doc.querySelector("#detniv-repost-sort");
    const names = () =>
      [...env.closet().querySelectorAll('[data-detniv-repost="1"]')].map(
        (card) => card.querySelector(".detniv-repost-name").textContent
      );
    const choose = async (value) => {
      select().value = value;
      select().dispatchEvent(new env.win.Event("change", { bubbles: true }));
      await sleep(20);
      return names();
    };

    assert.deepStrictEqual(await choose("price-asc"), [
      "Dix",
      "Vingt",
      "Sans prix",
      "Sans prix 2",
    ]);
    assert.deepStrictEqual(await choose("price-desc"), [
      "Vingt",
      "Dix",
      "Sans prix",
      "Sans prix 2",
    ]);
  });

  await test("repost : tri local conservé après changement de filtre", async () => {
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 301, title: "Actif" })],
          1,
          1,
          1
        ),
        [hiddenUrl]: pageBody(
          [
            makeItem({
              id: 202,
              title: "Masqué 2",
              price: { amount: "25", currency_code: "EUR" },
            }),
            makeItem({
              id: 201,
              title: "Masqué 1",
              price: { amount: "5", currency_code: "EUR" },
            }),
            makeItem({
              id: 203,
              title: "Masqué 3",
              price: { amount: "15", currency_code: "EUR" },
            }),
          ],
          1,
          1,
          3
        ),
      },
    });
    await env.repost().run();

    const select = () => env.doc.querySelector("#detniv-repost-sort");
    select().value = "price-asc";
    select().dispatchEvent(new env.win.Event("change", { bubbles: true }));
    await sleep(20);

    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 2, "fetch Masqués absent");
    assert.strictEqual(env.fetchLog[1].url, hiddenUrl);
    assert.strictEqual(select().value, "price-asc", "tri non conservé");
    const names = [
      ...env.closet().querySelectorAll('[data-detniv-repost="1"]'),
    ].map((card) => card.querySelector(".detniv-repost-name").textContent);
    assert.deepStrictEqual(names, ["Masqué 1", "Masqué 3", "Masqué 2"]);
  });

  await test("repost : tri local restauré après re-rendu React et réinjecté", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 302,
              title: "B",
              price: { amount: "30", currency_code: "EUR" },
            }),
            makeItem({
              id: 301,
              title: "A",
              price: { amount: "10", currency_code: "EUR" },
            }),
            makeItem({
              id: 303,
              title: "C",
              price: { amount: "20", currency_code: "EUR" },
            }),
          ],
          1,
          1,
          3
        ),
      },
    });
    const ssrCard = env.closet()
      .querySelector('[data-testid="grid-item"]')
      .cloneNode(true);
    await env.repost().run();

    const select = () => env.doc.querySelector("#detniv-repost-sort");
    select().value = "price-asc";
    select().dispatchEvent(new env.win.Event("change", { bubbles: true }));
    await sleep(20);

    const names = () =>
      [...env.closet().querySelectorAll('[data-detniv-repost="1"]')].map(
        (card) => card.querySelector(".detniv-repost-name").textContent
      );
    assert.deepStrictEqual(names(), ["A", "C", "B"]);

    // React remplace toute la grille par sa card SSR.
    const grid = env.closet().querySelector(GRID_SEL);
    grid.replaceChildren(ssrCard.cloneNode(true));
    await sleep(300);

    assert.strictEqual(
      env.closet().querySelectorAll('[data-detniv-repost="1"]').length,
      3,
      "grille non restaurée"
    );
    assert.strictEqual(select().value, "price-asc");
    assert.deepStrictEqual(names(), ["A", "C", "B"]);

    // React remplace la barre de filtres : le select revient avec la valeur.
    env.doc.getElementById("detniv-repost-search").remove();
    await sleep(300);
    assert.ok(select(), "select de tri non réinjecté");
    assert.strictEqual(select().value, "price-asc");
    assert.deepStrictEqual(names(), ["A", "C", "B"]);
  });

  await test("repost : cases à cocher Actifs, Masqués, Brouillons et compteur", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const draftUrl = WARDROBE + "?page=1&per_page=20&cond=draft";
    const env = boot({
      ownProfile: true,
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({ id: 501, title: "Actif 1" }),
            makeItem({ id: 502, title: "Actif 2" }),
          ],
          1,
          1,
          2
        ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 503, title: "Masqué" })],
          1,
          1,
          1
        ),
        [draftUrl]: pageBody(
          [makeItem({ id: 504, title: "Brouillon" })],
          1,
          1,
          1
        ),
      },
    });
    await sleep(300);
    assert.strictEqual(env.fetchLog.length, 1, "rendu initial absent");

    const cards = () => [
      ...env.closet().querySelectorAll('[data-detniv-repost="1"]'),
    ];
    const boxes = () =>
      cards().map((card) =>
        card.querySelector('.detniv-repost-select input[type="checkbox"]')
      );
    const countText = () =>
      env.doc.querySelector("#detniv-repost-selection-count").textContent;

    assert.strictEqual(cards().length, 2);
    assert.ok(
      cards().every(
        (card) =>
          card.firstElementChild &&
          card.firstElementChild.classList.contains("detniv-repost-select")
      ),
      "case à cocher absente du coin haut gauche"
    );
    assert.ok(boxes().every((box) => box && box.type === "checkbox"));
    assert.strictEqual(countText(), "0 sélectionné");

    boxes()[0].click();
    assert.strictEqual(countText(), "1 sélectionné");
    assert.strictEqual(boxes()[0].checked, true);
    assert.strictEqual(boxes()[1].checked, false);
    assert.ok(cards()[0].classList.contains("detniv-repost-selected"));

    boxes()[1].click();
    assert.strictEqual(countText(), "2 sélectionnés");
    boxes()[0].click();
    assert.strictEqual(countText(), "1 sélectionné");

    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await sleep(300);
    assert.strictEqual(env.fetchLog.length, 2, "fetch Masqués absent");
    assert.strictEqual(env.fetchLog[1].url, hiddenUrl);
    assert.strictEqual(cards().length, 1);
    assert.ok(boxes()[0], "case à cocher absente en Masqués");
    assert.strictEqual(boxes()[0].checked, false);
    assert.strictEqual(countText(), "1 sélectionné");
    boxes()[0].click();
    assert.strictEqual(countText(), "2 sélectionnés");

    env.doc
      .querySelector('[data-testid="closet-seller-filters-draft"]')
      .click();
    await sleep(300);
    assert.strictEqual(env.fetchLog.length, 3, "fetch Brouillons absent");
    assert.strictEqual(env.fetchLog[2].url, draftUrl);
    assert.strictEqual(cards().length, 1);
    assert.ok(boxes()[0], "case à cocher absente en Brouillons");
    assert.strictEqual(boxes()[0].checked, false);
    assert.strictEqual(countText(), "2 sélectionnés");
    boxes()[0].click();
    assert.strictEqual(countText(), "3 sélectionnés");
  });

  await test("repost : sélection restaurée après re-rendu React et réinjection", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({ id: 511, title: "Un" }),
            makeItem({ id: 512, title: "Deux" }),
          ],
          1,
          1,
          2
        ),
      },
    });
    const ssrCard = env.closet()
      .querySelector('[data-testid="grid-item"]')
      .cloneNode(true);
    await env.repost().run();

    const cards = () => [
      ...env.closet().querySelectorAll('[data-detniv-repost="1"]'),
    ];
    const boxes = () =>
      cards().map((card) =>
        card.querySelector('.detniv-repost-select input[type="checkbox"]')
      );
    const countText = () =>
      env.doc.querySelector("#detniv-repost-selection-count").textContent;

    boxes()[1].click();
    assert.strictEqual(countText(), "1 sélectionné");
    assert.strictEqual(boxes()[1].checked, true);

    // React remplace toute la grille par sa card SSR.
    const grid = env.closet().querySelector(GRID_SEL);
    grid.replaceChildren(ssrCard.cloneNode(true));
    await sleep(300);

    assert.strictEqual(cards().length, 2, "grille non restaurée");
    assert.strictEqual(countText(), "1 sélectionné");
    assert.strictEqual(boxes()[0].checked, false);
    assert.strictEqual(boxes()[1].checked, true);
    assert.ok(cards()[1].classList.contains("detniv-repost-selected"));

    // React remplace la barre de filtres : compteur et cases reviennent.
    env.doc.getElementById("detniv-repost-search").remove();
    await sleep(300);
    assert.ok(
      env.doc.querySelector("#detniv-repost-selection-count"),
      "compteur non réinjecté"
    );
    assert.strictEqual(countText(), "1 sélectionné");
    assert.strictEqual(boxes()[1].checked, true);

    // Le bouton et son statut sont réinjectés avec le reste des contrôles.
    env.doc.getElementById("detniv-repost-submit").remove();
    env.doc.getElementById("detniv-repost-upload-status").remove();
    await sleep(300);
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-submit").length,
      1,
      "bouton Republier non réinjecté"
    );
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-upload-status").length,
      1,
      "statut d'upload non réinjecté"
    );
  });

  await test("repost : bouton Republier jaune et upload des images actives", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const uploadCalls = [];
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({ id: 701, title: "Actif A" }),
            makeItem({ id: 702, title: "Actif B" }),
          ],
          1,
          1,
          2
        ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 703, title: "Masqué C" })],
          1,
          1,
          1
        ),
      },
      images: {
        "https://img.example/full.jpg": { type: "image/jpeg" },
      },
      detnivApi: {
        async handle(action, payload) {
          uploadCalls.push({ action, payload });
          return (payload.files || []).map((file, index) => ({
            id: index + 1,
            url: "https://cdn.example/" + file.fileName,
          }));
        },
      },
    });
    await env.repost().run();

    const filters = env.doc.querySelector(FILTERS_SEL);
    const button = filters.querySelector("#detniv-repost-submit");
    const status = () => env.doc.querySelector("#detniv-repost-upload-status");
    const boxes = () => [
      ...env.closet().querySelectorAll(
        '.detniv-repost-select input[type="checkbox"]'
      ),
    ];

    assert.ok(button, "bouton Republier absent");
    assert.ok(filters.contains(button), "bouton hors de la barre de filtres");
    assert.strictEqual(button.textContent, "Republier");
    assert.strictEqual(button.disabled, true, "bouton actif sans sélection");
    const css = env.doc.getElementById("detniv-repost-styles").textContent;
    assert.match(
      css,
      /\.detniv-repost-submit\s*\{[^}]*background:\s*#ffd600/s,
      "bouton non jaune Detniv"
    );

    boxes()[0].click();
    boxes()[1].click();
    assert.strictEqual(button.disabled, false);
    assert.match(button.title, /2 articles actifs/);

    button.click();
    await waitFor(
      () => uploadCalls.length === 1 && button.textContent === "Republier",
      "upload initial"
    );
    assert.strictEqual(uploadCalls[0].action, "images.upload");
    assert.strictEqual(uploadCalls[0].payload.files.length, 2);
    assert.ok(uploadCalls[0].payload.files[0].blob.size > 0);
    assert.match(uploadCalls[0].payload.files[0].fileName, /^vinted-701-/);
    assert.ok(
      env.fetchLog.some(
        (call) => call.url === "https://img.example/full.jpg"
      ),
      "photo Vinted non téléchargée"
    );
    assert.strictEqual(status().textContent, "2 images envoyées sur Detniv.");
    assert.ok(
      status().classList.contains("detniv-repost-upload-status--success")
    );

    // Une sélection faite en Masqués ne doit pas être envoyée.
    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await sleep(300);
    const hiddenBoxes = [
      ...env.closet().querySelectorAll(
        '.detniv-repost-select input[type="checkbox"]'
      ),
    ];
    hiddenBoxes[0].click();
    assert.strictEqual(
      env.doc.querySelector("#detniv-repost-selection-count").textContent,
      "3 sélectionnés"
    );
    assert.match(button.title, /2 articles actifs/);
    button.click();
    await waitFor(() => uploadCalls.length === 2, "second upload");
    assert.strictEqual(uploadCalls[1].payload.files.length, 2);
  });

  await test("repost : photo vinted.net téléchargée via le background", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const photo = "https://images1.vinted.net/t/03_test/f800/photo.jpeg?s=abc";
    const uploadCalls = [];
    const dataUrl =
      "data:image/jpeg;base64," +
      Buffer.from("image-bytes").toString("base64");
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({
              id: 731,
              title: "Actif CDN",
              photos: [{ is_main: true, full_size_url: photo, url: photo }],
            }),
          ],
          1,
          1,
          1
        ),
      },
      runtimeHandler: (message) =>
        message.type === "detniv:fetch-image"
          ? { ok: true, dataUrl }
          : undefined,
      permissionGranted: true,
      detnivApi: {
        async handle(action, payload) {
          uploadCalls.push({ action, payload });
          return [{ id: 1, url: "https://cdn.example/1.jpg" }];
        },
      },
    });
    await env.repost().run();
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();
    env.doc.querySelector("#detniv-repost-submit").click();
    await waitFor(() => uploadCalls.length === 1, "upload via background");

    assert.strictEqual(env.messages[0].type, "detniv:fetch-image");
    assert.strictEqual(env.messages[0].url, photo);
    assert.ok(
      !env.fetchLog.some((call) => call.url === photo),
      "le content script ne doit pas télécharger l'image soumise au CORS"
    );
    const file = uploadCalls[0].payload.files[0];
    assert.strictEqual(file.blob.type, "image/jpeg");
    assert.ok(file.blob.size > 0);
  });

  await test("repost : permission d'hôte images refusée → erreur explicite", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const photo = "https://images1.vinted.net/t/03_test/f800/photo.jpeg?s=abc";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({
              id: 741,
              title: "Actif CDN",
              photos: [{ is_main: true, full_size_url: photo, url: photo }],
            }),
          ],
          1,
          1,
          1
        ),
      },
      permissionGranted: false,
    });
    await env.repost().run();
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();
    env.doc.querySelector("#detniv-repost-submit").click();

    const status = () => env.doc.querySelector("#detniv-repost-upload-status");
    await waitFor(
      () => /Autorisez l'accès aux images Vinted/.test(status().textContent),
      "statut d'erreur"
    );
    assert.ok(
      status().classList.contains("detniv-repost-upload-status--error")
    );
    assert.strictEqual(env.messages.length, 0, "téléchargement désiré");
  });

  await test("repost : background injoignable → erreur explicite sans fetch direct", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const photo = "https://images1.vinted.net/t/03_test/f800/photo.jpeg?s=abc";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({
              id: 742,
              title: "Actif CDN",
              photos: [{ is_main: true, full_size_url: photo, url: photo }],
            }),
          ],
          1,
          1,
          1
        ),
      },
      permissionGranted: true,
      runtimeHandler: (message) =>
        message.type === "detniv:fetch-image"
          ? { ok: false, error: "NetworkError when attempting to fetch resource." }
          : undefined,
      detnivApi: {
        async handle() {
          throw new Error("unused");
        },
      },
    });
    await env.repost().run();
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();
    env.doc.querySelector("#detniv-repost-submit").click();

    const status = () => env.doc.querySelector("#detniv-repost-upload-status");
    await waitFor(
      () =>
        /téléchargement de l'image impossible|NetworkError|arrière-plan/.test(
          status().textContent
        ),
      "statut d'erreur"
    );
    assert.ok(
      !env.fetchLog.some((call) => call.url === photo),
      "pas de fetch direct d'une image Vinted soumise au CORS"
    );
    assert.strictEqual(
      env.messages.length,
      1,
      "une seule tentative via le background"
    );
  });

  await test("repost : background sans réponse → erreur explicite sans fetch direct", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const photo = "https://images1.vinted.net/t/03_test/f800/photo.jpeg?s=abc";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [
            makeItem({
              id: 743,
              title: "Actif CDN",
              photos: [{ is_main: true, full_size_url: photo, url: photo }],
            }),
          ],
          1,
          1,
          1
        ),
      },
      permissionGranted: true,
      runtimeUnresponsive: true,
      detnivApi: {
        async handle() {
          throw new Error("unused");
        },
      },
    });
    await env.repost().run();
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();
    env.doc.querySelector("#detniv-repost-submit").click();

    const status = () => env.doc.querySelector("#detniv-repost-upload-status");
    await waitFor(
      () =>
        /n'a pas répondu|recharguez|rechargez|arrière-plan/.test(
          status().textContent
        ),
      "statut d'erreur"
    );
    assert.ok(
      !env.fetchLog.some((call) => call.url === photo),
      "pas de fetch direct d'une image Vinted soumise au CORS"
    );
  });

  await test("repost : seuls les articles actifs alimentent le bouton Republier", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [makeItem({ id: 711, title: "Actif" })],
          1,
          1,
          1
        ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 712, title: "Masqué" })],
          1,
          1,
          1
        ),
      },
    });
    await env.repost().run();
    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await sleep(300);
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();

    const button = env.doc.querySelector("#detniv-repost-submit");
    assert.strictEqual(
      env.doc.querySelector("#detniv-repost-selection-count").textContent,
      "1 sélectionné"
    );
    assert.strictEqual(button.disabled, true);
    assert.match(button.title, /Seuls les articles actifs/);
  });

  await test("repost : échec d'upload affiché sans perdre la sélection", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [makeItem({ id: 721, title: "Actif" })],
          1,
          1,
          1
        ),
      },
      images: {
        "https://img.example/full.jpg": { type: "image/jpeg" },
      },
      detnivApi: {
        async handle() {
          throw new Error("Image storage is not configured");
        },
      },
    });
    await env.repost().run();
    const button = env.doc.querySelector("#detniv-repost-submit");
    env.closet()
      .querySelector('.detniv-repost-select input[type="checkbox"]')
      .click();
    button.click();

    const status = () =>
      env.doc.querySelector("#detniv-repost-upload-status");
    await waitFor(
      () => /Échec de l'envoi/.test(status().textContent),
      "statut d'erreur"
    );
    assert.match(status().textContent, /Image storage is not configured/);
    assert.ok(
      status().classList.contains("detniv-repost-upload-status--error")
    );
    assert.strictEqual(button.disabled, false);
    assert.strictEqual(
      env.doc.querySelector("#detniv-repost-selection-count").textContent,
      "1 sélectionné"
    );
  });

  await test("repost : barre de filtres responsive en mobile", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 601, title: "Mobile" })],
          1,
          1,
          1
        ),
      },
    });
    await env.repost().run();

    const filters = env.doc.querySelector(FILTERS_SEL);
    assert.ok(
      filters.closest(".detniv-repost-filter-row"),
      "ligne de filtres non marquée pour le responsive"
    );

    const css = env.doc.getElementById("detniv-repost-styles").textContent;
    assert.ok(css.includes("@media (max-width: 720px)"), "breakpoint mobile absent");
    assert.ok(
      css.includes(".detniv-repost-filter-row") &&
        css.includes(':has([data-testid="closet-seller-filters"])') &&
        css.includes("flex-wrap: wrap"),
      "ligne de filtres non repliable"
    );
    assert.ok(
      css.includes('[data-testid="closet-seller-filters"]') &&
        css.includes("align-items: flex-start") &&
        css.includes("> .web_ui__Spacer__vertical"),
      "chips non protégées contre l'étirement"
    );
    assert.ok(
      css.includes("grid-template-columns: minmax(0, 1fr) auto"),
      "contrôles locaux non empilés"
    );
    assert.ok(
      css.includes("grid-column: 1 / -1"),
      "recherche non pleine largeur"
    );
  });

  await test("repost : card rendue avec image, lien, titre, prix, vues", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 777,
              title: "Robe été",
              brand_title: "Zara",
              size_title: "M",
              promoted: false,
              price: { amount: "19.99", currency_code: "EUR" },
              view_count: 3,
              path: "/items/777",
              url: "https://www.vinted.fr/items/777",
            }),
          ],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    const img = card.querySelector("img");
    assert.strictEqual(img.src, "https://img.example/full.jpg");
    assert.strictEqual(img.alt, "Robe été");
    const link = card.querySelector("a");
    assert.strictEqual(link.getAttribute("href"), "https://www.vinted.fr/items/777");
    assert.strictEqual(link.title, "Robe été");
    const name = card.querySelector(".detniv-repost-name");
    assert.ok(name, "nom de l'article absent");
    assert.strictEqual(name.textContent, "Robe été");
    const meta = card.querySelector(".detniv-repost-meta");
    assert.ok(meta, "marque/taille absentes");
    assert.strictEqual(meta.textContent, "Zara · M");
    const titleContainer = card.querySelector('[data-testid$="--title-container"]');
    assert.strictEqual(titleContainer.firstElementChild, name, "nom pas en première position");
    assert.strictEqual(titleContainer.children[1], meta, "méta pas juste après le nom");
    const styles = env.doc.getElementById("detniv-repost-styles");
    assert.ok(styles, "styles des cards absents");
    assert.match(styles.textContent, /\.detniv-repost-name/);
    assert.strictEqual(
      card.querySelector('[data-testid$="--price-text"]').textContent,
      "19,99 €"
    );
    assert.strictEqual(
      card.querySelector('[data-testid$="--description-title"]').textContent,
      "3 vues"
    );
    assert.strictEqual(
      card.querySelector('[data-testid$="--description-subtitle"]').textContent,
      "",
      "favoris hérités du template non vidés"
    );
    assert.strictEqual(
      card.getAttribute("data-detniv-repost"),
      "1",
      "marqueur de card Detniv absent"
    );
    const bump = card.querySelector('[data-testid="bump-button"]');
    assert.ok(bump, "bouton Booster absent");
    assert.strictEqual(
      bump.querySelector(".web_ui__Button__label").textContent,
      "Booster",
      "libellé incorrect pour un article non promu"
    );
  });

  await test("repost : bouton Booster → « Boosté » si article promu", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 778, title: "Veste", promoted: true })],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    const bump = card.querySelector('[data-testid="bump-button"]');
    assert.ok(bump, "bouton Booster absent");
    assert.strictEqual(
      bump.querySelector(".web_ui__Button__label").textContent,
      "Boosté",
      "libellé incorrect pour un article promu"
    );
  });

  await test("repost : vue singulière (1 vue)", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 5, view_count: 1 })], 1, 1, 1
        ),
      },
    });
    await env.repost().run();
    const text = env.closet().querySelector('[data-testid$="--description-title"]').textContent;
    assert.strictEqual(text, "1 vue");
  });

  await test("repost : sans card modèle (garde-robe vide SSR) → rendu de repli", async () => {
    const env = boot({
      html: FIXTURE_NO_CARD_HTML,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 9,
              title: "Sac",
              brand_title: "Coach",
              size_title: "Unique",
              price: { amount: "5", currency_code: "EUR" },
            }),
          ],
          1, 1, 1
        ),
      },
    });
    assert.ok(env.closet(), "container absent du fixture");
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.ok(card, "card de repli absente");
    assert.strictEqual(card.querySelector("img").alt, "Sac");
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Sac");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Coach · Unique");
    assert.strictEqual(
      card.querySelector("p.web_ui__Text__caption").textContent,
      "5,00 €"
    );
  });


  await test("repost : sans marque ni taille → nom seul, pas de méta", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 10,
              title: "Vase",
              brand_title: null,
              size_title: "",
              brand: 42,
              size: 7,
            }),
          ],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Vase");
    assert.strictEqual(card.querySelector(".detniv-repost-meta"), null);
  });

  await test("repost : repli brand/size (objet ou chaîne) si *_title absent", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 11,
              title: "Manteau",
              brand_title: "",
              size_title: "",
              brand: { title: "Zara" },
              size: "XL",
            }),
          ],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    const meta = env.closet().querySelector(".detniv-repost-meta");
    assert.ok(meta, "méta absente");
    assert.strictEqual(meta.textContent, "Zara · XL");
  });

  await test("repost : second run ne duplique ni identité ni styles", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 12,
              title: "Pull",
              brand_title: "Uniqlo",
              size_title: "L",
            }),
          ],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelectorAll(".detniv-repost-name").length, 1);
    assert.strictEqual(card.querySelectorAll(".detniv-repost-meta").length, 1);
    assert.strictEqual(
      card.querySelectorAll(".detniv-repost-select").length,
      1,
      "case à cocher dupliquée"
    );
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-styles").length,
      1,
      "feuille de styles dupliquée"
    );
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-search").length,
      1,
      "champ de recherche dupliqué"
    );
    assert.strictEqual(
      env.doc.querySelectorAll("#detniv-repost-selection-count").length,
      1,
      "compteur de sélection dupliqué"
    );
  });

  await test("repost : clic Actifs sans cache → charge la garde-robe active", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 25, title: "Short", brand_title: "Nike", size_title: "M" })],
          1, 1, 1
        ),
      },
    });
    env.doc
      .querySelector('[data-testid="closet-seller-filters-active--text"]')
      .click();
    await sleep(250);

    assert.strictEqual(env.fetchLog.length, 1, "API non appelée");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Short");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Nike · M");
  });

  await test("repost : clic sur le filtre Actifs → re-rendu après re-render React", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 21,
              title: "Chemise",
              brand_title: "Zara",
              size_title: "M",
            }),
          ],
          1, 1, 1
        ),
      },
    });
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const ssrGrid = grid.innerHTML;
    await env.repost().run();
    assert.strictEqual(
      env.closet().querySelector(".detniv-repost-name").textContent,
      "Chemise"
    );

    env.doc
      .querySelector('[data-testid="closet-seller-filters-active--text"]')
      .click();
    await sleep(200);
    // Simule le rendu React asynchrone : la grille revient au contenu SSR.
    grid.innerHTML = ssrGrid;
    await sleep(300);

    const cards = env.closet().querySelectorAll('[data-testid="grid-item"]');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(
      cards[0].querySelector(".detniv-repost-name").textContent,
      "Chemise"
    );
    assert.strictEqual(
      cards[0].querySelector(".detniv-repost-meta").textContent,
      "Zara · M"
    );
  });

  await test("repost : clic sur Masqués → fetch cond=hidden et rendu", async () => {
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 22, title: "Jupe", brand_title: "H&M", size_title: "S" })],
          1, 1, 1
        ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 23, title: "Manteau masqué", brand_title: "COS", size_title: "M" })],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();

    const hidden = env.doc.querySelector(
      '[data-testid="closet-seller-filters-hidden"]'
    );
    hidden.click();
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 2, "fetch Masqués absent");
    assert.strictEqual(env.fetchLog[1].url, hiddenUrl);
    assert.strictEqual(
      env.doc
        .querySelector('[data-testid="closet-seller-filters-active"]')
        .getAttribute("aria-pressed"),
      "false"
    );
    assert.strictEqual(hidden.getAttribute("aria-pressed"), "true");
    const card = env.closet().querySelector('[data-detniv-repost="1"]');
    assert.strictEqual(
      card.querySelector(".detniv-repost-name").textContent,
      "Manteau masqué"
    );
    assert.strictEqual(
      card.querySelector(".detniv-repost-meta").textContent,
      "COS · M"
    );
  });

  await test("repost : clic sur Brouillons → fetch cond=draft et rendu", async () => {
    const draftUrl = WARDROBE + "?page=1&per_page=20&cond=draft";
    const env = boot({
      ownProfile: true,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 24, title: "Jupe active" })],
          1, 1, 1
        ),
        [draftUrl]: pageBody(
          [makeItem({ id: 25, title: "Brouillon", brand_title: "Sézane", size_title: "S" })],
          1, 1, 1
        ),
      },
    });
    // La garde-robe personnelle est rechargée automatiquement sur Actifs.
    await sleep(300);
    assert.strictEqual(env.fetchLog.length, 1, "rendu initial absent");

    env.doc
      .querySelector('[data-testid="closet-seller-filters-draft"]')
      .click();
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 2, "fetch Brouillons absent");
    assert.strictEqual(env.fetchLog[1].url, draftUrl);
    const card = env.closet().querySelector('[data-detniv-repost="1"]');
    assert.strictEqual(
      card.querySelector(".detniv-repost-name").textContent,
      "Brouillon"
    );
    assert.strictEqual(
      card.querySelector(".detniv-repost-meta").textContent,
      "Sézane · S"
    );
  });

  await test("repost : chaque clic sur un filtre relance fetchAllItems", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const env = boot({
      pages: {
        [activeUrl]: pageBody(
          [makeItem({ id: 26, title: "Pull", brand_title: "Uniqlo", size_title: "M" })],
          1, 1, 1
        ),
      },
    });
    await env.repost().run();
    assert.strictEqual(env.fetchLog.length, 1, "fetch initial absent");

    env.doc
      .querySelector('[data-testid="closet-seller-filters-active--text"]')
      .click();
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 2, "second clic sans fetch");
    assert.strictEqual(env.fetchLog[1].url, activeUrl);
    const card = env.closet().querySelector('[data-detniv-repost="1"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Pull");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Uniqlo · M");
  });

  await test("repost : clic pendant un fetch → chargé après le run en cours", async () => {
    const activeUrl = WARDROBE + "?page=1&per_page=20&cond=active";
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const env = boot({
      pages: {
        [activeUrl]: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  pageBody(
                    [makeItem({ id: 61, title: "Actif" })],
                    1,
                    1,
                    1
                  )
                ),
              250
            )
          ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 62, title: "Masqué", brand_title: "COS", size_title: "M" })],
          1,
          1,
          1
        ),
      },
    });
    const running = env.repost().run();
    await sleep(50);
    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await running;
    await sleep(500);

    assert.strictEqual(env.fetchLog.length, 2, "clic perdu pendant le fetch");
    assert.strictEqual(env.fetchLog[1].url, hiddenUrl);
    const card = env.closet().querySelector('[data-detniv-repost="1"]');
    assert.strictEqual(
      card.querySelector(".detniv-repost-name").textContent,
      "Masqué"
    );
    assert.strictEqual(
      card.querySelector(".detniv-repost-meta").textContent,
      "COS · M"
    );
  });

  await test("repost : grille démontée au clic → fetch puis rendu après retour", async () => {
    const hiddenUrl = WARDROBE + "?page=1&per_page=20&cond=hidden";
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 63, title: "Actif" })],
          1,
          1,
          1
        ),
        [hiddenUrl]: pageBody(
          [makeItem({ id: 64, title: "Masqué", brand_title: "COS", size_title: "M" })],
          1,
          1,
          1
        ),
      },
    });
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const gridHtml = grid.outerHTML;
    await env.repost().run();

    // Vinted vide la liste au clic sur un filtre et démonte la grille.
    grid.remove();
    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .click();
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 2, "fetch non lancé sans grille");
    assert.strictEqual(env.fetchLog[1].url, hiddenUrl);

    // Vinted rend ensuite les articles du filtre : notre grille enrichie
    // doit s'appliquer dès que le conteneur est de nouveau disponible.
    env.closet().insertAdjacentHTML("beforeend", gridHtml);
    await sleep(700);

    const card = env.closet().querySelector('[data-detniv-repost="1"]');
    assert.strictEqual(
      card.querySelector(".detniv-repost-name").textContent,
      "Masqué"
    );
    assert.strictEqual(
      card.querySelector(".detniv-repost-meta").textContent,
      "COS · M"
    );
  });

  await test("repost : re-rendu React tardif → restauration automatique", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 23, title: "Pantalon", brand_title: "Levi's", size_title: "W32" })],
          1, 1, 1
        ),
      },
    });
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const ssrGrid = grid.innerHTML;
    await env.repost().run();
    await sleep(250);
    grid.innerHTML = ssrGrid;
    await sleep(300);

    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Pantalon");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Levi's · W32");
  });

  await test("repost : re-rendu React sans aria-pressed (classe activée) → restauration", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 41, title: "Parka", brand_title: "Aigle", size_title: "L" })],
          1, 1, 1
        ),
      },
    });
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const ssrGrid = grid.innerHTML;
    await env.repost().run();

    const active = env.doc.querySelector(
      '[data-testid="closet-seller-filters-active"]'
    );
    active.removeAttribute("aria-pressed");
    active.classList.add("web_ui__Chip__chip", "web_ui__Chip__activated");
    await sleep(250);

    grid.innerHTML = ssrGrid;
    await sleep(350);

    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Parka");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Aigle · L");
  });

  await test("repost : remplacement du conteneur par React → restauration", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 24, title: "Blouson", brand_title: "The North Face", size_title: "L" })],
          1, 1, 1
        ),
      },
    });
    const originalCloset = env.closet().cloneNode(true);
    await env.repost().run();
    await sleep(250);

    env.closet().parentElement.replaceChild(originalCloset, env.closet());
    await sleep(300);

    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Blouson");
    assert.strictEqual(
      card.querySelector(".detniv-repost-meta").textContent,
      "The North Face · L"
    );
  });

  await test("repost : erreur HTTP API → run rejette, grille inchangée", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody([makeItem()], 1, 1, 1),
      },
    });
    env.failWith(429, "Too many requests");
    await assert.rejects(
      () => env.repost().run(),
      /HTTP 429/
    );
    const items = env.closet().querySelectorAll('[data-testid="grid-item"]');
    assert.strictEqual(items.length, 1, "grille modifiée malgré l'erreur");
    assert.strictEqual(
      items[0].querySelector("img").getAttribute("src"),
      "old.jpg",
      "ancienne image remplacée malgré l'erreur"
    );
  });

  await test("repost : URL non membre → erreur explicite", async () => {
    const env = boot({ url: "https://www.vinted.fr/items/new" });
    await assert.rejects(
      () => env.repost().run(),
      /Ouvrez une garde-robe/
    );
    assert.strictEqual(env.fetchLog.length, 0, "appel API malgré l'URL invalide");
  });

  await test("repost : run(id) accepte un id explicite", async () => {
    const custom = "https://www.vinted.fr/api/v2/wardrobe/999/items?page=1&per_page=20&cond=active";
    const body = pageBody([makeItem({ id: 42 })], 1, 1, 1);
    // Sans container (hors profil) → erreur avant tout appel API.
    const env0 = boot({
      url: "https://www.vinted.fr/items/new",
      html: "<!DOCTYPE html><html><body><div class=\"site-content\"></div></body></html>",
      pages: { [custom]: body },
    });
    await assert.rejects(() => env0.repost().run("999"), /Garde-robe introuvable/);
    assert.strictEqual(env0.fetchLog.length, 0, "appel API malgré l'absence de container");
    // Avec container + id explicite, l'id prime sur l'URL.
    const env2 = boot({
      url: "https://www.vinted.fr/member/111",
      pages: { [custom]: body },
    });
    const result = await env2.repost().run("999");
    assert.strictEqual(result.count, 1);
    assert.strictEqual(env2.fetchLog[0].url, custom);
  });

  await test("repost : total_pages absent → une seule page", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: {
          items: [makeItem({ id: 1 })],
          code: 0,
        },
      },
    });
    const result = await env.repost().run();
    assert.strictEqual(result.pages, 1);
    assert.strictEqual(env.fetchLog.length, 1);
  });

  await test("repost : readCookie lit v_uid dans document.cookie", async () => {
    const env = boot({
      url: "https://www.vinted.fr/",
      cookie: "251881314",
    });
    const uid = await env.repost().readCookie("v_uid");
    assert.strictEqual(uid, "251881314");
  });

  await test("repost : start() sans cookie → erreur v_uid", async () => {
    const env = boot({});
    await assert.rejects(() => env.repost().start(), /v_uid introuvable/);
    assert.strictEqual(env.fetchLog.length, 0);
  });

  await test("repost : readCookie lit v_uid via le background (cookie HttpOnly)", async () => {
    const env = boot({
      url: "https://www.vinted.fr/",
      runtimeCookie: "251881314",
    });
    const uid = await env.repost().readCookie("v_uid");
    assert.strictEqual(uid, "251881314");
    assert.strictEqual(env.messages.length, 1);
    assert.strictEqual(env.messages[0].type, "detniv:get-cookie");
    assert.strictEqual(env.messages[0].name, "v_uid");
  });

  await test("repost : start() hors garde-robe → navigue vers /member/<v_uid>", async () => {
    const env = boot({
      url: "https://www.vinted.fr/",
      cookie: "251881314",
    });
    const result = await env.repost().start();
    assert.strictEqual(result.navigating, true);
    assert.strictEqual(result.url, "https://www.vinted.fr/member/251881314");
    assert.strictEqual(env.store.detnivRepostPending.uid, "251881314");
    assert.ok(env.store.detnivRepostPending.at > 0);
    assert.strictEqual(env.fetchLog.length, 0, "fetch avant navigation");
  });

  await test("repost : actualisation en mode auto → rendu sans panneau", async () => {
    const env = boot({
      autoWardrobe: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 31,
              title: "Manteau",
              brand_title: "COS",
              size_title: "M",
            }),
          ],
          1, 1, 1
        ),
      },
    });
    await sleep(400);

    assert.strictEqual(env.fetchLog.length, 1, "API non appelée au chargement");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Manteau");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "COS · M");
    assert.strictEqual(env.activeFilterClicks(), 0, "Actifs déjà sélectionné");
  });

  await test("repost : actualisation en mode auto → sélectionne Actifs si besoin", async () => {
    const env = boot({
      autoWardrobe: "251881314",
      activePressed: false,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 32, title: "Robe", brand_title: "Sézane", size_title: "S" })],
          1, 1, 1
        ),
      },
    });
    await sleep(600);

    assert.strictEqual(env.activeFilterClicks(), 1, "filtre Actifs non cliqué");
    assert.strictEqual(
      env.doc
        .querySelector('[data-testid="closet-seller-filters-active"]')
        .getAttribute("aria-pressed"),
      "true"
    );
    assert.strictEqual(env.fetchLog.length, 1, "API non appelée après sélection");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Robe");
  });

  await test("repost : actualisation hors mode auto → aucun rendu", async () => {
    const env = boot({
      autoWardrobe: "999",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 33 })], 1, 1, 1
        ),
      },
    });
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 0, "fetch malgré l'absence de mode auto");
    assert.strictEqual(env.activeFilterClicks(), 0, "Actifs cliqué sans mode auto");
    assert.strictEqual(env.closet().querySelector(".detniv-repost-name"), null);
  });

  await test("repost : actualisation sur sa garde-robe (v_uid) → rendu auto", async () => {
    const env = boot({
      cookie: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 35, title: "Ceinture", brand_title: "Hermès", size_title: "85" })],
          1, 1, 1
        ),
      },
    });
    await sleep(400);

    assert.strictEqual(env.fetchLog.length, 1, "API non appelée au chargement");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Ceinture");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Hermès · 85");
  });

  await test("repost : actualisation sur sa garde-robe (v_uid HttpOnly) → rendu auto", async () => {
    const env = boot({
      runtimeCookie: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 36, title: "Écharpe", brand_title: "A.P.C.", size_title: "Unique" })],
          1, 1, 1
        ),
      },
    });
    await sleep(400);

    assert.strictEqual(env.messages.length, 1, "v_uid non lu via le background");
    assert.strictEqual(env.fetchLog.length, 1, "API non appelée au chargement");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Écharpe");
  });

  await test("repost : actualisation sur sa garde-robe (filtre Brouillons) → rendu auto", async () => {
    const env = boot({
      ownProfile: true,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 38, title: "Pull", brand_title: "Lacoste", size_title: "M" })],
          1, 1, 1
        ),
      },
    });
    await sleep(400);

    assert.strictEqual(env.fetchLog.length, 1, "API non appelée au chargement");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Pull");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Lacoste · M");
  });

  await test("repost : clic Actifs depuis Masqués → rendu malgré aria-pressed tardif", async () => {
    const env = boot({
      activePressed: false,
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 39, title: "Chemisier", brand_title: "Mango", size_title: "S" })],
          1, 1, 1
        ),
      },
    });
    env.doc
      .querySelector('[data-testid="closet-seller-filters-hidden"]')
      .setAttribute("aria-pressed", "true");
    env.doc
      .querySelector('[data-testid="closet-seller-filters-active--text"]')
      .click();
    await sleep(250);

    assert.strictEqual(env.fetchLog.length, 1, "API non appelée après le clic");
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Chemisier");
  });

  await test("repost : retour sur Actifs après Masqués → réapplique les cards", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 40, title: "Blouse", brand_title: "Zara", size_title: "L" })],
          1, 1, 1
        ),
      },
    });
    const active = env.doc.querySelector(
      '[data-testid="closet-seller-filters-active"]'
    );
    const hidden = env.doc.querySelector(
      '[data-testid="closet-seller-filters-hidden"]'
    );
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const ssrGrid = grid.innerHTML;
    await env.repost().run();

    // Masqués sélectionné : React remplace la grille.
    active.setAttribute("aria-pressed", "false");
    hidden.setAttribute("aria-pressed", "true");
    grid.innerHTML = ssrGrid;
    await sleep(250);

    env.doc
      .querySelector('[data-testid="closet-seller-filters-active--text"]')
      .click();
    await sleep(250);

    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.strictEqual(card.querySelector(".detniv-repost-name").textContent, "Blouse");
    assert.strictEqual(card.querySelector(".detniv-repost-meta").textContent, "Zara · L");
  });

  await test("repost : actualisation sur la garde-robe d'un autre membre → aucun rendu", async () => {
    const env = boot({
      url: "https://www.vinted.fr/member/999",
      cookie: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 37 })], 1, 1, 1
        ),
      },
    });
    await sleep(300);

    assert.strictEqual(env.fetchLog.length, 0, "fetch sur la garde-robe d'un autre membre");
    assert.strictEqual(env.closet().querySelector(".detniv-repost-name"), null);
  });

  await test("repost : run active le mode auto pour la garde-robe", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 34 })], 1, 1, 1
        ),
      },
    });
    await env.repost().run();
    assert.strictEqual(
      env.win.sessionStorage.getItem("detnivRepostAuto"),
      "251881314"
    );
  });

  await test("repost : reprise auto après navigation (marqueur pending)", async () => {
    const env = boot({
      activePressed: false,
      seedStore: {
        detnivRepostPending: { uid: "251881314", at: Date.now() },
      },
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 3 })], 1, 1, 1
        ),
      },
    });
    await sleep(400);
    assert.ok(!("detnivRepostPending" in env.store), "marqueur pending non consommé");
    assert.strictEqual(env.activeFilterClicks(), 1, "Actifs non cliqué après navigation");
    assert.strictEqual(
      env.closet().querySelectorAll('[data-testid="grid-item"]').length,
      1,
      "grille non rechargée après navigation"
    );
    assert.strictEqual(env.store.detnivRepostResult.count, 1);
    assert.ok(env.store.detnivRepostResult.at > 0);
  });

  await test("repost : marqueur pending expiré ignoré", async () => {
    const env = boot({
      seedStore: {
        detnivRepostPending: { uid: "251881314", at: Date.now() - 120000 },
      },
    });
    await sleep(200);
    assert.ok(!("detnivRepostPending" in env.store), "marqueur expiré conservé");
    assert.strictEqual(env.fetchLog.length, 0, "fetch malgré l'expiration");
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
