/**
 * repost.js — content script : republication (garde-robe Vinted).
 *
 * Sur une page profil membre (/member/<id>), recharge TOUS les articles
 * actifs via l'API Vinted (GET /api/v2/wardrobe/<id>/items?page=N&per_page=20
 * &cond=active, en boucle jusqu'à pagination.total_pages) puis remplace le
 * contenu de la grille (div.u-ui-margin-horizontal-regular@portables) par les
 * articles renvoyés par l'API.
 *
 * Déclenché depuis le panneau Detniv (menu « Republication ») :
 *   DetnivRepost.run() → { count, pages }
 */
(() => {
  "use strict";

  const CONTAINER_SEL = 'div[class*="u-ui-margin-horizontal-regular"]';
  const GRID_SEL = '[class*="feed-grid"]';
  const ITEM_SEL = '[data-testid="grid-item"]';
  const PER_PAGE = 20;
  const PAGE_DELAY_MS = 120;
  const UID_COOKIE = "v_uid";
  const PENDING_KEY = "detnivRepostPending";
  const RESULT_KEY = "detnivRepostResult";
  const PENDING_TTL_MS = 60000;

  let busy = false;

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
    const res = await fetch(url, { headers: { Accept: "application/json" } });
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
    const symbol = code === "EUR" ? " €" : code ? " " + code : "";
    return amount.toFixed(2).replace(".", ",") + symbol;
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
    const views = template.querySelector('[data-testid$="--description-title"]');
    if (views) {
      const count = Number(item.view_count) || 0;
      views.textContent = count + " vue" + (count === 1 ? "" : "s");
    }
    // Les favoris ne sont pas exposés par l'API wardrobe : on vide la valeur
    // héritée du template plutôt que d'afficher des données périmées.
    const favs = template.querySelector('[data-testid$="--description-subtitle"]');
    if (favs) favs.textContent = "";
    // Le bouton « Booster » cloné n'est pas branché aux handlers React de la
    // page : inutilisable, on le retire.
    for (const btn of template.querySelectorAll('[data-testid="bump-button"]')) {
      btn.remove();
    }
    return template;
  }

  /** Repli si la page ne contient aucune card modèle (garde-robe vide en SSR). */
  function buildFallbackItem(item) {
    const card = document.createElement("div");
    card.setAttribute("data-testid", "grid-item");
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
    box.append(link, price);
    card.appendChild(box);
    return card;
  }

  function renderItems(container, items) {
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

  /* ──────────────── Point d'entrée ──────────────── */

  async function run(wardrobeId) {
    if (busy) throw new Error("Republication déjà en cours.");
    const id = wardrobeId || wardrobeIdFromLocation();
    if (!id) {
      throw new Error(
        "Ouvrez une garde-robe (page profil membre) pour lancer la republication."
      );
    }
    const container = findContainer();
    if (!container) throw new Error("Garde-robe introuvable sur cette page.");
    busy = true;
    try {
      const { items, pages } = await fetchAllItems(id);
      renderItems(container, items);
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

  globalThis.DetnivRepost = {
    run,
    start,
    autoRunPending,
    readCookie,
    wardrobeIdFromLocation,
    onWardrobePage,
    fetchAllItems,
    formatPrice,
    photoUrl,
    itemUrl,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => autoRunPending(), {
      once: true,
    });
  } else {
    autoRunPending();
  }
})();
