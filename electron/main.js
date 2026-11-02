import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { spawn, execFile, exec } from 'child_process';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import updater from 'electron-updater';
import net from 'net';
import { splashHtml } from './splash.js';
const { autoUpdater } = updater;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
// Last update the checker found, kept so a renderer that mounts *after* the
// check resolved can still ask for it. Pushing alone is not enough: the send
// goes nowhere if no listener is attached yet, and nothing reports the loss.
let pendingUpdateInfo = null;
let backendProcess = null;
let backendLog = '';
// A sign-in link that arrived before the window existed. Providers can hand the
// callback back fast enough to beat a cold start, and dropping it would leave
// the user staring at a sign-in form they just completed.
let pendingAuthUrl = null;
const PREFERRED_BACKEND_PORT = 47837;
let activeBackendPort = PREFERRED_BACKEND_PORT;

// A fixed ceiling on the browser cache. Pictures, radar scans and views come
// with a max-age, so Chromium keeps them -- within a size it picks from the free
// space. It stays under this one instead, whatever the disk.
app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const AUTH_PROTOCOL = 'weatherts';

/** The deep-linked sign-in callback out of a set of process arguments, if any.
 *  Windows delivers it as an argv entry rather than an event. */
function authUrlFrom(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${AUTH_PROTOCOL}://`)) || null;
}

// Links to a moment (weatherts://view?site=KTLX&datetime=...): the same
// protocol as the sign-in callback, handed to the page on their own channel.
// One that arrives before the page listens waits to be asked for (link:pending).
let pendingViewUrl = null;
function isViewUrl(url) {
  try {
    return new URL(url).host === 'view';
  } catch (_) {
    return false;
  }
}

function deliverViewUrl(url) {
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('link:open', url);
  } else {
    pendingViewUrl = url;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function deliverAuthUrl(url) {
  if (!url) return;
  if (isViewUrl(url)) {
    deliverViewUrl(url);
    return;
  }
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('auth:callback', url);
  } else {
    pendingAuthUrl = url;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// Claim the protocol so the browser can hand the callback back to this app. In
// development the executable is Electron itself running a script, so the path
// and the script have to be spelled out or Windows registers the wrong target.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    deliverAuthUrl(authUrlFrom(argv));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// macOS delivers it as an event instead of an argument.
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverAuthUrl(url);
});

// A cold start launched BY the link: the URL is in this process's own argv.
pendingAuthUrl = authUrlFrom(process.argv);
if (pendingAuthUrl && isViewUrl(pendingAuthUrl)) {
  pendingViewUrl = pendingAuthUrl;
  pendingAuthUrl = null;
}

function getFreePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferredPort, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', (err) => {
      // A stale process or another local service must not prevent startup.
      if (preferredPort !== 0 && err.code === 'EADDRINUSE') {
        srv.close(() => {
          getFreePort(0).then(resolve, reject);
        });
        return;
      }
      reject(err);
    });
  });
}

function setSplashStatus(text, progress = null) {
  // Best effort: the splash may already have been replaced by the real app, or
  // the window closed. Either way this is cosmetic and must never throw.
  // `progress` (0-1) moves the loading bar; see splash.js.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const p = typeof progress === 'number' ? progress : 'null';
  mainWindow.webContents
    .executeJavaScript(
      `(() => { if (window.__splash) { window.__splash.set(${JSON.stringify(text)}, ${p}); return; } const el = document.getElementById('splash-status'); if (el) el.textContent = ${JSON.stringify(text)}; })()`
    )
    .catch(() => {});
}

async function waitForBackend(port) {
  // PyInstaller one-file extracts ~170 MB to %TEMP% on first launch and
  // Windows Defender (or any AV) scans it before the bootloader runs. That
  // can take well over 30 s on a fresh install — and the child stays silent
  // the whole time, so the user sees "No output captured." We give it 180 s
  // and write periodic heartbeats to backendLog so the error page at least
  // shows progress if it does time out.
  const maxAttempts = 360; // 180 seconds
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        backendLog += `READY after ${((Date.now() - start) / 1000).toFixed(1)}s\n`;
        return true;
      }
    } catch (e) {
      // ignore
    }
    if (i % 20 === 0 && i > 0) {
      const secs = ((Date.now() - start) / 1000).toFixed(0);
      backendLog += `waiting for backend (${secs}s elapsed)...\n`;
      // Say why the wait is long rather than leaving a silent screen: on a cold
      // start this is the antivirus scanning the extracted runtime.
      setSplashStatus(
        secs >= 20
          ? `preparing the local server — the first run is slower (${secs}s)`
          : `starting the local server… (${secs}s)`,
        0.25 + Math.min(0.4, secs / 150)
      );
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function showErrorPage(title, detail) {
  const safeTitle = String(title).replace(/</g, '&lt;');
  const safeDetail = String(detail).replace(/</g, '&lt;').substring(0, 2000);
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html>
      <body style="background-color: #202020; color: #ececec; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; padding: 40px;">
        <div style="max-width: 600px; text-align: center;">
          <h1 style="color: #f2715a; margin-bottom: 12px;">${safeTitle}</h1>
          <p style="color: #b8b8b8; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">The backend server failed to start. This usually means Windows Defender (or another antivirus) is still scanning the bundled runtime on first launch — it can take a couple of minutes. On a fresh PC, the VC++ Redistributable may also be missing.</p>
          <pre style="background: #262626; border: 1px solid #353535; border-radius: 8px; padding: 12px; color: #8e8e8e; font-size: 11px; text-align: left; overflow-x: auto; max-height: 240px; overflow-y: auto;">${safeDetail}</pre>
          <p style="color: #8e8e8e; font-size: 12px; margin-top: 16px;">If this keeps happening, try: (1) wait a minute and launch again — the second run is fast, (2) add <code style="background:#262626;padding:1px 6px;border-radius:4px;">%LOCALAPPDATA%\Temp\_MEI*</code> to your AV exclusions, or (3) install the <a href="https://aka.ms/vs/17/release/vc_redist.x64.exe" style="color: #8fb4ff;">Microsoft VC++ Redistributable</a>.</p>
        </div>
      </body>
    </html>
  `));
}

// Protocol of a URL, or '' when it will not parse. openExternal on a
// javascript: or file: URL is a way to run something the user did not ask for,
// so the handlers above check this before passing anything to the shell.
function safeProtocol(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function sameOrigin(a, b) {
  try {
    return Boolean(b) && new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#202020',
    title: 'WeatherTS — Geo Workstation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false,
      // Alert sounds (src/lib/alertSounds.ts) have to play for a warning that
      // arrives while the window sits hidden, before anything was clicked.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.removeMenu();

  // Anything the app asks to open in a new window goes to the real browser.
  //
  // Sign-in is the case that matters. signInWithProvider already calls
  // window.open for the desktop build, but with no handler here Electron
  // answers that by making another BrowserWindow -- so Google's page opened
  // inside the app, in a frame with no address bar. That is exactly the
  // embedded-webview shape providers refuse, and it asks the user to type a
  // password into a window that cannot show them where it is going. Denying
  // the window and handing the URL to the browser is the whole fix; the
  // callback still comes home through the weatherts:// deep link.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The same rule for a navigation that would replace the app itself. Without
  // this, one stray external link leaves the user stuck on a web page with no
  // way back -- the menu is gone and there is no address bar to type into.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const protocol = safeProtocol(url);
    // The app's own pages: the built file:// bundle, the data: splash, and the
    // dev server it reloads from. Blocking these would block the app booting.
    if (protocol === 'file:' || protocol === 'data:' || protocol === '') return;
    if (sameOrigin(url, mainWindow.webContents.getURL())) return;
    event.preventDefault();
    if (/^https?:$/.test(protocol)) void shell.openExternal(url);
  });

  // Splash: the logo, the name, a loading bar with what is loading under it
  // (see setSplashStatus) and the version, on screen for as long as the backend
  // takes to answer -- tens of seconds on a cold first run. See splash.js.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(app.getVersion())));

  return mainWindow;
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Fetch the installer in one stream instead of reassembling it from blockmap
  // ranges. Differential download is meant to save bandwidth, but this artifact
  // is ~285 MB and nearly all of it changes between builds -- the 166 MB
  // backend binary is rebuilt every time -- so it saves almost nothing while
  // issuing hundreds of HTTP range requests against GitHub's asset CDN. Those
  // stall: a download stopped at 119 MB with no progress events reaching the
  // banner, which read to the user as the update button doing nothing.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update:status', 'checking');
  });

  autoUpdater.on('update-available', (info) => {
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((item) => item.note || item.body || '').filter(Boolean).join('\n\n')
      : typeof info.releaseNotes === 'object'
        ? info.releaseNotes.body || ''
        : info.releaseNotes || '';
    const releaseInfo = {
      version: info.version,
      releaseNotes: notes || info.releaseName || '',
      releaseName: info.releaseName || `v${info.version}`
    };
    pendingUpdateInfo = releaseInfo;
    mainWindow?.webContents.send('update:available', releaseInfo);
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update:status', 'up-to-date');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:status', 'downloading');
    mainWindow?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', () => {
    // Hand control to the banner, which offers "Restart & install now" and
    // "Later". Force-quitting here raced that banner off the screen ~800 ms
    // after it appeared, so "Later" never worked and the restart looked like a
    // crash. autoInstallOnAppQuit is on, so "Later" still applies the update
    // the next time the app closes.
    mainWindow?.webContents.send('update:downloaded');
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    mainWindow?.webContents.send('update:error', err.message);
  });

  // IPC: renderer triggers a check (on mount, and from any manual trigger)
  ipcMain.on('update:check', () => {
    // There is no update feed to talk to in dev, and calling through would
    // surface an error toast on every reload.
    if (!app.isPackaged) return;
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Check for updates failed:', err);
      mainWindow?.webContents.send('update:error', err.message);
    });
  });

  // IPC: user agrees to download
  ipcMain.on('update:download', () => {
    mainWindow?.webContents.send('update:status', 'downloading');
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('Download update failed:', err);
      mainWindow?.webContents.send('update:error', err.message);
    });
  });

  // IPC: user agrees to install and restart
  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // IPC: what the checker already found, if anything. The banner asks for this
  // on mount so an update discovered before it existed is not lost.
  ipcMain.handle('update:pending', () => {
    // Logged because the renderer reaching this at all is the signal that the
    // preload bridge is alive. When the bridge was broken this handler was
    // never called, and the silence was indistinguishable from "no update".
    console.log('[updater] renderer asked for pending update ->', pendingUpdateInfo?.version ?? 'none');
    return pendingUpdateInfo;
  });

  // A view link that came before the page was listening, handed over once.
  ipcMain.handle('link:pending', () => {
    const url = pendingViewUrl;
    pendingViewUrl = null;
    return url;
  });

  // IPC: get current version
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });
  ipcMain.handle('backend:port', () => activeBackendPort);

  // An animation export runs with the window's background throttling off, so
  // minimising the app mid-export does not slow its timers or stop its map.
  ipcMain.on('render:keep', (_e, on) => {
    mainWindow?.webContents.setBackgroundThrottling(!on);
  });

  // The Export page (src/lib/viewExport.ts): a save dialog that opens on the
  // Downloads folder with the export's name filled in, then "Show in folder"
  // for what was saved -- only paths this session wrote can be shown.
  const exportedPaths = new Set();
  ipcMain.handle('export:save', async (_e, name, bytes) => {
    const safe = path.basename(String(name || 'weatherts-export')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    const ext = path.extname(safe).slice(1).toLowerCase();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save export',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, Buffer.from(bytes));
    exportedPaths.add(res.filePath);
    return res.filePath;
  });
  ipcMain.handle('export:reveal', (_e, filePath) => {
    if (typeof filePath !== 'string' || !exportedPaths.has(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
  });

}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  createWindow();
  setupAutoUpdater();

  // Check right away, in parallel with the backend coming up, rather than
  // waiting on the window. This almost always resolves while the splash is
  // still on screen -- which is fine, and is the point: the result lands in
  // pendingUpdateInfo, and the banner pulls it the moment it mounts. Tying the
  // check to the window instead is what made it unreliable.
  if (app.isPackaged) {
    const check = (label) => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error(`${label} update check failed:`, err);
      });
    };
    check('Initial');
    setInterval(() => check('Periodic'), 30 * 60 * 1000);
  }

  let assignedPort = PREFERRED_BACKEND_PORT;

  if (app.isPackaged) {
    try {
      assignedPort = await getFreePort(PREFERRED_BACKEND_PORT);
    } catch (e) {
      console.error('Could not reserve a backend port', e);
      showErrorPage('Failed to reserve backend port', String(e));
      return;
    }

    const backendPath = path.join(process.resourcesPath, 'backend', 'weatherts-backend.exe');
    console.log(`Starting backend on port ${assignedPort}:`, backendPath);
    setSplashStatus('starting the local server…', 0.2);

    backendProcess = spawn(backendPath, ['--port', String(assignedPort)], {
      env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    backendProcess.stdout?.on('data', (data) => {
      const msg = data.toString();
      console.log('[backend]', msg);
      backendLog += msg;
    });

    backendProcess.stderr?.on('data', (data) => {
      const msg = data.toString();
      console.error('[backend]', msg);
      backendLog += msg;
    });

    backendProcess.on('error', (err) => {
      console.error('Failed to spawn backend:', err);
      backendLog += `SPAWN ERROR: ${err.message}\n`;
    });

    backendProcess.on('exit', (code, signal) => {
      console.log(`Backend exited with code ${code}, signal ${signal}`);
      backendLog += `EXIT: code=${code} signal=${signal}\n`;
    });
  }

  activeBackendPort = assignedPort;
  const backendReady = app.isPackaged ? await waitForBackend(assignedPort) : true;

  if (!backendReady && app.isPackaged) {
    console.error('Backend failed to start');
    const logSnippet = backendLog.trim().substring(0, 1500) || 'No output captured.';
    showErrorPage('Failed to start backend', logSnippet);
    return;
  }

  setSplashStatus('loading the map…', 0.8);

  // index.html carries the same screen on, from where this one left off and
  // without replaying its entrance.
  if (app.isPackaged) {
    const indexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html'));
    indexUrl.searchParams.set('backendPort', String(assignedPort));
    indexUrl.searchParams.set('splash', 'continue');
    mainWindow.loadURL(indexUrl.toString());
  } else {
    mainWindow.loadURL('http://localhost:1420/?splash=continue');
  }

  // A sign-in link that beat the renderer here waits until there is something
  // listening for it, then goes exactly once.
  mainWindow.webContents.once('did-finish-load', () => {
    if (!pendingAuthUrl) return;
    const url = pendingAuthUrl;
    pendingAuthUrl = null;
    mainWindow.webContents.send('auth:callback', url);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (backendProcess) {
    backendProcess.kill();
    // Also kill any child processes (uvicorn workers)
    try {
      spawn('taskkill', ['/pid', String(backendProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) { /* ignore */ }
  }
});
