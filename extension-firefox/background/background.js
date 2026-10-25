/**
 * background.js — service worker léger : cookies Vinted et images Vinted.
 *
 * Les cookies de session Vinted (dont « v_uid ») sont HttpOnly : un content
 * script ne peut pas les lire via document.cookie. Il demande donc au
 * background de les récupérer avec l'API browser.cookies, pour l'origine de
 * l'onglet émetteur uniquement (jamais une URL arbitraire).
 *
 * Le background télécharge aussi les photos d'articles : en Manifest V3, les
 * content scripts sont soumis au CORS de la page, alors que les pages
 * d'extension disposent des permissions d'hôte. L'image est renvoyée en data
 * URL, seul format sérialisable par runtime.sendMessage.
 *
 * Les en-têtes `Host` et `Origin` ne peuvent pas être retirés par le fetch
 * (en-têtes forbiddens) : Firefox pose toujours `Origin: moz-extension://…`
 * au transport, ce qui provoque un échec CORS sur le CDN Vinted.
 *
 * Le background installe donc des règles `declarativeNetRequest` dynamiques
 * qui remplacent `Origin`/`Referer` par l'URL de base du site Vinted de
 * l'onglet émetteur (ex. `https://www.vinted.fr`) : origine que le CDN
 * autorise, `Access-Control-Allow-Origin` est renvoyé et la lecture de
 * l'image passe.
 *
 *   - les images sont demandées en GET basique (sans `Accept-Language`
 *     ni `credentials`) ;
 *   - le `content-type` de la réponse et la non-vacuité du corps sont
 *     vérifiés avant renvoi, pour distinguer une image d'un éventuel
 *     `CORS Missing Allow Origin` renvoyé comme HTML/texte.
 */
"use strict";

const COOKIE_MESSAGE = "detniv:get-cookie";
const IMAGE_MESSAGE = "detniv:fetch-image";

/** Identifiant de la règle DNR dynamique (une seule à la fois, remplacée). */
const DNR_IMAGE_RULE_ID = 100;

function installImageOriginRule(origin) {
  const dnr = browser.declarativeNetRequest;
  if (!dnr || typeof dnr.updateDynamicRules !== "function") {
    return Promise.resolve(false);
  }
  return dnr
    .updateDynamicRules({
      removeRuleIds: [DNR_IMAGE_RULE_ID],
      addRules: [
        {
          id: DNR_IMAGE_RULE_ID,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: origin },
              { header: "Referer", operation: "set", value: origin + "/" },
            ],
          },
          condition: {
            requestDomains: ["vinted.net"],
            resourceTypes: ["image", "xmlhttprequest", "other"],
          },
        },
      ],
    })
    .then(() => true)
    .catch((err) => {
      console.warn(
        "[Detniv] règle DNR « Origin » non installée :",
        (err && err.message) || err
      );
      return false;
    });
}

function isVintedImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "vinted.net" || host.endsWith(".vinted.net");
}

/** btoa est disponible en event page comme en service worker. */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(offset, offset + chunkSize)
    );
  }
  return btoa(binary);
}

async function fetchImage(message) {
  if (typeof message.url !== "string" || !isVintedImageUrl(message.url)) {
    return {
      ok: false,
      error: "URL d'image Vinted invalide.",
    };
  }
  // La règle DNR dynamique remplace `Origin: moz-extension://…` par
  // l'URL de base du site Vinted de l'onglet émetteur, ce qui permet au
  // CDN de répondre au CORS sans échec.
  await installImageOriginRule(message.origin);
  // La requête est volontairement sans en-tête de contrôle (`Referer`,
  // `Accept-Language`, …) pour rester une demande simple : le CDN Vinted
  // n'exige qu'un GET basique, et la règle DNR prend en charge `Origin`.
  const response = await fetch(message.url, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) {
    return { ok: false, error: "HTTP " + response.status };
  }
  const type =
    response.headers.get("content-type") || "application/octet-stream";
  const isImage = /^image\//.test(type);
  const buffer = await response.arrayBuffer();
  if (!isImage || buffer.byteLength === 0) {
    return {
      ok: false,
      error: "contenu non-image (type : " + type + ")",
    };
  }
  return {
    ok: true,
    dataUrl: "data:" + type + ";base64," + arrayBufferToBase64(buffer),
  };
}

function vintedOriginFromTab(sender) {
  let origin = null;
  try {
    origin =
      sender.tab && sender.tab.url
        ? new URL(sender.tab.url).origin
        : null;
  } catch (_) {
    origin = null;
  }
  if (
    !origin ||
    !/^https:\/\/(?:www\.)?vinted\.[a-z]{2}\/?$/i.test(origin)
  ) {
    return null;
  }
  return origin.replace(/\/?$/, "");
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (message.type === IMAGE_MESSAGE) {
    const origin = vintedOriginFromTab(sender);
    if (!origin) {
      return Promise.resolve({
        ok: false,
        error: "Origine Vinted de l'onglet inconnue.",
      });
    }
    return fetchImage({ ...message, origin });
  }
  if (message.type !== COOKIE_MESSAGE) return undefined;

  let cookieOrigin = null;
  try {
    cookieOrigin =
      sender.tab && sender.tab.url
        ? new URL(sender.tab.url).origin
        : null;
  } catch (_) {
    cookieOrigin = null;
  }
  if (!cookieOrigin) {
    return Promise.resolve({ ok: false, error: "Origine de l'onglet inconnue." });
  }
  if (typeof message.name !== "string" || !message.name) {
    return Promise.resolve({ ok: false, error: "Nom de cookie manquant." });
  }

  return browser.cookies
    .get({ url: cookieOrigin + "/", name: message.name })
    .then((cookie) => ({ ok: true, value: cookie ? cookie.value : null }))
    .catch((err) => ({
      ok: false,
      error: String((err && err.message) || err),
    }));
});
