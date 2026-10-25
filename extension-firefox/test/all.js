/**
 * all.js — exécute toutes les suites de tests de l'extension.
 *
 *   node test/all.js
 *
 * Code de sortie non nul dès qu'une suite échoue (utilisable en CI).
 */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUITES = [
  "manifest-tests.js",
  "background-tests.js",
  "api-tests.js",
  "run-tests.js",
  "dom-tests.js",
  "form-tools-tests.js",
  "repost-tests.js",
  "panel-tests.js",
];

let failed = 0;

for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
    env: process.env,
  });
  if (result.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} suite(s) en échec.`);
  process.exit(1);
}

console.log("\nToutes les suites sont vertes.");
