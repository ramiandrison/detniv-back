/**
 * api.js — module d'accès à l'API Detniv, chargé comme content script.
 *
 * Fetch direct vers http://localhost:3001 depuis le content script :
 *   - les requêtes vers une adresse loopback sont autorisées depuis une page
 *     HTTPS (exemption mixed-content de Firefox/Chrome)
 *   - le backend Express expose déjà CORS ouvert (app.use(cors()))
 * Cela évite les permissions d'hôte de l'arrière-plan MV3 (non accordées
 * pour un chargement temporaire via about:debugging).
 *
 * Session (jetons) stockée dans browser.storage.local.
 * Utilisé par panel.js : DetnivApi.handle(action, payload) → data | throw.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.DetnivApi = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_API_URL = "http://localhost:3001/api";
  const SESSION_KEY = "detnivSession";
  const ACCESS_TTL_MS = 14 * 60 * 1000;

  function env() {
    return typeof browser !== "undefined" ? browser : globalThis.browser;
  }

  function localStore() {
    const b = env();
    if (!b || !b.storage || !b.storage.local) {
      throw new Error("browser.storage indisponible");
    }
    return b.storage.local;
  }

  /* ──────────────── Session ──────────────── */

  async function apiBaseUrl() {
    const store = await localStore().get("detnivApiUrl");
    return (store && store.detnivApiUrl) || DEFAULT_API_URL;
  }

  async function getSession() {
    const store = await localStore().get(SESSION_KEY);
    return (store && store[SESSION_KEY]) || null;
  }

  async function setSession(session) {
    await localStore().set({ [SESSION_KEY]: session });
  }

  async function clearSession() {
    await localStore().remove(SESSION_KEY);
  }

  /* ──────────────── Appels API ──────────────── */

  function errorMessage(data, status) {
    if (data && typeof data === "object") {
      if (typeof data.message === "string" && data.message) return data.message;
      if (Array.isArray(data.errors) && data.errors.length) {
        const first = data.errors[0];
        return (first && (first.message || first.code)) || "erreur serveur";
      }
    }
    return `erreur HTTP ${status}`;
  }

  async function rawRequest(path, { method = "POST", body, headers = {} } = {}) {
    const base = await apiBaseUrl();
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) {
      throw new Error(
        `API Detniv injoignable (${base}) — le backend est-il démarré ?`
      );
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error(errorMessage(data, res.status));
      err.status = res.status;
      throw err;
    }
    return data && data.data !== undefined ? data.data : data;
  }

  async function refreshSession() {
    const session = await getSession();
    if (!session || !session.refreshToken) {
      throw new Error("session expirée, reconnectez-vous");
    }
    const data = await rawRequest("/auth/refresh", {
      body: { refreshToken: session.refreshToken },
    });
    const next = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: session.user,
      expiresAt: Date.now() + ACCESS_TTL_MS,
    };
    await setSession(next);
    return next;
  }

  /** POST authentifié ; tente un refresh + un nouvel essai sur 401. */
  async function authedRequest(path, { method = "POST", body } = {}) {
    let session = await getSession();
    if (!session || !session.accessToken) {
      throw new Error("non connecté à Detniv");
    }
    if (session.expiresAt && Date.now() > session.expiresAt) {
      session = await refreshSession();
    }
    const attempt = (token) =>
      rawRequest(path, {
        method,
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
    try {
      return await attempt(session.accessToken);
    } catch (err) {
      if (err.status !== 401) throw err;
      try {
        session = await refreshSession();
      } catch (refreshErr) {
        await clearSession();
        throw refreshErr;
      }
      return attempt(session.accessToken);
    }
  }

  /* ──────────────── Actions ──────────────── */

  async function handle(action, payload) {
    switch (action) {
      case "session.get": {
        const session = await getSession();
        if (!session) return null;
        if (session.expiresAt && Date.now() > session.expiresAt) {
          try {
            await refreshSession();
          } catch (_) {
            await clearSession();
            return null;
          }
        }
        return { user: session.user };
      }

      case "auth.login": {
        const data = await rawRequest("/auth/login", { body: payload });
        await setSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.user,
          expiresAt: Date.now() + ACCESS_TTL_MS,
        });
        return { user: data.user };
      }

      case "auth.register":
        return rawRequest("/auth/register", { body: payload });

      case "auth.verify":
        return rawRequest("/auth/verify-email", { body: payload });

      case "auth.resend":
        return rawRequest("/auth/resend-verification", { body: payload });

      case "auth.forgot":
        return rawRequest("/auth/forgot-password", { body: payload });

      case "auth.reset":
        return rawRequest("/auth/reset-password", { body: payload });

      case "auth.logout":
        await clearSession();
        return null;

      case "auth.api": {
        const { path, method, body } = payload || {};
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error("chemin d'API invalide");
        }
        return authedRequest(path, { method, body });
      }

      default:
        throw new Error("action inconnue : " + action);
    }
  }

  return { handle, apiBaseUrl };
});
