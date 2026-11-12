// Login area gestione — verifica credenziali e rilascia un cookie di sessione firmato.
// Credenziali da env: ADMIN_EMAIL (default fabiana.masia@gmail.com), ADMIN_PASSWORD
//   (fallback al vecchio CONSENT_ADMIN_TOKEN, così funziona senza nuove variabili).
// Antispam: honeypot + blocco tentativi ripetuti per IP (Netlify Blobs).
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const COOKIE = "fm_admin";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export default async (req) => {
  if (req.method !== "POST") return redirect("/accesso.html");

  const form = await req.formData().catch(() => null);
  const b = form ? Object.fromEntries(form) : {};
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  const honeypot = String(b.website || "").trim();
  const ip = clientIp(req);

  // Honeypot: se compilato è un bot → rifiuta senza spendere altro.
  if (honeypot) return redirect("/accesso.html?err=1");

  // Rate limit
  const gate = await rateState(ip);
  if (gate.lockUntil && Date.now() < gate.lockUntil) return redirect("/accesso.html?err=lock");

  const expectedEmail = (process.env.ADMIN_EMAIL || "fabiana.masia@gmail.com").toLowerCase();
  const expectedPass = process.env.ADMIN_PASSWORD || process.env.CONSENT_ADMIN_TOKEN || "";

  const ok = expectedPass && timingEqual(email, expectedEmail) && timingEqual(password, expectedPass);
  if (!ok) {
    await bumpFail(ip, gate);
    return redirect("/accesso.html?err=1");
  }

  await clearFail(ip);
  const cookie = `${COOKIE}=${signSession(email)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`;
  return new Response(null, {
    status: 302,
    headers: { location: "/.netlify/functions/consent-admin", "set-cookie": cookie },
  });
};

/* ---------- sessione ---------- */
function secret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || process.env.CONSENT_ADMIN_TOKEN || "";
}
function signSession(email, days = 7) {
  const payload = Buffer.from(JSON.stringify({ e: email, exp: Date.now() + days * 864e5 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return payload + "." + sig;
}

/* ---------- antispam / rate limit ---------- */
function store() { return getStore("authgate"); }
function keyFor(ip) { return "ip_" + String(ip || "unknown").replace(/[^a-zA-Z0-9._:-]/g, "_"); }
async function rateState(ip) {
  try {
    const r = await store().get(keyFor(ip), { type: "json" });
    if (!r) return { fails: 0 };
    // finestra scaduta → azzera
    if (r.ts && Date.now() - r.ts > LOCK_MS && (!r.lockUntil || Date.now() > r.lockUntil)) return { fails: 0 };
    return r;
  } catch { return { fails: 0 }; }
}
async function bumpFail(ip, prev) {
  try {
    const fails = (prev?.fails || 0) + 1;
    const rec = { fails, ts: Date.now() };
    if (fails >= MAX_FAILS) { rec.lockUntil = Date.now() + LOCK_MS; rec.fails = 0; }
    await store().setJSON(keyFor(ip), rec);
  } catch {}
}
async function clearFail(ip) { try { await store().delete(keyFor(ip)); } catch {} }

/* ---------- util ---------- */
function timingEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}
function clientIp(req) {
  return req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}
function redirect(loc) { return new Response(null, { status: 302, headers: { location: loc } }); }
