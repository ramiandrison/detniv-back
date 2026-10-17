/**
 * Tests d'intégration du panneau Detniv — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/panel-tests.js
 *
 * Simule div.site-content, mocke browser.storage et fetch, charge api.js
 * puis panel.js, et vérifie : injection, connexion, erreurs, déconnexion,
 * inscription (code de vérification), mot de passe oublié, réduction.
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
    "jsdom absent — lancez :  npm i --no-save jsdom  puis  node test/panel-tests.js"
  );
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const API_SRC = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const PANEL_SRC = fs.readFileSync(path.join(ROOT, "panel.js"), "utf8");

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Vinted</title></head>
<body>
  <div class="site-content"><main id="main"></main></div>
</body>
</html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = { id: 7, email: "ada@detniv.test", name: "Ada" };
const API = "http://localhost:3001/api";

function bootPanel(routes, seedStore) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(FIXTURE_HTML, {
    url: "https://www.vinted.fr/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;
  const fetchLog = [];
  const store = Object.assign({}, seedStore);

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
  };

  win.fetch = (url, options) => {
    fetchLog.push({ url, options });
    const route = routes[url];
    if (!route) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ message: "route inconnue : " + url }),
      });
    }
    const { status = 200, body } =
      typeof route === "function" ? route(options) : route;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  };

  win.eval(API_SRC);
  win.eval(PANEL_SRC);

  return {
    win,
    doc: win.document,
    store,
    fetchLog,
    panel: () => win.document.getElementById("detniv-panel"),
    calls: () => fetchLog.map((c) => c.url),
    async ready() {
      await sleep(40);
    },
  };
}

function setVal(win, input, value) {
  input.value = value;
}

function submit(win, form) {
  form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
}

async function click(win, node) {
  node.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
  await sleep(40);
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

const LOGIN_OK = {
  status: 200,
  body: {
    success: true,
    data: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      user: USER,
    },
  },
};

(async () => {
  await test("panel : injecté dans .site-content, vue connexion par défaut", async () => {
    const env = bootPanel({});
    await env.ready();
    const panel = env.panel();
    assert.ok(panel, "panneau absent");
    assert.strictEqual(panel.parentElement.className, "site-content");
    assert.match(panel.textContent, /DETNIV/);
    assert.ok(panel.querySelector("input[type=email]"), "champ e-mail absent");
    assert.ok(panel.querySelector("input[type=password]"), "champ mot de passe absent");
    assert.match(panel.textContent, /Se connecter/);
    assert.match(panel.textContent, /Créer un compte/);
  });

  await test("panel : connexion → menu (création d'annonce, republication, favoris)", async () => {
    const env = bootPanel({ [API + "/auth/login"]: LOGIN_OK });
    await env.ready();
    const panel = env.panel();
    setVal(env.win, panel.querySelector("input[type=email]"), "ada@detniv.test");
    setVal(env.win, panel.querySelector("input[type=password]"), "motdepasse");
    submit(env.win, panel.querySelector("form"));
    await sleep(40);

    const call = env.fetchLog.find((c) => c.url === API + "/auth/login");
    assert.ok(call, "POST /auth/login non effectué");
    // (champs à la main : objet de realm jsdom)
    const body = JSON.parse(call.options.body);
    assert.strictEqual(body.email, "ada@detniv.test");
    assert.strictEqual(body.password, "motdepasse");

    const bodyEl = env.panel().querySelector(".dv-body");
    assert.match(bodyEl.textContent, /Créer une annonce/);
    assert.match(bodyEl.textContent, /Republication/);
    assert.match(bodyEl.textContent, /Message aux favoris/);
    assert.match(bodyEl.textContent, /Déconnexion/);
    assert.match(bodyEl.textContent, /Bientôt/);
    assert.match(bodyEl.textContent, /ada@detniv\.test/);
    assert.ok(env.store.detnivSession, "session non stockée");
    assert.strictEqual(env.store.detnivSession.accessToken, "access-1");
  });

  await test("panel : erreur de connexion affichée, formulaire conservé", async () => {
    const env = bootPanel({
      [API + "/auth/login"]: { status: 500, body: { message: "Invalid credentials" } },
    });
    await env.ready();
    const panel = env.panel();
    setVal(env.win, panel.querySelector("input[type=email]"), "x@y.z");
    setVal(env.win, panel.querySelector("input[type=password]"), "non");
    submit(env.win, panel.querySelector("form"));
    await sleep(40);

    const notice = env.panel().querySelector(".dv-notice--error");
    assert.ok(notice, "notice d'erreur absente");
    assert.match(notice.textContent, /Invalid credentials/);
    assert.ok(env.panel().querySelector("input[type=email]"), "formulaire disparu");
  });

  await test("panel : compte non vérifié → renvoi du code → écran 6 chiffres", async () => {
    let loginCalls = 0;
    const env = bootPanel({
      // 1er appel : compte non vérifié (403) ; 2e (après vérification) : succès.
      [API + "/auth/login"]: () => {
        loginCalls++;
        return loginCalls === 1
          ? { status: 403, body: { message: "Account not verified" } }
          : LOGIN_OK;
      },
      [API + "/auth/resend-verification"]: {
        status: 200,
        body: {
          success: true,
          data: { message: "If this email exists and is not verified, a new code has been sent." },
        },
      },
      [API + "/auth/verify-email"]: {
        status: 200,
        body: { success: true, data: { message: "ok" } },
      },
    });
    await env.ready();
    const panel = env.panel();
    setVal(env.win, panel.querySelector("input[type=email]"), "ada@detniv.test");
    setVal(env.win, panel.querySelector("input[type=password]"), "motdepasse");
    submit(env.win, panel.querySelector("form"));
    await sleep(40);

    // Le renvoi du code a été demandé…
    const resend = env.fetchLog.find((c) => c.url === API + "/auth/resend-verification");
    assert.ok(resend, "POST /auth/resend-verification non effectué");
    assert.strictEqual(JSON.parse(resend.options.body).email, "ada@detniv.test");
    // …et l'écran des 6 chiffres est affiché.
    const codeInput = env.panel().querySelector("input[name=code]");
    assert.ok(codeInput, "écran de vérification absent");
    const notice = env.panel().querySelector(".dv-notice");
    assert.ok(notice, "notice absente");
    assert.match(notice.textContent, /code à 6 chiffres/);

    // Saisie du code → vérification → connexion automatique.
    setVal(env.win, codeInput, "654321");
    submit(env.win, env.panel().querySelector("form"));
    await sleep(40);
    const verify = env.fetchLog.find((c) => c.url === API + "/auth/verify-email");
    assert.ok(verify, "POST /auth/verify-email non effectué");
    assert.strictEqual(JSON.parse(verify.options.body).code, "654321");
    assert.match(env.panel().querySelector(".dv-body").textContent, /Déconnexion/);
  });

  await test("panel : session existante → menu dès l'ouverture", async () => {
    const env = bootPanel(
      {},
      {
        detnivSession: {
          accessToken: "a",
          refreshToken: "r",
          user: USER,
          expiresAt: Date.now() + 60_000,
        },
      }
    );
    await env.ready();
    assert.match(env.panel().querySelector(".dv-body").textContent, /Déconnexion/);
    assert.match(env.panel().textContent, /Ada/);
    assert.strictEqual(env.fetchLog.length, 0, "appel réseau inattendu à l'ouverture");
  });

  await test("panel : déconnexion → retour à la connexion", async () => {
    const env = bootPanel(
      {},
      {
        detnivSession: {
          accessToken: "a",
          refreshToken: "r",
          user: USER,
          expiresAt: Date.now() + 60_000,
        },
      }
    );
    await env.ready();
    const btn = [...env.panel().querySelectorAll("button")].find((b) =>
      /Déconnexion/.test(b.textContent)
    );
    await click(env.win, btn);
    assert.strictEqual(env.store.detnivSession, undefined);
    assert.ok(env.panel().querySelector("input[type=email]"), "vue login absente");
  });

  await test("panel : inscription → vérification du code → connexion auto", async () => {
    const env = bootPanel({
      [API + "/auth/register"]: {
        status: 201,
        body: { success: true, data: { message: "code envoyé" } },
      },
      [API + "/auth/verify-email"]: {
        status: 200,
        body: { success: true, data: { message: "ok" } },
      },
      [API + "/auth/login"]: LOGIN_OK,
    });
    await env.ready();
    const panel = env.panel();

    const tabRegister = [...panel.querySelectorAll(".dv-tab")].find((b) =>
      /Créer un compte/.test(b.textContent)
    );
    await click(env.win, tabRegister);

    const form = env.panel().querySelector("form");
    setVal(env.win, form.querySelector("input[name=name]"), "Ada");
    setVal(env.win, form.querySelector("input[name=email]"), "ada@detniv.test");
    setVal(env.win, form.querySelector("input[name=password]"), "motdepasse8");
    submit(env.win, form);
    await sleep(40);

    const register = env.fetchLog.find((c) => c.url === API + "/auth/register");
    assert.ok(register, "POST /auth/register non effectué");
    assert.strictEqual(JSON.parse(register.options.body).name, "Ada");

    const codeInput = env.panel().querySelector("input[name=code]");
    assert.ok(codeInput, "champ code absent");
    assert.strictEqual(codeInput.getAttribute("maxlength"), "6");
    setVal(env.win, codeInput, "123456");
    submit(env.win, env.panel().querySelector("form"));
    await sleep(40);

    const verify = env.fetchLog.find((c) => c.url === API + "/auth/verify-email");
    assert.ok(verify, "POST /auth/verify-email non effectué");
    assert.strictEqual(JSON.parse(verify.options.body).code, "123456");
    assert.match(env.panel().querySelector(".dv-body").textContent, /Déconnexion/);
  });

  await test("panel : mot de passe oublié → envoi du lien → retour connexion", async () => {
    const env = bootPanel({
      [API + "/auth/forgot-password"]: {
        status: 200,
        body: {
          success: true,
          data: { message: "If this email exists, a reset link has been sent." },
        },
      },
    });
    await env.ready();
    const forgotLink = [...env.panel().querySelectorAll("button")].find((b) =>
      /Mot de passe oublié/.test(b.textContent)
    );
    await click(env.win, forgotLink);
    setVal(env.win, env.panel().querySelector("input[type=email]"), "ada@detniv.test");
    submit(env.win, env.panel().querySelector("form"));
    await sleep(40);

    assert.ok(
      env.calls().includes(API + "/auth/forgot-password"),
      "POST /auth/forgot-password non effectué"
    );
    const notice = env.panel().querySelector(".dv-notice");
    assert.ok(notice, "notice absente");
    assert.match(notice.textContent, /réinitialisation/);
    assert.ok(env.panel().querySelector("input[type=email]"), "retour login absent");
  });

  await test("panel : réduction / réouverture", async () => {
    const env = bootPanel({});
    await env.ready();
    const collapse = env.panel().querySelector(".dv-collapse");
    await click(env.win, collapse);
    assert.ok(env.panel().classList.contains("dv-collapsed"), "panneau non réduit");
    const toggle = env.doc.getElementById("detniv-panel-toggle");
    assert.ok(toggle, "bouton d'ouverture absent");
    assert.notStrictEqual(toggle.style.display, "none");
    await click(env.win, toggle);
    assert.ok(!env.panel().classList.contains("dv-collapsed"), "panneau non rouvert");
  });

  await test("panel : le panneau survit au re-render de .site-content", async () => {
    const env = bootPanel({});
    await env.ready();
    // Vinted recrée son conteneur (re-render React).
    const fresh = env.doc.createElement("div");
    fresh.className = "site-content";
    fresh.appendChild(env.doc.createElement("main"));
    env.doc.querySelector(".site-content").replaceWith(fresh);
    await sleep(250); // debounce de l'observer (150 ms)
    const panel = env.doc.getElementById("detniv-panel");
    assert.ok(panel, "panneau perdu après re-render");
    assert.strictEqual(panel.parentElement.className, "site-content");
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
