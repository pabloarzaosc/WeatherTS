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
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  });

  mainWindow.removeMenu();
  
  // Show splash/loading state
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html>
      <body style="background-color: #0b0e13; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif;">
        <h1>Loading WeatherTS...</h1>
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

  // IPC: user triggers update check
  ipcMain.on('update:check', () => {
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

  if (app.isPackaged) {
    const indexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html'));
    indexUrl.searchParams.set('backendPort', String(assignedPort));
    mainWindow.loadURL(indexUrl.toString());
  } else {
    mainWindow.loadURL('http://localhost:1420');
  }

  // Check for updates 3 seconds after app is ready (only in packaged builds)
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('Initial update check failed:', err);
      });
    }, 3000);
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
