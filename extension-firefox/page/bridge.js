/**
 * bridge.js — exécuté dans le MONDE PAGE (injecté par features/creation/wand.js).
 *
 * Rôle : tout ce qui nécessite d'accéder au React de Vinted ou au
 * contexte réseau identique à celui de la page :
 *   - `ping`     : vérifie la disponibilité du pont
 *   - `state`    : instantané sérialisable du MediaSelectContext
 *                  (photos, orientations, blobUrls)
 *   - `upload`   : POST /api/v2/photos (mêmes en-têtes/cookies que l'app)
 *   - `replace`  : registerPhotoBlobUrl + replacePhoto (recette du crop Vinted)
 *
 * Protocole : window.postMessage({__detniv:1, dir:"req"|"res", ...})
 * (structured clone : Blob/File transitent tels quels)
 */
(() => {
  "use strict";

  if (window.__detnivBridgeInstalled) return;
  window.__detnivBridgeInstalled = true;

  const GRID_SELECTOR =
    '[data-testid="media-upload-grid"], [data-testid="media-upload"], [data-testid^="image-wrapper-"]';

  /* ──────────────── React / contexte ──────────────── */

  function getFiber(node) {
    for (let n = node; n; n = n.parentElement || n.parentNode) {
      if (n.nodeType !== 1) continue;
      const key = Object.keys(n).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")
      );
      if (key) return n[key];
    }
    return null;
  }

  function isMediaContext(v) {
    return !!(
      v &&
      Array.isArray(v.photos) &&
      typeof v.replacePhoto === "function" &&
      typeof v.registerPhotoBlobUrl === "function" &&
      typeof v.changePhotoOrder === "function"
    );
  }

  function findContext() {
    const root = document.querySelector(GRID_SELECTOR);
    if (!root) throw new Error("grille de photos introuvable");
    let fiber = getFiber(root);
    if (!fiber) throw new Error("fiber React introuvable");
    // On remonte l'arbre des fibers jusqu'au Provider le plus proche
    // (MediaSelectContext ou MediaUploadContext : les deux exposent l'API utile).
    // Chaque appel re-marche l'arbre : memoizedProps est frais à chaque render.
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      const v = fiber.memoizedProps && fiber.memoizedProps.value;
      if (isMediaContext(v)) return v;
    }
    throw new Error("contexte React Vinted introuvable");
  }

  function snapshotOf(ctx) {
    return {
      photos: (ctx.photos || []).map((p) => ({
        id: p.id,
        url: p.url,
        tempUuid: p.tempUuid || null,
        highResolution: p.highResolution || null,
        // Jeton posé par features/creation/wand.js sur l'objet photo : il est stocké tel quel
        // par replacePhoto et survit à tout ré-agencement des ids serveur.
        detniv: typeof p.__detniv === "string" ? p.__detniv : null,
      })),
      orientations: (ctx.photoOrientations || []).map((o) =>
        o && typeof o === "object"
          ? { id: o.id, orientation: o.orientation }
          : o
      ),
      blobUrls: { ...(ctx.photoBlobUrls || {}) },
    };
  }

  /* ──────────────── Upload (identique au chemin Vinted) ────────────────
   *
   * Vinted : ApiClient(baseURL "/api/v2") + intercepteur X-CSRF-Token
   *          → POST /api/v2/photos, FormData photo[type]/photo[file]
   *          (le crop de Vinted n'envoie pas non plus photo[temp_uuid]).
   */

  let csrfCache = null;

  function csrfToken() {
    if (csrfCache) return csrfCache;
    try {
      const meta = document.querySelector(
        'meta[name="csrf-token"], meta[name="csrf_token"]'
      );
      if (meta && meta.content) return (csrfCache = meta.content);

      const html = document.documentElement.innerHTML || "";
      const m = html.match(
        /CSRF_TOKEN[^0-9a-f-]{0,16}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      );
      if (m) return (csrfCache = m[1]);

      const cookie = document.cookie.match(
        /(?:^|;\s*)(?:csrf[^=]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      );
      if (cookie) return (csrfCache = cookie[1]);
    } catch (_) {}
    return null;
  }

  function locale() {
    try {
      const meta = document.querySelector('meta[name="iso-locale"]');
      if (meta && meta.content) return meta.content;
      if (document.documentElement.lang) return document.documentElement.lang;
    } catch (_) {}
    return null;
  }

  function pickDto(data) {
    if (!data || typeof data !== "object") return null;
    if (data.photo && typeof data.photo === "object") return data.photo;
    if (data.data && typeof data.data === "object") return data.data;
    if (data.payload && typeof data.payload === "object") return data.payload;
    if (Array.isArray(data.photos) && data.photos.length) return data.photos[0];
    return data;
  }

  async function uploadPhoto({ blob, type, filename }) {
    if (!(blob instanceof Blob)) throw new Error("image à téléverser invalide");

    const fd = new FormData();
    fd.append("photo[type]", type || "item");
    fd.append("photo[file]", blob, filename || "photo.jpg");

    const headers = { Accept: "application/json, text/plain, */*" };
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
    const loc = locale();
    if (loc) headers.Locale = loc;

    const res = await fetch("/api/v2/photos", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: fd,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg =
        (data && (data.message || data.message_code || data.error)) ||
        `HTTP ${res.status}`;
      throw new Error("téléversement refusé : " + msg);
    }
    if (data && typeof data === "object" && "errors" in data) {
      const first = Array.isArray(data.errors) && data.errors[0];
      const msg =
        (first && (first.message || first.code)) || "erreur serveur Vinted";
      throw new Error("téléversement refusé : " + msg);
    }

    const dto = pickDto(data);
    if (!dto || dto.id == null || !dto.url) {
      throw new Error("réponse d'upload invalide");
    }
    // Mêmes champs que transformMediaUploadPhotoDto de Vinted.
    return {
      id: dto.id,
      url: dto.url,
      tempUuid: dto.temp_uuid,
      highResolution: dto.high_resolution,
    };
  }

  /* ──────────────── Remplacement (recette exacte du crop Vinted) ──────────────── */

  function replacePhoto({ oldId, photo, orientation, blob }) {
    if (oldId == null) throw new Error("photo de départ manquante");
    if (!photo || photo.id == null || !photo.url) {
      throw new Error("photo cible invalide");
    }

    const ctx = findContext();

    if (blob instanceof Blob) {
      try {
        ctx.registerPhotoBlobUrl(photo.id, URL.createObjectURL(blob));
      } catch (_) {}
    }

    ctx.replacePhoto(oldId, photo, {
      id: photo.id,
      orientation: Number.isFinite(orientation) ? orientation : 0,
    });

    const snap = snapshotOf(ctx);
    const applied = snap.photos.some(
      (p) =>
        p.id === photo.id ||
        (typeof photo.__detniv === "string" && p.detniv === photo.__detniv)
    );
    if (!applied) {
      throw new Error("remplacement non appliqué (photo absente de l'état)");
    }
    return snap;
  }

  /* ──────────────── Protocole ──────────────── */

  const methods = {
    ping: () => ({
      version: 1,
      hasGrid: !!document.querySelector(GRID_SELECTOR),
      hasContext: (() => {
        try {
          findContext();
          return true;
        } catch (_) {
          return false;
        }
      })(),
    }),
    state: () => snapshotOf(findContext()),
    upload: (params) => uploadPhoto(params || {}),
    replace: (params) => replacePhoto(params || {}),
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__detniv !== 1 || msg.dir !== "req") return;
    if (typeof msg.id !== "number") return;

    const fn = methods[msg.method];
    const reply = (payload) =>
      window.postMessage({ __detniv: 1, dir: "res", ...payload }, "*");

    if (!fn) {
      reply({ id: msg.id, ok: false, error: "méthode inconnue : " + msg.method });
      return;
    }
    Promise.resolve()
      .then(() => fn(msg.params || {}))
      .then((result) => reply({ id: msg.id, ok: true, result }))
      .catch((err) =>
        reply({
          id: msg.id,
          ok: false,
          error: String((err && err.message) || err),
        })
      );
  });
})();
