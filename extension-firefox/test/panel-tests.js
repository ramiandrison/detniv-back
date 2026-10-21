/**
 * Tests d'intégration du panneau Detniv — exécutés avec :
 *   npm i --no-save jsdom
 *   node test/panel-tests.js
 *
 * Simule div.next-page > div.standard-layout.is-wide, mocke browser.storage
 * et fetch, charge api/api.js puis panel/panel.js, et vérifie : injection,
 * connexion, erreurs, déconnexion, inscription (code de vérification),
 * mot de passe oublié, réduction.
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
    "jsdom absent — lancez :  npm i --no-save jsdom  puis  node test/panel-tests.js"
  );
  process.exit(2);
}

const { SOURCES } = require("./sources");
const API_SRC = fs.readFileSync(SOURCES.api, "utf8");
const PANEL_SRC = fs.readFileSync(SOURCES.panel, "utf8");

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Vinted</title></head>
<body>
  <div class="next-page">
    <div class="standard-layout is-wide"><main id="main"></main></div>
  </div>
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
  await test("panel : inséré à côté de .standard-layout, vue connexion par défaut", async () => {
    const env = bootPanel({});
    await env.ready();
    const panel = env.panel();
    assert.ok(panel, "panneau absent");
    assert.ok(panel.parentElement.classList.contains("next-page"));
    assert.strictEqual(
      panel.nextElementSibling.className,
      "standard-layout is-wide",
      "panneau pas juste avant .standard-layout"
    );
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

  await test("panel : le panneau survit au re-render de .standard-layout", async () => {
    const env = bootPanel({});
    await env.ready();
    // Vinted recrée son conteneur (re-render React).
    const fresh = env.doc.createElement("div");
    fresh.className = "standard-layout is-wide";
    fresh.appendChild(env.doc.createElement("main"));
    env.doc.querySelector(".standard-layout").replaceWith(fresh);
    await sleep(250); // debounce de l'observer (150 ms)
    const panel = env.doc.getElementById("detniv-panel");
    assert.ok(panel, "panneau perdu après re-render");
    assert.ok(panel.parentElement.classList.contains("next-page"));
    assert.strictEqual(
      panel.nextElementSibling,
      fresh,
      "panneau pas réinséré avant le nouveau layout"
    );
  });

  await test("panel : Republication appelle DetnivRepost.start()", async () => {
    const env = bootPanel({ [API + "/auth/login"]: LOGIN_OK });
    await env.ready();
    const panel = env.panel();
    setVal(env.win, panel.querySelector("input[type=email]"), "ada@detniv.test");
    setVal(env.win, panel.querySelector("input[type=password]"), "motdepasse");
    submit(env.win, panel.querySelector("form"));
    await sleep(40);

    let started = 0;
    env.win.DetnivRepost = {
      async start() {
        started++;
        return { navigating: false, count: 17, pages: 2, url: "https://www.vinted.fr/member/7" };
      },
    };
    const btn = [...env.panel().querySelectorAll("button")].find((b) =>
      /^Republication/.test(b.textContent.trim())
    );
    assert.ok(btn, "bouton Republication absent");
    await click(env.win, btn);
    assert.strictEqual(started, 1, "DetnivRepost.start() non appelé");
    const notice = env.panel().querySelector(".dv-notice--success");
    assert.ok(notice, "notice de succès absente");
    assert.match(notice.textContent, /17 article\(s\).*2 page\(s\)/);
  });

  await test("panel : résultat de republication affiché à l'ouverture", async () => {
    const env = bootPanel({}, {
      detnivRepostResult: { count: 5, pages: 1, at: Date.now() },
    });
    await env.ready();
    const notice = env.panel().querySelector(".dv-notice--success");
    assert.ok(notice, "notice de résultat absente");
    assert.match(notice.textContent, /5 article\(s\)/);
    assert.ok(!("detnivRepostResult" in env.store), "résultat non consommé");
  });

  await test("panel : échec de republication affiché en erreur", async () => {
    const env = bootPanel({}, {
      detnivRepostResult: { count: 0, pages: 0, error: "HTTP 429", at: Date.now() },
    });
    await env.ready();
    const notice = env.panel().querySelector(".dv-notice--error");
    assert.ok(notice, "notice d'erreur absente");
    assert.match(notice.textContent, /Republication : HTTP 429/);
  });

  await test("panel : côte à côte — parent flex, sidebar sticky 288 px", async () => {
    const env = bootPanel({});
    await env.ready();
    const panel = env.panel();
    const host = env.doc.querySelector(".next-page");
    const panelStyle = env.win.getComputedStyle(panel);
    assert.notStrictEqual(panelStyle.position, "fixed", "panneau encore en fixed");
    assert.strictEqual(panelStyle.position, "sticky");
    assert.strictEqual(panel.parentElement, host, "panneau hors du parent du layout");
    const hostStyle = env.win.getComputedStyle(host);
    assert.strictEqual(hostStyle.display, "flex", ".next-page non flex");
    const css = env.doc.getElementById("detniv-panel-styles").textContent;
    assert.match(
      css,
      /\.dv-panel-host > \.standard-layout\s*\{\s*flex:\s*1 1 auto/,
      "layout non étiré dans le flex"
    );
    assert.match(css, /flex:\s*0 0 288px/, "largeur fixe de la sidebar absente");
  });

  await test("panel : burger masqué en desktop", async () => {
    const env = bootPanel({});
    await env.ready();
    const burger = env.doc.getElementById("detniv-burger");
    assert.ok(burger, "burger absent du DOM");
    assert.strictEqual(
      env.win.getComputedStyle(burger).display,
      "none",
      "burger visible en desktop"
    );
  });

  await test("panel : burger ouvre le tiroir, backdrop le ferme", async () => {
    const env = bootPanel({});
    await env.ready();
    Object.defineProperty(env.win, "innerWidth", { value: 500, configurable: true });
    const burger = env.doc.getElementById("detniv-burger");
    await click(env.win, burger);
    assert.ok(
      env.panel().classList.contains("dv-mobile-open"),
      "tiroir non ouvert"
    );
    const backdrop = env.doc.getElementById("detniv-panel-backdrop");
    assert.ok(backdrop.classList.contains("dv-visible"), "backdrop masqué");
    await click(env.win, backdrop);
    assert.ok(
      !env.panel().classList.contains("dv-mobile-open"),
      "tiroir non fermé par le backdrop"
    );
    assert.ok(!backdrop.classList.contains("dv-visible"), "backdrop encore visible");
  });

  await test("panel : mode sm — la croix ferme le tiroir sans replier la sidebar", async () => {
    const env = bootPanel({});
    await env.ready();
    Object.defineProperty(env.win, "innerWidth", { value: 500, configurable: true });
    await click(env.win, env.doc.getElementById("detniv-burger"));
    await click(env.win, env.panel().querySelector(".dv-collapse"));
    assert.ok(
      !env.panel().classList.contains("dv-mobile-open"),
      "tiroir non fermé par la croix"
    );
    assert.ok(
      !env.panel().classList.contains("dv-collapsed"),
      "sidebar repliée au lieu du tiroir fermé"
    );
  });

  await test("panel : Échap ferme le tiroir mobile", async () => {
    const env = bootPanel({});
    await env.ready();
    Object.defineProperty(env.win, "innerWidth", { value: 500, configurable: true });
    await click(env.win, env.doc.getElementById("detniv-burger"));
    assert.ok(env.panel().classList.contains("dv-mobile-open"));
    env.doc.dispatchEvent(
      new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    assert.ok(
      !env.panel().classList.contains("dv-mobile-open"),
      "tiroir non fermé par Échap"
    );
  });

  await test("panel : resize sm → desktop referme le tiroir", async () => {
    const env = bootPanel({});
    await env.ready();
    Object.defineProperty(env.win, "innerWidth", { value: 500, configurable: true });
    await click(env.win, env.doc.getElementById("detniv-burger"));
    assert.ok(env.panel().classList.contains("dv-mobile-open"));
    Object.defineProperty(env.win, "innerWidth", { value: 1280, configurable: true });
    env.win.dispatchEvent(new env.win.Event("resize"));
    assert.ok(
      !env.panel().classList.contains("dv-mobile-open"),
      "tiroir encore ouvert après retour desktop"
    );
    assert.ok(
      !env.doc.getElementById("detniv-panel-backdrop").classList.contains("dv-visible"),
      "backdrop encore visible"
    );
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
