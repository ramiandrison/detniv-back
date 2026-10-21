/**
 * sources.js — chemins des sources de l'extension, pour les tests.
 *
 * Point unique de vérité : si un module change de dossier, seule cette table
 * est à mettre à jour (les tests et le manifeste restent lisibles).
 */
"use strict";

const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const SOURCES = {
  manifest: path.join(ROOT, "manifest.json"),

  // Runtime
  background: path.join(ROOT, "background", "background.js"),
  api: path.join(ROOT, "api", "api.js"),
  heicTo: path.join(ROOT, "lib", "heic-to.js"),
  enhance: path.join(ROOT, "lib", "enhance.js"),
  bridge: path.join(ROOT, "page", "bridge.js"),
  panel: path.join(ROOT, "panel", "panel.js"),

  // Fonctionnalités
  heicImport: path.join(ROOT, "features", "heic", "heic-import.js"),
  wand: path.join(ROOT, "features", "creation", "wand.js"),
  formTools: path.join(ROOT, "features", "creation", "form-tools.js"),
  repost: path.join(ROOT, "features", "republication", "repost.js"),

  // Popup
  popup: path.join(ROOT, "popup", "popup.js"),
};

module.exports = { ROOT, SOURCES };
