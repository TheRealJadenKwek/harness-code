'use strict';
// Electron main process: owns MANY agent Sessions (one per chat in the sidebar),
// persists each to disk, and bridges them to the renderer over IPC — including the
// approval round-trip that gates mutating tool calls.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { Session } = require('../agent/agent');
const { McpClient } = require('../agent/mcp');

// Use the OS resolver instead of Chromium's built-in async DNS — the built-in one
// fails (ERR_NAME_NOT_RESOLVED) under split-tunnel VPNs, which breaks the webview.
app.commandLine.appendSwitch('disable-features', 'AsyncDns');

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
  cfg.modeByModel = cfg.modeByModel || {};     // remembered trust level per model
  cfg.effortByModel = cfg.effortByModel || {}; // remembered reasoning effort per model
  cfg.mcpServers = cfg.mcpServers || [];       // [{name, command, enabled}]
  cfg.pluginsDisabled = cfg.pluginsDisabled || [];   // plugin dir names the user switched off
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
    effort: rec.effort || null, goal: rec.goal || null,
    pinned: !!rec.pinned, unread: !!rec.unread, group: rec.group || null, archived: !!rec.archived,
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
        effort: rec.effort || null, goal: rec.goal || null,
        pinned: !!rec.pinned, unread: !!rec.unread, group: rec.group || null, archived: !!rec.archived,
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
            reasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('reasoning'),
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
      // invalidate caches from before the per-model `reasoning` flag existed
      if (c.items && c.items.length && c.items[0].reasoning !== undefined && Date.now() - c.fetchedAt < 24 * 3600 * 1000) {
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
function supportsReasoning(model) {
  const m = (modelsMem || []).find((x) => x.value === model);
  return m ? !!m.reasoning : true;   // unknown model → don't block (OpenRouter drops the param anyway)
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
  else if (e.type === 'screenshot') { rec.transcript.push({ t: 'note', text: '📸 screenshot taken (not persisted)' }); }
  else if (e.type === 'compacted') { flushAssistant(rec); rec.transcript.push({ t: 'note', text: '✦ context compacted' }); rec.updatedAt = Date.now(); saveSession(rec); }
  else if (e.type === 'done') {
    flushAssistant(rec);
    if (e.usage) {
      rec.usage.prompt_tokens += e.usage.prompt_tokens || 0;
      rec.usage.completion_tokens += e.usage.completion_tokens || 0;
      if (e.usage.last_prompt) rec.usage.context = e.usage.last_prompt;   // ≈ current context size
      const p = priceOf(rec.model);
      if (p) {
        const turnCost = (e.usage.prompt_tokens || 0) * p.prompt + (e.usage.completion_tokens || 0) * p.completion;
        rec.usage.cost += turnCost;
        addSpend(turnCost);
      }
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
      goal: rec.goal || null,
      extraTools: makeExtraTools(),
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
  // Route Chromium DNS through the OS (getaddrinfo) — the built-in resolver queries
  // the configured nameserver directly, which fails under Tailscale MagicDNS / VPNs.
  try { app.configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' }); } catch {}
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, '../../assets/icon.png')); } catch {}
  }
  loadSessionsFromDisk();
  getModels(false);   // warm the catalog cache in the background
  syncMcpFromConfig();
  try { globalShortcut.register('CommandOrControl+Shift+H', doAppshot); } catch {}
  createWindow();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const c of mcpClients.values()) c.stop();
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

// ---- plugins: installable bundles of skills + MCP servers ---------------------------
// A plugin is a directory in ~/.harness-code/plugins/<name>/ containing:
//   plugin.json   { name, description, version, mcpServers: [{name, command}] }   (optional)
//   skills/*.md   markdown skills, invoked as /<filename>
const pluginsDir = () => path.join(app.getPath('home'), '.harness-code', 'plugins');
function listPlugins() {
  const cfg = loadConfig();
  let dirs = [];
  try { dirs = fs.readdirSync(pluginsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return dirs.map((dir) => {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir(), dir, 'plugin.json'), 'utf8')); } catch {}
    let skills = [];
    try { skills = fs.readdirSync(path.join(pluginsDir(), dir, 'skills')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); } catch {}
    return {
      dir, name: manifest.name || dir,
      description: manifest.description || '', version: manifest.version || '',
      mcpServers: Array.isArray(manifest.mcpServers) ? manifest.mcpServers.filter((s) => s && s.name && s.command) : [],
      skills,
      enabled: !cfg.pluginsDisabled.includes(dir),
    };
  });
}
ipcMain.handle('plugin-list', () => listPlugins());
ipcMain.handle('plugin-toggle', async (_e, { dir, enabled }) => {
  const cfg = loadConfig();
  cfg.pluginsDisabled = cfg.pluginsDisabled.filter((d) => d !== dir);
  if (!enabled) cfg.pluginsDisabled.push(dir);
  saveConfig(cfg);
  await syncMcpFromConfig();
  sendToUI('mcp-updated', {});
  return { ok: true };
});
ipcMain.handle('plugin-remove', async (_e, dir) => {
  const target = path.join(pluginsDir(), dir);
  if (path.dirname(target) === pluginsDir()) { try { fs.rmSync(target, { recursive: true, force: true }); } catch {} }
  await syncMcpFromConfig();
  sendToUI('mcp-updated', {});
  return { ok: true };
});
ipcMain.handle('plugin-install', async (_e, source) => {
  source = String(source || '').trim();
  if (!source) return { ok: false, error: 'give a local folder path or a git URL' };
  try { fs.mkdirSync(pluginsDir(), { recursive: true }); } catch {}
  const isGit = /^(https?:\/\/|git@)/.test(source);
  const base = (path.basename(source.replace(/\.git$/, '').replace(/\/+$/, '')) || 'plugin').replace(/[^\w.-]/g, '_').slice(0, 40);
  const dest = path.join(pluginsDir(), base);
  if (fs.existsSync(dest)) return { ok: false, error: 'a plugin named "' + base + '" already exists' };
  if (isGit) {
    const r = await new Promise((res) => execFile('git', ['clone', '--depth', '1', source, dest], { timeout: 60000 }, (err, _o, se) => res({ err, se })));
    if (r.err) return { ok: false, error: 'git clone failed: ' + String(r.se || r.err.message).slice(0, 200) };
  } else {
    const src = source.replace(/^~(?=\/|$)/, app.getPath('home'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: false, error: 'not a directory: ' + src };
    fs.cpSync(src, dest, { recursive: true });
  }
  // must contain at least a manifest or skills to count as a plugin
  const has = fs.existsSync(path.join(dest, 'plugin.json')) || fs.existsSync(path.join(dest, 'skills'));
  if (!has) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch {} return { ok: false, error: 'no plugin.json or skills/ folder found' }; }
  await syncMcpFromConfig();
  sendToUI('mcp-updated', {});
  return { ok: true, dir: base };
});

// ---- MCP servers (connectors) ------------------------------------------------------
const mcpClients = new Map();   // name -> McpClient
function sanitizeToolName(s) { return String(s).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40); }
function syncMcpFromConfig() {
  const cfg = loadConfig();
  const want = new Map(cfg.mcpServers.filter((s) => s.enabled).map((s) => [s.name, { command: s.command, cwd: null }]));
  // Enabled plugins contribute their servers too, namespaced <plugin>_<server>.
  // Plugin commands run with cwd = the plugin folder and may use ${PLUGIN_DIR}.
  for (const p of listPlugins()) {
    if (!p.enabled) continue;
    const pdir = path.join(pluginsDir(), p.dir);
    for (const s of p.mcpServers) {
      want.set(sanitizeToolName(p.dir + '_' + s.name), { command: s.command.split('${PLUGIN_DIR}').join(pdir), cwd: pdir });
    }
  }
  for (const [name, client] of mcpClients) {
    const w = want.get(name);
    if (!w || w.command !== client.command || (w.cwd || null) !== (client.cwd || null)) { client.stop(); mcpClients.delete(name); }
  }
  const starts = [];
  for (const [name, w] of want) {
    if (!mcpClients.has(name)) {
      const c = new McpClient(name, w.command, w.cwd);
      mcpClients.set(name, c);
      starts.push(c.start().then(() => sendToUI('mcp-updated', {})));
    }
  }
  return Promise.all(starts);
}
function mcpStatuses() {
  const cfg = loadConfig();
  const out = cfg.mcpServers.map((s) => {
    const c = mcpClients.get(s.name);
    return { name: s.name, command: s.command, enabled: !!s.enabled, source: 'user',
      status: c ? c.status : 'stopped', error: c ? c.error : null,
      tools: c ? c.tools.map((t) => t.name) : [] };
  });
  for (const p of listPlugins()) {
    for (const s of p.mcpServers) {
      const key = sanitizeToolName(p.dir + '_' + s.name);
      const c = mcpClients.get(key);
      out.push({ name: key, command: s.command, enabled: p.enabled, source: 'plugin:' + p.dir,
        status: c ? c.status : 'stopped', error: c ? c.error : null,
        tools: c ? c.tools.map((t) => t.name) : [] });
    }
  }
  return out;
}
ipcMain.handle('mcp-list', () => mcpStatuses());
ipcMain.handle('mcp-add', async (_e, { name, command }) => {
  name = sanitizeToolName(name || '');
  if (!name || !command) return { ok: false, error: 'name and command required' };
  const cfg = loadConfig();
  if (cfg.mcpServers.some((s) => s.name === name)) return { ok: false, error: 'name already exists' };
  cfg.mcpServers.push({ name, command, enabled: true });
  saveConfig(cfg);
  await syncMcpFromConfig();
  return { ok: true };
});
ipcMain.handle('mcp-remove', async (_e, name) => {
  const cfg = loadConfig();
  cfg.mcpServers = cfg.mcpServers.filter((s) => s.name !== name);
  saveConfig(cfg);
  await syncMcpFromConfig();
  return { ok: true };
});
ipcMain.handle('mcp-toggle', async (_e, { name, enabled }) => {
  const cfg = loadConfig();
  const s = cfg.mcpServers.find((x) => x.name === name);
  if (s) { s.enabled = !!enabled; saveConfig(cfg); await syncMcpFromConfig(); }
  return { ok: true };
});
ipcMain.handle('mcp-restart', async (_e, name) => {
  const c = mcpClients.get(name);
  if (c) { c.stop(); await c.start(); sendToUI('mcp-updated', {}); }
  return { ok: true };
});

// ---- extra tools for the agent: every MCP tool + the built-in browser ----------------
// Browser tools drive the Preview webview, so the user literally watches the agent browse.
let previewWC = null;
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() === 'webview') {
    previewWC = wc;
    wc.on('destroyed', () => { if (previewWC === wc) previewWC = null; });
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function browserReady() {
  for (let i = 0; i < 40; i++) { if (previewWC && !previewWC.isLoading()) return true; await sleep(250); }
  return !!previewWC;
}
const BROWSER_TOOLS = {
  browser_open: {
    schema: { name: 'browser_open', description: 'Open a URL in the built-in browser (the Preview panel the user can see). Returns the page title.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    gate: (a) => ({ kind: 'browser', detail: 'open ' + (a.url || ''), danger: false }),
    run: async (a) => {
      let url = String(a.url || '');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      sendToUI('preview-open', { url });
      await sleep(600);
      if (!(await browserReady())) return { error: 'browser did not load' };
      for (let i = 0; i < 20; i++) { if (previewWC && !previewWC.isLoading() && previewWC.getURL() !== 'about:blank') break; await sleep(300); }
      await sleep(500);
      return { ok: true, url: previewWC.getURL(), title: previewWC.getTitle() };
    },
  },
  browser_read: {
    schema: { name: 'browser_read', description: 'Read the visible text of the page currently open in the built-in browser.', parameters: { type: 'object', properties: {} } },
    gate: () => null,
    run: async () => {
      if (!previewWC) return { error: 'no page is open — use browser_open first' };
      let text = '';
      for (let i = 0; i < 12; i++) {   // the page may still be loading — retry until text appears
        try { text = await previewWC.executeJavaScript('document.body ? document.body.innerText.slice(0, 30000) : ""', true); } catch {}
        if (text && text.trim()) break;
        await sleep(400);
      }
      return { url: previewWC.getURL(), title: previewWC.getTitle(), text };
    },
  },
  browser_click: {
    schema: { name: 'browser_click', description: 'Click an element in the built-in browser by CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
    gate: (a) => ({ kind: 'browser', detail: 'click ' + (a.selector || ''), danger: false }),
    run: async (a) => {
      if (!previewWC) return { error: 'no page is open' };
      return await previewWC.executeJavaScript(
        '(() => { const el = document.querySelector(' + JSON.stringify(String(a.selector || '')) + '); if (!el) return { error: "no element matches" }; el.click(); return { clicked: true }; })()', true);
    },
  },
  browser_fill: {
    schema: { name: 'browser_fill', description: 'Fill an input in the built-in browser by CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } },
    gate: (a) => ({ kind: 'browser', detail: 'fill ' + (a.selector || ''), danger: false }),
    run: async (a) => {
      if (!previewWC) return { error: 'no page is open' };
      return await previewWC.executeJavaScript(
        '(() => { const el = document.querySelector(' + JSON.stringify(String(a.selector || '')) + '); if (!el) return { error: "no element matches" }; el.value = ' + JSON.stringify(String(a.value || '')) + '; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { filled: true }; })()', true);
    },
  },
  browser_eval: {
    schema: { name: 'browser_eval', description: 'Evaluate JavaScript in the built-in browser page and return the JSON-serializable result.', parameters: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
    gate: (a) => ({ kind: 'browser', detail: 'eval: ' + String(a.js || '').slice(0, 120), danger: false }),
    run: async (a) => {
      if (!previewWC) return { error: 'no page is open' };
      try { const v = await previewWC.executeJavaScript(String(a.js || ''), true); return { result: v === undefined ? null : v }; }
      catch (e) { return { error: String((e && e.message) || e) }; }
    },
  },
};
// ---- pixel-level computer use: screenshot → vision → click/type loop ------------------
// The screenshot is downscaled to LOGICAL screen points, so coordinates the model
// reads off the image are exactly the coordinates cliclick clicks. Click/type/key are
// ALWAYS danger-gated (like applescript) — they can do anything the user can.
const CLICLICK = '/opt/homebrew/bin/cliclick';
function cli(args) {
  return new Promise((resolve) => {
    execFile(fs.existsSync(CLICLICK) ? CLICLICK : 'cliclick', args, { timeout: 15000 },
      (err, so, se) => resolve(err ? { error: (se || err.message).slice(0, 300) + ' — cliclick needs Accessibility permission (System Settings → Privacy)' } : { ok: true, out: (so || '').trim() }));
  });
}
const KEY_MAP = { enter: 'return', escape: 'esc', backspace: 'delete', pageup: 'page-up', pagedown: 'page-down', up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right' };
// Vision models point much more accurately on ~1500px images (providers downscale
// bigger ones anyway, wrecking coordinate precision). We send a small image and
// scale the model's coordinates back to screen points before clicking.
let shotScale = 1;
const SHOT_MAX_W = 1512;
const COMPUTER_TOOLS = {
  computer_screenshot: {
    schema: { name: 'computer_screenshot', description: 'Capture the primary screen. The image is attached in the next message, sized in screen POINTS — a coordinate you read off the image is exactly the coordinate to click. Always take a fresh screenshot after each action to see the result.', parameters: { type: 'object', properties: {} } },
    gate: () => ({ kind: 'computer', detail: 'take a screenshot of the screen', danger: false }),
    run: async () => {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      const tmp = path.join(app.getPath('temp'), 'hc-screen.png');
      await new Promise((res) => execFile('screencapture', ['-x', '-m', '-C', tmp], res));   // -C: cursor visible for aim-verification
      const imgW = Math.min(SHOT_MAX_W, d.size.width);
      shotScale = d.size.width / imgW;
      await new Promise((res) => execFile('sips', ['--resampleWidth', String(imgW), tmp], res));
      let buf;
      try { buf = fs.readFileSync(tmp); } catch { buf = null; }
      if (!buf || buf.length < 5000) return { error: 'screenshot failed — grant Screen Recording permission to Harness Code (System Settings → Privacy & Security)' };
      return { ok: true, width: imgW, height: Math.round(d.size.height / shotScale), note: 'screenshot attached below — click using coordinates as seen in this image',
        _image: 'data:image/png;base64,' + buf.toString('base64') };
    },
  },
  computer_move: {
    schema: { name: 'computer_move', description: 'Move the mouse cursor to coordinates from the latest screenshot WITHOUT clicking. Best practice for accuracy: move, take a screenshot (the cursor is visible in it) to verify you are on the target, adjust if needed, THEN click.', parameters: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' },
    }, required: ['x', 'y'] } },
    gate: (a) => ({ kind: 'computer', detail: 'move cursor to (' + a.x + ', ' + a.y + ')', danger: false }),
    run: (a) => cli(['m:' + Math.round(a.x * shotScale) + ',' + Math.round(a.y * shotScale)]),
  },
  computer_click: {
    schema: { name: 'computer_click', description: 'Click at screen-point coordinates from the latest screenshot. For accuracy, prefer computer_move → screenshot (verify the visible cursor is on the target) → click at the same coordinates.', parameters: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' },
      double: { type: 'boolean' }, right: { type: 'boolean' },
    }, required: ['x', 'y'] } },
    gate: (a) => ({ kind: 'computer', detail: 'click at (' + a.x + ', ' + a.y + ')' + (a.double ? ' double' : a.right ? ' right' : ''), danger: true }),
    run: (a) => cli([(a.double ? 'dc:' : a.right ? 'rc:' : 'c:') + Math.round(a.x * shotScale) + ',' + Math.round(a.y * shotScale)]),
  },
  computer_type: {
    schema: { name: 'computer_type', description: 'Type text at the current focus (click the target field first).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    gate: (a) => ({ kind: 'computer', detail: 'type: ' + String(a.text || '').slice(0, 80), danger: true }),
    run: (a) => cli(['t:' + String(a.text || '')]),
  },
  computer_key: {
    schema: { name: 'computer_key', description: 'Press a key, optionally with modifiers. Keys: return, esc, tab, space, delete, arrow-up/down/left/right, page-up, page-down, home, end, f1-f12. Modifiers: cmd, shift, alt, ctrl (comma-separated).', parameters: { type: 'object', properties: {
      key: { type: 'string' }, modifiers: { type: 'string', description: 'e.g. "cmd" or "cmd,shift"' },
    }, required: ['key'] } },
    gate: (a) => ({ kind: 'computer', detail: 'press ' + (a.modifiers ? a.modifiers + '+' : '') + a.key, danger: true }),
    run: async (a) => {
      const key = KEY_MAP[String(a.key || '').toLowerCase()] || String(a.key || '').toLowerCase();
      const mods = String(a.modifiers || '').split(',').map((s) => s.trim()).filter(Boolean);
      // single printable character with modifiers → key-down mods, type char, key-up
      const args = [];
      if (mods.length) args.push('kd:' + mods.join(','));
      args.push(/^[a-z0-9]$/.test(key) ? 't:' + key : 'kp:' + key);
      if (mods.length) args.push('ku:' + mods.join(','));
      return cli(args);
    },
  },
  computer_open_app: {
    schema: { name: 'computer_open_app', description: 'Open (or bring to front) a macOS application by name, e.g. "Safari", "Finder".', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    gate: (a) => ({ kind: 'computer', detail: 'open app: ' + (a.name || ''), danger: false }),
    run: (a) => new Promise((resolve) => execFile('open', ['-a', String(a.name || '')], (err) => resolve(err ? { error: 'no such app: ' + a.name } : { ok: true }))),
  },
};

function makeExtraTools() {
  return {
    get schemas() {
      const out = [...Object.values(BROWSER_TOOLS), ...Object.values(COMPUTER_TOOLS)].map((t) => ({ type: 'function', function: t.schema }));
      for (const [srv, client] of mcpClients) {
        if (client.status !== 'running') continue;
        for (const t of client.tools) {
          out.push({ type: 'function', function: {
            name: 'mcp__' + sanitizeToolName(srv) + '__' + sanitizeToolName(t.name),
            description: ('[' + srv + '] ' + (t.description || t.name)).slice(0, 1024),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          } });
        }
      }
      return out;
    },
    has(name) {
      if (BROWSER_TOOLS[name] || COMPUTER_TOOLS[name]) return true;
      return name.startsWith('mcp__') && this._route(name) !== null;
    },
    gate(name, args) {
      if (BROWSER_TOOLS[name]) return BROWSER_TOOLS[name].gate(args || {});
      if (COMPUTER_TOOLS[name]) return COMPUTER_TOOLS[name].gate(args || {});
      return { kind: 'mcp', detail: name.replace(/^mcp__/, '').replace('__', ' → ') + ' ' + JSON.stringify(args || {}).slice(0, 160), danger: false };
    },
    _route(name) {
      if (!name.startsWith('mcp__')) return null;
      for (const [srv, client] of mcpClients) {
        const pre = 'mcp__' + sanitizeToolName(srv) + '__';
        if (!name.startsWith(pre)) continue;
        const tn = name.slice(pre.length);
        const tool = client.tools.find((t) => sanitizeToolName(t.name) === tn);
        if (tool) return { client, tool: tool.name };
      }
      return null;
    },
    run(name, args) {
      if (BROWSER_TOOLS[name]) return BROWSER_TOOLS[name].run(args || {});
      if (COMPUTER_TOOLS[name]) return COMPUTER_TOOLS[name].run(args || {});
      const r = this._route(name);
      if (!r) return Promise.resolve({ error: 'unknown MCP tool: ' + name });
      return r.client.call(r.tool, args || {});
    },
  };
}

// ---- skills: markdown playbooks in ~/.harness-code/skills, invoked as /name ---------
const skillsDir = () => path.join(app.getPath('home'), '.harness-code', 'skills');
ipcMain.handle('skills-list', () => {
  const readSkill = (file, name, plugin) => {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const firstLine = (content.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 100);
    return { name, description: firstLine, content, plugin: plugin || null };
  };
  const out = [];
  try {
    for (const f of fs.readdirSync(skillsDir())) {
      if (!f.endsWith('.md')) continue;
      const s = readSkill(path.join(skillsDir(), f), f.replace(/\.md$/, ''), null);
      if (s) out.push(s);
    }
  } catch {}
  // enabled plugins contribute skills too
  for (const p of listPlugins()) {
    if (!p.enabled) continue;
    for (const name of p.skills) {
      const s = readSkill(path.join(pluginsDir(), p.dir, 'skills', name + '.md'), name, p.dir);
      if (s) out.push(s);
    }
  }
  return out;
});
ipcMain.handle('skill-save', (_e, { name, content }) => {
  name = sanitizeToolName(name || '');
  if (!name || !content) return { ok: false, error: 'name and content required' };
  try {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(), name + '.md'), content);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('skill-delete', (_e, name) => {
  try { fs.unlinkSync(path.join(skillsDir(), sanitizeToolName(name) + '.md')); } catch {}
  return { ok: true };
});

// ---- session fork + standing goal ----------------------------------------------------
ipcMain.handle('session-fork', (_e, id) => {
  const src = sessions.get(id);
  if (!src) return null;
  const rec = {
    id: newId(), title: (src.title + ' (fork)').slice(0, 60),
    cwd: src.cwd, model: src.model, mode: src.mode, effort: src.effort || null, goal: src.goal || null,
    createdAt: Date.now(), updatedAt: Date.now(),
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    agent: null,
    savedMessages: JSON.parse(JSON.stringify(src.agent ? src.agent.messages : (src.savedMessages || []))),
    transcript: JSON.parse(JSON.stringify(src.transcript)),
    abort: null, cur: null,
  };
  sessions.set(rec.id, rec);
  saveSession(rec);
  return metaOf(rec);
});
ipcMain.handle('session-goal', (_e, { id, goal }) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false };
  rec.goal = goal || null;
  if (rec.agent) rec.agent.setGoal(rec.goal);
  saveSession(rec);
  return { ok: true };
});

// ---- Appshot: ⌘⇧H captures the screen and attaches it to the active chat -------------
async function doAppshot() {
  const tmp = path.join(app.getPath('temp'), 'harness-appshot.png');
  await new Promise((res) => execFile('screencapture', ['-x', tmp], res));
  await new Promise((res) => execFile('sips', ['--resampleWidth', '1600', tmp], res));
  let buf;
  try { buf = fs.readFileSync(tmp); } catch { return; }
  if (buf.length < 1000) return;   // screen-recording permission not granted
  sendToUI('appshot', { name: 'appshot.png', dataUrl: 'data:image/png;base64,' + buf.toString('base64') });
  if (win) { win.show(); win.focus(); }
}

// ---- local AI-spend ledger: one number per local day, written on every turn -------
const spendPath = () => path.join(app.getPath('userData'), 'spend.json');
function localDay(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function loadSpend() {
  try { return JSON.parse(fs.readFileSync(spendPath(), 'utf8')); } catch {}
  // First run: seed from existing sessions, attributing each session's recorded
  // cost to its last-active day (approximate, but better than starting at zero).
  const days = {};
  for (const rec of sessions.values()) {
    if (rec.usage && rec.usage.cost) {
      const d = localDay(new Date(rec.updatedAt || Date.now()));
      days[d] = (days[d] || 0) + rec.usage.cost;
    }
  }
  const s = { days };
  try { fs.writeFileSync(spendPath(), JSON.stringify(s)); } catch {}
  return s;
}
function addSpend(cost) {
  if (!cost || cost <= 0) return;
  const s = loadSpend();
  const d = localDay(new Date());
  s.days[d] = (s.days[d] || 0) + cost;
  try { fs.writeFileSync(spendPath(), JSON.stringify(s)); } catch {}
}
ipcMain.handle('spend-summary', async () => {
  const s = loadSpend();
  const now = new Date();
  const today = localDay(now);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const sums = { today: 0, week: 0, month: 0, ytd: 0, allTime: 0 };
  for (const [day, cost] of Object.entries(s.days)) {
    const dt = new Date(day + 'T12:00:00');
    sums.allTime += cost;
    if (day === today) sums.today += cost;
    if (dt >= monday) sums.week += cost;
    if (dt >= monthStart) sums.month += cost;
    if (dt >= yearStart) sums.ytd += cost;
  }
  // last 14 days for the mini bar chart
  const bars = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const key = localDay(d);
    bars.push({ day: key, cost: s.days[key] || 0 });
  }
  const credits = await getCredits();
  return { ...sums, bars, credits };
});

// ---- OpenRouter credits (usage popover + spend page), cached 60s -------------------
let creditsCache = { at: 0, data: null };
function getCredits() {
  if (Date.now() - creditsCache.at < 60000 && creditsCache.data) return Promise.resolve(creditsCache.data);
  const cfg = loadConfig();
  if (!cfg.apiKey) return Promise.resolve(null);
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
}
ipcMain.handle('credits', () => getCredits());

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

// Generic sidebar-metadata patch: pin, unread, group, archive, title.
ipcMain.handle('session-meta', (_e, { id, patch }) => {
  const rec = sessions.get(id);
  if (!rec) return null;
  for (const k of ['pinned', 'unread', 'group', 'archived']) if (patch[k] !== undefined) rec[k] = patch[k];
  if (patch.title) rec.title = String(patch.title).slice(0, 60);
  saveSession(rec);
  sessionsChanged();
  return metaOf(rec);
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
    // effort follows the model too: restore what you last used with this model —
    // and clear it entirely for models that don't support reasoning at all
    if (patch.effort === undefined) rec.effort = supportsReasoning(patch.model) ? (cfg.effortByModel[patch.model] || null) : null;
  }
  if (patch.cwd) { rec.cwd = patch.cwd; cfg.cwd = patch.cwd; }
  if (patch.effort !== undefined) {
    rec.effort = supportsReasoning(rec.model) ? (patch.effort || null) : null;
    cfg.effortByModel[rec.model] = rec.effort;
  }
  saveConfig(cfg);
  if (rec.agent) {
    if (patch.model) rec.agent.setModel(rec.model);
    rec.agent.setMode(rec.mode);
    if (patch.cwd) rec.agent.setCwd(rec.cwd);
    rec.agent.setEffort(rec.effort || null);
  }
  saveSession(rec);
  return metaOf(rec);
});

ipcMain.handle('session-send', (_e, { id, text, images, modelText }) => {
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
  const sendText = modelText || text;   // skills expand for the model; the transcript shows what was typed
  const payload = images && images.length ? { text: sendText, images } : sendText;
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
