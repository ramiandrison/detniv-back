/**
 * background.js — service worker léger : lecture des cookies Vinted.
 *
 * Les cookies de session Vinted (dont « v_uid ») sont HttpOnly : un content
 * script ne peut pas les lire via document.cookie. Il demande donc au
 * background de les récupérer avec l'API browser.cookies, pour l'origine de
 * l'onglet émetteur uniquement (jamais une URL arbitraire).
 */
"use strict";

const COOKIE_MESSAGE = "detniv:get-cookie";

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== COOKIE_MESSAGE) return undefined;

  let origin = null;
  try {
    origin = sender.tab && sender.tab.url ? new URL(sender.tab.url).origin : null;
  } catch (_) {
    origin = null;
  }
  if (!origin) {
    return Promise.resolve({ ok: false, error: "Origine de l'onglet inconnue." });
  }
  if (typeof message.name !== "string" || !message.name) {
    return Promise.resolve({ ok: false, error: "Nom de cookie manquant." });
  }

  return browser.cookies
    .get({ url: origin + "/", name: message.name })
    .then((cookie) => ({ ok: true, value: cookie ? cookie.value : null }))
    .catch((err) => ({
      ok: false,
      error: String((err && err.message) || err),
    }));
});
