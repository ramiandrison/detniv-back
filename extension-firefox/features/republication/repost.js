/**
 * repost.js — content script : republication (garde-robe Vinted).
 *
 * Sur une page profil membre (/member/<id>), recharge les articles du filtre
 * sélectionné via l'API Vinted : « Actifs » → cond=active, « Masqués » →
 * cond=hidden, « Brouillons » → cond=draft (GET
 * /api/v2/wardrobe/<id>/items?page=N&per_page=20&cond=…, en boucle jusqu'à
 * pagination.total_pages) puis remplace le contenu de la grille
 * (div.u-ui-margin-horizontal-regular@portables) par les articles renvoyés.
 * Avant tout chargement, le filtre « Actifs » est sélectionné s'il ne l'est
 * pas déjà. Chaque card affiche le nom, la marque et la taille de l'article
 * (`title`, `brand_title`, `size_title`) en plus du prix et des vues. Un champ
 * et un select ajoutés à la barre de filtres filtrent localement les cards sur
 * `item.title` et les trient par ID ou prix. Chaque card possède une case à
 * cocher ; le nombre total d'articles sélectionnés est affiché dans la barre
 * de filtres. Un re-rendu React de la grille ré-applique nos cards.
 *
 * Un bouton jaune « Republier » est ajouté à la barre de filtres. Il demande
 * si besoin la permission optionnelle d'hôte des images Vinted, puis envoie
 * à POST /images la photo principale des articles actifs sélectionnés
 * (multipart, lots de 20) et affiche le résultat de ce test d'upload. Les
 * photos Vinted ne sont jamais téléchargées par le content script (CORS du
 * CDN) ; le background est la seule voie, avec message d'erreur explicite.
 *
 * Déclenché depuis le panneau Detniv (menu « Republication ») :
 *   DetnivRepost.run() → { count, pages }
 *
 * À l'actualisation de la garde-robe du compte connecté (v_uid), autoStart()
 * sélectionne « Actifs » si nécessaire et relance le rendu sans panneau.
 */
(() => {
  "use strict";

  const CONTAINER_SEL = 'div[class*="u-ui-margin-horizontal-regular"]';
  const GRID_SEL = '[class*="feed-grid"]';
  const ITEM_SEL = '[data-testid="grid-item"]';
  const FILTERS_SEL = '[data-testid="closet-seller-filters"]';
  const ACTIVE_FILTER_SEL =
    '[data-testid="closet-seller-filters-active"], ' +
    '[data-testid="closet-seller-filters-active--text"]';
  const HIDDEN_FILTER_SEL =
    '[data-testid="closet-seller-filters-hidden"], ' +
    '[data-testid="closet-seller-filters-hidden--text"]';
  const DRAFT_FILTER_SEL =
    '[data-testid="closet-seller-filters-draft"], ' +
    '[data-testid="closet-seller-filters-draft--text"]';
  const STYLE_ID = "detniv-repost-styles";
  const SEARCH_ID = "detniv-repost-search";
  const SORT_ID = "detniv-repost-sort";
  const SELECT_CLASS = "detniv-repost-select";
  const SELECTED_CLASS = "detniv-repost-selected";
  const SELECTION_COUNT_ID = "detniv-repost-selection-count";
  const REPOST_BUTTON_ID = "detniv-repost-submit";
  const UPLOAD_STATUS_ID = "detniv-repost-upload-status";
  const SEARCH_HIDDEN_CLASS = "detniv-repost-hidden";
  const MAX_UPLOAD_BATCH = 20;
  const IMAGE_HOST_PERMISSION = "https://*.vinted.net/*";
  const SORT_OPTIONS = [
    { value: "default", label: "Ordre par défaut" },
    { value: "id-desc", label: "Plus récents" },
    { value: "id-asc", label: "Plus anciens" },
    { value: "price-asc", label: "Prix croissant" },
    { value: "price-desc", label: "Prix décroissant" },
  ];
  const PER_PAGE = 20;
  const PAGE_DELAY_MS = 120;
  const RECONCILE_DELAY_MS = 200;
  const FILTER_SETTLE_MS = 120;
  const UID_COOKIE = "v_uid";
  const PENDING_KEY = "detnivRepostPending";
  const RESULT_KEY = "detnivRepostResult";
  const AUTO_KEY = "detnivRepostAuto";
  const PENDING_TTL_MS = 60000;

  let busy = false;
  let lastRender = null;
  let reconcileTimer = null;
  let reconcileObserver = null;
  let suppressFilterClick = false;
  let pendingFilter = null;
  let filterRunSeq = 0;
  let activeCondition = null;
  let csrf = null;
  let searchQuery = "";
  let sortMode = "default";
  let uploadBusy = false;
  let uploadStatus = { kind: "idle", text: "" };
  /**
   * Sélection par clé d'article : `{ item, condition }`. L'objet complet est
   * conservé pour pouvoir uploader un article même après un changement de
   * filtre ou un re-rendu React. `condition` est le filtre d'où vient la
   * sélection : seuls les articles « active » sont republiables.
   */
  const selectedItems = new Map();

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ──────────────── Contexte navigateur / stockage ──────────────── */

  function browserApi() {
    if (typeof browser !== "undefined") return browser;
    return globalThis.browser || null;
  }

  function storageApi() {
    const api = browserApi();
    return api && api.storage && api.storage.local ? api.storage.local : null;
  }

  /**
   * Mode « republication automatique » : mémorisé dans sessionStorage, il
   * survit à l'actualisation de la page mais pas à la fermeture de l'onglet.
   */
  function autoWardrobeId() {
    try {
      return sessionStorage.getItem(AUTO_KEY);
    } catch (_) {
      return null;
    }
  }

  function rememberAutoWardrobe(wardrobeId) {
    try {
      sessionStorage.setItem(AUTO_KEY, String(wardrobeId));
    } catch (_) {}
  }

  function cookieFromDocument(name) {
    const prefix = name + "=";
    for (const part of String(document.cookie || "").split(";")) {
      const entry = part.trim();
      if (entry.startsWith(prefix)) {
        try {
          return decodeURIComponent(entry.slice(prefix.length));
        } catch (_) {
          return entry.slice(prefix.length);
        }
      }
    }
    return null;
  }

  /**
   * Lit un cookie pour l'origine courante. Voie rapide : document.cookie
   * (cookies non HttpOnly) ; sinon background.js via l'API browser.cookies
   * (les cookies de session Vinted sont HttpOnly).
   */
  async function readCookie(name) {
    const direct = cookieFromDocument(name);
    if (direct) return direct;
    const api = browserApi();
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") {
      return null;
    }
    const response = await api.runtime.sendMessage({
      type: "detniv:get-cookie",
      name,
    });
    if (!response || !response.ok) {
      throw new Error(
        (response && response.error) || "Lecture du cookie impossible."
      );
    }
    return response.value || null;
  }

  /**
   * Jeton CSRF utilisé par le client API de Vinted. Il est présent dans les
   * données RSC de la page (ou dans une meta selon les versions). Les appels
   * GET de l'API wardrobe l'exigent aussi.
   */
  function csrfToken() {
    if (csrf) return csrf;
    const meta = document.querySelector('meta[name="csrf-token"]');
    const metaValue = meta && meta.getAttribute("content");
    if (metaValue) {
      csrf = metaValue;
      return csrf;
    }
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes("CSRF_TOKEN")) continue;
      const match = /CSRF_TOKEN\\*"\s*:\s*\\*"([^"\\]+)/.exec(text);
      if (match) {
        csrf = match[1];
        return csrf;
      }
    }
    return null;
  }

  /* ──────────────── Lecture de la page ──────────────── */

  function wardrobeIdFromLocation() {
    const match = /^\/member\/(\d+)/.exec(location.pathname || "");
    return match ? match[1] : null;
  }

  function onWardrobePage(wardrobeId) {
    const path = location.pathname || "";
    return new RegExp("^/member/" + wardrobeId + "(/|$)").test(path);
  }

  async function waitForContainer(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let node = findContainer();
    while (!node && Date.now() < deadline) {
      await sleep(200);
      node = findContainer();
    }
    return node;
  }

  /**
   * Attente de la grille après un clic de filtre. On s'arrête dès qu'un autre
   * filtre est cliqué, pour ne pas bloquer le run suivant.
   */
  async function waitForFilterContainer(condition, runSeq, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let node = findContainer();
    while (!node && Date.now() < deadline) {
      if (runSeq !== filterRunSeq || !conditionIsCurrent(condition)) return null;
      await sleep(200);
      node = findContainer();
    }
    return node;
  }

  function findContainer() {
    for (const node of document.querySelectorAll(CONTAINER_SEL)) {
      if (node.querySelector(GRID_SEL) || node.querySelector(ITEM_SEL)) return node;
    }
    return null;
  }

  /* ──────────────── API Vinted (paginée) ──────────────── */

  async function fetchPage(wardrobeId, page, condition = "active") {
    const url =
      `${location.origin}/api/v2/wardrobe/${wardrobeId}/items` +
      `?page=${page}&per_page=${PER_PAGE}&cond=${encodeURIComponent(condition)}`;
    const headers = { Accept: "application/json" };
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
    console.info("[Detniv] API :", url);
    const res = await fetch(url, {
      headers,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`API Vinted en erreur (HTTP ${res.status})`);
    return res.json();
  }

  async function fetchAllItems(wardrobeId, condition = "active") {
    const items = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await fetchPage(wardrobeId, page, condition);
      if (Array.isArray(data.items)) items.push(...data.items);
      totalPages = Number((data.pagination || {}).total_pages) || 1;
      page += 1;
      if (page <= totalPages) await sleep(PAGE_DELAY_MS);
    } while (page <= totalPages);
    return { items, pages: totalPages };
  }

  /* ──────────────── Données d'un article ──────────────── */

  function photoUrl(item) {
    const photos = Array.isArray(item.photos) ? item.photos : [];
    const main = photos.find((p) => p && p.is_main) || photos[0] || {};
    return (
      main.full_size_url ||
      main.url ||
      (main.thumbnails && main.thumbnails[0] && main.thumbnails[0].url) ||
      ""
    );
  }

  /** Renvoie les URLs de toutes les photos de l'article. */
  function allPhotoUrls(item) {
    const photos = Array.isArray(item.photos) ? item.photos : [];
    return photos
      .map((p) => p && (p.full_size_url || p.url))
      .filter(Boolean);
  }

  function itemUrl(item) {
    if (item.url) return item.url;
    const path = item.path || "/items/" + item.id;
    return /^https?:/.test(path) ? path : location.origin + path;
  }

  /** Clé stable de sélection : l'ID Vinted, sinon l'URL de l'annonce. */
  function itemKey(item) {
    const id = item && item.id;
    if (id != null && id !== "") return "id:" + String(id);
    return "url:" + itemUrl(item);
  }

  /** Montant numérique d'un prix API (`price.amount`), ou null si absent. */
  function priceAmount(price) {
    if (!price || price.amount == null || price.amount === "") return null;
    const amount = Number(String(price.amount).replace(",", "."));
    return Number.isFinite(amount) ? amount : null;
  }

  function formatPrice(price) {
    if (!price || price.amount == null) return "";
    const amount = priceAmount(price);
    if (amount == null) return String(price.amount);
    const code = price.currency_code || "";
    const symbol = code === "EUR" ? "\u00a0€" : code ? "\u00a0" + code : "";
    return amount.toFixed(2).replace(".", ",") + symbol;
  }

  function textValue(value) {
    if (value == null) return "";
    // `brand` / `size` peuvent être des IDs numériques : ne jamais les afficher.
    if (typeof value === "number") return "";
    if (typeof value === "object") {
      return String(value.title || value.name || "").trim();
    }
    return String(value).trim();
  }

  /** Nom affiché de l'article (champ API `title`). */
  function itemName(item) {
    return textValue(item.title);
  }

  /**
   * Marque + taille, séparées par un point médian. L'API wardrobe expose
   * `brand_title` / `size_title` ; on accepte aussi `brand` / `size`
   * (chaîne ou objet) pour les anciennes réponses.
   */
  function itemMeta(item) {
    const brand = textValue(item.brand_title) || textValue(item.brand);
    const size = textValue(item.size_title) || textValue(item.size);
    return [brand, size].filter(Boolean).join(" · ");
  }

  function itemIdValue(item) {
    const id = Number(item && item.id);
    return Number.isFinite(id) ? id : null;
  }

  function itemPriceAmount(item) {
    return priceAmount(item && item.price);
  }

  /** Trie une copie des articles selon le select local (jamais l'ordre API). */
  function sortItems(items) {
    if (sortMode === "default") return items.slice();
    const sorted = items.slice();
    sorted.sort((a, b) => {
      if (sortMode === "id-desc" || sortMode === "id-asc") {
        const aId = itemIdValue(a);
        const bId = itemIdValue(b);
        if (aId == null && bId == null) return 0;
        if (aId == null) return 1;
        if (bId == null) return -1;
        return sortMode === "id-desc" ? bId - aId : aId - bId;
      }
      const aPrice = itemPriceAmount(a);
      const bPrice = itemPriceAmount(b);
      if (aPrice == null && bPrice == null) return 0;
      if (aPrice == null) return 1;
      if (bPrice == null) return -1;
      return sortMode === "price-asc" ? aPrice - bPrice : bPrice - aPrice;
    });
    return sorted;
  }

  function identityNode(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function identityNodes(item) {
    const name = itemName(item);
    const meta = itemMeta(item);
    const nodes = [];
    if (name) nodes.push(identityNode("p", "detniv-repost-name", name));
    if (meta) nodes.push(identityNode("p", "detniv-repost-meta", meta));
    return nodes;
  }

  function appendIdentity(container, item) {
    const nodes = identityNodes(item);
    if (nodes.length) container.prepend(...nodes);
  }

  /** Normalise une saisie ou un titre : minuscules, sans accents, sans espaces autour. */
  function normalizeSearch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function selectionCountText(count) {
    return count + " sélectionné" + (count > 1 ? "s" : "");
  }

  function articleCountText(count) {
    return count + " article" + (count > 1 ? "s" : "");
  }

  function imageCountText(count) {
    return count + " image" + (count > 1 ? "s" : "");
  }

  /** Articles sélectionnés issus du filtre « Actifs » uniquement. */
  function activeSelectionEntries() {
    const entries = [];
    for (const entry of selectedItems.values()) {
      if (entry && entry.condition === "active") entries.push(entry);
    }
    return entries;
  }

  /** Met à jour le compteur, y compris après sa réinjection par React. */
  function syncSelectionCount(node) {
    const target = node || document.getElementById(SELECTION_COUNT_ID);
    if (!target) return;
    const count = selectedItems.size;
    target.textContent = selectionCountText(count);
    target.classList.toggle(
      "detniv-repost-selection-count--active",
      count > 0
    );
    syncRepostButton();
  }

  function createSelectionCount() {
    const node = document.createElement("span");
    node.id = SELECTION_COUNT_ID;
    node.className = "detniv-repost-selection-count";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-atomic", "true");
    node.title = "Nombre total d'articles sélectionnés";
    syncSelectionCount(node);
    return node;
  }

  /* ──────────────── Bouton « Republier » et upload ──────────────── */

  function syncUploadStatus(node) {
    const target = node || document.getElementById(UPLOAD_STATUS_ID);
    if (!target) return;
    target.textContent = uploadStatus.text;
    target.hidden = !uploadStatus.text;
    target.classList.toggle(
      "detniv-repost-upload-status--error",
      uploadStatus.kind === "error"
    );
    target.classList.toggle(
      "detniv-repost-upload-status--success",
      uploadStatus.kind === "success"
    );
    target.classList.toggle(
      "detniv-repost-upload-status--warning",
      uploadStatus.kind === "warning"
    );
    target.classList.toggle(
      "detniv-repost-upload-status--progress",
      uploadStatus.kind === "progress"
    );
  }

  function setUploadStatus(kind, text) {
    uploadStatus = { kind, text: text || "" };
    syncUploadStatus();
  }

  function createUploadStatus() {
    const node = document.createElement("span");
    node.id = UPLOAD_STATUS_ID;
    node.className = "detniv-repost-upload-status";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-atomic", "true");
    syncUploadStatus(node);
    return node;
  }

  function syncRepostButton(node) {
    const button = node || document.getElementById(REPOST_BUTTON_ID);
    if (!button) return;
    const active = activeSelectionEntries().length;
    button.disabled = uploadBusy || active === 0;
    button.textContent = uploadBusy ? "Envoi…" : "Republier";
    button.setAttribute("aria-busy", uploadBusy ? "true" : "false");
    button.setAttribute(
      "aria-label",
      uploadBusy
        ? "Envoi des images en cours"
        : "Republier " + articleCountText(active) + " actif" +
          (active > 1 ? "s" : "")
    );
    if (uploadBusy) {
      button.title = "Envoi des images en cours";
    } else if (active === 0) {
      button.title =
        selectedItems.size > 0
          ? "Seuls les articles actifs peuvent être republiés."
          : "Sélectionnez au moins un article actif.";
    } else {
      button.title =
        "Envoyer les images de " + articleCountText(active) + " actif" +
        (active > 1 ? "s" : "");
    }
  }

  function createRepostButton() {
    const button = document.createElement("button");
    button.id = REPOST_BUTTON_ID;
    button.type = "button";
    button.className = "detniv-repost-submit";
    button.addEventListener("click", () => {
      startImageUpload();
    });
    syncRepostButton(button);
    return button;
  }

  /**
   * Permission optionnelle d'accès aux images Vinted (`optional_host_permissions`).
   * Firefox demande explicitement l'origine `*.vinted.net` : tant qu'elle
   * n'est pas accordée, le téléchargement dans le background échoue par CORS.
   * La demande doit être faite dans le handler de clic (action utilisateur).
   */
  async function ensureImageHostPermission() {
    const api = browserApi();
    if (
      !api ||
      !api.permissions ||
      typeof api.permissions.request !== "function"
    ) {
      return true;
    }
    try {
      const granted = await api.permissions.contains({
        origins: [IMAGE_HOST_PERMISSION],
      });
      if (granted) return true;
      return await api.permissions.request({
        origins: [IMAGE_HOST_PERMISSION],
      });
    } catch (_) {
      return true;
    }
  }

  async function startImageUpload() {
    const granted = await ensureImageHostPermission();
    if (!granted) {
      setUploadStatus(
        "error",
        "Autorisez l'accès aux images Vinted pour pouvoir les envoyer à Detniv."
      );
      return;
    }
    uploadSelectedImages();
  }

  /** Enfant direct unique portant cet id (React peut en laisser des doublons). */
  function directChildById(parent, id) {
    let found = null;
    for (const child of [...parent.children]) {
      if (child.id !== id) continue;
      if (found) child.remove();
      else found = child;
    }
    return found;
  }

  /**
   * Garantit la présence du bouton et du statut dans la barre de filtres.
   * Appelé aussi après un rendu React qui aurait remplacé nos nœuds.
   */
  function ensureRepostControls(filters) {
    for (const old of document.querySelectorAll("#" + REPOST_BUTTON_ID)) {
      if (old.parentElement !== filters) old.remove();
    }
    let button = directChildById(filters, REPOST_BUTTON_ID);
    if (!button) {
      button = createRepostButton();
      filters.appendChild(button);
    } else {
      syncRepostButton(button);
    }

    for (const old of document.querySelectorAll("#" + UPLOAD_STATUS_ID)) {
      if (old.parentElement !== filters) old.remove();
    }
    let status = directChildById(filters, UPLOAD_STATUS_ID);
    if (!status) {
      status = createUploadStatus();
      filters.appendChild(status);
    } else {
      syncUploadStatus(status);
    }
  }

  function detnivApiClient() {
    const api = globalThis.DetnivApi;
    if (!api || typeof api.handle !== "function") {
      throw new Error(
        "module API Detniv indisponible — rechargez la page Vinted."
      );
    }
    return api;
  }

  const IMAGE_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
  };

  function imageFileName(item, url, blob, index) {
    let base = "";
    try {
      const parsed = new URL(url, location.href);
      base = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    } catch (_) {}
    base = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
    if (!/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(base)) {
      base = "image." + (IMAGE_EXTENSIONS[blob && blob.type] || "jpg");
    }
    const id =
      item && item.id != null
        ? String(item.id).replace(/[^A-Za-z0-9._-]/g, "_")
        : "article";
    const suffix = index != null && index > 1 ? "-" + index : "";
    return "vinted-" + id + suffix + "-" + base;
  }

  function getVintedUserId() {
    return wardrobeIdFromLocation() || "";
  }

  function groupFilesByArticle(entries, files) {
    const map = new Map();
    let index = 0;
    for (const entry of entries) {
      const urlCount = allPhotoUrls(entry.item).length;
      if (urlCount === 0) continue;
      const articleId = String(entry.item.id || "");
      const batch = files.slice(index, index + urlCount);
      index += urlCount;
      map.set(articleId, batch);
    }
    return map;
  }

  function isVintedImageUrl(url) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "vinted.net" || host.endsWith(".vinted.net");
  }

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("image invalide");
    const meta = dataUrl.slice(0, comma);
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const match = /^data:([^;,]+)/.exec(meta);
    return new Blob([bytes], {
      type: match ? match[1] : "application/octet-stream",
    });
  }

  /**
   * En MV3, le content script subit le CORS de la page : les photos
   * images1.vinted.net n'exposent pas d'en-tête CORS. Le background, lui,
   * utilise la permission d'hôte et renvoie l'image en data URL.
   *
   * Sans repli vers le fetch du content script : pour une URL Vinted, tout
   * échec du background est signalé comme tel (extension non rechargée,
   * permission d'hôte refusée ou inconnue), sans masquer le diagnostic par
   * un second téléchargement voué à échouer.
   */
  function backgroundFailureError(response) {
    const hint =
      " — rechargez l'extension via about:debugging, puis rechargez l'onglet Vinted";
    if (!response) {
      return new Error(
        "le module d'arrière-plan n'a pas répondu à la demande d'image" +
          hint
      );
    }
    if (response.ok === false || !response.dataUrl) {
      return new Error(
        (response.error || "téléchargement de l'image impossible") +
          (response.error ? "" : hint)
      );
    }
    return null;
  }

  async function fetchImageViaBackground(url) {
    const api = browserApi();
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== "function") {
      throw new Error(
        "le module d'arrière-plan de l'extension n'est pas chargé — rechargez l'extension puis l'onglet Vinted"
      );
    }
    let response;
    try {
      response = await api.runtime.sendMessage({
        type: "detniv:fetch-image",
        url,
      });
    } catch (err) {
      const reason = (err && err.message) || err;
      throw new Error(
        "le module d'arrière-plan n'a pas répondu (" +
          reason +
          ") — rechargez l'extension puis l'onglet Vinted"
      );
    }
    const failure = backgroundFailureError(response);
    if (failure) throw failure;
    return dataUrlToBlob(response.dataUrl);
  }

  async function fetchImageDirect(url) {
    let response;
    try {
      response = await fetch(url, { credentials: "include" });
    } catch (_) {
      throw new Error("image inaccessible (CORS ou réseau)");
    }
    if (!response.ok) {
      throw new Error("image inaccessible (HTTP " + response.status + ")");
    }
    let blob;
    try {
      blob = await response.blob();
    } catch (_) {
      throw new Error("lecture de l'image impossible");
    }
    if (!blob || !blob.size) throw new Error("image vide");
    return blob;
  }

  async function fetchImageBlob(url) {
    if (isVintedImageUrl(url)) {
      // Pas de fallback direct : le content script est soumis au CORS du CDN
      // Vinted, un échec ici serait silencieux et trompeur.
      return fetchImageViaBackground(url);
    }
    return fetchImageDirect(url);
  }

  /**
   * Test d'upload : télécharge toutes les photos de chaque article actif
   * sélectionné puis les envoie à POST /images par lots de 20.
   */
  async function uploadSelectedImages() {
    if (uploadBusy) return;

    const entries = activeSelectionEntries();
    if (entries.length === 0) {
      setUploadStatus("error", "Sélectionnez au moins un article actif.");
      return;
    }

    const withPhoto = entries.filter((entry) =>
      allPhotoUrls(entry.item).length > 0
    );
    const withoutPhoto = entries.length - withPhoto.length;
    if (withPhoto.length === 0) {
      setUploadStatus("error", "Aucun article sélectionné n'a de photo.");
      return;
    }

    uploadBusy = true;
    syncRepostButton();
    setUploadStatus(
      "progress",
      "Téléchargement de " + imageCountText(withPhoto.length) + "…"
    );

    try {
      const downloads = [];
      for (const entry of withPhoto) {
        const item = entry.item;
        const urls = allPhotoUrls(item);
        const results = await Promise.all(
          urls.map(async (url, index) => {
            try {
              const blob = await fetchImageBlob(url);
              const fileName = imageFileName(
                item,
                url,
                blob,
                urls.length > 1 ? index + 1 : undefined
              );
              return { status: "fulfilled", value: { blob, fileName } };
            } catch (err) {
              return {
                status: "rejected",
                item,
                reason: err,
              };
            }
          })
        );
        downloads.push(...results);
      }

      const files = [];
      const failures = [];
      downloads.forEach((result) => {
        if (result.status === "fulfilled") {
          files.push(result.value);
          return;
        }
        const name =
          (result.item && itemName(result.item)) || "Article";
        const reason = result.reason;
        failures.push(name + " : " + ((reason && reason.message) || reason));
      });

      if (files.length === 0) {
        throw new Error(failures[0] || "aucune image téléchargée");
      }

      // Envoie par article : tous les fichiers d'un même article sont
      // regroupés par articleId ; le backend reçoit vintedUserId et
      // articleId pour stocker le chemin B2 et la table repost_image.
      const vintedUserId = getVintedUserId();
      const byArticle = new Map();
      let offset = 0;
      for (const entry of withPhoto) {
        const urls = allPhotoUrls(entry.item);
        const articleId = String(entry.item.id || "");
        const batch = files.slice(offset, offset + urls.length);
        offset += urls.length;
        byArticle.set(articleId, batch);
      }
      let uploaded = 0;
      for (const [articleId, articleFiles] of byArticle) {
        for (
          let start = 0;
          start < articleFiles.length;
          start += MAX_UPLOAD_BATCH
        ) {
          const batch = articleFiles.slice(start, start + MAX_UPLOAD_BATCH);
          const data = await detnivApiClient().handle("images.upload", {
            files: batch,
            vintedUserId,
            articleId,
          });
          uploaded += Array.isArray(data) ? data.length : batch.length;
        }
      }

      const details = [];
      if (withoutPhoto > 0) {
        details.push(articleCountText(withoutPhoto) + " sans photo");
      }
      if (failures.length > 0) {
        details.push(
          imageCountText(failures.length) +
            " ignorée" +
            (failures.length > 1 ? "s" : "")
        );
      }
      const suffix = details.length ? " (" + details.join(", ") + ")" : "";
      setUploadStatus(
        failures.length || withoutPhoto ? "warning" : "success",
        imageCountText(uploaded) +
          " envoyée" +
          (uploaded > 1 ? "s" : "") +
          " sur Detniv" +
          suffix +
          "."
      );
      console.info("[Detniv] upload images :", uploaded, "image(s)");
    } catch (err) {
      const message = (err && err.message) || String(err);
      setUploadStatus("error", "Échec de l'envoi : " + message);
      console.error("[Detniv] upload images :", err);
    } finally {
      uploadBusy = false;
      syncRepostButton();
    }
  }

  /**
   * Champ de recherche, select de tri et compteur de sélection ajoutés à la
   * barre de filtres Vinted. Ils restent dans le DOM géré par React :
   * l'observateur les réinjecte si un rendu les supprime.
   */
  function ensureLocalControls() {
    const filters = document.querySelector(FILTERS_SEL);
    if (!filters) return null;

    // Sur mobile, la ligne d'en-tête doit pouvoir passer sous le compteur
    // d'articles pour que les contrôles prennent toute la largeur.
    const scrollContent = filters.closest(
      '[class*="horizontal-scroll__content"]'
    );
    const scrollWrapper = scrollContent && scrollContent.parentElement;
    const filterRow =
      (scrollWrapper && scrollWrapper.parentElement) || filters.parentElement;
    if (filterRow) filterRow.classList.add("detniv-repost-filter-row");

    const wrapper = filters.querySelector("." + SEARCH_ID);
    if (wrapper) {
      const existingInput = wrapper.querySelector("input");
      const existingSelect = wrapper.querySelector("select");
      if (existingInput && existingSelect) {
        if (existingInput.value !== searchQuery) {
          existingInput.value = searchQuery;
        }
        if (existingSelect.value !== sortMode) existingSelect.value = sortMode;
        let countNode = wrapper.querySelector("#" + SELECTION_COUNT_ID);
        if (!countNode) {
          countNode = createSelectionCount();
          wrapper.appendChild(countNode);
        } else {
          syncSelectionCount(countNode);
        }
        ensureRepostControls(filters);
        return existingInput;
      }
      wrapper.remove();
    }
    for (const old of document.querySelectorAll("." + SEARCH_ID)) old.remove();

    const host = document.createElement("div");
    host.id = SEARCH_ID;
    host.className = SEARCH_ID;
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Rechercher un article…";
    input.setAttribute("aria-label", "Rechercher un article");
    input.autocomplete = "off";
    input.value = searchQuery;
    input.addEventListener("input", () => {
      searchQuery = input.value;
      applySearchFilter();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });

    const select = document.createElement("select");
    select.id = SORT_ID;
    select.className = "detniv-repost-sort";
    select.setAttribute("aria-label", "Trier les articles");
    select.title = "Trier les articles";
    for (const { value, label } of SORT_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = sortMode;
    select.addEventListener("change", () => {
      sortMode = select.value;
      rerenderItems();
    });

    host.appendChild(input);
    host.appendChild(select);
    host.appendChild(createSelectionCount());
    filters.appendChild(host);
    ensureRepostControls(filters);
    return input;
  }

  /** Masque localement les cards dont `item.title` ne contient pas la saisie. */
  function applySearchFilter(grid) {
    let target = grid;
    if (!target) {
      const container = findContainer();
      target = container && container.querySelector(GRID_SEL);
    }
    if (!target) return;
    const query = normalizeSearch(searchQuery);
    for (const card of target.querySelectorAll('[data-detniv-repost="1"]')) {
      const title = card.getAttribute("data-detniv-title") || "";
      const hide = Boolean(query) && !title.includes(query);
      if (card.classList.contains(SEARCH_HIDDEN_CLASS) !== hide) {
        card.classList.toggle(SEARCH_HIDDEN_CLASS, hide);
      }
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .detniv-repost-name {
        margin: 4px 0 0;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
        color: #1a1a1a;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .detniv-repost-meta {
        margin: 2px 0 0;
        font-size: 12px;
        line-height: 1.3;
        color: #737373;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .detniv-repost-hidden {
        display: none !important;
      }
      .detniv-repost-card {
        position: relative;
      }
      .detniv-repost-card.detniv-repost-selected {
        outline: 2px solid #007782;
        outline-offset: -2px;
      }
      .detniv-repost-select {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        box-sizing: border-box;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
        cursor: pointer;
        user-select: none;
      }
      .detniv-repost-select:focus-within {
        box-shadow: 0 0 0 2px #007782, 0 1px 4px rgba(0, 0, 0, 0.22);
      }
      .detniv-repost-select input {
        width: 18px;
        height: 18px;
        margin: 0;
        accent-color: #007782;
        cursor: pointer;
      }
      .detniv-repost-search {
        display: flex;
        align-items: center;
        flex: 0 0 auto;
        margin-left: 8px;
      }
      .detniv-repost-search input {
        width: 210px;
        height: 32px;
        box-sizing: border-box;
        padding: 0 12px;
        border: 1px solid #c7c7c7;
        border-radius: 999px;
        background: #fff;
        color: #1a1a1a;
        font: inherit;
        font-size: 14px;
        outline: none;
      }
      .detniv-repost-search input:focus {
        border-color: #007782;
        box-shadow: 0 0 0 1px #007782;
      }
      .detniv-repost-search input::placeholder {
        color: #737373;
      }
      .detniv-repost-search select {
        width: 168px;
        height: 32px;
        margin-left: 8px;
        box-sizing: border-box;
        padding: 0 30px 0 12px;
        border: 1px solid #c7c7c7;
        border-radius: 999px;
        background: #fff;
        color: #1a1a1a;
        font: inherit;
        font-size: 14px;
        outline: none;
        cursor: pointer;
      }
      .detniv-repost-search select:focus {
        border-color: #007782;
        box-shadow: 0 0 0 1px #007782;
      }
      .detniv-repost-selection-count {
        display: inline-flex;
        align-items: center;
        height: 32px;
        margin-left: 8px;
        padding: 0 12px;
        box-sizing: border-box;
        border: 1px solid #c7c7c7;
        border-radius: 999px;
        background: #fff;
        color: #737373;
        font-size: 14px;
        white-space: nowrap;
      }
      .detniv-repost-selection-count--active {
        border-color: #007782;
        background: #e6f4f5;
        color: #005f68;
        font-weight: 600;
      }
      .detniv-repost-submit {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 32px;
        margin-left: 8px;
        padding: 0 18px;
        box-sizing: border-box;
        border: 1px solid #ffd600;
        border-radius: 999px;
        background: #ffd600;
        color: #0d0d0d;
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        white-space: nowrap;
        cursor: pointer;
      }
      .detniv-repost-submit:hover:not(:disabled) {
        border-color: #ffe23d;
        background: #ffe23d;
      }
      .detniv-repost-submit:focus-visible {
        outline: 2px solid #0d0d0d;
        outline-offset: 2px;
      }
      .detniv-repost-submit:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .detniv-repost-upload-status {
        margin-left: 8px;
        font-size: 13px;
        color: #4a4a4a;
      }
      .detniv-repost-upload-status[hidden] {
        display: none;
      }
      .detniv-repost-upload-status--progress {
        color: #005f68;
      }
      .detniv-repost-upload-status--success {
        color: #0a7a33;
      }
      .detniv-repost-upload-status--warning {
        color: #8a5a00;
      }
      .detniv-repost-upload-status--error {
        color: #b00020;
      }
      @media (max-width: 720px) {
        .detniv-repost-filter-row {
          flex-wrap: wrap;
          row-gap: 8px;
        }
        .detniv-repost-filter-row > .u-position-relative {
          flex: 1 0 100%;
          width: 100%;
          max-width: 100%;
          min-width: 0;
        }
        /* Repli CSS si la classe JS disparaît lors d'un rendu React. */
        .web_ui__Container__container
          > .u-flexbox:has([data-testid="closet-seller-filters"]) {
          flex-wrap: wrap;
          row-gap: 8px;
        }
        .web_ui__Container__container
          > .u-flexbox:has([data-testid="closet-seller-filters"])
          > .u-position-relative {
          flex: 1 0 100%;
          width: 100%;
          max-width: 100%;
          min-width: 0;
        }
        [data-testid="closet-seller-filters"] {
          flex-wrap: wrap;
          align-items: flex-start;
          align-content: flex-start;
          align-self: flex-start;
          width: 100%;
          min-width: 0;
          gap: 8px;
        }
        [data-testid="closet-seller-filters"] > .web_ui__Spacer__vertical {
          display: none;
        }
        [data-testid="closet-seller-filters"] > button {
          align-self: flex-start;
        }
        .detniv-repost-search {
          order: 1;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 6px;
          flex: 1 1 100%;
          width: 100%;
          box-sizing: border-box;
          margin-left: 0;
        }
        .detniv-repost-search input {
          grid-column: 1 / -1;
          width: 100%;
          min-width: 0;
        }
        .detniv-repost-search select {
          width: 100%;
          min-width: 0;
          margin-left: 0;
        }
        .detniv-repost-selection-count {
          justify-content: center;
          margin-left: 0;
          padding: 0 10px;
          font-size: 13px;
        }
        [data-testid="closet-seller-filters"] > .detniv-repost-submit {
          order: 2;
          align-self: stretch;
          flex: 1 1 100%;
          width: 100%;
          margin-left: 0;
        }
        .detniv-repost-upload-status {
          order: 3;
          flex: 1 1 100%;
          margin-left: 0;
          font-size: 12px;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ──────────────── Rendu des articles ──────────────── */

  function gridNode(container) {
    let grid = container.querySelector(GRID_SEL);
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "u-fill-width";
      container.appendChild(grid);
    }
    return grid;
  }

  /** Recopie la card SSR existante (mêmes classes CSS Vinted) pour un article. */
  function fillFromTemplate(template, item) {
    template.setAttribute("data-detniv-repost", "1");
    template.setAttribute("data-detniv-title", normalizeSearch(item.title));
    const nodes = [template, ...template.querySelectorAll("[data-testid]")];
    for (const node of nodes) {
      const tid = node.getAttribute("data-testid");
      if (tid && tid.includes("product-item-id-")) {
        node.setAttribute(
          "data-testid",
          tid.replace(/product-item-id-\d+/g, "product-item-id-" + item.id)
        );
      }
    }
    const img = template.querySelector("img");
    if (img) {
      img.src = photoUrl(item);
      img.alt = item.title || "";
    }
    const link =
      template.querySelector('a[data-testid$="--overlay-link"]') ||
      template.querySelector("a");
    if (link) {
      link.href = itemUrl(item);
      link.title = item.title || "";
    }
    const price = template.querySelector('[data-testid$="--price-text"]');
    if (price) price.textContent = formatPrice(item.price);
    // Nom + marque/taille au-dessus du prix. La card peut être reclonée lors
    // d'un second run : on retire d'abord une éventuelle identité déjà rendue.
    const identityHost =
      template.querySelector('[data-testid$="--title-container"]') ||
      template.querySelector('[data-testid$="--summary"]');
    if (identityHost) {
      for (const node of identityHost.querySelectorAll(
        ".detniv-repost-name, .detniv-repost-meta"
      )) {
        node.remove();
      }
      appendIdentity(identityHost, item);
    }
    const views = template.querySelector('[data-testid$="--description-title"]');
    if (views) {
      const count = Number(item.view_count) || 0;
      views.textContent = count + " vue" + (count === 1 ? "" : "s");
    }
    // Les favoris ne sont pas exposés par l'API wardrobe : on vide la valeur
    // héritée du template plutôt que d'afficher des données périmées.
    const favs = template.querySelector('[data-testid$="--description-subtitle"]');
    if (favs) favs.textContent = "";
    // Bouton « Booster » conservé, avec le libellé correspondant à l'état de
    // l'article (`promoted`). Il n'est pas rebranché aux handlers React.
    const bumped = Boolean(item.promoted);
    const bumpLabel = bumped ? "Boosté" : "Booster";
    for (const btn of template.querySelectorAll('[data-testid="bump-button"]')) {
      const label = btn.querySelector(".web_ui__Button__label");
      if (label) label.textContent = bumpLabel;
      else btn.textContent = bumpLabel;
    }
    return template;
  }

  /** Repli si la page ne contient aucune card modèle (garde-robe vide en SSR). */
  function buildFallbackItem(item) {
    const card = document.createElement("div");
    card.setAttribute("data-testid", "grid-item");
    card.setAttribute("data-detniv-repost", "1");
    card.setAttribute("data-detniv-title", normalizeSearch(item.title));
    const box = document.createElement("div");
    box.className = "u-flex-grow u-fill-width";
    box.setAttribute("data-testid", "product-item-id-" + item.id);
    const link = document.createElement("a");
    link.href = itemUrl(item);
    link.title = item.title || "";
    const img = document.createElement("img");
    img.alt = item.title || "";
    img.src = photoUrl(item);
    img.style.width = "100%";
    link.appendChild(img);
    const price = document.createElement("p");
    price.className = "web_ui__Text__text web_ui__Text__caption";
    price.textContent = formatPrice(item.price);
    box.append(link);
    box.append(...identityNodes(item));
    box.append(price);
    card.appendChild(box);
    return card;
  }

  function setItemData(card, item) {
    card.setAttribute("data-detniv-id", item.id == null ? "" : String(item.id));
    card.setAttribute("data-detniv-key", itemKey(item));
    const amount = itemPriceAmount(item);
    if (amount == null) card.removeAttribute("data-detniv-price");
    else card.setAttribute("data-detniv-price", String(amount));
  }

  /**
   * Case à cocher en haut à gauche de la card. La sélection est mémorisée par
   * clé d'article et reste valable en changeant de filtre ou après un rendu.
   */
  function addSelectionCheckbox(card, item) {
    for (const old of card.querySelectorAll("." + SELECT_CLASS)) old.remove();

    const key = itemKey(item);
    const name = itemName(item) || "cet article";
    const checked = selectedItems.has(key);
    const label = document.createElement("label");
    label.className = SELECT_CLASS;
    label.addEventListener("click", (event) => event.stopPropagation());

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    const applyLabel = () => {
      const action = checkbox.checked ? "Désélectionner " : "Sélectionner ";
      checkbox.setAttribute("aria-label", action + name);
      label.title = action + name;
    };
    applyLabel();

    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedItems.set(key, {
          item,
          condition:
            (lastRender && lastRender.condition) || activeCondition || "active",
        });
      } else {
        selectedItems.delete(key);
      }
      card.classList.toggle(SELECTED_CLASS, checkbox.checked);
      applyLabel();
      syncSelectionCount();
    });

    label.appendChild(checkbox);
    card.classList.add("detniv-repost-card");
    card.classList.toggle(SELECTED_CLASS, checked);
    card.prepend(label);
  }

  function renderItems(container, items) {
    ensureStyles();
    const grid = gridNode(container);
    const templateNode = grid.querySelector(ITEM_SEL);
    const template = templateNode ? templateNode.cloneNode(true) : null;
    const ordered = sortItems(items);
    grid.replaceChildren(
      ...ordered.map((item) => {
        const card = template
          ? fillFromTemplate(template.cloneNode(true), item)
          : buildFallbackItem(item);
        setItemData(card, item);
        addSelectionCheckbox(card, item);
        return card;
      })
    );
    ensureLocalControls();
    applySearchFilter(grid);
  }

  /* ──────────────── Filtres et re-rendu ──────────────── */

  function filterButton(node) {
    if (!node || typeof node.closest !== "function") return null;
    return node.closest("button") || node;
  }

  /**
   * Vinted signale le filtre sélectionné par `aria-pressed` en SSR, mais après
   * hydratation React l'état peut n'être porté que par la classe du chip.
   */
  function filterIsActive(button) {
    if (!button) return false;
    return (
      button.getAttribute("aria-pressed") === "true" ||
      button.getAttribute("aria-selected") === "true" ||
      button.classList.contains("web_ui__Chip__activated")
    );
  }

  function filterSelector(condition) {
    if (condition === "hidden") return HIDDEN_FILTER_SEL;
    if (condition === "draft") return DRAFT_FILTER_SEL;
    return ACTIVE_FILTER_SEL;
  }

  function findFilterButton(condition) {
    for (const node of document.querySelectorAll(filterSelector(condition))) {
      const button = filterButton(node);
      if (button) return button;
    }
    return null;
  }

  function filterIsSelected(condition) {
    return filterIsActive(findFilterButton(condition));
  }

  /**
   * Condition actuellement voulue par l'utilisateur. L'intention du dernier
   * clic est prioritaire : elle ne dépend pas de la mise à jour aria/classes
   * de React, qui peut arriver après notre fetch.
   */
  function conditionIsCurrent(condition) {
    if (activeCondition) return activeCondition === condition;
    return filterIsSelected(condition);
  }

  /** Une barre de filtres est présente : le rendu doit correspondre au filtre. */
  function filtersPresent() {
    return Boolean(
      document.querySelector(FILTERS_SEL) ||
        document.querySelector(ACTIVE_FILTER_SEL) ||
        document.querySelector(HIDDEN_FILTER_SEL) ||
        document.querySelector(DRAFT_FILTER_SEL)
    );
  }

  function findActiveFilterButton() {
    return findFilterButton("active");
  }

  /**
   * Le filtre « Brouillons » n'est présent que sur la garde-robe du compte
   * connecté : c'est un marqueur d'appartenance indépendant du cookie v_uid.
   */
  function hasDraftFilter() {
    return Boolean(document.querySelector(DRAFT_FILTER_SEL));
  }

  /** Sélectionne « Actifs » s'il ne l'est pas déjà. */
  async function selectActiveFilter(timeoutMs = 2000) {
    // Sans barre de filtres (page vide ou variante DOM), ne pas bloquer le run.
    if (
      !document.querySelector(FILTERS_SEL) &&
      !document.querySelector(ACTIVE_FILTER_SEL)
    ) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    let button = findActiveFilterButton();
    while (!button && Date.now() < deadline) {
      await sleep(100);
      button = findActiveFilterButton();
    }
    if (!button) return false;
    if (filterIsActive(button)) return true;

    // Évite que notre propre délégation de clic déclenche un run en double.
    suppressFilterClick = true;
    try {
      button.click();
    } finally {
      suppressFilterClick = false;
    }

    // React applique l'état sélectionné après le cycle de clic.
    const settleDeadline = Date.now() + 600;
    do {
      if (filterIsSelected("active")) return true;
      await sleep(50);
    } while (Date.now() < settleDeadline);
    return filterIsSelected("active");
  }

  function cardsAreRendered(container) {
    if (!lastRender) return false;
    const grid = container.querySelector(GRID_SEL);
    if (!grid) return false;

    const items = lastRender.items;
    const cards = grid.querySelectorAll(ITEM_SEL);
    const ours = [...grid.querySelectorAll('[data-detniv-repost="1"]')];
    if (cards.length !== items.length || ours.length !== items.length) {
      return false;
    }

    const orderedItems = sortItems(items);
    const expectedIds = orderedItems.map((item) =>
      item.id == null ? "" : String(item.id)
    );
    if (
      ours.some(
        (card, index) =>
          card.getAttribute("data-detniv-id") !== expectedIds[index]
      )
    ) {
      return false;
    }

    const expectedSelection = orderedItems.map((item) =>
      selectedItems.has(itemKey(item))
    );
    if (
      ours.some((card, index) => {
        const checkbox = card.querySelector(
          "." + SELECT_CLASS + ' input[type="checkbox"]'
        );
        return !checkbox || checkbox.checked !== expectedSelection[index];
      })
    ) {
      return false;
    }

    const names = grid.querySelectorAll(".detniv-repost-name").length;
    const metas = grid.querySelectorAll(".detniv-repost-meta").length;
    const expectedNames = items.filter((item) => itemName(item)).length;
    const expectedMetas = items.filter((item) => itemMeta(item)).length;
    return names === expectedNames && metas === expectedMetas;
  }

  /** Ré-applique les derniers articles chargés sur la grille courante. */
  function rerenderItems() {
    if (!lastRender) return false;
    if (wardrobeIdFromLocation() !== lastRender.wardrobeId) return false;
    if (!conditionIsCurrent(lastRender.condition || "active")) return false;
    const container = findContainer();
    if (!container) return false;
    renderItems(container, lastRender.items);
    return true;
  }

  /** Ne re-rend que si React a remplacé notre grille. */
  function reconcileItems() {
    if (!lastRender) return false;
    if (wardrobeIdFromLocation() !== lastRender.wardrobeId) return false;
    if (!conditionIsCurrent(lastRender.condition || "active")) return false;
    const container = findContainer();
    if (!container) return false;
    ensureLocalControls();
    if (cardsAreRendered(container)) {
      applySearchFilter();
      return false;
    }
    renderItems(container, lastRender.items);
    return true;
  }

  function startReconcile() {
    if (reconcileObserver) return;
    const root = document.documentElement || document.body;
    if (!root) return;
    reconcileObserver = new MutationObserver(() => {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        reconcileItems();
      }, RECONCILE_DELAY_MS);
    });
    reconcileObserver.observe(root, { childList: true, subtree: true });
  }

  function conditionFromTarget(target) {
    if (!target || typeof target.closest !== "function") return null;
    if (target.closest(ACTIVE_FILTER_SEL)) return "active";
    if (target.closest(HIDDEN_FILTER_SEL)) return "hidden";
    if (target.closest(DRAFT_FILTER_SEL)) return "draft";
    return null;
  }

  /** Mémorise le dernier filtre cliqué pendant un chargement en cours. */
  function queuePendingFilter(wardrobeId, condition, runSeq) {
    pendingFilter = { wardrobeId, condition, runSeq };
  }

  /** Exécute le filtre cliqué pendant un run, dès que la garde-robe se libère. */
  function drainPendingFilter() {
    if (!pendingFilter || busy) return;
    const { wardrobeId, condition, runSeq } = pendingFilter;
    pendingFilter = null;
    if (wardrobeIdFromLocation() !== wardrobeId) return;
    if (runSeq !== filterRunSeq) return;
    activeCondition = condition;
    run(wardrobeId, { condition, selectFilter: false, runSeq }).catch((err) => {
      console.error("[Detniv] republication :", err);
    });
  }

  function onFilterClick(event) {
    if (suppressFilterClick) return;
    const condition = conditionFromTarget(event.target);
    if (!condition) return;

    const wardrobeId = wardrobeIdFromLocation();
    if (!wardrobeId) {
      console.warn(
        "[Detniv] filtre : garde-robe non reconnue dans l'URL",
        location.pathname
      );
      return;
    }

    // L'intention est enregistrée dès le clic : un fetch déjà en cours pour un
    // autre filtre ne pourra plus écraser la vue. On ne dépend pas de l'état
    // aria/classes de React pour lancer la requête.
    const runSeq = ++filterRunSeq;
    activeCondition = condition;
    console.info("[Detniv] filtre cliqué :", condition);

    setTimeout(() => {
      if (wardrobeIdFromLocation() !== wardrobeId || runSeq !== filterRunSeq) {
        return;
      }
      activeCondition = condition;
      if (busy) {
        console.info("[Detniv] filtre en attente :", condition);
        queuePendingFilter(wardrobeId, condition, runSeq);
        return;
      }
      run(wardrobeId, { condition, selectFilter: false, runSeq }).catch((err) => {
        console.error("[Detniv] republication :", err);
      });
    }, FILTER_SETTLE_MS);
  }

  /* ──────────────── Point d'entrée ──────────────── */

  async function run(wardrobeId, options = {}) {
    if (busy) throw new Error("Republication déjà en cours.");
    const id = wardrobeId || wardrobeIdFromLocation();
    if (!id) {
      throw new Error(
        "Ouvrez une garde-robe (page profil membre) pour lancer la republication."
      );
    }
    const condition = options.condition || "active";
    const runSeq = options.runSeq;
    const filterRun = runSeq !== undefined;
    const selectFilter =
      options.selectFilter === undefined
        ? condition === "active"
        : Boolean(options.selectFilter);
    let container = findContainer();
    // Un clic de filtre peut avoir démonté la grille Vinted (les articles sont
    // vidés avant son fetch). On charge quand même, puis on attend la nouvelle
    // grille avant de rendre nos cards.
    if (!container && !filterRun) {
      throw new Error("Garde-robe introuvable sur cette page.");
    }
    busy = true;
    try {
      activeCondition = condition;
      console.info("[Detniv] chargement :", condition, "garde-robe", id);
      // Pour « Actifs » déclenché depuis le panneau, on aligne d'abord l'onglet
      // Vinted. Un clic direct sur Masqués/Brouillons ne doit pas revenir aux
      // actifs : le fetch suit le filtre déjà sélectionné.
      if (selectFilter) await selectActiveFilter();
      const { items, pages } = await fetchAllItems(id, condition);
      // Un clic plus récent sur un filtre invalide ce chargement.
      if (runSeq !== undefined && runSeq !== filterRunSeq) {
        console.info("[Detniv] chargement ignoré (filtre plus récent) :", condition);
        return { count: 0, pages, skipped: true };
      }
      // Si l'utilisateur a changé de filtre pendant le chargement, ne pas
      // écraser la vue courante avec une autre catégorie.
      if (filtersPresent() && !conditionIsCurrent(condition)) {
        console.info("[Detniv] chargement ignoré (filtre courant différent) :", condition);
        return { count: 0, pages, skipped: true };
      }
      if (items.length === 0) {
        console.info("[Detniv] aucun article :", condition);
        return { count: 0, pages };
      }
      if (filterRun) {
        container = findContainer();
        if (!container) {
          console.info("[Detniv] grille Vinted absente, attente :", condition);
          container = await waitForFilterContainer(condition, runSeq);
        }
        // Un autre filtre a pu être cliqué pendant l'attente de la grille.
        if (runSeq !== filterRunSeq || !conditionIsCurrent(condition)) {
          console.info("[Detniv] chargement ignoré après attente :", condition);
          return { count: 0, pages, skipped: true };
        }
      } else {
        container = findContainer() || container;
      }
      if (!container) {
        console.warn("[Detniv] grille introuvable, rendu annulé :", condition);
        return { count: 0, pages, skipped: true };
      }
      lastRender = { wardrobeId: String(id), condition, items };
      renderItems(container, items);
      rememberAutoWardrobe(id);
      startReconcile();
      return { count: items.length, pages };
    } finally {
      busy = false;
      drainPendingFilter();
    }
  }

  /**
   * Clic « Republication » : lit v_uid (cookie de session Vinted), en déduit
   * l'URL de garde-robe https://<origine>/member/<v_uid> et y navigue si
   * nécessaire. La republication s'exécute alors automatiquement au chargement
   * (marqueur detnivRepostPending en storage).
   */
  async function start() {
    const base = location.origin;
    const uid = await readCookie(UID_COOKIE);
    if (!uid) {
      throw new Error(
        "Cookie v_uid introuvable — connectez-vous à Vinted puis réessayez."
      );
    }
    const url = base + "/member/" + uid;
    if (!onWardrobePage(uid)) {
      const store = storageApi();
      if (store) {
        try {
          await store.set({
            [PENDING_KEY]: { uid: String(uid), at: Date.now() },
          });
        } catch (_) {}
      }
      location.assign(url);
      return { navigating: true, url, count: 0, pages: 0 };
    }
    await waitForContainer();
    const result = await run(uid);
    return { ...result, navigating: false, url };
  }

  /**
   * Actualisation de la garde-robe du compte connecté : sélectionne « Actifs »
   * si nécessaire puis réapplique le rendu enrichi sans passer par le panneau.
   */
  async function autoRunOnRefresh() {
    const wardrobeId = wardrobeIdFromLocation();
    if (!wardrobeId || busy) return null;

    // Mode déjà armé dans cet onglet, ou garde-robe personnelle reconnaissable
    // au filtre « Brouillons ». Sinon on vérifie le cookie v_uid du compte.
    let enabled = autoWardrobeId() === wardrobeId || hasDraftFilter();
    if (!enabled) {
      let uid = null;
      try {
        uid = await readCookie(UID_COOKIE);
      } catch (_) {}
      if (uid) {
        enabled = String(uid) === wardrobeId;
      } else {
        // Cookie inaccessible : on laisse la barre de filtres se rendre avant
        // de conclure grâce au marqueur « Brouillons ».
        await waitForContainer();
        enabled = hasDraftFilter();
      }
    }
    if (!enabled || busy) return null;

    await waitForContainer();
    if (busy) return null;

    console.info("[Detniv] republication automatique :", wardrobeId);
    try {
      const result = await run(wardrobeId);
      console.info(
        "[Detniv] republication automatique :",
        result.count,
        "article(s)"
      );
      return result;
    } catch (err) {
      console.error("[Detniv] republication automatique :", err);
      return null;
    }
  }

  /** Reprise après navigation : exécute la republication demandée. */
  async function autoRunPending() {
    const store = storageApi();
    if (!store) return null;
    let pending = null;
    try {
      pending = (await store.get(PENDING_KEY))[PENDING_KEY];
    } catch (_) {
      return null;
    }
    if (!pending || !pending.uid) return null;
    const clear = () => store.remove(PENDING_KEY).catch(() => {});
    if (Date.now() - (pending.at || 0) > PENDING_TTL_MS) {
      await clear();
      return null;
    }
    if (!onWardrobePage(pending.uid)) return null;
    await clear();
    try {
      await waitForContainer();
      const result = await run(pending.uid);
      await store
        .set({ [RESULT_KEY]: { ...result, at: Date.now() } })
        .catch(() => {});
      return result;
    } catch (err) {
      await store
        .set({
          [RESULT_KEY]: {
            count: 0,
            pages: 0,
            error: String((err && err.message) || err),
            at: Date.now(),
          },
        })
        .catch(() => {});
      return null;
    }
  }

  /** Priorité à une navigation demandée par le panneau, sinon auto-refresh. */
  async function autoStart() {
    const pending = await autoRunPending();
    if (pending) return pending;
    return autoRunOnRefresh();
  }

  globalThis.DetnivRepost = {
    run,
    start,
    autoRunPending,
    autoRunOnRefresh,
    autoStart,
    rerenderItems,
    readCookie,
    wardrobeIdFromLocation,
    onWardrobePage,
    fetchAllItems,
    formatPrice,
    photoUrl,
    itemUrl,
  };

  const runtimeApi = browserApi() && browserApi().runtime;
  const extensionVersion =
    runtimeApi && typeof runtimeApi.getManifest === "function"
      ? runtimeApi.getManifest().version
      : "dev";
  console.info("[Detniv] republication", extensionVersion, "chargée");

  document.addEventListener("click", onFilterClick, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => autoStart(), {
      once: true,
    });
  } else {
    autoStart();
  }
})();
