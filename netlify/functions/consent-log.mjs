// Registra un consenso cookie nel Netlify Blobs (store "consents").
// Viene chiamata dal banner (cookie-consent.js) a ogni scelta dell'utente.
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors(req) });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ ok: false, error: "bad_body" }), {
      status: 400, headers: { "content-type": "application/json", ...cors(req) },
    });
  }

  const id = String(body.consentId || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || randomUUID();
  const ts = new Date().toISOString();

  const record = {
    id,
    ts,
    consent: {
      necessary: true,
      analytics: !!body.analytics,
      ads: !!body.ads,
    },
    version: body.version ?? null,
    page: String(body.page || "").slice(0, 300),
    referrer: String(body.ref || "").slice(0, 300),
    lang: String(body.lang || "").slice(0, 10),
    userAgent: (req.headers.get("user-agent") || "").slice(0, 400),
    // IP anonimizzato prima del salvataggio (minimizzazione GDPR): l'IP completo non viene mai memorizzato
    ip: anonIp(
      req.headers.get("x-nf-client-connection-ip") ||
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      ""
    ),
    ipAnon: true,
  };

  try {
    const store = getStore("consents");
    // chiave ordinabile per data, con le scelte incluse (s=statistica, m=marketing):
    // il pannello admin conta e filtra i consensi senza dover scaricare ogni record
    const key = `${ts}__${id}__s${record.consent.analytics ? 1 : 0}m${record.consent.ads ? 1 : 0}`;
    await store.setJSON(key, record);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "store_error" }), {
      status: 500, headers: { "content-type": "application/json", ...cors(req) },
    });
  }

  return new Response(JSON.stringify({ ok: true, id }), {
    status: 200, headers: { "content-type": "application/json", ...cors(req) },
  });
};

// CORS ristretto: riflette l'origine solo se è del sito (o un preview Netlify).
// Le richieste same-origin del banner funzionano comunque; blocca l'abuso cross-origin dai browser.
function cors(req) {
  const origin = (req && req.headers.get("origin")) || "";
  const allowed =
    /^https:\/\/(www\.)?fisiomasia\.it$/.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin);
  const h = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
  if (allowed) h["access-control-allow-origin"] = origin;
  return h;
}

// Anonimizzazione IP (stesso criterio di Google Analytics):
//   IPv4 → azzera l'ultimo ottetto     93.45.12.87      → 93.45.12.0
//   IPv6 → tiene solo il prefisso /48  2001:db8:85a3:..  → 2001:db8:85a3::
function anonIp(raw) {
  const ip = String(raw || "").trim().split("%")[0];
  if (!ip) return "";
  const v4 = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); // anche ::ffff:1.2.3.4
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  if (!ip.includes(":")) return "";
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail !== undefined
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]
    : h;
  return groups.slice(0, 3).map((g) => (g || "0").toLowerCase()).join(":") + "::";
}
