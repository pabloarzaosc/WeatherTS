import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { spawn, execFile, exec } from 'child_process';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import updater from 'electron-updater';
import net from 'net';
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
const PREFERRED_BACKEND_PORT = 47837;
let activeBackendPort = PREFERRED_BACKEND_PORT;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
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

function setSplashStatus(text) {
  // Best effort: the splash may already have been replaced by the real app, or
  // the window closed. Either way this is cosmetic and must never throw.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => { const el = document.getElementById('splash-status'); if (el) el.textContent = ${JSON.stringify(text)}; })()`
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
          : `starting the local server… (${secs}s)`
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
      <body style="background-color: #0b0e13; color: #e9edf2; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; padding: 40px;">
        <div style="max-width: 600px; text-align: center;">
          <h1 style="color: #f26d6d; margin-bottom: 12px;">${safeTitle}</h1>
          <p style="color: #a6afba; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">The backend server failed to start. This usually means Windows Defender (or another antivirus) is still scanning the bundled runtime on first launch — it can take a couple of minutes. On a fresh PC, the VC++ Redistributable may also be missing.</p>
          <pre style="background: #16191e; border: 1px solid rgba(190,200,210,0.12); border-radius: 8px; padding: 12px; color: #6b7480; font-size: 11px; text-align: left; overflow-x: auto; max-height: 240px; overflow-y: auto;">${safeDetail}</pre>
          <p style="color: #6b7480; font-size: 12px; margin-top: 16px;">If this keeps happening, try: (1) wait a minute and launch again — the second run is fast, (2) add <code style="background:#16191e;padding:1px 6px;border-radius:4px;">%LOCALAPPDATA%\Temp\_MEI*</code> to your AV exclusions, or (3) install the <a href="https://aka.ms/vs/17/release/vc_redist.x64.exe" style="color: #3b82f6;">Microsoft VC++ Redistributable</a>.</p>
        </div>
      </body>
    </html>
  `));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0e13',
    title: 'WeatherTS — Geo Workstation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false
    }
  });

  mainWindow.removeMenu();

  // Splash. This is on screen for as long as the backend takes to answer, which
  // on a cold first run is tens of seconds, so it carries a live status line
  // (see setSplashStatus) instead of a bare "Loading". Colours and type are the
  // app's own tokens from theme.css, inlined because a data: URL has no CSS.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html>
      <head><meta charset="utf-8"></head>
      <body>
        <style>
          body {
            margin: 0; height: 100vh; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 20px;
            background: #0c0f13; color: #e9edf2; user-select: none;
            font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            -webkit-font-smoothing: antialiased;
          }
          .mark {
            font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
            font-size: 25px; font-weight: 700; letter-spacing: 0.22em;
            animation: rise .55s cubic-bezier(.2,.7,.3,1) both;
          }
          .mark span { color: #3b82f6; }
          .bar {
            width: 186px; height: 2px; border-radius: 2px; overflow: hidden;
            background: rgba(190,200,210,0.18);
            animation: rise .55s cubic-bezier(.2,.7,.3,1) .08s both;
          }
          .bar i {
            display: block; width: 38%; height: 100%; border-radius: 2px;
            background: #3b82f6; animation: slide 1.2s ease-in-out infinite;
          }
          .status {
            font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
            font-size: 11px; letter-spacing: 0.04em; color: #6b7480;
            min-height: 14px; text-align: center; padding: 0 24px;
            animation: rise .55s cubic-bezier(.2,.7,.3,1) .16s both;
          }
          @keyframes slide {
            0% { transform: translateX(-110%); }
            100% { transform: translateX(370%); }
          }
          @keyframes rise {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: none; }
          }
          @media (prefers-reduced-motion: reduce) {
            .bar i { animation: none; width: 100%; opacity: .45; }
            .mark, .bar, .status { animation: none; }
          }
        </style>
        <div class="mark">WEATHER<span>TS</span></div>
        <div class="bar"><i></i></div>
        <div class="status" id="splash-status">starting…</div>
      </body>
    </html>
  `));

  return mainWindow;
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

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

  // IPC: get current version
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });
  ipcMain.handle('backend:port', () => activeBackendPort);
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
    setSplashStatus('starting the local server…');

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

  setSplashStatus('carregando o mapa…');

  if (app.isPackaged) {
    const indexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html'));
    indexUrl.searchParams.set('backendPort', String(assignedPort));
    mainWindow.loadURL(indexUrl.toString());
  } else {
    mainWindow.loadURL('http://localhost:1420');
  }
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
