// The opening screen: the logo, the app's name, a loading bar with what is
// loading under it, and the version at the bottom. The window shows it while
// the local server starts -- a second or two warm, tens of seconds on a cold
// first run -- and index.html shows it again until React mounts, so the app
// never opens on a blank frame.
//
// This file is the one to edit. scripts/sync-splash.mjs copies the same markup
// into index.html between its splash:* markers, and `npm run build` runs it.
//
// The logo is drawn as SVG, traced from public/logo.png (99.3% of its pixels):
// the window's splash is a data: URL and cannot load a file.
//
// Progress comes from electron/main.js through window.__splash.set(text, p),
// one step per stage of the start-up. Between steps the bar creeps on slowly,
// never reaching the next step by itself, so a long wait still shows movement.

export const LOGO_PATHS = [
  'M1.8 1L209.9 1L305 320.6L414.8 3L592 0.3L651 320.8L768 0.4L1199.9 1L1179 163.1L889.4 169L715.4 658L713 661L495 658.7L492 397.9L394 660.8L156 658.5Z',
  'M919.6 249L1141 248.7L1120 410L866 412.3L870.9 385Z',
  'M832.8 498L1192 499.7L1169.6 660L778 661Z',
  'M0 785.5H1219V806.5H0Z',
  'M0 861H1219V882H0Z',
  'M0 934.5H1219V955.5H0Z',
];

export const SPLASH_CSS = `
.splash {
  position: fixed; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: #202020; color: #ececec; user-select: none;
  font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.splash .logo {
  width: 112px; height: auto; margin-bottom: 22px;
  animation: splash-in .7s cubic-bezier(.16,1,.3,1) both;
}
.splash .logo path { fill: #0258bd; }
.splash .name {
  margin-bottom: 34px;
  font-size: 30px; font-weight: 700; letter-spacing: .005em; line-height: 1;
  animation: splash-in .7s cubic-bezier(.16,1,.3,1) .08s both;
}
.splash .name span { color: #8fb4ff; }
.splash .loading {
  width: 320px; max-width: calc(100vw - 48px);
  animation: splash-in .7s cubic-bezier(.16,1,.3,1) .16s both;
}
.splash .bar { height: 4px; overflow: hidden; border-radius: 2px; background: #353535; }
.splash .bar-fill {
  height: 100%; border-radius: 2px; background: #6c9dff;
  transform: scaleX(var(--p, 0)); transform-origin: 0 50%;
}
.splash .status {
  display: flex; justify-content: space-between; gap: 16px; margin-top: 10px;
  font-family: "Cascadia Mono", Consolas, ui-monospace, monospace; font-size: 11.5px;
}
.splash .status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b8b8b8; }
.splash .status-pct { flex: none; color: #8e8e8e; font-variant-numeric: tabular-nums; }
.splash .version {
  position: absolute; bottom: 22px; left: 0; right: 0; text-align: center;
  font-family: "Cascadia Mono", Consolas, ui-monospace, monospace; font-size: 11px; color: #6a6a6a;
}
@keyframes splash-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
/* Carried on from the window's splash: already on screen, no second entrance. */
.splash--continue .logo, .splash--continue .name, .splash--continue .loading { animation: none; }
@media (prefers-reduced-motion: reduce) { .splash * { animation: none !important; } }
`;

export function splashBody({ version = '', status = 'starting…', progress = 0.05 } = {}) {
  const v = String(version || '').replace(/[^0-9A-Za-z.+-]/g, '');
  const text = String(status).replace(/[<&]/g, '');
  const logo = LOGO_PATHS.map((d) => `<path d="${d}"/>`).join('');
  return `<main class="splash" data-progress="${Number(progress) || 0}">
  <svg class="logo" viewBox="0 0 1220 957" role="img" aria-label="WeatherTS logo">${logo}</svg>
  <div class="name">Weather<span>TS</span></div>
  <div class="loading" role="progressbar" aria-label="Loading WeatherTS" aria-valuemin="0" aria-valuemax="100">
    <div class="bar"><div class="bar-fill"></div></div>
    <div class="status"><span class="status-text" id="splash-status">${text}</span><span class="status-pct"></span></div>
  </div>
  ${v ? `<div class="version">v${v}</div>` : ''}
</main>`;
}

// Plain ES5 so it runs as-is inside a data: URL and inline in index.html.
export const SPLASH_SCRIPT = `(function (doc) {
  var win = doc.defaultView;
  var root = doc.querySelector('.splash');
  if (!root || root.getAttribute('data-running')) return;
  root.setAttribute('data-running', '1');
  var reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (/[?&]splash=continue\\b/.test(win.location.search)) root.classList.add('splash--continue');
  var continued = root.classList.contains('splash--continue');

  var loading = root.querySelector('.loading');
  var fill = root.querySelector('.bar-fill');
  var statusEl = root.querySelector('.status-text');
  var pctEl = root.querySelector('.status-pct');

  var target = Number(root.getAttribute('data-progress')) || 0.05;
  if (continued) target = Math.max(target, 0.82);
  var shown = continued || reduce ? target : 0;

  function paint() {
    fill.style.setProperty('--p', shown.toFixed(4));
    var pct = Math.round(shown * 100);
    pctEl.textContent = pct + '%';
    loading.setAttribute('aria-valuenow', String(pct));
  }

  win.__splash = {
    set: function (text, progress) {
      if (text != null && statusEl) statusEl.textContent = text;
      if (typeof progress === 'number' && progress > target) target = Math.min(1, progress);
      if (reduce) { shown = target; paint(); }
    },
  };

  paint();
  if (reduce) return;
  var last = 0;
  function frame(now) {
    if (!root.isConnected) return;
    if (now - last >= 30) {
      last = now;
      // Creep towards the next step while waiting, never arriving on its own.
      var cap = Math.min(0.97, target + 0.1);
      target += (cap - target) * 0.004;
      shown += (target - shown) * 0.12;
      paint();
    }
    win.requestAnimationFrame(frame);
  }
  win.requestAnimationFrame(frame);
})(document);`;

export function splashHtml(version) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; height: 100%; background: #202020; }${SPLASH_CSS}</style>
  </head>
  <body>
    ${splashBody({ version, status: 'starting…', progress: 0.05 })}
    <script>${SPLASH_SCRIPT}</script>
  </body>
</html>`;
}
