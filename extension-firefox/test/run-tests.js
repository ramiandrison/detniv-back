/**
 * Tests de l'extension — exécutés avec : node test/run-tests.js
 *
 * 1. enhance.js  : fonctions pures (auto-niveaux, flou, masque de flou)
 * 2. bridge.js   : protocole postMessage + contexte React mocké + upload
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

const flush = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
};

/* ════════════════ 1. enhance.js ════════════════ */

const enhance = require(path.join(__dirname, "..", "enhance.js"));

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const off = (y * width + x) * 4;
      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
      data[off + 3] = a;
    }
  }
  return data;
}

function channelRange(data, channel) {
  let min = 255;
  let max = 0;
  for (let i = channel; i < data.length; i += 4) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return [min, max];
}

async function runEnhanceTests() {
  await test("enhance : auto-niveaux étire une plage étroite (60→190)", () => {
    const w = 64;
    const h = 64;
    const data = makeImage(w, h, (x, y) => {
      const v = 60 + Math.round((130 * (x + y)) / (w + h - 2));
      return [v, v, v];
    });
    enhance.processImage(data, w, h, { saturation: 1 });
    const [min, max] = channelRange(data, 0);
    assert.ok(min <= 20, `min trop haut : ${min}`);
    assert.ok(max >= 235, `max trop bas : ${max}`);
  });

  await test("enhance : une image grise reste grise (pas de dominante)", () => {
    const w = 32;
    const h = 32;
    const data = makeImage(w, h, (x) => [40 + x * 3, 40 + x * 3, 40 + x * 3]);
    enhance.processImage(data, w, h);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      assert.ok(Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2, `dérive couleur @${i}`);
    }
  });

  await test("enhance : image plate = aucun artefact (LUT identité)", () => {
    const w = 16;
    const h = 16;
    const data = makeImage(w, h, () => [128, 128, 128]);
    enhance.processImage(data, w, h);
    for (let i = 0; i < data.length; i += 4) {
      assert.ok(
        data[i] >= 127 && data[i] <= 129 && data[i] === data[i + 1],
        `pixel ${data[i]}`
      );
    }
  });

  await test("enhance : le canal alpha est conservé", () => {
    const w = 8;
    const h = 8;
    const data = makeImage(w, h, (x, y) => [x * 8, y * 8, 128, 77]);
    enhance.processImage(data, w, h);
    for (let i = 3; i < data.length; i += 4) {
      assert.strictEqual(data[i], 77, `alpha modifié @${i}`);
    }
  });

  await test("boxBlur : image constante → flou constant exact", () => {
    const w = 24;
    const h = 24;
    const data = makeImage(w, h, () => [128, 128, 128]);
    const blurred = enhance.boxBlurRgb(data, w, h, 2);
    for (let i = 0; i < blurred.length; i++) {
      assert.strictEqual(blurred[i], 128, `@${i} = ${blurred[i]}`);
    }
  });

  await test("boxBlur : un impulsion est bien diffusée", () => {
    const w = 9;
    const h = 9;
    const data = makeImage(w, h, (x, y) =>
      x === 4 && y === 4 ? [255, 255, 255] : [0, 0, 0]
    );
    const blurred = enhance.boxBlurRgb(data, w, h, 1);
    const center = (4 * w + 4) * 3;
    const neighbor = (4 * w + 5) * 3;
    assert.ok(blurred[center] < 255 && blurred[center] > 0, "centre");
    assert.ok(blurred[neighbor] > 0, "voisin non alimenté");
  });

  await test("unsharpMask : image constante inchangée", () => {
    const w = 16;
    const h = 16;
    const data = makeImage(w, h, () => [200, 200, 200]);
    enhance.unsharpMask(data, w, h, 2, 0.45);
    for (let i = 0; i < data.length; i += 4) {
      assert.strictEqual(data[i], 200, `@${i} = ${data[i]}`);
    }
  });

  await test("buildLuts : sortie bornée 0-255 sur bruit complet", () => {
    const w = 64;
    const h = 64;
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    const data = makeImage(w, h, () => [rand(), rand(), rand()]);
    const luts = enhance.buildLuts(data);
    assert.strictEqual(luts.length, 3);
    for (const lut of luts) {
      assert.strictEqual(lut.length, 256);
      for (const v of lut) assert.ok(v >= 0 && v <= 255);
    }
    const before = channelRange(data, 0);
    enhance.processImage(data, w, h);
    const after = channelRange(data, 0);
    assert.ok(after[1] >= before[1] - 5, "plage haute non dégradée");
  });
}

/* ════════════════ 2. bridge.js ════════════════ */

function buildBridgeEnv() {
  const posted = [];
  let fetchImpl = null;

  const windowMock = {
    __env: "mock",
    addEventListener(type, handler) {
      if (type === "message") this.__handlers = this.__handlers || [];
      this.__handlers.push({ type, handler });
    },
    postMessage(msg) {
      posted.push(msg);
    },
  };

  // Contexte MediaSelect « à la Vinted » (mêmes règles que le provider).
  const ctx = {
    photos: [
      { id: 1, url: "https://images1.vinted.net/a/1.jpg", tempUuid: "t1" },
      { id: 2, url: "https://images1.vinted.net/b/2.jpg" },
    ],
    photoOrientations: [
      { id: 1, orientation: 0 },
      { id: 2, orientation: 1 },
    ],
    photoC2paMetadata: { 1: { sig: "c2pa" } },
    photoBlobUrls: { 1: "blob:original-1" },
    registered: [],
    calls: [],
    registerPhotoBlobUrl(id, url) {
      this.registered.push([id, url]);
      this.photoBlobUrls[id] = url;
    },
    changePhotoOrder() {},
    replacePhoto(oldId, photo, orientationEntry) {
      this.calls.push(["replace", oldId, photo, orientationEntry]);
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

  const fiberValue = { value: "contexte sans photos" };
  const fiberMedia = { memoizedProps: { value: ctx }, return: null };
  const fiberRoot = { memoizedProps: fiberValue, return: fiberMedia };

  const gridNode = { nodeType: 1, parentElement: null, parentNode: null };
  gridNode.__reactFiber$mock = fiberRoot;

  const documentMock = {
    documentElement: {
      innerHTML:
        'x{\\"CSRF_TOKEN\\":\\"75f6c9fa-dc8e-4e52-a000-e09dd4084b3e\\",\\"NODE_ENV\\":\\"production\\"}',
      lang: "fr",
    },
    cookie: "",
    querySelector(selector) {
      if (selector.includes("media-upload-grid") || selector.includes("media-upload")) {
        return this.__noGrid ? null : gridNode;
      }
      return null;
    },
    __noGrid: false,
  };

  global.window = windowMock;
  global.document = documentMock;
  if (typeof global.URL.createObjectURL !== "function") {
    global.URL.createObjectURL = () => "blob:detniv-test";
  }
  if (typeof global.URL.revokeObjectURL !== "function") {
    global.URL.revokeObjectURL = () => {};
  }
  global.fetch = (...args) => fetchImpl(...args);

  return {
    posted,
    ctx,
    documentMock,
    handlers: () => windowMock.__handlers || [],
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    send: (payload) => {
      for (const { handler } of windowMock.__handlers) {
        handler({ source: windowMock, data: payload });
      }
    },
    replies: () => posted.filter((m) => m && m.dir === "res"),
  };
}

async function call(env, method, params) {
  env.send({ __detniv: 1, dir: "req", id: Math.floor(Math.random() * 1e9), method, params });
  await flush();
  const all = env.replies();
  return all[all.length - 1];
}

async function runBridgeTests() {
  const env = buildBridgeEnv();
  require(path.join(__dirname, "..", "bridge.js"));

  await test("bridge : handler de message enregistré", () => {
    assert.ok(env.handlers().length >= 1, "aucun handler message");
  });

  await test("bridge : ping ok (grid + contexte)", async () => {
    const reply = await call(env, "ping");
    assert.strictEqual(reply.ok, true, reply.error);
    assert.deepStrictEqual(reply.result, {
      version: 1,
      hasGrid: true,
      hasContext: true,
    });
  });

  await test("bridge : state renvoie photos/orientations/blobUrls sérialisables", async () => {
    const reply = await call(env, "state");
    assert.strictEqual(reply.ok, true, reply.error);
    assert.strictEqual(reply.result.photos.length, 2);
    assert.strictEqual(reply.result.photos[0].id, 1);
    assert.strictEqual(reply.result.orientations[1].orientation, 1);
    assert.strictEqual(reply.result.blobUrls[1], "blob:original-1");
    // Aucune fonction ne doit fuiter dans la réponse
    const json = JSON.stringify(reply.result);
    assert.ok(!json.includes("function"), "objet non sérialisable");
  });

  await test("bridge : upload envoie POST /api/v2/photos + X-CSRF-Token", async () => {
    const seen = {};
    env.setFetch(async (url, options) => {
      seen.url = url;
      seen.options = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 42,
          url: "https://images1.vinted.net/new/42.jpg",
          temp_uuid: "tmp-42",
          high_resolution: "https://images1.vinted.net/hr/42.jpg",
        }),
      };
    });

    const reply = await call(env, "upload", {
      blob: new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
      type: "item",
      filename: "photo.jpg",
    });

    assert.strictEqual(reply.ok, true, reply.error);
    assert.strictEqual(reply.result.id, 42);
    assert.strictEqual(reply.result.url, "https://images1.vinted.net/new/42.jpg");
    assert.strictEqual(reply.result.tempUuid, "tmp-42");

    assert.strictEqual(seen.url, "/api/v2/photos");
    assert.strictEqual(seen.options.method, "POST");
    assert.strictEqual(
      seen.options.headers["X-CSRF-Token"],
      "75f6c9fa-dc8e-4e52-a000-e09dd4084b3e"
    );
    assert.strictEqual(seen.options.headers.Locale, "fr");
    const fd = seen.options.body;
    assert.strictEqual(fd.get("photo[type]"), "item");
    assert.strictEqual(fd.get("photo[file]").name, "photo.jpg");
  });

  await test("bridge : upload refuse une réponse en erreur", async () => {
    env.setFetch(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "csrf invalide" }),
    }));
    const reply = await call(env, "upload", { blob: new Blob(["x"]), type: "item" });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /csrf invalide/);
  });

  await test("bridge : replace applique la recette du crop Vinted", async () => {
    const reply = await call(env, "replace", {
      oldId: 1,
      photo: { id: 99, url: "https://images1.vinted.net/new/99.jpg" },
      orientation: 2,
      blob: new Blob(["enhanced"], { type: "image/jpeg" }),
    });
    assert.strictEqual(reply.ok, true, reply.error);

    // état mis à jour
    assert.ok(reply.result.photos.some((p) => p.id === 99));
    assert.ok(!reply.result.photos.some((p) => p.id === 1));
    assert.strictEqual(
      reply.result.orientations.find((o) => o.id === 99).orientation,
      2
    );
    // blob url enregistrée + ancienne révoquée
    assert.ok(env.ctx.registered.some(([id]) => id === 99));
    assert.match(String(env.ctx.photoBlobUrls[99]), /^blob:/);
    assert.ok(!(1 in env.ctx.photoBlobUrls));
    // c2pa migré vers le nouvel id
    assert.strictEqual(env.ctx.photoC2paMetadata[99].sig, "c2pa");
    assert.ok(!(1 in env.ctx.photoC2paMetadata));
  });

  await test("bridge : le jeton __detniv survit au remplacement", async () => {
    const reply = await call(env, "replace", {
      oldId: 2,
      photo: {
        id: 55,
        url: "https://images1.vinted.net/new/55.jpg",
        __detniv: "dtok1",
      },
      orientation: 1,
    });
    assert.strictEqual(reply.ok, true, reply.error);
    const p = reply.result.photos.find((x) => x.id === 55);
    assert.strictEqual(p.detniv, "dtok1");
  });

  await test("bridge : replace échoue proprement si l'ancienne photo a disparu", async () => {
    const reply = await call(env, "replace", {
      oldId: 4242,
      photo: { id: 100, url: "https://images1.vinted.net/new/100.jpg" },
      orientation: 0,
    });
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /remplacement non appliqué/);
    assert.ok(!env.ctx.photos.some((p) => p.id === 100));
  });

  await test("bridge : méthode inconnue → erreur explicite", async () => {
    const reply = await call(env, "nimporte-quoi");
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /méthode inconnue/);
  });

  await test("bridge : sans grille → « grille de photos introuvable »", async () => {
    env.documentMock.__noGrid = true;
    const reply = await call(env, "state");
    env.documentMock.__noGrid = false;
    assert.strictEqual(reply.ok, false);
    assert.match(reply.error, /grille de photos introuvable/);
  });
}

/* ════════════════ Exécution ════════════════ */

(async () => {
  await runEnhanceTests();
  await runBridgeTests();

  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}\n       ${r.err && r.err.message}`);
  }
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(failures ? 1 : 0);
})();
