/**
 * wand.js — bouton « baguette magique » sur chaque vignette photo Vinted.
 *
 * Côté content script (monde isolé) :
 *   - injection idempotente du bouton dans chaque vignette
 *   - orchestration : récupérer l'original → améliorer (enhance.js)
 *     → téléverser via le bridge → remplacer la photo dans l'état Vinted
 *   - « Annuler l'amélioration » : renvoie l'original (nouvel id serveur)
 *
 * Tout accès à React / au réseau identique à la page passe par bridge.js.
 */
(() => {
  "use strict";

  const GRID_SELECTOR = '[data-testid="media-upload-grid"]';
  const WRAPPER_SELECTOR = '[data-testid^="image-wrapper-"]';
  const STYLE_ID = "detniv-wand-styles";
  const TOAST_ID = "detniv-toast";
  const BRIDGE_FLAG = "data-detniv-bridge";

  const DEFAULT_SETTINGS = { format: "jpeg", quality: 0.92 };

  const WAND_SVG = `
    <svg class="detniv-wand-icon" viewBox="0 0 16 16" width="15" height="15"
         aria-hidden="true" focusable="false">
      <path d="M2.7 13.3 8.9 7.1" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round"/>
      <path d="M10.5 2.1l.62 1.48 1.48.62-1.48.62-.62 1.48-.62-1.48L8.4 4.2l1.48-.62z"/>
      <path d="M13.2 7.7l.44 1.06 1.06.44-1.06.44-.44 1.06-.44-1.06L11.7 9.2l1.06-.44z"/>
      <path d="M12.3 11.6l.32.74.74.32-.74.32-.32.74-.32-.74-.74-.32.74-.32z"/>
    </svg>`;

  /* ──────────────── État ──────────────── */

  let settings = { ...DEFAULT_SETTINGS };
  let bridgeReady = false;
  let bridgeWarned = false;
  let contextRetries = 0;
  let opLock = false;
  let refreshTimer = null;
  let refreshChain = Promise.resolve();

  /** jeton (jeton embarqué dans l'objet photo) → { originalBlob, originalOrientation } */
  const enhanced = new Map();

  const pendingCalls = new Map();
  let nextCallId = 1;

  function makeToken() {
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** Jeton posé par nous sur l'objet photo (ou renommé `detniv` par l'instantané du pont). */
  function tokenOf(photo) {
    if (!photo) return null;
    if (typeof photo.__detniv === "string") return photo.__detniv;
    if (typeof photo.detniv === "string") return photo.detniv;
    return null;
  }

  /**
   * Trouve l'entrée « améliorée » d'une photo.
   * Priorité au jeton embarqué (fiable quoi qu'il arrive aux ids serveur) ;
   * l'id reste en repli pour les entrées plus anciennes.
   */
  function findEntry(photo) {
    const token = tokenOf(photo);
    if (token && enhanced.has(token)) return { token, entry: enhanced.get(token) };
    if (photo && enhanced.has(photo.id)) {
      return { token: photo.id, entry: enhanced.get(photo.id) };
    }
    return null;
  }

  /* ──────────────── Réglages ──────────────── */

  async function loadSettings() {
    try {
      const result = await browser.storage.local.get("settings");
      if (result.settings) {
        settings = { ...DEFAULT_SETTINGS, ...result.settings };
      }
    } catch (_) {}
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    }
  });

  /* ──────────────── Pont (postMessage ↔ bridge.js) ──────────────── */

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__detniv !== 1 || msg.dir !== "res") return;
    if (typeof msg.id !== "number") return;

    const entry = pendingCalls.get(msg.id);
    if (!entry) return;
    pendingCalls.delete(msg.id);
    clearTimeout(entry.timer);
    msg.ok
      ? entry.resolve(msg.result)
      : entry.reject(new Error(msg.error || "erreur du pont"));
  });

  function callBridge(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`pont sans réponse (${method})`));
      }, timeoutMs);
      pendingCalls.set(id, { resolve, reject, timer });
      window.postMessage({ __detniv: 1, dir: "req", id, method, params }, "*");
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function ensureBridge() {
    if (bridgeReady) return;

    if (!document.querySelector(`script[${BRIDGE_FLAG}]`)) {
      const script = document.createElement("script");
      script.src = browser.runtime.getURL("bridge.js");
      script.setAttribute(BRIDGE_FLAG, "1");
      try {
        await new Promise((resolve, reject) => {
          const guard = setTimeout(
            () => reject(new Error("pont non chargé")),
            10000
          );
          script.onload = () => {
            clearTimeout(guard);
            resolve();
          };
          script.onerror = () => {
            clearTimeout(guard);
            reject(
              new Error(
                "injection du pont refusée (web_accessible_resources ?)"
              )
            );
          };
          (document.head || document.documentElement).appendChild(script);
        });
      } finally {
        // Le script exécuté reste actif même une fois la balise retirée ;
        // la retirer aussi après échec permet une nouvelle tentative.
        script.remove();
      }
    }

    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await callBridge("ping", {}, 2000);
        bridgeReady = true;
        return;
      } catch (_) {
        await sleep(120);
      }
    }
    throw new Error("pont avec Vinted indisponible");
  }

  /* ──────────────── Vignettes / DOM ──────────────── */

  function isPhotoBox(el) {
    if (!el || el.nodeType !== 1) return false;
    for (const cls of el.classList) {
      if (cls === "photo-box" || cls.endsWith("__photo-box")) return true;
    }
    return false;
  }

  function boxOf(wrapper) {
    for (let n = wrapper; n; n = n.parentElement) {
      if (isPhotoBox(n)) return n;
    }
    return null;
  }

  function photoIndex(box) {
    const wrapper = box.querySelector(WRAPPER_SELECTOR);
    if (!wrapper) return null;
    const match = /^image-wrapper-(\d+)$/.exec(
      wrapper.getAttribute("data-testid") || ""
    );
    return match ? Number(match[1]) : null;
  }

  function wrappers() {
    const grid = document.querySelector(GRID_SELECTOR);
    // Repli document : le bouton doit apparaître même si Vinted renomme
    // l'attribut de la grille.
    const scope = grid || document;
    return scope.querySelectorAll(WRAPPER_SELECTOR);
  }

  function uploadAreaPresent() {
    return !!(
      document.querySelector(GRID_SELECTOR) ||
      document.querySelector(WRAPPER_SELECTOR)
    );
  }

  function photoBoxes() {
    const boxes = [];
    for (const wrapper of wrappers()) {
      const box = boxOf(wrapper);
      if (box && !boxes.includes(box)) boxes.push(box);
    }
    return boxes;
  }

  function orientationOf(state, photoId) {
    for (const entry of state.orientations || []) {
      if (entry && typeof entry === "object" && entry.id === photoId) {
        return Number.isFinite(entry.orientation) ? entry.orientation : 0;
      }
    }
    return 0;
  }

  /* ──────────────── Bouton ──────────────── */

  function createButton(box) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "detniv-wand";
    btn.setAttribute("data-detniv-wand", "1");
    btn.title = "Améliorer l'image";
    btn.setAttribute("aria-label", "Améliorer l'image");
    btn.innerHTML = WAND_SVG;

    // Ne jamais laisser un pointerdown partir en glisser-déposer Vinted.
    for (const type of ["pointerdown", "mousedown", "touchstart", "dragstart"]) {
      btn.addEventListener(
        type,
        (event) => {
          event.stopPropagation();
        },
        true
      );
    }

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onWandClick(box, btn);
    });

    return btn;
  }

  function injectButtons() {
    for (const wrapper of wrappers()) {
      const box = boxOf(wrapper);
      if (!box || box.querySelector("[data-detniv-wand]")) continue;
      box.appendChild(createButton(box));
    }
  }

  function applyStates(state) {
    for (const box of photoBoxes()) {
      const btn = box.querySelector("[data-detniv-wand]");
      if (!btn) continue;

      const index = photoIndex(box);
      const photo = index == null ? null : state.photos[index];

      const img = box.querySelector("img");
      if (img && !img.dataset.detnivHooked) {
        img.dataset.detnivHooked = "1";
        img.addEventListener("load", scheduleRefresh);
      }
      const loading = !!box.querySelector('[data-testid$="-loader"]');
      const ready = img ? img.complete : true;

      btn.hidden = !photo || !ready || loading;
      if (!photo) continue;

      const isEnhanced = !!findEntry(photo);
      btn.dataset.mode = isEnhanced ? "active" : "idle";
      const label = isEnhanced
        ? "Annuler l'amélioration"
        : "Améliorer l'image";
      if (btn.title !== label) {
        btn.title = label;
        btn.setAttribute("aria-label", label);
      }
    }
  }

  /* ──────────────── Source originale ──────────────── */

  async function fetchOriginal(photo, state) {
    const candidates = [];
    const localUrl = state.blobUrls ? state.blobUrls[photo.id] : null;
    if (localUrl) candidates.push(localUrl);
    if (photo.url) candidates.push(photo.url);

    let lastError = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!blob.size) throw new Error("fichier vide");
        return blob;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      "image originale inaccessible" + (lastError ? ` (${lastError.message})` : "")
    );
  }

  /** Renvoie un blob téléversable : les HEIC sont décodés en JPEG. */
  async function toUploadable(blob) {
    if (await enhanceLib().maybeHeic(blob)) {
      const lib = typeof HeicTo !== "undefined" ? HeicTo : self.HeicTo;
      if (typeof lib !== "function") {
        throw new Error("décodeur HEIC indisponible");
      }
      return lib({ blob, type: "image/jpeg", quality: 0.95 });
    }
    return blob;
  }

  function enhanceLib() {
    const lib =
      typeof DetnivEnhance !== "undefined" ? DetnivEnhance : self.DetnivEnhance;
    if (!lib || typeof lib.enhanceBlob !== "function") {
      throw new Error("module d'amélioration indisponible");
    }
    return lib;
  }

  /* ──────────────── Actions ──────────────── */

  async function enhance(photo, state) {
    const lib = enhanceLib();
    const orientation = orientationOf(state, photo.id);

    const fetched = await fetchOriginal(photo, state);
    const source = await toUploadable(fetched);
    const improved = await lib.enhanceBlob(source, {
      quality: settings.quality,
    });

    const uploaded = await callBridge("upload", {
      blob: improved,
      type: "item",
      filename: "photo_amelioree.jpg",
    });

    // L'identité « annuler » voyage DANS l'objet photo (replacePhoto de
    // Vinted stocke notre objet tel quel) : elle ne dépend plus d'un id
    // serveur pouvant être ré-agencé ou d'une réponse perdue.
    const token = makeToken();
    uploaded.__detniv = token;
    enhanced.set(token, {
      originalBlob: source,
      originalOrientation: orientation,
    });

    // Enregistré AVANT le remplacement : si la réponse du pont est perdue
    // alors que l'état Vinted est déjà à jour, l'annulation reste possible.
    await callBridge("replace", {
      oldId: photo.id,
      photo: uploaded,
      orientation,
      blob: improved,
    });

    toast("Photo améliorée");
  }

  async function cancelEnhance(photo, token) {
    const entry = enhanced.get(token);
    if (!entry) throw new Error("rien à annuler");

    const restored = await callBridge("upload", {
      blob: entry.originalBlob,
      type: "item",
      filename: "photo_originale.jpg",
    });
    await callBridge("replace", {
      oldId: photo.id,
      photo: restored,
      orientation: entry.originalOrientation,
      blob: entry.originalBlob,
    });

    enhanced.delete(token);
    if (enhanced.has(photo.id)) enhanced.delete(photo.id);
    toast("Photo originale restaurée");
  }

  function setBusy(btn, busy) {
    if (busy) btn.dataset.busy = "1";
    else delete btn.dataset.busy;
  }

  async function onWandClick(box, btn) {
    if (opLock || btn.dataset.busy) return;
    opLock = true;
    setBusy(btn, true);
    try {
      await ensureBridge();

      const index = photoIndex(box);
      if (index == null) throw new Error("photo introuvable");

      const state = await callBridge("state");
      const photo = state.photos[index];
      if (!photo) throw new Error("photo introuvable");

      const hit = findEntry(photo);
      if (hit) {
        await cancelEnhance(photo, hit.token);
      } else {
        await enhance(photo, state);
      }
      await refresh();
    } catch (err) {
      console.error("[Detniv] baguette :", err);
      toast("Échec : " + ((err && err.message) || err), true);
    } finally {
      setBusy(btn, false);
      opLock = false;
    }
  }

  /* ──────────────── Rafraîchissement ──────────────── */

  async function refresh() {
    // Inutile d'injecter le pont hors des pages « vendre un article ».
    if (!uploadAreaPresent()) return;

    injectButtons();

    let state;
    try {
      await ensureBridge();
      state = await callBridge("state");
    } catch (err) {
      const message = String((err && err.message) || err);
      // React pas encore hydraté (début de page) : on réessaie sans
      // afficher d'erreur à l'utilisateur.
      const notReady =
        /grille de photos introuvable|contexte React|fiber React/.test(
          message
        );
      if (notReady) {
        if (contextRetries < 100) {
          contextRetries++;
          scheduleRefresh();
        }
        return;
      }
      if (!bridgeWarned) {
        bridgeWarned = true;
        toast("Pont Vinted indisponible : " + message, true);
      }
      return;
    }
    contextRetries = 0;
    applyStates(state);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshChain = refreshChain
        .then(refresh)
        .catch((err) => console.error("[Detniv] refresh :", err));
    }, 120);
  }

  /* ──────────────── Toast ──────────────── */

  function toast(message, isError) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle("detniv-toast-error", !!isError);
    el.classList.add("detniv-toast-show");
    clearTimeout(el.__detnivTimer);
    el.__detnivTimer = setTimeout(() => {
      el.classList.remove("detniv-toast-show");
    }, 3500);
  }

  /* ──────────────── Styles ──────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes detniv-spin { to { transform: rotate(360deg); } }
      @keyframes detniv-fade-in {
        from { opacity: 0; transform: translate(-50%, 8px); }
        to   { opacity: 1; transform: translate(-50%, 0); }
      }
      button.detniv-wand {
        position: absolute;
        /* Même repositionnement que le bouton « supprimer » de Vinted. */
        top: calc(var(--media-select-item-inset, 4px) + 6px);
        left: calc(var(--media-select-item-inset, 4px) + 6px);
        z-index: 3;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        color: #fff;
        background: rgba(13, 13, 13, .72);
        box-shadow: 0 1px 4px rgba(0, 0, 0, .45);
        transition: background .15s ease, color .15s ease, transform .1s ease;
      }
      button.detniv-wand:hover {
        background: #ffd600;
        color: #0d0d0d;
        transform: scale(1.06);
      }
      button.detniv-wand:active { transform: scale(.96); }
      button.detniv-wand:focus-visible { outline: 2px solid #ffd600; outline-offset: 2px; }
      button.detniv-wand[data-mode="active"] {
        background: #ffd600;
        color: #0d0d0d;
        box-shadow: 0 0 0 2px rgba(13, 13, 13, .8);
      }
      button.detniv-wand[hidden] { display: none !important; }
      button.detniv-wand[data-busy] { pointer-events: none; }
      button.detniv-wand[data-busy] .detniv-wand-icon { opacity: .2; }
      button.detniv-wand[data-busy]::after {
        content: "";
        position: absolute;
        inset: 5px;
        border: 2px solid rgba(255, 255, 255, .25);
        border-top-color: #ffd600;
        border-radius: 50%;
        animation: detniv-spin .8s linear infinite;
      }
      button.detniv-wand[data-mode="active"][data-busy]::after {
        border-color: rgba(13, 13, 13, .25);
        border-top-color: #0d0d0d;
      }
      #${TOAST_ID} {
        position: fixed;
        left: 50%;
        bottom: 28px;
        transform: translate(-50%, 0);
        z-index: 2147483647;
        max-width: min(420px, calc(100vw - 32px));
        padding: 11px 16px;
        border-radius: 10px;
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fff;
        background: #0d0d0d;
        border: 1px solid #2a2a2a;
        border-left: 3px solid #ffd600;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .6);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity .2s ease, visibility .2s ease;
      }
      #${TOAST_ID}.detniv-toast-show {
        opacity: 1;
        visibility: visible;
        animation: detniv-fade-in .25s ease;
      }
      #${TOAST_ID}.detniv-toast-error { border-left-color: #ff5252; }
    `;
    document.head.appendChild(style);
  }

  /* ──────────────── Init ──────────────── */

  const observer = new MutationObserver(() => scheduleRefresh());

  async function init() {
    injectStyles();
    await loadSettings();
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-testid"],
      });
    }
    scheduleRefresh();
    console.log("[Detniv] baguette magique prête — qualité:", settings.quality);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
