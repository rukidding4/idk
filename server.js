const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { findLyrics } = require('./lyrics');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function parseLength(text) {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

async function searchYouTube(query) {
  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' },
        },
        query,
      }),
    }
  );
  const data = await res.json();
  const items =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

  const results = [];
  for (const item of items) {
    const v = item.videoRenderer;
    if (!v) continue;
    const id = v.videoId;
    if (!id) continue;
    const title = v.title?.runs?.[0]?.text || v.title?.accessibility?.accessibilityData?.label || '';
    const author = v.ownerText?.runs?.[0]?.text || 'Unknown';
    const lengthText = v.lengthText?.simpleText || '';
    const thumbnail =
      v.thumbnail?.thumbnails?.pop()?.url ||
      `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    results.push({
      id,
      title,
      author,
      length: parseLength(lengthText),
      lengthText,
      thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
      source: 'youtube',
    });
  }
  return results;
}

// === SOUNDCLOUD (via yt-dlp) ===
// SoundCloud's best audio is 160 kbps AAC (HLS). The stream URLs are IP-bound,
// so the server proxies the HLS manifest + segments to the browser.

function ytdlpFilename() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

let ytdlpPromise = null;
function ensureYtDlp() {
  if (ytdlpPromise) return ytdlpPromise;
  ytdlpPromise = (async () => {
    const dir = path.join(os.homedir() || os.tmpdir(), '.amg');
    fs.mkdirSync(dir, { recursive: true });
    const name = ytdlpFilename();
    const bin = path.join(dir, name);
    if (fs.existsSync(bin) && fs.statSync(bin).size > 100000) return bin;
    console.log('[yt-dlp] downloading helper to', bin);
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`);
    if (!r.ok) throw new Error('yt-dlp download HTTP ' + r.status);
    await new Promise((resolve, reject) => {
      const f = fs.createWriteStream(bin);
      r.body.pipe(f);
      r.body.on('error', reject);
      f.on('finish', resolve);
      f.on('error', reject);
    });
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    console.log('[yt-dlp] ready');
    return bin;
  })().catch((e) => { ytdlpPromise = null; throw e; });
  return ytdlpPromise;
}

async function runYtDlp(args, timeoutMs) {
  const bin = await ensureYtDlp();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('yt-dlp timeout')); }, timeoutMs || 60000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('yt-dlp exit ' + code + ': ' + (err.trim().split('\n').pop() || '')));
    });
  });
}

function pickThumb(d) {
  const list = Array.isArray(d.thumbnails) ? d.thumbnails : null;
  if (list && list.length) {
    const best = list.filter(t => t && t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (best) return best.url;
  }
  return d.thumbnail || '';
}

async function searchSoundCloud(query, limit = 10) {
  const out = await runYtDlp(['scsearch' + limit + ':' + query, '--flat-playlist', '-j', '--no-warnings'], 45000);
  const results = [];
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let d;
    try { d = JSON.parse(s); } catch (e) { continue; }
    if (!d || !d.id) continue;
    results.push({
      id: String(d.id),
      title: d.title || 'Unknown',
      author: d.uploader || d.artist || 'Unknown',
      length: Math.round(d.duration || 0),
      thumbnail: pickThumb(d),
      source: 'soundcloud',
      url: d.webpage_url || d.original_url || '',
    });
  }
  return results;
}

function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

function isSoundCloudPageUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'soundcloud.com' || h.endsWith('.soundcloud.com');
  } catch (e) { return false; }
}

function isSoundCloudCdnUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h.endsWith('.soundcloud.cloud') || h === 'soundcloud.cloud' || h.endsWith('.sndcdn.com');
  } catch (e) { return false; }
}

const scManifestCache = new Map();
async function resolveSoundCloudManifest(pageUrl) {
  const cached = scManifestCache.get(pageUrl);
  if (cached && Date.now() - cached.ts < 8 * 60 * 1000) return cached.url;
  const out = await runYtDlp(
    ['-f', 'hls_aac_160k/hls_aac_96k/bestaudio', '-g', '--no-warnings', '--no-playlist', pageUrl],
    45000
  );
  const url = out.trim().split('\n').filter(Boolean).pop();
  if (!url) throw new Error('no manifest url');
  scManifestCache.set(pageUrl, { url, ts: Date.now() });
  return url;
}

function scSegUrl(u) {
  return '/api/sc/seg?u=' + Buffer.from(u).toString('base64url');
}

const FALLBACK_TRACKS = [
  { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', author: 'Rick Astley', length: 212, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' },
  { id: '9bZkp7q19f0', title: 'PSY - GANGNAM STYLE', author: 'PSY', length: 253, thumbnail: 'https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg' },
  { id: 'kJQP7kiw5Fk', title: 'Luis Fonsi - Despacito ft. Daddy Yankee', author: 'Luis Fonsi', length: 281, thumbnail: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/mqdefault.jpg' },
  { id: 'RgKAFK5djSk', title: 'Wiz Khalifa - See You Again ft. Charlie Puth', author: 'Wiz Khalifa', length: 237, thumbnail: 'https://i.ytimg.com/vi/RgKAFK5djSk/mqdefault.jpg' },
  { id: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody', author: 'Queen', length: 355, thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/mqdefault.jpg' },
  { id: 'JGwWNGJdvx8', title: 'Ed Sheeran - Shape of You', author: 'Ed Sheeran', length: 263, thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/mqdefault.jpg' },
  { id: '09R8_2nJtjg', title: 'Maroon 5 - Sugar', author: 'Maroon 5', length: 305, thumbnail: 'https://i.ytimg.com/vi/09R8_2nJtjg/mqdefault.jpg' },
  { id: 'pRpeEdMmmQ0', title: 'Imagine Dragons - Believer', author: 'Imagine Dragons', length: 204, thumbnail: 'https://i.ytimg.com/vi/pRpeEdMmmQ0/mqdefault.jpg' },
  { id: '7wtfhZwirJc', title: 'The Weeknd - Blinding Lights', author: 'The Weeknd', length: 200, thumbnail: 'https://i.ytimg.com/vi/7wtfhZwirJc/mqdefault.jpg' },
  { id: 'kTJczUoc26U', title: 'Post Malone - Sunflower', author: 'Post Malone', length: 158, thumbnail: 'https://i.ytimg.com/vi/kTJczUoc26U/mqdefault.jpg' },
];

function withYouTubeSource(list) {
  return list.map((t) => t.source ? t : { ...t, source: 'youtube' });
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  try {
    const ytResults = await searchYouTube(query);
    res.json(ytResults.length ? ytResults : withYouTubeSource(FALLBACK_TRACKS.slice(0, 5)));
  } catch (err) {
    console.error('YouTube search error:', err.message);
    res.json(withYouTubeSource(FALLBACK_TRACKS.slice(0, 5)));
  }
});

app.get('/api/search/sc', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  try {
    res.json(await searchSoundCloud(query));
  } catch (err) {
    console.error('SoundCloud search error:', err.message);
    res.json([]);
  }
});

app.get('/api/sc/manifest', async (req, res) => {
  const page = String(req.query.u || '');
  if (!isSoundCloudPageUrl(page)) return res.status(400).send('bad url');
  try {
    const manifestUrl = await resolveSoundCloudManifest(page);
    const r = await fetch(manifestUrl, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('manifest upstream ' + r.status);
    const body = await r.text();
    const rewritten = body.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#EXT-X-MAP:')) {
        return t.replace(/URI="([^"]+)"/, (m, u) => 'URI="' + scSegUrl(u) + '"');
      }
      if (t.startsWith('#')) return line;
      return scSegUrl(t);
    }).join('\n');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);
  } catch (err) {
    console.error('[sc] manifest', err.message);
    res.status(502).send('manifest error');
  }
});

app.get('/api/sc/seg', async (req, res) => {
  let target = '';
  try { target = Buffer.from(String(req.query.u || ''), 'base64url').toString(); } catch (e) {}
  if (!target || !isSoundCloudCdnUrl(target)) return res.status(400).send('bad segment');
  try {
    const headers = { 'User-Agent': UA };
    if (req.headers.range) headers['Range'] = req.headers.range;
    const up = await fetch(target, { headers });
    if (!up.ok && up.status !== 206) return res.status(502).send('segment upstream ' + up.status);
    res.status(up.status === 206 ? 206 : 200);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    up.body.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.on('close', () => { try { up.body.destroy(); } catch (e) {} });
    up.body.pipe(res);
  } catch (err) {
    console.error('[sc] seg', err.message);
    if (!res.headersSent) res.status(502).send('segment error');
  }
});

app.get('/api/trending', async (req, res) => {
  try {
    const results = await searchYouTube('trending music 2024');
    res.json(results.length > 0 ? results : withYouTubeSource(FALLBACK_TRACKS));
  } catch (err) {
    console.error('Trending error:', err.message);
    res.json(withYouTubeSource(FALLBACK_TRACKS));
  }
});

// === RECOMMENDATIONS ===
// YouTube-style "radio" for a track: the same artist's other songs plus songs
// with a similar vibe. Deliberately independent of whatever the user searched,
// so autoplay never just repeats the search results.
const recommendCache = new Map();
const RECOMMEND_TTL = 30 * 60 * 1000;

// Spread the results out so we don't get a long run of one artist.
function diversify(list, maxRun) {
  const out = [];
  const pool = list.slice();
  let run = 0, lastAuthor = null;
  while (pool.length) {
    let idx = 0;
    if (lastAuthor && run >= maxRun) {
      const alt = pool.findIndex((t) => String(t.author || '').toLowerCase() !== lastAuthor);
      if (alt >= 0) idx = alt;
    }
    const t = pool.splice(idx, 1)[0];
    const a = String(t.author || '').toLowerCase();
    if (a === lastAuthor) run++; else { lastAuthor = a; run = 1; }
    out.push(t);
  }
  return out;
}

async function recommendTracks(artist, title, excludeIds, limit) {
  const exclude = new Set((excludeIds || []).filter(Boolean));
  const a = String(artist || '').trim();
  const baseTitle = String(title || '').split(' - ').pop().replace(/[\(\[]([^\)\]]*)[\)\]]/g, ' ').trim();
  const queries = [];
  if (a) { queries.push(a); queries.push(a + ' top songs'); queries.push(a + ' mix'); }
  if (baseTitle) queries.push('songs similar to ' + baseTitle + (a ? ' ' + a : ''));
  if (!queries.length) return [];

  const settled = await Promise.allSettled(queries.slice(0, 4).map((q) => searchYouTube(q)));
  const seen = new Set();
  const aKey = a.toLowerCase();
  const scored = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      if (!t || !t.id || exclude.has(t.id) || seen.has(t.id)) continue;
      seen.add(t.id);
      const author = String(t.author || '').toLowerCase();
      const tTitle = String(t.title || '').toLowerCase();
      let score = 0;
      if (aKey && author === aKey) score += 5;
      else if (aKey && (author.includes(aKey) || aKey.includes(author))) score += 3;
      if (t.length >= 60 && t.length <= 600) score += 1;
      if (/official (audio|video)|music video|lyric/.test(tTitle)) score += 0.5;
      scored.push({ t, score });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const ranked = diversify(scored.map((s) => s.t), 2);
  return ranked.slice(0, limit || 15);
}

app.get('/api/recommend', async (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const title = String(req.query.title || '').trim();
  const exclude = String(req.query.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 15, 30));
  if (!artist && !title) return res.status(400).json({ error: 'Missing artist/title' });

  const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
  const cached = recommendCache.get(key);
  if (cached && Date.now() - cached.ts < RECOMMEND_TTL) {
    return res.json(cached.data.filter((t) => !exclude.includes(t.id)).slice(0, limit));
  }
  try {
    const list = await recommendTracks(artist, title, exclude, limit);
    recommendCache.set(key, { data: list, ts: Date.now() });
    if (recommendCache.size > 200) recommendCache.delete(recommendCache.keys().next().value);
    res.json(list);
  } catch (err) {
    console.error('Recommend error:', err.message);
    res.json([]);
  }
});

// Lyrics: aggregated from several providers (synced first, then plain, then a
// web-search fallback). Results are cached in-memory to avoid re-hitting APIs.
const lyricsCache = new Map();
const LYRICS_TTL = 6 * 60 * 60 * 1000;
const LYRICS_NEG_TTL = 10 * 60 * 1000;

app.get('/api/lyrics', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const duration = Number(req.query.duration) || 0;
  if (!title) return res.status(400).json({ error: 'Missing title' });

  const key = `${artist.toLowerCase()}|${title.toLowerCase()}|${Math.round(duration / 5) * 5}`;
  const force = req.query.refresh === '1';
  const cached = lyricsCache.get(key);
  if (cached && !force) {
    const ttl = cached.data.found ? LYRICS_TTL : LYRICS_NEG_TTL;
    if (Date.now() - cached.ts < ttl) return res.json(cached.data);
  }

  try {
    const data = await findLyrics(title, artist, duration);
    lyricsCache.set(key, { ts: Date.now(), data });
    if (lyricsCache.size > 500) {
      const oldest = [...lyricsCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) lyricsCache.delete(oldest[0]);
    }
    res.json(data);
  } catch (err) {
    console.error('Lyrics error:', err.message);
    res.status(502).json({ found: false, error: 'lyrics unavailable' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

const DOWNLOADS = {
  exe: { file: 'AMG.exe', name: 'AMG.exe', label: 'Windows single .exe (40 MB)' },
  zip: { file: 'streamvibe-portable-win-x64.zip', name: 'AMG-portable-win-x64.zip', label: 'Windows Portable ZIP (27 MB)' },
  apk: { file: 'StreamVibe.apk', name: 'AMG.apk', label: 'Android APK (45 KB)' },
};

const DOWNLOAD_TYPES = {
  exe: 'application/x-msdos-program',
  zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
};

app.get('/download/:kind', (req, res) => {
  const item = DOWNLOADS[req.params.kind];
  if (!item) return res.status(404).send('Not found');
  const filePath = path.join(process.cwd(), item.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send(`${item.file} not found on server`);
  }
  const kind = req.params.kind;
  const ct = DOWNLOAD_TYPES[kind] || 'application/octet-stream';
  const enc = String(req.headers['accept-encoding'] || '');
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', `attachment; filename="${item.name}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Vary', 'Accept-Encoding');

  if (kind === 'exe' && /\bbr\b/.test(enc)) {
    const brPath = filePath + '.br';
    if (fs.existsSync(brPath)) {
      const stat = fs.statSync(brPath);
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') return res.end();
      const s = fs.createReadStream(brPath);
      s.on('error', () => res.destroy());
      return s.pipe(res);
    }
  }

  if (kind === 'exe' && /\bgzip\b/.test(enc)) {
    res.setHeader('Content-Encoding', 'gzip');
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(filePath);
    const gz = zlib.createGzip({ level: 6 });
    s.on('error', () => res.destroy());
    gz.on('error', () => res.destroy());
    return s.pipe(gz).pipe(res);
  }

  res.download(filePath, item.name);
});

app.get('/download', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Download ///AMG</title>
<style>
body{background:#0B0908;color:#F5F3F1;font-family:system-ui,sans-serif;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{text-align:center;padding:40px;border:1px solid #302A26;border-radius:16px;
background:#171412;max-width:540px;width:100%}
h1{font-size:24px;margin:0 0 8px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#96908B;
margin:28px 0 4px;font-weight:600}
p{color:#96908B;line-height:1.6}
a{display:block;margin:12px 0 0;padding:14px 28px;background:#E7A98D;color:#0B0908;
text-decoration:none;border-radius:10px;font-weight:600}
a:hover{opacity:.9}
a.alt{background:transparent;border:1px solid #E7A98D;color:#E7A98D}
small{display:block;margin-top:8px;color:#666;font-size:12px;line-height:1.5}
</style></head>
<body><div class="box">
<h1>Download ///AMG</h1>
<p>Standalone apps that run on your own device.</p>

<h2>Android</h2>
<a href="/download/apk">Download ///AMG.apk</a>
<small>Android 7.0+ &middot; Enable "Install unknown apps" to install &middot; Enter your server address on first launch</small>

<h2>Windows</h2>
<a href="/download/zip">Download Portable ZIP (27 MB) - recommended</a>
<a class="alt" href="/download/exe">Download ///AMG.exe (40 MB)</a>
<small>Windows 10/11 64-bit &middot; ZIP: unzip and double-click "Start AMG.bat"<br>
Runs at http://localhost:3000 &middot; Requires internet for music (YouTube + SoundCloud)</small>

<h2>Source code</h2>
<a class="alt" href="/amg-source.zip">Download source ZIP</a>
<small>Full source (server.js, lyrics.js, public/) to self-host or deploy to Netlify/Vercel</small>
</div></body></html>`);
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ============================================');
  console.log('       ///AMG is running!');
  console.log('  ============================================');
  console.log('');
  console.log(`   Open your browser at:  ${url}`);
  console.log('');
  console.log('   Keep this window open while using the app.');
  console.log('   Press Ctrl+C to stop.');
  console.log('');

  if (process.env.NO_OPEN !== '1') {
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32') {
        exec(`start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
    } catch (e) {
      /* ignore */
    }
  }
}).on('error', (err) => {
  console.error('');
  console.error('  Failed to start ///AMG:');
  console.error(`  ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use.`);
    console.error('  Close the other app using it, or run with a different port:');
    console.error(`     set PORT=3001 && AMG.exe   (Windows)`);
    console.error(`     PORT=3001 ./AMG.exe         (Mac/Linux)`);
  }
  console.error('');
});