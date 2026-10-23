// Lyrics aggregation service.
//
// Tries several providers (synced first, then plain, then a web-search
// fallback) and normalizes the result to:
//   { found, synced, source, lines: [{ time: number|null, text }] }
//
// Providers:
//   1. LRCLIB        (synced + plain)
//   2. Netease       (synced)
//   3. QQ Music      (synced, best-effort)
//   4. lyrics.ovh    (plain)
//   5. AZLyrics      (plain, direct)
//   6. Google search (fallback scrape)
//   7. DuckDuckGo    (fallback scrape)

const fetch = require('node-fetch');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API_UA = 'AMG/1.2.0 (https://github.com/anomalyco/opencode)';

// === low level fetch with timeout ===
async function getText(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, ...opts });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url, opts = {}, ms = 8000) {
  const txt = await getText(url, opts, ms);
  return JSON.parse(txt);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient failures (rate limiting / 5xx / aborts) once.
async function getJSONRetry(url, opts = {}, ms = 8000) {
  try {
    return await getJSON(url, opts, ms);
  } catch (e) {
    if (/\b(429|5\d\d)\b|abort|timeout|socket|ECONN/i.test(e.message || '')) {
      await sleep(700);
      return await getJSON(url, opts, ms);
    }
    throw e;
  }
}

// === text helpers ===
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'feat', 'ft', 'with', 'official', 'video', 'audio', 'lyrics', 'lyric', 'music', 'hd', 'hq', 'mv']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) {
  return norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  return a.filter((w) => setB.has(w)).length / a.length;
}
// 0..1 confidence that a candidate matches the requested song.
function scoreMatch(cTitle, cArtist, title, artist) {
  const titleScore = overlap(tokenize(title), tokenize(cTitle));
  const artistScore = overlap(tokenize(artist), tokenize(cArtist));
  return titleScore * 0.75 + artistScore * 0.25;
}
function isGoodMatch(cTitle, cArtist, title, artist) {
  const titleScore = overlap(tokenize(title), tokenize(cTitle));
  const artistScore = overlap(tokenize(artist), tokenize(cArtist));
  if (titleScore >= 0.6) return true;
  if (titleScore >= 0.4 && artistScore >= 0.4) return true;
  return scoreMatch(cTitle, cArtist, title, artist) >= 0.5;
}

// === LRC / plain parsing ===
const CREDIT_RE = /(作词|作曲|编曲|制作人|监制|混音|母带|录音|出品|发行|词曲|统筹|企划|吉他|贝斯|和声|词|曲)\s*[:：]|^\s*(lyrics?\s*by|composed\s*by|written\s*by|music\s*by|produced\s*by|producer|arranged\s*by|mixing|mastering|performed\s*by|vocals?|guitar|bass|drums|piano|keyboard|backing\s*vocals?|recorded|studio|engineer|label|copyright)\b\s*[:：]/i;

function isCreditLine(text) {
  return text.length < 80 && CREDIT_RE.test(text);
}

function parseLRC(lrc) {
  const out = [];
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(tagRe)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text || isCreditLine(text)) continue;
    for (const m of tags) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      let frac = 0;
      if (m[3] != null) frac = m[3].length === 1 ? +m[3] / 10 : m[3].length === 2 ? +m[3] / 100 : +m[3] / 1000;
      out.push({ time: +(min * 60 + sec + frac).toFixed(2), text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function plainToLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((t) => t.replace(/\s+$/g, '').trim())
    .filter(Boolean)
    .map((t) => ({ time: null, text: t }));
}

function usable(lines, synced) {
  if (!lines || lines.length < 2) return false;
  if (synced && !lines.some((l) => l.time != null)) return false;
  return true;
}

// Reject bot-check / "not found" / nav-only pages masquerading as lyrics.
const JUNK_PAGE = /(recaptcha|request for access|are you a robot|enable javascript|access denied|bot detection|just a moment|checking your browser|cf-browser-verification|page not found|404 not found|subscribe to continue)/i;
function looksLikeLyrics(text) {
  if (!text) return false;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length < 60 || JUNK_PAGE.test(clean)) return false;
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const wordy = lines.filter((l) => l.split(/\s+/).length >= 4).length;
  return wordy >= 2;
}

function result(source, synced, lines) {
  if (!usable(lines, synced)) return null;
  if (!synced && !looksLikeLyrics(lines.map((l) => l.text).join('\n'))) return null;
  return { source, synced: !!synced, lines };
}

// === Provider 1: LRCLIB (synced + plain) ===
async function fromLrclib(rec) {
  if (!rec) return null;
  if (rec.syncedLyrics) {
    const lines = parseLRC(rec.syncedLyrics);
    if (usable(lines, true)) return result('lrclib', true, lines);
  }
  if (rec.plainLyrics) {
    const lines = plainToLines(rec.plainLyrics);
    if (usable(lines, false)) return result('lrclib', false, lines);
  }
  return null;
}

async function lrclib(title, artist, duration) {
  const h = { headers: { 'User-Agent': API_UA, Accept: 'application/json' } };
  try {
    const p = new URLSearchParams();
    p.set('track_name', title);
    if (artist) p.set('artist_name', artist);
    if (duration) p.set('duration', String(Math.round(duration)));
    const j = await getJSONRetry('https://lrclib.net/api/get?' + p.toString(), h, 8000);
    if (j && (j.syncedLyrics || j.plainLyrics)) {
      return await fromLrclib(j);
    }
  } catch (e) { /* fall through to search */ }

  try {
    const p = new URLSearchParams();
    p.set('track_name', title);
    if (artist) p.set('artist_name', artist);
    const arr = await getJSONRetry('https://lrclib.net/api/search?' + p.toString(), h, 8000);
    if (Array.isArray(arr) && arr.length) {
      const scored = arr
        .map((r) => ({ r, s: scoreMatch(r.trackName || r.name, r.artistName, title, artist), dur: Math.abs((r.duration || 0) - (duration || 0)) }))
        .sort((a, b) => (b.s - a.s) || (a.dur - b.dur));
      for (const { r, s } of scored.slice(0, 3)) {
        if (s < 0.4 && !isGoodMatch(r.trackName || r.name, r.artistName, title, artist)) continue;
        const res = await fromLrclib(r);
        if (res) return res;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// === Provider 2: Netease Cloud Music (synced) ===
async function netease(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  const h = { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://music.163.com/', Accept: 'application/json' } };
  try {
    const s = await getJSON('https://music.163.com/api/search/get?s=' + encodeURIComponent(q) + '&type=1&limit=8', h, 8000);
    const songs = (s && s.result && s.result.songs) || [];
    const scored = songs
      .map((x) => ({ x, s: scoreMatch(x.name, (x.artists || []).map((a) => a.name).join(' '), title, artist) }))
      .sort((a, b) => b.s - a.s);
    for (const { x, s } of scored.slice(0, 3)) {
      if (s < 0.4 && !isGoodMatch(x.name, (x.artists || []).map((a) => a.name).join(' '), title, artist)) continue;
      const ly = await getJSON('https://music.163.com/api/song/lyric?id=' + x.id + '&lv=1&kv=1&tv=-1', h, 8000);
      const lrc = ly && ly.lrc && ly.lrc.lyric;
      if (!lrc) continue;
      if (/纯音乐|instrumental/i.test(lrc) && lrc.length < 60) continue;
      const lines = parseLRC(lrc);
      const res = result('netease', true, lines);
      if (res) return res;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// === Provider 3: QQ Music (synced, best-effort) ===
async function qq(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ');
  const h = { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://y.qq.com/' } };
  try {
    const s = await getJSON('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=8&w=' + encodeURIComponent(q), h, 8000);
    const list = (s && s.data && s.data.song && s.data.song.list) || [];
    const scored = list
      .map((x) => ({ x, s: scoreMatch(x.songname || x.title, (x.singer || []).map((a) => a.name).join(' '), title, artist) }))
      .sort((a, b) => b.s - a.s);
    for (const { x, s } of scored.slice(0, 3)) {
      if (s < 0.4) continue;
      const mid = x.songmid;
      if (!mid) continue;
      const ly = await getJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + mid + '&format=json&nobase64=1', h, 8000);
      if (!ly || !ly.lyric) continue;
      const lines = parseLRC(decodeEntities(ly.lyric));
      const res = result('qq', true, lines);
      if (res) return res;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// === Provider 4: lyrics.ovh (plain) ===
async function lyricsOvh(title, artist) {
  if (!artist) return null;
  try {
    const j = await getJSON('https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title), {}, 8000);
    if (j && j.lyrics) {
      const clean = j.lyrics.replace(/^\s*Paroles de la chanson.*?\n/i, '');
      const res = result('lyrics.ovh', false, plainToLines(clean));
      if (res) return res;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// === Provider 5: AZLyrics (plain, direct) ===
function azSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function extractAz(html) {
  const marker = html.indexOf('Usage of azlyrics.com content');
  if (marker === -1) return '';
  const startBrace = html.indexOf('-->', marker);
  const start = startBrace !== -1 ? startBrace + 3 : marker;
  const end = html.indexOf('</div>', start);
  const seg = html.slice(start, end === -1 ? undefined : end);
  const text = decodeEntities(seg.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}
async function azlyrics(title, artist) {
  if (!artist) return null;
  try {
    const url = 'https://www.azlyrics.com/lyrics/' + azSlug(artist) + '/' + azSlug(title) + '.html';
    const html = await getText(url, { headers: { 'User-Agent': BROWSER_UA } }, 9000);
    const lyric = extractAz(html);
    const res = result('azlyrics', false, plainToLines(lyric));
    if (res) return res;
  } catch (e) { /* ignore */ }
  return null;
}

// === generic lyric page extraction (for search fallback) ===
const LYRICS_HOSTS = [
  'azlyrics.com', 'lyricsfreak.com', 'allthelyrics.com', 'lyricsmania.com',
  'songlyrics.com', 'lyrics.com', 'musixmatch.com', 'genius.com',
  'letras.com', 'letras.mus.br', 'lyricstranslate.com', 'stlyrics.com',
];

function isLyricsHost(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    return LYRICS_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

function htmlToLyrics(inner) {
  let text = String(inner)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Well-known lyric containers for popular sites (checked in order).
const LYRIC_CONTAINERS = [
  /<div[^>]*class=["'][^"']*lyrictxt[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,       // lyricsfreak
  /<div[^>]*class=["'][^"']*content-text-inner[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, // allthelyrics
  /<div[^>]*class=["'][^"']*lyrics-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,     // lyricsmania
  /<div[^>]*id=["']lyrics-root["'][^>]*>([\s\S]*?)<\/div>/i,                    // genius
  /<div[^>]*class=["'][^"']*lyrics__content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]*id=["']lyrics["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]*class=["'][^"']*[^"']*lyrics[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
];

function containerExtract(html) {
  for (const re of LYRIC_CONTAINERS) {
    const m = html.match(re);
    if (m && m[1]) {
      const text = htmlToLyrics(m[1]);
      if (looksLikeLyrics(text)) return text;
    }
  }
  return null;
}

function genericExtract(html) {
  const fromContainer = containerExtract(html);
  if (fromContainer) return fromContainer;

  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = decodeEntities(h);
  const lines = h.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const junk = /(cookie|advert|subscribe|share|submit|correction|lyrics licensed|copyright|all rights|read more|azlyrics|songfacts|privacy|terms|sign up|log in|you might also|related|random|trending|report|top \w+ songs|playlist|newsletter|comment)/i;
  // Longest run of consecutive non-empty, non-junk lines == the lyrics body.
  let best = [], cur = [];
  for (const l of lines) {
    if (l.length >= 2 && l.length < 200 && !junk.test(l)) cur.push(l);
    else { if (cur.length > best.length) best = cur; cur = []; }
  }
  if (cur.length > best.length) best = cur;
  return best.join('\n');
}

async function scrapePage(url) {
  const html = await getText(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, 9000);
  if (isLyricsHost(url) && /azlyrics\.com/.test(url)) {
    const az = extractAz(html);
    if (az && az.length > 40) return az;
  }
  const g = genericExtract(html);
  return g && g.length > 60 ? g : null;
}

async function scrapeFromLinks(links) {
  const seen = new Set();
  const ordered = [];
  for (const u of links) {
    if (!isLyricsHost(u)) continue;
    let key;
    try { const p = new URL(u); key = p.hostname + p.pathname; } catch (e) { continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(u);
  }
  for (const url of ordered.slice(0, 6)) {
    try {
      const text = await scrapePage(url);
      if (text) {
        const res = result('web', false, plainToLines(text));
        if (res) return res;
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// === Provider 6: Google search fallback ===
async function googleScrape(title, artist) {
  const q = [title, artist, 'lyrics'].filter(Boolean).join(' ');
  const links = [];
  for (const url of [
    'https://www.google.com/search?hl=en&num=10&q=' + encodeURIComponent(q),
    'https://www.google.com/search?gbv=1&hl=en&q=' + encodeURIComponent(q),
  ]) {
    try {
      const html = await getText(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, 9000);
      for (const m of html.matchAll(/\/url\?q=([^&"']+)/g)) {
        try { links.push(decodeURIComponent(m[1])); } catch (e) { /* ignore */ }
      }
      for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
        if (isLyricsHost(m[1])) links.push(m[1]);
      }
      if (links.length) break;
    } catch (e) { /* try next form */ }
  }
  return await scrapeFromLinks(links);
}

// === Provider 7: DuckDuckGo fallback ===
async function ddgScrape(title, artist) {
  const q = [title, artist, 'lyrics'].filter(Boolean).join(' ');
  const links = [];
  for (const url of [
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
    'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q),
  ]) {
    try {
      const html = await getText(url, { headers: { 'User-Agent': BROWSER_UA } }, 9000);
      for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
        try { links.push(decodeURIComponent(m[1])); } catch (e) { /* ignore */ }
      }
      for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
        if (isLyricsHost(m[1])) links.push(m[1]);
      }
      if (links.length) break;
    } catch (e) { /* try next */ }
  }
  return await scrapeFromLinks(links);
}

// === Orchestration ===
const SYNCED_PROVIDERS = [
  ['lrclib', (t, a, d) => lrclib(t, a, d)],
  ['netease', (t, a) => netease(t, a)],
  ['qq', (t, a) => qq(t, a)],
];
const PLAIN_PROVIDERS = [
  ['lyrics.ovh', (t, a) => lyricsOvh(t, a)],
  ['azlyrics', (t, a) => azlyrics(t, a)],
];
const SEARCH_PROVIDERS = [
  ['google', (t, a) => googleScrape(t, a)],
  ['duckduckgo', (t, a) => ddgScrape(t, a)],
];

// Resolve with the first provider that yields a usable result.
function firstSuccess(providers, title, artist, duration) {
  return new Promise((resolve) => {
    let pending = providers.length;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (!pending) return resolve(null);
    for (const [, fn] of providers) {
      Promise.resolve()
        .then(() => fn(title, artist, duration))
        .then((v) => { if (v) done(v); else if (--pending === 0) done(null); })
        .catch(() => { if (--pending === 0) done(null); });
    }
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }).catch(() => { clearTimeout(t); resolve(null); });
  });
}

async function findLyrics(rawTitle, rawArtist, duration) {
  const title = cleanTitle(rawTitle, rawArtist);
  const artist = cleanArtist(rawArtist);
  if (!title) return { found: false };

  // All synced providers race together; plain providers race in parallel so a
  // plain result is ready instantly if no synced lyrics exist. LRCLIB is
  // preferred: if it produces synced lyrics quickly, use it.
  const syncedAll = firstSuccess(SYNCED_PROVIDERS, title, artist, duration);
  const plainAll = firstSuccess(PLAIN_PROVIDERS, title, artist, duration);

  const lrclibQuick = await withTimeout(firstSuccess([['lrclib', (t, a, d) => lrclib(t, a, d)]], title, artist, duration), 1600);
  if (lrclibQuick && lrclibQuick.synced) return { found: true, ...lrclibQuick };

  const synced = await withTimeout(syncedAll, 6500);
  if (synced) return { found: true, ...synced };
  if (lrclibQuick) return { found: true, ...lrclibQuick };

  const plain = await withTimeout(plainAll, 4000);
  if (plain) return { found: true, ...plain };

  const web = await withTimeout(firstSuccess(SEARCH_PROVIDERS, title, artist, duration), 14000);
  if (web) return { found: true, ...web };

  return { found: false };
}

// === Query cleaning ===
function cleanArtist(a) {
  return String(a || '')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/official\s*$/i, '')
    .trim();
}

const NOISE = /\b(official|lyric|lyrics|audio|video|visualizer|visualiser|hd|hq|4k|8k|remaster(ed)?|mv|m\/v|music\s*video|full\s*song|with\s*lyrics|color\s*coded|explicit|clean\s*version|radio\s*edit|extended|live|performance)\b/i;

function cleanTitle(title, artist) {
  let t = String(title || '');
  // YouTube style "Artist - Song"
  if (/\s[-–—]\s/.test(t)) {
    const parts = t.split(/\s[-–—]\s/);
    const a = norm(artist);
    // drop a leading/trailing segment that equals the artist
    if (a && parts.length > 1) {
      const keep = parts.filter((p) => {
        const pn = norm(p);
        return pn && pn !== a && !(a.includes(pn) && pn.length > 2);
      });
      if (keep.length) t = keep.join(' - ');
    }
  }
  t = t.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (m, inner) => (NOISE.test(inner) ? ' ' : m));
  t = t.replace(/\b(feat|ft|featuring)\.?\s+[^,;]+/gi, ' ');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '').trim();
  return t || String(title || '').trim();
}

module.exports = { findLyrics, parseLRC, cleanTitle, cleanArtist, googleScrape, ddgScrape };
