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
                    <button type="button" data-testid="bump-button">Booster</button>
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

  await test("repost : card rendue avec image, lien, titre, prix, vues", async () => {
    const env = boot({
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [
            makeItem({
              id: 777,
              title: "Robe été",
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
    assert.ok(!card.querySelector('[data-testid="bump-button"]'), "bouton Booster cloné conservé");
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
          [makeItem({ id: 9, title: "Sac", price: { amount: "5", currency_code: "EUR" } })],
          1, 1, 1
        ),
      },
    });
    assert.ok(env.closet(), "container absent du fixture");
    await env.repost().run();
    const card = env.closet().querySelector('[data-testid="grid-item"]');
    assert.ok(card, "card de repli absente");
    assert.strictEqual(card.querySelector("img").alt, "Sac");
    assert.strictEqual(card.querySelector("p").textContent, "5,00 €");
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

  await test("repost : start() lit v_uid dans document.cookie et lance la grille", async () => {
    const env = boot({
      cookie: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 1 }), makeItem({ id: 2 })], 1, 1, 2
        ),
      },
    });
    const result = await env.repost().start();
    assert.strictEqual(result.navigating, false);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.url, "https://www.vinted.fr/member/251881314");
    assert.strictEqual(
      env.closet().querySelectorAll('[data-testid="grid-item"]').length,
      2
    );
  });

  await test("repost : start() sans cookie → erreur v_uid", async () => {
    const env = boot({});
    await assert.rejects(() => env.repost().start(), /v_uid introuvable/);
    assert.strictEqual(env.fetchLog.length, 0);
  });

  await test("repost : start() lit v_uid via le background (cookie HttpOnly)", async () => {
    const env = boot({
      runtimeCookie: "251881314",
      pages: {
        [WARDROBE + "?page=1&per_page=20&cond=active"]: pageBody(
          [makeItem({ id: 7 })], 1, 1, 1
        ),
      },
    });
    const result = await env.repost().start();
    assert.strictEqual(result.count, 1);
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

  await test("repost : reprise auto après navigation (marqueur pending)", async () => {
    const env = boot({
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
