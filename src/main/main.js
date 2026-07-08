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
const { streamChat } = require('../agent/provider');

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
  cfg.allowRules = cfg.allowRules || [];             // [{kind, prefix, cwd}] — "always allow" rules
  if (cfg.sandboxBash === undefined) cfg.sandboxBash = true;
  return cfg;
}
function ruleMatches(kind, detail, cwd) {
  const cfg = loadConfig();
  return cfg.allowRules.some((r) => r.kind === kind && String(detail || '').startsWith(r.prefix) && (!r.cwd || r.cwd === cwd));
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
    vision: supportsVision(rec.model),
    pinned: !!rec.pinned, unread: !!rec.unread, group: rec.group || null, archived: !!rec.archived,
    worktree: rec.worktree || null,
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
        worktree: rec.worktree || null,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt, usage: rec.usage,
      },
      messages: rec.agent ? rec.agent.messages : (rec.savedMessages || []),
      transcript: rec.transcript,
      checkpoints: (rec.checkpoints || []).slice(-10),
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
        checkpoints: d.checkpoints || [],
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
            tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
            vision: !!(m.architecture && Array.isArray(m.architecture.input_modalities) && m.architecture.input_modalities.includes('image')),
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
      if (c.items && c.items.length && c.items[0].reasoning !== undefined && c.items[0].tools !== undefined && c.items[0].vision !== undefined && Date.now() - c.fetchedAt < 24 * 3600 * 1000) {
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
function supportsTools(model) {
  const m = (modelsMem || []).find((x) => x.value === model);
  return m ? !!m.tools : true;       // unknown model → assume native tool calling
}
function supportsVision(model) {
  const m = (modelsMem || []).find((x) => x.value === model);
  return m ? !!m.vision : true;   // unknown model → don't block
}
function ctxLimitOf(model) {
  const m = (modelsMem || []).find((x) => x.value === model);
  return m && m.context ? m.context : 0;
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
  else if (e.type === 'plan') {
    // keep only the latest plan in the persisted transcript
    rec.transcript = rec.transcript.filter((i) => i.t !== 'plan');
    rec.transcript.push({ t: 'plan', items: e.items });
  }
  else if (e.type === 'snapshot') {
    // checkpoint: remember each file's pre-change content once per turn (null = file was new)
    if (rec.curCkpt && Object.keys(rec.curCkpt.files).length < 40) {
      const abs = path.resolve(rec.cwd, e.path);
      if (!(abs in rec.curCkpt.files) && (e.before === null || e.before.length <= 300000)) {
        rec.curCkpt.files[abs] = e.before;
      }
    }
  }
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
    generateSuggestion(rec);   // fire-and-forget: ghost-text next-message suggestion
    generateTitle(rec);        // fire-and-forget: model-written chat title after the first exchange
  }
  else if (e.type === 'error') { flushAssistant(rec); rec.transcript.push({ t: 'err', text: e.message }); saveSession(rec); }
  else if (e.type === 'aborted') { flushAssistant(rec); rec.transcript.push({ t: 'note', text: 'stopped.' }); saveSession(rec); }
}
const turnListeners = new Map();   // sessionId -> Set<fn> — remote API subscribers
function onAgentEvent(rec, e) {
  foldEvent(rec, e);
  // the takeover overlay comes down the moment the controlling turn ends
  if ((e.type === 'done' || e.type === 'error' || e.type === 'aborted') &&
      typeof control !== 'undefined' && control && control.rec === rec) endControl();
  sendToUI('agent-event', Object.assign({ sessionId: rec.id }, e));
  const subs = turnListeners.get(rec.id);
  if (subs) for (const fn of subs) { try { fn(e); } catch {} }
}

function ensureAgent(rec) {
  const cfg = loadConfig();
  if (!rec.agent) {
    rec.agent = new Session({
      apiKey: cfg.apiKey, model: rec.model, cwd: rec.cwd, mode: rec.mode, effort: rec.effort || null,
      goal: rec.goal || null,
      textTools: !supportsTools(rec.model),
      ctxLimit: ctxLimitOf(rec.model),
      hooks: makeHooks(rec),
      extraTools: makeExtraTools(rec),
      emit: (e) => onAgentEvent(rec, e),
      approve: (kind, detail, opts = {}) => new Promise((resolve) => {
        // "always allow" rules auto-approve non-destructive requests
        if (!opts.danger && ruleMatches(kind, detail, rec.cwd)) {
          rec.transcript.push({ t: 'note', text: '✓ allowed by rule: ' + kind + ' ' + String(detail || '').slice(0, 60) });
          sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '✓ allowed by rule: ' + kind + ' ' + String(detail || '').slice(0, 60) });
          return resolve(true);
        }
        const aid = ++approvalSeq;
        pendingApprovals.set(aid, { resolve, kind, detail, cwd: rec.cwd });
        sendToUI('approval', { sessionId: rec.id, sessionTitle: rec.title, id: aid, kind, detail, danger: !!opts.danger });
      }),
      sandbox: loadConfig().sandboxBash !== false,
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
  try {   // purge trash entries older than 30 days
    const cutoff = Date.now() - 30 * 86400e3;
    for (const f of fs.readdirSync(path.join(app.getPath('userData'), 'trash'))) {
      const fp = path.join(app.getPath('userData'), 'trash', f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
  getModels(false);   // warm the catalog cache in the background
  syncMcpFromConfig();
  startApiServer();   // remote API for the iOS Harness bridge (localhost, token-gated)
  try { globalShortcut.register('CommandOrControl+Shift+H', doAppshot); } catch {}
  createWindow();
});
app.on('will-quit', () => {
  if (typeof control !== 'undefined' && control) endControl();
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
// Native cursor helper: glides the REAL cursor with eased motion (Codex-style)
// instead of teleporting. Falls back to cliclick if the binary is missing.
const HC_CURSOR = path.join(__dirname, '../../assets/hc-cursor');
const hasCursorHelper = () => { try { return fs.existsSync(HC_CURSOR); } catch { return false; } };
function cursorCmd(args) {
  return new Promise((resolve) => {
    execFile(HC_CURSOR, args.map(String), { timeout: 20000 },
      (err, so, se) => resolve(err ? { error: (se || err.message).slice(0, 200) + ' — needs Accessibility permission' } : { ok: true, out: (so || '').trim() }));
  });
}
async function getCursorPos() {
  if (hasCursorHelper()) {
    const r = await cursorCmd(['pos']);
    const m = (r.out || '').match(/(-?\d+),(-?\d+)/);
    if (m) return { x: +m[1], y: +m[2] };
  }
  return null;
}

// ---- takeover UI: click-through overlay + user-movement / Esc abort ------------------
let overlayWin = null;
let overlayReady = false;
function showOverlay() {
  if (overlayWin) { overlayWin.showInactive(); return; }
  const { screen } = require('electron');
  const b = screen.getPrimaryDisplay().bounds;
  overlayReady = false;
  overlayWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, alwaysOnTop: true, hasShadow: false,
    resizable: false, movable: false, focusable: false, skipTaskbar: true,
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  overlayWin.webContents.on('did-finish-load', () => { overlayReady = true; });
  overlayWin.on('closed', () => { overlayWin = null; overlayReady = false; });
}
function hideOverlay() { if (overlayWin) { try { overlayWin.close(); } catch {} overlayWin = null; overlayReady = false; } }
async function overlayJS(code) {
  for (let i = 0; i < 20 && !(overlayWin && overlayReady); i++) await sleep(150);
  if (overlayWin && overlayReady) return overlayWin.webContents.executeJavaScript(code).catch(() => {});
}

// Ghost-cursor mode: the agent drives a SECOND cursor rendered on the overlay —
// the user's physical cursor is never moved, so both can work at once. Clicks are
// posted directly at coordinates (hc-cursor tap). Esc hands control back.
let control = null;   // { rec, busy: false, startedAt }
function startControl(rec) {
  if (control && control.rec === rec) return;
  endControl();
  control = { rec, busy: false, startedAt: Date.now() };
  showOverlay();
  overlayJS('showGhost()');
  try { globalShortcut.register('Escape', () => abortControl('Esc pressed')); } catch {}
}
function endControl() {
  if (!control) return;
  try { globalShortcut.unregister('Escape'); } catch {}
  hideOverlay();
  control = null;
}
function abortControl(why) {
  const rec = control && control.rec;
  endControl();
  if (rec) {
    rec.transcript.push({ t: 'note', text: '🖱 control returned — ' + why });
    sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '🖱 control returned — ' + why });
    if (rec.abort) rec.abort.abort();
  }
}
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
    schema: { name: 'computer_screenshot', description: 'Capture the primary screen. The image is attached in the next message — a coordinate you read off it is exactly the coordinate to click. Your ORANGE "AI" cursor is visible in the shot: use it to verify your aim (move → screenshot → adjust → click). Always take a fresh screenshot after each action.', parameters: { type: 'object', properties: {} } },
    gate: () => ({ kind: 'computer', detail: 'take a screenshot of the screen', danger: false }),
    run: async (a, rec) => {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      const tmp = path.join(app.getPath('temp'), 'hc-screen.png');
      if (rec && !supportsVision(rec.model)) return { error: 'this model cannot see images — switch to a vision model (🖼 in the picker) to use screenshots' };
      if (rec) { startControl(rec); control.busy = true; }
      // banner/frame out of the shot, but the AI ghost cursor STAYS visible —
      // that's how the model verifies its aim before clicking
      await overlayJS('setShotMode(true)');
      await new Promise((res) => execFile('screencapture', ['-x', '-m', tmp], res));
      await overlayJS('setShotMode(false)');
      if (control) control.busy = false;
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
    schema: { name: 'computer_move', description: 'Glide your orange AI cursor to coordinates from the latest screenshot WITHOUT clicking. This is a SECOND cursor — the user keeps theirs. Best practice: move, screenshot to verify the AI cursor is on the target, adjust, THEN click.', parameters: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' },
    }, required: ['x', 'y'] } },
    gate: (a) => ({ kind: 'computer', detail: 'move AI cursor to (' + a.x + ', ' + a.y + ')', danger: false }),
    run: async (a, rec) => {
      const sx = Math.round(a.x * shotScale), sy = Math.round(a.y * shotScale);
      if (rec) { startControl(rec); control.busy = true; }
      await overlayJS('moveGhost(' + sx + ',' + sy + ',450)');
      await sleep(500);
      if (control) control.busy = false;
      return { ok: true, cursor_at: { x: a.x, y: a.y } };
    },
  },
  computer_click: {
    schema: { name: 'computer_click', description: 'Click with your AI cursor at coordinates from the latest screenshot (the user\'s own cursor is not moved). For accuracy, prefer computer_move → screenshot (verify the AI cursor is on target) → click the same coordinates.', parameters: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' },
      double: { type: 'boolean' }, right: { type: 'boolean' },
    }, required: ['x', 'y'] } },
    gate: (a) => ({ kind: 'computer', detail: 'click at (' + a.x + ', ' + a.y + ')' + (a.double ? ' double' : a.right ? ' right' : ''), danger: true }),
    run: async (a, rec) => {
      const sx = Math.round(a.x * shotScale), sy = Math.round(a.y * shotScale);
      if (rec) { startControl(rec); control.busy = true; }
      await overlayJS('moveGhost(' + sx + ',' + sy + ',450)');
      await sleep(500);
      const kind = a.double ? 'double' : a.right ? 'right' : 'left';
      let r;
      if (hasCursorHelper()) r = await cursorCmd(['tap', sx, sy, kind]);
      else r = await cli([(a.double ? 'dc:' : a.right ? 'rc:' : 'c:') + sx + ',' + sy]);   // fallback moves the real cursor
      await overlayJS('clickGhost()');
      if (control) control.busy = false;
      return r;
    },
  },
  computer_type: {
    schema: { name: 'computer_type', description: 'Type text at the current focus (click the target field first).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    gate: (a) => ({ kind: 'computer', detail: 'type: ' + String(a.text || '').slice(0, 80), danger: true }),
    run: async (a, rec) => {
      if (rec) { startControl(rec); control.busy = true; }
      const r = await cli(['t:' + String(a.text || '')]);
      if (control) control.busy = false;
      return r;
    },
  },
  computer_key: {
    schema: { name: 'computer_key', description: 'Press a key, optionally with modifiers. Keys: return, esc, tab, space, delete, arrow-up/down/left/right, page-up, page-down, home, end, f1-f12. Modifiers: cmd, shift, alt, ctrl (comma-separated).', parameters: { type: 'object', properties: {
      key: { type: 'string' }, modifiers: { type: 'string', description: 'e.g. "cmd" or "cmd,shift"' },
    }, required: ['key'] } },
    gate: (a) => ({ kind: 'computer', detail: 'press ' + (a.modifiers ? a.modifiers + '+' : '') + a.key, danger: true }),
    run: async (a, rec) => {
      const key = KEY_MAP[String(a.key || '').toLowerCase()] || String(a.key || '').toLowerCase();
      const mods = String(a.modifiers || '').split(',').map((s) => s.trim()).filter(Boolean);
      // single printable character with modifiers → key-down mods, type char, key-up
      const args = [];
      if (mods.length) args.push('kd:' + mods.join(','));
      args.push(/^[a-z0-9]$/.test(key) ? 't:' + key : 'kp:' + key);
      if (mods.length) args.push('ku:' + mods.join(','));
      if (rec) { startControl(rec); control.busy = true; }
      const r = await cli(args);
      if (control) control.busy = false;
      return r;
    },
  },
  computer_open_app: {
    schema: { name: 'computer_open_app', description: 'Open (or bring to front) a macOS application by name, e.g. "Safari", "Finder".', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    gate: (a) => ({ kind: 'computer', detail: 'open app: ' + (a.name || ''), danger: false }),
    run: (a) => new Promise((resolve) => execFile('open', ['-a', String(a.name || '')], (err) => resolve(err ? { error: 'no such app: ' + a.name } : { ok: true }))),
  },
};

// Sub-agent: the model can delegate a self-contained task to a fresh agent with its
// own context window. Sub-agents cannot spawn further sub-agents.
const AGENT_TOOL_SCHEMA = {
  name: 'agent',
  description: 'Delegate a self-contained task to a sub-agent with a FRESH context (it does not see this conversation). Give it complete instructions and everything it needs to know. It has the same tools (files, bash, browser) and returns its final report. Use for parallel-izable or context-heavy subtasks like "audit all files under src/ for X".',
  parameters: { type: 'object', properties: {
    task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent.' },
  }, required: ['task'] },
};
async function runSubAgent(rec, task) {
  const cfg = loadConfig();
  let finalText = '';
  let toolsUsed = 0;
  const sub = new Session({
    apiKey: cfg.apiKey, model: rec.model, cwd: rec.cwd, mode: rec.mode,
    effort: rec.effort || null, textTools: !supportsTools(rec.model),
    sandbox: cfg.sandboxBash !== false,
    extraTools: makeExtraTools(rec, true),
    emit: (e) => {
      if (e.type === 'tool_call') { toolsUsed++; sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '· sub-agent → ' + e.name }); }
      if (e.type === 'done') finalText = e.text || '';
      if (e.type === 'error') finalText = '[sub-agent error] ' + e.message;
    },
    approve: (kind, detail, opts = {}) => new Promise((resolve) => {
      if (!opts.danger && ruleMatches(kind, detail, rec.cwd)) return resolve(true);
      const aid = ++approvalSeq;
      pendingApprovals.set(aid, { resolve, kind, detail, cwd: rec.cwd });
      sendToUI('approval', { sessionId: rec.id, sessionTitle: rec.title + ' · sub-agent', id: aid, kind, detail, danger: !!opts.danger });
    }),
  });
  await sub.send(task, rec.abort ? rec.abort.signal : undefined);
  return { report: (finalText || '(no report)').slice(0, 20000), tools_used: toolsUsed };
}

function makeExtraTools(rec, noAgent) {
  return {
    get schemas() {
      const out = [...Object.values(BROWSER_TOOLS), ...Object.values(COMPUTER_TOOLS)].map((t) => ({ type: 'function', function: t.schema }));
      if (!noAgent) out.push({ type: 'function', function: AGENT_TOOL_SCHEMA });
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
      if (name === 'agent' && !noAgent) return true;
      return name.startsWith('mcp__') && this._route(name) !== null;
    },
    gate(name, args) {
      if (BROWSER_TOOLS[name]) return BROWSER_TOOLS[name].gate(args || {});
      if (COMPUTER_TOOLS[name]) return COMPUTER_TOOLS[name].gate(args || {});
      if (name === 'agent') return { kind: 'agent', detail: String((args || {}).task || '').slice(0, 160), danger: false };
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
      if (COMPUTER_TOOLS[name]) return COMPUTER_TOOLS[name].run(args || {}, rec);
      if (name === 'agent' && !noAgent) return runSubAgent(rec, String((args || {}).task || ''));
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

// ---- ghost-text suggestions: after each turn, a cheap model drafts the user's
// likely next message; the composer shows it as placeholder text, Tab accepts it.
async function generateSuggestion(rec) {
  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.suggestions === false) return;
  const tail = rec.transcript.slice(-6)
    .map((i) => i.t === 'user' ? 'USER: ' + i.text : i.t === 'assistant' ? 'ASSISTANT: ' + (i.text || '').slice(0, 600) : '')
    .filter(Boolean).join('\n').slice(-2500);
  if (!tail) return;
  try {
    const res = await streamChat({
      apiKey: cfg.apiKey, model: 'deepseek/deepseek-v4-flash', tools: null,
      messages: [
        { role: 'system', content: 'You draft the user\'s most likely NEXT message in this coding-assistant conversation: one short, actionable instruction that continues the work (a natural follow-up, verification step, or next feature). Reply with ONLY that message. Max 12 words. No quotes, no explanations.' },
        { role: 'user', content: tail },
      ],
    });
    const text = (res.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').split('\n')[0].slice(0, 120);
    if (text) sendToUI('suggest', { sessionId: rec.id, text });
  } catch {}
}

// After the first exchange, replace the truncated-first-message title with a real one.
async function generateTitle(rec) {
  const cfg = loadConfig();
  if (!cfg.apiKey || rec.titled) return;
  if (rec.transcript.filter((i) => i.t === 'user').length !== 1) return;
  rec.titled = true;
  const tail = rec.transcript.slice(0, 8)
    .map((i) => (i.t === 'user' ? 'USER: ' + i.text : i.t === 'assistant' ? 'ASSISTANT: ' + (i.text || '').slice(0, 300) : ''))
    .filter(Boolean).join('\n').slice(0, 1800);
  try {
    const res = await streamChat({
      apiKey: cfg.apiKey, model: 'deepseek/deepseek-v4-flash', tools: null,
      messages: [
        { role: 'system', content: 'Write a 3-6 word title for this coding chat. Reply with ONLY the title — no quotes, no trailing punctuation.' },
        { role: 'user', content: tail },
      ],
    });
    const t = (res.content || '').trim().replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0].slice(0, 48);
    if (t) { rec.title = t; saveSession(rec); sessionsChanged(); }
  } catch {}
}

// ---- cross-session search (sidebar) --------------------------------------------------
ipcMain.handle('sessions-search', (_e, q) => {
  q = String(q || '').toLowerCase().trim();
  if (!q) return null;
  const ids = [];
  for (const rec of sessions.values()) {
    if (rec.title.toLowerCase().includes(q)) { ids.push(rec.id); continue; }
    if (rec.transcript.some((i) => (i.text || '').toLowerCase().includes(q))) ids.push(rec.id);
  }
  return ids;
});

// ---- per-file discard in the Changes panel -------------------------------------------
ipcMain.handle('git-discard', async (_e, { id, file, status }) => {
  const rec = sessions.get(id);
  if (!rec) return { error: 'no session' };
  if (status === '??' || status === 'U') {
    try { fs.rmSync(path.resolve(rec.cwd, file)); return { ok: true }; }
    catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
  }
  const r = await git(rec.cwd, ['checkout', '--', file]);
  return r.err ? { error: (r.se || 'checkout failed').slice(0, 120) } : { ok: true };
});

// ---- tool hooks: ~/.harness-code/hooks.json {"pre_tool": "cmd", "post_tool": "cmd"} ----
// pre_tool runs before every tool (env: HC_TOOL, HC_ARGS, HC_CWD); non-zero exit BLOCKS
// the tool with stderr as the reason. post_tool runs after, fire-and-forget.
function loadHooks() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('home'), '.harness-code', 'hooks.json'), 'utf8')); }
  catch { return {}; }
}
function runHook(cmd, env) {
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-lc', cmd], { timeout: 10000, env: { ...process.env, ...env } },
      (err, _so, se) => resolve(err ? { ok: false, reason: (se || err.message).trim().slice(0, 200) } : { ok: true }));
  });
}
function makeHooks(rec) {
  return {
    pre: async (name, args) => {
      const h = loadHooks();
      if (!h.pre_tool) return { ok: true };
      return runHook(h.pre_tool, { HC_TOOL: name, HC_ARGS: JSON.stringify(args || {}).slice(0, 8000), HC_CWD: rec.cwd });
    },
    post: (name, args, result) => {
      const h = loadHooks();
      if (h.post_tool) runHook(h.post_tool, { HC_TOOL: name, HC_ARGS: JSON.stringify(args || {}).slice(0, 8000), HC_CWD: rec.cwd, HC_RESULT: JSON.stringify(result || {}).slice(0, 8000) });
    },
  };
}

// ---- self-update: pull latest from GitHub, refresh the bundle, offer relaunch ---------
ipcMain.handle('self-update', async () => {
  const repo = path.join(app.getPath('home'), 'harness-code');
  const pull = await git(repo, ['pull', '--ff-only']);
  if (pull.err) return { error: ('git pull: ' + (pull.se || '')).slice(0, 200) };
  const appDir = '/Applications/Harness Code.app/Contents/Resources/app';
  try {
    fs.cpSync(path.join(repo, 'src'), path.join(appDir, 'src'), { recursive: true });
    fs.cpSync(path.join(repo, 'assets'), path.join(appDir, 'assets'), { recursive: true });
    fs.cpSync(path.join(repo, 'package.json'), path.join(appDir, 'package.json'));
  } catch (e) { return { error: 'copy failed: ' + String(e.message).slice(0, 150) }; }
  await new Promise((res) => execFile('codesign', ['--force', '--deep', '--sign', 'Apple Development: JADEN CALEB KWEK (Y3L6295L7T)', '/Applications/Harness Code.app'], res));
  return { ok: true, out: pull.so.split('\n')[0] };
});
ipcMain.handle('app-relaunch', () => { app.relaunch(); app.exit(0); });

// ---- voice input: MediaRecorder audio → ffmpeg → local whisper-cli --------------------
ipcMain.handle('transcribe', async (_e, b64) => {
  const tmpIn = path.join(app.getPath('temp'), 'hc-voice.webm');
  const tmpWav = path.join(app.getPath('temp'), 'hc-voice.wav');
  try { fs.writeFileSync(tmpIn, Buffer.from(b64, 'base64')); } catch { return { error: 'write failed' }; }
  const ff = await new Promise((res) => execFile('/opt/homebrew/bin/ffmpeg', ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', tmpWav], { timeout: 30000 }, (err, _o, se) => res({ err, se })));
  if (ff.err) return { error: 'ffmpeg: ' + String(ff.se || '').slice(-120) };
  return new Promise((resolve) => {
    execFile('/opt/homebrew/bin/whisper-cli',
      ['-m', path.join(app.getPath('home'), '.whisper-models/ggml-base.en.bin'), '-f', tmpWav, '-np', '-nt'],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, so, se) => resolve(err ? { error: 'whisper: ' + String(se || err.message).slice(-120) } : { text: (so || '').trim() }));
  });
});
ipcMain.handle('mic-permission', async () => {
  try { const { systemPreferences } = require('electron'); return { granted: await systemPreferences.askForMediaAccess('microphone') }; }
  catch { return { granted: true }; }
});

// ---- remote API: lets the Mac harness server (and through it the iOS Harness app)
// drive sessions. Localhost-only, token-gated (~/.harness-code/api-token — the same
// folder the harness server already reads). Because remote turns run through the
// SAME session records and event bus, they stream live in the desktop UI too.
const crypto = require('crypto');
const apiTokenPath = () => path.join(app.getPath('home'), '.harness-code', 'api-token');
function apiToken() {
  try { const t = fs.readFileSync(apiTokenPath(), 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.mkdirSync(path.dirname(apiTokenPath()), { recursive: true }); fs.writeFileSync(apiTokenPath(), t, { mode: 0o600 }); } catch {}
  return t;
}
const API_FORWARD = ['text', 'reasoning', 'tool_call', 'tool_result', 'plan', 'auto_approved', 'approval_request', 'control_note', 'done', 'error', 'aborted', 'compacted'];
function startApiServer() {
  apiToken();   // materialize the token file so clients can read it before the first request
  const srv = http.createServer((req, res) => {
    if ((req.headers['x-hc-token'] || '') !== apiToken()) { res.writeHead(401); return res.end('unauthorized'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 30e6) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch {}
      const json = (obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, 'http://localhost');
      const sendMatch = u.pathname.match(/^\/api\/sessions\/([^/]+)\/send$/);
      if (req.method === 'GET' && u.pathname === '/api/sessions') {
        return json([...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(metaOf));
      }
      const getMatch = u.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && getMatch) {
        const rec = sessions.get(getMatch[1]);
        if (!rec) return json({ error: 'no such session' }, 404);
        return json({ meta: metaOf(rec), transcript: rec.transcript });
      }
      if (req.method === 'GET' && u.pathname === '/api/models') {
        return json((modelsMem || []).map((m) => ({ value: m.value, label: m.label })));
      }
      if (req.method === 'POST' && u.pathname === '/api/sessions') {
        const cfg = loadConfig();
        const rec = {
          id: newId(), title: 'New chat',
          cwd: data.cwd || cfg.cwd, model: data.model || cfg.model, mode: data.mode || cfg.mode,
          effort: null, goal: null,
          createdAt: Date.now(), updatedAt: Date.now(),
          usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
          agent: null, savedMessages: [], transcript: [], abort: null, cur: null, checkpoints: [],
        };
        sessions.set(rec.id, rec);
        saveSession(rec);
        sessionsChanged();
        return json(metaOf(rec));
      }
      if (req.method === 'POST' && sendMatch) {
        const rec = sessions.get(sendMatch[1]);
        if (!rec) return json({ error: 'no such session' }, 404);
        if (rec.abort) return json({ error: 'busy' }, 409);
        // apply per-turn model/mode overrides from the phone
        if (data.model && data.model !== rec.model) { rec.model = data.model; if (rec.agent) { rec.agent.setModel(rec.model); rec.agent.textTools = !supportsTools(rec.model); } }
        if (data.mode && data.mode !== rec.mode) { rec.mode = data.mode; if (rec.agent) rec.agent.setMode(rec.mode); }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
        let subs = turnListeners.get(rec.id);
        if (!subs) { subs = new Set(); turnListeners.set(rec.id, subs); }
        const listener = (e) => {
          if (!API_FORWARD.includes(e.type)) return;
          const out = { ...e };
          if (out.type === 'tool_result' && out.result) out.result = { error: out.result.error, ok: !out.result.error };
          try { res.write(JSON.stringify(out) + '\n'); } catch {}
          if (e.type === 'done' || e.type === 'error' || e.type === 'aborted') {
            subs.delete(listener);
            try { res.end(); } catch {}
          }
        };
        subs.add(listener);
        res.on('close', () => subs.delete(listener));   // phone disconnect: turn keeps running
        const r = beginTurn(rec, { text: String(data.text || ''), images: Array.isArray(data.images) ? data.images : undefined, remote: true });
        if (!r.ok) { subs.delete(listener); try { res.write(JSON.stringify({ type: 'error', message: r.error }) + '\n'); res.end(); } catch {} }
        return;
      }
      json({ error: 'not found' }, 404);
    });
  });
  // Bind the first free port in the range and publish it for clients (the Mac
  // harness server reads ~/.harness-code/api-port next to the token).
  const ports = [8799, 8798, 8797, 8796, 8795];
  let pi = 0;
  srv.on('error', () => { if (++pi < ports.length) srv.listen(ports[pi], '127.0.0.1'); });
  srv.on('listening', () => {
    const write = () => { try { fs.writeFileSync(path.join(path.dirname(apiTokenPath()), 'api-port'), String(ports[pi])); } catch {} };
    write();
    setInterval(write, 60000);   // self-heal: a stale file from a dead instance gets reclaimed
  });
  srv.listen(ports[0], '127.0.0.1');
}


// ---- read-only CLI session viewer: browse claude/codex desktop-CLI transcripts ------
// (ports of the harness server's parsers; live-tailed by the renderer via polling)
const CLAUDE_SESS = path.join(app.getPath('home'), '.claude', 'projects');
const CODEX_SESS = path.join(app.getPath('home'), '.codex', 'sessions');

// Bounded reads — CLI transcripts can be hundreds of MB; never load them whole.
function readSlice(file, start, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(bytes);
    const n = fs.readSync(fd, b, 0, bytes, start);
    fs.closeSync(fd);
    return b.slice(0, n).toString('utf8');
  } catch { return ''; }
}
function cliLines(file, full) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return null; }
  const head = readSlice(file, 0, 256 * 1024).split('\n');
  if (!full || size <= 256 * 1024) return head;
  const tailStart = Math.max(0, size - 2 * 1024 * 1024);
  const tail = readSlice(file, tailStart, 2 * 1024 * 1024).split('\n').slice(1);   // drop partial first line
  return head.slice(0, 200).concat(tail);
}
function parseClaudeCli(file, full) {
  let cwd = null, title = null, turns = 0;
  const messages = [];
  const lines = cliLines(file, full);
  if (!lines) return null;
  const limit = full ? 6000 : 400;
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.isSidechain) continue;
    if (!cwd && d.cwd) cwd = d.cwd;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const m = d.message || {};
    let c = m.content;
    if (Array.isArray(c)) c = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
    if (typeof c !== 'string' || !c.trim()) continue;
    turns++;
    if (d.type === 'user' && !title && !c.trim().startsWith('<')) title = c.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (full) messages.push({ role: d.type, text: c.slice(0, 6000) });
  }
  const out = { engine: 'claude', path: file, cwd: cwd || app.getPath('home'),
    title: title || ('Claude session ' + path.basename(file).slice(0, 8)),
    updated: 0, turns };
  try { out.updated = fs.statSync(file).mtimeMs; } catch {}
  if (full) out.messages = messages.slice(-120);
  return out;
}

function parseCodexCli(file, full) {
  let cwd = null, title = null, turns = 0;
  const messages = [];
  const lines = cliLines(file, full);
  if (!lines) return null;
  const limit = full ? 6000 : 500;
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    const pl = d.payload || {};
    if ((d.type === 'session_meta' || pl.type === 'session_meta') && !cwd) cwd = pl.cwd || cwd;
    if (pl.type === 'turn_context' && !cwd) cwd = pl.cwd;
    if (d.type === 'response_item' && pl.type === 'message') {
      const role = pl.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const txt = (pl.content || []).filter((b) => b && ['input_text', 'output_text', 'text'].includes(b.type)).map((b) => b.text || '').join(' ');
      if (!txt.trim()) continue;
      turns++;
      if (role === 'user' && !title && !txt.trim().startsWith('<')) title = txt.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (full) messages.push({ role, text: txt.slice(0, 6000) });
    }
  }
  const out = { engine: 'codex', path: file, cwd: cwd || app.getPath('home'),
    title: title || ('Codex session ' + path.basename(file).slice(-14, -6)),
    updated: 0, turns };
  try { out.updated = fs.statSync(file).mtimeMs; } catch {}
  if (full) out.messages = messages.slice(-120);
  return out;
}

function cliSessionFiles() {
  const out = [];
  try {
    for (const proj of fs.readdirSync(CLAUDE_SESS)) {
      const dir = path.join(CLAUDE_SESS, proj);
      let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const f of ents) if (f.endsWith('.jsonl')) {
        const fp = path.join(dir, f);
        try { out.push({ engine: 'claude', path: fp, mtime: fs.statSync(fp).mtimeMs }); } catch {}
      }
    }
  } catch {}
  const walkCodex = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walkCodex(fp, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { out.push({ engine: 'codex', path: fp, mtime: fs.statSync(fp).mtimeMs }); } catch {}
      }
    }
  };
  walkCodex(CODEX_SESS, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 30);
}

function cliPathAllowed(fp) {
  const r1 = path.relative(CLAUDE_SESS, fp), r2 = path.relative(CODEX_SESS, fp);
  return (!r1.startsWith('..') && !path.isAbsolute(r1)) || (!r2.startsWith('..') && !path.isAbsolute(r2));
}

ipcMain.handle('cli-sessions', () => {
  return cliSessionFiles()
    .map((f) => (f.engine === 'claude' ? parseClaudeCli(f.path, false) : parseCodexCli(f.path, false)))
    .filter((s) => s && s.turns > 0);
});
ipcMain.handle('cli-session-get', (_e, fp) => {
  if (!cliPathAllowed(fp)) return null;
  return fs.existsSync(fp) ? (fp.includes('/.claude/') ? parseClaudeCli(fp, true) : parseCodexCli(fp, true)) : null;
});

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
  return { hasKey: !!c.apiKey, model: c.model, mode: c.mode, cwd: c.cwd, sandboxBash: c.sandboxBash !== false, suggestions: c.suggestions !== false };
});
ipcMain.handle('set-config', (_e, patch) => {
  const c = loadConfig();
  saveConfig({ ...c, ...patch });
  if (patch.apiKey) for (const rec of sessions.values()) if (rec.agent) rec.agent.apiKey = patch.apiKey;
  if (patch.sandboxBash !== undefined) for (const rec of sessions.values()) if (rec.agent) rec.agent.sandbox = !!patch.sandboxBash;
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

// Deletion is a soft delete: the session file moves to a trash folder (restorable
// from Settings); entries older than 30 days are purged at boot.
const trashDir = () => path.join(app.getPath('userData'), 'trash');
ipcMain.handle('session-delete', async (_e, id) => {
  const rec = sessions.get(id);
  if (rec) {
    if (rec.abort) rec.abort.abort();
    saveSession(rec);   // capture the latest state before trashing
    sessions.delete(id);
    try {
      fs.mkdirSync(trashDir(), { recursive: true });
      fs.renameSync(sessionFile(id), path.join(trashDir(), id + '.json'));
    } catch { try { fs.unlinkSync(sessionFile(id)); } catch {} }
    if (rec.worktree) {   // clean up the isolated worktree with the session
      await git(rec.worktree.repo, ['worktree', 'remove', '--force', rec.worktree.path]);
      await git(rec.worktree.repo, ['branch', '-D', rec.worktree.branch]);
    }
  }
  return { ok: true };
});
ipcMain.handle('trash-list', () => {
  let out = [];
  try {
    for (const f of fs.readdirSync(trashDir())) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(trashDir(), f);
      try {
        const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
        out.push({ id: d.meta.id, title: d.meta.title, deletedAt: fs.statSync(fp).mtimeMs, items: (d.transcript || []).length });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
});
ipcMain.handle('trash-restore', (_e, id) => {
  const src = path.join(trashDir(), id + '.json');
  try {
    const d = JSON.parse(fs.readFileSync(src, 'utf8'));
    fs.renameSync(src, sessionFile(id));
    sessions.set(d.meta.id, {
      ...d.meta,
      usage: d.meta.usage || { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      agent: null, savedMessages: d.messages || [], transcript: d.transcript || [],
      checkpoints: d.checkpoints || [], abort: null, cur: null,
    });
    sessionsChanged();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 120) }; }
});
ipcMain.handle('trash-purge', (_e, id) => {
  try {
    if (id) fs.unlinkSync(path.join(trashDir(), id + '.json'));
    else for (const f of fs.readdirSync(trashDir())) fs.unlinkSync(path.join(trashDir(), f));
  } catch {}
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
    if (patch.model) {
      const oldLimit = rec.agent.ctxLimit || 0;
      rec.agent.setModel(rec.model);
      rec.agent.textTools = !supportsTools(rec.model);
      rec.agent.setCtxLimit(ctxLimitOf(rec.model));
      // moving up in context: refill the model's memory from the full transcript
      if (ctxLimitOf(rec.model) > oldLimit * 1.5 && rec.agent.messages.length < rec.transcript.length / 3) {
        if (rec.agent.rehydrate(rec.transcript)) {
          rec.transcript.push({ t: 'note', text: '🧠 restored conversation memory from the transcript for the larger context window' });
          sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '🧠 restored conversation memory from the transcript' });
        }
      }
    }
    rec.agent.setMode(rec.mode);
    if (patch.cwd) rec.agent.setCwd(rec.cwd);
    rec.agent.setEffort(rec.effort || null);
  }
  saveSession(rec);
  return metaOf(rec);
});

// One turn pipeline shared by the renderer (IPC) and the remote API (iOS harness).
// `remote` additionally mirrors the user bubble into the desktop UI.
function beginTurn(rec, { text, images, modelText, remote }) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    sendToUI('agent-event', { sessionId: rec.id, type: 'error', message: 'No OpenRouter API key set — open Settings.' });
    return { ok: false, error: 'no key' };
  }
  if (rec.abort) return { ok: false, error: 'busy' };
  if (rec.title === 'New chat') {
    rec.title = text.split('\n')[0].slice(0, 48) || 'New chat';
    sessionsChanged();
  }
  rec.transcript.push({ t: 'user', text, images: images && images.length ? images.length : 0, remote: !!remote });
  if (remote) sendToUI('agent-event', { sessionId: rec.id, type: 'remote_user', text });
  rec.updatedAt = Date.now();
  const agent = ensureAgent(rec);
  const convo = rec.transcript.filter((i) => i.t === 'user' || i.t === 'assistant').length;
  if (convo > 16 && agent.messages.length < Math.min(30, convo / 4) && ctxLimitOf(rec.model) > 60000) {
    if (agent.rehydrate(rec.transcript)) {
      sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '🧠 restored conversation memory from the transcript' });
    }
  }
  rec.abort = new AbortController();
  rec.curCkpt = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), files: {} };
  sessionsChanged();
  const sendText = modelText || text;   // skills expand for the model; the transcript shows what was typed
  const payload = images && images.length ? { text: sendText, images } : sendText;
  (async () => {
    try {
      // auto-compact when the context window is ~75% full (like Claude Code)
      const limit = ctxLimitOf(rec.model);
      if (limit && rec.usage.context > 0.7 * Math.max(limit - 4600, limit * 0.5) && agent.messages.length > 8) {
        rec.transcript.push({ t: 'note', text: '✦ context ~' + Math.round(rec.usage.context / limit * 100) + '% full — auto-compacting' });
        sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: '✦ context nearly full — auto-compacting first' });
        try { await agent.compact(rec.abort.signal); } catch {}
        rec.usage.context = 0;
      }
      await agent.send(payload, rec.abort.signal);
    }
    catch (err) { onAgentEvent(rec, { type: 'error', message: String((err && err.message) || err) }); }
    finally {
      // finalize the turn's checkpoint if any files were touched
      if (rec.curCkpt && Object.keys(rec.curCkpt.files).length) {
        rec.checkpoints = (rec.checkpoints || []).slice(-19);
        rec.checkpoints.push(rec.curCkpt);
        rec.transcript.push({ t: 'ckpt', id: rec.curCkpt.id, files: Object.keys(rec.curCkpt.files).length });
        sendToUI('agent-event', { sessionId: rec.id, type: 'checkpoint', ckptId: rec.curCkpt.id, files: Object.keys(rec.curCkpt.files).length });
      }
      rec.curCkpt = null;
      rec.abort = null; saveSession(rec); sessionsChanged();
    }
  })();
  return { ok: true };
}

ipcMain.handle('session-send', (_e, { id, text, images, modelText }) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false, error: 'no such session' };
  return beginTurn(rec, { text, images, modelText });
});

// Rewind: restore every file a turn touched to its pre-turn contents.
ipcMain.handle('session-revert', (_e, { id, ckptId }) => {
  const rec = sessions.get(id);
  if (!rec) return { ok: false, error: 'no session' };
  const ck = (rec.checkpoints || []).find((c) => c.id === ckptId);
  if (!ck) return { ok: false, error: 'checkpoint no longer available' };
  let restored = 0, removed = 0, failed = 0;
  for (const [abs, before] of Object.entries(ck.files)) {
    try {
      if (before === null) { if (fs.existsSync(abs)) { fs.unlinkSync(abs); removed++; } }
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, before); restored++; }
    } catch { failed++; }
  }
  const msg = '⤺ reverted turn: ' + restored + ' file(s) restored' + (removed ? ', ' + removed + ' new file(s) removed' : '') + (failed ? ', ' + failed + ' failed' : '');
  rec.transcript.push({ t: 'note', text: msg });
  sendToUI('agent-event', { sessionId: rec.id, type: 'control_note', message: msg });
  saveSession(rec);
  return { ok: true, restored, removed, failed };
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

ipcMain.on('approval-response', (_e, { id, approved, always }) => {
  const p = pendingApprovals.get(id);
  if (!p) return;
  pendingApprovals.delete(id);
  if (approved && always) {
    // rule prefix = the first two tokens of the request ("npm test", "git push"…)
    const prefix = String(p.detail || '').split(/\s+/).slice(0, 2).join(' ').slice(0, 60) || p.kind;
    const cfg = loadConfig();
    if (!cfg.allowRules.some((r) => r.kind === p.kind && r.prefix === prefix && r.cwd === p.cwd)) {
      cfg.allowRules.push({ kind: p.kind, prefix, cwd: p.cwd });
      saveConfig(cfg);
    }
  }
  p.resolve(!!approved);
});
ipcMain.handle('rules-list', () => loadConfig().allowRules);
ipcMain.handle('rule-remove', (_e, idx) => {
  const cfg = loadConfig();
  cfg.allowRules.splice(idx, 1);
  saveConfig(cfg);
  return cfg.allowRules;
});

// ---- mid-turn steering: inject a user message into the RUNNING turn -----------------
ipcMain.handle('session-steer', (_e, { id, text }) => {
  const rec = sessions.get(id);
  if (!rec || !rec.abort || !rec.agent) return { ok: false, error: 'not running' };
  rec.agent.steer(text);
  rec.transcript.push({ t: 'user', text, steered: true });
  return { ok: true };
});

// ---- worktrees: fork a session into an isolated git worktree ------------------------
ipcMain.handle('session-worktree', async (_e, id) => {
  const src = sessions.get(id);
  if (!src) return { error: 'no session' };
  const head = await git(src.cwd, ['rev-parse', '--show-toplevel']);
  if (head.err) return { error: 'not a git repository' };
  const repo = head.so.trim();
  const short = Date.now().toString(36).slice(-5);
  const wtPath = path.join(path.dirname(repo), path.basename(repo) + '-wt-' + short);
  const r = await git(repo, ['worktree', 'add', '-b', 'harness/' + short, wtPath]);
  if (r.err) return { error: 'git worktree failed: ' + (r.se || '').slice(0, 200) };
  const rec = {
    id: newId(), title: (src.title + ' ⌥' + short).slice(0, 60),
    cwd: wtPath, model: src.model, mode: src.mode, effort: src.effort || null, goal: src.goal || null,
    worktree: { repo, path: wtPath, branch: 'harness/' + short },
    createdAt: Date.now(), updatedAt: Date.now(),
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    agent: null, savedMessages: [], transcript: [{ t: 'note', text: '⌥ isolated worktree on branch harness/' + short + ' — ' + wtPath }],
    abort: null, cur: null, checkpoints: [],
  };
  sessions.set(rec.id, rec);
  saveSession(rec);
  return metaOf(rec);
});

// ---- one-click commit / PR from the Changes panel ------------------------------------
ipcMain.handle('git-commit', async (_e, { id, message }) => {
  const rec = sessions.get(id);
  if (!rec) return { error: 'no session' };
  const a = await git(rec.cwd, ['add', '-A']);
  if (a.err) return { error: (a.se || 'git add failed').slice(0, 200) };
  const c = await git(rec.cwd, ['commit', '-m', message || 'Changes via Harness Code']);
  if (c.err) return { error: (c.se || c.so || 'nothing to commit').slice(0, 200) };
  return { ok: true, out: c.so.split('\n')[0] };
});
ipcMain.handle('git-pr', (_e, id) => {
  const rec = sessions.get(id);
  if (!rec) return { error: 'no session' };
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'create', '--fill', '--web'], { cwd: rec.cwd, timeout: 30000 },
      (err, _so, se) => resolve(err ? { error: ('gh: ' + (se || err.message)).slice(0, 200) } : { ok: true }));
  });
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

ipcMain.handle('reveal-file', (_e, p) => {
  if (typeof p === 'string' && p.startsWith('/') && fs.existsSync(p)) shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('clipboard-write', (_e, t) => {
  const { clipboard } = require('electron');
  clipboard.writeText(String(t || ''));
  return { ok: true };
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
