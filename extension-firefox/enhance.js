/**
 * enhance.js — pipeline d'amélioration d'image (canvas), côté content script.
 *
 * Étapes :
 *   1. décodage (HEIC via heic-to si besoin) → bitmap redressé (EXIF)
 *   2. fond blanc (évite les bords noirs en JPEG sur PNG transparents)
 *   3. auto-niveaux par canal (percentiles 0,4 % / 99,6 %)
 *   4. courbe en S douce + contraste, léger boost de saturation
 *   5. masque de flou (box blur séparable) pour la netteté
 *   6. encodage JPEG, puis rappel du comportement Vinted
 *      (resizePhoto : ≥ 1 Mo et côté > 1600 px → 1600 px, qualité 0,95)
 *
 * Les fonctions 3-5 sont pures (Uint8ClampedArray) : testables sous Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) root.DetnivEnhance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    lowClip: 0.004,
    highClip: 0.996,
    sCurve: 0.25,
    contrast: 1.05,
    saturation: 1.12,
    unsharpRadius: 2,
    unsharpAmount: 0.45,
    minStretchRange: 64,
    maxPixels: 24e6,
    maxDimension: 1600,
    resizeAboveBytes: 1048576,
    resizeQuality: 0.95,
  };

  const LUMA = [0.2126, 0.7152, 0.0722];

  /* ──────────────── Pure : auto-niveaux + courbe en S ──────────────── */

  function buildLuts(data, opts) {
    const o = { ...DEFAULTS, ...opts };
    const px = data.length / 4;
    const hist = [
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
    ];

    for (let i = 0; i < px; i++) {
      const off = i * 4;
      hist[0][data[off]]++;
      hist[1][data[off + 1]]++;
      hist[2][data[off + 2]]++;
    }

    const lowCount = px * o.lowClip;
    const highCount = px * (1 - o.highClip);
    const luts = [];

    for (let c = 0; c < 3; c++) {
      const h = hist[c];

      let acc = 0;
      let lo = 0;
      for (let v = 0; v < 256; v++) {
        acc += h[v];
        if (acc >= lowCount) {
          lo = v;
          break;
        }
      }

      acc = 0;
      let hi = 255;
      for (let v = 255; v >= 0; v--) {
        acc += h[v];
        if (acc >= highCount) {
          hi = v;
          break;
        }
      }

      // Image déjà bien répartie sur la plage → pas d'étirement (évite
      // d'amplifier le bruit d'une photo plate ou surexposée).
      if (hi - lo < o.minStretchRange) {
        lo = 0;
        hi = 255;
      }
      const span = hi - lo || 1;

      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let x = ((v - lo) / span) * 255;
        x = x < 0 ? 0 : x > 255 ? 255 : x;

        const t = x / 255;
        const s = t * t * (3 - 2 * t);
        let y = (1 - o.sCurve) * t + o.sCurve * s;
        y = 0.5 + (y - 0.5) * o.contrast;
        y = y < 0 ? 0 : y > 1 ? 1 : y;

        lut[v] = Math.round(y * 255);
      }
      luts.push(lut);
    }
    return luts;
  }

  function applyLutSaturation(data, luts, opts) {
    const o = { ...DEFAULTS, ...opts };
    const px = data.length / 4;
    const [lr, lg, lb] = luts;
    const sat = o.saturation;
    const [wr, wg, wb] = LUMA;

    for (let i = 0; i < px; i++) {
      const off = i * 4;
      let r = lr[data[off]];
      let g = lg[data[off + 1]];
      let b = lb[data[off + 2]];

      if (sat !== 1) {
        const lum = wr * r + wg * g + wb * b;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }

      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
      // canal alpha conservé tel quel
    }
  }

  /* ──────────────── Pure : box blur séparable sur RGB ──────────────── */

  function boxBlurRgb(data, width, height, radius) {
    const px = width * height;
    const tmp = new Uint8ClampedArray(px * 3);
    const out = new Uint8ClampedArray(px * 3);
    const win = radius * 2 + 1;

    // Horizontal
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let x = -radius; x <= radius; x++) {
        const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
        const off = (row + cx) * 4;
        sr += data[off];
        sg += data[off + 1];
        sb += data[off + 2];
      }
      for (let x = 0; x < width; x++) {
        const t = (row + x) * 3;
        tmp[t] = sr / win;
        tmp[t + 1] = sg / win;
        tmp[t + 2] = sb / win;

        const prev = (row + (x - radius < 0 ? 0 : x - radius)) * 4;
        const next = row + (x + radius + 1 >= width ? width - 1 : x + radius + 1);
        const nextOff = next * 4;
        sr += data[nextOff] - data[prev];
        sg += data[nextOff + 1] - data[prev + 1];
        sb += data[nextOff + 2] - data[prev + 2];
      }
    }

    // Vertical
    for (let x = 0; x < width; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = -radius; y <= radius; y++) {
        const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
        const t = (cy * width + x) * 3;
        sr += tmp[t];
        sg += tmp[t + 1];
        sb += tmp[t + 2];
      }
      for (let y = 0; y < height; y++) {
        const d = (y * width + x) * 3;
        out[d] = sr / win;
        out[d + 1] = sg / win;
        out[d + 2] = sb / win;

        const prevY = y - radius < 0 ? 0 : y - radius;
        const nextY = y + radius + 1 >= height ? height - 1 : y + radius + 1;
        const p = (prevY * width + x) * 3;
        const n = (nextY * width + x) * 3;
        sr += tmp[n] - tmp[p];
        sg += tmp[n + 1] - tmp[p + 1];
        sb += tmp[n + 2] - tmp[p + 2];
      }
    }

    return out;
  }

  function unsharpMask(data, width, height, radius, amount) {
    if (!(amount > 0) || !(radius > 0)) return;
    const blurred = boxBlurRgb(data, width, height, radius);
    const px = width * height;
    for (let i = 0; i < px; i++) {
      const off = i * 4;
      const t = i * 3;
      data[off] = data[off] + amount * (data[off] - blurred[t]);
      data[off + 1] = data[off + 1] + amount * (data[off + 1] - blurred[t + 1]);
      data[off + 2] = data[off + 2] + amount * (data[off + 2] - blurred[t + 2]);
    }
  }

  /** Applique l'intégrité du pipeline sur un buffer RGBA. */
  function processImage(data, width, height, opts) {
    const o = { ...DEFAULTS, ...opts };
    const luts = buildLuts(data, o);
    applyLutSaturation(data, luts, o);
    unsharpMask(data, width, height, o.unsharpRadius, o.unsharpAmount);
    return data;
  }

  /* ──────────────── Décodage ──────────────── */

  function heicLib() {
    const lib = typeof HeicTo !== "undefined" ? HeicTo : root.HeicTo;
    return typeof lib === "function" ? lib : null;
  }

  async function maybeHeic(blob) {
    if (/^image\/(heic|heif)/i.test(blob.type || "")) return true;
    const lib = heicLib();
    if (lib && typeof lib.isHeic === "function") {
      try {
        return !!(await lib.isHeic(blob));
      } catch (_) {}
    }
    return false;
  }

  async function decodeToDrawable(blob) {
    if (await maybeHeic(blob)) {
      const lib = heicLib();
      if (!lib) throw new Error("décodeur HEIC indisponible");
      blob = await lib({ blob, type: "image/jpeg", quality: 0.95 });
    }

    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (err) {
      // Repli : <img> décodé (certains formats non supportés par ImageBitmap)
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode();
        return img;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("échec d'encodage JPEG")),
        type,
        quality
      );
    });
  }

  /* ──────────────── Entrée ──────────────── */

  /**
   * @param {Blob} blob image source (JPEG/PNG/WebP/HEIC…)
   * @param {{quality?:number} & Partial<typeof DEFAULTS>} [opts]
   * @returns {Promise<Blob>} JPEG amélioré
   */
  async function enhanceBlob(blob, opts) {
    const o = { ...DEFAULTS, ...opts };
    const quality = typeof opts?.quality === "number" ? opts.quality : 0.92;

    const src = await decodeToDrawable(blob);
    let width = src.naturalWidth || src.width;
    let height = src.naturalHeight || src.height;
    if (!width || !height) throw new Error("image illisible");

    if (width * height > o.maxPixels) {
      const k = Math.sqrt(o.maxPixels / (width * height));
      width = Math.max(1, Math.round(width * k));
      height = Math.max(1, Math.round(height * k));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("contexte 2D indisponible");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, width, height);
    if (typeof src.close === "function") src.close();

    const image = ctx.getImageData(0, 0, width, height);
    processImage(image.data, width, height, o);
    ctx.putImageData(image, 0, 0);

    let out = await canvasToBlob(canvas, "image/jpeg", quality);

    // Miroir de Vinted resizePhoto (appelé uniquement si fichier ≥ 1 Mo)
    if (
      out.size >= o.resizeAboveBytes &&
      (width > o.maxDimension || height > o.maxDimension)
    ) {
      const k = Math.min(o.maxDimension / width, o.maxDimension / height);
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(width * k));
      small.height = Math.max(1, Math.round(height * k));
      const sctx = small.getContext("2d");
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(canvas, 0, 0, small.width, small.height);
      out = await canvasToBlob(small, "image/jpeg", o.resizeQuality);
    }

    return out;
  }

  return {
    DEFAULTS,
    buildLuts,
    applyLutSaturation,
    boxBlurRgb,
    unsharpMask,
    processImage,
    maybeHeic,
    enhanceBlob,
  };
});
