/**
 * repost.js — content script : republication (garde-robe Vinted).
 *
 * Sur une page profil membre (/member/<id>), recharge TOUS les articles
 * actifs via l'API Vinted (GET /api/v2/wardrobe/<id>/items?page=N&per_page=20
 * &cond=active, en boucle jusqu'à pagination.total_pages) puis remplace le
 * contenu de la grille (div.u-ui-margin-horizontal-regular@portables) par les
 * articles renvoyés par l'API. Avant tout chargement, le filtre « Actifs » est
 * sélectionné s'il ne l'est pas déjà. Chaque card affiche le nom, la marque et
 * la taille de l'article (`title`, `brand_title`, `size_title`) en plus du prix
 * et des vues. Tant que le filtre « Actifs » est sélectionné, un clic sur
 * celui-ci ou un re-rendu React de la grille ré-applique nos cards.
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
  const ACTIVE_FILTER_SEL =
    '[data-testid="closet-seller-filters-active"], ' +
    '[data-testid="closet-seller-filters-active--text"]';
  const DRAFT_FILTER_SEL =
    '[data-testid="closet-seller-filters-draft"], ' +
    '[data-testid="closet-seller-filters-draft--text"]';
  const STYLE_ID = "detniv-repost-styles";
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
  let filterRetryTimer = null;
  let filterRetryCount = 0;
  let csrf = null;

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

  function findContainer() {
    for (const node of document.querySelectorAll(CONTAINER_SEL)) {
      if (node.querySelector(GRID_SEL) || node.querySelector(ITEM_SEL)) return node;
    }
    return null;
  }

  /* ──────────────── API Vinted (paginée) ──────────────── */

  async function fetchPage(wardrobeId, page) {
    const url =
      `${location.origin}/api/v2/wardrobe/${wardrobeId}/items` +
      `?page=${page}&per_page=${PER_PAGE}&cond=active`;
    const headers = { Accept: "application/json" };
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
    const res = await fetch(url, {
      headers,
      credentials: "include",
    });
    if (!res.ok) throw new Error(`API Vinted en erreur (HTTP ${res.status})`);
    return res.json();
  }

  async function fetchAllItems(wardrobeId) {
    const items = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await fetchPage(wardrobeId, page);
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

  function itemUrl(item) {
    if (item.url) return item.url;
    const path = item.path || "/items/" + item.id;
    return /^https?:/.test(path) ? path : location.origin + path;
  }

  function formatPrice(price) {
    if (!price || price.amount == null) return "";
    const amount = Number(price.amount);
    if (Number.isNaN(amount)) return String(price.amount);
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

  function renderItems(container, items) {
    ensureStyles();
    const grid = gridNode(container);
    const templateNode = grid.querySelector(ITEM_SEL);
    const template = templateNode ? templateNode.cloneNode(true) : null;
    grid.replaceChildren(
      ...items.map((item) =>
        template
          ? fillFromTemplate(template.cloneNode(true), item)
          : buildFallbackItem(item)
      )
    );
  }

  /* ──────────────── Re-rendu après le filtre « Actifs » ──────────────── */

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

  function findActiveFilterButton() {
    for (const node of document.querySelectorAll(ACTIVE_FILTER_SEL)) {
      const button = filterButton(node);
      if (button) return button;
    }
    return null;
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
      !document.querySelector('[data-testid="closet-seller-filters"]') &&
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
      if (activeFilterPressed()) return true;
      await sleep(50);
    } while (Date.now() < settleDeadline);
    return activeFilterPressed();
  }

  function activeFilterPressed() {
    return [...document.querySelectorAll(ACTIVE_FILTER_SEL)].some((node) => {
      return filterIsActive(filterButton(node));
    });
  }

  function cardsAreRendered(container) {
    if (!lastRender) return false;
    const grid = container.querySelector(GRID_SEL);
    if (!grid) return false;

    const items = lastRender.items;
    const cards = grid.querySelectorAll(ITEM_SEL);
    const ours = grid.querySelectorAll('[data-detniv-repost="1"]');
    if (cards.length !== items.length || ours.length !== items.length) {
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
    if (!activeFilterPressed()) return false;
    const container = findContainer();
    if (!container) return false;
    renderItems(container, lastRender.items);
    return true;
  }

  /** Ne re-rend que si React a remplacé notre grille. */
  function reconcileItems() {
    if (!lastRender) return false;
    if (wardrobeIdFromLocation() !== lastRender.wardrobeId) return false;
    if (!activeFilterPressed()) return false;
    const container = findContainer();
    if (!container) return false;
    if (cardsAreRendered(container)) return false;
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

  function onActiveFilterClick(event) {
    if (suppressFilterClick) return;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (!target.closest(ACTIVE_FILTER_SEL)) return;

    const wardrobeId = wardrobeIdFromLocation();
    if (!wardrobeId || busy) return;

    // React met à jour aria-pressed après l'événement de clic. On attend donc
    // la fin de son cycle avant de vérifier que « Actifs » est réellement le
    // filtre sélectionné, puis on réapplique nos cards (ou on recharge).
    if (filterRetryTimer) clearTimeout(filterRetryTimer);
    filterRetryCount = 0;

    const attempt = () => {
      filterRetryTimer = null;
      if (busy || wardrobeIdFromLocation() !== wardrobeId) return;
      if (activeFilterPressed()) {
        if (lastRender && lastRender.wardrobeId === wardrobeId) {
          rerenderItems();
        } else {
          run(wardrobeId).catch((err) => {
            console.error("[Detniv] republication :", err);
          });
        }
        return;
      }
      if (filterRetryCount < 5) {
        filterRetryCount += 1;
        filterRetryTimer = setTimeout(attempt, 150);
      }
    };
    filterRetryTimer = setTimeout(attempt, FILTER_SETTLE_MS);
  }

  /* ──────────────── Point d'entrée ──────────────── */

  async function run(wardrobeId) {
    if (busy) throw new Error("Republication déjà en cours.");
    const id = wardrobeId || wardrobeIdFromLocation();
    if (!id) {
      throw new Error(
        "Ouvrez une garde-robe (page profil membre) pour lancer la republication."
      );
    }
    let container = findContainer();
    if (!container) throw new Error("Garde-robe introuvable sur cette page.");
    busy = true;
    try {
      // Le fetch porte toujours sur les articles actifs : on aligne d'abord
      // l'onglet Vinted pour que React ne remplace pas nos cards juste après.
      await selectActiveFilter();
      const { items, pages } = await fetchAllItems(id);
      // Le clic sur « Actifs » peut avoir remplacé le conteneur React.
      container = findContainer() || container;
      lastRender = { wardrobeId: String(id), items };
      renderItems(container, items);
      rememberAutoWardrobe(id);
      startReconcile();
      return { count: items.length, pages };
    } finally {
      busy = false;
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

  document.addEventListener("click", onActiveFilterClick, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => autoStart(), {
      once: true,
    });
  } else {
    autoStart();
  }
})();
