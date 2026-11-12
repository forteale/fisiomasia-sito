/* ============================================================
   Studio Fisiomasia — banner e consenso cookie (unico per tutte le pagine)
   - Accetta / Rifiuta con pari evidenza; scelta valida 12 mesi
   - Consenso = misurazione Google Ads (Consent Mode v2) + mappa Google Maps
   - Registro consensi su Netlify Forms (form "cookie-consent-log")
   - Link «Preferenze cookie» aggiunto in fondo a ogni pagina per cambiare idea
   - Mappe: <iframe data-consent-src="..."> si carica solo con il consenso
     oppure al clic su «Mostra la mappa» (solo per quella volta)
   ============================================================ */
(function () {
  "use strict";

  var POLICY_VERSION = "2026-11";          // cambiarla richiede di nuovo il consenso a tutti
  var DURATION = 365 * 24 * 60 * 60 * 1000; // 12 mesi
  var K_CHOICE = "cookie_consent_v2", K_EXP = "cookie_consent_expiry", K_VER = "cookie_consent_version", K_SID = "fisiomasia_sid";

  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== "function") { window.gtag = function () { window.dataLayer.push(arguments); }; }

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function stored() {
    var c = ls(K_CHOICE), exp = parseInt(ls(K_EXP) || "0", 10), ver = ls(K_VER);
    if (!c || !exp || Date.now() > exp || ver !== POLICY_VERSION) return null;
    return c; // "granted" | "rifiutato"
  }
  function granted() { return stored() === "granted"; }

  function sid() {
    var s = ls(K_SID);
    if (!s) { s = "sid_" + Math.random().toString(36).slice(2, 11) + "_" + Date.now(); ls(K_SID, s); }
    return s;
  }
  function log(scelta) {
    try {
      var fd = new FormData();
      fd.append("form-name", "cookie-consent-log");
      fd.append("scelta", scelta);
      fd.append("timestamp", new Date().toISOString());
      fd.append("sessione_id", sid());
      fd.append("pagina", location.href);
      fd.append("policy_version", POLICY_VERSION);
      fetch("/", { method: "POST", body: fd }).catch(function () {});
    } catch (e) {}
  }
  function googleConsent(ok) {
    var s = ok ? "granted" : "denied";
    window.gtag("consent", "update", { ad_storage: s, analytics_storage: s, ad_user_data: s, ad_personalization: s });
  }
  function clearGoogleCookies() {
    try {
      var host = location.hostname.replace(/^www\./, "");
      document.cookie.split(";").forEach(function (p) {
        var n = p.split("=")[0].trim();
        if (/^(_gcl_|_ga)/.test(n)) {
          ["", "; domain=" + host, "; domain=." + host].forEach(function (d) { document.cookie = n + "=; Max-Age=0; path=/" + d; });
        }
      });
    } catch (e) {}
  }

  /* ---------- mappe Google ---------- */
  function loadMap(f) {
    if (!f.getAttribute("data-consent-src")) return;
    f.src = f.getAttribute("data-consent-src");
    f.removeAttribute("data-consent-src");
    var g = f.parentNode && f.parentNode.querySelector(".fm-map-gate");
    if (g) g.parentNode.removeChild(g);
  }
  function setupMaps() {
    var frames = document.querySelectorAll("iframe[data-consent-src]");
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (granted()) { loadMap(f); continue; }
      var box = f.parentNode;
      if (!box || box.querySelector(".fm-map-gate")) continue;
      if (getComputedStyle(box).position === "static") box.style.position = "relative";
      var g = document.createElement("div");
      g.className = "fm-map-gate";
      g.innerHTML = '<div><p>La mappa è fornita da <strong>Google Maps</strong>: se la mostri, Google riceve il tuo indirizzo IP e può impostare cookie propri. <a href="cookie-policy.html">Cookie Policy</a></p>' +
        '<button type="button">Mostra la mappa</button></div>';
      (function (frame) { g.querySelector("button").addEventListener("click", function () { loadMap(frame); }); })(f);
      box.appendChild(g);
    }
  }

  /* ---------- banner ---------- */
  var CSS =
    "#fm-cookie{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:rgba(30,26,26,.97);border-top:1px solid rgba(139,77,110,.3);padding:.95rem 5vw;font-family:'DM Sans',system-ui,sans-serif}" +
    "#fm-cookie .in{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:1.4rem;flex-wrap:wrap;justify-content:space-between}" +
    "#fm-cookie p{margin:0;flex:1;min-width:220px;font-size:.84rem;line-height:1.55;color:rgba(255,255,255,.78)}" +
    "#fm-cookie a{color:#7fc8ad;text-decoration:underline;text-underline-offset:3px}" +
    "#fm-cookie .bt{display:flex;gap:.8rem;flex-shrink:0}" +
    "#fm-cookie button{font-family:inherit;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:.55rem 1.5rem;cursor:pointer;min-width:118px;border:1.5px solid #8b4d6e;background:#8b4d6e;color:#fff}" +
    "#fm-cookie button:hover{background:#6e3a56;border-color:#6e3a56}" +
    "@media(max-width:640px){#fm-cookie .bt{width:100%}#fm-cookie button{flex:1}}" +
    ".fm-map-gate{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#f6f1ee;padding:1.4rem;text-align:center;z-index:2;border-radius:inherit}" +
    ".fm-map-gate p{margin:0 auto 1rem;max-width:42ch;font-size:.88rem;line-height:1.55;color:#5a4a52}" +
    ".fm-map-gate a{color:#8b4d6e}" +
    ".fm-map-gate button{font:600 .78rem 'DM Sans',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;border:0;border-radius:999px;padding:.6rem 1.5rem;background:#8b4d6e;color:#fff;cursor:pointer}";

  function injectCSS() {
    if (document.getElementById("fm-cookie-css")) return;
    var s = document.createElement("style"); s.id = "fm-cookie-css"; s.textContent = CSS; document.head.appendChild(s);
  }
  var banner = null;
  function hideBanner() { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); banner = null; }
  function showBanner() {
    if (banner) return;
    injectCSS();
    banner = document.createElement("div");
    banner.id = "fm-cookie";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Preferenze sui cookie");
    banner.innerHTML = '<div class="in"><p>Questo sito usa cookie tecnici e, con il tuo consenso, i cookie di <strong>Google Ads</strong> per misurare i risultati degli annunci e la <strong>mappa di Google Maps</strong>. Puoi cambiare idea quando vuoi dal link «Preferenze cookie» in fondo alla pagina. <a href="cookie-policy.html">Cookie Policy</a> · <a href="privacy.html">Privacy</a></p>' +
      '<div class="bt"><button type="button" data-c="no">Rifiuta</button><button type="button" data-c="si">Accetta</button></div></div>';
    document.body.appendChild(banner);
    banner.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-c]") : null; if (!b) return;
      save(b.getAttribute("data-c") === "si");
    });
  }
  function save(ok) {
    ls(K_CHOICE, ok ? "granted" : "rifiutato");
    ls(K_EXP, String(Date.now() + DURATION));
    ls(K_VER, POLICY_VERSION);
    googleConsent(ok);
    if (!ok) clearGoogleCookies();
    log(ok ? "granted" : "rifiutato");
    hideBanner();
    setupMaps();
  }

  /* API: riapre il banner (link «Preferenze cookie») */
  window.fmCookiePrefs = function () { showBanner(); return false; };

  function addFooterLink() {
    var links = document.querySelectorAll('footer a[href*="cookie-policy"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.parentNode.querySelector("[data-cookie-prefs]")) continue;
      var p = document.createElement("a");
      p.href = "#"; p.setAttribute("data-cookie-prefs", "");
      p.textContent = "Preferenze cookie";
      p.className = a.className; p.style.cssText = a.style.cssText;
      a.parentNode.insertBefore(p, a.nextSibling); // subito dopo «Cookie Policy»
    }
    var inPage = document.querySelectorAll("[data-cookie-prefs]");
    for (var j = 0; j < inPage.length; j++) {
      if (inPage[j].__fm) continue; inPage[j].__fm = 1;
      inPage[j].addEventListener("click", function (e) { e.preventDefault(); window.fmCookiePrefs(); });
    }
  }

  function init() {
    var c = stored();
    if (c) googleConsent(c === "granted"); else showBanner();
    setupMaps();
    addFooterLink();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
