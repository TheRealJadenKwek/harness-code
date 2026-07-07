'use strict';
const H = window.harness;
const $ = (id) => document.getElementById(id);
const log = $('log');

let cfg = { model: 'z-ai/glm-4.6', mode: 'build', cwd: '' };
let streaming = false;
let curAssistant = null;   // {el, thinkEl, textEl} for the in-flight assistant message
let allModels = [];

function esc(s) { return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
function scroll() { requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); }
function shortDir(p) { const h = p.replace(/\/Users\/[^/]+/, '~'); const parts = h.split('/'); return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : h; }

// ---- context chips
async function refreshConfig() {
  const c = await H.getConfig();
  cfg = c;
  $('dirLabel').textContent = shortDir(c.cwd || '~');
  $('modelLabel').textContent = c.model;
  const mb = $('modeBtn');
  mb.textContent = c.mode === 'plan' ? '📋 Plan' : '🔨 Build';
  mb.classList.toggle('build', c.mode === 'build');
}

$('dirBtn').onclick = async () => { const d = await H.pickDir(); if (d) refreshConfig(); };
$('modeBtn').onclick = async () => { const next = cfg.mode === 'build' ? 'plan' : 'build'; await H.setConfig({ mode: next }); refreshConfig(); };
$('newBtn').onclick = async () => { await H.newSession(); log.innerHTML = ''; addLine('done', 'New session.'); };

// ---- rendering
function addUser(text) { const el = document.createElement('div'); el.className = 'msg user'; el.textContent = text; log.appendChild(el); scroll(); }
function addLine(cls, text) { const el = document.createElement('div'); el.className = cls; el.textContent = text; log.appendChild(el); scroll(); return el; }

function ensureAssistant() {
  if (curAssistant) return curAssistant;
  const el = document.createElement('div'); el.className = 'msg assistant';
  const thinkEl = document.createElement('div'); thinkEl.className = 'think'; thinkEl.style.display = 'none';
  const textEl = document.createElement('div');
  el.appendChild(thinkEl); el.appendChild(textEl); log.appendChild(el);
  curAssistant = { el, thinkEl, textEl };
  return curAssistant;
}

function toolEl(name, args) {
  const el = document.createElement('div'); el.className = 'tool';
  el.innerHTML = `<span class="name">▸ ${esc(name)}</span> <span class="args">${esc(JSON.stringify(args)).slice(0, 300)}</span>`;
  log.appendChild(el); scroll(); return el;
}

function renderDiff(file, before, after) {
  const el = document.createElement('div'); el.className = 'diff';
  const b = before.split('\n'), a = after.split('\n');
  // minimal line diff: common prefix/suffix, mark the middle
  let p = 0; while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let sb = b.length, sa = a.length;
  while (sb > p && sa > p && b[sb - 1] === a[sa - 1]) { sb--; sa--; }
  let html = '';
  for (let i = Math.max(0, p - 2); i < p; i++) if (b[i] !== undefined) html += '  ' + esc(b[i]) + '\n';
  for (let i = p; i < sb; i++) html += `<span class="del">- ${esc(b[i])}</span>\n`;
  for (let i = p; i < sa; i++) html += `<span class="add">+ ${esc(a[i])}</span>\n`;
  el.innerHTML = `<div class="dfile">± ${esc(file)}</div><pre>${html || '  (no line changes)'}</pre>`;
  log.appendChild(el); scroll();
}

// ---- agent events
H.onEvent((e) => {
  const stick = atBottom();
  if (e.type === 'turn_start') { /* keep current assistant block across tool rounds */ }
  else if (e.type === 'reasoning') { const a = ensureAssistant(); a.thinkEl.style.display = 'block'; a.thinkEl.textContent += e.delta; }
  else if (e.type === 'text') { const a = ensureAssistant(); a.textEl.textContent += e.delta; }
  else if (e.type === 'tool_call') { curAssistant = null; toolEl(e.name, e.args); }
  else if (e.type === 'tool_result') {
    const last = log.querySelector('.tool:last-child');
    if (last) { const r = document.createElement('div'); const err = e.result && e.result.error; r.className = 'res' + (err ? ' err' : ''); r.textContent = err ? ('✗ ' + err) : ('✓ ' + summarizeResult(e.name, e.result)); last.appendChild(r); }
  }
  else if (e.type === 'diff') { renderDiff(e.file, e.before, e.after); }
  else if (e.type === 'done') { finishTurn(); if (e.usage) addLine('done', `done · ~${(e.usage.prompt_tokens + e.usage.completion_tokens).toLocaleString()} tokens`); }
  else if (e.type === 'error') { finishTurn(); addLine('err', '⚠︎ ' + e.message); }
  else if (e.type === 'aborted') { finishTurn(); addLine('done', 'stopped.'); }
  if (stick) scroll();
});

function summarizeResult(name, r) {
  if (!r) return '';
  if (name === 'read_file') return `${r.bytes} bytes`;
  if (name === 'bash') return `exit ${r.exit_code}` + (r.stdout ? '\n' + r.stdout.trim().slice(0, 400) : '');
  if (name === 'grep' || name === 'glob') return `${(r.matches || []).length} matches`;
  if (name === 'list_dir') return `${(r.entries || []).length} entries`;
  if (name === 'write_file') return `${r.written} bytes written`;
  if (name === 'edit_file') return 'edited';
  return Object.keys(r).join(', ');
}

// ---- approvals
let pendingApprovalId = null;
H.onApproval((a) => {
  pendingApprovalId = a.id;
  $('apKind').textContent = a.kind;
  $('apDetail').textContent = a.detail;
  $('approvalModal').style.display = 'flex';
});
function respond(ok) { $('approvalModal').style.display = 'none'; if (pendingApprovalId != null) H.respondApproval(pendingApprovalId, ok); pendingApprovalId = null; }
$('apAllow').onclick = () => respond(true);
$('apDeny').onclick = () => respond(false);
// Keyboard approval: Enter/⌘Enter = Allow, Esc = Deny — approve without reaching for the mouse.
document.addEventListener('keydown', (e) => {
  if ($('approvalModal').style.display !== 'flex') return;
  if (e.key === 'Enter') { e.preventDefault(); respond(true); }
  else if (e.key === 'Escape') { e.preventDefault(); respond(false); }
}, true);

// ---- send / stop
function finishTurn() { streaming = false; curAssistant = null; $('sendBtn').style.display = ''; $('stopBtn').style.display = 'none'; }
async function send() {
  const text = $('input').value.trim();
  if (!text || streaming) return;
  $('input').value = ''; $('input').style.height = 'auto';
  addUser(text);
  streaming = true; curAssistant = null;
  $('sendBtn').style.display = 'none'; $('stopBtn').style.display = '';
  await H.send(text);
  finishTurn();
}
$('sendBtn').onclick = send;
$('stopBtn').onclick = () => H.abort();
$('input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } });
$('input').addEventListener('input', () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(160, i.scrollHeight) + 'px'; });

// ---- model search sheet
$('modelBtn').onclick = async () => {
  $('modelSheet').style.display = 'flex'; $('modelSearch').value = ''; $('modelSearch').focus();
  if (!allModels.length) { $('modelCount').textContent = 'Loading…'; allModels = await H.listModels(); }
  renderModels('');
};
$('modelClose').onclick = () => { $('modelSheet').style.display = 'none'; };
$('modelSearch').addEventListener('input', (e) => renderModels(e.target.value));
$('modelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) chooseModel(q); }
});
function renderModels(q) {
  const s = q.trim().toLowerCase();
  const list = s ? allModels.filter((m) => m.value.toLowerCase().includes(s) || m.label.toLowerCase().includes(s)) : allModels;
  $('modelCount').textContent = `${list.length} of ${allModels.length} models` + (s && !allModels.some((m) => m.value === q.trim()) ? ` · Enter to use “${q.trim()}”` : '');
  const box = $('modelList'); box.innerHTML = '';
  for (const m of list.slice(0, 400)) {
    const row = document.createElement('div'); row.className = 'model-row' + (m.value === cfg.model ? ' sel' : '');
    row.innerHTML = `<div>${esc(m.label)}</div><div class="mv">${esc(m.value)}</div>`;
    row.onclick = () => chooseModel(m.value);
    box.appendChild(row);
  }
}
async function chooseModel(v) { await H.setConfig({ model: v }); $('modelSheet').style.display = 'none'; refreshConfig(); }

// ---- settings
$('settingsBtn').onclick = () => { $('settingsSheet').style.display = 'flex'; $('keyInput').value = ''; };
$('settingsClose').onclick = () => { $('settingsSheet').style.display = 'none'; };
$('keySave').onclick = async () => { const k = $('keyInput').value.trim(); if (k) { await H.setConfig({ apiKey: k }); allModels = []; } $('settingsSheet').style.display = 'none'; refreshConfig(); };

refreshConfig();
