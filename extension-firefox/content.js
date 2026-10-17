(function () {
  "use strict";

  /* ──────────────── Constants ──────────────── */

  const HEIC_MIME_TYPES = new Set([
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
  ]);

  const HEIC_EXT_RE = /\.(heic|heif)$/i;

  const DEFAULT_SETTINGS = {
    format: "jpeg",
    quality: 0.92,
  };

  const PROGRESS_ID = "heic-ext-progress";
  const STYLE_ID = "heic-ext-styles";

  /* ──────────────── State ──────────────── */

  let settings = { ...DEFAULT_SETTINGS };
  let progressEl = null;

  // Guards anti-boucle
  const processingInputs = new WeakSet();
  const processingDropzones = new WeakSet();

  // Cache : évite de relire le magic bytes d'un même fichier
  const heicCache = new WeakMap();

  /* ──────────────── Settings ──────────────── */

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

  /* ──────────────── Helpers ──────────────── */

  function heicLib() {
    // Build IIFE : HeicTo EST la fonction heicTo, et HeicTo.isHeic existe
    const lib = typeof HeicTo !== "undefined" ? HeicTo : self.HeicTo;
    if (typeof lib !== "function") {
      throw new Error("Bibliothèque heic-to non chargée");
    }
    return lib;
  }

  /**
   * Détection HEIC : MIME/extension en premier (rapide),
   * puis vérification magic-bytes via heic-to (fiable, async).
   */
  async function isHeic(file) {
    // Cache hit
    if (heicCache.has(file)) return heicCache.get(file);

    // Fast path : MIME ou extension
    const quick =
      HEIC_MIME_TYPES.has(file.type) || HEIC_EXT_RE.test(file.name);

    let result = quick;
    if (quick) {
      // Double-check avec magic bytes pour éviter les faux positifs
      try {
        result = await heicLib().isHeic(file);
      } catch (_) {
        result = true; // en cas de doute, on tente la conversion
      }
    }

    heicCache.set(file, result);
    return result;
  }

  function outputMime() {
    return settings.format === "png" ? "image/png" : "image/jpeg";
  }

  function outputExt() {
    return settings.format === "png" ? "png" : "jpg";
  }

  function stripHeicExt(name) {
    return name.replace(HEIC_EXT_RE, "");
  }

  function buildDataTransfer(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  /* ──────────────── Conversion ──────────────── */

  async function convertHeicFile(file, index) {
    const heicTo = heicLib();

    const blob = await heicTo({
      blob: file,
      type: outputMime(),
      quality: settings.quality,
    });

    const base = stripHeicExt(file.name) || `photo_${index}`;
    return [
      new File([blob], `${base}.${outputExt()}`, {
        type: blob.type || outputMime(),
        lastModified: Date.now(),
      }),
    ];
  }

  /**
   * Converts every HEIC entry in `fileList`.
   * Returns an array of Files or null on error.
   */
  async function processFileList(fileList) {
    const files = Array.from(fileList);

    // Détection async de tous les HEIC
    const heicFlags = await Promise.all(files.map((f) => isHeic(f)));
    const totalHeic = heicFlags.filter(Boolean).length;
    if (totalHeic === 0) return null;

    const total = files.length;
    showProgress({ current: 0, total: totalHeic, totalAll: total, filename: "" });

    try {
      const result = [];
      let heicDone = 0;

      for (let i = 0; i < total; i++) {
        const file = files[i];

        if (heicFlags[i]) {
          heicDone++;
          showProgress({
            current: heicDone,
            total: totalHeic,
            totalAll: total,
            filename: file.name,
          });
          const converted = await convertHeicFile(file, i);
          result.push(...converted);
        } else {
          result.push(file);
        }
      }

      return result;
    } catch (err) {
      console.error("[HEIC Ext] Conversion échouée :", err);
      showError("Conversion HEIC échouée : " + (err.message || err));
      return null;
    }
  }

  /**
   * Check synchrone (MIME + extension) — utilisé AVANT stopPropagation
   * pour ne pas laisser l'événement original atteindre React pendant un await.
   */
  function maybeHeic(file) {
    return HEIC_MIME_TYPES.has(file.type) || HEIC_EXT_RE.test(file.name);
  }

  /* ──────────────── Event interception ────────────────
   *
   * RÈGLE : le stopPropagation doit être SYNCHRONE, avant tout await.
   * Ensuite seulement on vérifie via magic bytes + on convertit.
   */

  // ── change (file input) ──
  document.addEventListener(
    "change",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.type !== "file") return;
      if (processingInputs.has(input)) return;
      if (!input.files || input.files.length === 0) return;

      // ── CHECK SYNCHRONE : stoppe tout de suite si potentiel HEIC ──
      const files = Array.from(input.files);
      if (!files.some(maybeHeic)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      processingInputs.add(input);

      (async () => {
        try {
          // Vérification par magic bytes (async) puis conversion
          const converted = await processFileList(files);
          if (!converted) {
            // Pas en fait HEIC (faux positif) → on rejoue l'événement original
            input.files = buildDataTransfer(files).files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          input.files = buildDataTransfer(converted).files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (err) {
          console.error("[HEIC Ext] change handler error:", err);
          showError("Erreur : " + (err.message || err));
        } finally {
          setTimeout(() => processingInputs.delete(input), 0);
        }
      })();
    },
    true
  );

  // ── drop (dropzone) ──
  document.addEventListener(
    "drop",
    (event) => {
      const dropzone = event.target.closest?.('[data-testid="dropzone"]');
      if (!dropzone) return;
      if (processingDropzones.has(dropzone)) return;

      const dt = event.dataTransfer;
      if (!dt || dt.files.length === 0) return;

      // ── CHECK SYNCHRONE ──
      const files = Array.from(dt.files);
      if (!files.some(maybeHeic)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      processingDropzones.add(dropzone);

      (async () => {
        try {
          const converted = await processFileList(files);
          if (!converted) {
            dropzone.dispatchEvent(
              new DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: buildDataTransfer(files),
              })
            );
            return;
          }
          dropzone.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: buildDataTransfer(converted),
            })
          );
        } catch (err) {
          console.error("[HEIC Ext] drop handler error:", err);
          showError("Erreur : " + (err.message || err));
        } finally {
          setTimeout(() => processingDropzones.delete(dropzone), 0);
        }
      })();
    },
    true
  );

  /* ──────────────── Accept attribute patch ──────────────── */

  const ACCEPT_EXTENSION = ",.heic,.heif,image/heic,image/heif";

  function patchAcceptAttributes() {
    for (const input of document.querySelectorAll('input[type="file"]')) {
      const accept = input.getAttribute("accept") || "";
      if (accept.includes("image/") && !accept.includes(".heic")) {
        input.setAttribute("accept", accept + ACCEPT_EXTENSION);
      }
    }
  }

  /* ──────────────── Progress bar UI ──────────────── */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes heic-ext-fade-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #${PROGRESS_ID} {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        min-width: 260px;
        max-width: 360px;
        padding: 14px 18px;
        border-radius: 12px;
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fff;
        background: #0d0d0d;
        border: 1px solid #2a2a2a;
        box-shadow: 0 6px 24px rgba(0,0,0,.6);
        animation: heic-ext-fade-in .25s ease;
        pointer-events: none;
      }
      #${PROGRESS_ID}.heic-ext-error { background: #7a1010; border-color: #a33; }
      #${PROGRESS_ID} .heic-ext-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 8px;
      }
      #${PROGRESS_ID} .heic-ext-label {
        font-weight: 600;
        font-size: 13px;
      }
      #${PROGRESS_ID} .heic-ext-count {
        font-size: 12px;
        opacity: .8;
        white-space: nowrap;
        margin-left: 12px;
      }
      #${PROGRESS_ID} .heic-ext-bar-track {
        width: 100%;
        height: 6px;
        border-radius: 3px;
        background: rgba(255,255,255,.15);
        overflow: hidden;
        margin-bottom: 8px;
      }
      #${PROGRESS_ID} .heic-ext-bar-fill {
        height: 100%;
        border-radius: 3px;
        background: #ffd600;
        transition: width .3s ease;
        min-width: 0;
      }
      #${PROGRESS_ID} .heic-ext-filename {
        font-size: 11px;
        opacity: .65;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * @param {{current:number,total:number,totalAll:number,filename:string}} info
   */
  function showProgress(info) {
    ensureStyles();

    if (!progressEl || progressEl.classList.contains("heic-ext-error")) {
      hideProgress();
      progressEl = document.createElement("div");
      progressEl.id = PROGRESS_ID;

      const row = document.createElement("div");
      row.className = "heic-ext-row";

      const label = document.createElement("span");
      label.className = "heic-ext-label";
      label.textContent = "Conversion HEIC";

      const count = document.createElement("span");
      count.className = "heic-ext-count";

      row.appendChild(label);
      row.appendChild(count);

      const track = document.createElement("div");
      track.className = "heic-ext-bar-track";
      const fill = document.createElement("div");
      fill.className = "heic-ext-bar-fill";
      track.appendChild(fill);

      const filename = document.createElement("div");
      filename.className = "heic-ext-filename";

      progressEl.appendChild(row);
      progressEl.appendChild(track);
      progressEl.appendChild(filename);
      document.body.appendChild(progressEl);
    }

    const countEl = progressEl.querySelector(".heic-ext-count");
    const fillEl = progressEl.querySelector(".heic-ext-bar-fill");
    const fileEl = progressEl.querySelector(".heic-ext-filename");

    const { current, total, filename: fname } = info;

    countEl.textContent = total > 1 ? `${current} / ${total}` : "";

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    fillEl.style.width = pct + "%";

    if (fname) {
      fileEl.textContent = fname;
      fileEl.style.display = "";
    } else {
      fileEl.style.display = "none";
    }
  }

  function showError(message) {
    hideProgress();
    ensureStyles();

    progressEl = document.createElement("div");
    progressEl.id = PROGRESS_ID;
    progressEl.classList.add("heic-ext-error");
    progressEl.textContent = message;
    document.body.appendChild(progressEl);

    setTimeout(hideProgress, 5000);
  }

  function hideProgress() {
    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }
  }

  /* ──────────────── Mutation observer ──────────────── */

  let observerTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(patchAcceptAttributes, 100);
  });

  /* ──────────────── Init ──────────────── */

  async function init() {
    await loadSettings();
    patchAcceptAttributes();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    console.log(
      "[HEIC Ext] prêt — heic-to | format:", settings.format,
      "qualité:", settings.quality
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
