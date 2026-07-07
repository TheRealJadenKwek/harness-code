'use strict';
// Electron main process: owns MANY agent Sessions (one per chat in the sidebar),
// persists each to disk, and bridges them to the renderer over IPC — including the
// approval round-trip that gates mutating tool calls.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { Session } = require('../agent/agent');

let win;
const sessions = new Map();           // id -> rec (see sessionCreate for shape)
const pendingApprovals = new Map();   // approvalId -> resolve fn
let approvalSeq = 0;

// ---- paths -----------------------------------------------------------------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const sessionsDir = () => path.join(app.getPath('userData'), 'sessions');
const modelsCachePath = () => path.join(app.getPath('userData'), 'models.json');
const sessionFile = (id) => path.join(sessionsDir(), id + '.json');

// ---- config (key + defaults for new sessions), persisted in userData; key
// bootstraps from ~/.claude-harness/keys.json so there's nothing to paste on day one.
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  if (!cfg.apiKey) {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(app.getPath('home'), '.claude-harness/keys.json'), 'utf8'));
      if (k.OPENROUTER_API_KEY) cfg.apiKey = k.OPENROUTER_API_KEY;
    } catch {}
  }
  cfg.model = cfg.model || 'deepseek/deepseek-v4-pro';
  cfg.mode = cfg.mode || 'ask';
  cfg.cwd = cfg.cwd || app.getPath('home');
  cfg.modeByModel = cfg.modeByModel || {};   // remembered trust level per model
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); } catch {}
}

// ---- session records + persistence ------------------------------------------
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function metaOf(rec) {
  return {
    id: rec.id, title: rec.title, cwd: rec.cwd, model: rec.model, mode: rec.mode,
    effort: rec.effort || null,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt, usage: rec.usage,
    streaming: !!rec.abort,
  };
}

function saveSession(rec) {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(sessionFile(rec.id), JSON.stringify({
      meta: {
        id: rec.id, title: rec.title, cwd: rec.cwd, model: rec.model, mode: rec.mode,
        effort: rec.effort || null,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt, usage: rec.usage,
      },
      messages: rec.agent ? rec.agent.messages : (rec.savedMessages || []),
      transcript: rec.transcript,
    }));
  } catch {}
}

function loadSessionsFromDisk() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
      if (!d.meta || !d.meta.id) continue;
      sessions.set(d.meta.id, {
        ...d.meta,
        usage: d.meta.usage || { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
        agent: null, savedMessages: d.messages || [], transcript: d.transcript || [],
        abort: null, cur: null,
      });
    } catch {}
  }
}

function sessionsChanged() { win && win.webContents.send('sessions-updated'); }
function sendToUI(channel, payload) { win && win.webContents.send(channel, payload); }

// ---- model catalog (cached to disk so the picker is instant) -----------------
let modelsMem = null;
function fetchModels(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET', hostname: 'openrouter.ai', path: '/api/v1/models',
      headers: { 'Accept': 'application/json', ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const items = (JSON.parse(b).data || []).map((m) => ({
            value: m.id, label: m.name || m.id,
            context: m.context_length || 0,
            pricing: m.pricing ? { prompt: Number(m.pricing.prompt) || 0, completion: Number(m.pricing.completion) || 0 } : null,
          }));
          items.sort((a, z) => a.value.localeCompare(z.value));
          resolve(items);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}
async function getModels(force) {
  if (!force && modelsMem) return modelsMem;
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(modelsCachePath(), 'utf8'));
      if (c.items && c.items.length && Date.now() - c.fetchedAt < 24 * 3600 * 1000) {
        modelsMem = c.items;
        return modelsMem;
      }
    } catch {}
  }
  const items = await fetchModels(loadConfig().apiKey);
  if (items.length) {
    modelsMem = items;
    try { fs.writeFileSync(modelsCachePath(), JSON.stringify({ fetchedAt: Date.now(), items })); } catch {}
  }
  return modelsMem || [];
}
function priceOf(model) {
  const m = (modelsMem || []).find((x) => x.value === model);
  return m && m.pricing ? m.pricing : null;
}

// ---- agent event folding: mirror the live event stream into a compact transcript
// that persists to disk and replays when a session is reopened.
function flushAssistant(rec) {
  if (rec.cur && (rec.cur.text || rec.cur.think)) {
    rec.transcript.push({ t: 'assistant', text: rec.cur.text, think: rec.cur.think });
  }
  rec.cur = null;
}
function foldEvent(rec, e) {
  if (e.type === 'text') { (rec.cur || (rec.cur = { text: '', think: '' })).text += e.delta; }
  else if (e.type === 'reasoning') { (rec.cur || (rec.cur = { text: '', think: '' })).think += e.delta; }
  else if (e.type === 'tool_call') { flushAssistant(rec); rec.transcript.push({ t: 'tool', name: e.name, args: e.args }); }
  else if (e.type === 'tool_result') {
    for (let i = rec.transcript.length - 1; i >= 0; i--) {
      const it = rec.transcript[i];
      if (it.t === 'tool' && it.result === undefined) { it.result = e.result; break; }
    }
  }
  else if (e.type === 'diff') { rec.transcript.push({ t: 'diff', file: e.file, before: e.before, after: e.after }); }
  else if (e.type === 'auto_approved') { rec.transcript.push({ t: 'note', text: '⚡ auto-approved ' + e.kind + ': ' + String(e.detail || '').slice(0, 80) }); }
  else if (e.type === 'compacted') { flushAssistant(rec); rec.transcript.push({ t: 'note', text: '✦ context compacted' }); rec.updatedAt = Date.now(); saveSession(rec); }
  else if (e.type === 'done') {
    flushAssistant(rec);
    if (e.usage) {
      rec.usage.prompt_tokens += e.usage.prompt_tokens || 0;
      rec.usage.completion_tokens += e.usage.completion_tokens || 0;
      if (e.usage.last_prompt) rec.usage.context = e.usage.last_prompt;   // ≈ current context size
      const p = priceOf(rec.model);
      if (p) rec.usage.cost += (e.usage.prompt_tokens || 0) * p.prompt + (e.usage.completion_tokens || 0) * p.completion;
      rec.transcript.push({ t: 'note', text: 'done · ~' + ((e.usage.prompt_tokens || 0) + (e.usage.completion_tokens || 0)).toLocaleString() + ' tokens' });
    }
    rec.updatedAt = Date.now();
    saveSession(rec);
  }
  else if (e.type === 'error') { flushAssistant(rec); rec.transcript.push({ t: 'err', text: e.message }); saveSession(rec); }
  else if (e.type === 'aborted') { flushAssistant(rec); rec.transcript.push({ t: 'note', text: 'stopped.' }); saveSession(rec); }
}
function onAgentEvent(rec, e) {
  foldEvent(rec, e);
  sendToUI('agent-event', Object.assign({ sessionId: rec.id }, e));
}

function ensureAgent(rec) {
  const cfg = loadConfig();
  if (!rec.agent) {
    rec.agent = new Session({
      apiKey: cfg.apiKey, model: rec.model, cwd: rec.cwd, mode: rec.mode, effort: rec.effort || null,
      emit: (e) => onAgentEvent(rec, e),
      approve: (kind, detail, opts = {}) => new Promise((resolve) => {
        const aid = ++approvalSeq;
        pendingApprovals.set(aid, resolve);
        sendToUI('approval', { sessionId: rec.id, sessionTitle: rec.title, id: aid, kind, detail, danger: !!opts.danger });
      }),
    });
    if (rec.savedMessages && rec.savedMessages.length) rec.agent.loadMessages(rec.savedMessages);
    rec.savedMessages = null;
  }
  rec.agent.apiKey = cfg.apiKey;
  return rec.agent;
}

// ---- window ------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 860, minHeight: 520,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161619' : '#f4f4f2',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, '../../assets/icon.png')); } catch {}
  }
  loadSessionsFromDisk();
  getModels(false);   // warm the catalog cache in the background
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  for (const rec of sessions.values()) if (rec.agent) saveSession(rec);
  for (const t of tasks.values()) if (t.status === 'running') { try { process.kill(-t.child.pid, 'SIGTERM'); } catch {} }
});

// ---- background tasks: long-running shell commands (dev servers, watchers) ------
// Spawned in their own process group so Stop kills the whole tree. First
// localhost URL seen in the logs becomes the task's preview URL.
let taskSeq = 0;
const tasks = new Map();   // id -> { id, sessionId, name, command, cwd, status, exitCode, url, startedAt, log, child }
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>)\]]*)?/;
function taskMeta(t) {
  return { id: t.id, sessionId: t.sessionId, name: t.name, command: t.command, cwd: t.cwd,
    status: t.status, exitCode: t.exitCode, url: t.url, startedAt: t.startedAt };
}

ipcMain.handle('task-start', (_e, { sessionId, command, name }) => {
  const rec = sessions.get(sessionId);
  if (!rec || !command) return null;
  const id = ++taskSeq;
  let child;
  try {
    child = spawn('/bin/bash', ['-lc', command], {
      cwd: rec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0' },
    });
  } catch (e) { return { error: String((e && e.message) || e) }; }
  const t = { id, sessionId, name: (name || command).slice(0, 48), command, cwd: rec.cwd,
    status: 'running', exitCode: null, url: null, startedAt: Date.now(), log: '', child };
  tasks.set(id, t);
  const onChunk = (c) => {
    const s = c.toString();
    t.log = (t.log + s).slice(-200000);
    if (!t.url) {
      const m = s.match(URL_RE) || t.log.match(URL_RE);
      if (m) { t.url = m[0].replace('0.0.0.0', 'localhost'); sendToUI('task-event', { type: 'url', id, url: t.url }); }
    }
    sendToUI('task-event', { type: 'log', id, chunk: s.slice(-8000) });
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  child.on('error', (e) => { t.status = 'exited'; t.exitCode = -1; t.log += '\nspawn error: ' + e.message; sendToUI('task-event', { type: 'exit', id, code: -1 }); });
  child.on('exit', (code) => { t.status = 'exited'; t.exitCode = code; sendToUI('task-event', { type: 'exit', id, code }); });
  sendToUI('task-event', { type: 'started', id });
  // Fallback URL detection: many servers buffer or never print their URL. If the
  // command mentions a port (":8123", "--port 3000", "-p 5173", trailing "8080"),
  // probe it until something answers and use that as the preview URL.
  const pm = command.match(/(?:--?p(?:ort)?[= ]\s*|:)(\d{3,5})\b/) || command.match(/\b(\d{3,5})\b(?!.*\d{3,5})/);
  if (pm) {
    const port = +pm[1];
    if (port >= 80 && port <= 65535) {
      let tries = 0;
      const probe = () => {
        if (t.url || t.status !== 'running' || ++tries > 20) return;
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 900 }, (res) => {
          res.resume();
          if (!t.url && t.status === 'running') { t.url = 'http://localhost:' + port + '/'; sendToUI('task-event', { type: 'url', id, url: t.url }); }
        });
        req.on('error', () => setTimeout(probe, 1000));
        req.on('timeout', () => { req.destroy(); setTimeout(probe, 1000); });
      };
      setTimeout(probe, 700);
    }
  }
  return taskMeta(t);
});

ipcMain.handle('task-stop', (_e, id) => {
  const t = tasks.get(id);
  if (t && t.status === 'running') { try { process.kill(-t.child.pid, 'SIGTERM'); } catch {} }
  return { ok: true };
});
ipcMain.handle('task-remove', (_e, id) => {
  const t = tasks.get(id);
  if (t) { if (t.status === 'running') { try { process.kill(-t.child.pid, 'SIGTERM'); } catch {} } tasks.delete(id); }
  return { ok: true };
});
ipcMain.handle('task-list', () => [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map(taskMeta));
ipcMain.handle('task-log', (_e, id) => { const t = tasks.get(id); return t ? t.log.slice(-60000) : ''; });

// Run-command suggestions from the project's package.json scripts.
ipcMain.handle('project-scripts', (_e, id) => {
  const rec = sessions.get(id);
  if (!rec) return [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(rec.cwd, 'package.json'), 'utf8'));
    return Object.keys(pj.scripts || {}).map((k) => ({ name: k, command: 'npm run ' + k }));
  } catch { return []; }
});

// ---- files panel: lazy directory tree + read-only file preview -------------------
const TREE_SKIP = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'venv', '__pycache__', 'target'];
ipcMain.handle('file-tree', (_e, { id, sub }) => {
  const rec = sessions.get(id);
  if (!rec) return [];
  const base = path.resolve(rec.cwd, sub || '.');
  const rel = path.relative(rec.cwd, base);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => !e.name.startsWith('.') && !TREE_SKIP.includes(e.name))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 500)
    .map((e) => ({ name: e.name, dir: e.isDirectory() }));
});
ipcMain.handle('file-read', (_e, { id, rel }) => {
  const rec = sessions.get(id);
  if (!rec) return { error: 'no session' };
  const abs = path.resolve(rec.cwd, rel);
  const r = path.relative(rec.cwd, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return { error: 'outside working directory' };
  try {
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) return { error: 'file too large to preview (' + Math.round(st.size / 1024) + ' KB)' };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { binary: true, bytes: st.size };
    return { content: buf.toString('utf8').slice(0, 120000), bytes: st.size };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});

// ---- OpenRouter credits (for the usage popover), cached 60s -----------------------
let creditsCache = { at: 0, data: null };
ipcMain.handle('credits', () => {
  if (Date.now() - creditsCache.at < 60000 && creditsCache.data) return creditsCache.data;
  const cfg = loadConfig();
  if (!cfg.apiKey) return null;
  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET', hostname: 'openrouter.ai', path: '/api/v1/credits',
      headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Accept': 'application/json' },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const d = JSON.parse(b).data || {};
          creditsCache = { at: Date.now(), data: { total: d.total_credits, used: d.total_usage } };
          resolve(creditsCache.data);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
});

// ---- attach files/photos from the + menu ------------------------------------------
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
ipcMain.handle('pick-files', async (_e, id) => {
  const rec = sessions.get(id);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  return r.filePaths.slice(0, 8).map((p) => {
    const ext = path.extname(p).toLowerCase();
    if (IMG_EXT.includes(ext)) {
      try {
        const buf = fs.readFileSync(p);
        if (buf.length <= 6 * 1024 * 1024) {
          return { kind: 'image', name: path.basename(p), dataUrl: 'data:' + IMG_MIME[ext] + ';base64,' + buf.toString('base64') };
        }
        return { kind: 'error', name: path.basename(p), error: 'image over 6 MB' };
      } catch (e) { return { kind: 'error', name: path.basename(p), error: String(e.message || e) }; }
    }
    // Non-image: hand back a path to @-mention (relative if inside the session cwd).
    let rel = p;
    if (rec) { const rp = path.relative(rec.cwd, p); if (!rp.startsWith('..') && !path.isAbsolute(rp)) rel = rp; }
    return { kind: 'path', name: path.basename(p), path: rel };
  });
});
ipcMain.handle('pick-folder-path', async (_e, id) => {
  const rec = sessions.get(id);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  let p = r.filePaths[0];
  if (rec) { const rp = path.relative(rec.cwd, p); if (!rp.startsWith('..') && !path.isAbsolute(rp)) p = rp; }
  return p;
});

// ---- "Open in …" ------------------------------------------------------------------
ipcMain.handle('open-in', (_e, { id, target }) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false };
  const dir = rec.cwd;
  if (target === 'finder') { shell.openPath(dir); return { ok: true }; }
  const appName = target === 'terminal' ? 'Terminal' : target === 'vscode' ? 'Visual Studio Code' : null;
  if (!appName) return { ok: false };
  return new Promise((resolve) => {
    execFile('open', ['-a', appName, dir], (err) => resolve(err ? { ok: false, error: appName + ' not found' } : { ok: true }));
  });
});

// ---- IPC: config ---------------------------------------------------------------
ipcMain.handle('get-config', () => {
  const c = loadConfig();
  return { hasKey: !!c.apiKey, model: c.model, mode: c.mode, cwd: c.cwd };
});
ipcMain.handle('set-config', (_e, patch) => {
  const c = loadConfig();
  saveConfig({ ...c, ...patch });
  if (patch.apiKey) for (const rec of sessions.values()) if (rec.agent) rec.agent.apiKey = patch.apiKey;
  return { ok: true };
});

// ---- IPC: sessions --------------------------------------------------------------
ipcMain.handle('sessions-list', () =>
  [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(metaOf));

ipcMain.handle('session-create', (_e, opts = {}) => {
  const cfg = loadConfig();
  const rec = {
    id: newId(), title: 'New chat',
    cwd: opts.cwd || cfg.cwd, model: opts.model || cfg.model, mode: opts.mode || cfg.mode,
    createdAt: Date.now(), updatedAt: Date.now(),
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    agent: null, savedMessages: [], transcript: [], abort: null, cur: null,
  };
  sessions.set(rec.id, rec);
  saveSession(rec);
  return metaOf(rec);
});

ipcMain.handle('session-delete', (_e, id) => {
  const rec = sessions.get(id);
  if (rec) {
    if (rec.abort) rec.abort.abort();
    sessions.delete(id);
    try { fs.unlinkSync(sessionFile(id)); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('session-get', (_e, id) => {
  const rec = sessions.get(id);
  return rec ? { meta: metaOf(rec), transcript: rec.transcript } : null;
});

ipcMain.handle('session-rename', (_e, { id, title }) => {
  const rec = sessions.get(id);
  if (rec && title) { rec.title = String(title).slice(0, 60); saveSession(rec); sessionsChanged(); }
  return { ok: true };
});

ipcMain.handle('session-config', (_e, { id, patch }) => {
  const rec = sessions.get(id);
  if (!rec) return null;
  const cfg = loadConfig();
  // Trust memory: switching models restores the mode last used with that model;
  // changing mode records it for the current model. "New → Auto, old → Ask" sticks.
  if (patch.mode) { rec.mode = patch.mode; cfg.mode = patch.mode; cfg.modeByModel[rec.model] = patch.mode; }
  if (patch.model) {
    rec.model = patch.model; cfg.model = patch.model;
    if (!patch.mode && cfg.modeByModel[patch.model]) rec.mode = cfg.modeByModel[patch.model];
  }
  if (patch.cwd) { rec.cwd = patch.cwd; cfg.cwd = patch.cwd; }
  if (patch.effort !== undefined) rec.effort = patch.effort || null;
  saveConfig(cfg);
  if (rec.agent) {
    if (patch.model) rec.agent.setModel(rec.model);
    rec.agent.setMode(rec.mode);
    if (patch.cwd) rec.agent.setCwd(rec.cwd);
    if (patch.effort !== undefined) rec.agent.setEffort(rec.effort);
  }
  saveSession(rec);
  return metaOf(rec);
});

ipcMain.handle('session-send', (_e, { id, text, images }) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false, error: 'no such session' };
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    sendToUI('agent-event', { sessionId: id, type: 'error', message: 'No OpenRouter API key set — open Settings.' });
    return { ok: false, error: 'no key' };
  }
  if (rec.abort) return { ok: false, error: 'busy' };
  if (rec.title === 'New chat') {
    rec.title = text.split('\n')[0].slice(0, 48) || 'New chat';
    sessionsChanged();
  }
  rec.transcript.push({ t: 'user', text, images: images && images.length ? images.length : 0 });
  rec.updatedAt = Date.now();
  const agent = ensureAgent(rec);
  rec.abort = new AbortController();
  sessionsChanged();
  const payload = images && images.length ? { text, images } : text;
  (async () => {
    try { await agent.send(payload, rec.abort.signal); }
    catch (err) { onAgentEvent(rec, { type: 'error', message: String((err && err.message) || err) }); }
    finally { rec.abort = null; saveSession(rec); sessionsChanged(); }
  })();
  return { ok: true };
});

ipcMain.handle('session-abort', (_e, id) => {
  const rec = sessions.get(id);
  if (rec && rec.abort) rec.abort.abort();
  return { ok: true };
});

ipcMain.handle('session-clear', (_e, id) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false };
  if (rec.abort) rec.abort.abort();
  rec.transcript = [];
  rec.savedMessages = [];
  rec.cur = null;
  if (rec.agent) rec.agent.reset();
  rec.usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  saveSession(rec);
  sessionsChanged();
  return { ok: true };
});

ipcMain.handle('session-compact', async (_e, id) => {
  const rec = sessions.get(id);
  if (!rec || rec.abort) return { ok: false, error: 'busy or missing' };
  const agent = ensureAgent(rec);
  if (agent.messages.length < 3) return { ok: false, error: 'nothing to compact yet' };
  rec.abort = new AbortController();
  sessionsChanged();
  try {
    await agent.compact(rec.abort.signal);
    return { ok: true };
  } catch (e) {
    onAgentEvent(rec, { type: 'error', message: 'compact failed: ' + String((e && e.message) || e) });
    return { ok: false };
  } finally {
    rec.abort = null; saveSession(rec); sessionsChanged();
  }
});

ipcMain.on('approval-response', (_e, { id, approved }) => {
  const resolve = pendingApprovals.get(id);
  if (resolve) { pendingApprovals.delete(id); resolve(!!approved); }
});

// ---- IPC: pickers, models, files, git --------------------------------------------
ipcMain.handle('pick-dir', async (_e, id) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  const cfg = loadConfig(); cfg.cwd = dir; saveConfig(cfg);
  const rec = id && sessions.get(id);
  if (rec) { rec.cwd = dir; if (rec.agent) rec.agent.setCwd(dir); saveSession(rec); }
  return dir;
});

ipcMain.handle('list-models', (_e, force) => getModels(!!force));

ipcMain.handle('list-files', (_e, id) => {
  const rec = sessions.get(id);
  if (!rec) return [];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= 3000) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'out', '.next', 'venv', '__pycache__', 'target'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else out.push(path.relative(rec.cwd, full));
    }
  };
  walk(rec.cwd, 0);
  return out.slice(0, 3000);
});

function git(cwdir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: cwdir, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, so, se) => resolve({ err, so: so || '', se: se || '' }));
  });
}

ipcMain.handle('git-status', async (_e, id) => {
  const rec = sessions.get(id);
  if (!rec) return { repo: false };
  const head = await git(rec.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.err) return { repo: false };
  const st = await git(rec.cwd, ['status', '--porcelain']);
  const files = st.so.split('\n').filter(Boolean).map((l) => {
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    return { status: l.slice(0, 2).trim() || '??', path: p };
  });
  return { repo: true, branch: head.so.trim(), files };
});

ipcMain.handle('git-diff', async (_e, { id, file }) => {
  const rec = sessions.get(id);
  if (!rec) return { diff: '' };
  let r = await git(rec.cwd, ['diff', '--', file]);
  if (!r.so.trim()) {
    const staged = await git(rec.cwd, ['diff', '--cached', '--', file]);
    if (staged.so.trim()) r = staged;
  }
  if (!r.so.trim()) {
    // Untracked file: render as an all-additions diff.
    const un = await git(rec.cwd, ['diff', '--no-index', '--', '/dev/null', file]);
    if (un.so.trim()) r = un;
  }
  return { diff: r.so.slice(0, 300000) };
});

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url || '')) shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('open-sessions-folder', () => {
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); } catch {}
  shell.openPath(sessionsDir());
  return { ok: true };
});
