// generate.mjs — NoveC SEO Blog
//
// Replica in un singolo script Node del workflow n8n "NoveC SEO Blog - v2"
// (vedi `n8nesistente`). Gira da GitHub Actions una volta a settimana e crea
// un articolo con publish PROGRAMMATO (status: future) su WordPress: va online
// da solo a meta' mattina, con finestra di veto per Daniel. Mai publish immediato.
//
// MVP1:   7 nodi n8n replicati, MENO la notifica email (-> MVP2).
// MVP1.1: lista argomenti editabile in topics.json (C1) + override one-off
//         in next.json, consumato e svuotato dopo il run (C2).
// MVP3:   output strutturato (tool use) + garanzie SEO titolo/meta + retry HTTP.
// MVP4/B1: immagine in evidenza generata (OpenAI) + upload su WP con alt text.
// MVP4/B2: link interni REALI: articoli WP pubblicati e pertinenti al topic
//          proposti a Claude al posto dei 2 link fissi (fallback sui fissi).
// A4:      anti-doppioni: un topic gia' online (anche se la rotazione non lo
//          sa, es. pubblicato via override) viene saltato e segnato in rotazione.
// D1:      registro storico: una riga per articolo in ops/articles.csv
//          (committato dal workflow) + riepilogo nel summary della Action.
// Stack: solo `fetch` nativo (Node 20+), nessuna dipendenza npm.
//
// Segreti letti da env (GitHub Secrets):
//   ANTHROPIC_API_KEY, BRAVE_API_KEY, WP_USER, WP_APP_PASSWORD
//   OPENAI_API_KEY (opzionale: se manca, immagine saltata, articolo comunque ok)

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOPICS_PATH = join(ROOT, "topics.json");
const NEXT_PATH = join(ROOT, "next.json");
const ROTATION_STATE_PATH = join(ROOT, "ops", "rotation-state.json");

const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const BRAVE_API_KEY = requireEnv("BRAVE_API_KEY");
const WP_USER = requireEnv("WP_USER");
const WP_APP_PASSWORD = requireEnv("WP_APP_PASSWORD");

const WP_BASE = "https://nove-c.com";
// User-Agent da browser reale sulle chiamate a WP: l'anti-bot di SiteGround
// (sgcaptcha) sfida gli UA "sospetti" (il default di Node). Accesso legittimo
// e autenticato al nostro sito; riduce i falsi positivi del WAF sull'API REST.
const WP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const MODEL = "claude-sonnet-4-6";
// Template del post (Attributi articolo -> Template = "Blog Post (Nuovo)").
// Valore = filename del template come esposto dalla REST API WP.
const WP_POST_TEMPLATE = "single-blog-nuovo.php";
// Immagine in evidenza fallback (ID media WP) se la generazione fallisce.
const FEATURED_MEDIA_FALLBACK = 5026;

// MVP4/B1 — immagine in evidenza generata (OpenAI). Non bloccante: se manca la
// key o fallisce, l'articolo esce lo stesso con l'immagine fallback.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const IMAGE_QUALITY = "medium"; // resa/costo bilanciati per un articolo/settimana
// Stile fotografico costante: dà realismo e coerenza. Il SOGGETTO/registro lo
// sceglie Claude (brief_immagine); qui fissiamo COME va fotografato.
const STILE_IMMAGINE =
  "Fotografia editoriale fotorealistica, reflex full-frame 35mm, obiettivo 50mm f/1.8, luce naturale morbida, profondita di campo ridotta, momento candido e non in posa, leggera grana pellicola, texture e imperfezioni realistiche, atmosfera italiana calda e autentica. Niente testo, loghi o watermark. Le persone vanno riprese di spalle o di tre quarti da dietro, a media o lunga distanza, mai frontali ne ravvicinate; nelle scene di lavoro inquadratura ampia sull'ambiente e sul gesto.";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Manca il secret ${name}. Configuralo in Settings -> Secrets -> Actions.`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + parse JSON robusto: ritenta sui glitch transitori (5xx, 429, o body
// non-JSON tipo pagina HTML di cache/WAF), ed esce con errore CHIARO sul resto.
async function fetchJson(url, options, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      lastErr = new Error(`${label}: errore di rete (${e.message})`);
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      lastErr = new Error(`${label} ha risposto ${res.status}: ${text.slice(0, 300)}`);
      if (res.status >= 500 || res.status === 429) { await sleep(2000 * attempt); continue; }
      throw lastErr; // 4xx: errore reale, inutile ritentare
    }
    try {
      return JSON.parse(text);
    } catch {
      // status 2xx ma body non-JSON (es. pagina HTML transitoria): ritenta
      lastErr = new Error(`${label}: risposta non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Slug da una frase: minuscolo, senza accenti/punteggiatura, trattini.
// ---------------------------------------------------------------------------
function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 60)
    .replace(/-+$/, "");
}

// Accorcia lo slug (URL) tagliando su confine di parola. Preserva il piu
// possibile la focus keyword (che di solito e in testa allo slug).
function shortenSlug(s, max = 60) {
  s = (s || "").toLowerCase().replace(/-+$/, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

// Data di pubblicazione programmata (publish differito con finestra di veto).
// Prossime 09:00 UTC (~10-11 ora italiana) ad almeno 4h da ora: il job gira
// lunedi notte -> l'articolo va live lunedi tarda mattina, e Daniel ha la
// mattinata per cestinarlo se sbagliato. Ritorna ISO senza millisecondi.
function scheduledPublishGmt() {
  const now = new Date();
  let target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  if (target.getTime() - now.getTime() < 4 * 3600 * 1000) {
    target = new Date(target.getTime() + 24 * 3600 * 1000);
  }
  return target.toISOString().replace(/\.\d{3}Z$/, "");
}

// Legge l'override one-off da next.json. Ritorna null se assente o senza titolo.
function readOverride() {
  try {
    const ov = JSON.parse(readFileSync(NEXT_PATH, "utf8"));
    if (ov && typeof ov.titolo === "string" && ov.titolo.trim()) return ov;
  } catch {
    // next.json mancante o malformato -> nessun override
  }
  return null;
}

// Svuota next.json dopo aver consumato l'override (preserva le note di aiuto).
function clearOverride() {
  const stub = {
    _leggimi:
      "Compila i 4 campi sotto per forzare UN articolo specifico (es. una novità), poi committa su main: parte un run con quel titolo. A run riuscito il file si SVUOTA da solo e torna la rotazione. Lascia 'titolo' vuoto = rotazione normale. Le righe che iniziano con _ sono solo note di aiuto: non vengono lette dallo script, non toccarle.",
    titolo: "",
    _aiuto_titolo:
      "Titolo H1 dell'articolo. Metti la parola chiave + una power word italiana di Rank Math usata ESATTAMENTE (invariabile): essenziale, efficace, indispensabile, incredibile, irresistibile, impeccabile. Se vuoi l'anno nel titolo (serve di rado, solo dove aggiunge valore) scrivi {{year}}: diventa l'anno corrente. Es: Elettrificazione dei Carichi con Pompa di Calore: Guida Essenziale",
    focus_keyword: "",
    _aiuto_focus_keyword:
      "La frase chiave SEO esatta, 2-4 parole, quella per cui vuoi posizionarti su Google. Es: elettrificazione dei carichi",
    brief: "",
    _aiuto_brief:
      "Il taglio/tesi dell'articolo in 2-4 frasi: cosa deve sostenere e quali punti toccare. Piu sei specifico, meglio scrive Claude.",
    stile: "",
    _aiuto_stile:
      "Schema del testo. Valori possibili: problem-solution (problema -> soluzione) | how-to-guide (guida a step operativi) | faq-driven (tutto domande e risposte) | numbers-first (costruito su numeri/bollette/cifre) | comparison (confronti X vs Y). Vuoto = problem-solution."
  };
  writeFileSync(NEXT_PATH, JSON.stringify(stub, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Rotazione TRACCIATA: stato in ops/rotation-state.json (slug -> data ultimo uso),
// ri-committato su main dal workflow. Identita' per SLUG (stabile): riordinare,
// aggiungere o rimuovere topic non corrompe la traccia. Sostituisce la vecchia
// rotazione cieca `weekNumber % len` che ripeteva le keyword (cannibalizzazione SEO).
// ---------------------------------------------------------------------------
const ROTATION_README =
  "Stato rotazione: quando ogni argomento e' stato pubblicato. Gestito dallo script, NON modificare a mano. Per scegliere il prossimo, riordina topics.json (il primo non ancora usato e' il prossimo).";

function readRotationState() {
  try {
    const s = JSON.parse(readFileSync(ROTATION_STATE_PATH, "utf8"));
    if (s && typeof s === "object" && s.usati && typeof s.usati === "object") {
      return { usati: s.usati };
    }
  } catch {
    // file assente o malformato -> stato vuoto (primo run: tutti unused)
  }
  return { usati: {} };
}

function writeRotationState(state) {
  const out = { _leggimi: ROTATION_README, usati: state.usati || {} };
  writeFileSync(ROTATION_STATE_PATH, JSON.stringify(out, null, 2) + "\n");
}

// Sceglie il topic: primo in ordine di lista il cui slug NON e' ancora usato.
// A4: un topic non-usato ma GIA' online (gemello live trovato, es. pubblicato
// via override che non tocca la rotazione) viene saltato e raccolto in
// `doppioni` (a fine run verra' segnato in rotazione con la data del pezzo
// live, cosi' lo stato si auto-ripara e il salto non si ripete). Con posts
// null (lettura fallita) il controllo doppioni e' saltato: run come prima.
// Se sono tutti usati -> LRU (data piu' vecchia; tie-break: ordine di lista) e
// segnala esaurito=true. Slug orfani (topic rimossi) sono ignorati: iteriamo
// solo la lista corrente.
function pickTopic(topics, state, posts) {
  const usati = state.usati || {};
  const doppioni = [];
  for (const t of topics) {
    if (t.slug in usati) continue;
    const twin = posts ? findLiveTwin(posts, t) : null;
    if (twin) {
      doppioni.push({ slug: t.slug, date: (twin.date || "").slice(0, 10), link: twin.link });
      continue;
    }
    return { topic: { ...t }, esaurito: false, doppioni };
  }
  // Esauriti (o rimasti solo doppioni): LRU sulla data effettiva, contando i
  // doppioni appena trovati con la data del loro pezzo live.
  const eff = { ...usati };
  for (const d of doppioni) eff[d.slug] = d.date || new Date().toISOString().slice(0, 10);
  let best = null;
  for (const t of topics) {
    const dd = eff[t.slug] || "";
    if (best === null || dd < best.date) best = { topic: t, date: dd };
  }
  return { topic: { ...best.topic }, esaurito: true, doppioni };
}

// ---------------------------------------------------------------------------
// NODO: "Code in JavaScript - Topic" — selezione topic tracciata + stile.
// MVP1.1: topic/stile letti da topics.json; se next.json ha un titolo, quello
//         vince (override one-off, FUORI rotazione: non tocca lo stato).
// Feature rotazione tracciata: il TOPIC e' il primo non-usato (vedi pickTopic);
//         lo STILE resta su `weekNumber % stili.length` (la ripetizione di stile
//         non crea cannibalizzazione, quindi non si traccia).
// ---------------------------------------------------------------------------
function selectTopic(posts) {
  const data = JSON.parse(readFileSync(TOPICS_PATH, "utf8"));
  const topics = data.topics;
  const stili = data.stili;

  const now = new Date();
  const year = now.getFullYear();
  const weekNumber = Math.floor((now - new Date(year, 0, 1)) / (7 * 24 * 60 * 60 * 1000));
  const today = now.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });

  const ov = readOverride();
  if (ov) {
    const focusKeyword = (ov.focus_keyword || "").trim() || ov.titolo.trim();
    const topic = {
      slug: slugify(focusKeyword),
      focusKeyword,
      title: ov.titolo.replace("{{year}}", year).trim(),
      angle: (ov.brief || "").trim() || `Approfondimento specifico richiesto dalla redazione: ${ov.titolo.trim()}`
    };
    const template =
      stili.find((s) => s.name === (ov.stile || "").trim()) || stili[0];
    return { topic, template, year, weekNumber, today, override: true };
  }

  const state = readRotationState();
  const { topic, esaurito, doppioni } = pickTopic(topics, state, posts);
  const template = stili[weekNumber % stili.length];
  topic.title = topic.title.replace("{{year}}", year);
  return { topic, template, year, weekNumber, today, override: false, state, esaurito, doppioni };
}

// ---------------------------------------------------------------------------
// NODO: "HTTP Request" — Brave Search per contesto aggiornato
// ---------------------------------------------------------------------------
async function braveSearch(topic, year) {
  const params = new URLSearchParams({
    q: `${topic.focusKeyword} ${year} GSE normativa aggiornamenti`,
    count: "5",
    country: "IT",
    search_lang: "it",
    freshness: "pm"
  });
  return await fetchJson(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    { headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY } },
    "Brave Search"
  );
}

// ---------------------------------------------------------------------------
// B2 + A4 — una sola lettura del blog (WP REST, categoria 3) alimenta due cose:
//   B2: i link interni REALI (articoli pertinenti proposti a Claude al posto
//       dei 2 link fissi; fallback sui fissi se la GET fallisce o <2 candidati);
//   A4: l'anti-doppioni (un topic gia' online viene saltato e segnato in
//       rotazione, anche se la rotazione non lo sapeva, es. da override).
// Tutto NON bloccante: senza lettura il run procede come prima di B2/A4.
// ---------------------------------------------------------------------------
// Parole vuote per il match di pertinenza: grammaticali + boilerplate dei
// nostri titoli SEO (guida/power word/anno compaiono quasi ovunque e
// creerebbero pertinenza finta tra articoli che non c'entrano nulla).
const RELATED_STOPWORDS = [
  "del", "dello", "della", "dei", "degli", "delle", "dal", "dallo", "dalla",
  "dai", "dagli", "dalle", "nel", "nello", "nella", "nei", "negli", "nelle",
  "sul", "sullo", "sulla", "sui", "sugli", "sulle", "con", "per", "tra", "fra",
  "gli", "una", "uno", "che", "chi", "cosa", "come", "quando", "dove", "quanto",
  "perche", "piu", "meno", "non", "anche", "tutto", "tutti", "tutte", "senza",
  "ecco", "verso", "sono", "essere", "questa", "questo", "questi", "queste",
  "guida", "completa", "completo", "essenziale", "efficace", "indispensabile",
  "incredibile", "irresistibile", "impeccabile", "straordinario", "definitivo",
  "definitiva"
];

// Stemming MINIMO per l'italiano: tronca l'ultima vocale delle parole >=5
// lettere, cosi' singolare/plurale/genere collassano sullo stesso token
// (piscina/piscine -> piscin, pompa/pompe -> pomp, risparmio/risparmia ->
// risparmi). Senza questo il gemello "piscina" di un topic "piscine" sfugge.
function stemToken(w) {
  return w.length >= 5 ? w.replace(/[aeiou]$/, "") : w;
}
const RELATED_STOP_STEMS = new Set(RELATED_STOPWORDS.map(stemToken));

// Token "significativi" di una frase, gia' stemmati: minuscolo, senza accenti,
// niente stopword, niente numeri puri (l'anno nei titoli non e' un tema).
function relatedTokens(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .map(stemToken)
    .filter((w) => !RELATED_STOP_STEMS.has(w));
}

// "Stesso argomento" tra slug candidato e slug del topic. Lo slug pubblicato
// differisce spesso da quello del topic (riscritture di Claude, "con-la" in
// mezzo, suffissi -2/-5 di WP): il match esatto non basta, confrontiamo gli
// INSIEMI di token significativi (uguali o contenuti -> stesso argomento).
function sameTopicSlug(candSlug, topicSlug) {
  const a = new Set(relatedTokens(candSlug));
  const b = new Set(relatedTokens(topicSlug));
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((w) => big.has(w));
}

// Il post live p e' il "gemello" del topic in creazione? Tre segnali:
//   1) slug con gli stessi token (vedi sameTopicSlug);
//   2) titolo identico;
//   3) titolo che INIZIA con la focus keyword del topic (i nostri titoli SEO
//      sono keyword-led: se un pezzo live apre con la stessa keyword, compete
//      sulla stessa SERP anche se il resto del titolo e' diverso).
// Usato sia da A4 (salta il topic) sia da B2 (mai proporre il gemello come
// link correlato, caso LRU dove il topic si ripubblica apposta).
function isTopicTwin(p, topic) {
  if (sameTopicSlug(p.slug, topic.slug)) return true;
  if ((p.title || "").toLowerCase() === (topic.title || "").toLowerCase()) return true;
  const fk = relatedTokens(topic.focusKeyword);
  if (fk.length >= 2) {
    const tt = relatedTokens(p.title);
    if (fk.every((w, i) => tt[i] === w)) return true;
  }
  return false;
}

function findLiveTwin(posts, topic) {
  return (posts || []).find((p) => isTopicTwin(p, topic)) || null;
}

// I titoli WP arrivano con entita' HTML (es. &#8217;): decodifica minima.
function decodeEntities(s) {
  return (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

// Legge gli articoli pubblicati del blog (lettura pubblica: niente auth, meno
// modi di fallire) e li normalizza in {title, link, slug, date}.
async function fetchPublishedPosts() {
  const params = new URLSearchParams({
    categories: "3",
    // 1 articolo/settimana: 100 copre ~2 anni di storico in una chiamata.
    // Quando il blog li supera, servira' la paginazione (dolore futuro, §13).
    per_page: "100",
    status: "publish",
    _fields: "title,link,slug,date"
  });
  const posts = await fetchJson(
    `${WP_BASE}/wp-json/wp/v2/posts?${params}`,
    { headers: { "Accept": "application/json", "User-Agent": WP_UA } },
    "WordPress (articoli live)"
  );
  if (!Array.isArray(posts)) throw new Error("WordPress (articoli live): risposta inattesa");
  return posts
    .map((p) => ({
      title: decodeEntities((p.title && p.title.rendered) || "").trim(),
      link: p.link || "",
      slug: p.slug || "",
      date: p.date || ""
    }))
    .filter((p) => p.title && p.link);
}

// B2 — sceglie i 5 articoli live piu' pertinenti come {title, link}.
// Pertinenza = token in comune tra keyword+titolo del topic e titolo+slug del
// candidato; il gemello del topic e' escluso (caso LRU: si ripubblica apposta).
// A parita' di punteggio vince il piu' recente (WP ordina per data, sort stabile).
function pickRelatedPosts(posts, topic) {
  const topicToks = new Set([...relatedTokens(topic.focusKeyword), ...relatedTokens(topic.title)]);
  const scored = [];
  for (const p of posts) {
    if (isTopicTwin(p, topic)) continue;
    const score = relatedTokens(`${p.title} ${p.slug}`).filter((w) => topicToks.has(w)).length;
    if (score >= 1) scored.push({ title: p.title, link: p.link, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ title, link }) => ({ title, link }));
}

// ---------------------------------------------------------------------------
// NODO: "Message a model" — generazione articolo con Claude
// ---------------------------------------------------------------------------
function buildPrompt(ctx, braveResults, related = []) {
  const t = ctx.topic;
  // B2: se abbiamo articoli correlati reali, i link interni si scelgono da li'
  // (2-3 contestuali nel corpo); altrimenti restano i 2 link fissi storici.
  const internalLinksRule = related.length >= 2
    ? `- LINK INTERNI OBBLIGATORI: inserisci ${related.length >= 3 ? "2-3" : "2"} link interni contestuali nel corpo dell'articolo scegliendo SOLO tra questi articoli correlati gia' pubblicati sul blog Nove C. Usa l'URL ESATTO cosi' com'e' (non inventare altri URL), ancora ogni link a un testo naturale e pertinente al punto in cui compare, e distribuiscili in sezioni diverse dell'articolo:
${related.map((r) => `  * "${r.title}" -> ${r.link}`).join("\n")}`
    : `- LINK INTERNI: inserisci almeno 2 link interni a pagine Nove C. Usa: <a href="https://nove-c.com/soluzioni/conto-termico-3-0-incentivi-fino-al-65-senza-anticipo/">scopri il servizio Conto Termico 3.0 di Nove C</a> e <a href="https://nove-c.com/chi-siamo/">Nove C Ingegneria ESCo certificata</a>`;
  return `[ISTRUZIONI DI SISTEMA]
Sei un SEO copywriter esperto di efficienza energetica e incentivi per il residenziale per Nove C Ingegneria, ESCo certificata UNI CEI 11352 ed EPC Contractor. Il blog copre pompe di calore, fotovoltaico, autoconsumo (collettivo e comunita' energetiche/CER), riqualificazione energetica e i relativi incentivi. REGOLA INCENTIVI: se l'argomento riguarda POMPE DI CALORE o generazione termica, il riferimento e il Conto Termico 3.0 (D.M. 7 agosto 2025, MAI il 2.0 superato) con interpretazione restrittiva della normativa; se riguarda FOTOVOLTAICO, autoconsumo, CER o altri temi, usa il quadro incentivante PERTINENTE (incentivi GSE su autoconsumo/CER, detrazioni, bandi regionali/fondi dove rilevanti) e NON forzare il Conto Termico. Non citare anni precedenti come attuali. Output JSON stretto, nessun testo extra. Privilegia l'ambito Privati (appartamenti, ville e condomini). TAGLIO PRO-VENDITA: questo blog SUPPORTA LA VENDITA dei servizi di Nove C, non e' divulgazione neutra. Aggancia il lettore a leve concrete (risparmio in euro, aumento del valore dell'immobile, urgenza di incentivi o novita' normative) e conducilo all'azione (contatto/sopralluogo Nove C). Deve restare tecnicamente corretto e credibile: niente allarmismo gratuito, promesse false o dati inventati; se un dato (percentuali, tassi, importi) non e' certo, resta sull'ordine di grandezza senza spacciarlo per preciso.

[TASK]
Oggi e ${ctx.today}.

Argomento: ${t.angle}
Focus keyword: ${t.focusKeyword}
Titolo H1 proposto: ${t.title}
Template strutturale: ${ctx.template.name}
Struttura: ${ctx.template.structure}
Tono: ${ctx.template.tone}

Ricerca Brave (usa SOLO per contesto aggiornato, NON copiare):
${JSON.stringify(braveResults)}

Scrivi un articolo di 1500-2000 parole in HTML puro (solo tag ammessi: p, h2, strong, em, ul, li, a). Negli attributi HTML usa pure le normali virgolette doppie (es: <a href="https://url">): l'output passa da un tool strutturato, quindi non ci sono problemi di escaping.

PARAGRAFI BREVI (importante per Rank Math): ogni <p> deve essere corto, MASSIMO 3-4 frasi e comunque MAI oltre ~110 parole. Spezza i blocchi lunghi in piu' <p> separati. I muri di testo abbassano il punteggio di leggibilita'.

Requisiti SEO TASSATIVI:
- Focus keyword ESATTA "${t.focusKeyword}" nel primo paragrafo (primi 100 caratteri)
- Focus keyword in almeno 2 H2 su 5-6 totali
- DENSITA FOCUS KEYWORD: la focus keyword esatta deve comparire almeno 16-22 volte nel testo (target circa 1.0-1.5%). Ripetila naturalmente in ogni sezione (intro, ogni H2, FAQ, conclusione). Questo e CRITICO per il punteggio Rank Math: non scendere sotto le 16 occorrenze.
- Almeno 4 H2 distinte
- 1 H2 "Domande frequenti" con 4-5 Q&A in <p><strong>...</strong></p>
- LINK ESTERNI OBBLIGATORI: inserisci almeno 2 link esterni dofollow a fonti istituzionali autorevoli. Usa <a href="URL">testo ancora</a> (SENZA rel="nofollow"). Fonti consigliate: https://www.gse.it (Portale GSE Conto Termico), https://www.mase.gov.it (Ministero Ambiente), https://www.gazzettaufficiale.it (Gazzetta Ufficiale per D.M.). Esempio: <a href="https://www.gse.it/servizi-per-te/conto-termico">portale Conto Termico del GSE</a>
${internalLinksRule}
- CTA finale con riferimento a Nove C Ingegneria ESCo certificata e link alla pagina servizio
- Cita le fonti normative PERTINENTI all'argomento: per pompe di calore/termico il D.M. 7 agosto 2025 (Conto Termico 3.0) e lo stato del Portaltermico GSE; per fotovoltaico/autoconsumo/CER i provvedimenti GSE pertinenti. Non forzare riferimenti non attinenti al tema.
- NON citare anni precedenti all'anno corrente come "attuali"
- ANNO NEI TITOLI E NELLO SLUG: NON aggiungere l'anno corrente al titolo, al titolo SEO, alla meta description o allo slug, A MENO CHE l'anno non sia gia' nel Titolo H1 proposto qui sopra. Essere aggiornati vale per i CONTENUTI (normativa, cifre, riferimenti), non per l'etichetta dell'anno: "Guida ${ctx.year}" ripetuto su ogni articolo del blog e' un pattern da evitare.
- TITOLO SEO (campo titolo_seo): deve INIZIARE con la focus keyword esatta "${t.focusKeyword}" e contenere una "power word" italiana riconosciuta da Rank Math. USA ESATTAMENTE una di queste (invariabili, valgono per maschile e femminile, NON declinarle): essenziale, efficace, indispensabile, incredibile, irresistibile, impeccabile, straordinario, definitivo. Esempio: "${t.focusKeyword}: Guida Essenziale".
- META DESCRIPTION (campo meta_description): 150-160 caratteri e DEVE contenere la focus keyword esatta "${t.focusKeyword}", preferibilmente all'inizio.
- SLUG: deve contenere la focus keyword completa separata da trattini, max 60 caratteri, senza anno (le URL evergreen invecchiano meglio)
- IMMAGINE IN EVIDENZA (campo brief_immagine): descrivi in 1-2 frasi la SCENA ideale per l'immagine di QUESTO articolo.
  REGOLA PRINCIPALE: il soggetto e' il TEMA CONCRETO dell'articolo, non il mestiere di chi installa. Esempi: articolo sulle piscine -> la piscina (acqua, vapore, corsie); su villa o condominio -> l'edificio; su risparmio/bollette/comfort -> l'interno di casa vissuto, caldo e accogliente; su fotovoltaico/autoconsumo -> il tetto con i pannelli; sul prodotto o la configurazione -> la pompa di calore ben fotografata nel suo contesto, senza persone.
  VIETATO il tecnico/installatore al lavoro su una pompa di calore, A MENO CHE l'articolo non parli proprio di installazione/cantiere/iter dei lavori: e' un cliche' gia' usato troppe volte su questo blog. Il fatto che l'articolo citi le pompe di calore NON basta per metterci un operaio.
  Persone: facoltative e di contorno, mai il soggetto principale. Orienta la scena all'EMOZIONE e al beneficio per il cliente (comfort, relax, orgoglio della casa), non al tecnicismo. NON descrivere lo stile fotografico (luci, obiettivo, ecc.): a quello pensa il sistema.

Per restituire l'articolo CHIAMA il tool "pubblica_articolo" compilando TUTTI i suoi campi. La focus_keyword deve essere esattamente "${t.focusKeyword}" e l'h1 esattamente "${t.title}". Non scrivere altro testo fuori dal tool.`;
}

async function callClaude(prompt) {
  return await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      // A1: forziamo l'output strutturato via tool use -> niente parsing
      // fragile del testo (addio regex sulle virgolette).
      tools: [
        {
          name: "pubblica_articolo",
          description: "Restituisce l'articolo SEO completo, pronto per la bozza WordPress.",
          input_schema: {
            type: "object",
            properties: {
              titolo_seo: { type: "string", description: "Titolo SEO che INIZIA con la focus keyword esatta e contiene una power word italiana di Rank Math usata ESATTAMENTE (invariabile): essenziale, efficace, indispensabile, incredibile, irresistibile, impeccabile, straordinario, definitivo" },
              focus_keyword: { type: "string", description: "Focus keyword esatta" },
              meta_description: { type: "string", description: "Meta description 150-160 caratteri che CONTIENE la focus keyword esatta, preferibilmente all'inizio" },
              slug: { type: "string", description: "Slug con la focus keyword, max 60 caratteri" },
              estratto: { type: "string", description: "Estratto 120-160 caratteri" },
              h1: { type: "string", description: "Titolo H1" },
              content_html: { type: "string", description: "Corpo dell'articolo in HTML puro (solo tag p, h2, strong, em, ul, li, a)" },
              brief_immagine: { type: "string", description: "Scena per l'immagine in evidenza (1-2 frasi). Soggetto = il tema concreto dell'articolo (piscina, edificio, interno casa, tetto fotovoltaico, prodotto), orientato all'emozione/beneficio. NIENTE tecnico/installatore salvo articoli su installazione/cantiere. NON descrivere lo stile fotografico." }
            },
            required: ["titolo_seo", "focus_keyword", "meta_description", "slug", "estratto", "h1", "content_html", "brief_immagine"]
          }
        }
      ],
      tool_choice: { type: "tool", name: "pubblica_articolo" },
      messages: [{ role: "user", content: prompt }]
    })
  }, "Anthropic");
}

// ---------------------------------------------------------------------------
// Garanzie SEO su titolo e meta (Rank Math). Il modello a volte non mette la
// focus keyword nel titolo SEO / meta: qui lo forziamo in modo deterministico.
// NB: ottimizziamo SOLO il titolo SEO (tag <title>), non il titolo visibile.
// ---------------------------------------------------------------------------
// Lista power word ITALIANE di Rank Math (fonte: rankmath.com/blog/power-words,
// sezione Italian). Rank Math usa una lista interna per lingua: il titolo passa
// il check solo se contiene una parola di QUESTA lista (con la lingua del sito
// WordPress = Italiano). Teniamo la lista allineata a quella o il check resta rosso.
const POWER_WORDS = [
  "abile", "affascinante", "autentico", "avanguardia", "avventuroso", "bello", "brillante",
  "carismatico", "chiaro", "completamente", "coraggio", "coraggioso", "creativo", "definitivo",
  "degno", "delizioso", "determinato", "di successo", "dimostrare", "dinamico", "efficace",
  "esclusivo", "essenziale", "favoloso", "felicità", "fenomenale", "fiducia", "formidabile",
  "garanzia", "geniale", "glorioso", "grandioso", "gratuito", "illimitato", "impeccabile",
  "impressionante", "inarrestabile", "incredibile", "infallibile", "infinitamente", "influente",
  "ingegnoso", "indimenticabile", "indispensabile", "insostituibile", "intenso", "innovativo",
  "inaspettato", "irresistibile", "ispiratore", "leader", "leggendario", "libertà", "luminoso",
  "lusso", "lussuoso", "maestro", "magico", "magnifico", "maestoso", "memorabile", "meraviglioso",
  "miracoloso", "motivante", "necessario", "notevole", "nuovo", "ufficiale", "perfetto",
  "persuasivo", "piacere", "pioniere", "popolare", "potente", "potere", "prestigioso", "prezioso",
  "prodigioso", "profondo", "progresso", "prospero", "qualità", "radiante", "riconosciuto",
  "rinnovato", "riservato", "rivoluzionario", "saggezza", "soddisfazione", "soddisfatto",
  "sicurezza", "sicuro", "sensazionale", "sereno", "serenità", "spettacolare", "splendido",
  "straordinario", "sublime", "superamento", "superiore", "talento", "talentuoso", "terrificante",
  "trascendente", "trasformativo", "trionfante", "trionfo", "unico", "ultra", "valore", "veramente",
  "veloce", "vibrante", "vigoroso", "vittoria", "vittorioso", "vivace", "visionario", "volontà",
  "vitale", "zelante"
];
// Power word di DEFAULT da iniettare se il titolo non ne ha: invariabile
// (uguale maschile/femminile) per non rischiare mismatch di genere con la lista.
const DEFAULT_POWER_WORD = "essenziale";
// Match per PAROLA INTERA (confini non-lettera, unicode) per evitare falsi
// positivi da sottostringhe (es. "unico" dentro "comunico").
function hasPowerWord(s) {
  const l = (s || "").toLowerCase();
  return POWER_WORDS.some((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "iu").test(l);
  });
}
function capFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
// Titolo SEO con focus keyword all'inizio + una power word. NB: qui NON si
// aggiunge l'anno (feedback PM: "Guida 2026" ovunque stufa; l'anno nel titolo
// solo dove ha senso, cioe' quando sta gia' nel titolo del topic).
function buildSeoTitle(titoloSeo, focusKw) {
  let t = (titoloSeo || "").trim();
  const fk = (focusKw || "").trim();
  if (!fk) return t;
  if (!t.toLowerCase().startsWith(fk.toLowerCase())) {
    t = t ? `${capFirst(fk)}: ${t}` : capFirst(fk);
  }
  if (!hasPowerWord(t)) {
    t = `${t} - Guida ${capFirst(DEFAULT_POWER_WORD)}`;
  }
  return t;
}
// Meta description con focus keyword garantita (150-160 char).
function ensureKwInMeta(meta, focusKw) {
  const fk = (focusKw || "").trim();
  let m = (meta || "").trim();
  if (!fk) return m;
  if (m.toLowerCase().includes(fk.toLowerCase())) return m;
  m = m ? `${capFirst(fk)}: ${m}` : `${capFirst(fk)}: la guida di Nove C Ingegneria.`;
  if (m.length > 160) m = m.slice(0, 157).trimEnd() + "...";
  return m;
}

// ---------------------------------------------------------------------------
// NODO: "Code in JavaScript" — estrae l'articolo dall'output strutturato + diagnostica SEO.
// A1 (MVP3): l'articolo arriva come tool_use.input gia' parsato dall'API,
// quindi niente piu' strip fence / swap virgolette / JSON.parse del testo.
// ---------------------------------------------------------------------------
function parseArticle(message, related = []) {
  const block = Array.isArray(message.content)
    ? message.content.find((b) => b.type === "tool_use" && b.name === "pubblica_articolo")
    : null;
  if (!block || !block.input) {
    throw new Error(
      "Claude non ha restituito il tool 'pubblica_articolo'. Risposta: " +
        JSON.stringify(message).substring(0, 300)
    );
  }
  const parsed = block.input;

  // Sanitize HTML
  let html = (parsed.content_html || "").trim();
  html = html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, "");
  html = html.replace(/<\/?(div|span|br|img|script|style|iframe|form)[^>]*>/gi, "");

  // SEO diagnostics
  const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = plainText.split(" ").filter(Boolean).length;
  const h2Count = (html.match(/<h2/gi) || []).length;
  const focusKw = parsed.focus_keyword || "";
  const h2Texts = (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) || []).map((x) => x.replace(/<[^>]+>/g, "").toLowerCase());
  const kwInH2 = focusKw ? h2Texts.some((h) => h.includes(focusKw.toLowerCase())) : false;
  const kwRegex = focusKw ? new RegExp(focusKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  const kwCount = kwRegex ? (plainText.match(kwRegex) || []).length : 0;
  const first200 = plainText.substring(0, 200).toLowerCase();
  const kwInFirst = focusKw ? first200.includes(focusKw.toLowerCase()) : false;
  const kwDensity = wordCount > 0 ? (kwCount / wordCount * 100).toFixed(2) : "0.00";
  const extLinks = (html.match(/<a\s[^>]*href=["']https?:\/\/(?!nove-c\.com)[^"']+["'][^>]*>/gi) || []).length;
  const intLinks = (html.match(/<a\s[^>]*href=["']https?:\/\/nove-c\.com[^"']*["'][^>]*>/gi) || []).length;
  // B2: quanti degli articoli correlati proposti sono stati linkati davvero.
  const relatedUsed = related.filter((r) => r.link && html.includes(r.link)).length;
  // Paragrafo piu' lungo (parole): Rank Math penalizza i <p> troppo lunghi.
  const paraWords = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map((p) => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length);
  const maxParaWords = paraWords.length ? Math.max(...paraWords) : 0;

  // Slug from focus keyword if too short
  let slug = parsed.slug || "";
  if (slug.length < 10 && focusKw) {
    slug = focusKw.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").substring(0, 60);
  }
  slug = shortenSlug(slug, 60); // URL corta (Rank Math preferisce slug brevi)

  const ctaHtml = '<a href="https://nove-c.com/soluzioni/conto-termico-3-0-incentivi-fino-al-65-senza-anticipo/" style="font-weight:bold;">Contatta Nove C per una verifica di ammissibilita gratuita e scopri quanto puoi risparmiare con il Conto Termico 3.0</a>';

  // Garanzie SEO (Rank Math): titolo SEO keyword-led + power word, FK nella meta.
  const seoTitle = buildSeoTitle(parsed.titolo_seo, focusKw);
  const metaDescription = ensureKwInMeta(parsed.meta_description, focusKw);

  const patch_body = {
    // Publish PROGRAMMATO (non piu' draft): va online da solo a scheduledPublishGmt(),
    // ma Daniel ha la finestra del mattino per cestinarlo. Mai publish immediato.
    status: "future",
    date_gmt: scheduledPublishGmt(),
    // TITOLO VISIBILE (H1 in pagina + home) = h1 NATURALE del topic (capitalizzato,
    // leggibile), NON il titolo SEO keyword-led. Da quando le focus keyword sono
    // minuscole, usare titolo_seo qui produceva H1 tipo "pompa di calore condominio:
    // Guida..." (bug segnalato dal PM). Il titolo keyword-led resta dove serve:
    // SOLO nel tag <title> (rank_math_title), che e' quello che legge Google.
    title: capFirst((parsed.h1 || "").trim()) || parsed.titolo_seo || "Articolo Nove C",
    slug: slug,
    template: WP_POST_TEMPLATE,
    categories: [3],
    featured_media: FEATURED_MEDIA_FALLBACK,
    excerpt: metaDescription,
    acf: {
      titoli: { titolo_h2: "", testo: html, testo_call_to_action: ctaHtml },
      estratto: parsed.estratto || metaDescription
    }
  };

  return {
    titolo_seo: patch_body.title,
    seo_title: seoTitle,
    focus_keyword: focusKw,
    meta_description: metaDescription,
    slug: slug,
    brief_immagine: (parsed.brief_immagine || "").trim(),
    patch_body: patch_body,
    diagnostics: {
      wordCount, h2Count, kwCount, kwInFirst, kwInH2, kwDensity, extLinks, intLinks,
      relatedAvailable: related.length, relatedUsed,
      slugLen: slug.length, maxParaWords,
      powerWordInTitle: hasPowerWord(seoTitle),
      warnings: [
        wordCount < 1500 ? "Word count basso: " + wordCount : null,
        h2Count < 4 ? "H2 insufficienti: " + h2Count : null,
        !kwInFirst ? "FK assente nei primi 200 char" : null,
        (parseFloat(kwDensity) < 0.5 || parseFloat(kwDensity) > 2.5) ? "Densita: " + kwDensity + "%" : null,
        extLinks < 1 ? "No link esterni" : null,
        intLinks < 1 ? "No link interni" : null,
        related.length >= 2 && relatedUsed < 2 ? "Link correlati usati: " + relatedUsed + "/" + related.length : null,
        maxParaWords > 120 ? "Paragrafo troppo lungo: " + maxParaWords + " parole" : null
      ].filter(Boolean)
    }
  };
}

// ---------------------------------------------------------------------------
// Verificatore pre-publish (quality gate A3, "reporting"): stampa una checklist
// PASS/FAIL delle regole SEO PRIMA di creare il post, cosi' a ogni run si vede
// a colpo d'occhio se qualcosa non torna. Non blocca (l'articolo esce comunque
// programmato, con la finestra di veto di Daniel): serve a NON pubblicare alla
// cieca. Le regole deterministiche (power word, FK in titolo/meta) sono gia'
// forzate a monte, quindi qui devono risultare sempre verdi.
// NB fuori portata dello script: alt-text immagini nel corpo (i nostri articoli
// hanno solo la featured) e Table of Contents (plugin WordPress).
function verifyArticle(article) {
  const d = article.diagnostics;
  const fk = article.focus_keyword || "";
  const checks = [
    ["Titolo SEO inizia con la focus keyword", article.seo_title.toLowerCase().startsWith(fk.toLowerCase())],
    ["Titolo SEO contiene una power word (Rank Math IT)", d.powerWordInTitle],
    ["Focus keyword nella meta description", article.meta_description.toLowerCase().includes(fk.toLowerCase())],
    ["Focus keyword nei primi 200 caratteri", d.kwInFirst],
    ["Focus keyword in almeno un H2", d.kwInH2],
    ["Densita' focus keyword 0.5-2.5%", parseFloat(d.kwDensity) >= 0.5 && parseFloat(d.kwDensity) <= 2.5],
    ["Lunghezza articolo >= 1500 parole", d.wordCount >= 1500],
    ["Almeno 4 H2", d.h2Count >= 4],
    ["Slug <= 60 caratteri", d.slugLen <= 60],
    ["Almeno 1 link esterno", d.extLinks >= 1],
    ["Almeno 1 link interno", d.intLinks >= 1],
    // B2: solo quando abbiamo proposto articoli correlati reali (>=2), pretendi
    // che almeno 2 siano stati linkati; in fallback il check non compare.
    ...(d.relatedAvailable >= 2
      ? [[`Almeno 2 link interni ad articoli correlati reali (usati ${d.relatedUsed}/${d.relatedAvailable})`, d.relatedUsed >= 2]]
      : []),
    [`Paragrafi brevi (piu' lungo: ${d.maxParaWords} parole, max 120)`, d.maxParaWords <= 120]
  ];
  const failed = checks.filter(([, ok]) => !ok);
  console.log("VERIFICA REGOLE SEO (pre-publish):");
  for (const [label, ok] of checks) console.log(`  [${ok ? "OK" : "XX"}] ${label}`);
  console.log(`REGOLE: ${checks.length - failed.length}/${checks.length} ok${failed.length ? " (rivedi i punti XX)" : " - tutto a posto"}`);
  return { ok: checks.length - failed.length, total: checks.length };
}

// ---------------------------------------------------------------------------
// D1 — Registro storico: una riga per articolo generato in ops/articles.csv
// (ri-committato su main dal workflow insieme a log e stato rotazione) +
// riepilogo leggibile nel summary della Action (se disponibile).
// ---------------------------------------------------------------------------
const ARTICLES_CSV_PATH = join(ROOT, "ops", "articles.csv");
const ARTICLES_CSV_HEADER =
  "data_run,post_id,titolo,focus_keyword,slug,parole,regole_ok,correlati_usati,immagine,publish_gmt,origine";

// Campo CSV: virgolette solo se serve (virgole/virgolette/a-capo nel valore).
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function appendArticleLog(fields) {
  let prefix = "";
  try {
    if (!readFileSync(ARTICLES_CSV_PATH, "utf8").trim()) prefix = ARTICLES_CSV_HEADER + "\n";
  } catch {
    prefix = ARTICLES_CSV_HEADER + "\n"; // file assente: crealo con l'header
  }
  appendFileSync(ARTICLES_CSV_PATH, prefix + fields.map(csvField).join(",") + "\n");
}

// Riepilogo nel summary della Action (GITHUB_STEP_SUMMARY e' il file magico
// di GitHub Actions; fuori da Actions la variabile manca e non si scrive nulla).
function writeStepSummary(article, post, regole, origine) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const d = article.diagnostics;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    "## Articolo generato",
    "",
    `**${article.patch_body.title}**`,
    "",
    `- Post WP: [${post.id}](${WP_BASE}/wp-admin/post.php?post=${post.id}&action=edit) — publish ${article.patch_body.date_gmt} UTC (${origine})`,
    `- Focus keyword: ${article.focus_keyword}`,
    `- Parole: ${d.wordCount} · Regole SEO: ${regole.ok}/${regole.total} · Link correlati: ${d.relatedUsed}/${d.relatedAvailable}`,
    ""
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// NODO: "Crea Post WordPress" — crea il post (programmato)
// ---------------------------------------------------------------------------
function wpAuthHeader() {
  return "Basic " + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
}

async function createDraft(patch_body) {
  return await fetchJson(`${WP_BASE}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": wpAuthHeader(), "User-Agent": WP_UA },
    body: JSON.stringify(patch_body)
  }, "WordPress (crea post)");
}

// ---------------------------------------------------------------------------
// NODO: "Rank Math updateMeta" — imposta i meta SEO
// ---------------------------------------------------------------------------
async function updateRankMath(postId, article) {
  return await fetchJson(`${WP_BASE}/wp-json/rankmath/v1/updateMeta`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": wpAuthHeader(), "User-Agent": WP_UA },
    body: JSON.stringify({
      objectType: "post",
      objectID: postId,
      meta: {
        rank_math_focus_keyword: article.focus_keyword,
        rank_math_title: `${article.seo_title} | Nove C`,
        rank_math_description: article.meta_description
      }
    })
  }, "Rank Math (updateMeta)");
}

// ---------------------------------------------------------------------------
// MVP4/B1 — Immagine in evidenza: genera con OpenAI, carica su WP, imposta l'alt.
// Il SOGGETTO/registro arriva da Claude (brief_immagine); qui aggiungiamo lo
// stile fotografico fisso e gestiamo generazione + upload.
// ---------------------------------------------------------------------------
async function generateImage(brief) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY non configurata");
  const prompt = `${brief} ${STILE_IMMAGINE}`;
  const data = await fetchJson("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1536x1024", quality: IMAGE_QUALITY, n: 1 })
  }, "OpenAI immagine");
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error("nessuna immagine nella risposta OpenAI");
  return Buffer.from(b64, "base64");
}

async function uploadFeaturedImage(pngBuffer, focusKeyword, slug) {
  const filename = ((slug || "immagine").replace(/[^a-z0-9-]/gi, "-").slice(0, 60)) + ".png";
  // 1) upload binario nella media library
  const media = await fetchJson(`${WP_BASE}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      "Authorization": wpAuthHeader(),
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "User-Agent": WP_UA
    },
    body: pngBuffer
  }, "WordPress (upload media)");
  // 2) alt text con la focus keyword (chiude il check Rank Math sull'alt)
  await fetchJson(`${WP_BASE}/wp-json/wp/v2/media/${media.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": wpAuthHeader(), "User-Agent": WP_UA },
    body: JSON.stringify({ alt_text: capFirst(focusKeyword), title: capFirst(focusKeyword) })
  }, "WordPress (alt media)");
  return media.id;
}

// ---------------------------------------------------------------------------
// Orchestrazione
// ---------------------------------------------------------------------------
async function main() {
  // B2 + A4 — una sola lettura del blog: alimenta anti-doppioni e correlati.
  // NON bloccante: se fallisce (es. anti-bot) si procede come prima di B2/A4.
  let posts = null;
  try {
    posts = await fetchPublishedPosts();
    console.log(`Articoli live sul blog: ${posts.length}`);
  } catch (e) {
    console.error(`Lettura articoli live fallita (${e.message}): controllo doppioni saltato, link interni fissi`);
  }

  const ctx = selectTopic(posts);
  for (const d of ctx.doppioni || []) {
    console.log(`A4: topic "${d.slug}" gia' online (${d.link}) -> saltato, verra' segnato in rotazione`);
  }
  if (ctx.override) {
    console.log(`Override one-off (next.json): "${ctx.topic.title}"`);
    // A4 sull'override: solo avviso (se Daniel forza un titolo, comanda lui).
    const twin = posts ? findLiveTwin(posts, ctx.topic) : null;
    if (twin) console.log(`A4 (avviso): un pezzo simile e' gia' online: ${twin.link}`);
  } else if (ctx.esaurito) {
    console.log(`Topic (rotazione, ARGOMENTI ESAURITI -> LRU): ${ctx.topic.focusKeyword}`);
  } else {
    console.log(`Topic (rotazione tracciata): ${ctx.topic.focusKeyword}`);
  }
  console.log(`Template: ${ctx.template.name}`);

  const braveResults = await braveSearch(ctx.topic, ctx.year);
  console.log("Brave Search: ok");

  // B2 — articoli correlati per i link interni, dagli articoli live gia' letti.
  let related = posts ? pickRelatedPosts(posts, ctx.topic) : [];
  if (related.length >= 2) {
    console.log(`Articoli correlati (candidati link interni): ${related.length}`);
    for (const r of related) console.log(`  - ${r.title} -> ${r.link}`);
  } else {
    related = [];
    console.log("Articoli correlati: candidati insufficienti -> fallback sui 2 link interni fissi");
  }

  const message = await callClaude(buildPrompt(ctx, braveResults, related));
  console.log("Claude: articolo generato");

  const article = parseArticle(message, related);
  console.log("Diagnostica SEO:", JSON.stringify(article.diagnostics));
  const regole = verifyArticle(article);

  // Immagine in evidenza (non bloccante): se generazione/upload falliscono,
  // l'articolo esce comunque con l'immagine fallback. Il brief va nel log:
  // e' il modo per accorgersi se i soggetti tornano monotoni (bug operaio).
  if (article.brief_immagine) {
    console.log(`Brief immagine: ${article.brief_immagine}`);
    try {
      const png = await generateImage(article.brief_immagine);
      const mediaId = await uploadFeaturedImage(png, article.focus_keyword, article.slug);
      article.patch_body.featured_media = mediaId;
      console.log(`Immagine in evidenza generata: media id ${mediaId}`);
    } catch (e) {
      console.error(`Immagine saltata (non bloccante): ${e.message}`);
    }
  }

  const post = await createDraft(article.patch_body);
  console.log(`Articolo creato (${post.status}): id ${post.id}, publish previsto ${article.patch_body.date_gmt} UTC`);

  await updateRankMath(post.id, article);
  console.log("Rank Math: meta impostati");

  // D1 — registro storico + riepilogo nella Action (solo a run riuscito).
  const origine = ctx.override ? "override" : (ctx.esaurito ? "lru" : "rotazione");
  appendArticleLog([
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    post.id,
    article.patch_body.title,
    article.focus_keyword,
    article.slug,
    article.diagnostics.wordCount,
    `${regole.ok}/${regole.total}`,
    `${article.diagnostics.relatedUsed}/${article.diagnostics.relatedAvailable}`,
    article.patch_body.featured_media === FEATURED_MEDIA_FALLBACK ? "fallback" : article.patch_body.featured_media,
    article.patch_body.date_gmt,
    origine
  ]);
  console.log("Registro storico aggiornato: ops/articles.csv");
  writeStepSummary(article, post, regole, origine);

  // Override consumato solo a run riuscito: svuota next.json (il workflow
  // committa il file ripulito). Su errore l'override resta per il retry.
  if (ctx.override) {
    clearOverride();
    console.log("Override consumato: next.json svuotato (torna in rotazione).");
  } else {
    // Marca il topic come usato SOLO a pubblicazione riuscita (come clearOverride):
    // su errore il topic resta disponibile per il retry. Lo stato viene
    // ri-committato su main dal workflow (come next.json / log).
    ctx.state.usati = ctx.state.usati || {};
    // A4: i doppioni saltati vengono segnati con la data del pezzo live, cosi'
    // la rotazione si auto-ripara e il salto non si ripete a ogni run.
    for (const d of ctx.doppioni || []) {
      ctx.state.usati[d.slug] = d.date || new Date().toISOString().slice(0, 10);
      console.log(`Rotazione: "${d.slug}" segnato come gia' pubblicato (${ctx.state.usati[d.slug]}, doppione live).`);
    }
    ctx.state.usati[ctx.topic.slug] = new Date().toISOString().slice(0, 10);
    writeRotationState(ctx.state);
    console.log(`Rotazione: "${ctx.topic.slug}" segnato come usato.`);
    // Marker per lo step di notifica nel workflow (issue "argomenti esauriti").
    if (ctx.esaurito) {
      console.log("ARGOMENTI_ESAURITI: tutti i topic sono gia' stati pubblicati; ripubblicato il meno recente (LRU). Aggiungi nuovi topic a topics.json.");
    }
  }

  console.log(`\nFatto. Articolo programmato (rivedi o cestina entro la mattina):`);
  console.log(`  Admin:     ${WP_BASE}/wp-admin/post.php?post=${post.id}&action=edit`);
  console.log(`  Anteprima: ${WP_BASE}/?p=${post.id}&preview=true`);
}

main().catch((err) => {
  console.error("ERRORE:", err.message);
  process.exit(1);
});
