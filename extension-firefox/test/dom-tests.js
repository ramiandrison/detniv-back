/**
 * Tests d'intégration DOM — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/dom-tests.js
 *
 * Simule la page Vinted (grille + vignettes + fiber React + fetch),
 * charge enhance.js / wand.js / bridge.js comme le ferait le navigateur,
 * puis vérifie le parcours complet :
 *   injection des boutons → améliorer → état Vinted remplacé → annuler.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
let requestInterceptor;
try {
  ({ JSDOM, requestInterceptor } = require("jsdom"));
} catch (_) {
  console.error(
    "jsdom absent — lancez :  npm i --no-save jsdom  puis  node test/dom-tests.js"
  );
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const CSRF_TOKEN = "75f6c9fa-dc8e-4e52-a000-e09dd4084b3e";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Vends ton article | Vinted</title>
  <script type="application/json" id="env">{"CSRF_TOKEN":"${CSRF_TOKEN}","NODE_ENV":"production"}</script>
</head>
<body>
  <div class="_media-select-module-scss-module__bhUXGW__media-select__grid _media-select-module-scss-module__bhUXGW__media-select__grid--flush"
       data-testid="media-upload-grid">
    <div data-testid="add-photos-icon-button"
         class="_media-select-module-scss-module__bhUXGW__media-select__input-box"></div>

    <div class="PhotoBox-module-scss-module__wSh2GW__photo-box">
      <div role="button" tabindex="0" class="u-cursor-grab">
        <div class="PhotoBox-module-scss-module__wSh2GW__photo-box__image-container" role="button" tabindex="0">
          <div data-testid="image-wrapper-0" style="transform: rotate(0deg);">
            <div class="web_ui__Image__image web_ui__Image__cover">
              <img class="web_ui__Image__content" alt="Photo 1"
                   src="data:image/png;base64,${PNG_BASE64}">
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="PhotoBox-module-scss-module__wSh2GW__photo-box">
      <div role="button" tabindex="0" class="u-cursor-grab">
        <div class="PhotoBox-module-scss-module__wSh2GW__photo-box__image-container" role="button" tabindex="0">
          <div data-testid="image-wrapper-1" style="transform: rotate(0deg);">
            <div class="web_ui__Image__image web_ui__Image__cover">
              <img class="web_ui__Image__content" alt="Photo 2"
                   src="data:image/png;base64,${PNG_BASE64}">
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sert bridge.js comme le ferait browser.runtime.getURL(). */
const extensionResources = {
  interceptors: [
    requestInterceptor((request) => {
      if (request.url === "https://extension.local/bridge.js") {
        return new Response(
          fs.readFileSync(path.join(ROOT, "bridge.js"), "utf8"),
          { headers: { "Content-Type": "application/javascript" } }
        );
      }
    }),
  ],
};

/* ──────────────── Contexte React simulé (règles du provider Vinted) ──────────────── */

function buildMockContext() {
  return {
    photos: [
      { id: 1, url: `data:image/png;base64,${PNG_BASE64}`, tempUuid: "tmp-a" },
      { id: 2, url: `data:image/png;base64,${PNG_BASE64}` },
    ],
    photoOrientations: [
      { id: 1, orientation: 2 },
      { id: 2, orientation: 0 },
    ],
    photoC2paMetadata: { 1: { sig: "c2pa" } },
    photoBlobUrls: {},
    registered: [],
    registerPhotoBlobUrl(id, url) {
      this.registered.push([id, url]);
      this.photoBlobUrls[id] = url;
    },
    changePhotoOrder() {},
    removePhoto(id) {
      this.photos = this.photos.filter((p) => p.id !== id);
    },
    replacePhoto(oldId, photo, orientationEntry) {
      if (!this.photos.some((p) => p.id === oldId)) return;
      this.photos = this.photos.map((p) => (p.id === oldId ? photo : p));
      this.photoOrientations = this.photoOrientations.map((o) =>
        o.id === oldId ? orientationEntry : o
      );
      if (oldId in this.photoC2paMetadata) {
        const meta = this.photoC2paMetadata[oldId];
        delete this.photoC2paMetadata[oldId];
        this.photoC2paMetadata[photo.id] = meta;
      }
      delete this.photoBlobUrls[oldId];
    },
  };
}

/* ──────────────── Helpers ──────────────── */

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

async function main() {
  const ctx = buildMockContext();
  const fetchCalls = [];
  const requests = [];
  let nextPhotoId = 100;

  const dom = new JSDOM(FIXTURE_HTML, {
    url: "https://www.vinted.fr/items/new",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    resources: extensionResources,
  });
  const win = dom.window;
  const doc = win.document;

  /* ── Stubs navigateur / extension ── */

  win.browser = {
    storage: {
      local: { get: async () => ({ settings: { format: "jpeg", quality: 0.92 } }) },
      onChanged: { addListener() {} },
    },
    runtime: { getURL: (p) => `https://extension.local/${p}` },
  };

  // Les content scripts et la page partagent le bus de messages.
  win.postMessage = (msg) => {
    if (msg && msg.__detniv === 1 && msg.dir === "req") {
      requests.push({ method: msg.method, params: msg.params });
    }
    const event = new win.MessageEvent("message", { data: msg });
    Object.defineProperty(event, "source", { value: win });
    win.dispatchEvent(event);
  };

  if (typeof win.URL.createObjectURL !== "function") {
    win.URL.createObjectURL = () => "blob:detniv-dom";
  }
  if (typeof win.URL.revokeObjectURL !== "function") {
    win.URL.revokeObjectURL = () => {};
  }

  win.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url === "/api/v2/photos") {
      const id = ++nextPhotoId;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id,
          url: `https://images1.vinted.net/fixture/${id}.jpg`,
          temp_uuid: `tmp-${id}`,
        }),
      };
    }
    if (typeof url === "string" && url.startsWith("data:")) {
      const base64 = url.split(",")[1];
      return {
        ok: true,
        status: 200,
        blob: async () =>
          new win.Blob([Buffer.from(base64, "base64")], { type: "image/png" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // Pipeline canvas indisponible sous jsdom : on le remplace.
  win.DetnivEnhance = {
    maybeHeic: async () => false,
    enhanceBlob: async () =>
      new win.Blob(["improved"], { type: "image/jpeg" }),
  };

  /* ── Fiber React simulée (grid → provider MediaSelectContext) ── */

  const grid = doc.querySelector('[data-testid="media-upload-grid"]');
  const fiberProvider = { memoizedProps: { value: ctx }, return: null };
  const fiberRoot = {
    memoizedProps: { value: { unrelated: true } },
    return: fiberProvider,
  };
  grid.__reactFiber$test = fiberRoot;

  /* ── Chargement des scripts ── */

  win.eval(fs.readFileSync(path.join(ROOT, "enhance.js"), "utf8"));
  win.DetnivEnhance = {
    // Repasse après enhance.js : canvas absent de jsdom.
    maybeHeic: async () => false,
    enhanceBlob: async () => new win.Blob(["improved"], { type: "image/jpeg" }),
  };
  win.eval(fs.readFileSync(path.join(ROOT, "wand.js"), "utf8"));

  // Les images jsdom ne se chargent pas : on signale « prête ».
  for (const img of doc.querySelectorAll("img")) {
    Object.defineProperty(img, "complete", { value: true });
  }

  await sleep(600);

  const buttons = () => doc.querySelectorAll("button.detniv-wand");
  const titleOf = (index) =>
    doc.querySelectorAll("button.detniv-wand")[index].title;

  /* ── Tests ── */

  await test("un bouton par vignette, hors du conteneur d'image", () => {
    assert.strictEqual(buttons().length, 2, `${buttons().length} boutons`);
    for (const btn of buttons()) {
      const box = btn.closest('[class*="__photo-box"]:not([class*="__photo-box__"])');
      assert.ok(box, "bouton hors vignette");
      assert.ok(
        !btn.closest('[data-testid^="image-wrapper-"]'),
        "bouton à l'intérieur de l'image"
      );
    }
  });

  await test("libellés initiaux + bouton visible", () => {
    assert.strictEqual(titleOf(0), "Améliorer l'image");
    assert.strictEqual(titleOf(1), "Améliorer l'image");
    for (const btn of buttons()) {
      assert.strictEqual(btn.getAttribute("aria-label"), "Améliorer l'image");
      assert.strictEqual(btn.hidden, false, "bouton masqué");
    }
  });

  await test("l'état Vinted est lu via le pont (photos + orientations)", async () => {
    // Le refresh initial a dû appeler state.
    const stateReqs = requests.filter((r) => r.method === "state");
    assert.ok(stateReqs.length >= 1, "aucun appel state");
    assert.ok(requests.some((r) => r.method === "ping"), "aucun ping");
  });

  await test("améliorer : upload + remplacement dans l'état Vinted", async () => {
    const btn = buttons()[0];
    btn.click();
    await sleep(700);

    // 1. original récupéré puis téléversé
    const uploads = fetchCalls.filter((c) => c.url === "/api/v2/photos");
    assert.strictEqual(uploads.length, 1, `${uploads.length} uploads`);
    assert.strictEqual(
      uploads[0].options.headers["X-CSRF-Token"],
      CSRF_TOKEN,
      "CSRF absent"
    );
    assert.strictEqual(uploads[0].options.body.get("photo[type]"), "item");
    assert.strictEqual(
      uploads[0].options.body.get("photo[file]").name,
      "photo_amelioree.jpg"
    );

    // 2. photo remplacée à l'index 0, orientation 2 conservée, c2pa migré
    // Le jeton d'annulation voyage dans l'objet photo stocké par Vinted.
    assert.strictEqual(typeof ctx.photos[0].__detniv, "string");
    assert.ok(ctx.photos[0].__detniv.length > 8);

    assert.strictEqual(ctx.photos[0].id, 101);
    assert.strictEqual(
      ctx.photos[0].url,
      "https://images1.vinted.net/fixture/101.jpg"
    );
    // (champs à la main : objets créés dans le realm jsdom)
    assert.strictEqual(ctx.photoOrientations[0].id, 101);
    assert.strictEqual(ctx.photoOrientations[0].orientation, 2);
    assert.ok(ctx.photoC2paMetadata[101], "c2pa non migré");
    assert.ok(ctx.registered.some(([id]) => id === 101), "blob url absente");
    assert.strictEqual(ctx.photos.length, 2, "nombre de photos modifié");

    // 3. bascule en mode « annuler »
    await sleep(300);
    assert.strictEqual(titleOf(0), "Annuler l'amélioration");
    assert.strictEqual(buttons()[0].dataset.mode, "active");

    const toast = doc.getElementById("detniv-toast");
    assert.ok(toast, "toast absent");
    assert.match(toast.textContent, /Photo améliorée/);
  });

  await test("annuler : l'original est renvoyé (nouvel id serveur)", async () => {
    const before = fetchCalls.filter((c) => c.url === "/api/v2/photos").length;
    buttons()[0].click();
    await sleep(700);

    const uploads = fetchCalls.filter((c) => c.url === "/api/v2/photos");
    assert.strictEqual(uploads.length, before + 1, "aucun upload d'annulation");
    const last = uploads[uploads.length - 1];
    assert.strictEqual(last.options.body.get("photo[file]").name, "photo_originale.jpg");

    assert.strictEqual(ctx.photos[0].id, 102);
    assert.strictEqual(ctx.photoOrientations[0].id, 102);
    assert.strictEqual(ctx.photoOrientations[0].orientation, 2);
    assert.strictEqual(ctx.photos.length, 2);

    await sleep(300);
    assert.strictEqual(titleOf(0), "Améliorer l'image");
    assert.strictEqual(buttons()[0].dataset.mode, "idle");
    const toast = doc.getElementById("detniv-toast");
    assert.match(toast.textContent, /restaurée/);
  });

  await test("la seconde vignette reste intacte", () => {
    assert.strictEqual(ctx.photos[1].id, 2);
    assert.strictEqual(titleOf(1), "Améliorer l'image");
  });

  await test("pas de boucle infinie de refresh", async () => {
    const count1 = requests.filter((r) => r.method === "state").length;
    await sleep(1000);
    const count2 = requests.filter((r) => r.method === "state").length;
    assert.ok(
      count2 - count1 <= 5,
      `refresh en boucle : +${count2 - count1} appels state en 1 s`
    );
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests DOM réussis`);
  dom.window.close();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
