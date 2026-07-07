'use strict';
// Electron main process: owns the agent Session, bridges it to the renderer over
// IPC, and gates mutating tool calls through an approval round-trip to the UI.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Session } = require('../agent/agent');

let win;
let session = null;
let currentAbort = null;
const pendingApprovals = new Map();   // id -> resolve fn
let approvalSeq = 0;

// ---- config (key + last model/dir/mode), persisted in userData; key bootstraps
// from an existing ~/.claude-harness/keys.json so there's nothing to paste on day one.
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  if (!cfg.apiKey) {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(app.getPath('home'), '.claude-harness/keys.json'), 'utf8'));
      if (k.OPENROUTER_API_KEY) cfg.apiKey = k.OPENROUTER_API_KEY;
    } catch {}
  }
  cfg.model = cfg.model || 'z-ai/glm-4.6';
  cfg.mode = cfg.mode || 'build';
  cfg.cwd = cfg.cwd || app.getPath('home');
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 780, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hiddenInset', backgroundColor: '#1a1a1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function ensureSession() {
  const cfg = loadConfig();
  if (!session) {
    session = new Session({
      apiKey: cfg.apiKey, model: cfg.model, cwd: cfg.cwd, mode: cfg.mode,
      emit: (e) => win && win.webContents.send('agent-event', e),
      approve: (kind, detail) => new Promise((resolve) => {
        const id = ++approvalSeq;
        pendingApprovals.set(id, resolve);
        win && win.webContents.send('approval', { id, kind, detail });
      }),
    });
  } else {
    session.apiKey = cfg.apiKey;
  }
  return session;
}

// ---- IPC
ipcMain.handle('get-config', () => {
  const c = loadConfig();
  return { hasKey: !!c.apiKey, model: c.model, mode: c.mode, cwd: c.cwd };
});

ipcMain.handle('set-config', (_e, patch) => {
  const c = loadConfig();
  const next = { ...c, ...patch };
  saveConfig(next);
  if (session) {
    if (patch.model) session.setModel(patch.model);
    if (patch.mode) session.setMode(patch.mode);
    if (patch.cwd) session.setCwd(patch.cwd);
    if (patch.apiKey) session.apiKey = patch.apiKey;
  }
  return { ok: true };
});

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const cfg = loadConfig(); cfg.cwd = r.filePaths[0]; saveConfig(cfg);
  if (session) session.setCwd(r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('new-session', () => { session = null; ensureSession(); return { ok: true }; });

ipcMain.handle('send', async (_e, text) => {
  const s = ensureSession();
  if (!s.apiKey) { win.webContents.send('agent-event', { type: 'error', message: 'No OpenRouter API key set — open Settings.' }); return { ok: false }; }
  currentAbort = new AbortController();
  await s.send(text, currentAbort.signal);
  currentAbort = null;
  return { ok: true };
});

ipcMain.handle('abort', () => { if (currentAbort) currentAbort.abort(); return { ok: true }; });

ipcMain.on('approval-response', (_e, { id, approved }) => {
  const resolve = pendingApprovals.get(id);
  if (resolve) { pendingApprovals.delete(id); resolve(!!approved); }
});

ipcMain.handle('list-models', () => new Promise((resolve) => {
  const cfg = loadConfig();
  const req = https.request({
    method: 'GET', hostname: 'openrouter.ai', path: '/api/v1/models',
    headers: { 'Accept': 'application/json', ...(cfg.apiKey ? { 'Authorization': 'Bearer ' + cfg.apiKey } : {}) },
  }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      try {
        const items = (JSON.parse(b).data || []).map((m) => ({ value: m.id, label: m.name || m.id }));
        items.sort((a, z) => a.value.localeCompare(z.value));
        resolve(items);
      } catch { resolve([]); }
    });
  });
  req.on('error', () => resolve([]));
  req.end();
}));
