/**
 * electron/main.js
 * Electron main process — creates the app window and spawns the backend server.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// Log crashes to a file for debugging
process.on('uncaughtException', err => {
  try {
    const logDir = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
    fs.appendFileSync(path.join(logDir, 'crash.log'), `[${new Date().toISOString()}] ${err.stack || err.message}\n`);
  } catch { /* best-effort */ }
});

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isDev = process.argv.includes('--dev');
const BACKEND_PORT = process.env.PORT || 3001;

let mainWindow = null;
let backendProcess = null;

// ── Spawn the backend Express server ─────────────────────────────────────────
function startBackend() {
  // In a packaged build the backend is unpacked from the asar archive to:
  //   <Resources>/app.asar.unpacked/backend/server.js
  // In dev it lives at the normal relative path.
  const backendPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'server.js')
    : path.join(__dirname, '..', 'backend', 'server.js');

  // In packaged builds use Electron's own Node runtime (ELECTRON_RUN_AS_NODE=1)
  // so we don't depend on the user having Node.js installed.
  // In dev just use the system node.
  const spawnBin = app.isPackaged ? process.execPath : 'node';
  const spawnEnv = {
    ...process.env,
    NODE_ENV: isDev ? 'development' : 'production',
    PORT: BACKEND_PORT,
    APPDATA_PATH: app.getPath('userData'),
  };
  if (app.isPackaged) spawnEnv.ELECTRON_RUN_AS_NODE = '1';

  backendProcess = spawn(spawnBin, [backendPath], {
    env: spawnEnv,
    stdio: isDev ? 'inherit' : 'pipe',
  });

  backendProcess.on('error', err => {
    console.error('[Electron] Failed to start backend:', err);
  });

  backendProcess.on('exit', code => {
    if (code !== 0) {
      console.error(`[Electron] Backend exited with code ${code}`);
    }
  });

  console.log(`[Electron] Backend started (PID ${backendProcess.pid}) on port ${BACKEND_PORT}`);
}

// ── Wait for backend to be ready, then open the window ───────────────────────
function waitForBackend(retries = 20, delay = 500) {
  return new Promise((resolve, reject) => {
    function attempt(remaining) {
      http.get(`http://localhost:${BACKEND_PORT}/api/health`, res => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry(remaining);
        }
      }).on('error', () => retry(remaining));
    }

    function retry(remaining) {
      if (remaining <= 0) {
        reject(new Error('Backend did not start in time'));
        return;
      }
      setTimeout(() => attempt(remaining - 1), delay);
    }

    attempt(retries);
  });
}

// ── Create the main browser window ───────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepBook Studio',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // Security: isolate renderer from Node.js
      nodeIntegration: false,   // Security: no Node.js in renderer
      sandbox: false,           // Required for preload to access process.platform
    },
  });

  // Load the frontend
  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}`);

  // Open external links in the default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hot-reload in development
  if (isDev) {
    try {
      require('electron-reload')(__dirname, {
        electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit',
      });
    } catch {
      // electron-reload not installed — skip
    }
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Set native app menu
  const { buildMenu } = require('./menu');
  buildMenu();

  // Start backend then open window
  startBackend();

  try {
    await waitForBackend();
    createWindow();
  } catch (err) {
    console.error('[Electron] Could not connect to backend:', err.message);
    app.quit();
  }

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked with no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up backend process on quit
app.on('will-quit', () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
    console.log('[Electron] Backend process terminated.');
  }
});
