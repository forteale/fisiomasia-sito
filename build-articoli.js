// build-articoli.js
// Converte i file *.html generati dal CMS in articoli/index.json
// Eseguito da Netlify a ogni deploy automaticamente

const fs = require('fs');
const path = require('path');

const ARTICOLI_DIR = './articoli';
const OUTPUT_FILE = './articoli/index.json';

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;
  const fm = {};
  match[1].split('\n').forEach(line => {
    const [k, ...rest] = line.split(':');
    if (k && rest.length) {
      let v = rest.join(':').trim();
      // Togli virgolette se presenti
      v = v.replace(/^["']|["']$/g, '');
      fm[k.trim()] = v;
    }
  });
  return { meta: fm, body: match[2].trim() };
}

// Conversione minima Markdown → HTML (le cose essenziali)
function md2html(md) {
  let h = md;
  // Headings
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold + italic
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Liste
  h = h.replace(/(^- .+(\n- .+)*)/gm, m => {
    const items = m.split('\n').map(l => '<li>' + l.replace(/^- /, '') + '</li>').join('');
    return '<ul>' + items + '</ul>';
  });
  // Paragrafi
  h = h.split(/\n\n+/).map(p => {
    if (p.match(/^<(h[123]|ul|ol|p|div)/)) return p;
    return p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '';
  }).join('');
  return h;
}

function generateSlug(title) {
  return title.toLowerCase()
    .replace(/[àáâã]/g, 'a').replace(/[èéê]/g, 'e').replace(/[ìí]/g, 'i')
    .replace(/[òóôõ]/g, 'o').replace(/[ùú]/g, 'u').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function build() {
  if (!fs.existsSync(ARTICOLI_DIR)) {
    console.log('Cartella articoli/ non trovata, creo index.json vuoto');
    fs.writeFileSync(OUTPUT_FILE, '[]');
    return;
  }

  const files = fs.readdirSync(ARTICOLI_DIR).filter(f => f.endsWith('.html') && f !== 'index.json');
  const articoli = [];
  let nextId = 1;

  files.forEach(file => {
    const raw = fs.readFileSync(path.join(ARTICOLI_DIR, file), 'utf8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return;

    const meta = parsed.meta;
    if (!meta.title) return;

    const slug = file.replace(/\.html$/, '');
    const articolo = {
      id: nextId++,
      slug: slug,
      title: meta.title,
      cat: meta.cat || 'News',
      date: meta.date || new Date().toISOString().slice(0, 10),
      image: meta.image || '',
      excerpt: meta.excerpt || '',
      content: md2html(parsed.body)
    };
    articoli.push(articolo);
  });

  // Ordina dal più recente al meno recente
  articoli.sort((a, b) => new Date(b.date) - new Date(a.date));
  // Riassegna id in ordine
  articoli.forEach((a, i) => a.id = i + 1);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(articoli, null, 2));
  console.log(`✓ Generati ${articoli.length} articoli in ${OUTPUT_FILE}`);
}

build();
