/**
 * panel.js — content script : panneau Detniv à gauche de div.site-content.
 *
 * Déconnecté : onglets Connexion / Créer un compte + mot de passe oublié
 * (et vérification du code e-mail envoyé à l'inscription).
 * Connecté   : menu — Créer une annonce, Republication, Message aux favoris,
 * + Déconnexion.
 *
 * Toutes les requêtes API passent par api.js (DetnivApi.handle).
 */
(() => {
  "use strict";

  const PANEL_ID = "detniv-panel";
  const TOGGLE_ID = "detniv-panel-toggle";
  const STYLE_ID = "detniv-panel-styles";
  const COLLAPSE_KEY = "detnivPanelCollapsed";
  const REPOST_RESULT_KEY = "detnivRepostResult";

  const state = {
    view: "login",
    user: null,
    busy: false,
    notice: null,
    pending: null,
    collapsed: false,
  };

  /* ──────────────── Pont vers l'API (api.js) ──────────────── */

  async function call(action, payload) {
    const lib =
      typeof DetnivApi !== "undefined" ? DetnivApi : globalThis.DetnivApi;
    if (!lib || typeof lib.handle !== "function") {
      throw new Error("module api indisponible (api.js)");
    }
    return lib.handle(action, payload);
  }

  /* ──────────────── DOM helpers ──────────────── */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value);
      }
    }
    for (const child of children || []) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function field(labelText, input) {
    return el("label", { class: "dv-field" }, [
      el("span", { class: "dv-label", text: labelText }),
      input,
    ]);
  }

  function input(attrs) {
    return el("input", { class: "dv-input", type: "text", ...attrs });
  }

  function noticeNode() {
    if (!state.notice) return null;
    return el("p", {
      class: "dv-notice dv-notice--" + state.notice.kind,
      role: "status",
      text: state.notice.text,
    });
  }

  function submitButton(label) {
    const btn = el("button", {
      class: "dv-btn",
      type: "submit",
      text: state.busy ? "…" : label,
    });
    if (state.busy) btn.disabled = true;
    return btn;
  }

  /* ──────────────── Actions métier ──────────────── */

  async function run(fn, busyLabel) {
    if (state.busy) return;
    state.busy = true;
    state.notice = null;
    render();
    try {
      await fn();
    } catch (err) {
      state.notice = {
        kind: "error",
        text: String((err && err.message) || err),
      };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function doLogin(email, password) {
    await run(async () => {
      let data;
      try {
        data = await call("auth.login", { email, password });
      } catch (err) {
        const message = String((err && err.message) || err);
        // Compte créé mais jamais vérifié : on renvoie un nouveau code
        // et on bascule sur l'écran de vérification.
        if (/not verified/i.test(message)) {
          state.pending = { email, password };
          await call("auth.resend", { email });
          state.view = "verify";
          state.notice = {
            kind: "success",
            text: "Compte non vérifié. Un nouveau code à 6 chiffres vous a été envoyé par e-mail.",
          };
          return;
        }
        throw err;
      }
      state.user = data.user;
      state.view = "menu";
      state.pending = null;
      state.notice = {
        kind: "success",
        text: "Bonjour " + ((data.user && (data.user.name || data.user.email)) || "") + " !",
      };
    });
  }

  async function doRegister({ name, email, password }) {
    await run(async () => {
      await call("auth.register", { email, password, name: name || undefined });
      state.pending = { email, password };
      state.view = "verify";
      state.notice = {
        kind: "success",
        text: "Compte créé. Un code à 6 chiffres vous a été envoyé par e-mail.",
      };
    });
  }

  async function doVerify(code) {
    await run(async () => {
      const { email, password } = state.pending || {};
      await call("auth.verify", { email, code });
      try {
        const data = await call("auth.login", { email, password });
        state.user = data.user;
        state.view = "menu";
        state.notice = { kind: "success", text: "Compte vérifié, connecté." };
      } catch (_) {
        state.view = "login";
        state.notice = {
          kind: "success",
          text: "Compte vérifié. Vous pouvez vous connecter.",
        };
      }
    });
  }

  async function doForgot(email) {
    await run(async () => {
      await call("auth.forgot", { email });
      state.view = "login";
      state.notice = {
        kind: "success",
        text: "Si cet e-mail existe, un lien de réinitialisation a été envoyé.",
      };
    });
  }

  async function doReset({ token, password }) {
    await run(async () => {
      await call("auth.reset", { token, password });
      state.view = "login";
      state.notice = {
        kind: "success",
        text: "Mot de passe réinitialisé. Connectez-vous.",
      };
    });
  }

  function repostNotice(result) {
    return {
      kind: "success",
      text:
        result.count + " article(s) rechargé(s) sur " +
        result.pages + " page(s).",
    };
  }

  async function doRepost() {
    await run(async () => {
      const lib =
        typeof DetnivRepost !== "undefined" ? DetnivRepost : globalThis.DetnivRepost;
      if (!lib || typeof lib.start !== "function") {
        throw new Error("module repost indisponible (repost.js)");
      }
      const result = await lib.start();
      state.notice = result.navigating
        ? { kind: "success", text: "Redirection vers votre garde-robe…" }
        : repostNotice(result);
    });
  }

  async function doLogout() {
    await run(async () => {
      await call("auth.logout");
      state.user = null;
      state.view = "login";
      state.notice = { kind: "success", text: "Déconnecté de Detniv." };
    });
  }

  /* ──────────────── Vues ──────────────── */

  function tabs(active) {
    const make = (id, label) =>
      el("button", {
        class: "dv-tab" + (active === id ? " dv-tab--active" : ""),
        type: "button",
        text: label,
        onclick: () => {
          state.view = id;
          state.notice = null;
          render();
        },
      });
    return el("div", { class: "dv-tabs" }, [
      make("login", "Connexion"),
      make("register", "Créer un compte"),
    ]);
  }

  function viewLogin() {
    const email = input({
      type: "email",
      name: "email",
      autocomplete: "username",
      required: "",
    });
    const password = input({
      type: "password",
      name: "password",
      autocomplete: "current-password",
      required: "",
    });
    const form = el("form", { class: "dv-form" }, [
      field("E-mail", email),
      field("Mot de passe", password),
      submitButton("Se connecter"),
      el("button", {
        class: "dv-link",
        type: "button",
        text: "Mot de passe oublié ?",
        onclick: () => {
          state.view = "forgot";
          state.notice = null;
          render();
        },
      }),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      doLogin(email.value.trim(), password.value);
    });
    return [tabs("login"), form];
  }

  function viewRegister() {
    const name = input({ name: "name", autocomplete: "name" });
    const email = input({
      type: "email",
      name: "email",
      autocomplete: "username",
      required: "",
    });
    const password = input({
      type: "password",
      name: "password",
      autocomplete: "new-password",
      minlength: "8",
      required: "",
    });
    const form = el("form", { class: "dv-form" }, [
      field("Nom (optionnel)", name),
      field("E-mail", email),
      field("Mot de passe (8 caractères min.)", password),
      submitButton("Créer mon compte"),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      doRegister({
        name: name.value.trim(),
        email: email.value.trim(),
        password: password.value,
      });
    });
    return [tabs("register"), form];
  }

  function viewVerify() {
    const code = input({
      name: "code",
      inputmode: "numeric",
      pattern: "[0-9]{6}",
      maxlength: "6",
      required: "",
    });
    const form = el("form", { class: "dv-form" }, [
      el("p", {
        class: "dv-hint",
        text:
          "Un code à 6 chiffres a été envoyé à " +
          ((state.pending && state.pending.email) || "votre e-mail") +
          ".",
      }),
      field("Code de vérification", code),
      submitButton("Vérifier"),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      doVerify(code.value.trim());
    });
    return [form];
  }

  function viewForgot() {
    const email = input({
      type: "email",
      name: "email",
      autocomplete: "username",
      required: "",
    });
    const form = el("form", { class: "dv-form" }, [
      field("E-mail", email),
      submitButton("Envoyer le lien"),
      el("button", {
        class: "dv-link",
        type: "button",
        text: "Retour à la connexion",
        onclick: () => {
          state.view = "login";
          state.notice = null;
          render();
        },
      }),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      doForgot(email.value.trim());
    });
    return [form];
  }

  function viewReset() {
    const token = input({ name: "token", required: "" });
    const password = input({
      type: "password",
      name: "password",
      autocomplete: "new-password",
      minlength: "8",
      required: "",
    });
    const form = el("form", { class: "dv-form" }, [
      el("p", {
        class: "dv-hint",
        text: "Collez le jeton reçu dans l'e-mail, puis choisissez un nouveau mot de passe.",
      }),
      field("Jeton (depuis l'e-mail)", token),
      field("Nouveau mot de passe", password),
      submitButton("Réinitialiser"),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      doReset({ token: token.value.trim(), password: password.value });
    });
    return [form];
  }

  function menuItem({ label, hint, onclick }) {
    const btn = el("button", {
      class: "dv-menu-item" + (onclick ? "" : " dv-menu-item--disabled"),
      type: "button",
      onclick: onclick || null,
    }, [
      el("span", { class: "dv-menu-label", text: label }),
      hint ? el("span", { class: "dv-menu-hint", text: hint }) : null,
    ]);
    return btn;
  }

  function viewMenu() {
    const user = state.user || {};
    return [
      el("div", { class: "dv-user" }, [
        el("div", { class: "dv-user-name", text: user.name || "Compte Detniv" }),
        el("div", { class: "dv-user-email", text: user.email || "" }),
      ]),
      el("nav", { class: "dv-menu" }, [
        menuItem({
          label: "Créer une annonce",
          onclick: () => {
            try {
              window.location.assign("/items/new");
            } catch (_) {}
          },
        }),
        menuItem({
          label: "Republication",
          onclick: () => doRepost(),
        }),
        menuItem({ label: "Message aux favoris", hint: "Bientôt" }),
      ]),
      el("button", {
        class: "dv-btn dv-btn--ghost",
        type: "button",
        text: state.busy ? "…" : "Déconnexion",
        onclick: () => doLogout(),
        disabled: state.busy ? "" : null,
      }),
    ];
  }

  /* ──────────────── Rendu du panneau ──────────────── */

  function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle("dv-collapsed", state.collapsed);

    const body = panel.querySelector(".dv-body");
    const notice = panel.querySelector(".dv-notice-slot");

    // On conserve les valeurs saisies si la vue ne change pas.
    const keep = {};
    for (const field of body.querySelectorAll("input[name]")) {
      keep[field.name] = field.value;
    }
    const sameView = body.dataset.view === state.view;

    body.replaceChildren(...viewFor(state.view));
    body.dataset.view = state.view;
    if (sameView) {
      for (const field of body.querySelectorAll("input[name]")) {
        if (field.name in keep) field.value = keep[field.name];
      }
    }

    const node = noticeNode();
    notice.replaceChildren(...(node ? [node] : []));
  }

  function viewFor(view) {
    if (state.user && view !== "reset") return viewMenu();
    switch (view) {
      case "register":
        return viewRegister();
      case "verify":
        return viewVerify();
      case "forgot":
        return viewForgot();
      case "reset":
        return viewReset();
      default:
        return viewLogin();
    }
  }

  function buildPanel() {
    const panel = el("aside", {
      id: PANEL_ID,
      "aria-label": "Panneau Detniv",
    }, [
      el("header", { class: "dv-header" }, [
        el("span", { class: "dv-brand", text: "DETNIV" }),
        el("button", {
          class: "dv-collapse",
          type: "button",
          title: "Réduire le panneau",
          text: "‹",
          onclick: () => setCollapsed(true),
        }),
      ]),
      el("div", { class: "dv-notice-slot" }),
      el("div", { class: "dv-body" }),
      el("footer", { class: "dv-footer", text: "detniv · api locale" }),
    ]);
    return panel;
  }

  function buildToggle() {
    return el("button", {
      id: TOGGLE_ID,
      type: "button",
      title: "Ouvrir le panneau Detniv",
      text: "D",
      onclick: () => setCollapsed(false),
    });
  }

  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    try {
      browser.storage.local.set({ [COLLAPSE_KEY]: collapsed });
    } catch (_) {}
    syncDom();
  }

  /* ──────────────── Injection (SPA-safe) ──────────────── */

  function panelHosted() {
    const panel = document.getElementById(PANEL_ID);
    const host = document.querySelector(".site-content") || document.body;
    return !!(panel && host && panel.parentElement === host);
  }

  function ensureAttached() {
    const host = document.querySelector(".site-content") || document.body;
    if (!host) return false;

    let created = false;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = buildPanel();
      created = true;
    }
    if (panel.parentElement !== host) host.appendChild(panel);

    let toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) {
      toggle = buildToggle();
      document.body.appendChild(toggle);
    }
    toggle.style.display = state.collapsed ? "" : "none";
    panel.classList.toggle("dv-collapsed", state.collapsed);

    if (created) render();
    return true;
  }

  let attachTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(attachTimer);
    attachTimer = setTimeout(() => {
      try {
        // Ré-injection uniquement si Vinted a retiré le panneau (re-render
        // React) : pas de reconstruction à chaque mutation de la page.
        if (!panelHosted()) ensureAttached();
      } catch (err) {
        console.error("[Detniv] panneau :", err);
      }
    }, 150);
  });

  function syncDom() {
    ensureAttached();
  }

  /* ──────────────── Init ──────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  async function init() {
    injectStyles();
    try {
      const { [COLLAPSE_KEY]: collapsed } = await browser.storage.local.get(
        COLLAPSE_KEY
      );
      state.collapsed = !!collapsed;
    } catch (_) {}

    ensureAttached();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    try {
      const session = await call("session.get");
      if (session && session.user) {
        state.user = session.user;
        state.view = "menu";
      }
    } catch (_) {}

    // Résultat d'une republication lancée avant la navigation.
    try {
      const stored = await browser.storage.local.get(REPOST_RESULT_KEY);
      const last = stored[REPOST_RESULT_KEY];
      if (last && Date.now() - (last.at || 0) < 120000) {
        state.notice = last.error
          ? { kind: "error", text: "Republication : " + last.error }
          : repostNotice(last);
        await browser.storage.local.remove(REPOST_RESULT_KEY);
      }
    } catch (_) {}

    render();
  }

  const CSS = `
    #${PANEL_ID} {
      position: fixed;
      top: 53px;
      left: 0;
      bottom: 0;
      width: 288px;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      background: #0d0d0d;
      color: #f2f2f2;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      border-right: 1px solid #262626;
      box-shadow: 4px 0 24px rgba(0, 0, 0, .45);
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID}.dv-collapsed { display: none; }
    #${PANEL_ID} .dv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #1f1f1f;
    }
    #${PANEL_ID} .dv-brand {
      font-weight: 800;
      letter-spacing: .14em;
      font-size: 13px;
      color: #ffd600;
    }
    #${PANEL_ID} .dv-collapse {
      background: none;
      border: 0;
      color: #8a8a8a;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
    }
    #${PANEL_ID} .dv-collapse:hover { color: #ffd600; background: #1a1a1a; }
    #${PANEL_ID} .dv-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    #${PANEL_ID} .dv-footer {
      padding: 10px 16px;
      font-size: 11px;
      color: #6a6a6a;
      border-top: 1px solid #1f1f1f;
    }
    #${PANEL_ID} .dv-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 14px;
      border-bottom: 1px solid #1f1f1f;
    }
    #${PANEL_ID} .dv-tab {
      flex: 1;
      background: none;
      border: 0;
      border-bottom: 2px solid transparent;
      color: #9a9a9a;
      font: inherit;
      font-weight: 600;
      padding: 8px 4px;
      cursor: pointer;
    }
    #${PANEL_ID} .dv-tab:hover { color: #fff; }
    #${PANEL_ID} .dv-tab--active { color: #ffd600; border-bottom-color: #ffd600; }
    #${PANEL_ID} .dv-form { display: flex; flex-direction: column; gap: 12px; }
    #${PANEL_ID} .dv-field { display: flex; flex-direction: column; gap: 5px; }
    #${PANEL_ID} .dv-label { font-size: 12px; color: #b5b5b5; }
    #${PANEL_ID} .dv-input {
      background: #161616;
      border: 1px solid #2c2c2c;
      border-radius: 8px;
      color: #fff;
      font: inherit;
      padding: 9px 10px;
      outline: none;
    }
    #${PANEL_ID} .dv-input:focus { border-color: #ffd600; }
    #${PANEL_ID} .dv-btn {
      background: #ffd600;
      color: #0d0d0d;
      border: 0;
      border-radius: 8px;
      font: inherit;
      font-weight: 700;
      padding: 10px 12px;
      cursor: pointer;
    }
    #${PANEL_ID} .dv-btn:hover { filter: brightness(1.06); }
    #${PANEL_ID} .dv-btn:disabled { opacity: .55; cursor: default; }
    #${PANEL_ID} .dv-btn--ghost {
      background: transparent;
      color: #ddd;
      border: 1px solid #333;
      font-weight: 600;
    }
    #${PANEL_ID} .dv-btn--ghost:hover { border-color: #ffd600; color: #ffd600; }
    #${PANEL_ID} .dv-link {
      background: none;
      border: 0;
      color: #9a9a9a;
      font: inherit;
      font-size: 12px;
      text-decoration: underline;
      cursor: pointer;
      padding: 0;
      align-self: flex-start;
    }
    #${PANEL_ID} .dv-link:hover { color: #ffd600; }
    #${PANEL_ID} .dv-hint { margin: 0 0 4px; color: #b5b5b5; font-size: 12px; }
    #${PANEL_ID} .dv-notice-slot:empty { display: none; }
    #${PANEL_ID} .dv-notice {
      margin: 0 0 12px;
      padding: 9px 11px;
      border-radius: 8px;
      font-size: 12px;
      border-left: 3px solid #ffd600;
      background: #161616;
      color: #eee;
    }
    #${PANEL_ID} .dv-notice--error { border-left-color: #ff5252; }
    #${PANEL_ID} .dv-user {
      padding: 10px 12px;
      margin-bottom: 14px;
      background: #141414;
      border: 1px solid #242424;
      border-radius: 10px;
    }
    #${PANEL_ID} .dv-user-name { font-weight: 700; color: #fff; }
    #${PANEL_ID} .dv-user-email { color: #8f8f8f; font-size: 12px; word-break: break-all; }
    #${PANEL_ID} .dv-menu { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    #${PANEL_ID} .dv-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      text-align: left;
      background: #141414;
      border: 1px solid #262626;
      border-radius: 10px;
      color: #f2f2f2;
      font: inherit;
      font-weight: 600;
      padding: 12px;
      cursor: pointer;
    }
    #${PANEL_ID} .dv-menu-item:hover { border-color: #ffd600; color: #ffd600; }
    #${PANEL_ID} .dv-menu-item--disabled { opacity: .5; cursor: default; }
    #${PANEL_ID} .dv-menu-item--disabled:hover { border-color: #262626; color: #f2f2f2; }
    #${PANEL_ID} .dv-menu-hint {
      font-size: 11px;
      font-weight: 700;
      color: #0d0d0d;
      background: #ffd600;
      border-radius: 999px;
      padding: 2px 8px;
    }
    #${TOGGLE_ID} {
      position: fixed;
      left: 12px;
      top: 72px;
      z-index: 2147483645;
      width: 40px;
      height: 40px;
      border-radius: 999px;
      background: #0d0d0d;
      color: #ffd600;
      border: 1px solid #2a2a2a;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .5);
      font: 800 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    #${TOGGLE_ID}:hover { border-color: #ffd600; }
  `;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
