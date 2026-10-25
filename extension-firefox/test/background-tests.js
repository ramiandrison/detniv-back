/**
 * Tests de background.js — exécutés avec :
 *   node test/background-tests.js
 *
 * Mocke browser.runtime, browser.cookies et fetch, puis vérifie :
 * téléchargement d'une image Vinted en data URL, refus des URLs non Vinted,
 * et lecture d'un cookie pour l'origine de l'onglet émetteur.
 */
"use strict";

const assert = require("node:assert");

const { SOURCES } = require("./sources");

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

let listener = null;
const fetchLog = [];
const cookies = { v_uid: "251881314" };
const dnrLog = [];

global.browser = {
  runtime: {
    onMessage: {
      addListener(fn) {
        listener = fn;
      },
    },
  },
  cookies: {
    async get({ name }) {
      return name in cookies ? { value: cookies[name] } : null;
    },
  },
  declarativeNetRequest: {
    updateDynamicRules({ addRules, removeRuleIds }) {
      dnrLog.push({ addRules, removeRuleIds });
      return Promise.resolve();
    },
  },
};

global.fetch = async (url, options) => {
  fetchLog.push({ url, options });
  if (url === "https://images1.vinted.net/t/photo.jpeg") {
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Buffer.from("image-bytes"),
    };
  }
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

require(SOURCES.background);

(async () => {
  await test("background : image Vinted renvoyée en data URL", async () => {
    const response = await listener(
      {
        type: "detniv:fetch-image",
        url: "https://images1.vinted.net/t/photo.jpeg",
      },
      { tab: { url: "https://www.vinted.fr/member/1" } }
    );
    assert.strictEqual(response.ok, true);
    assert.strictEqual(
      response.dataUrl,
      "data:image/jpeg;base64," +
        Buffer.from("image-bytes").toString("base64")
    );
    assert.strictEqual(fetchLog[0].options.credentials, "omit");
    // La règle DNR dynamique est installée avec l'origine de l'onglet
    assert.strictEqual(dnrLog.length, 1);
    const rule = dnrLog[0].addRules[0];
    assert.strictEqual(rule.id, 100);
    assert.strictEqual(
      rule.action.requestHeaders[0].value,
      "https://www.vinted.fr"
    );
    assert.strictEqual(
      rule.action.requestHeaders[1].value,
      "https://www.vinted.fr/"
    );
  });

  await test("background : origine Vinted déduite de l'onglet émetteur", async () => {
    const response = await listener(
      {
        type: "detniv:fetch-image",
        url: "https://images1.vinted.net/t/photo.jpeg",
      },
      { tab: { url: "https://www.vinted.de/item/42" } }
    );
    assert.strictEqual(response.ok, true);
    // La règle est remplacée avec la nouvelle origine
    assert.strictEqual(dnrLog.length, 2);
    const rule = dnrLog[1].addRules[0];
    assert.strictEqual(
      rule.action.requestHeaders[0].value,
      "https://www.vinted.de"
    );
    assert.strictEqual(
      rule.action.requestHeaders[1].value,
      "https://www.vinted.de/"
    );
  });

  await test("background : URL d'image non Vinted refusée", async () => {
    const before = fetchLog.length;
    const response = await listener(
      {
        type: "detniv:fetch-image",
        url: "https://example.com/photo.jpg",
      },
      { tab: { url: "https://www.vinted.fr/member/1" } }
    );
    assert.strictEqual(response.ok, false);
    assert.match(response.error, /invalide|inconnue/i);
    assert.strictEqual(fetchLog.length, before, "fetch non désiré");
  });

  await test("background : cookie Vinted lu pour l'origine de l'onglet", async () => {
    const response = await listener(
      { type: "detniv:get-cookie", name: "v_uid" },
      { tab: { url: "https://www.vinted.fr/member/1" } }
    );
    assert.deepStrictEqual(response, { ok: true, value: "251881314" });
  });

  for (const result of results) {
    if (result.ok) console.log(`  ok   ${result.name}`);
    else console.log(`  FAIL ${result.name}\n       ${result.err && result.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
