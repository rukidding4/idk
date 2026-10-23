(() => {
'use strict';

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const formatTime = s => { if (!s || isNaN(s)) return '0:00'; const m = Math.floor(s/60); return `${m}:${String(Math.floor(s%60)).padStart(2,'0')}`; };
const escapeHtml = t => { const d = document.createElement('div'); d.textContent = t||''; return d.innerHTML; };
const uid = () => Math.random().toString(36).slice(2,10);

const DEFAULT_SETTINGS = {
  theme:'dark', accentColor:'auto', bgStyle:'artwork',
  fontFamily:'inter', blurStrength:60, bgDim:50, glass:true,
  corners:'normal', density:'comfortable', fontSize:'medium',
  lite:false, perfPreset:'auto',
  autoplay:true, crossfade:0, audioQuality:'auto',
  seekDuration:10, scrollVolume:true, toasts:true,
  startup:'home', history:true,
  resume:true, searchHistory:true, lang:'en', device:'',
  custom:{ useColors:false, bg:'#0B0908', surface:'#171412', text:'#F5F3F1', border:'#302A26',
    radius:100, animSpeed:100, glow:100, grain:false, cursor:false, css:'',
    glassBlur:16, glassTint:9, hoverStyle:'glow', hoverIntensity:100, glowBorder:false },
};

// Lightweight UI translations for primary navigation + headings.
const I18N = {
  en: { Home:'Home', Search:'Search', Library:'Library', 'Liked Songs':'Liked Songs', History:'History', Race:'Race', Settings:'Settings', 'Quick Picks':'Quick Picks' },
  es: { Home:'Inicio', Search:'Buscar', Library:'Biblioteca', 'Liked Songs':'Favoritos', History:'Historial', Race:'Carrera', Settings:'Ajustes', 'Quick Picks':'Selección rápida' },
  fr: { Home:'Accueil', Search:'Rechercher', Library:'Bibliothèque', 'Liked Songs':'Titres aimés', History:'Historique', Race:'Course', Settings:'Paramètres', 'Quick Picks':'Sélection rapide' },
  de: { Home:'Start', Search:'Suche', Library:'Bibliothek', 'Liked Songs':'Lieblingstitel', History:'Verlauf', Race:'Rennen', Settings:'Einstellungen', 'Quick Picks':'Schnellauswahl' },
  pt: { Home:'Início', Search:'Pesquisar', Library:'Biblioteca', 'Liked Songs':'Favoritas', History:'Histórico', Race:'Corrida', Settings:'Configurações', 'Quick Picks':'Escolhas rápidas' },
  hi: { Home:'होम', Search:'खोज', Library:'लाइब्रेरी', 'Liked Songs':'पसंदीदा', History:'इतिहास', Race:'रेस', Settings:'सेटिंग्स', 'Quick Picks':'त्वरित चयन' },
};

function applyLanguage() {
  const lang = settings.lang || 'en';
  document.documentElement.setAttribute('lang', lang);
  const dict = I18N[lang] || I18N.en;
  // Translate nav items + known section titles by their original English text.
  $$('.nav-item span').forEach(span => {
    const orig = span.dataset.i18nOrig || span.textContent.trim();
    span.dataset.i18nOrig = orig;
    span.textContent = dict[orig] || orig;
  });
  $$('.quick-picks-header h3, .settings-section-title, .section-title').forEach(el => {
    const orig = el.dataset.i18nOrig || el.textContent.trim();
    if (!el.querySelector('i') && !el.querySelector('span')) { el.dataset.i18nOrig = orig; el.textContent = dict[orig] || orig; }
  });
}

let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('sv_settings')||'{}')); } catch(e){}
settings.custom = { ...DEFAULT_SETTINGS.custom, ...(settings.custom||{}) };

let state = {
  queue: [], currentIndex: -1, isPlaying: false, shuffle: false, repeat: 'off',
  liked: JSON.parse(localStorage.getItem('sv_liked')||'[]'),
  playlists: JSON.parse(localStorage.getItem('sv_playlists')||'[]'),
  recentSearches: JSON.parse(localStorage.getItem('sv_recent_searches')||'[]'),
  recentlyPlayed: JSON.parse(localStorage.getItem('sv_recent_played')||'[]'),
  currentPage: 'home', searchQuery: '', searchDebounce: null, activeFilter: 'all',
  nowPlayingOpen: false, rightPanelOpen: false, rightPanelTab: 'lyrics',
  searchActive: false, allSearchResults: [],
};

let player = null;
let progressInterval = null;

// Lyrics state
let lyricsData = null;        // { found, synced, source, lines }
let lyricsRows = [];          // [{ time, text, el, npEl }]
let lyricsActiveIndex = -1;
let lyricsReqId = 0;
let lyricsUserScrolledAt = 0;

function saveSettings() { localStorage.setItem('sv_settings', JSON.stringify(settings)); }

// Device scale: zoom the whole app to fit the chosen device.
const DEVICE_SCALE = { laptop: 1, tablet: 0.5, phone: 0.25 };
function applyDeviceScale() {
  const key = DEVICE_SCALE[settings.device] != null ? settings.device : 'laptop';
  const scale = DEVICE_SCALE[key];
  const shell = document.getElementById('appShell');
  // The now-playing overlay and race view live outside #appShell too; scale them together.
  const targets = ['appShell', 'nowPlaying', 'raceOverlay'];
  targets.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (scale === 1) {
      el.style.zoom = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.width = '';
      el.style.height = '';
    } else {
      el.style.zoom = scale;
      el.style.transformOrigin = 'top left';
      // Zoom shrinks layout box; compensate width/height so the app still fills the viewport.
      el.style.width = (100 / scale) + '%';
      el.style.height = (100 / scale) + 'vh';
    }
  });
  document.documentElement.setAttribute('data-device', key);
}

function applySettings() {
  const r = document.documentElement;
  const theme = settings.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark')
    : settings.theme;
  r.setAttribute('data-theme', theme);
  r.setAttribute('data-lite', settings.lite ? 'true' : 'false');
  r.setAttribute('data-density', settings.density);
  r.setAttribute('data-corners', settings.corners);
  r.setAttribute('data-font-size', settings.fontSize);
  r.setAttribute('data-font', settings.fontFamily || 'inter');
  r.setAttribute('data-glass', settings.glass ? 'true' : 'false');
  r.style.setProperty('--blur-strength', `${clamp(Number(settings.blurStrength) || 0, 0, 120)}px`);
  r.style.setProperty('--bg-dim', (clamp(Number(settings.bgDim ?? 50), 0, 100) / 100).toFixed(2));
  document.documentElement.style.setProperty('--seek-duration', settings.seekDuration);
  if (settings.accentColor !== 'auto') {
    const [h, s] = settings.accentColor.split(',');
    document.documentElement.style.setProperty('--accent-h', h);
    document.documentElement.style.setProperty('--accent-s', s);
  }
  applyBgStyle();
  applyLanguage();
  applyDeviceScale();
  applyCustom();
}

function applyCustom() {
  const r = document.documentElement;
  const c = settings.custom || {};
  const unset = k => r.style.removeProperty(k);

  // Accent from the Customize sliders (overrides album-art auto accent)
  if (c.accentH != null && c.accentH !== '') r.style.setProperty('--accent-h', c.accentH);
  if (c.accentSat != null && c.accentSat !== '') r.style.setProperty('--accent-s', c.accentSat + '%');
  if (c.accentLight != null && c.accentLight !== '') r.style.setProperty('--accent-l', c.accentLight + '%');

  // Full palette override
  r.toggleAttribute('data-custom-colors', !!c.useColors);
  const map = { '--bg-base': c.bg, '--bg-surface': c.surface, '--text-primary': c.text, '--border-default': c.border };
  Object.entries(map).forEach(([k, v]) => {
    if (c.useColors && v) r.style.setProperty(k, v);
    else unset(k);
  });

  // Corner radius scale
  const scale = (Number(c.radius) || 100) / 100;
  if (scale !== 1) {
    r.style.setProperty('--radius-sm', `${(6*scale).toFixed(2)}px`);
    r.style.setProperty('--radius-md', `${(10*scale).toFixed(2)}px`);
    r.style.setProperty('--radius-lg', `${(14*scale).toFixed(2)}px`);
    r.style.setProperty('--radius-xl', `${(20*scale).toFixed(2)}px`);
  } else {
    ['--radius-sm','--radius-md','--radius-lg','--radius-xl'].forEach(unset);
  }

  // Animation speed
  const spd = Number(c.animSpeed);
  if (spd === 0) {
    r.style.setProperty('--transition-fast', '0ms');
    r.style.setProperty('--transition-base', '0ms');
    r.style.setProperty('--transition-slow', '0ms');
    r.style.setProperty('--transition-spring', '0ms');
  } else if (spd && spd !== 100) {
    const f = 100 / spd;
    r.style.setProperty('--transition-fast', `${Math.round(100*f)}ms ease`);
    r.style.setProperty('--transition-base', `${Math.round(200*f)}ms ease`);
    r.style.setProperty('--transition-slow', `${Math.round(350*f)}ms ease`);
    r.style.setProperty('--transition-spring', `${Math.round(400*f)}ms cubic-bezier(0.34,1.56,0.64,1)`);
  } else {
    ['--transition-fast','--transition-base','--transition-slow','--transition-spring'].forEach(unset);
  }

  // Hover glow intensity
  const glow = (Number(c.glow) ?? 100) / 100;
  r.style.setProperty('--accent-glow', `hsla(var(--accent-h),var(--accent-s),var(--accent-l), ${(0.15*glow).toFixed(3)})`);
  r.style.setProperty('--accent-glow-strong', `hsla(var(--accent-h),var(--accent-s),var(--accent-l), ${(0.3*glow).toFixed(3)})`);

  // Grain overlay
  let grain = $('#grainOverlay');
  if (c.grain && !settings.lite) {
    if (!grain) { grain = document.createElement('div'); grain.id = 'grainOverlay'; grain.className = 'grain-overlay'; document.body.appendChild(grain); }
    grain.style.display = '';
  } else if (grain) grain.style.display = 'none';

  // Custom cursor
  r.toggleAttribute('data-cursor', !!c.cursor);

  // Glass tuning (blur + tint strength)
  r.style.setProperty('--glass-blur', `${clamp(Number(c.glassBlur ?? 16), 0, 40)}px`);
  const tint = clamp(Number(c.glassTint ?? 9), 0, 60) / 100;
  r.style.setProperty('--glass-a-card', tint.toFixed(3));
  r.style.setProperty('--glass-a-hover', Math.min(0.9, tint + 0.22).toFixed(3));
  r.style.setProperty('--glass-a-panel', Math.min(0.9, tint + 0.09).toFixed(3));

  // Hover effect style + intensity
  r.setAttribute('data-hover', c.hoverStyle || 'glow');
  const hi = clamp(Number(c.hoverIntensity ?? 100), 0, 200) / 100;
  r.style.setProperty('--hover-glow', `${(16 * hi).toFixed(1)}px`);
  r.style.setProperty('--hover-lift', `${(-3 * hi).toFixed(1)}px`);
  r.toggleAttribute('data-glow-border', !!c.glowBorder);

  // Custom CSS (infinite customization)
  let style = $('#customCssStyle');
  if (c.css && c.css.trim()) {
    if (!style) { style = document.createElement('style'); style.id = 'customCssStyle'; document.head.appendChild(style); }
    style.textContent = c.css;
  } else if (style) style.textContent = '';
}

function applyBgStyle() {
  const bg = $('#bgArtwork'), img = $('#bgArtImg'), vid = $('#bgVideo');
  if (!bg) return;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isLite = settings.lite || reduceMotion;
  bg.style.display = settings.bgStyle === 'none' ? 'none' : '';
  img.style.display = ''; vid.style.display = 'none'; vid.pause();

  // An explicitly chosen video background plays, even under Reduce-Motion.
  // Lite Mode (for low-end devices) stops it, since video is heavy.
  if (settings.bgStyle === 'video' && settings.videoBgUrl && !settings.lite) {
    img.style.display = 'none';
    if (vid.getAttribute('src') !== settings.videoBgUrl) vid.src = settings.videoBgUrl;
    vid.muted = true; vid.loop = true; vid.playsInline = true;
    vid.style.display = '';
    vid.play().catch(() => {});
    return;
  }

  if (isLite || settings.bgStyle === 'none' || settings.bgStyle === 'solid') { img.style.display = 'none'; return; }
}

function detectPerformance() {
  if (settings.perfPreset !== 'auto') return;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const conn = navigator.connection;
  const slow = conn && (conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g');
  if (mem <= 2 || cores <= 2 || slow) {
    settings.lite = true; saveSettings(); applySettings();
    showToast('Lite Mode enabled for better performance');
  }
}

function showToast(msg) {
  if (!settings.toasts) return;
  const c = $('#toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  c.appendChild(t); setTimeout(() => t.remove(), 3000);
}

function toggleLite(force) {
  settings.lite = force == null ? !settings.lite : !!force;
  settings.perfPreset = 'manual';
  saveSettings(); applySettings(); syncSettingsUI();
  // Lite mode must stop every animation, including the race rAF loop.
  if (typeof RaceUI !== 'undefined') {
    if (settings.lite && RaceUI.open) { cancelAnimationFrame(RaceUI.raf); RaceUI.raf = 0; }
    else if (!settings.lite && RaceUI.open && !RaceUI.raf) { RaceUI.last = performance.now(); RaceUI.raf = requestAnimationFrame(RaceUI.tick.bind(RaceUI)); }
  }
  showToast(settings.lite ? 'Lite Mode ON — animations off, audio unaffected' : 'Lite Mode OFF');
}

function cycleTheme() {
  const modes = ['dark', 'light', 'amoled', 'auto'];
  settings.theme = modes[(modes.indexOf(settings.theme) + 1) % modes.length];
  saveSettings(); applySettings(); syncSettingsUI();
  showToast(`Theme: ${settings.theme}`);
}

let minimized = false;
function toggleMinimize() {
  minimized = !minimized;
  document.documentElement.toggleAttribute('data-minimized', minimized);
  const btn = $('#minimizeBtn');
  if (btn) {
    btn.classList.toggle('active', minimized);
    btn.setAttribute('aria-pressed', minimized ? 'true' : 'false');
    btn.title = minimized ? 'Restore (H)' : 'Minimize (H)';
    btn.innerHTML = `<i class="fas fa-window-${minimized ? 'maximize' : 'minimize'}"></i>`;
  }
  showToast(minimized ? 'Content minimized' : 'Content restored');
}

function updateQuickActions() {
  const lite = $('#liteToggle');
  if (lite) {
    lite.classList.toggle('active', settings.lite);
    lite.setAttribute('aria-pressed', settings.lite ? 'true' : 'false');
    lite.title = settings.lite ? 'Lite Mode: ON (B)' : 'Lite Mode: OFF (B)';
  }
}

function attachRipples() {
  const sel = '.btn, .btn-icon, .ctrl-btn, .nav-item, .card-action-btn, .settings-tab, .filter-tab, .mood-card, .track-card';
  document.addEventListener('pointerdown', e => {
    if (settings.lite) return;
    const el = e.target.closest(sel);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.2;
    const r = document.createElement('span');
    r.className = 'ripple';
    r.style.width = r.style.height = size + 'px';
    r.style.left = (e.clientX - rect.left - size / 2) + 'px';
    r.style.top = (e.clientY - rect.top - size / 2) + 'px';
    el.appendChild(r);
    setTimeout(() => r.remove(), 600);
  });
}

function extractColors(img) {
  if (settings.accentColor !== 'auto' || settings.lite) return;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    c.width = 64; c.height = 64;
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let r=0,g=0,b=0,n=0;
    for (let i = 0; i < d.length; i += 16) { r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
    r=Math.round(r/n); g=Math.round(g/n); b=Math.round(b/n);
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    let h=0,s=0;
    if (max!==min) { const d2=max-min; s=d2/(max+min>510?(510-max-min):(max+min)); if(max===r)h=((g-b)/d2+(g<b?6:0))/6; else if(max===g)h=((b-r)/d2+2)/6; else h=((r-g)/d2+4)/6; }
    h=Math.round(h*360); s=Math.round(s*100);
    document.documentElement.style.setProperty('--accent-h', h);
    document.documentElement.style.setProperty('--accent-s', s+'%');
    const overlay = $('#accentOverlay');
    if (overlay) overlay.style.background = `hsl(${h},${s}%,50%)`;
  } catch(e){}
}

// === NAVIGATION ===
function navigateTo(page) {
  if (page === 'race') { RaceUI.toggle(); return; }
  state.currentPage = page;
  if (page === 'home' && state.searchActive) clearSearch();
  $$('.page').forEach(p => p.classList.remove('active'));
  const el = $(`#page-${page}`);
  if (el) el.classList.add('active');
  $$('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
    n.setAttribute('aria-current', n.dataset.page === page ? 'page' : 'false');
  });
  if (page === 'liked') renderLiked();
  if (page === 'library') renderLibrary();
  if (page === 'home') loadHome();
  if (page === 'history') renderHistory();
  if (page === 'search-page') renderSearchPage();
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeHtml(text).replace(new RegExp(`(${escaped})`,'gi'), '<span class="highlight-match">$1</span>');
}

function createTrackCard(track, query) {
  const d = document.createElement('div');
  d.className = 'track-card';
  d.setAttribute('tabindex', '0');
  d.setAttribute('role', 'button');
  d.setAttribute('aria-label', `${track.title} by ${track.author}`);
  d.innerHTML = `
    <div class="art-wrap">
      <img src="${track.thumbnail}" alt="" loading="lazy">
      <div class="play-overlay"><div class="play-icon"><i class="fas fa-play"></i></div></div>
      <div class="card-actions">
        <button class="card-action-btn" data-action="like" title="Like"><i class="${isLiked(track.id)?'fas':'far'} fa-heart"></i></button>
        <button class="card-action-btn" data-action="queue" title="Add to queue"><i class="fas fa-plus"></i></button>
      </div>
    </div>
    <div class="card-title">${query ? highlightText(track.title, query) : escapeHtml(track.title)}</div>
    <div class="card-artist">${query ? highlightText(track.author, query) : escapeHtml(track.author)}${track.source === 'soundcloud' ? ' <span class="src-badge">SC</span>' : ''}</div>`;
  const artImg = d.querySelector('.art-wrap img');
  if (artImg) artImg.addEventListener('error', () => { artImg.style.opacity = '0'; });
  d.querySelector('.art-wrap').addEventListener('click', e => {
    if (e.target.closest('.card-action-btn')) return;
    playNow(track);
  });
  d.addEventListener('keydown', e => { if (e.key === 'Enter') playNow(track); });
  d.querySelector('[data-action="like"]').addEventListener('click', e => {
    e.stopPropagation(); toggleLike(track);
    e.currentTarget.querySelector('i').className = isLiked(track.id) ? 'fas fa-heart' : 'far fa-heart';
  });
  d.querySelector('[data-action="queue"]').addEventListener('click', e => {
    e.stopPropagation(); addToQueue(track); showToast('Added to queue');
  });
  return d;
}

function createPlaylistCard(track) {
  const d = document.createElement('div');
  d.className = 'playlist-card';
  d.innerHTML = `
    <div class="card-art">
      <img src="${track.thumbnail}" alt="" loading="lazy">
      <div class="play-overlay"><div class="play-icon"><i class="fas fa-play"></i></div></div>
    </div>
    <div class="card-title">${escapeHtml(track.title)}</div>
    <div class="card-subtitle">${escapeHtml(track.author)}</div>`;
  d.addEventListener('click', () => playNow(track));
  return d;
}

function isLiked(id) { return state.liked.some(t => t.id === id); }
function toggleLike(track) {
  const idx = state.liked.findIndex(t => t.id === track.id);
  if (idx >= 0) { state.liked.splice(idx, 1); showToast('Removed from Liked'); }
  else { state.liked.unshift(track); showToast('Added to Liked'); }
  localStorage.setItem('sv_liked', JSON.stringify(state.liked));
  updateLikeBtn();
  if (state.currentPage === 'liked') renderLiked();
}

function updateLikeBtn() {
  const cur = state.queue[state.currentIndex];
  if (!cur) return;
  const liked = isLiked(cur.id);
  ['#playerLikeBtn'].forEach(sel => {
    const btn = $(sel);
    if (btn) { btn.classList.toggle('liked', liked); btn.querySelector('i').className = liked ? 'fas fa-heart' : 'far fa-heart'; }
  });
}

function addToQueue(track) { state.queue.push(track); renderQueue(); }

function playNow(track) {
  // Playing a single track starts a fresh "radio" unless it's already part of
  // an explicit queue. Auto-advance then uses recommendations (similar songs /
  // same artist) instead of following whichever list the track came from
  // (e.g. the search results).
  const existing = state.queue.findIndex(t => t.id === track.id && (t.source || 'youtube') === (track.source || 'youtube'));
  if (existing >= 0) {
    state.currentIndex = existing;
  } else {
    state.queue = [track];
    state.currentIndex = 0;
  }
  loadAndPlay(track);
}

function playQueueIndex(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.currentIndex = i;
  loadAndPlay(state.queue[i]);
}

function loadAndPlay(track) {
  if (!player) { setTimeout(() => loadAndPlay(track), 200); return; }
  currentTrack = track;
  resumePos = null;
  if (settings.resume) {
    try {
      const r = JSON.parse(localStorage.getItem('sv_resume') || 'null');
      if (r && r.id === track.id && r.source === track.source && r.time > 3) resumePos = r.time;
    } catch (e) {}
  }
  if (track.source === 'soundcloud') playSoundCloud(track);
  else playYouTube(track.id);
  updatePlayerUI(track);
  updateMediaSession(track);
  if (settings.history) addToRecent(track);
  updateLikeBtn();
  renderQueue();
  loadLyrics(track);
  if (!settings.lite) extractColorsFromTrack(track);
}

function extractColorsFromTrack(track) {
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => extractColors(img);
  img.src = track.thumbnail;
}

function updatePlayerUI(track) {
  $('#playerTitle').textContent = track.title;
  $('#playerAuthor').textContent = track.author;
  $('#playerThumb').src = track.thumbnail;
  $('#npTitle').textContent = track.title;
  $('#npAuthor').textContent = track.author;
  $('#npArtwork').src = track.thumbnail;
  $('#npBgImg').src = track.thumbnail;
  $('#bgArtImg').src = track.thumbnail;
  updatePlayBtns();
}

function updatePlayBtns() {
  const icon = state.isPlaying ? 'fa-pause' : 'fa-play';
  ['#btnPlay','#npPlay'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.innerHTML = `<i class="fas ${icon}"></i>`;
  });
  const eq = $('#eqBars');
  if (eq) eq.classList.toggle('playing', state.isPlaying);
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.author,
    artwork: [{ src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' }],
  });
  navigator.mediaSession.setActionHandler('play', () => player?.playVideo());
  navigator.mediaSession.setActionHandler('pause', () => player?.pauseVideo());
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
}

function addToRecent(track) {
  state.recentlyPlayed = [track, ...state.recentlyPlayed.filter(t => t.id !== track.id)].slice(0, 50);
  localStorage.setItem('sv_recent_played', JSON.stringify(state.recentlyPlayed));
}

function playNext() {
  if (state.repeat === 'one' && state.currentIndex >= 0) { loadAndPlay(state.queue[state.currentIndex]); return; }
  if (state.shuffle) {
    let next = Math.floor(Math.random() * state.queue.length);
    while (next === state.currentIndex && state.queue.length > 1) next = Math.floor(Math.random() * state.queue.length);
    playQueueIndex(next); return;
  }
  if (state.currentIndex < state.queue.length - 1) playQueueIndex(state.currentIndex + 1);
  else if (state.repeat === 'all') playQueueIndex(0);
  else if (settings.autoplay) autoplayNext();
}

function playPrev() { if (state.currentIndex > 0) playQueueIndex(state.currentIndex - 1); }

function seekBy(seconds) {
  if (!player?.getCurrentTime || !player?.getDuration) return;
  player.seekTo(clamp(player.getCurrentTime() + seconds, 0, player.getDuration()), true);
}

let autoplayLoading = false;
async function autoplayNext() {
  const cur = state.queue[state.currentIndex];
  if (!cur) return;
  if (autoplayLoading) return;
  autoplayLoading = true;
  showToast('Finding similar songs…');
  try {
    const exclude = [
      ...state.queue.map(t => t.id),
      ...state.recentlyPlayed.slice(0, 25).map(t => t.id),
    ];
    const p = new URLSearchParams({
      artist: cur.author || '',
      title: cur.title || '',
      exclude: exclude.join(','),
      limit: '12',
    });
    const res = await fetch('/api/recommend?' + p.toString());
    const list = await res.json();
    const queued = new Set(state.queue.map(t => t.id));
    const picks = (Array.isArray(list) ? list : []).filter(t => t && t.id && t.id !== cur.id && !queued.has(t.id));
    if (!picks.length) { showToast('No recommendations found'); return; }
    const toAdd = picks.slice(0, 6);
    const startIdx = state.queue.length;
    toAdd.forEach(t => state.queue.push(t));
    renderQueue();
    playQueueIndex(startIdx);
  } catch (e) {
    showToast('Could not load recommendations');
  } finally {
    autoplayLoading = false;
  }
}

// === QUEUE RENDERING ===
function renderQueue() {
  const nowEl = $('#queueNow');
  const nextEl = $('#queueNext');
  const histEl = $('#queueHistory');
  if (!nowEl) return;

  const cur = state.queue[state.currentIndex];
  nowEl.innerHTML = cur ? `
    <div class="queue-item active">
      <img src="${cur.thumbnail}" alt="">
      <div class="qi-info"><div class="qi-title">${escapeHtml(cur.title)}</div><div class="qi-artist">${escapeHtml(cur.author)}</div></div>
    </div>` : '<p style="color:var(--text-tertiary);font-size:var(--text-xs);padding:var(--sp-2)">Nothing playing</p>';

  const upcoming = state.queue.slice(state.currentIndex + 1);
  nextEl.innerHTML = upcoming.length ? upcoming.map((t, i) => `
    <div class="queue-item" data-qi="${state.currentIndex + 1 + i}">
      <img src="${t.thumbnail}" alt="">
      <div class="qi-info"><div class="qi-title">${escapeHtml(t.title)}</div><div class="qi-artist">${escapeHtml(t.author)}</div></div>
      <button class="qi-remove" data-qr="${state.currentIndex + 1 + i}"><i class="fas fa-times"></i></button>
    </div>`).join('') : '<p style="color:var(--text-tertiary);font-size:var(--text-xs);padding:var(--sp-2)">Queue is empty</p>';

  const history = state.recentlyPlayed.slice(0, 10);
  histEl.innerHTML = history.length ? history.map(t => `
    <div class="queue-item" data-hid="${t.id}">
      <img src="${t.thumbnail}" alt="">
      <div class="qi-info"><div class="qi-title">${escapeHtml(t.title)}</div><div class="qi-artist">${escapeHtml(t.author)}</div></div>
    </div>`).join('') : '<p style="color:var(--text-tertiary);font-size:var(--text-xs);padding:var(--sp-2)">No history</p>';

  nextEl.querySelectorAll('[data-qi]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-qr]')) return;
      playQueueIndex(parseInt(el.dataset.qi));
    });
  });
  nextEl.querySelectorAll('[data-qr]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.qr);
      state.queue.splice(idx, 1);
      if (idx < state.currentIndex) state.currentIndex--;
      else if (idx === state.currentIndex) state.currentIndex = Math.min(state.currentIndex, state.queue.length - 1);
      renderQueue();
    });
  });
  histEl.querySelectorAll('[data-hid]').forEach(el => {
    el.addEventListener('click', () => {
      const track = state.recentlyPlayed.find(t => t.id === el.dataset.hid);
      if (track) playNow(track);
    });
  });
}

function renderLiked() {
  const c = $('#likedContent');
  $('#likedCount').textContent = `${state.liked.length} songs`;
  if (!state.liked.length) {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-heart"></i><h3>No liked songs yet</h3><p>Songs you like will appear here</p></div>';
    return;
  }
  c.innerHTML = '';
  const grid = document.createElement('div'); grid.className = 'track-grid';
  state.liked.forEach(t => grid.appendChild(createTrackCard(t)));
  c.appendChild(grid);
}

function renderHistory() {
  const c = $('#historyContent');
  $('#historyCount').textContent = `${state.recentlyPlayed.length} songs`;
  if (!state.recentlyPlayed.length) {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-clock-rotate-left"></i><h3>No history</h3><p>Recently played songs will appear here</p></div>';
    return;
  }
  c.innerHTML = '';
  const grid = document.createElement('div'); grid.className = 'track-grid';
  state.recentlyPlayed.forEach(t => grid.appendChild(createTrackCard(t)));
  c.appendChild(grid);
}

function renderLibrary() {
  const c = $('#libraryContent');
  if (!state.playlists.length) {
    c.innerHTML = '<div class="empty-state"><i class="fas fa-record-vinyl"></i><h3>No playlists yet</h3><p>Create a playlist to organize your music</p></div>';
    return;
  }
  c.innerHTML = '<div class="track-grid">' + state.playlists.map((p, i) => `
    <div class="track-card" data-pli="${i}" tabindex="0" style="cursor:pointer">
      <div class="art-wrap" style="background:var(--accent-soft);display:flex;align-items:center;justify-content:center">
        <i class="fas fa-music" style="font-size:2rem;color:var(--accent);opacity:0.5"></i>
      </div>
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-artist">${p.tracks.length} songs</div>
    </div>`).join('') + '</div>';
  c.querySelectorAll('[data-pli]').forEach(el => {
    el.addEventListener('click', () => openPlaylist(parseInt(el.dataset.pli)));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openPlaylist(parseInt(el.dataset.pli)); });
  });
}

function openPlaylist(idx) {
  const pl = state.playlists[idx];
  if (!pl) return;
  navigateTo('library');
  const c = $('#libraryContent');
  c.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-4)">
      <button class="btn btn-secondary btn-sm" id="plBack"><i class="fas fa-arrow-left"></i> Back</button>
      <h2 style="font-size:var(--text-xl);font-weight:700">${escapeHtml(pl.name)}</h2>
      <button class="btn btn-primary btn-sm" id="plPlayAll"><i class="fas fa-play"></i> Play All</button>
      <button class="btn btn-secondary btn-sm" id="plShuffle"><i class="fas fa-shuffle"></i> Shuffle</button>
      <button class="btn btn-secondary btn-sm" id="plDelete" style="color:#e74c3c"><i class="fas fa-trash"></i></button>
    </div>
    <div class="track-grid" id="plTracks"></div>`;
  $('#plBack').addEventListener('click', renderLibrary);
  $('#plPlayAll').addEventListener('click', () => {
    if (pl.tracks.length) { state.queue = [...pl.tracks]; state.currentIndex = 0; loadAndPlay(pl.tracks[0]); }
  });
  $('#plShuffle').addEventListener('click', () => {
    if (pl.tracks.length) {
      state.queue = [...pl.tracks].sort(() => Math.random() - 0.5);
      state.currentIndex = 0; loadAndPlay(state.queue[0]);
    }
  });
  $('#plDelete').addEventListener('click', () => {
    if (confirm('Delete this playlist?')) {
      state.playlists.splice(idx, 1);
      localStorage.setItem('sv_playlists', JSON.stringify(state.playlists));
      renderSidebarPlaylists(); renderLibrary(); showToast('Playlist deleted');
    }
  });
  const grid = $('#plTracks');
  if (!pl.tracks.length) grid.innerHTML = '<div class="empty-state"><p>No songs in this playlist</p></div>';
  else pl.tracks.forEach(t => grid.appendChild(createTrackCard(t)));
}

function renderSidebarPlaylists() {
  const c = $('#sidebarPlaylists');
  c.innerHTML = state.playlists.map((p, i) => `<div class="playlist-item" data-pli="${i}" tabindex="0">${escapeHtml(p.name)}</div>`).join('');
  c.querySelectorAll('[data-pli]').forEach(el => {
    el.addEventListener('click', () => openPlaylist(parseInt(el.dataset.pli)));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openPlaylist(parseInt(el.dataset.pli)); });
  });
}

// === POPOVER MENU ===
let activeMenu = null;
function onMenuDocClick(e) { if (activeMenu && !activeMenu.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  document.removeEventListener('click', onMenuDocClick, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
}

function showMenu(anchor, items, opts) {
  closeMenu();
  if (!anchor) return;
  const menu = document.createElement('div');
  menu.className = 'popover-menu';
  let html = (opts && opts.title) ? `<div class="popover-title">${escapeHtml(opts.title)}</div>` : '';
  items.forEach((it, i) => {
    if (it === '-') { html += '<div class="popover-sep"></div>'; return; }
    const icon = it.icon ? `<i class="fas fa-${it.icon}"></i>` : '<i class="far fa-circle" style="opacity:0"></i>';
    const hint = it.hint != null ? `<span class="popover-hint">${escapeHtml(String(it.hint))}</span>` : '';
    const check = it.checked ? '<i class="fas fa-check popover-check"></i>' : '';
    html += `<button class="popover-item${it.active ? ' active' : ''}" data-mi="${i}">${icon}<span>${escapeHtml(it.label)}</span>${hint}${check}</button>`;
  });
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = clamp(r.left + r.width / 2 - mw / 2, 8, window.innerWidth - mw - 8);
  let top = r.top - mh - 8;
  if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.querySelectorAll('[data-mi]').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = items[parseInt(btn.dataset.mi)];
      closeMenu();
      if (it && it.onClick) it.onClick();
    });
  });
  activeMenu = menu;
  setTimeout(() => {
    document.addEventListener('click', onMenuDocClick, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }, 0);
}

// === ADD TO PLAYLIST ===
function addTrackToPlaylist(idx, track) {
  const pl = state.playlists[idx];
  if (!pl || !track) return;
  if (pl.tracks.some(t => t.id === track.id && t.source === track.source)) {
    showToast(`Already in ${pl.name}`);
    return;
  }
  pl.tracks.push(track);
  localStorage.setItem('sv_playlists', JSON.stringify(state.playlists));
  renderSidebarPlaylists();
  if (state.currentPage === 'library') renderLibrary();
  showToast(`Added to ${pl.name}`);
}

function openAddToPlaylistMenu(anchor) {
  const track = state.queue[state.currentIndex];
  if (!track) { showToast('Nothing playing'); return; }
  const items = state.playlists.map((p, i) => ({
    label: p.name,
    icon: 'music',
    hint: p.tracks.length,
    checked: p.tracks.some(t => t.id === track.id && t.source === track.source),
    onClick: () => addTrackToPlaylist(i, track),
  }));
  if (items.length) items.push('-');
  items.push({ label: 'New playlist…', icon: 'plus', onClick: () => openPlaylistModal(-1, track) });
  showMenu(anchor, items, { title: 'Add to playlist' });
}

// === SLEEP TIMER ===
let sleepTimer = { mode: null, endsAt: 0, minutes: 0, tick: null };
const SLEEP_OPTIONS = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1 hour 30 min'], [120, '2 hours']];

function updateSleepBtn() {
  const btn = $('#btnSleep');
  const badge = $('#sleepBadge');
  if (btn) btn.classList.toggle('active', !!sleepTimer.mode);
  if (!badge) return;
  if (sleepTimer.mode === 'time') badge.textContent = formatTime(Math.max(0, Math.ceil((sleepTimer.endsAt - Date.now()) / 1000)));
  else if (sleepTimer.mode === 'end') badge.textContent = 'END';
  else badge.textContent = '';
}

function clearSleepTimer(silent) {
  if (sleepTimer.tick) clearInterval(sleepTimer.tick);
  sleepTimer = { mode: null, endsAt: 0, minutes: 0, tick: null };
  updateSleepBtn();
  if (!silent) showToast('Sleep timer turned off');
}

function fireSleepTimer() {
  try { player?.pauseVideo(); } catch (e) {}
  state.isPlaying = false;
  updatePlayBtns();
  stopProgress();
  clearSleepTimer(true);
  showToast('Sleep timer finished — playback paused');
}

function tickSleepTimer() {
  if (sleepTimer.mode !== 'time') return;
  if (Date.now() >= sleepTimer.endsAt) { fireSleepTimer(); return; }
  updateSleepBtn();
}

function setSleepTimer(opt) {
  clearSleepTimer(true);
  if (opt === 'end') {
    sleepTimer = { mode: 'end', endsAt: 0, minutes: 0, tick: null };
    updateSleepBtn();
    showToast('Sleep timer: pause at end of track');
    return;
  }
  const min = Number(opt) || 0;
  if (!min) return;
  sleepTimer = { mode: 'time', endsAt: Date.now() + min * 60000, minutes: min, tick: null };
  sleepTimer.tick = setInterval(tickSleepTimer, 1000);
  updateSleepBtn();
  const label = min >= 60 ? `${min / 60} hour${min > 60 ? 's' : ''}` : `${min} minutes`;
  showToast(`Sleep timer set for ${label}`);
}

function openSleepMenu(anchor) {
  const items = SLEEP_OPTIONS.map(([min, label]) => ({
    label, icon: 'clock',
    active: sleepTimer.mode === 'time' && sleepTimer.minutes === min,
    onClick: () => setSleepTimer(min),
  }));
  items.push('-');
  items.push({ label: 'End of track', icon: 'flag-checkered', active: sleepTimer.mode === 'end', onClick: () => setSleepTimer('end') });
  if (sleepTimer.mode) items.push({ label: 'Turn off timer', icon: 'xmark', onClick: () => clearSleepTimer() });
  showMenu(anchor, items, { title: 'Sleep timer' });
}

// === SEARCH ===
let searchAbort = null;

function clearSearch() {
  state.searchActive = false;
  state.allSearchResults = [];
  state.searchQuery = '';
  $('#searchInput').value = '';
  const overlay = $('#searchOverlay'), def = $('#homeDefault');
  if (overlay) overlay.style.display = 'none';
  if (def) def.style.display = '';
  const sug = $('#searchSuggestions');
  if (sug) sug.classList.remove('active');
}

async function doSearch(query) {
  if (!query.trim()) { clearSearch(); return; }
  // Search results may be triggered from any section; make sure the Home
  // page (which hosts the results overlay) is the active one. Navigate
  // BEFORE marking the search active so navigateTo doesn't clear it.
  if (state.currentPage !== 'home') navigateTo('home');
  state.searchQuery = query;
  state.searchActive = true;
  addRecentSearch(query);
  const overlay = $('#searchOverlay'), def = $('#homeDefault');
  const content = $('#searchResultsContent'), title = $('#searchResultsTitle');
  def.style.display = 'none'; overlay.style.display = '';
  title.textContent = `Results for "${query}"`;
  content.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  const sug = $('#searchSuggestions');
  if (sug) sug.classList.remove('active');
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: searchAbort.signal });
    const data = await res.json();
    state.allSearchResults = data;
    state.activeFilter = 'all';
    renderSearchResults();
    updateTabIndicator();
  } catch(e) {
    if (e.name === 'AbortError') return;
    content.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Search failed</h3><p>Please try again</p></div>';
  }
}

function renderSearchResults() {
  const content = $('#searchResultsContent');
  const data = state.allSearchResults;
  const q = state.searchQuery;
  const filter = state.activeFilter;
  content.innerHTML = '';
  if (!data.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><h3>No results for "${escapeHtml(q)}"</h3><p>Try different keywords</p></div>`;
    return;
  }
  const songs = data;
  const topResult = songs[0];
  if (filter === 'all') {
    const layout = document.createElement('div');
    layout.style.cssText = 'display:grid;grid-template-columns:1fr 1.5fr;gap:var(--sp-5);align-items:start';
    const topCard = document.createElement('div');
    topCard.className = 'top-result-card';
    topCard.innerHTML = `
      <img src="${topResult.thumbnail}" alt="">
      <div class="top-result-info">
        <h3>${highlightText(topResult.title, q)}</h3>
        <p>${highlightText(topResult.author, q)}</p>
        <span class="top-result-badge">Top Result</span>
      </div>`;
    topCard.addEventListener('click', () => playNow(topResult));
    layout.appendChild(topCard);
    const songsSection = document.createElement('div');
    songsSection.innerHTML = `<h3 style="font-size:var(--text-base);font-weight:600;margin-bottom:var(--sp-3)">Songs</h3>`;
    const songList = document.createElement('div');
    songs.slice(0, 5).forEach(t => {
      const row = document.createElement('div');
      row.className = 'search-song-row';
      row.innerHTML = `
        <img src="${t.thumbnail}" alt="">
        <div class="ssr-info">
          <div class="ssr-title">${highlightText(t.title, q)}</div>
          <div class="ssr-artist">${highlightText(t.author, q)}</div>
        </div>
        <span class="ssr-dur">${formatTime(t.length)}</span>`;
      row.addEventListener('click', () => playNow(t));
      songList.appendChild(row);
    });
    songsSection.appendChild(songList);
    layout.appendChild(songsSection);
    content.appendChild(layout);
    if (songs.length > 5) {
      const more = document.createElement('div');
      more.style.marginTop = 'var(--sp-5)';
      more.innerHTML = `<h3 style="font-size:var(--text-base);font-weight:600;margin-bottom:var(--sp-3)">More Results</h3>`;
      const grid = document.createElement('div'); grid.className = 'track-grid';
      songs.slice(5).forEach(t => grid.appendChild(createTrackCard(t, q)));
      more.appendChild(grid);
      content.appendChild(more);
    }
  } else if (filter === 'songs') {
    const grid = document.createElement('div'); grid.className = 'track-grid';
    songs.forEach(t => grid.appendChild(createTrackCard(t, q)));
    content.appendChild(grid);
  } else if (filter === 'artists') {
    const artists = [...new Map(songs.map(t => [t.author, t])).values()];
    const grid = document.createElement('div'); grid.className = 'track-grid';
    artists.slice(0, 8).forEach(t => {
      const d = document.createElement('div');
      d.className = 'track-card'; d.style.textAlign = 'center';
      d.innerHTML = `
        <div class="art-wrap" style="border-radius:50%;aspect-ratio:1;margin-bottom:var(--sp-2)">
          <img src="${t.thumbnail}" alt="" style="border-radius:50%">
        </div>
        <div class="card-title">${highlightText(t.author, q)}</div>
        <div class="card-artist">Artist</div>`;
      d.addEventListener('click', () => { $('#searchInput').value = t.author; doSearch(t.author); });
      grid.appendChild(d);
    });
    content.appendChild(grid);
  }
}

function updateTabIndicator() {
  const tabs = $$('#filterTabs .filter-tab');
  const indicator = $('#tabIndicator');
  if (!indicator || !tabs.length) return;
  const active = tabs.find(t => t.dataset.filter === state.activeFilter) || tabs[0];
  tabs.forEach(t => { t.classList.toggle('active', t.dataset.filter === state.activeFilter); });
  const rect = active.getBoundingClientRect();
  const parent = active.parentElement.getBoundingClientRect();
  indicator.style.width = rect.width + 'px';
  indicator.style.transform = `translateX(${rect.left - parent.left - 2}px)`;
}

function addRecentSearch(q) {
  if (!settings.searchHistory) return;
  state.recentSearches = [q, ...state.recentSearches.filter(s => s !== q)].slice(0, 10);
  localStorage.setItem('sv_recent_searches', JSON.stringify(state.recentSearches));
}

function renderRecentSearches() {
  const sug = $('#searchSuggestions');
  if (!sug) return;
  if (!state.recentSearches.length || !settings.searchHistory) {
    sug.innerHTML = '<p style="color:var(--text-tertiary);font-size:var(--text-sm);padding:var(--sp-4);text-align:center">Search for songs, artists...</p>';
    return;
  }
  sug.innerHTML = '<div style="padding:4px 8px;font-size:var(--text-xs);color:var(--text-tertiary);font-weight:600">Recent Searches</div>' +
    state.recentSearches.map(q => `
      <div class="search-suggestion-item" data-rs="${escapeHtml(q)}" role="option">
        <i class="fas fa-clock" style="color:var(--text-tertiary);width:16px;text-align:center;font-size:0.75rem"></i>
        <span style="flex:1;font-size:var(--text-sm)">${escapeHtml(q)}</span>
        <button class="suggestion-delete" data-del="${escapeHtml(q)}" aria-label="Remove"><i class="fas fa-times"></i></button>
      </div>`).join('');
  sug.querySelectorAll('[data-rs]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.suggestion-delete')) return;
      $('#searchInput').value = el.dataset.rs;
      doSearch(el.dataset.rs); sug.classList.remove('active');
    });
  });
  sug.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.recentSearches = state.recentSearches.filter(s => s !== btn.dataset.del);
      localStorage.setItem('sv_recent_searches', JSON.stringify(state.recentSearches));
      renderRecentSearches();
    });
  });
}

// === MOODS ===
const MOODS = [
  { id: 'happy', name: 'Happy', icon: '😊', query: 'happy upbeat songs', gradient: 'linear-gradient(135deg, #FFD700, #FF8C00)' },
  { id: 'chill', name: 'Chill', icon: '😌', query: 'chill lofi relaxing music', gradient: 'linear-gradient(135deg, #4ECDC4, #45B7AF)' },
  { id: 'sad', name: 'Sad', icon: '😢', query: 'sad emotional songs', gradient: 'linear-gradient(135deg, #667eea, #764ba2)' },
  { id: 'romantic', name: 'Romantic', icon: '💕', query: 'romantic love songs', gradient: 'linear-gradient(135deg, #f093fb, #f5576c)' },
  { id: 'energetic', name: 'Energetic', icon: '⚡', query: 'energetic workout songs', gradient: 'linear-gradient(135deg, #f5af19, #f12711)' },
  { id: 'pop', name: 'Pop', icon: '🎵', query: 'pop music hits', gradient: 'linear-gradient(135deg, #a18cd1, #fbc2eb)' },
  { id: 'rock', name: 'Rock', icon: '🎸', query: 'rock music classics', gradient: 'linear-gradient(135deg, #2C3E50, #4CA1AF)' },
  { id: 'hiphop', name: 'Hip Hop', icon: '🎤', query: 'hip hop rap songs', gradient: 'linear-gradient(135deg, #141E30, #243B55)' },
  { id: 'edm', name: 'EDM', icon: '🎧', query: 'edm dance electronic music', gradient: 'linear-gradient(135deg, #00c6ff, #0072ff)' },
  { id: 'indie', name: 'Indie', icon: '🌙', query: 'indie alternative songs', gradient: 'linear-gradient(135deg, #3a7bd5, #3a6073)' },
  { id: 'focus', name: 'Focus', icon: '🧠', query: 'focus study instrumental music', gradient: 'linear-gradient(135deg, #2C3E50, #3498DB)' },
  { id: 'sleep', name: 'Sleep', icon: '😴', query: 'sleep ambient calm music', gradient: 'linear-gradient(135deg, #0F2027, #2C5364)' },
];

function renderMoodGrid() {
  const grid = $('#moodGrid');
  if (!grid || grid.children.length > 0) return;
  MOODS.forEach(mood => {
    const card = document.createElement('div');
    card.className = 'mood-card';
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${mood.name} music`);
    card.innerHTML = `<div class="mood-bg" style="background:${mood.gradient}"></div><div class="mood-label"><div class="mood-icon">${mood.icon}</div><div class="mood-name">${mood.name}</div></div>`;
    card.addEventListener('click', () => loadMood(mood));
    card.addEventListener('keydown', e => { if (e.key === 'Enter') loadMood(mood); });
    grid.appendChild(card);
  });
}

function renderBrowseGrid() {
  const grid = $('#browseGrid');
  if (!grid || grid.children.length > 0) return;
  MOODS.forEach(mood => {
    const card = document.createElement('div');
    card.className = 'mood-card';
    card.setAttribute('tabindex', '0');
    card.innerHTML = `<div class="mood-bg" style="background:${mood.gradient}"></div><div class="mood-label"><div class="mood-icon">${mood.icon}</div><div class="mood-name">${mood.name}</div></div>`;
    card.addEventListener('click', () => { navigateTo('home'); loadMood(mood); });
    grid.appendChild(card);
  });
}

async function loadMood(mood) {
  const section = $('#moodSection'), resultsSection = $('#moodResultsSection');
  const grid = $('#moodResultsGrid'), title = $('#moodResultsTitle');
  section.style.display = 'none';
  resultsSection.style.display = '';
  title.textContent = `${mood.icon} ${mood.name}`;
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(mood.query)}`);
    const data = await res.json();
    grid.innerHTML = '';
    data.forEach(t => grid.appendChild(createTrackCard(t)));
  } catch(e) {
    grid.innerHTML = '<div class="empty-state"><p>Could not load songs</p></div>';
  }
}

async function loadHome() {
  const greeting = $('#greeting');
  const h = new Date().getHours();
  greeting.textContent = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  renderMoodGrid();
  loadQuickPicks();
  loadRecentScroll();
}

async function loadRecentScroll() {
  const row = $('#recentScroll');
  const section = $('#recentSection');
  if (!row || !state.recentlyPlayed.length) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';
  row.innerHTML = '';
  state.recentlyPlayed.slice(0, 10).forEach(t => row.appendChild(createPlaylistCard(t)));
}

async function loadQuickPicks() {
  const grid = $('#quickPicksGrid');
  if (!grid) return;
  if (state.recentlyPlayed.length >= 6) {
    grid.innerHTML = '';
    state.recentlyPlayed.slice(0, 6).forEach(t => {
      const row = document.createElement('div');
      row.className = 'quick-pick-row';
      row.innerHTML = `
        <img src="${t.thumbnail}" alt="">
        <div class="qp-info">
          <div class="qp-title">${escapeHtml(t.title)}</div>
          <div class="qp-artist">${escapeHtml(t.author)}</div>
        </div>
        <div class="qp-duration">${formatTime(t.length)}</div>`;
      row.addEventListener('click', () => playNow(t));
      grid.appendChild(row);
    });
    return;
  }
  grid.innerHTML = Array(6).fill('<div class="skeleton" style="height:52px"></div>').join('');
  try {
    const res = await fetch('/api/search?q=popular+songs+2024');
    const data = await res.json();
    grid.innerHTML = '';
    data.slice(0, 6).forEach(t => {
      const row = document.createElement('div');
      row.className = 'quick-pick-row';
      row.innerHTML = `
        <img src="${t.thumbnail}" alt="">
        <div class="qp-info">
          <div class="qp-title">${escapeHtml(t.title)}</div>
          <div class="qp-artist">${escapeHtml(t.author)}</div>
        </div>
        <div class="qp-duration">${formatTime(t.length)}</div>`;
      row.addEventListener('click', () => playNow(t));
      grid.appendChild(row);
    });
  } catch(e) {
    grid.innerHTML = '<p style="color:var(--text-tertiary);font-size:var(--text-sm)">Could not load suggestions</p>';
  }
}



function renderSearchPage() {
  renderBrowseGrid();
}

// === PLAYER ===
function onPlayerStateChange(e) {
  if (e.data === YTS.ENDED) {
    clearResumePos();
    if (sleepTimer.mode === 'end') { fireSleepTimer(); return; }
    playNext();
  }
  else if (e.data === YTS.PLAYING) {
    state.isPlaying = true; updatePlayBtns(); startProgress();
    fadeInVolume();
    const npArt = $('#npArtwork'); if (npArt) npArt.classList.add('playing');
    if (resumePos != null && player?.seekTo) {
      try { player.seekTo(resumePos, true); } catch (err) {}
      resumePos = null;
    }
  } else if (e.data === YTS.PAUSED) {
    state.isPlaying = false; updatePlayBtns(); stopProgress(); saveResumePos();
    const npArt = $('#npArtwork'); if (npArt) npArt.classList.remove('playing');
  }
}

function saveResumePos() {
  if (!settings.resume || !currentTrack || !player?.getCurrentTime) return;
  try {
    const t = player.getCurrentTime();
    if (t > 3) localStorage.setItem('sv_resume', JSON.stringify({ id: currentTrack.id, source: currentTrack.source, time: t }));
  } catch (e) {}
}
function clearResumePos() { try { localStorage.removeItem('sv_resume'); } catch (e) {} resumePos = null; }

function startProgress() {
  stopProgress(); resumeSaveTick = 0; crossfading = false;
  progressInterval = setInterval(() => {
    if (!player?.getDuration) return;
    const dur = player.getDuration();
    const cur = player.getCurrentTime();
    const pct = dur ? (cur / dur * 100) : 0;
    ['#progressFill','#npProgressFill'].forEach(sel => { const el = $(sel); if (el) el.style.width = pct + '%'; });
    ['#currentTime','#npCurrentTime'].forEach(sel => { const el = $(sel); if (el) el.textContent = formatTime(cur); });
    ['#totalTime','#npTotalTime'].forEach(sel => { const el = $(sel); if (el) el.textContent = formatTime(dur); });
    updateActiveLyric(cur);
    if (settings.resume && ++resumeSaveTick % 8 === 0) saveResumePos();
    // Crossfade: fade the current track out over the configured seconds
    const cf = Number(settings.crossfade) || 0;
    if (cf > 0 && dur && !settings.lite) {
      const remaining = dur - cur;
      if (remaining <= cf && remaining > 0) {
        crossfading = true;
        const base = parseInt($('#volumeSlider')?.value ?? 100);
        player.setVolume(clamp(Math.round(base * (remaining / cf)), 0, 100));
      }
    }
  }, 250);
}

// Fade the freshly-started track back up to the user's volume.
function fadeInVolume() {
  const base = parseInt($('#volumeSlider')?.value ?? 100);
  if (!(Number(settings.crossfade) > 0) || settings.lite || !player?.setVolume) return;
  let v = 0;
  player.setVolume(0);
  const step = Math.max(5, Math.round(base / 10));
  const iv = setInterval(() => {
    v += step;
    if (v >= base || state.isPlaying === false) { player.setVolume(base); clearInterval(iv); return; }
    player.setVolume(v);
  }, 100);
}

function stopProgress() { if (progressInterval) clearInterval(progressInterval); }

function seekTo(pct) {
  if (!player?.getDuration) return;
  player.seekTo(player.getDuration() * pct, true);
}

function setupSeek(wrapId) {
  const wrap = $(wrapId);
  if (!wrap) return;
  let seeking = false;
  const getPercent = e => { const r = wrap.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  wrap.addEventListener('mousedown', e => { seeking = true; seekTo(getPercent(e)); });
  document.addEventListener('mousemove', e => { if (seeking) seekTo(getPercent(e)); });
  document.addEventListener('mouseup', () => seeking = false);
  wrap.addEventListener('touchstart', e => { seeking = true; seekTo(getPercent(e.touches[0])); }, { passive: true });
  wrap.addEventListener('touchmove', e => { if (seeking) seekTo(getPercent(e.touches[0])); }, { passive: true });
  document.addEventListener('touchend', () => seeking = false);
}

function setupVolume() {
  const slider = $('#volumeSlider');
  const btn = $('#btnVolume');
  if (!slider) return;
  slider.addEventListener('input', () => { if (player) player.setVolume(parseInt(slider.value)); updateVolumeIcon(); });
  btn.addEventListener('click', () => {
    if (!player) return;
    if (player.isMuted()) { player.unMute(); slider.value = player.getVolume(); }
    else { player.mute(); slider.value = 0; }
    updateVolumeIcon();
  });
  // Scroll wheel over the player volume area adjusts volume
  const zone = $('#playerBar') || $('.player-right');
  if (zone) {
    zone.addEventListener('wheel', e => {
      if (!settings.scrollVolume) return;
      if (e.target.closest('input, select, textarea')) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 5 : -5;
      const v = clamp(parseInt(slider.value) + step, 0, 100);
      slider.value = v;
      if (player) player.setVolume(v);
      updateVolumeIcon();
    }, { passive: false });
  }
}

function updateVolumeIcon() {
  const v = parseInt($('#volumeSlider').value);
  const icon = v === 0 ? 'fa-volume-xmark' : v < 40 ? 'fa-volume-low' : 'fa-volume-high';
  $('#btnVolume').innerHTML = `<i class="fas ${icon}"></i>`;
}

// === RIGHT PANEL ===
function toggleRightPanel(tab) {
  if (state.rightPanelOpen && (!tab || state.rightPanelTab === tab)) {
    state.rightPanelOpen = false;
  } else {
    state.rightPanelOpen = true;
    state.rightPanelTab = tab || state.rightPanelTab;
  }
  const panel = $('#rightPanel');
  const shell = $('#appShell');
  panel.classList.toggle('open', state.rightPanelOpen);
  shell.classList.toggle('right-panel-open', state.rightPanelOpen);
  $$('.right-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.rptab === state.rightPanelTab));
  $('#rpLyrics').style.display = state.rightPanelTab === 'lyrics' ? '' : 'none';
  $('#rpQueue').style.display = state.rightPanelTab === 'queue' ? '' : 'none';
  if (state.rightPanelOpen && state.rightPanelTab === 'queue') renderQueue();
  if (state.rightPanelOpen && state.rightPanelTab === 'lyrics') setTimeout(scrollActiveLyricIntoView, 60);
}

function toggleNowPlaying(show) {
  state.nowPlayingOpen = show ?? !state.nowPlayingOpen;
  $('#nowPlaying').classList.toggle('active', state.nowPlayingOpen);
  if (state.nowPlayingOpen) setTimeout(scrollActiveLyricIntoView, 200);
}

// === SETTINGS ===
function setupSettings() {
  const s = settings;
  const bind = (id, key, evt='change') => {
    const el = $(id); if (!el) return;
    if (el.type === 'checkbox') el.checked = s[key];
    else el.value = s[key];
    el.addEventListener(evt, () => {
      s[key] = el.type === 'checkbox' ? el.checked : el.value;
      saveSettings(); applySettings(); syncSettingsUI();
    });
  };
  bind('#settingTheme', 'theme');
  bind('#settingBgStyle', 'bgStyle');
  $('#settingBgStyle')?.addEventListener('change', () => toggleVideoBgOptions());
  bind('#settingDensity', 'density');
  bind('#settingCorners', 'corners');
  bind('#settingFontSize', 'fontSize');
  bind('#settingFontFamily', 'fontFamily');
  bind('#settingGlass', 'glass');
  bind('#settingBlur', 'blurStrength', 'input');
  bind('#settingBgDim', 'bgDim', 'input');
  bind('#settingAutoplay', 'autoplay');
  bind('#settingCrossfade', 'crossfade', 'input');
  bind('#settingAudioQuality', 'audioQuality');
  const aqSel = $('#settingAudioQuality');
  if (aqSel) aqSel.addEventListener('change', applyQuality);
  bind('#settingSeekDuration', 'seekDuration');
  bind('#settingScrollVolume', 'scrollVolume');
  bind('#settingToasts', 'toasts');
  bind('#settingStartup', 'startup');
  bind('#settingLang', 'lang');
  bind('#settingDevice', 'device');
  bind('#settingHistory', 'history');
  bind('#settingResume', 'resume');
  bind('#settingSearchHistory', 'searchHistory');

  // Lite Mode toggle (marks performance as manual so auto-detect won't override)
  const liteEl = $('#settingLite');
  if (liteEl) {
    liteEl.checked = s.lite;
    liteEl.addEventListener('change', () => toggleLite(liteEl.checked));
  }

  // Auto performance detection
  const autoPerf = $('#settingAutoPerf');
  if (autoPerf) {
    autoPerf.checked = s.perfPreset === 'auto';
    autoPerf.addEventListener('change', () => {
      s.perfPreset = autoPerf.checked ? 'auto' : 'manual';
      saveSettings();
      if (autoPerf.checked) { detectPerformance(); syncSettingsUI(); }
      showToast(autoPerf.checked ? 'Auto performance detection ON' : 'Auto performance detection OFF');
    });
  }

  const applyAccent = (h, sat) => {
    s.accentColor = `${h},${sat}%`;
    document.documentElement.style.setProperty('--accent-h', h);
    document.documentElement.style.setProperty('--accent-s', sat + '%');
    $$('#accentSwatches .color-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.color === s.accentColor));
    saveSettings();
  };

  $$('#accentSwatches .color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      $$('.color-swatch').forEach(s2 => s2.classList.remove('active'));
      sw.classList.add('active');
      s.accentColor = sw.dataset.color;
      if (sw.dataset.color === 'auto') {
        document.documentElement.style.removeProperty('--accent-h');
        document.documentElement.style.removeProperty('--accent-s');
      } else {
        const [h, sat] = sw.dataset.color.split(',');
        document.documentElement.style.setProperty('--accent-h', h);
        document.documentElement.style.setProperty('--accent-s', sat);
        const hue = $('#settingAccentHue'), satEl = $('#settingAccentSat');
        if (hue) hue.value = parseFloat(h);
        if (satEl) satEl.value = parseFloat(sat);
      }
      saveSettings();
    });
  });

  const hueEl = $('#settingAccentHue'), satEl = $('#settingAccentSat');
  const syncAccentSliders = () => {
    if (s.accentColor === 'auto' || !s.accentColor) return;
    const [h, sat] = s.accentColor.split(',');
    if (hueEl && h) hueEl.value = parseFloat(h);
    if (satEl && sat) satEl.value = parseFloat(sat);
  };
  syncAccentSliders();
  const onAccentSlider = () => { if (hueEl && satEl) applyAccent(hueEl.value, satEl.value); };
  hueEl?.addEventListener('input', onAccentSlider);
  satEl?.addEventListener('input', onAccentSlider);

  // Settings tabs
  $$('#settingsTabs .settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('#settingsTabs .settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.dataset.tab;
      $$('.settings-section[data-tab]').forEach(sec => {
        const on = sec.dataset.tab === tabName;
        sec.classList.toggle('tab-visible', on);
        sec.style.display = on ? 'block' : 'none';
      });
    });
  });
  // Show default tab
  $$('.settings-section[data-tab="general"]').forEach(s => { s.classList.add('tab-visible'); s.style.display = 'block'; });

  // Settings search
  $('#settingsSearchInput')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('.setting-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  });

  // Reset / Export / Import
  $('#resetSettings')?.addEventListener('click', () => {
    if (confirm('Reset all settings to defaults?')) {
      Object.assign(s, DEFAULT_SETTINGS); saveSettings(); applySettings(); syncSettingsUI(); showToast('Settings reset');
    }
  });
  $('#exportSettings')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'amg-settings.json'; a.click();
    URL.revokeObjectURL(url);
  });
  $('#importSettings')?.addEventListener('click', () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      try {
        const text = await input.files[0].text();
        Object.assign(s, DEFAULT_SETTINGS, JSON.parse(text));
        saveSettings(); applySettings(); syncSettingsUI(); showToast('Settings imported');
      } catch(e) { showToast('Invalid settings file'); }
    };
    input.click();
  });

  // Clear all data
  $('#clearAllData')?.addEventListener('click', () => {
    if (confirm('This will delete all settings, playlists, history, and liked songs. Continue?')) {
      localStorage.clear(); location.reload();
    }
  });

  // Clear history
  $('#clearHistory')?.addEventListener('click', () => {
    if (confirm('Clear all listening history?')) {
      state.recentlyPlayed = [];
      localStorage.setItem('sv_recent_played', '[]');
      renderHistory(); showToast('History cleared');
    }
  });

  // Clear recent searches
  $('#clearSearchHistory')?.addEventListener('click', () => {
    state.recentSearches = [];
    localStorage.setItem('sv_recent_searches', '[]');
    renderRecentSearches(); showToast('Recent searches cleared');
  });

  // Video background quick buttons (always visible in Appearance)
  $('#videoBgUploadBtn')?.addEventListener('click', () => {
    s.bgStyle = 'video'; saveSettings(); applySettings(); syncSettingsUI(); toggleVideoBgOptions();
    $('#videoFileInput')?.click();
  });
  $('#videoBgUrlBtn2')?.addEventListener('click', () => {
    s.bgStyle = 'video'; saveSettings(); applySettings(); syncSettingsUI(); toggleVideoBgOptions();
    $('#videoUrlModal')?.classList.add('active');
    const inp = $('#videoUrlInput'); if (inp) { inp.value = s.videoBgUrl || ''; inp.focus(); }
  });

  // Video background
  const dropZone = $('#videoDropZone');
  const bgVideoEl = $('#bgVideo');
  bgVideoEl?.addEventListener('error', () => {
    if (settings.bgStyle !== 'video') return;
    settings.videoBgUrl = ''; settings.bgStyle = 'artwork';
    saveSettings(); applySettings(); syncSettingsUI(); toggleVideoBgOptions();
    showToast('Could not play that video background');
  });
  function handleVideoFile(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) { showToast('Please select a video file'); return; }
    if (file.size > 20 * 1024 * 1024) { showToast('File too large (max 20MB)'); return; }
    s.videoBgUrl = URL.createObjectURL(file); s.bgStyle = 'video';
    saveSettings(); applySettings(); syncSettingsUI(); toggleVideoBgOptions();
    showToast('Video background applied');
  }
  dropZone?.addEventListener('click', () => $('#videoFileInput').click());
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
  dropZone?.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
  dropZone?.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor = ''; handleVideoFile(e.dataTransfer.files[0]); });
  $('#videoFileInput')?.addEventListener('change', e => handleVideoFile(e.target.files[0]));
  $('#videoUrlBtn')?.addEventListener('click', () => { $('#videoUrlModal').classList.add('active'); $('#videoUrlInput').value = s.videoBgUrl || ''; $('#videoUrlInput').focus(); });
  $('#videoUrlCancel')?.addEventListener('click', () => $('#videoUrlModal').classList.remove('active'));
  $('#videoUrlSave')?.addEventListener('click', () => {
    const url = $('#videoUrlInput').value.trim(); if (!url) return;
    s.videoBgUrl = url; s.bgStyle = 'video'; saveSettings(); applySettings(); syncSettingsUI();
    toggleVideoBgOptions(); $('#videoUrlModal').classList.remove('active'); showToast('Video URL applied');
  });
  $('#videoRemoveBtn')?.addEventListener('click', () => {
    s.videoBgUrl = ''; s.bgStyle = 'artwork'; saveSettings(); applySettings(); syncSettingsUI();
    toggleVideoBgOptions(); showToast('Video background removed');
  });

  toggleVideoBgOptions();
  setupCustomize();
}

function setupCustomize() {
  const c = settings.custom;
  const $c = id => $(id);
  const sync = () => {
    $c('#cHue').value = c.accentH != null && c.accentH !== '' ? c.accentH : (settings.accentColor !== 'auto' ? parseFloat(settings.accentColor.split(',')[0]) || 20 : 20);
    $c('#cSat').value = c.accentSat != null && c.accentSat !== '' ? c.accentSat : (settings.accentColor !== 'auto' ? parseFloat(settings.accentColor.split(',')[1]) || 65 : 65);
    $c('#cLight').value = c.accentLight != null && c.accentLight !== '' ? c.accentLight : 72;
    $c('#cBg').value = c.bg || '#0B0908';
    $c('#cSurface').value = c.surface || '#171412';
    $c('#cText').value = c.text || '#F5F3F1';
    $c('#cBorder').value = c.border || '#302A26';
    $c('#cUseColors').checked = !!c.useColors;
    $c('#cRadius').value = c.radius ?? 100;
    $c('#cAnimSpeed').value = c.animSpeed ?? 100;
    $c('#cGlow').value = c.glow ?? 100;
    $c('#cGrain').checked = !!c.grain;
    $c('#cCursor').checked = !!c.cursor;
    $c('#cGlass').checked = !!settings.glass;
    $c('#cGlassBlur').value = c.glassBlur ?? 16;
    $c('#cGlassTint').value = c.glassTint ?? 9;
    $c('#cHoverStyle').value = c.hoverStyle || 'glow';
    $c('#cHoverIntensity').value = c.hoverIntensity ?? 100;
    $c('#cGlowBorder').checked = !!c.glowBorder;
    $c('#cCss').value = c.css || '';
  };
  const commit = () => { saveSettings(); applySettings(); };
  const onColor = () => {
    c.accentH = +$c('#cHue').value;
    c.accentSat = +$c('#cSat').value;
    c.accentLight = +$c('#cLight').value;
    commit();
  };
  ['#cHue','#cSat','#cLight'].forEach(id => $c(id)?.addEventListener('input', onColor));
  [['#cBg','bg'],['#cSurface','surface'],['#cText','text'],['#cBorder','border']].forEach(([id,key]) =>
    $c(id)?.addEventListener('input', () => { c[key] = $c(id).value; commit(); }));
  $c('#cUseColors')?.addEventListener('change', () => { c.useColors = $c('#cUseColors').checked; commit(); });
  $c('#cRadius')?.addEventListener('input', () => { c.radius = +$c('#cRadius').value; commit(); });
  $c('#cAnimSpeed')?.addEventListener('input', () => { c.animSpeed = +$c('#cAnimSpeed').value; commit(); });
  $c('#cGlow')?.addEventListener('input', () => { c.glow = +$c('#cGlow').value; commit(); });
  $c('#cGrain')?.addEventListener('change', () => { c.grain = $c('#cGrain').checked; commit(); });
  $c('#cCursor')?.addEventListener('change', () => { c.cursor = $c('#cCursor').checked; commit(); });
  $c('#cGlass')?.addEventListener('change', () => { settings.glass = $c('#cGlass').checked; saveSettings(); applySettings(); const sg = $c('#settingGlass'); if (sg) sg.checked = settings.glass; });
  $c('#cGlassBlur')?.addEventListener('input', () => { c.glassBlur = +$c('#cGlassBlur').value; commit(); });
  $c('#cGlassTint')?.addEventListener('input', () => { c.glassTint = +$c('#cGlassTint').value; commit(); });
  $c('#cHoverStyle')?.addEventListener('change', () => { c.hoverStyle = $c('#cHoverStyle').value; commit(); });
  $c('#cHoverIntensity')?.addEventListener('input', () => { c.hoverIntensity = +$c('#cHoverIntensity').value; commit(); });
  $c('#cGlowBorder')?.addEventListener('change', () => { c.glowBorder = $c('#cGlowBorder').checked; commit(); });
  $c('#cCssApply')?.addEventListener('click', () => { c.css = $c('#cCss').value; commit(); showToast('Custom CSS applied'); });
  $c('#cCssClear')?.addEventListener('click', () => { c.css = ''; $c('#cCss').value = ''; commit(); showToast('Custom CSS cleared'); });
  $c('#cCss')?.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey) && e.key === 'Enter') $c('#cCssApply').click(); });

  // Presets
  const getPresets = () => { try { return JSON.parse(localStorage.getItem('sv_presets')||'[]'); } catch(e){ return []; } };
  const setPresets = p => localStorage.setItem('sv_presets', JSON.stringify(p));
  const snapshot = () => ({
    theme: settings.theme, accentColor: settings.accentColor, glass: settings.glass,
    density: settings.density, corners: settings.corners, fontSize: settings.fontSize,
    fontFamily: settings.fontFamily, bgStyle: settings.bgStyle, custom: JSON.parse(JSON.stringify(settings.custom)),
  });
  const renderPresets = () => {
    const list = $c('#cPresetList'); if (!list) return;
    const presets = getPresets();
    list.innerHTML = presets.length ? '' : '<div class="preset-item"><span class="preset-empty">No presets saved yet</span></div>';
    presets.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'preset-item';
      row.innerHTML = `<span class="preset-name"></span>
        <button class="btn btn-secondary btn-sm" data-apply="${i}"><i class="fas fa-check"></i> Apply</button>
        <button class="btn btn-secondary btn-sm" data-del="${i}" style="color:#e74c3c"><i class="fas fa-trash"></i></button>`;
      row.querySelector('.preset-name').textContent = p.name;
      row.querySelector('[data-apply]').addEventListener('click', () => {
        Object.assign(settings, { theme:p.theme, accentColor:p.accentColor, glass:p.glass, density:p.density,
          corners:p.corners, fontSize:p.fontSize, fontFamily:p.fontFamily, bgStyle:p.bgStyle });
        settings.custom = { ...DEFAULT_SETTINGS.custom, ...(p.custom||{}) };
        saveSettings(); applySettings(); syncSettingsUI(); sync(); renderPresets();
        showToast(`Applied preset "${p.name}"`);
      });
      row.querySelector('[data-del]').addEventListener('click', () => {
        const arr = getPresets(); arr.splice(i, 1); setPresets(arr); renderPresets();
      });
      list.appendChild(row);
    });
  };
  $c('#cPresetSave')?.addEventListener('click', () => {
    const name = ($c('#cPresetName').value || '').trim();
    if (!name) { showToast('Enter a preset name'); return; }
    const arr = getPresets();
    const existing = arr.findIndex(p => p.name === name);
    const entry = { name, ...snapshot() };
    if (existing >= 0) arr[existing] = entry; else arr.push(entry);
    setPresets(arr); $c('#cPresetName').value = ''; renderPresets(); showToast(`Saved preset "${name}"`);
  });

  sync(); renderPresets();
  // Expose for syncSettingsUI
  setupCustomize._sync = sync;
  setupCustomize._renderPresets = renderPresets;
}

function toggleVideoBgOptions() {
  const isVideo = settings.bgStyle === 'video';
  const row = $('#videoBgRow'); if (row) row.style.display = isVideo ? '' : 'none';
  const dropZone = $('#videoDropZone');
  const preview = $('#videoPreview');
  const previewPlayer = $('#videoPreviewPlayer');
  if (dropZone && preview) {
    if (settings.videoBgUrl) {
      dropZone.style.display = 'none'; preview.style.display = '';
      if (previewPlayer) { previewPlayer.src = settings.videoBgUrl; previewPlayer.play().catch(()=>{}); }
    } else {
      dropZone.style.display = ''; preview.style.display = 'none';
    }
  }
}

function syncSettingsUI() {
  const s = settings;
  const pairs = [
    ['#settingTheme','theme'],['#settingBgStyle','bgStyle'],['#settingDensity','density'],
    ['#settingCorners','corners'],['#settingFontSize','fontSize'],['#settingFontFamily','fontFamily'],
    ['#settingBlur','blurStrength'],['#settingBgDim','bgDim'],
    ['#settingAutoplay','autoplay'],['#settingCrossfade','crossfade'],['#settingAudioQuality','audioQuality'],
    ['#settingSeekDuration','seekDuration'],['#settingScrollVolume','scrollVolume'],['#settingToasts','toasts'],
    ['#settingStartup','startup'],['#settingHistory','history'],['#settingLang','lang'],['#settingDevice','device'],
    ['#settingLite','lite'],['#settingGlass','glass'],
    ['#settingResume','resume'],['#settingSearchHistory','searchHistory'],
  ];
  pairs.forEach(([sel,key]) => {
    const el = $(sel); if (!el) return;
    if (el.type === 'checkbox') el.checked = s[key];
    else el.value = s[key];
  });
  if (setupCustomize._sync) setupCustomize._sync();
  if (setupCustomize._renderPresets) setupCustomize._renderPresets();
  const autoPerf = $('#settingAutoPerf');
  if (autoPerf) autoPerf.checked = s.perfPreset === 'auto';
  if (s.accentColor && s.accentColor !== 'auto') {
    const [h, sat] = s.accentColor.split(',');
    const hueEl = $('#settingAccentHue'), satEl = $('#settingAccentSat');
    if (hueEl && h) hueEl.value = parseFloat(h);
    if (satEl && sat) satEl.value = parseFloat(sat);
  }
  $$('.color-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.color === s.accentColor));
  updateQuickActions();
  toggleVideoBgOptions();
}

let playlistEditIdx = -1;
let pendingPlaylistTrack = null;

function openPlaylistModal(idx, track) {
  playlistEditIdx = (typeof idx === 'number') ? idx : -1;
  pendingPlaylistTrack = track || null;
  const modal = $('#playlistModal');
  const input = $('#playlistNameInput');
  if (!modal) return;
  $('#playlistModalTitle').textContent = playlistEditIdx >= 0 ? 'Rename Playlist' : 'Create Playlist';
  $('#playlistModalSave').textContent = playlistEditIdx >= 0 ? 'Save' : 'Create';
  input.value = playlistEditIdx >= 0 ? state.playlists[playlistEditIdx].name : '';
  modal.classList.add('active');
  input.focus();
}

function setupPlaylistModal() {
  const modal = $('#playlistModal');
  const input = $('#playlistNameInput');
  $('#newPlaylistBtn')?.addEventListener('click', () => openPlaylistModal(-1));
  $('#playlistModalCancel')?.addEventListener('click', () => { modal.classList.remove('active'); pendingPlaylistTrack = null; });
  modal.addEventListener('click', e => { if (e.target === modal) { modal.classList.remove('active'); pendingPlaylistTrack = null; } });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') $('#playlistModalSave')?.click(); });
  $('#playlistModalSave')?.addEventListener('click', () => {
    const name = input.value.trim(); if (!name) return;
    let targetIdx = playlistEditIdx;
    if (playlistEditIdx >= 0) state.playlists[playlistEditIdx].name = name;
    else { state.playlists.push({ id: uid(), name, tracks: [] }); targetIdx = state.playlists.length - 1; }
    let added = false;
    if (pendingPlaylistTrack && state.playlists[targetIdx]) {
      const pl = state.playlists[targetIdx];
      if (!pl.tracks.some(t => t.id === pendingPlaylistTrack.id && t.source === pendingPlaylistTrack.source)) {
        pl.tracks.push(pendingPlaylistTrack); added = true;
      }
    }
    localStorage.setItem('sv_playlists', JSON.stringify(state.playlists));
    renderSidebarPlaylists(); modal.classList.remove('active');
    if (state.currentPage === 'library') renderLibrary();
    showToast(added ? `Added to ${name}` : (playlistEditIdx >= 0 ? 'Playlist updated' : 'Playlist created'));
    pendingPlaylistTrack = null;
    playlistEditIdx = -1;
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch(e.code) {
      case 'Space': e.preventDefault(); state.isPlaying ? player?.pauseVideo() : player?.playVideo(); break;
      case 'ArrowRight':
        if (e.shiftKey) { e.preventDefault(); playNext(); }
        else { e.preventDefault(); seekBy(settings.seekDuration); }
        break;
      case 'ArrowLeft':
        if (e.shiftKey) { e.preventDefault(); playPrev(); }
        else { e.preventDefault(); seekBy(-settings.seekDuration); }
        break;
      case 'ArrowUp': e.preventDefault(); { const v = clamp(parseInt($('#volumeSlider').value) + 5, 0, 100); $('#volumeSlider').value = v; player?.setVolume(v); updateVolumeIcon(); } break;
      case 'ArrowDown': e.preventDefault(); { const v = clamp(parseInt($('#volumeSlider').value) - 5, 0, 100); $('#volumeSlider').value = v; player?.setVolume(v); updateVolumeIcon(); } break;
      case 'KeyJ': seekBy(-settings.seekDuration); break;
      case 'KeyL': if (e.ctrlKey || e.metaKey) break; seekBy(settings.seekDuration); break;
      case 'KeyM': $('#btnVolume')?.click(); break;
      case 'KeyQ': toggleRightPanel('queue'); break;
      case 'KeyY': toggleRightPanel('lyrics'); break;
      case 'KeyB': toggleLite(); break;
      case 'KeyR': RaceUI.toggle(); break;
      case 'KeyT': cycleTheme(); break;
      case 'KeyH': toggleMinimize(); break;
      case 'Slash': e.preventDefault(); { $('.search-container')?.classList.remove('collapsed'); $('#searchInput')?.focus(); } break;
      case 'Escape':
        if (RaceUI.open) RaceUI.close();
        else if (state.nowPlayingOpen) toggleNowPlaying(false);
        else if (state.rightPanelOpen) toggleRightPanel();
        else if (state.searchActive) clearSearch();
        break;
    }
  });
}

// === PLAYER ENGINE (YouTube + SoundCloud) ===
// YouTube tracks play in the listener's own browser via the IFrame API (best
// available audio, ~130-160 kbps Opus). SoundCloud tracks stream their best
// track (160 kbps AAC) through the server's HLS proxy via an <audio> element.
const YTS = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

let ytPlayer = null;
let ytApiLoading = false;
let currentTrack = null;
let pendingVideoId = null;
let audioEl = null;
let hlsInstance = null;
let backend = 'youtube';
let resumePos = null;       // where to seek the next track once it plays
let resumeSaveTick = 0;     // throttle writes to localStorage
let crossfading = false;    // true while the current track is fading out

function initPlayer() {
  audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.volume = (parseInt(($('#volumeSlider') || {}).value, 10) || 80) / 100;
  audioEl.addEventListener('playing', () => onPlayerStateChange({ data: YTS.PLAYING }));
  audioEl.addEventListener('pause', () => { if (!audioEl.ended) onPlayerStateChange({ data: YTS.PAUSED }); });
  audioEl.addEventListener('ended', () => onPlayerStateChange({ data: YTS.ENDED }));
  audioEl.addEventListener('error', () => { if (backend === 'soundcloud') playNext(); });
  player = createPlayerFacade();
  loadYouTubeApi(createYouTubePlayer);
}

function createPlayerFacade() {
  const yt = () => backend === 'youtube' && ytPlayer && ytPlayer.loadVideoById;
  const au = () => backend === 'soundcloud' && audioEl;
  return {
    playVideo() { if (yt()) ytPlayer.playVideo(); else if (au()) audioEl.play().catch(() => {}); },
    pauseVideo() { if (yt()) ytPlayer.pauseVideo(); if (audioEl) audioEl.pause(); },
    getCurrentTime() { if (yt()) return ytPlayer.getCurrentTime() || 0; return audioEl ? (audioEl.currentTime || 0) : 0; },
    getDuration() {
      if (yt()) return ytPlayer.getDuration() || 0;
      if (audioEl && isFinite(audioEl.duration)) return audioEl.duration;
      return 0;
    },
    seekTo(t) { if (yt()) ytPlayer.seekTo(t, true); else if (au()) { try { audioEl.currentTime = t; } catch (e) {} } },
    setVolume(v) {
      v = clamp(Math.round(v), 0, 100);
      if (yt()) { ytPlayer.setVolume(v); if (v > 0 && ytPlayer.isMuted()) ytPlayer.unMute(); }
      if (audioEl) { audioEl.volume = v / 100; if (v > 0) audioEl.muted = false; }
    },
    getVolume() { if (yt()) return ytPlayer.getVolume(); return audioEl ? Math.round(audioEl.volume * 100) : 80; },
    isMuted() { if (yt()) return ytPlayer.isMuted(); return audioEl ? audioEl.muted : false; },
    mute() { if (yt()) ytPlayer.mute(); if (audioEl) audioEl.muted = true; },
    unMute() { if (yt()) ytPlayer.unMute(); if (audioEl) audioEl.muted = false; },
  };
}

function applyQuality() {
  if (!ytPlayer || !ytPlayer.setPlaybackQuality) return;
  const map = { high: 'hd1080', normal: 'large', low: 'small', auto: 'default' };
  try { ytPlayer.setPlaybackQuality(map[settings.audioQuality] || 'default'); } catch (e) {}
}

function loadYouTubeApi(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (prev) prev(); cb(); };
  if (ytApiLoading) return;
  ytApiLoading = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function createYouTubePlayer() {
  if (ytPlayer) return;
  const div = document.createElement('div');
  div.id = 'yt-player';
  div.style.cssText = 'position:fixed;right:0;bottom:0;width:640px;height:360px;'
    + 'opacity:0;pointer-events:none;border:0;z-index:-1;';
  document.body.appendChild(div);
  ytPlayer = new YT.Player('yt-player', {
    width: '640', height: '360',
    playerVars: {
      autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3,
      modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin,
    },
    events: {
      onReady: () => {
        ytPlayer.setVolume(parseInt(($('#volumeSlider') || {}).value, 10) || 80);
        if (pendingVideoId) { ytPlayer.loadVideoById(pendingVideoId); pendingVideoId = null; applyQuality(); }
      },
      onStateChange: onPlayerStateChange,
      onError: () => playNext(),
    },
  });
}

function stopSoundCloud() {
  if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
  if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); }
}

function playYouTube(id) {
  backend = 'youtube';
  stopSoundCloud();
  if (ytPlayer && ytPlayer.loadVideoById) { ytPlayer.loadVideoById(id); applyQuality(); }
  else pendingVideoId = id;
}

function playSoundCloud(track) {
  if (!audioEl || !track.url) return;
  backend = 'soundcloud';
  if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
  const manifest = '/api/sc/manifest?u=' + encodeURIComponent(track.url);
  const nativeHls = audioEl.canPlayType('application/vnd.apple.mpegurl');
  if (window.Hls && window.Hls.isSupported()) {
    if (!hlsInstance) {
      hlsInstance = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => { audioEl.play().catch(() => {}); });
      hlsInstance.on(window.Hls.Events.ERROR, (evt, data) => {
        if (data && data.fatal) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hlsInstance.startLoad();
          else { stopSoundCloud(); playNext(); }
        }
      });
    }
    hlsInstance.loadSource(manifest);
    hlsInstance.attachMedia(audioEl);
    audioEl.play().catch(() => {});
  } else if (nativeHls) {
    audioEl.src = manifest;
    audioEl.play().catch(() => {});
  } else {
    showToast('SoundCloud playback not supported in this browser');
  }
}

// === LYRICS ===
// Fetches lyrics from the server (multiple providers) and renders them into
// both the right panel and the Now Playing overlay. Synced lyrics (LRC) are
// highlighted line-by-line and auto-scrolled; plain lyrics get an estimated
// timeline so the glow / auto-scroll still works.
function lyricsQuery(track) {
  const artist = (track.author || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
  let title = track.title || '';
  title = title.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (m, inner) =>
    /(official|lyric|audio|video|visuali|hd|hq|4k|remix|m\/v|mv|music video|color coded|full song|with lyrics)/i.test(inner) ? ' ' : m);
  title = title.replace(/\b(feat|ft|featuring)\.?\s+[^,;]+/gi, ' ');
  title = title.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '').trim();
  return { title: title || track.title || '', artist };
}

function sourceLabel(s) {
  const map = { lrclib: 'LRCLIB', netease: 'Netease', qq: 'QQ Music', 'lyrics.ovh': 'lyrics.ovh', azlyrics: 'AZLyrics', web: 'Web', google: 'Google', duckduckgo: 'DuckDuckGo' };
  return map[s] || 'Lyrics';
}

function renderLyricsStatus(kind, msg) {
  const icon = kind === 'loading' ? 'spinner fa-spin' : kind === 'error' ? 'triangle-exclamation' : 'microphone-slash';
  const html = `<div class="lyrics-status"><i class="fas fa-${icon}"></i><p>${escapeHtml(msg || 'Lyrics not available')}</p></div>`;
  ['#lyricsContainer', '#npLyricsContainer'].forEach(sel => {
    const c = $(sel); if (c) { c.innerHTML = html; c.scrollTop = 0; }
  });
  lyricsRows = []; lyricsActiveIndex = -1; lyricsData = null;
}

async function loadLyrics(track, refresh) {
  const id = ++lyricsReqId;
  lyricsUserScrolledAt = 0;
  if (!track) { renderLyricsStatus('empty', 'Nothing playing'); return; }
  renderLyricsStatus('loading', 'Loading lyrics…');
  const { title, artist } = lyricsQuery(track);
  try {
    const p = new URLSearchParams();
    p.set('title', title);
    if (artist) p.set('artist', artist);
    if (track.length) p.set('duration', String(track.length));
    if (refresh) p.set('refresh', '1');
    const res = await fetch('/api/lyrics?' + p.toString());
    const data = await res.json();
    if (id !== lyricsReqId) return;
    lyricsData = data;
    renderLyrics(data, track);
  } catch (e) {
    if (id !== lyricsReqId) return;
    renderLyricsStatus('error', 'Could not load lyrics');
  }
}

function renderLyrics(data, track) {
  if (!data || !data.found || !data.lines || !data.lines.length) {
    renderLyricsStatus('empty', 'Lyrics not available for this song');
    return;
  }
  let lines = data.lines;
  const hasTimes = lines.some(l => l.time != null);
  const estimated = !hasTimes && !!(track && track.length);
  if (estimated) {
    const n = lines.length;
    const start = Math.min(6, track.length * 0.06);
    const end = Math.max(start + 1, track.length - 3);
    lines = lines.map((l, i) => ({ ...l, time: start + (end - start) * (n > 1 ? i / (n - 1) : 0) }));
  }
  const syncBadge = hasTimes ? '<span class="lyrics-sync">synced</span>'
    : estimated ? '<span class="lyrics-sync est">auto-synced</span>'
    : '<span class="lyrics-sync est">unsynced</span>';

  lyricsRows = lines.map(l => ({ time: l.time, text: l.text, el: null, npEl: null }));
  lyricsActiveIndex = -1;

  [['#lyricsContainer', 'el'], ['#npLyricsContainer', 'npEl']].forEach(([sel, key]) => {
    const c = $(sel);
    if (!c) return;
    c.innerHTML = '';
    const badge = document.createElement('div');
    badge.className = 'lyrics-badge';
    badge.innerHTML = `<span class="lyrics-source">${escapeHtml(sourceLabel(data.source))}</span>${syncBadge}`;
    c.appendChild(badge);
    lines.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'lyrics-line' + (String(l.text).trim() === '♪' ? ' instrumental' : '');
      d.dataset.index = i;
      d.innerHTML = `<span class="lyric-text">${escapeHtml(l.text)}</span>`;
      if (l.time != null) d.addEventListener('click', () => { try { player?.seekTo(l.time, true); } catch (e) {} });
      c.appendChild(d);
      lyricsRows[i][key] = d;
    });
    c.scrollTop = 0;
  });

  const cur = (player && player.getCurrentTime) ? player.getCurrentTime() : 0;
  updateActiveLyric(cur, true);
}

function updateActiveLyric(t, force) {
  if (!lyricsRows.length || t == null) return;
  let idx = -1;
  for (let i = 0; i < lyricsRows.length; i++) {
    const lt = lyricsRows[i].time;
    if (lt == null) continue;
    if (lt <= t + 0.2) idx = i; else break;
  }
  if (!force && idx === lyricsActiveIndex) return;
  lyricsActiveIndex = idx;
  lyricsRows.forEach((r, i) => {
    const active = i === idx, past = i < idx;
    if (r.el) { r.el.classList.toggle('active', active); r.el.classList.toggle('past', past); }
    if (r.npEl) { r.npEl.classList.toggle('active', active); r.npEl.classList.toggle('past', past); }
  });
  scrollActiveLyricIntoView();
}

function scrollActiveLyricIntoView() {
  if (lyricsActiveIndex < 0) return;
  if (Date.now() - lyricsUserScrolledAt < 3500) return;
  const row = lyricsRows[lyricsActiveIndex];
  if (!row) return;
  [row.el, row.npEl].filter(Boolean).forEach(el => {
    const c = el.closest('.lyrics-container');
    if (!c || c.offsetParent === null) return;
    const delta = el.getBoundingClientRect().top - c.getBoundingClientRect().top - c.clientHeight / 2 + el.clientHeight / 2;
    c.scrollTo({ top: c.scrollTop + delta, behavior: settings.lite ? 'auto' : 'smooth' });
  });
}

function setupLyrics() {
  ['#lyricsContainer', '#npLyricsContainer'].forEach(sel => {
    const c = $(sel);
    if (!c) return;
    ['wheel', 'touchstart', 'pointerdown'].forEach(ev =>
      c.addEventListener(ev, () => { lyricsUserScrolledAt = Date.now(); }, { passive: true }));
  });
  const refresh = () => {
    if (!currentTrack) return;
    const btns = ['#lyricsRefresh', '#npLyricsRefresh'];
    btns.forEach(b => $(b)?.classList.add('spin'));
    loadLyrics(currentTrack, true).finally(() => setTimeout(() => btns.forEach(b => $(b)?.classList.remove('spin')), 600));
    showToast('Refreshing lyrics…');
  };
  $('#lyricsRefresh')?.addEventListener('click', refresh);
  $('#npLyricsRefresh')?.addEventListener('click', refresh);
}

// === NAVIGATION SETUP ===
function setupNavigation() {
  $$('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
    item.addEventListener('keydown', e => { if (e.key === 'Enter') navigateTo(item.dataset.page); });
  });

  // Top bar quick actions
  $('#liteToggle')?.addEventListener('click', () => toggleLite());
  $('#themeCycle')?.addEventListener('click', () => cycleTheme());
  $('#minimizeBtn')?.addEventListener('click', toggleMinimize);
  updateQuickActions();

  const searchInput = $('#searchInput');
  const suggestions = $('#searchSuggestions');
  const searchWrap = $('.search-container');
  const expandSearch = () => searchWrap?.classList.remove('collapsed');
  const collapseSearchIfEmpty = () => { if (searchWrap && !searchInput.value.trim() && document.activeElement !== searchInput) searchWrap.classList.add('collapsed'); };
  // Search starts collapsed to icon; click expands it
  $('#searchBox')?.addEventListener('click', () => { expandSearch(); searchInput.focus(); });
  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { suggestions.classList.remove('active'); if (state.searchActive) clearSearch(); return; }
    suggestions.classList.add('active');
    state.searchDebounce = setTimeout(() => doSearch(q), 100);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(state.searchDebounce); doSearch(searchInput.value.trim()); suggestions.classList.remove('active'); }
    if (e.key === 'Escape') { searchInput.blur(); suggestions.classList.remove('active'); collapseSearchIfEmpty(); }
  });
  searchInput.addEventListener('focus', () => { expandSearch(); suggestions.classList.add('active'); renderRecentSearches(); });
  searchInput.addEventListener('blur', collapseSearchIfEmpty);
  document.addEventListener('click', e => { if (!e.target.closest('.search-container')) suggestions.classList.remove('active'); });
  $('#searchClear')?.addEventListener('click', () => { clearSearch(); searchInput.focus(); });
  $('#searchBackBtn')?.addEventListener('click', clearSearch);

  // Filter tabs
  $$('#filterTabs .filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.activeFilter = tab.dataset.filter;
      renderSearchResults(); updateTabIndicator();
    });
  });

  // Menu toggle
  $('#menuToggle')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.addEventListener('click', e => {
    if (window.innerWidth <= 1024 && !e.target.closest('.sidebar') && !e.target.closest('#menuToggle'))
      $('#sidebar').classList.remove('open');
  });

  // Player
  $('#playerThumb')?.addEventListener('click', () => toggleNowPlaying(true));
  $('#playerTitle')?.addEventListener('click', () => toggleNowPlaying(true));
  $('#npClose')?.addEventListener('click', () => toggleNowPlaying(false));
  $('#btnPlay')?.addEventListener('click', () => state.isPlaying ? player?.pauseVideo() : player?.playVideo());
  $('#npPlay')?.addEventListener('click', () => state.isPlaying ? player?.pauseVideo() : player?.playVideo());
  $('#btnNext')?.addEventListener('click', playNext);
  $('#npNext')?.addEventListener('click', playNext);
  $('#btnPrev')?.addEventListener('click', playPrev);
  $('#npPrev')?.addEventListener('click', playPrev);

  $('#btnShuffle')?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#btnShuffle')?.classList.toggle('active', state.shuffle);
    $('#npShuffle')?.classList.toggle('active', state.shuffle);
    showToast(state.shuffle ? 'Shuffle ON' : 'Shuffle OFF');
  });
  $('#npShuffle')?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#btnShuffle')?.classList.toggle('active', state.shuffle);
    $('#npShuffle')?.classList.toggle('active', state.shuffle);
    showToast(state.shuffle ? 'Shuffle ON' : 'Shuffle OFF');
  });

  ['#btnRepeat','#npRepeat'].forEach(sel => {
    $(sel)?.addEventListener('click', () => {
      const modes = ['off','all','one'];
      state.repeat = modes[(modes.indexOf(state.repeat)+1) % 3];
      ['#btnRepeat','#npRepeat'].forEach(s2 => {
        const btn = $(s2); if (!btn) return;
        btn.classList.toggle('active', state.repeat !== 'off');
        btn.innerHTML = state.repeat === 'one' ? '<i class="fas fa-repeat"></i><span style="font-size:0.5rem;position:absolute">1</span>' : '<i class="fas fa-repeat"></i>';
      });
      showToast(`Repeat: ${state.repeat}`);
    });
  });

  $('#playerLikeBtn')?.addEventListener('click', () => {
    const cur = state.queue[state.currentIndex];
    if (cur) toggleLike(cur);
  });

  // Add current track to a playlist
  $('#playerAddBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddToPlaylistMenu(e.currentTarget);
  });

  // Sleep timer
  $('#btnSleep')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openSleepMenu(e.currentTarget);
  });

  // Right panel
  $('#btnLyrics')?.addEventListener('click', () => toggleRightPanel('lyrics'));
  $('#btnQueue')?.addEventListener('click', () => toggleRightPanel('queue'));
  $$('.right-panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.rightPanelTab = tab.dataset.rptab;
      $$('.right-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.rptab === state.rightPanelTab));
      $('#rpLyrics').style.display = state.rightPanelTab === 'lyrics' ? '' : 'none';
      $('#rpQueue').style.display = state.rightPanelTab === 'queue' ? '' : 'none';
      if (state.rightPanelTab === 'queue') renderQueue();
    });
  });

  // Mood back
  $('#moodBackBtn')?.addEventListener('click', () => {
    $('#moodSection').style.display = '';
    $('#moodResultsSection').style.display = 'none';
  });

  // Play all liked
  $('#playAllLiked')?.addEventListener('click', () => {
    if (state.liked.length) { state.queue = [...state.liked]; state.currentIndex = 0; loadAndPlay(state.liked[0]); }
  });

  // Nav arrows
  $('#navBack')?.addEventListener('click', () => history.back());
  $('#navForward')?.addEventListener('click', () => history.forward());

  setupSeek('#progressWrap');
  setupSeek('#npProgressWrap');
  setupVolume();
  setupSettings();
  setupPlaylistModal();
  setupKeyboard();
  setupRaceUI();
}

// ===================== F1 RACE UI (3D) =====================
const RaceUI = {
  open: false, raf: 0, last: 0, built: false,
  world: null, carsEl: null, trackEl: null, startEl: null, boardEl: null,
  cars: [], leaderId: null, targetId: null, statusT: 0,
  trackPts: [], per: 0,
  L: 300, R: 190, W: 100,   // half-straight, radius, road width

  el(id) { return document.getElementById(id); },

  // ---- Geometry: stadium oval centred on origin, local XY plane ----
  pointAt(d) {
    const L = this.L, R = this.R;
    const straight = 2 * L, arc = Math.PI * R;
    d = ((d % this.per) + this.per) % this.per;
    let x, y, hx, hy;
    if (d < straight) {                       // bottom straight (+x)
      x = -L + d; y = R; hx = 1; hy = 0;
    } else if (d < straight + arc) {          // right semicircle
      const phi = Math.PI / 2 - (d - straight) / R;
      x = L + R * Math.cos(phi); y = R * Math.sin(phi);
      hx = Math.sin(phi); hy = -Math.cos(phi);
    } else if (d < 2 * straight + arc) {      // top straight (-x)
      const s = d - (straight + arc);
      x = L - s; y = -R; hx = -1; hy = 0;
    } else {                                  // left semicircle
      const phi = -Math.PI / 2 - (d - (2 * straight + arc)) / R;
      x = -L + R * Math.cos(phi); y = R * Math.sin(phi);
      hx = Math.sin(phi); hy = -Math.cos(phi);
    }
    return { x, y, heading: Math.atan2(hy, hx), hx, hy };
  },

  buildTrack() {
    const straight = 2 * this.L, arc = Math.PI * this.R;
    this.per = 2 * straight + 2 * arc;
    const N = 150, tileLen = this.per / N + 2, W = this.W;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < N; i++) {
      const d = (i / N) * this.per;
      const p = this.pointAt(d + this.per / N / 2);
      const t = document.createElement('div');
      t.className = 'race-road';
      t.style.width = tileLen + 'px';
      t.style.height = W + 'px';
      t.style.transform =
        `translate3d(${p.x}px, ${p.y}px, 0) rotateZ(${p.heading}rad) translate(-50%, -50%)`;
      if (i % 4 === 0) { const l = document.createElement('div'); l.className = 'lane-line'; t.appendChild(l); }
      frag.appendChild(t);
    }
    // Start/finish line
    const sp = this.pointAt(0);
    this.startEl.style.transform =
      `translate3d(${sp.x}px, ${sp.y}px, 0) rotateZ(${sp.heading}rad) translate(-50%, -50%)`;
    this.trackEl.appendChild(frag);
  },

  palette() { return ['#e23b2e', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#facc15']; },

  buildCars() {
    const list = this.tracks();
    this.carsEl.innerHTML = '';
    this.cars = list.map((track, i) => {
      const el = document.createElement('div');
      el.className = 'race-car';
      el.style.setProperty('--car-color', this.palette()[i % 8]);
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `Overtake with ${track.title}`);
      el.innerHTML =
        `<div class="car-shadow"></div>` +
        `<div class="car-headlight"></div>` +
        `<div class="car-body"><img src="${track.thumbnail || ''}" alt="" loading="lazy"></div>` +
        `<div class="car-canopy"></div>` +
        `<div class="car-nose"></div>` +
        `<div class="car-wing rear"></div><div class="car-wing front"></div>` +
        `<div class="car-boost"></div>` +
        `<div class="car-flag">P1</div>` +
        `<div class="car-num">${i + 1}</div>`;
      el.addEventListener('click', () => this.select(i));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(i); } });
      this.carsEl.appendChild(el);
      const base = 150 + (i % 4) * 14 + Math.random() * 10;   // px/s base speed
      return { track, el, id: i, d: (this.per - i * (this.per / list.length)) % this.per, speed: base, boost: 0, lane: ((i % 3) - 1) * 30 };
    });
    this.cars.sort((a, b) => b.d - a.d);
    this.leaderId = this.cars[0]?.id ?? null;
  },

  tracks() {
    let list = (state.queue && state.queue.length) ? state.queue.slice(0, 8)
      : (state.recentlyPlayed || []).slice(0, 8);
    if (!list.length) list = RaceUI.demo().slice(0, 6);
    return list;
  },

  demo() {
    return [
      { id: 'demo1', title: 'Add songs to race', author: 'Queue a track', thumbnail: '', source: 'youtube' },
      { id: 'demo2', title: 'Search & play', author: 'Any song', thumbnail: '', source: 'youtube' },
      { id: 'demo3', title: 'Then open Race', author: 'Press R', thumbnail: '', source: 'youtube' },
    ];
  },

  renderBoard() {
    if (!this.boardEl) return;
    if (!this.cars.length) { this.boardEl.innerHTML = `<div class="race-empty"><i class="fas fa-flag-checkered" style="font-size:2rem"></i><div>Add songs to your queue to start a race</div></div>`; return; }
    const order = [...this.cars].sort((a, b) => b.d - a.d);
    const lead = order[0];
    this.boardEl.innerHTML = order.map((c, i) => {
      const gap = i === 0 ? 'LEADER' : '+' + (lead.d - c.d).toFixed(0);
      const sel = c.id === this.targetId ? ' selected' : '';
      const led = i === 0 ? ' leader' : '';
      return `<div class="race-board-row${sel}${led}" data-car="${c.id}" role="button" tabindex="0" aria-label="Overtake with ${escapeHtml(c.track.title)}">
        <div class="race-pos">${i + 1}</div>
        <img src="${c.track.thumbnail || ''}" alt="" loading="lazy">
        <div class="race-board-info"><div class="race-board-title">${escapeHtml(c.track.title)}</div><div class="race-board-sub">${escapeHtml(c.track.author || '')}</div></div>
        <div class="race-board-gap">${gap}</div>
      </div>`;
    }).join('');
    this.boardEl.querySelectorAll('.race-board-row').forEach(row => {
      row.addEventListener('click', () => this.select(Number(row.dataset.car)));
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(Number(row.dataset.car)); } });
    });
  },

  updateNowPlaying(track) {
    const art = this.el('raceNowArt'), title = this.el('raceNowTitle');
    if (art && track) art.src = track.thumbnail || '';
    if (title) title.textContent = track ? track.title : '—';
  },

  setStatus(txt, flash) {
    const s = this.el('raceStatus'); if (!s) return;
    s.textContent = txt || '';
    if (flash) { s.classList.remove('flash'); void s.offsetWidth; s.classList.add('flash'); }
  },

  // ---- Overtake ----
  select(i) {
    const car = this.cars.find(c => c.id === i); if (!car) return;
    this.targetId = i;
    this.updateNowPlaying(car.track);
    // Start boost only if not already leading -> overtake animation
    const isLeader = this.cars.slice().sort((a, b) => b.d - a.d)[0]?.id === i;
    if (!isLeader) { car.boost = 1; car.boostUntil = performance.now() + 6000; this.setStatus(`OVERTAKING — ${car.track.title}`, true); }
    else this.setStatus(`LEADING — ${car.track.title}`);
    playNow(car.track);   // music starts as the car moves up
    this.renderBoard();
    this.paint();
  },
  next() { const order = [...this.cars].sort((a, b) => b.d - a.d); const idx = order.findIndex(c => c.id === this.targetId); this.select(order[(idx + 1) % order.length].id); },
  prev() { const order = [...this.cars].sort((a, b) => b.d - a.d); const idx = order.findIndex(c => c.id === this.targetId); this.select(order[(idx - 1 + order.length) % order.length].id); },
  overtake() { if (this.targetId != null) this.select(this.targetId); else if (this.cars.length) this.next(); },

  paint() {
    const order = [...this.cars].sort((a, b) => b.d - a.d);
    this.leaderId = order[0]?.id ?? null;
    for (const c of this.cars) {
      const p = this.pointAt(c.d);
      const px = p.x + (-p.hy) * c.lane, py = p.y + p.hx * c.lane;
      c.el.style.transform = `translate3d(${px}px, ${py}px, 0) rotateZ(${p.heading}rad)`;
      c.el.classList.toggle('leader', c.id === this.leaderId);
      c.el.classList.toggle('selected', c.id === this.targetId);
      c.el.classList.toggle('boosting', c.boost > 0);
    }
  },

  tick(now) {
    if (!this.open) return;
    const dt = Math.min((now - this.last) / 1000, 0.05); this.last = now;
    for (const c of this.cars) {
      if (c.boost > 0 && now > c.boostUntil) c.boost = 0;
      const spd = c.speed * (1 + c.boost * 0.9);
      c.d += spd * dt;
    }
    // resolve overtake completion
    const order = [...this.cars].sort((a, b) => b.d - a.d);
    if (this.targetId != null) {
      const t = this.cars.find(c => c.id === this.targetId);
      if (t && t.boost > 0 && order[0].id === this.targetId) { t.boost = 0; this.setStatus(`P1 — ${t.track.title}`, true); this.renderBoard(); }
    }
    this.paint();
    if ((now | 0) % 12 === 0) this.renderBoard();   // throttle board refresh
    this.raf = requestAnimationFrame(this.tick.bind(this));
  },

  build() {
    if (this.built) return;
    this.world = this.el('raceWorld'); this.carsEl = this.el('raceCars');
    this.trackEl = this.el('raceTrack'); this.startEl = this.el('raceStart'); this.boardEl = this.el('raceBoard');
    this.buildTrack(); this.buildCars(); this.renderBoard(); this.built = true;
  },

  refresh() { this.built = false; this.build(); this.paint(); this.renderBoard(); if (currentTrack) this.updateNowPlaying(currentTrack); },

  openView() {
    this.open = true;
    const o = this.el('raceOverlay'); o.classList.add('active'); o.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    this.refresh();
    // seed target from currently playing track
    if (currentTrack) {
      const idx = this.cars.findIndex(c => c.track.id === currentTrack.id && (c.track.source || '') === (currentTrack.source || ''));
      if (idx >= 0) this.targetId = this.cars[idx].id;
      this.updateNowPlaying(currentTrack);
    }
    this.paint(); this.renderBoard();
    this.last = performance.now();
    cancelAnimationFrame(this.raf); this.raf = 0;
    if (!settings.lite) this.raf = requestAnimationFrame(this.tick.bind(this));
  },
  close() {
    this.open = false; cancelAnimationFrame(this.raf);
    const o = this.el('raceOverlay'); o.classList.remove('active'); o.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === state.currentPage));
  },
  toggle() { this.open ? this.close() : this.openView(); },
};

function setupRaceUI() {
  $('#raceToggle')?.addEventListener('click', () => RaceUI.toggle());
  $('#raceExit')?.addEventListener('click', () => RaceUI.close());
  $('#raceNext')?.addEventListener('click', () => RaceUI.next());
  $('#racePrev')?.addEventListener('click', () => RaceUI.prev());
  $('#raceOvertake')?.addEventListener('click', () => RaceUI.overtake());
  const banner = $('#raceBanner');
  if (banner) {
    banner.addEventListener('click', () => RaceUI.openView());
    banner.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); RaceUI.openView(); } });
  }
}

// ===================== DEVICE SELECT (first launch) =====================
function setupDeviceModal() {
  const modal = $('#deviceModal');
  const choose = (device) => {
    settings.device = device;
    saveSettings();
    applyDeviceScale();
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('device-pending');
    showToast(`Device set to ${device === 'laptop' ? 'Laptop / PC' : device.charAt(0).toUpperCase() + device.slice(1)} (${Math.round(DEVICE_SCALE[device] * 100)}% scale)`);
  };
  $$('#deviceModal .device-card').forEach(card => {
    card.addEventListener('click', () => choose(card.dataset.device));
  });
  // Show once, only when no device has been chosen yet.
  if (!settings.device) {
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('device-pending');
  }
}

function init() {
  applySettings();
  detectPerformance();
  loadHome();
  initPlayer();
  setupNavigation();
  renderSidebarPlaylists();
  renderRecentSearches();
  attachRipples();
  updateQuickActions();
  setupLyrics();
  setupDeviceModal();

  // Always land on a clean Home view: never auto-open the lyrics/queue panel
  // or the now-playing overlay on load (this was showing on phones).
  state.rightPanelOpen = false;
  state.nowPlayingOpen = false;
  $('#rightPanel')?.classList.remove('open');
  $('#appShell')?.classList.remove('right-panel-open');
  $('#nowPlaying')?.classList.remove('active');

  // Honour the configured startup page (General settings).
  if (settings.startup && settings.startup !== 'home') {
    navigateTo(settings.startup);
  }

  if (window.innerWidth <= 1024) { const t = $('#menuToggle'); if (t) t.style.display = 'flex'; }
  let wasNarrow = window.innerWidth <= 1200;
  window.addEventListener('resize', () => {
    const t = $('#menuToggle');
    if (t) t.style.display = window.innerWidth <= 1024 ? 'flex' : 'none';
    const narrow = window.innerWidth <= 1200;
    // On smaller screens the lyrics/queue panel would cover the content, so
    // close it automatically when the window shrinks into that range.
    if (narrow && !wasNarrow && state.rightPanelOpen) toggleRightPanel();
    wasNarrow = narrow;
  });
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();