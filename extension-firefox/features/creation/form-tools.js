/**
 * form-tools.js — content script : outils sur le formulaire « Vends ton article ».
 *
 *   - Déplace le champ Description de « Présentation de ton article » vers sa
 *     propre carte entre « Détails de l'article » et « Prix »
 *     (auto-réappliqué si React le remet à sa place)
 *   - 3 boutons sous le champ : Générer une description, Générer des
 *     hashtags, Mes descriptions (popup CRUD des modèles, stockés en base
 *     via l'API Detniv — connexion requise)
 */
(() => {
  "use strict";

  const STYLE_ID = "detniv-ft-styles";
  const SLOT_ATTR = "data-detniv-desc-slot";

  const DESC_LABEL = 'label[data-testid="description"]';
  const DESC_TEXTAREA = 'textarea[data-testid="description--input"]';
  const TITLE_INPUT = 'input[data-testid="title--input"]';

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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ──────────────── Écriture dans un champ contrôlé par React ──────────────── */

  function setNativeValue(node, value) {
    const proto =
      node.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Remplace le contenu du textarea de façon annulable (Ctrl+Z) si possible. */
  function fillTextarea(textarea, text) {
    textarea.focus();
    textarea.select();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) setNativeValue(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ──────────────── Lecture du formulaire ──────────────── */

  function titleValue() {
    const input = document.querySelector(TITLE_INPUT);
    return input ? input.value.trim() : "";
  }

  function detailValue(labelText) {
    for (const dd of document.querySelectorAll('[class*="input-dropdown"]')) {
      const label = dd.querySelector("label");
      if (!label || label.textContent.trim() !== labelText) continue;
      const input = dd.querySelector("input");
      const value = input ? input.value.trim() : "";
      // Vide = placeholder « Sélectionne … » / « Select … ».
      if (!value || /^s[ée]lectionne|^select /i.test(value)) return "";
      return value;
    }
    return "";
  }

  function formSummary() {
    return {
      title: titleValue(),
      category: detailValue("Catégorie") || detailValue("Category"),
      brand: detailValue("Marque") || detailValue("Brand"),
      size: detailValue("Taille") || detailValue("Size"),
      state: detailValue("État") || detailValue("État de l'article") || detailValue("Condition"),
      colors: detailValue("Couleur") || detailValue("Couleurs") || detailValue("Colour") || detailValue("Color"),
      material: detailValue("Matériau (recommandé)") || detailValue("Matériau") || detailValue("Material"),
    };
  }

  /* ──────────────── Générateurs ──────────────── */

  function buildDescription(summary) {
    const lines = [];
    if (summary.title) lines.push(summary.title + ".");
    const specs = [
      ["Marque", summary.brand],
      ["Taille", summary.size],
      ["État", summary.state],
      ["Couleurs", summary.colors],
      ["Matière", summary.material],
    ];
    const filled = specs.filter(([, v]) => v).map(([k, v]) => `${k} : ${v}`);
    if (filled.length) lines.push(filled.join(" · "));
    if (summary.category) lines.push(`Catégorie : ${summary.category}.`);
    lines.push("");
    lines.push("Article en bon état, expédition rapide. N'hésitez pas si vous avez des questions !");
    return lines.join("\n");
  }

  const STOP_WORDS = new Set(
    ("le la les de des un une et ou pour avec en du au aux ce cet cette ma mon mes " +
      "ta ton tes son sa ses est sont sur sous dans par que qui quoi dont bien " +
      "the a an of and or for with in on to is are my your new size ref")
      .split(" ")
  );

  function extractHashtags(summary) {
    const source = [summary.title, summary.category, summary.brand, summary.material]
      .filter(Boolean)
      .join(" ");
    const words = source
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    const seen = new Set();
    const tags = [];
    for (const word of words) {
      if (seen.has(word)) continue;
      seen.add(word);
      tags.push("#" + word);
      if (tags.length >= 10) break;
    }
    return tags.join(" ");
  }

  /* ──────────────── Modèles (CRUD via l'API Detniv) ──────────────── */

  /** Appel générique à l'API backend (session JWT auto gérée par api.js). */
  async function apiCall(path, method, body) {
    if (typeof DetnivApi === "undefined" || !DetnivApi || !DetnivApi.handle) {
      throw new Error("API Detniv indisponible.");
    }
    return DetnivApi.handle("auth.api", { path, method, body });
  }

  async function isLoggedIn() {
    try {
      if (typeof DetnivApi === "undefined" || !DetnivApi || !DetnivApi.handle) return false;
      const session = await DetnivApi.handle("session.get");
      return Boolean(session && session.user);
    } catch (_) {
      return false;
    }
  }

  async function loadTemplates() {
    // auth.api renvoie data.data (le tableau nu pour GET /descriptions).
    const res = await apiCall("/descriptions", "GET");
    return Array.isArray(res) ? res : [];
  }

  async function addTemplate(name, text) {
    return apiCall("/descriptions", "POST", { name, text });
  }

  async function deleteTemplate(id) {
    return apiCall(`/descriptions/${id}`, "DELETE");
  }

  /* ──────────────── Popup CRUD ──────────────── */

  let popup = null;

  function closePopup() {
    if (!popup) return;
    popup.remove();
    popup = null;
  }

  async function openPopup() {
    if (popup) return;
    const textarea = document.querySelector(DESC_TEXTAREA);

    const nameInput = el("input", {
      class: "dv-crud-input",
      type: "text",
      placeholder: "Nom du modèle (ex. Jeans Zara)",
      maxlength: "120",
    });
    const textArea = el("textarea", {
      class: "dv-crud-textarea",
      placeholder: "Texte du modèle…",
      rows: "5",
      maxlength: "2000",
    });
    if (textarea && textarea.value.trim()) {
      textArea.value = textarea.value.trim();
    }

    const listNode = el("div", { class: "dv-crud-list" });
    const errorNode = el("p", { class: "dv-crud-error" });

    async function refreshList() {
      errorNode.textContent = "";
      listNode.replaceChildren();
      let templates;
      try {
        templates = await loadTemplates();
      } catch (err) {
        listNode.appendChild(
          el("p", { class: "dv-crud-empty", text: "Impossible de charger vos descriptions." })
        );
        errorNode.textContent = err && err.message ? err.message : "Erreur API.";
        return;
      }
      if (!templates.length) {
        listNode.appendChild(
          el("p", { class: "dv-crud-empty", text: "Aucun modèle enregistré." })
        );
        return;
      }
      for (const template of templates) {
        listNode.appendChild(
          el("div", { class: "dv-crud-item" }, [
            el("div", { class: "dv-crud-item-head" }, [
              el("span", { class: "dv-crud-name", text: template.name }),
              el("div", { class: "dv-crud-actions" }, [
                el("button", {
                  class: "dv-crud-btn dv-crud-btn--use",
                  type: "button",
                  text: "Utiliser",
                  onclick: () => {
                    const target = document.querySelector(DESC_TEXTAREA);
                    if (target) fillTextarea(target, template.text);
                    closePopup();
                  },
                }),
                el("button", {
                  class: "dv-crud-btn dv-crud-btn--del",
                  type: "button",
                  text: "Supprimer",
                  onclick: async () => {
                    if (!window.confirm(`Supprimer le modèle « ${template.name} » ?`)) {
                      return;
                    }
                    try {
                      await deleteTemplate(template.id);
                    } catch (err) {
                      errorNode.textContent = err && err.message ? err.message : "Erreur API.";
                      return;
                    }
                    refreshList();
                  },
                }),
              ]),
            ]),
            el("pre", { class: "dv-crud-preview", text: template.text }),
          ])
        );
      }
    }

    const addForm = el("form", { class: "dv-crud-add" }, [
      nameInput,
      textArea,
      el("button", { class: "dv-crud-btn dv-crud-btn--add", type: "submit", text: "Enregistrer le modèle" }),
    ]);
    addForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorNode.textContent = "";
      const name = nameInput.value.trim();
      const text = textArea.value.trim();
      if (!name || !text) {
        errorNode.textContent = "Nom et texte sont obligatoires.";
        return;
      }
      if (text.length > 2000) {
        errorNode.textContent = "Le texte est trop long (2000 caractères max).";
        return;
      }
      try {
        await addTemplate(name, text);
      } catch (err) {
        errorNode.textContent = err && err.message ? err.message : "Erreur API.";
        return;
      }
      nameInput.value = "";
      textArea.value = "";
      refreshList();
    });

    const loggedIn = await isLoggedIn();

    const children = [
      el("header", { class: "dv-crud-header" }, [
        el("span", { class: "dv-crud-title", text: "Mes descriptions" }),
        el("button", {
          class: "dv-crud-close",
          type: "button",
          text: "×",
          title: "Fermer",
          onclick: () => closePopup(),
        }),
      ]),
      errorNode,
    ];
    if (loggedIn) {
      children.push(addForm);
      children.push(el("h3", { class: "dv-crud-subtitle", text: "Descriptions enregistrées" }));
      children.push(listNode);
    } else {
      children.push(
        el("p", {
          class: "dv-crud-empty",
          text: "Connectez-vous à Detniv (panneau à gauche) pour gérer vos descriptions.",
        })
      );
    }

    popup = el("div", {
      class: "dv-crud-overlay",
      onclick: (event) => {
        if (event.target === popup) closePopup();
      },
    }, [
      el("div", { class: "dv-crud-popup", role: "dialog", "aria-modal": "true" }, children),
    ]);

    // Les clics dans le popup ne doivent pas atteindre le <label> du champ
    // (phase bubble : les boutons internes fonctionnent, l'événement s'arrête
    // au popup avant de remonter vers le label).
    for (const type of ["mousedown", "mouseup", "click"]) {
      popup.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.appendChild(popup);
    if (loggedIn) {
      await refreshList();
      nameInput.focus();
    }
  }

  /* ──────────────── Barre d'outils + déplacement ──────────────── */

  function toolbar() {
    return el("div", { class: "detniv-ft-bar" }, [
      el("button", {
        class: "detniv-ft-btn",
        type: "button",
        text: "Générer une description",
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const textarea = document.querySelector(DESC_TEXTAREA);
          if (!textarea) return;
          fillTextarea(textarea, buildDescription(formSummary()));
        },
      }),
      el("button", {
        class: "detniv-ft-btn",
        type: "button",
        text: "Générer des hashtags",
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const textarea = document.querySelector(DESC_TEXTAREA);
          if (!textarea) return;
          const tags = extractHashtags(formSummary());
          if (!tags) return;
          const base = textarea.value.replace(/\s+#\S+(?:\s+#\S+)*\s*$/, "").trimEnd();
          fillTextarea(textarea, base ? base + "\n\n" + tags : tags);
        },
      }),
      el("button", {
        class: "detniv-ft-btn detniv-ft-btn--primary",
        type: "button",
        text: "Mes descriptions",
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPopup();
        },
      }),
    ]);
  }

  function sectionHeading(textRe) {
    for (const p of document.querySelectorAll("p.web_ui__Text__section-heading")) {
      if (textRe.test(p.textContent.trim())) return p;
    }
    return null;
  }

  function cardAfterHeading(heading) {
    let node = heading ? heading.nextElementSibling : null;
    while (node) {
      if (node.classList && node.classList.contains("web_ui__Card__card")) return node;
      node = node.nextElementSibling;
    }
    return null;
  }

  function detailsCard() {
    return cardAfterHeading(sectionHeading(/^(Détails de l'article|Details of the item)$/i));
  }

  function applyMove() {
    const label = document.querySelector(DESC_LABEL);
    if (!label) return false;
    if (label.parentElement && label.parentElement.hasAttribute(SLOT_ATTR)) return true;

    const details = detailsCard();
    const prix = sectionHeading(/^(Prix|Price)$/i);

    let slot;
    if (details && prix) {
      // Carte autonome : après le spacer qui sépare Détails et Prix, avec un
      // second spacer cloné avant le titre Prix (rythme visuel Vinted).
      slot = document.querySelector(`div[${SLOT_ATTR}]`);
      if (!slot) {
        const orphanSpacer = document.querySelector(`div[${SLOT_ATTR}-spacer]`);
        if (orphanSpacer) orphanSpacer.remove();
        slot = el("div", { class: "web_ui__Card__card" });
        slot.setAttribute(SLOT_ATTR, "1");
        prix.before(slot);
        const spacer = el("div", { class: "web_ui__Spacer__x2-large web_ui__Spacer__horizontal" });
        spacer.setAttribute(`${SLOT_ATTR}-spacer`, "1");
        slot.after(spacer);
      }
    } else if (details) {
      // Repli : dans la carte « Détails de l'article » (si « Prix » est absent).
      slot = details.querySelector(`[${SLOT_ATTR}]`);
      if (!slot) {
        slot = el("li", { class: "web_ui__Item__item" });
        slot.setAttribute(SLOT_ATTR, "1");
        const list = details.querySelector("ul");
        if (list) list.appendChild(slot);
        else details.appendChild(slot);
      }
    } else {
      return false;
    }

    slot.appendChild(label);

    const content = label.querySelector(".web_ui__Input__content");
    if (content && !content.querySelector(".detniv-ft-bar")) {
      content.appendChild(toolbar());
    }
    return true;
  }

  /* ──────────────── Styles + init ──────────────── */

  const CSS = `
    .detniv-ft-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .detniv-ft-btn {
      background: #0d0d0d;
      color: #ffd600;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 8px 12px;
      cursor: pointer;
    }
    .detniv-ft-btn:hover { border-color: #ffd600; background: #161616; }
    .detniv-ft-btn--primary { background: #ffd600; color: #0d0d0d; border-color: #ffd600; }
    .detniv-ft-btn--primary:hover { filter: brightness(1.05); background: #ffd600; }
    .dv-crud-overlay {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(0, 0, 0, .55);
      display: flex; align-items: center; justify-content: center;
    }
    .dv-crud-popup {
      width: min(560px, calc(100vw - 32px));
      max-height: min(80vh, 640px);
      overflow-y: auto;
      background: #0d0d0d; color: #f2f2f2;
      border: 1px solid #2a2a2a; border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, .6);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 16px;
    }
    .dv-crud-popup * { box-sizing: border-box; }
    .dv-crud-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .dv-crud-title { font-weight: 800; letter-spacing: .08em; color: #ffd600; font-size: 13px; }
    .dv-crud-close {
      background: none; border: 0; color: #8a8a8a; font-size: 22px; line-height: 1;
      cursor: pointer; padding: 0 4px;
    }
    .dv-crud-close:hover { color: #ffd600; }
    .dv-crud-add { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .dv-crud-input, .dv-crud-textarea {
      background: #161616; border: 1px solid #2c2c2c; border-radius: 8px;
      color: #fff; font: inherit; padding: 9px 10px; outline: none; width: 100%;
    }
    .dv-crud-textarea { resize: vertical; min-height: 90px; }
    .dv-crud-input:focus, .dv-crud-textarea:focus { border-color: #ffd600; }
    .dv-crud-subtitle { margin: 0 0 8px; font-size: 12px; color: #9a9a9a; text-transform: uppercase; letter-spacing: .06em; }
    .dv-crud-list { display: flex; flex-direction: column; gap: 10px; }
    .dv-crud-empty { margin: 0; color: #8a8a8a; font-style: italic; }
    .dv-crud-error { margin: 0 0 8px; color: #ff5252; font-size: 12px; min-height: 1em; }
    .dv-crud-item { border: 1px solid #242424; border-radius: 10px; padding: 10px 12px; background: #141414; }
    .dv-crud-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .dv-crud-name { font-weight: 700; color: #fff; }
    .dv-crud-actions { display: flex; gap: 6px; }
    .dv-crud-btn {
      background: transparent; border: 1px solid #333; border-radius: 6px;
      color: #ddd; font: 600 11px/1 inherit; padding: 6px 10px; cursor: pointer;
    }
    .dv-crud-btn:hover { border-color: #ffd600; color: #ffd600; }
    .dv-crud-btn--use { border-color: #ffd600; color: #ffd600; }
    .dv-crud-btn--del:hover { border-color: #ff5252; color: #ff5252; }
    .dv-crud-btn--add {
      background: #ffd600; border-color: #ffd600; color: #0d0d0d;
      font-weight: 700; padding: 9px 12px; align-self: flex-start;
    }
    .dv-crud-btn--add:hover { filter: brightness(1.05); color: #0d0d0d; border-color: #ffd600; }
    .dv-crud-preview {
      margin: 8px 0 0; white-space: pre-wrap; word-break: break-word;
      color: #b5b5b5; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      max-height: 96px; overflow-y: auto;
    }
  `;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  let moveTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      try {
        applyMove();
      } catch (err) {
        console.error("[Detniv] form-tools :", err);
      }
    }, 200);
  });

  function init() {
    injectStyles();
    try {
      applyMove();
    } catch (err) {
      console.error("[Detniv] form-tools :", err);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    // Raccourci Échap pour fermer le popup.
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePopup();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
