/**
 * Tests d'intégration form-tools.js — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/form-tools-tests.js
 *
 * Simule le formulaire « Vends ton article » (SSR Vinted), charge
 * form-tools.js, puis vérifie : déplacement du champ Description entre
 * « Détails de l'article » et « Prix », barre d'outils, générateurs,
 * popup CRUD (API Detniv), ré-ancrage après re-render.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (_) {
  console.error(
    "jsdom absent — lancez :  npm i --no-save jsdom  puis  node test/form-tools-tests.js"
  );
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "form-tools.js"), "utf8");

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Vends ton article | Vinted</title></head>
<body>
  <p class="web_ui__Text__text web_ui__Text__section-heading">Présentation de ton article</p>
  <div class="web_ui__Card__card web_ui__Card__overflowAuto" id="pres-card">
    <label data-testid="title">
      <div class="web_ui__Input__title">Titre</div>
      <div class="web_ui__Input__content">
        <input id="title" data-testid="title--input" type="text" placeholder="Dis aux acheteurs ce que tu vends">
      </div>
    </label>
    <div class="web_ui__Divider__divider"></div>
    <label for="description" data-testid="description">
      <div class="web_ui__Input__title" data-testid="description--title">Description</div>
      <div class="web_ui__Input__content">
        <textarea id="description" data-testid="description--input"
                  placeholder="Ajoute des informations utiles"></textarea>
      </div>
    </label>
  </div>

  <p class="web_ui__Text__text web_ui__Text__section-heading">Détails de l'article</p>
  <div class="web_ui__Card__card web_ui__Card__overflowVisible" id="details-card">
    <ul class="web_ui__List__list">
      <li class="web_ui__Item__item">
        <div class="InputDropdown-module__input-dropdown">
          <label>Catégorie</label>
          <div class="input-dropdown__content">
            <input data-testid="catalog-select-dropdown-input" value="Jeans troués">
          </div>
        </div>
      </li>
      <li class="web_ui__Item__item">
        <div class="InputDropdown-module__input-dropdown">
          <label>Marque</label>
          <div class="input-dropdown__content">
            <input value="Sélectionne une marque">
          </div>
        </div>
      </li>
      <li class="web_ui__Item__item">
        <div class="InputDropdown-module__input-dropdown">
          <label>Taille</label>
          <div class="input-dropdown__content">
            <input value="M">
          </div>
        </div>
      </li>
      <li class="web_ui__Item__item">
        <div class="InputDropdown-module__input-dropdown">
          <label>État</label>
          <div class="input-dropdown__content">
            <input value="Neuf avec étiquette">
          </div>
        </div>
      </li>
    </ul>
  </div>

  <div class="web_ui__Spacer__x2-large web_ui__Spacer__horizontal" id="spacer-x2"></div>
  <p class="web_ui__Text__text web_ui__Text__section-heading">Prix</p>
  <div class="web_ui__Spacer__large web_ui__Spacer__horizontal"></div>
  <div class="web_ui__Card__card" id="price-card">
    <label data-testid="price-input">
      <div class="web_ui__Input__title">Prix</div>
      <div class="web_ui__Input__content">
        <input data-testid="price--input" value="">
      </div>
    </label>
  </div>
</body>
</html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot({ loggedIn = true, apiFail = false } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(FIXTURE_HTML, {
    url: "https://www.vinted.fr/items/new",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;

  // Mock de l'API Detniv (même contrat que api.js) en mémoire.
  const api = { templates: [], calls: [], user: loggedIn ? { id: 1, email: "t@example.com" } : null };
  let nextId = 1;
  win.DetnivApi = {
    async handle(action, payload) {
      if (action === "session.get") return { user: api.user };
      if (action === "auth.api") {
        if (apiFail) throw new Error("API Detniv injoignable.");
        const { path: reqPath, method = "POST", body } = payload || {};
        api.calls.push({ path: reqPath, method, body });
        if (reqPath === "/descriptions" && method === "GET") {
          return api.templates.map((t) => ({ ...t }));
        }
        if (reqPath === "/descriptions" && method === "POST") {
          const item = {
            id: nextId++,
            name: body.name,
            text: body.text,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          api.templates.unshift(item);
          return { ...item };
        }
        const m = /^\/descriptions\/(\d+)$/.exec(reqPath);
        if (m && method === "DELETE") {
          const id = Number(m[1]);
          api.templates = api.templates.filter((t) => t.id !== id);
          return { message: "Description deleted." };
        }
        const err = new Error("Erreur API.");
        err.status = 404;
        throw err;
      }
      throw new Error("action inconnue : " + action);
    },
  };

  win.confirm = () => true;
  win.eval(SRC);
  return {
    win,
    doc: win.document,
    api,
    async ready() {
      await sleep(50);
    },
  };
}

function click(win, node) {
  node.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
}

function buttons(doc, label) {
  return [...doc.querySelectorAll("button")].filter((b) => b.textContent === label);
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

(async () => {
  await test("form-tools : Description dans sa carte entre Détails et Prix", async () => {
    const env = boot();
    await env.ready();
    const label = env.doc.querySelector('label[data-testid="description"]');
    assert.ok(label, "champ description absent");
    const slot = label.parentElement;
    assert.strictEqual(slot.getAttribute("data-detniv-desc-slot"), "1", "slot absent");
    assert.ok(slot.classList.contains("web_ui__Card__card"), "slot non en carte");
    assert.ok(!env.doc.querySelector("#pres-card label[data-testid='description']"),
      "description encore dans Présentation");
    assert.ok(!slot.closest("#details-card"), "description encore dans la carte Détails");
    // Entre la carte Détails et le titre Prix : slot après #spacer-x2, suivi
    // d'un spacer cloné puis du titre Prix.
    assert.strictEqual(slot.previousElementSibling.id, "spacer-x2", "slot mal positionné");
    const after = slot.nextElementSibling;
    assert.ok(after && after.hasAttribute("data-detniv-desc-slot-spacer"), "spacer cloné absent");
    assert.strictEqual(after.nextElementSibling.textContent.trim(), "Prix", "titre Prix non suivant");
  });

  await test("form-tools : barre d'outils avec les 3 boutons", async () => {
    const env = boot();
    await env.ready();
    const bar = env.doc.querySelector(".detniv-ft-bar");
    assert.ok(bar, "barre d'outils absente");
    assert.ok(bar.closest(".web_ui__Input__content"), "barre hors du contenu du champ");
    for (const label of ["Générer une description", "Générer des hashtags", "Mes descriptions"]) {
      assert.ok(buttons(env.doc, label).length, `bouton « ${label} » absent`);
    }
  });

  await test("form-tools : génération de description à partir du formulaire", async () => {
    const env = boot();
    await env.ready();
    const title = env.doc.querySelector('input[data-testid="title--input"]');
    title.value = "Jean's slim noir taille M";
    const textarea = env.doc.querySelector("textarea[data-testid='description--input']");
    let inputEvents = 0;
    textarea.addEventListener("input", () => inputEvents++);

    click(env.win, buttons(env.doc, "Générer une description")[0]);

    const value = textarea.value;
    assert.match(value, /Jean's slim noir taille M/, "titre absent");
    assert.match(value, /Jeans troués/, "catégorie absente");
    assert.match(value, /Taille : M/, "taille absente");
    assert.match(value, /État : Neuf avec étiquette/, "état absent");
    assert.ok(!/Marque :/.test(value), "marque placeholder non filtrée");
    assert.ok(inputEvents >= 1, "événement input non émis (React non mis à jour)");
  });

  await test("form-tools : génération de hashtags", async () => {
    const env = boot();
    await env.ready();
    env.doc.querySelector('input[data-testid="title--input"]').value =
      "Veste en jean Zara";
    const textarea = env.doc.querySelector("textarea[data-testid='description--input']");
    click(env.win, buttons(env.doc, "Générer des hashtags")[0]);
    assert.match(textarea.value, /#jeans/, "hashtag catégorie manquant");
    assert.match(textarea.value, /#zara/, "hashtag marque manquant");
  });

  await test("form-tools : CRUD — appels API, ajouter, utiliser, supprimer", async () => {
    const env = boot();
    await env.ready();
    click(env.win, buttons(env.doc, "Mes descriptions")[0]);
    await sleep(30);
    const popup = env.doc.querySelector(".dv-crud-popup");
    assert.ok(popup, "popup CRUD absente");
    assert.match(popup.textContent, /Aucun modèle enregistré/);
    assert.strictEqual(env.api.calls[0].path, "/descriptions");
    assert.strictEqual(env.api.calls[0].method, "GET");

    // Ajout → POST /descriptions
    const nameInput = popup.querySelector(".dv-crud-input");
    const textArea = popup.querySelector(".dv-crud-textarea");
    nameInput.value = "Jeans Zara";
    textArea.value = "Superbe jeans Zara, taille M, état impeccable.";
    popup.querySelector(".dv-crud-add").dispatchEvent(
      new env.win.Event("submit", { bubbles: true, cancelable: true })
    );
    await sleep(30);
    assert.match(env.doc.querySelector(".dv-crud-popup").textContent, /Jeans Zara/);
    assert.strictEqual(env.api.templates.length, 1);
    assert.strictEqual(env.api.templates[0].name, "Jeans Zara");
    assert.ok(
      env.api.calls.some((c) => c.method === "POST" && c.path === "/descriptions"),
      "POST /descriptions non appelé"
    );

    // Utiliser → insertion dans le champ + fermeture
    const useBtn = buttons(env.doc, "Utiliser")[0];
    click(env.win, useBtn);
    const textarea = env.doc.querySelector("textarea[data-testid='description--input']");
    assert.match(textarea.value, /Superbe jeans Zara/, "modèle non inséré");
    assert.ok(!env.doc.querySelector(".dv-crud-overlay"), "popup non fermée");

    // Suppression → DELETE /descriptions/:id
    click(env.win, buttons(env.doc, "Mes descriptions")[0]);
    await sleep(30);
    click(env.win, buttons(env.doc, "Supprimer")[0]);
    await sleep(30);
    assert.strictEqual(env.api.templates.length, 0, "modèle non supprimé");
    assert.ok(
      env.api.calls.some((c) => c.method === "DELETE" && /^\/descriptions\/\d+$/.test(c.path)),
      "DELETE /descriptions/:id non appelé"
    );
    assert.match(env.doc.querySelector(".dv-crud-popup").textContent, /Aucun modèle/);
  });

  await test("form-tools : non connecté → message de connexion, pas de formulaire", async () => {
    const env = boot({ loggedIn: false });
    await env.ready();
    click(env.win, buttons(env.doc, "Mes descriptions")[0]);
    await sleep(30);
    const popup = env.doc.querySelector(".dv-crud-popup");
    assert.ok(popup, "popup CRUD absente");
    assert.match(popup.textContent, /Connectez-vous à Detniv/);
    assert.ok(!popup.querySelector(".dv-crud-add"), "formulaire d'ajout présent");
    assert.strictEqual(env.api.calls.length, 0, "appel API malgré la déconnexion");
  });

  await test("form-tools : erreur API affichée dans le popup", async () => {
    const env = boot({ apiFail: true });
    await env.ready();
    click(env.win, buttons(env.doc, "Mes descriptions")[0]);
    await sleep(30);
    const errorNode = env.doc.querySelector(".dv-crud-error");
    assert.ok(errorNode, "ligne d'erreur absente");
    assert.match(errorNode.textContent, /API Detniv injoignable/);
  });

  await test("form-tools : le champ reste ancré après re-render React", async () => {
    const env = boot();
    await env.ready();
    const label = env.doc.querySelector('label[data-testid="description"]');
    // Simule Vinted qui remet le champ à sa place d'origine.
    env.doc.querySelector("#pres-card").appendChild(label);
    // Déclenche l'observer.
    env.doc.body.appendChild(env.doc.createElement("div"));
    await sleep(400);
    assert.ok(
      label.parentElement.hasAttribute("data-detniv-desc-slot"),
      "non ré-ancré après re-render"
    );
    assert.ok(!label.closest("#details-card"));
    const after = label.parentElement.nextElementSibling;
    assert.ok(after && after.hasAttribute("data-detniv-desc-slot-spacer"), "spacer cloné absent");
    assert.strictEqual(after.nextElementSibling.textContent.trim(), "Prix");
  });

  await test("form-tools : Échap ferme le popup", async () => {
    const env = boot();
    await env.ready();
    click(env.win, buttons(env.doc, "Mes descriptions")[0]);
    await sleep(30);
    assert.ok(env.doc.querySelector(".dv-crud-overlay"));
    env.doc.dispatchEvent(
      new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    assert.ok(!env.doc.querySelector(".dv-crud-overlay"), "popup non fermée par Échap");
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
