/**
 * manifest-tests.js — cohérence du manifeste et de l'arborescence.
 *
 * Vérifie que tous les fichiers déclarés existent encore après un
 * déplacement, que l'ordre des content scripts respecte les dépendances,
 * et que le bridge page est bien déclaré et injecté au même chemin.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, SOURCES } = require("./sources");

const manifest = JSON.parse(fs.readFileSync(SOURCES.manifest, "utf8"));

const results = [];
let failures = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    failures++;
    results.push({ name, ok: false, err });
  }
}

function exists(rel) {
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `fichier manquant : ${rel}`);
}

const contentScripts = manifest.content_scripts[0].js;
const order = (file) => contentScripts.indexOf(file);

test("manifest : background, popup et icônes présents", () => {
  for (const script of manifest.background.scripts) exists(script);
  exists(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons)) exists(icon);
});

test("manifest : tous les content scripts existent", () => {
  for (const script of contentScripts) exists(script);
});

test("manifest : ordre de chargement des dépendances", () => {
  assert.ok(
    order("lib/heic-to.js") < order("features/heic/heic-import.js"),
    "heic-to doit précéder l'import HEIC"
  );
  assert.ok(
    order("lib/enhance.js") < order("features/creation/wand.js"),
    "enhance doit précéder la baguette"
  );
  assert.ok(
    order("api/api.js") < order("features/creation/form-tools.js"),
    "api doit précéder form-tools"
  );
  assert.ok(
    order("api/api.js") < order("panel/panel.js"),
    "api doit précéder le panneau"
  );
  assert.ok(
    order("features/republication/repost.js") < order("panel/panel.js"),
    "repost doit précéder le panneau"
  );
});

test("manifest : bridge page déclaré et injecté au même chemin", () => {
  const resources = manifest.web_accessible_resources[0].resources;
  assert.ok(resources.includes("page/bridge.js"), "bridge absent des ressources");
  for (const resource of resources) exists(resource);

  const wand = fs.readFileSync(SOURCES.wand, "utf8");
  assert.match(
    wand,
    /getURL\("page\/bridge\.js"\)/,
    "wand n'injecte pas page/bridge.js"
  );
});

for (const result of results) {
  if (result.ok) console.log(`  ok   ${result.name}`);
  else console.log(`  FAIL ${result.name}\n       ${result.err && result.err.message}`);
}

if (failures) {
  console.log(`\n${results.length - failures}/${results.length} tests réussis`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} tests réussis`);
