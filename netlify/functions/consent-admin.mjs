// Backoffice registro consensi — protetto da login (cookie di sessione) o da token.
// Accesso via pagina /accesso.html. Filtri per data e ricerca testo.
//   Diretto (senza login):  /.netlify/functions/consent-admin?token=IL_TUO_TOKEN
//   Export:                 &format=csv | &format=json  (rispettano i filtri attivi)
//   Filtri:                 &from=YYYY-MM-DD &to=YYYY-MM-DD &q=testo &limit=200
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "html").toLowerCase();

  // ---- autenticazione ----
  const token = url.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  const expectedToken = process.env.CONSENT_ADMIN_TOKEN || "";
  const secretConfigured = process.env.ADMIN_PASSWORD || process.env.CONSENT_ADMIN_TOKEN;
  const session = verifySession(getCookie(req, "fm_admin"));
  const authed = !!session || (expectedToken && token === expectedToken);

  if (!secretConfigured) {
    return html(
      `<h1>Registro consensi non configurato</h1>
       <p>Imposta la variabile d'ambiente <b>ADMIN_PASSWORD</b> (o <b>CONSENT_ADMIN_TOKEN</b>)
       su Netlify → Site settings → Environment variables, poi riprova.</p>`, 500);
  }
  if (!authed) {
    if (format === "json" || format === "csv")
      return new Response("401 — non autorizzato", { status: 401 });
    return new Response(null, { status: 302, headers: { location: "/accesso.html" } });
  }

  const DEADLINE = Date.now() + 7000; // margine sotto il limite di ~10 s delle Netlify Functions
  const store = getStore("consents");

  // ---- elenco chiavi: una sola richiesta, senza scaricare i record ----
  // chiave = <data ISO>__<id consenso>__s<0|1>m<0|1>  (le scelte stanno nella chiave → conteggi immediati)
  let entries, stale;
  try {
    const { blobs } = await store.list();
    ({ entries, stale } = dedupe(blobs.map((b) => parseKey(b.key))));
  } catch {
    return html(`<h1>Errore</h1><p>Impossibile leggere lo store dei consensi.</p>`, 500);
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // più recenti in alto
  const legacy = entries.filter((e) => !e.flags); // registrati prima dell'anonimizzazione automatica
  const totalAll = entries.length;

  // ---- azione una tantum, a blocchi: anonimizza gli IP dei consensi registrati in precedenza ----
  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    if (!form || form.get("action") !== "anonymize-legacy")
      return new Response("Richiesta non valida", { status: 400 });
    let done = 0;
    const jobs = [...legacy.map((e) => ({ e, drop: false })), ...stale.map((e) => ({ e, drop: true }))];
    await pool(jobs, 25, DEADLINE, async ({ e, drop }) => {
      if (!drop) {
        const r = await store.get(e.key, { type: "json" });
        if (!r) return;
        r.ip = anonIp(r.ip);
        r.ipAnon = true;
        await store.setJSON(`${e.ts}__${e.id}__s${r.consent?.analytics ? 1 : 0}m${r.consent?.ads ? 1 : 0}`, r);
      }
      await store.delete(e.key);
      done++;
    });
    const back = `${url.pathname}?${token ? `token=${encodeURIComponent(token)}&` : ""}anon=${done}`;
    return new Response(null, { status: 303, headers: { location: back } });
  }

  // ---- filtri ----
  // date accettate solo nel formato YYYY-MM-DD (neutralizza input malevolo)
  const dateOnly = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "");
  const from = dateOnly((url.searchParams.get("from") || "").trim());
  const to = dateOnly((url.searchParams.get("to") || "").trim());
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 120);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
  // giorno-calendario in ora italiana (YYYY-MM-DD) → confronto coerente coi filtri per data
  const itDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" });
  const ranged = (from || to)
    ? entries.filter((e) => {
        const day = e.ts ? itDay.format(new Date(e.ts)) : "";
        return !(from && day < from) && !(to && day > to);
      })
    : entries;

  // ---- scarico solo i record necessari, in parallelo ----
  const MAX_FETCH = 4000;
  const exporting = format === "json" || format === "csv";
  const needAll = exporting || !!q; // ricerca testo ed export richiedono il contenuto
  const targets = needAll ? ranged.slice(0, MAX_FETCH) : ranged.slice(0, limit);
  const { results, timedOut } = await fetchAll(store, targets, 25, DEADLINE);
  const loaded = results.filter(Boolean);
  const incomplete = (needAll && ranged.length > MAX_FETCH) || timedOut;

  const matches = (r) => [
    r.id, r.page, r.referrer, r.lang, r.ip, r.userAgent, r.version,
    r.consent?.analytics ? "Google Ads sì" : "Google Ads no",
    r.consent?.ads ? "mappa sì" : "mappa no",
  ].join(" ").toLowerCase().includes(q);
  const filtered = q ? loaded.filter(matches) : loaded;
  const totalFiltered = q ? filtered.length : ranged.length;
  const shown = filtered.slice(0, limit);

  // ---- export (rispetta i filtri) ----
  if (exporting && incomplete) {
    return html(`<h1>Export troppo grande</h1>
      <p>Nell'intervallo selezionato ci sono troppi consensi per un unico file (${ranged.length}).
      Restringi le date (ad esempio un mese alla volta) ed esporta più file.</p>
      <p><a href="${url.pathname}${token ? `?token=${encodeURIComponent(token)}` : ""}">← Torna al registro</a></p>`, 413);
  }
  if (format === "json") {
    return new Response(JSON.stringify(filtered, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (format === "csv") {
    const head = ["ts", "id", "analytics", "ads", "version", "page", "referrer", "lang", "ip", "userAgent"];
    const rows = filtered.map((r) =>
      [r.ts, r.id, r.consent?.analytics, r.consent?.ads, r.version, r.page, r.referrer, r.lang, r.ip, r.userAgent]
        .map(csvCell).join(","));
    const csv = head.join(",") + "\n" + rows.join("\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="registro-consensi.csv"',
      },
    });
  }

  // ---- HTML ----
  // conteggi: dalla chiave (immediati); se nell'intervallo ci sono consensi vecchi non ancora aggiornati → "—"
  let nAna, nAds, statKnown;
  if (q) {
    nAna = filtered.filter((r) => r.consent?.analytics).length;
    nAds = filtered.filter((r) => r.consent?.ads).length;
    statKnown = !incomplete;
  } else {
    statKnown = ranged.every((e) => e.flags);
    nAna = ranged.filter((e) => e.flags?.analytics).length;
    nAds = ranged.filter((e) => e.flags?.ads).length;
  }
  const tokenQS = token ? `token=${encodeURIComponent(token)}&` : "";
  const filterQS = `${from ? `from=${from}&` : ""}${to ? `to=${to}&` : ""}${q ? `q=${encodeURIComponent(q)}&` : ""}`;
  const expBase = `?${tokenQS}${filterQS}`;
  const hiddenToken = token ? `<input type="hidden" name="token" value="${esc(token)}">` : "";

  const toFix = legacy.length + stale.length;
  const anonDone = url.searchParams.has("anon") ? parseInt(url.searchParams.get("anon"), 10) || 0 : null;
  const anonNote = toFix > 0
    ? `<form class="note" id="anonForm" method="post" action="" onsubmit="return confirm('Anonimizzare gli IP dei consensi registrati in precedenza? Operazione non reversibile.')">
         <input type="hidden" name="action" value="anonymize-legacy">
         ${anonDone !== null ? `Aggiornati <b>${anonDone}</b> consensi in questo passaggio. ` : ""}<b>${toFix}</b> consensi registrati prima dell'aggiornamento contengono ancora l'IP completo.
         <button type="submit" class="anonbtn">${anonDone !== null ? "Continua" : "Anonimizza ora"}</button>
         ${anonDone !== null ? `<span class="auto"> — prosegue in automatico…</span><script>setTimeout(function(){document.getElementById('anonForm').submit()},1200)</script>` : ""}
       </form>`
    : anonDone !== null
      ? `<div class="note ok">Fatto: tutti i consensi registrati in precedenza sono stati anonimizzati.</div>`
      : "";
  const searchNote = q && incomplete
    ? `<div class="note">La ricerca è stata eseguita sui ${loaded.length} consensi più recenti dell'intervallo: per cercare in quelli più vecchi restringi le date.</div>`
    : "";

  const filtered_note = totalFiltered > shown.length
    ? `<div class="note">Mostrati i primi <b>${shown.length}</b> di <b>${totalFiltered}</b> risultati. Restringi con i filtri per vedere gli altri, oppure esporta in CSV.</div>`
    : "";

  const rowsHtml = shown.map((r) => `<tr>
      <td>${esc(fmtDate(r.ts))}</td>
      <td class="mono">${esc(r.id)}</td>
      <td class="c">${badge(r.consent?.analytics)}</td>
      <td class="c">${badge(r.consent?.ads)}</td>
      <td class="c">${esc(r.version)}</td>
      <td>${esc(r.page)}</td>
      <td>${esc(r.lang)}</td>
      <td class="mono">${esc(r.ip)}</td>
      <td class="ua">${esc(r.userAgent)}</td>
    </tr>`).join("");

  const resetHref = token ? `?token=${encodeURIComponent(token)}` : "?";

  return html(
    `<div class="top">
       <div><h1>Registro consensi cookie</h1><p class="sub">Studio Fisiomasia · prova dei consensi raccolti dal sito.</p></div>
       <a class="logout" href="/.netlify/functions/auth-logout">Esci</a>
     </div>
     <div class="cards">
       <div class="card"><div class="n">${totalFiltered}</div><div class="l">Consensi ${from || to || q ? "(filtrati)" : "totali"}</div></div>
       <div class="card"><div class="n">${statKnown ? nAna : "—"}</div><div class="l">Con Google Ads</div></div>
       <div class="card"><div class="n">${statKnown ? nAds : "—"}</div><div class="l">Con mappa Google</div></div>
     </div>
     <form class="filters" method="get" action="">
       ${hiddenToken}
       <div class="fg"><label>Dal</label><input type="date" name="from" value="${esc(from)}"></div>
       <div class="fg"><label>Al</label><input type="date" name="to" value="${esc(to)}"></div>
       <div class="fg grow"><label>Cerca (ID, pagina, IP, browser…)</label><input type="text" name="q" value="${esc(q)}" placeholder="testo da cercare"></div>
       <div class="fg"><label>&nbsp;</label><button type="submit">Filtra</button></div>
       <div class="fg"><label>&nbsp;</label><a class="reset" href="${resetHref}">Azzera</a></div>
     </form>
     <div class="exp">
       Esporta ${from || to || q ? "(con i filtri attivi)" : "tutto"}:
       <a href="${expBase}format=csv">CSV</a> · <a href="${expBase}format=json">JSON</a>
     </div>
     ${anonNote}
     ${searchNote}
     ${filtered_note}
     <div class="tw">
     <table>
       <thead><tr>
         <th>Data e ora</th><th>ID consenso</th><th>Google Ads</th><th>Mappa Google</th>
         <th>Vers.</th><th>Pagina</th><th>Lingua</th><th>IP (anonim.)</th><th>Browser</th>
       </tr></thead>
       <tbody>${rowsHtml || `<tr><td colspan="9" class="empty">Nessun consenso per i filtri selezionati.</td></tr>`}</tbody>
     </table>
     </div>`,
    200
  );
};

/* ---------- sessione ---------- */
function secret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || process.env.CONSENT_ADMIN_TOKEN || "";
}
function verifySession(val) {
  if (!val || !secret()) return null;
  const i = val.lastIndexOf(".");
  if (i < 1) return null;
  const payload = val.slice(0, i), sig = val.slice(i + 1);
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { e, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!exp || Date.now() > exp) return null;
    return { email: e };
  } catch { return null; }
}
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

/* ---------- accesso veloce allo store ---------- */
// chiave nuova: <ts>__<id>__s<0|1>m<0|1>   ·   chiave vecchia: <ts>__<id>
function parseKey(key) {
  const i = key.indexOf("__");
  if (i < 0) return { key, ts: "", id: key, flags: null };
  const ts = key.slice(0, i);
  let id = key.slice(i + 2), flags = null;
  const m = id.match(/__s([01])m([01])$/);
  if (m) { flags = { analytics: m[1] === "1", ads: m[2] === "1" }; id = id.slice(0, -m[0].length); }
  return { key, ts, id, flags };
}
// se un aggiornamento si è interrotto a metà può esistere sia la copia vecchia sia la nuova: tengo la nuova
function dedupe(list) {
  const map = new Map(), stale = [];
  for (const e of list) {
    const k = e.ts + "__" + e.id, prev = map.get(k);
    if (!prev) map.set(k, e);
    else if (!prev.flags && e.flags) { stale.push(prev); map.set(k, e); }
    else if (!e.flags) stale.push(e);
    else map.set(k + "#" + e.key, e);
  }
  return { entries: [...map.values()], stale };
}
// esegue fn su items con N richieste in parallelo; si ferma (senza errori) alla scadenza
async function pool(items, concurrency, deadline, fn) {
  let i = 0, timedOut = false;
  const worker = async () => {
    while (i < items.length) {
      if (Date.now() > deadline) { timedOut = true; return; }
      const it = items[i++];
      try { await fn(it); } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return timedOut;
}
async function fetchAll(store, entries, concurrency, deadline) {
  const out = new Array(entries.length);
  const timedOut = await pool(entries.map((_, k) => k), concurrency, deadline, async (k) => {
    out[k] = await store.get(entries[k].key, { type: "json" });
  });
  return { results: out, timedOut };
}

/* ---------- anonimizzazione IP (stesso criterio della function consent-log) ---------- */
function anonIp(raw) {
  const ip = String(raw || "").trim().split("%")[0];
  if (!ip) return "";
  const v4 = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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

/* ---------- helper render ---------- */
function badge(v) { return v ? `<span class="b yes">sì</span>` : `<span class="b no">no</span>`; }
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("it-IT", {
      dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Rome",
    });
  } catch { return iso; }
}
function esc(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
function html(inner, status = 200) {
  const doc = `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Registro consensi · Studio Fisiomasia</title>
  <style>
    :root{--ink:#242017;--wine:#8A6B50;--bone:#F2E7D8;--soft:#6B5E4F;--line:rgba(36,32,23,.14)}
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:#faf7f2;padding:28px}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
    h1{font-size:1.5rem;margin:0 0 4px}
    .sub{color:var(--soft);margin:0 0 20px}
    .logout{flex:none;color:var(--wine);text-decoration:none;font-weight:600;font-size:.85rem;border:1px solid var(--line);border-radius:8px;padding:8px 14px;background:#fff}
    .logout:hover{background:#f3ece1}
    .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
    .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-width:150px}
    .card .n{font-size:1.7rem;font-weight:700}
    .card .l{color:var(--soft);font-size:.85rem}
    .filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
    .fg{display:flex;flex-direction:column;gap:5px}
    .fg.grow{flex:1;min-width:200px}
    .fg label{font-size:.72rem;color:var(--soft);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    .fg input{padding:9px 11px;border:1px solid var(--line);border-radius:8px;font-size:.9rem;background:#fdfbf8;color:var(--ink)}
    .fg input:focus{outline:none;border-color:var(--wine);background:#fff}
    .filters button{padding:9px 18px;border:0;border-radius:8px;background:var(--ink);color:#f5ede4;font-weight:600;cursor:pointer;font-size:.9rem}
    .filters button:hover{background:#332c20}
    .reset{display:inline-block;padding:9px 14px;border:1px solid var(--line);border-radius:8px;color:var(--soft);text-decoration:none;font-size:.9rem;background:#fff}
    .reset:hover{color:var(--wine)}
    .exp{margin-bottom:12px;font-size:.9rem;color:var(--soft)}
    .exp a{color:var(--wine);font-weight:600;text-decoration:none;margin:0 2px}
    .note{background:#fbf3e4;border:1px solid #ecd9b6;color:#7a5c2e;border-radius:10px;padding:10px 14px;font-size:.85rem;margin-bottom:14px}
    .note.ok{background:#e6efe6;border-color:#bcd6bc;color:#2c6b3c}
    .anonbtn{margin-left:10px;padding:6px 14px;border:0;border-radius:7px;background:var(--ink);color:#f5ede4;font-weight:600;cursor:pointer;font-size:.85rem}
    .anonbtn:hover{background:#332c20}
    .tw{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
    th{background:#f3ece1;font-weight:700;position:sticky;top:0}
    td.ua{white-space:normal;max-width:280px;color:var(--soft)}
    .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8rem}
    .c{text-align:center}
    .b{display:inline-block;padding:2px 9px;border-radius:20px;font-size:.75rem;font-weight:700}
    .b.yes{background:#e2efe4;color:#1c6b38}
    .b.no{background:#efe6da;color:#8a6b50}
    .empty{text-align:center;color:var(--soft);padding:28px}
  </style></head><body>${inner}</body></html>`;
  return new Response(doc, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
