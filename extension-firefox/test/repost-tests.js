/**
 * Tests d'intégration repost.js — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/repost-tests.js
 *
 * Simule la grille garde-robe Vinted (SSR), mocke fetch (pagination), charge
 * repost.js, puis vérifie : lecture de l'id dans l'URL, boucle de pagination
 * jusqu'à total_pages, remplacement du contenu de la grille, format prix,
 * repli sans card modèle, erreurs.
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
  html,
  cookie,
  runtimeCookie,
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
      runtimeCookie === undefined
        ? undefined
        : {
            async sendMessage(message) {
              messages.push(message);
              return { ok: true, value: runtimeCookie };
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

  let activeFilterClicks = 0;
  const activeButton = win.document.querySelector(
    '[data-testid="closet-seller-filters-active"]'
  );
  if (activeButton) {
    if (activePressed !== undefined) {
      activeButton.setAttribute("aria-pressed", activePressed ? "true" : "false");
    }
    activeButton.addEventListener("click", () => {
      activeFilterClicks++;
      activeButton.setAttribute("aria-pressed", "true");
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
    activeFilterClicks: () => activeFilterClicks,
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
      env.doc.querySelectorAll("#detniv-repost-styles").length,
      1,
      "feuille de styles dupliquée"
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

  await test("repost : clic sur un autre filtre → pas de re-rendu", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 22, title: "Jupe", brand_title: "H&M", size_title: "S" })],
          1, 1, 1
        ),
      },
    });
    const grid = env.closet().querySelector('[class*="feed-grid"]');
    const ssrGrid = grid.innerHTML;
    await env.repost().run();

    const hidden = env.doc.querySelector(
      '[data-testid="closet-seller-filters-hidden"]'
    );
    hidden.click();
    // Simule l'état React après le clic : Actifs n'est plus sélectionné.
    env.doc
      .querySelector('[data-testid="closet-seller-filters-active"]')
      .setAttribute("aria-pressed", "false");
    hidden.setAttribute("aria-pressed", "true");
    await sleep(120);
    grid.innerHTML = ssrGrid;
    await sleep(300);

    assert.strictEqual(
      env.closet().querySelector(".detniv-repost-name"),
      null,
      "grille re-rendue malgré un filtre inactif"
    );
    assert.strictEqual(
      env.closet().querySelector('[data-testid="grid-item"] img').getAttribute("src"),
      "old.jpg"
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
