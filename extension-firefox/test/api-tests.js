/**
 * Tests de api.js — exécutés avec :
 *   node test/api-tests.js
 *
 * Mocke browser.storage et fetch, puis vérifie :
 * session, refresh auto sur 401, extraction des erreurs, message si API absente.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");

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

/* ──────────────── Environnement mocké ──────────────── */

function makeBrowser() {
  const store = {};
  return {
    __store: store,
    storage: {
      local: {
        async get(key) {
          if (key == null) return { ...store };
          if (typeof key === "string") {
            return key in store ? { [key]: store[key] } : {};
          }
          const out = {};
          for (const k of key) if (k in store) out[k] = store[k];
          return out;
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
}

const fetchLog = [];
const fetchRoutes = {};

function mockFetch(url, options) {
  fetchLog.push({ url, options });
  const route = fetchRoutes[url];
  if (!route) {
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ message: "route inconnue : " + url }),
    });
  }
  const { status = 200, body } = typeof route === "function" ? route(options) : route;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/* ──────────────── Tests ──────────────── */

(async () => {
  global.browser = makeBrowser();
  global.fetch = mockFetch;
  const api = require(path.join(__dirname, "..", "api.js"));

  fetchRoutes["http://localhost:3001/auth/login"] = {
    status: 200,
    body: {
      success: true,
      data: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        user: { id: 7, email: "ada@detniv.test", name: "Ada" },
      },
    },
  };

  await test("api : login enregistre la session et renvoie l'utilisateur", async () => {
    const data = await api.handle("auth.login", {
      email: "ada@detniv.test",
      password: "motdepasse",
    });
    assert.strictEqual(data.user.email, "ada@detniv.test");
    const session = global.browser.__store.detnivSession;
    assert.strictEqual(session.accessToken, "access-1");
    assert.strictEqual(session.refreshToken, "refresh-1");
    assert.ok(session.expiresAt > Date.now(), "expiresAt manquant");
    const call = fetchLog[fetchLog.length - 1];
    assert.strictEqual(call.url, "http://localhost:3001/auth/login");
    assert.deepStrictEqual(JSON.parse(call.options.body), {
      email: "ada@detniv.test",
      password: "motdepasse",
    });
  });

  await test("api : session.get renvoie l'utilisateur", async () => {
    const data = await api.handle("session.get");
    assert.strictEqual(data.user.name, "Ada");
  });

  await test("api : auth.api envoie le Bearer token", async () => {
    fetchRoutes["http://localhost:3001/api/thing"] = {
      status: 200,
      body: { success: true, data: { id: 1 } },
    };
    const data = await api.handle("auth.api", {
      path: "/api/thing",
      method: "POST",
      body: { a: 1 },
    });
    assert.strictEqual(data.id, 1);
    const call = fetchLog[fetchLog.length - 1];
    assert.strictEqual(call.options.headers.Authorization, "Bearer access-1");
  });

  await test("api : 401 → refresh automatique puis nouvel essai", async () => {
    global.browser.__store.detnivSession.expiresAt = Date.now() + 60_000;
    fetchLog.length = 0;
    fetchRoutes["http://localhost:3001/auth/refresh"] = {
      status: 200,
      body: {
        success: true,
        data: { accessToken: "access-2", refreshToken: "refresh-2" },
      },
    };
    let calls = 0;
    fetchRoutes["http://localhost:3001/api/thing"] = () => {
      calls++;
      return calls === 1
        ? { status: 401, body: { message: "token expiré" } }
        : { status: 200, body: { success: true, data: { id: 2 } } };
    };

    const data = await api.handle("auth.api", { path: "/api/thing" });
    assert.strictEqual(data.id, 2);
    assert.strictEqual(fetchLog.length, 3, "appel api + refresh + nouvel appel api");
    assert.match(fetchLog[1].url, /\/auth\/refresh$/);
    assert.strictEqual(fetchLog[2].options.headers.Authorization, "Bearer access-2");
    const session = global.browser.__store.detnivSession;
    assert.strictEqual(session.accessToken, "access-2");
  });

  await test("api : erreur métier remontée telle quelle", async () => {
    fetchRoutes["http://localhost:3001/auth/login"] = {
      status: 401,
      body: { success: false, message: "Invalid credentials" },
    };
    await assert.rejects(
      () => api.handle("auth.login", { email: "x@y.z", password: "non" }),
      /Invalid credentials/
    );
  });

  await test("api : API injoignable → message explicite", async () => {
    const previous = global.fetch;
    global.fetch = () => Promise.reject(new TypeError("NetworkError"));
    try {
      await assert.rejects(
        () => api.handle("auth.login", { email: "a@b.c", password: "x" }),
        /API Detniv injoignable \(http:\/\/localhost:3001\)/
      );
    } finally {
      global.fetch = previous;
    }
  });

  await test("api : forgot-password (réponse anti-énumération)", async () => {
    fetchRoutes["http://localhost:3001/auth/forgot-password"] = {
      status: 200,
      body: {
        success: true,
        data: { message: "If this email exists, a reset link has been sent." },
      },
    };
    const data = await api.handle("auth.forgot", { email: "ada@detniv.test" });
    assert.match(data.message, /reset link/);
  });

  await test("api : resend-verification envoie le bon endpoint", async () => {
    fetchRoutes["http://localhost:3001/auth/resend-verification"] = {
      status: 200,
      body: {
        success: true,
        data: { message: "If this email exists and is not verified, a new code has been sent." },
      },
    };
    const data = await api.handle("auth.resend", { email: "ada@detniv.test" });
    assert.match(data.message, /new code has been sent/);
    const call = fetchLog[fetchLog.length - 1];
    assert.strictEqual(call.url, "http://localhost:3001/auth/resend-verification");
    assert.deepStrictEqual(JSON.parse(call.options.body), { email: "ada@detniv.test" });
  });

  await test("api : logout efface la session", async () => {
    await api.handle("auth.logout");
    assert.strictEqual(global.browser.__store.detnivSession, undefined);
    const after = await api.handle("session.get");
    assert.strictEqual(after, null);
  });

  await test("api : action inconnue → erreur explicite", async () => {
    await assert.rejects(() => api.handle("nimporte-quoi"), /action inconnue/);
  });

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
