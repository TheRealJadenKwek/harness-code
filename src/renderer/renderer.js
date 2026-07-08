'use strict';
const H = window.harness;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const S = {
  recs: new Map(),      // id -> { meta, logEl, loaded, cur, queued: [], approvals: [], files: null, streaming: false }
  order: [],            // session ids, most recent first (sidebar order)
  active: null,         // active session id
  models: [],
  skills: [],
  showingApproval: null,
  panel: null,           // null | 'changes' | 'files' | 'tasks' | 'preview'
  selGitFile: null,
  tasks: new Map(),      // taskId -> meta
  selTask: null,
  selFile: null,
};
const active = () => S.recs.get(S.active);

// ---------------------------------------------------------------- utils
function esc(s) { return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function shortDir(p) { const h = (p || '').replace(/\/Users\/[^/]+/, '~'); const parts = h.split('/'); return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : h; }
function shortModel(m) { return (m || '').split('/').pop(); }
function timeAgo(t) {
  const d = Date.now() - t;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  return Math.floor(d / 86400e3) + 'd';
}
function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// Minimal safe markdown: escape first, then transform. Fenced code is lifted out
// before inline rules run and restored after.
function md(src) {
  let s = esc(src || '');
  const blocks = [];
  s = s.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push('<pre class="code"><code>' + code.replace(/\n$/, '') + '</code></pre>');
    return '\uE000' + (blocks.length - 1) + '\uE001';
  });
  s = s.replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>');
  s = s.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.*)$/gm, '<h4>$1</h4>');
  s = s.replace(/^## (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^# (.*)$/gm, '<h2>$1</h2>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" class="ext">$1</a>');
  s = s.replace(/^(\s*)[-*] /gm, '$1• ');
  s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => blocks[+i]);
  s = s.replace(/<\/(h2|h3|h4|pre)>\n/g, '</$1>');
  return s;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.ext');
  if (a) { e.preventDefault(); H.openExternal(a.href); }
});

// ---------------------------------------------------------------- chat rendering
function logOf(rec) { return rec.logEl; }
function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }
function scrollLog(rec) { const el = logOf(rec); requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); }

function addUser(rec, text, imageCount) {
  const el = document.createElement('div'); el.className = 'msg user';
  el.textContent = (imageCount ? '🖼 ' + imageCount + ' image' + (imageCount > 1 ? 's' : '') + '\n' : '') + text;
  logOf(rec).appendChild(el); scrollLog(rec);
}
function addLine(rec, cls, text) {
  const el = document.createElement('div'); el.className = cls; el.textContent = text;
  logOf(rec).appendChild(el); scrollLog(rec); return el;
}

function ensureAssistant(rec) {
  if (rec.cur) return rec.cur;
  const el = document.createElement('div'); el.className = 'msg assistant';
  const think = document.createElement('div'); think.className = 'think'; think.style.display = 'none';
  const thinkHead = document.createElement('div'); thinkHead.className = 'think-head'; thinkHead.textContent = '✳ thinking…';
  const thinkBody = document.createElement('div'); thinkBody.className = 'think-body';
  think.appendChild(thinkHead); think.appendChild(thinkBody);
  thinkHead.onclick = () => think.classList.toggle('closed');
  const textEl = document.createElement('div'); textEl.className = 'md';
  el.appendChild(think); el.appendChild(textEl);
  logOf(rec).appendChild(el);
  rec.cur = { el, think, thinkHead, thinkBody, textEl, raw: '', thinkRaw: '', mdTimer: null };
  return rec.cur;
}
function renderCurMd(rec) {
  const c = rec.cur; if (!c) return;
  if (c.mdTimer) return;
  c.mdTimer = setTimeout(() => { c.mdTimer = null; if (rec.cur === c) c.textEl.innerHTML = md(c.raw); }, 120);
}
function finalizeAssistant(rec) {
  const c = rec.cur; if (!c) return;
  if (c.mdTimer) { clearTimeout(c.mdTimer); c.mdTimer = null; }
  c.textEl.innerHTML = md(c.raw);
  c.think.classList.add('closed');
  c.thinkHead.textContent = '✳ thought for a bit';
  rec.cur = null;
}

const TOOL_ARG_SUMMARY = {
  read_file: (a) => a.path, list_dir: (a) => a.path || '.', glob: (a) => a.query,
  grep: (a) => a.pattern, write_file: (a) => a.path, edit_file: (a) => a.path,
  bash: (a) => a.command,
};
function summarizeResult(name, r) {
  if (!r) return '';
  if (r.error) return r.error;
  if (name === 'read_file') return r.bytes + ' bytes';
  if (name === 'bash') return 'exit ' + r.exit_code + (r.stdout ? '\n' + r.stdout.trim().slice(0, 1200) : '') + (r.stderr ? '\n' + r.stderr.trim().slice(0, 400) : '');
  if (name === 'grep' || name === 'glob') return (r.matches || []).length + ' matches' + ((r.matches || []).length ? '\n' + r.matches.slice(0, 20).join('\n') : '');
  if (name === 'list_dir') return (r.entries || []).length + ' entries';
  if (name === 'write_file') return r.written + ' bytes written';
  if (name === 'edit_file') return 'edited';
  return Object.keys(r).join(', ');
}
function addTool(rec, name, args, result) {
  const el = document.createElement('div'); el.className = 'tool';
  const head = document.createElement('div'); head.className = 'tool-head';
  const summ = (TOOL_ARG_SUMMARY[name] ? TOOL_ARG_SUMMARY[name](args || {}) : JSON.stringify(args)) || '';
  head.innerHTML = '<span class="name">▸ ' + esc(name) + '</span><span class="summ">' + esc(String(summ).slice(0, 200)) + '</span><span class="st run">●</span>';
  const body = document.createElement('div'); body.className = 'tool-body';
  body.innerHTML = '<div class="tb-label">args</div><pre>' + esc(JSON.stringify(args, null, 2)) + '</pre><div class="tb-res-slot"></div>';
  head.onclick = () => el.classList.toggle('open');
  el.appendChild(head); el.appendChild(body);
  logOf(rec).appendChild(el); scrollLog(rec);
  rec.lastTool = el;
  if (result !== undefined) setToolResult(el, name, result);
  return el;
}
function setToolResult(el, name, result) {
  const st = el.querySelector('.st');
  const err = result && result.error;
  st.className = 'st ' + (err ? 'bad' : 'ok');
  st.textContent = err ? '✗' : '✓';
  const slot = el.querySelector('.tb-res-slot');
  slot.innerHTML = '<div class="tb-label">result</div><pre class="tb-res' + (err ? ' err' : '') + '">' + esc(summarizeResult(name, result).slice(0, 4000)) + '</pre>';
}

function addDiff(rec, file, before, after) {
  const el = document.createElement('div'); el.className = 'diff';
  const b = (before || '').split('\n'), a = (after || '').split('\n');
  let p = 0; while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let sb = b.length, sa = a.length;
  while (sb > p && sa > p && b[sb - 1] === a[sa - 1]) { sb--; sa--; }
  let html = '', lines = 0;
  for (let i = Math.max(0, p - 2); i < p; i++) if (b[i] !== undefined) { html += '  ' + esc(b[i]) + '\n'; lines++; }
  for (let i = p; i < sb; i++) { html += '<span class="del">- ' + esc(b[i]) + '</span>\n'; lines++; }
  for (let i = p; i < sa; i++) { html += '<span class="add">+ ' + esc(a[i]) + '</span>\n'; lines++; }
  const adds = sa - p, dels = sb - p;
  const pre = document.createElement('pre');
  pre.innerHTML = html || '  (no line changes)';
  el.innerHTML = '<div class="dfile">± ' + esc(file) + '<span class="dstats">+' + adds + ' −' + dels + '</span></div>';
  el.appendChild(pre);
  if (lines > 24) {
    pre.classList.add('clamped');
    const more = document.createElement('button'); more.className = 'd-more'; more.textContent = '⌄ show all ' + lines + ' lines';
    more.onclick = () => { pre.classList.remove('clamped'); more.remove(); };
    el.appendChild(more);
  }
  logOf(rec).appendChild(el); scrollLog(rec);
}

// Live plan card: one per session, updated in place as the model checks items off.
function renderPlan(rec, items) {
  if (!rec.planEl || !rec.planEl.isConnected) {
    rec.planEl = document.createElement('div');
    rec.planEl.className = 'plan';
    logOf(rec).appendChild(rec.planEl);
  }
  rec.planEl.innerHTML = '<div class="plan-title">☰ Plan</div>' +
    items.map((i) => '<div class="plan-item' + (i.done ? ' done' : '') + '">' + (i.done ? '☑' : '☐') + ' ' + esc(i.text) + '</div>').join('');
  scrollLog(rec);
}

// Checkpoint line: click to restore every file this turn touched.
function addCkptLine(rec, ckptId, files) {
  const el = document.createElement('div');
  el.className = 'done ckpt';
  el.textContent = '⤺ revert this turn’s file changes (' + files + ' file' + (files > 1 ? 's' : '') + ')';
  el.title = 'Restores files changed by write/edit this turn. Bash side effects are not reverted.';
  el.onclick = async () => {
    if (!confirm('Revert ' + files + ' file change(s) from this turn?')) return;
    const r = await H.sessionRevert(rec.meta.id, ckptId);
    if (r && r.error) addLine(rec, 'err', '⚠︎ ' + r.error);
    if (S.panel === 'changes') refreshGit();
  };
  logOf(rec).appendChild(el);
  scrollLog(rec);
}

function renderItem(rec, item) {
  if (item.t === 'user') addUser(rec, (item.remote ? '📱 ' : '') + (item.steered ? '↳ ' : '') + item.text, item.images);
  else if (item.t === 'plan') { renderPlan(rec, item.items); rec.planEl = null; }
  else if (item.t === 'ckpt') addCkptLine(rec, item.id, item.files);
  else if (item.t === 'assistant') {
    const c = ensureAssistant(rec);
    if (item.think) { c.think.style.display = 'block'; c.thinkBody.textContent = item.think; }
    c.raw = item.text || '';
    finalizeAssistant(rec);
  }
  else if (item.t === 'tool') addTool(rec, item.name, item.args, item.result === undefined ? { error: '(interrupted)' } : item.result);
  else if (item.t === 'diff') addDiff(rec, item.file, item.before, item.after);
  else if (item.t === 'note') addLine(rec, 'done', item.text);
  else if (item.t === 'err') addLine(rec, 'err', '⚠︎ ' + item.text);
}

// ---------------------------------------------------------------- sessions / sidebar
async function refreshSessions() {
  const metas = await H.sessionsList();
  S.order = metas.map((m) => m.id);
  for (const m of metas) {
    let rec = S.recs.get(m.id);
    if (!rec) rec = makeLocalRec(m);
    else rec.meta = m;
  }
  for (const id of [...S.recs.keys()]) {
    if (!S.order.includes(id)) { const r = S.recs.get(id); r.logEl.remove(); S.recs.delete(id); }
  }
  renderSidebar();
  updateTitlebar();
}

function makeLocalRec(meta) {
  const logEl = document.createElement('div'); logEl.className = 'log';
  $('logs').appendChild(logEl);
  const rec = { meta, logEl, loaded: false, cur: null, queued: [], approvals: [], files: null, streaming: !!meta.streaming, lastTool: null };
  S.recs.set(meta.id, rec);
  return rec;
}

async function deleteSession(id, title) {
  if (!confirm('Delete "' + (title || 'this chat') + '"?')) return;
  await H.sessionDelete(id);
  if (S.active === id) S.active = null;
  await refreshSessions();
  if (!S.active) {
    const next = S.order.find((sid) => S.recs.get(sid) && !S.recs.get(sid).meta.archived);
    if (next) activate(next);
    else { const nm = await H.sessionCreate({}); await refreshSessions(); activate(nm.id); }
  }
}

function sessEl(rec, badge) {
  const m = rec.meta;
  const el = document.createElement('div'); el.className = 'sess' + (m.id === S.active ? ' active' : '');
  const live = rec.approvals.length ? '<span class="s-live appr">⚠</span>' : (rec.streaming ? '<span class="s-live spin">●</span>' : '');
  el.innerHTML = '<div class="s-title">' + (m.unread ? '<span class="s-unread">●</span> ' : '') + (badge ? badge + ' ' : '') + esc(m.title) + '</div>' +
    '<div class="s-sub">' + esc(shortModel(m.model)) + ' · ' + timeAgo(m.updatedAt) + '</div>' +
    live + '<button class="s-x" title="Delete">✕</button>';
  el.onclick = () => activate(m.id);
  el.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, m.id); };
  el.querySelector('.s-x').onclick = (e) => { e.stopPropagation(); deleteSession(m.id, m.title); };
  return el;
}

function renderSidebar() {
  const box = $('sessionList'); box.innerHTML = '';
  const header = (t) => { const h = document.createElement('div'); h.className = 'side-sec'; h.textContent = t; box.appendChild(h); return h; };
  let metas = S.order.map((id) => S.recs.get(id)).filter(Boolean);
  if (S.searchIds) metas = metas.filter((r) => S.searchIds.includes(r.meta.id));   // cross-session search filter
  const act = metas.filter((r) => !r.meta.archived);
  const pinned = act.filter((r) => r.meta.pinned);
  const groups = {};
  const rest = [];
  for (const r of act.filter((r) => !r.meta.pinned)) {
    if (r.meta.group) (groups[r.meta.group] || (groups[r.meta.group] = [])).push(r);
    else rest.push(r);
  }
  if (pinned.length) { header('Pinned'); pinned.forEach((r) => box.appendChild(sessEl(r, '📌'))); }
  for (const g of Object.keys(groups).sort()) { header(g); groups[g].forEach((r) => box.appendChild(sessEl(r))); }
  if (rest.length && (pinned.length || Object.keys(groups).length)) header('Chats');
  rest.forEach((r) => box.appendChild(sessEl(r)));
  const arch = metas.filter((r) => r.meta.archived);
  if (arch.length) {
    const h = header('▸ Archived (' + arch.length + ')');
    h.classList.add('clickable');
    if (S.showArchived) h.textContent = '▾ Archived (' + arch.length + ')';
    h.onclick = () => { S.showArchived = !S.showArchived; renderSidebar(); };
    if (S.showArchived) arch.forEach((r) => box.appendChild(sessEl(r)));
  }
  // read-only CLI sessions (claude / codex desktop CLIs), live-tailed
  const ch = header((S.showCli ? '▾' : '▸') + ' CLI sessions');
  ch.classList.add('clickable');
  ch.onclick = async () => { S.showCli = !S.showCli; if (S.showCli) S.cliList = await H.cliSessions(); renderSidebar(); };
  if (S.showCli) {
    for (const cs of (S.cliList || [])) {
      const el = document.createElement('div');
      el.className = 'sess' + (S.cliView && S.cliView.path === cs.path ? ' active' : '');
      el.innerHTML = '<div class="s-title">' + (cs.engine === 'claude' ? '✳ ' : '⌬ ') + esc(cs.title) + '</div>' +
        '<div class="s-sub">' + esc(cs.engine) + ' cli · ' + timeAgo(cs.updated) + ' · read-only</div>';
      el.onclick = () => openCliView(cs.path);
      box.appendChild(el);
    }
    if (!(S.cliList || []).length) { const d = document.createElement('div'); d.className = 'git-empty'; d.textContent = 'No CLI sessions found.'; box.appendChild(d); }
  }
}

// ---- read-only CLI session viewer -----------------------------------------------
function closeCliView() {
  if (!S.cliView) return;
  clearInterval(S.cliView.timer);
  if (S.cliView.el) S.cliView.el.remove();
  S.cliView = null;
  for (const [rid, r] of S.recs) r.logEl.classList.toggle('active', rid === S.active);
  $('input').disabled = false;
  showSuggestion(active());
  renderSidebar();
}
async function openCliView(fp) {
  closeCliView();
  const el = document.createElement('div');
  el.className = 'log active';
  $('logs').appendChild(el);
  for (const [, r] of S.recs) r.logEl.classList.remove('active');
  S.cliView = { path: fp, el, mtime: 0, timer: null };
  $('input').disabled = true;
  $('input').placeholder = 'read-only CLI session — press Esc to return to your chats';
  const render = async () => {
    const d = await H.cliSessionGet(fp);
    if (!d || !S.cliView || S.cliView.path !== fp) return;
    if (d.updated === S.cliView.mtime) return;
    S.cliView.mtime = d.updated;
    const stick = atBottom(el);
    el.innerHTML = '';
    const ban = document.createElement('div'); ban.className = 'done';
    ban.textContent = '👁 read-only ' + d.engine + ' CLI session · ' + shortDir(d.cwd) + ' · updates live · Esc to close';
    el.appendChild(ban);
    for (const m of (d.messages || [])) {
      if (m.role === 'user') { const u = document.createElement('div'); u.className = 'msg user'; u.textContent = m.text; el.appendChild(u); }
      else { const a = document.createElement('div'); a.className = 'msg assistant'; const t = document.createElement('div'); t.className = 'md'; t.innerHTML = md(m.text); a.appendChild(t); el.appendChild(a); }
    }
    if (stick || !el.dataset.scrolled) { el.scrollTop = el.scrollHeight; el.dataset.scrolled = '1'; }
  };
  await render();
  S.cliView.timer = setInterval(render, 2000);
  renderSidebar();
}

// ---- right-click context menu on chats -------------------------------------------
let ctxEl = null;
function hideCtxMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function showCtxMenu(x, y, id, view) {
  hideCtxMenu();
  const rec = S.recs.get(id); if (!rec) return;
  const m = rec.meta;
  ctxEl = document.createElement('div');
  ctxEl.className = 'menu ctx-menu';
  ctxEl.dataset.sessId = id;
  const item = (html, fn, cls) => {
    const d = document.createElement('div'); d.className = 'menu-item' + (cls ? ' ' + cls : ''); d.innerHTML = html;
    d.onmousedown = (e) => e.stopPropagation();
    d.onclick = fn; ctxEl.appendChild(d); return d;
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'menu-sep'; ctxEl.appendChild(d); };
  const patch = async (p) => { hideCtxMenu(); const nm = await H.sessionMeta(id, p); if (nm) rec.meta = nm; renderSidebar(); };

  if (view === 'openin') {
    item('‹ Open in', (e) => { e.stopPropagation(); reopen('root'); });
    sep();
    for (const [t, label] of [['finder', 'Finder'], ['terminal', 'Terminal'], ['vscode', 'VS Code']]) {
      item(label, async () => { hideCtxMenu(); const r = await H.openIn(id, t); if (r && r.error) alert(r.error); });
    }
  } else if (view === 'group') {
    item('‹ Move to group', (e) => { e.stopPropagation(); reopen('root'); });
    sep();
    const names = [...new Set([...S.recs.values()].map((r) => r.meta.group).filter(Boolean))].sort();
    for (const g of names) item((m.group === g ? '✓ ' : '') + esc(g), () => patch({ group: g }));
    item('＋ New group…', () => {
      const g = prompt('Group name:'); if (g && g.trim()) patch({ group: g.trim().slice(0, 30) }); else hideCtxMenu();
    });
    if (m.group) { sep(); item('Remove from group', () => patch({ group: null })); }
  } else {
    item('Open in <span class="mi-hint">›</span>', (e) => { e.stopPropagation(); reopen('openin'); });
    sep();
    item((m.pinned ? 'Unpin' : 'Pin') + ' <span class="mi-hint">P</span>', () => patch({ pinned: !m.pinned }));
    item('Mark as ' + (m.unread ? 'read' : 'unread') + ' <span class="mi-hint">U</span>', () => patch({ unread: !m.unread }));
    item('Rename <span class="mi-hint">R</span>', () => {
      const t = prompt('Rename chat:', m.title); if (t && t.trim()) patch({ title: t.trim() }); else hideCtxMenu();
    });
    item('Fork <span class="mi-hint">F</span>', async () => {
      hideCtxMenu();
      const nm = await H.sessionFork(id);
      if (nm) { await refreshSessions(); activate(nm.id); }
    });
    item('Fork to worktree <span class="mi-hint">W</span>', async () => {
      hideCtxMenu();
      const nm = await H.sessionWorktree(id);
      if (nm && nm.error) { alert(nm.error); return; }
      if (nm) { await refreshSessions(); activate(nm.id); }
    });
    sep();
    item('Move to group <span class="mi-hint">›</span>', (e) => { e.stopPropagation(); reopen('group'); });
    sep();
    item((m.archived ? 'Unarchive' : 'Archive') + ' <span class="mi-hint">A</span>', async () => {
      await patch({ archived: !m.archived });
      if (!m.archived && S.active === id) {   // just archived the active chat
        const next = S.order.find((sid) => S.recs.get(sid) && !S.recs.get(sid).meta.archived);
        if (next) activate(next);
        else { const nm = await H.sessionCreate({}); await refreshSessions(); activate(nm.id); }
      }
    });
    item('Delete <span class="mi-hint">D</span>', () => { hideCtxMenu(); deleteSession(id, m.title); }, 'ctx-danger');
  }
  document.body.appendChild(ctxEl);
  const rect = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  ctxEl.style.right = 'auto';
  function reopen(v) {
    const lx = parseInt(ctxEl.style.left), ly = parseInt(ctxEl.style.top);
    showCtxMenu(lx, ly, id, v);
  }
}
document.addEventListener('mousedown', (e) => { if (ctxEl && !e.target.closest('.ctx-menu')) hideCtxMenu(); });
document.addEventListener('keydown', (e) => {
  if (!ctxEl) return;
  const id = ctxEl.dataset.sessId;
  const rec = S.recs.get(id);
  if (!rec) { hideCtxMenu(); return; }
  const m = rec.meta;
  const patch = async (p) => { hideCtxMenu(); const nm = await H.sessionMeta(id, p); if (nm) rec.meta = nm; renderSidebar(); };
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideCtxMenu(); }
  else if (k === 'p') { e.preventDefault(); patch({ pinned: !m.pinned }); }
  else if (k === 'u') { e.preventDefault(); patch({ unread: !m.unread }); }
  else if (k === 'r') { e.preventDefault(); hideCtxMenu(); const t = prompt('Rename chat:', m.title); if (t && t.trim()) H.sessionMeta(id, { title: t.trim() }).then((nm) => { if (nm) rec.meta = nm; renderSidebar(); updateTitlebar(); }); }
  else if (k === 'f') { e.preventDefault(); hideCtxMenu(); H.sessionFork(id).then(async (nm) => { if (nm) { await refreshSessions(); activate(nm.id); } }); }
  else if (k === 'w') { e.preventDefault(); hideCtxMenu(); H.sessionWorktree(id).then(async (nm) => { if (nm && nm.error) return alert(nm.error); if (nm) { await refreshSessions(); activate(nm.id); } }); }
  else if (k === 'a') { e.preventDefault(); patch({ archived: !m.archived }); }
  else if (k === 'd') { e.preventDefault(); hideCtxMenu(); deleteSession(id, m.title); }
}, true);

async function activate(id) {
  if (!S.recs.has(id)) return;
  closeCliView();
  S.active = id;
  for (const [rid, rec] of S.recs) rec.logEl.classList.toggle('active', rid === id);
  const rec = S.recs.get(id);
  if (!rec.loaded) {
    rec.loaded = true;
    const d = await H.sessionGet(id);
    if (d) { rec.meta = d.meta; for (const item of d.transcript) renderItem(rec, item); rec.cur = null; }
    rec.logEl.scrollTop = rec.logEl.scrollHeight;
  }
  renderSidebar();
  updateTitlebar();
  updateComposer();
  hidePopup();
  hideMenus();
  if (rec.meta.unread) { rec.meta.unread = false; H.sessionMeta(id, { unread: false }); }
  renderAttachRow();
  maybeShowApproval();
  if (S.panel === 'changes') refreshGit();
  else if (S.panel === 'files') refreshFiles();
  showSuggestion(rec);
  $('input').focus();
}

const MODES = [
  { key: 'plan', label: '📋 Plan mode', chip: '📋 Plan' },
  { key: 'ask', label: '🔨 Manual permissions', chip: '🔨 Ask' },
  { key: 'edits', label: '✎ Accept edits', chip: '✎ Edits' },
  { key: 'auto', label: '⚡ Auto mode', chip: '⚡ Auto' },
  { key: 'bypass', label: '⚠ Bypass permissions', chip: '⚠ Bypass' },
];
function updateTitlebar() {
  const rec = active(); if (!rec) return;
  const m = rec.meta;
  $('dirLabel').textContent = shortDir(m.cwd);
  $('modelLabel').textContent = shortModel(m.model);
  const mb = $('modeBtn');
  const md = MODES.find((x) => x.key === m.mode) || MODES[1];
  mb.textContent = md.chip;
  mb.className = 'chip mode ' + m.mode;
  // effort only exists for reasoning-capable models — hide the chip otherwise
  const mm = S.models.find((x) => x.value === m.model);
  const canReason = mm ? !!mm.reasoning : false;
  $('effortBtn').style.display = canReason ? '' : 'none';
  $('effortBtn').textContent = m.effort ? '◔ ' + m.effort[0].toUpperCase() + m.effort.slice(1) : 'Effort';
  const u = m.usage || { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  const tot = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
  $('usageLabel').textContent = tot ? fmtTokens(tot) + ' tok' + (u.cost ? ' · $' + u.cost.toFixed(u.cost < 0.1 ? 4 : 2) : '') : '';
}

function updateComposer() {
  const rec = active();
  const streaming = rec && rec.streaming;
  $('sendBtn').style.display = streaming ? 'none' : '';
  $('stopBtn').style.display = streaming ? '' : 'none';
  const q = rec ? rec.queued.length : 0;
  $('queueNote').style.display = q ? '' : 'none';
  $('queueNote').textContent = q ? q + ' message' + (q > 1 ? 's' : '') + ' queued — sends when this turn finishes' : '';
}

// ---------------------------------------------------------------- agent events
const MUTATING = ['write_file', 'edit_file', 'bash'];
let gitDebounce = null;
H.onEvent((e) => {
  const rec = S.recs.get(e.sessionId);
  if (!rec || !rec.loaded) return;
  const el = logOf(rec); const stick = atBottom(el);
  if (e.type === 'turn_start') { /* keep the current assistant block across tool rounds */ }
  else if (e.type === 'reasoning') {
    const c = ensureAssistant(rec);
    c.think.style.display = 'block'; c.thinkRaw += e.delta; c.thinkBody.textContent = c.thinkRaw;
    if (stick) c.thinkBody.scrollTop = c.thinkBody.scrollHeight;
  }
  else if (e.type === 'text') {
    const c = ensureAssistant(rec);
    if (c.thinkRaw && !c.raw) { c.think.classList.add('closed'); c.thinkHead.textContent = '✳ thought for a bit'; }
    c.raw += e.delta; renderCurMd(rec);
  }
  else if (e.type === 'tool_call') { finalizeAssistant(rec); addTool(rec, e.name, e.args); }
  else if (e.type === 'tool_result') {
    if (rec.lastTool) setToolResult(rec.lastTool, e.name, e.result);
    if (S.panel === 'changes' && e.sessionId === S.active && MUTATING.includes(e.name)) {
      clearTimeout(gitDebounce); gitDebounce = setTimeout(refreshGit, 500);
    }
  }
  else if (e.type === 'auto_approved') addLine(rec, 'done', '⚡ auto-approved ' + e.kind + ': ' + String(e.detail || '').slice(0, 80));
  else if (e.type === 'control_note') addLine(rec, 'done', e.message);
  else if (e.type === 'remote_user') { addUser(rec, '📱 ' + e.text); rec.streaming = true; updateComposer(); renderSidebar(); }
  else if (e.type === 'plan') renderPlan(rec, e.items);
  else if (e.type === 'checkpoint') addCkptLine(rec, e.ckptId, e.files);
  else if (e.type === 'snapshot') { /* main-side checkpoint bookkeeping only */ }
  else if (e.type === 'screenshot') {
    const card = document.createElement('div'); card.className = 'shot';
    const img = document.createElement('img'); img.src = e.dataUrl;
    img.onclick = () => card.classList.toggle('big');
    card.appendChild(img); logOf(rec).appendChild(card); scrollLog(rec);
  }
  else if (e.type === 'diff') addDiff(rec, e.file, e.before, e.after);
  else if (e.type === 'done') {
    finalizeAssistant(rec);
    if (e.usage) addLine(rec, 'done', 'done · ~' + ((e.usage.prompt_tokens || 0) + (e.usage.completion_tokens || 0)).toLocaleString() + ' tokens');
    endTurn(rec);
  }
  else if (e.type === 'compacted') { finalizeAssistant(rec); addLine(rec, 'done', '✦ context compacted'); endTurn(rec); }
  else if (e.type === 'error') { finalizeAssistant(rec); addLine(rec, 'err', '⚠︎ ' + e.message); endTurn(rec); }
  else if (e.type === 'aborted') { finalizeAssistant(rec); addLine(rec, 'done', 'stopped.'); endTurn(rec); }
  if (stick) scrollLog(rec);
});

function endTurn(rec) {
  rec.streaming = false;
  if (rec.meta.id === S.active) updateComposer();
  else { rec.meta.unread = true; H.sessionMeta(rec.meta.id, { unread: true }); }   // finished in the background
  renderSidebar();
  if (rec.queued.length) {
    const next = rec.queued.shift();
    setTimeout(() => sendText(rec, next.text, next.images, next.modelText), 80);
  }
}

H.onSessionsUpdated(() => refreshSessions());

// ---------------------------------------------------------------- send / stop
async function sendText(rec, text, images, modelText) {
  if (rec.streaming) {
    // steer the RUNNING turn (mid-task interjection); fall back to queueing
    const st = await H.sessionSteer(rec.meta.id, modelText || text);
    if (st && st.ok) { addUser(rec, '↳ ' + text, images ? images.length : 0); return; }
    rec.queued.push({ text, images, modelText }); updateComposer(); return;
  }
  rec.streaming = true; rec.cur = null;
  const r = await H.sessionSend(rec.meta.id, text, images && images.length ? images : undefined, modelText);
  if (r.ok) addUser(rec, text, images ? images.length : 0);
  else if (r.error === 'busy') rec.queued.push({ text, images, modelText });
  else rec.streaming = false;
  updateComposer(); renderSidebar();
}
async function onSend() {
  const rec = active(); if (!rec) return;
  const text = $('input').value.trim();
  const images = (rec.attachments || []).map((a) => a.dataUrl).filter(Boolean);
  if (!text && !images.length) return;
  $('input').value = ''; $('input').style.height = 'auto'; hidePopup();
  rec.suggestion = null; showSuggestion(rec);
  if (text.startsWith('/') && runSlash(rec, text)) return;
  rec.attachments = []; renderAttachRow();
  sendText(rec, text || 'See the attached image(s).', images);
}
$('sendBtn').onclick = onSend;
$('stopBtn').onclick = () => { const rec = active(); if (rec) H.sessionAbort(rec.meta.id); };

// ---------------------------------------------------------------- slash commands
const SLASH = [
  { cmd: '/new', desc: 'New chat' },
  { cmd: '/clear', desc: 'Clear this conversation' },
  { cmd: '/compact', desc: 'Summarize & compress the context' },
  { cmd: '/model', desc: 'Choose a model' },
  { cmd: '/mode ask', desc: 'Approve every change' },
  { cmd: '/mode auto', desc: 'Auto-approve routine work (destructive still asks)' },
  { cmd: '/mode plan', desc: 'Read-only planning' },
  { cmd: '/dir', desc: 'Change the working directory' },
  { cmd: '/diff', desc: 'Toggle the changes panel' },
  { cmd: '/rename <title>', desc: 'Rename this chat' },
  { cmd: '/fork', desc: 'Duplicate this chat into a new session' },
  { cmd: '/goal <text>', desc: 'Set a standing goal (empty = clear)' },
  { cmd: '/loop <min> <prompt>', desc: 'Re-send a prompt on an interval · /loop stop' },
  { cmd: '/help', desc: 'Show available commands' },
];
function runSlash(rec, text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === '/new') { newChat(); return true; }
  if (cmd === '/clear') { H.sessionClear(rec.meta.id).then(() => { rec.logEl.innerHTML = ''; rec.cur = null; addLine(rec, 'done', 'conversation cleared.'); }); return true; }
  if (cmd === '/compact') {
    rec.streaming = true; updateComposer(); addLine(rec, 'done', '✦ compacting context…');
    H.sessionCompact(rec.meta.id).then((r) => { if (!r.ok && r.error) { addLine(rec, 'err', '⚠︎ ' + r.error); endTurn(rec); } });
    return true;
  }
  if (cmd === '/model') { openModelSheet(); return true; }
  if (cmd === '/mode') {
    if (['ask', 'auto', 'plan'].includes(arg)) setSessionConfig({ mode: arg });
    else addLine(rec, 'err', 'usage: /mode ask|auto|plan');
    return true;
  }
  if (cmd === '/dir') { pickDir(); return true; }
  if (cmd === '/diff') { toggleDiff(); return true; }
  if (cmd === '/rename') { if (arg) H.sessionRename(rec.meta.id, arg); return true; }
  if (cmd === '/fork') {
    H.sessionFork(rec.meta.id).then(async (m) => { if (m) { await refreshSessions(); activate(m.id); } });
    return true;
  }
  if (cmd === '/goal') {
    H.sessionGoal(rec.meta.id, arg || null);
    rec.meta.goal = arg || null;
    addLine(rec, 'done', arg ? '◎ standing goal set: ' + arg : '◎ standing goal cleared');
    return true;
  }
  if (cmd === '/loop') {
    if (arg === 'stop' || !arg) {
      if (rec.loopTimer) { clearInterval(rec.loopTimer); rec.loopTimer = null; addLine(rec, 'done', '↻ loop stopped'); }
      else addLine(rec, 'err', 'usage: /loop <minutes> <prompt> · /loop stop');
      return true;
    }
    const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) { addLine(rec, 'err', 'usage: /loop <minutes> <prompt>'); return true; }
    const mins = Math.max(1, +m[1]), prompt = m[2];
    if (rec.loopTimer) clearInterval(rec.loopTimer);
    rec.loopTimer = setInterval(() => { if (!rec.streaming) sendText(rec, prompt); }, mins * 60000);
    addLine(rec, 'done', '↻ looping every ' + mins + 'm: "' + prompt.slice(0, 60) + '" — /loop stop to end');
    sendText(rec, prompt);
    return true;
  }
  if (cmd === '/help') {
    addLine(rec, 'done', SLASH.map((s) => s.cmd + ' — ' + s.desc).join('\n') +
      (S.skills.length ? '\n\nskills: ' + S.skills.map((s) => '/' + s.name).join(' ') : ''));
    return true;
  }
  // skills: /name [task] expands the skill content for the model
  const skill = S.skills.find((s) => cmd === '/' + s.name);
  if (skill) {
    sendText(rec, text, null,
      'Follow this skill/playbook:\n\n' + skill.content + '\n\n---\nTask: ' + (arg || 'apply the skill to the current context'));
    return true;
  }
  return false;   // not a command → send as a normal message
}

// ---------------------------------------------------------------- popup (@files + /commands)
const pop = { mode: null, items: [], sel: 0, mStart: 0, mLen: 0 };
function hidePopup() { pop.mode = null; $('popup').style.display = 'none'; }
function renderPopup() {
  const box = $('popup');
  if (!pop.items.length) { hidePopup(); return; }
  box.innerHTML = '';
  pop.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'pop-row' + (i === pop.sel ? ' sel' : '');
    row.innerHTML = '<span class="p-main">' + esc(it.main) + '</span>' + (it.hint ? '<span class="p-hint">' + esc(it.hint) + '</span>' : '');
    row.onmousedown = (e) => { e.preventDefault(); choosePopup(i); };
    box.appendChild(row);
  });
  box.style.display = '';
  box.querySelector('.pop-row.sel') && box.querySelector('.pop-row.sel').scrollIntoView({ block: 'nearest' });
}
async function updatePopup() {
  const i = $('input');
  const posn = i.selectionStart;
  const before = i.value.slice(0, posn);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  if (m) {
    const rec = active(); if (!rec) return hidePopup();
    if (!rec.files) rec.files = await H.listFiles(rec.meta.id);
    const q = m[2].toLowerCase();
    const list = (q ? rec.files.filter((f) => f.toLowerCase().includes(q)) : rec.files).slice(0, 12);
    pop.mode = 'mention'; pop.sel = 0;
    pop.mStart = posn - m[2].length - 1; pop.mLen = m[2].length + 1;
    pop.items = list.map((f) => ({ main: f, insert: '@' + f + ' ' }));
    renderPopup();
    return;
  }
  if (i.value.startsWith('/') && !i.value.includes('\n')) {
    const q = i.value.toLowerCase();
    const all = [...SLASH, ...S.skills.map((s) => ({ cmd: '/' + s.name, desc: 'skill — ' + (s.description || '') }))];
    const list = all.filter((s) => s.cmd.startsWith(q) || q === '/');
    pop.mode = 'slash'; pop.sel = 0;
    pop.items = list.map((s) => ({ main: s.cmd, hint: s.desc, insert: s.cmd.replace(/ <.*$/, ' ') }));
    renderPopup();
    return;
  }
  hidePopup();
}
function choosePopup(idx) {
  const it = pop.items[idx]; if (!it) return;
  const i = $('input');
  if (pop.mode === 'mention') {
    i.value = i.value.slice(0, pop.mStart) + it.insert + i.value.slice(pop.mStart + pop.mLen);
    const at = pop.mStart + it.insert.length;
    i.setSelectionRange(at, at);
  } else {
    i.value = it.insert.endsWith(' ') ? it.insert : it.insert;
    i.setSelectionRange(i.value.length, i.value.length);
    if (!it.insert.endsWith(' ')) { hidePopup(); i.focus(); onSend(); return; }
  }
  hidePopup(); i.focus();
}

// ---------------------------------------------------------------- cross-session search
let searchTimer = null;
$('sessSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('sessSearch').value.trim();
    S.searchIds = q ? await H.sessionsSearch(q) : null;
    renderSidebar();
  }, 200);
});
$('sessSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('sessSearch').value = ''; S.searchIds = null; renderSidebar(); $('input').focus(); }
  if (e.key === 'Enter' && S.searchIds && S.searchIds.length) { activate(S.searchIds[0]); }
});

// ---------------------------------------------------------------- voice input (local whisper)
let recState = null;   // { recorder, chunks }
$('micBtn').onclick = async () => {
  if (recState) {   // stop → transcribe
    recState.recorder.stop();
    return;
  }
  const perm = await H.micPermission();
  if (perm && perm.granted === false) { alert('Microphone access denied — grant it in System Settings → Privacy.'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { alert('Microphone unavailable: ' + e.message); return; }
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recState = null;
    $('micBtn').textContent = '…';
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let b64 = '';
    for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const r = await H.transcribe(btoa(b64));
    $('micBtn').textContent = '🎙';
    $('micBtn').classList.remove('rec');
    if (r.error) { const rec = active(); if (rec) addLine(rec, 'err', '⚠︎ ' + r.error); return; }
    if (r.text) {
      input.value = (input.value ? input.value + ' ' : '') + r.text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  };
  recorder.start();
  recState = { recorder, chunks };
  $('micBtn').textContent = '⏺';
  $('micBtn').classList.add('rec');
};

// ---------------------------------------------------------------- self-update
$('updateBtn').onclick = async () => {
  $('updateStatus').textContent = 'checking…';
  const r = await H.selfUpdate();
  if (r.error) { $('updateStatus').textContent = '⚠︎ ' + r.error; return; }
  if (/Already up to date/i.test(r.out || '')) { $('updateStatus').textContent = '✓ up to date'; return; }
  $('updateStatus').textContent = '✓ updated (' + (r.out || '') + ')';
  if (confirm('Update installed. Relaunch now?')) H.appRelaunch();
};

// ---------------------------------------------------------------- ghost-text suggestions (Tab to accept)
const input = $('input');
const DEFAULT_PLACEHOLDER = input.placeholder;
function showSuggestion(rec) {
  input.placeholder = (rec && rec.suggestion && !input.value)
    ? rec.suggestion + '   ⇥ tab'
    : DEFAULT_PLACEHOLDER;
}
H.onSuggest(({ sessionId, text }) => {
  const rec = S.recs.get(sessionId);
  if (!rec) return;
  rec.suggestion = text;
  if (sessionId === S.active) showSuggestion(rec);
});

// ---------------------------------------------------------------- composer keys
// paste an image straight from the clipboard (⌘V) → attaches like the + menu does
input.addEventListener('paste', (e) => {
  const rec = active(); if (!rec) return;
  for (const item of e.clipboardData.items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const f = item.getAsFile();
      const fr = new FileReader();
      fr.onload = () => {
        rec.attachments = rec.attachments || [];
        rec.attachments.push({ name: 'pasted image', dataUrl: fr.result });
        renderAttachRow();
      };
      fr.readAsDataURL(f);
    }
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight) + 'px';
  updatePopup();
});
input.addEventListener('keydown', (ev) => {
  if (pop.mode) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); pop.sel = Math.min(pop.sel + 1, pop.items.length - 1); renderPopup(); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); pop.sel = Math.max(pop.sel - 1, 0); renderPopup(); return; }
    if (ev.key === 'Tab' || ev.key === 'Enter') { ev.preventDefault(); choosePopup(pop.sel); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); hidePopup(); return; }
  }
  // Tab accepts the ghost-text suggestion when the composer is empty
  if (ev.key === 'Tab' && !ev.shiftKey && !pop.mode) {
    const rec = active();
    if (rec && rec.suggestion && !input.value) {
      ev.preventDefault();
      input.value = rec.suggestion;
      rec.suggestion = null;
      showSuggestion(rec);
      input.dispatchEvent(new Event('input'));
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); onSend(); return; }
  if (ev.key === 'Escape') {
    const rec = active();
    if (rec && rec.streaming) { ev.preventDefault(); H.sessionAbort(rec.meta.id); }
  }
  if (ev.key === 'Tab' && ev.shiftKey) { ev.preventDefault(); cycleMode(); }
});

// ---------------------------------------------------------------- titlebar actions
async function setSessionConfig(patch) {
  const rec = active(); if (!rec) return;
  const m = await H.sessionConfig(rec.meta.id, patch);
  if (m) rec.meta = m;
  updateTitlebar(); renderSidebar();
}
const MODE_CYCLE = { plan: 'ask', ask: 'edits', edits: 'auto', auto: 'bypass', bypass: 'plan' };
function cycleMode() { const rec = active(); if (rec) setSessionConfig({ mode: MODE_CYCLE[rec.meta.mode] || 'ask' }); }
async function pickDir() {
  const rec = active(); if (!rec) return;
  const d = await H.pickDir(rec.meta.id);
  if (d) {
    rec.meta.cwd = d; rec.files = null; updateTitlebar();
    if (S.panel === 'changes') refreshGit();
    else if (S.panel === 'files') refreshFiles();
  }
}
$('dirBtn').onclick = pickDir;

// ---- mode menu (click the pill; 1–5 select; ⇧Tab still cycles)
$('modeBtn').onclick = () => {
  const open = $('modeMenu').style.display !== 'none';
  hideMenus();
  if (open) return;
  const rec = active(); if (!rec) return;
  for (const it of document.querySelectorAll('#modeMenu .menu-item'))
    it.classList.toggle('on', it.dataset.mode === rec.meta.mode);
  $('modeMenu').style.display = '';
};
$('modeMenu').addEventListener('click', (e) => {
  const it = e.target.closest('.menu-item'); if (!it) return;
  hideMenus();
  setSessionConfig({ mode: it.dataset.mode });
});

// ---- effort menu (OpenRouter unified reasoning effort — faster ↔ smarter)
$('effortBtn').onclick = () => {
  const open = $('effortMenu').style.display !== 'none';
  hideMenus();
  if (open) return;
  const rec = active(); if (!rec) return;
  for (const it of document.querySelectorAll('#effortMenu .menu-item'))
    it.classList.toggle('on', (it.dataset.effort || '') === (rec.meta.effort || ''));
  $('effortMenu').style.display = '';
};
$('effortMenu').addEventListener('click', (e) => {
  const it = e.target.closest('.menu-item'); if (!it) return;
  hideMenus();
  setSessionConfig({ effort: it.dataset.effort || null });
});

// ---- + menu: attach files/photos, add folder, slash commands
function renderAttachRow() {
  const rec = active();
  const row = $('attachRow');
  const atts = rec ? (rec.attachments || []) : [];
  row.style.display = atts.length ? '' : 'none';
  row.innerHTML = '';
  atts.forEach((a, i) => {
    const chip = document.createElement('div'); chip.className = 'att-chip';
    chip.innerHTML = (a.dataUrl ? '<img src="' + a.dataUrl + '">' : '📄') + '<span>' + esc(a.name) + '</span><button title="Remove">✕</button>';
    chip.querySelector('button').onclick = () => { rec.attachments.splice(i, 1); renderAttachRow(); };
    row.appendChild(chip);
  });
}
async function attachFiles() {
  const rec = active(); if (!rec) return;
  const picked = await H.pickFiles(rec.meta.id);
  rec.attachments = rec.attachments || [];
  for (const f of picked) {
    if (f.kind === 'image') rec.attachments.push({ name: f.name, dataUrl: f.dataUrl });
    else if (f.kind === 'path') { const i = $('input'); i.value = (i.value ? i.value.replace(/\s?$/, ' ') : '') + '@' + f.path + ' '; }
    else if (f.kind === 'error') addLine(rec, 'err', '⚠︎ ' + f.name + ': ' + f.error);
  }
  renderAttachRow();
  $('input').focus();
}
function openSettings(sec) {
  $('settingsSheet').style.display = 'flex';
  renderMcpList(); renderSkillsList(); renderPluginsList();
  const b = document.querySelector('.snav[data-sec=' + sec + ']');
  if (b) b.onclick();
}
async function renderPlusMenu(view) {
  const box = $('plusMenu'); box.innerHTML = '';
  const item = (html, fn) => {
    const d = document.createElement('div'); d.className = 'menu-item'; d.innerHTML = html;
    d.onmousedown = (e) => e.stopPropagation();
    d.onclick = fn; box.appendChild(d); return d;
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'menu-sep'; box.appendChild(d); };
  if (view === 'root') {
    item('📎 Add files or photos <span class="mi-hint">⌘U</span>', () => { hideMenus(); attachFiles(); });
    item('📁 Add folder', async () => {
      hideMenus();
      const rec = active(); if (!rec) return;
      const p = await H.pickFolderPath(rec.meta.id);
      if (p) { const i = $('input'); i.value = (i.value ? i.value.replace(/\s?$/, ' ') : '') + '@' + p + '/ '; i.focus(); }
    });
    item('▸ Slash commands', () => { hideMenus(); const i = $('input'); i.value = '/'; i.focus(); i.dispatchEvent(new Event('input')); });
    sep();
    item('🔌 Connectors <span class="mi-hint">›</span>', (e) => { e.stopPropagation(); renderPlusMenu('connectors'); });
    item('🧩 Plugins <span class="mi-hint">›</span>', (e) => { e.stopPropagation(); renderPlusMenu('plugins'); });
  } else if (view === 'connectors') {
    item('‹ Connectors', (e) => { e.stopPropagation(); renderPlusMenu('root'); });
    sep();
    const list = await H.mcpList();
    if (!list.length) item('<span class="mi-hint">No MCP servers yet</span>', () => {});
    for (const s of list) {
      const dot = s.status === 'running' ? '🟢' : s.enabled ? '🔴' : '⚪';
      item(dot + ' ' + esc(s.name) + ' <span class="mi-hint">' + (s.status === 'running' ? s.tools.length + ' tools · on' : s.enabled ? s.status : 'off') + '</span>',
        async (e) => {
          e.stopPropagation();
          if (s.source && s.source.startsWith('plugin:')) await H.pluginToggle(s.source.slice(7), !s.enabled);
          else await H.mcpToggle(s.name, !s.enabled);
          renderPlusMenu('connectors');
        });
    }
    sep();
    item('Manage connectors…', () => { hideMenus(); openSettings('mcp'); });
  } else if (view === 'plugins') {
    item('‹ Plugins', (e) => { e.stopPropagation(); renderPlusMenu('root'); });
    sep();
    const list = await H.pluginList();
    if (!list.length) item('<span class="mi-hint">No plugins installed</span>', () => {});
    for (const p of list) {
      item((p.enabled ? '🟢 ' : '⚪ ') + esc(p.name) +
        ' <span class="mi-hint">' + p.skills.length + ' skills · ' + p.mcpServers.length + ' servers</span>',
        async (e) => { e.stopPropagation(); await H.pluginToggle(p.dir, !p.enabled); await loadSkills(); renderPlusMenu('plugins'); });
    }
    sep();
    item('Manage plugins…', () => { hideMenus(); openSettings('plugins'); });
  }
}
$('plusBtn').onclick = () => {
  const open = $('plusMenu').style.display !== 'none';
  hideMenus();
  if (open) return;
  renderPlusMenu('root');
  $('plusMenu').style.display = '';
};

// ---- usage popover: context window + session cost + OpenRouter credits
$('usageLabel').onclick = async () => {
  const open = $('usageMenu').style.display !== 'none';
  hideMenus();
  if (open) return;
  const rec = active(); if (!rec) return;
  $('usageMenu').style.display = '';
  if (!S.models.length) S.models = await H.listModels(false);
  const mm = S.models.find((x) => x.value === rec.meta.model);
  const limit = mm && mm.context ? mm.context : 0;
  const used = (rec.meta.usage && rec.meta.usage.context) || 0;
  const pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
  $('ctxPct').textContent = limit ? fmtTokens(used) + ' / ' + fmtTokens(limit) + ' (' + pct + '%)' : fmtTokens(used) + ' used';
  $('ctxBar').style.width = pct + '%';
  const cost = (rec.meta.usage && rec.meta.usage.cost) || 0;
  $('umCost').textContent = '$' + cost.toFixed(cost < 0.1 ? 4 : 2);
  $('umCredits').textContent = '…';
  const cr = await H.credits();
  if (cr && cr.total != null) {
    $('umCredits').textContent = '$' + (cr.used || 0).toFixed(2) + ' used of $' + cr.total.toFixed(2);
    $('creditsBar').style.width = Math.min(100, Math.round((cr.used || 0) / cr.total * 100)) + '%';
  } else if (cr && cr.used != null) {
    $('umCredits').textContent = '$' + cr.used.toFixed(2) + ' used';
    $('creditsBar').style.width = '0%';
  } else {
    $('umCredits').textContent = 'unavailable';
  }
};
async function newChat() {
  const m = await H.sessionCreate({});
  await refreshSessions();
  activate(m.id);
}
$('newBtn').onclick = newChat;
$('sideToggle').onclick = () => {
  const sb = $('sidebar');
  sb.classList.toggle('hidden');
  document.querySelector('.titlebar').classList.toggle('no-side', sb.classList.contains('hidden'));
};

// ---------------------------------------------------------------- approvals
H.onApproval((a) => {
  const rec = S.recs.get(a.sessionId);
  if (!rec) { H.respondApproval(a.id, false); return; }
  rec.approvals.push(a);
  renderSidebar();
  maybeShowApproval();
});
function maybeShowApproval() {
  if (S.showingApproval) return;
  const rec = active(); if (!rec || !rec.approvals.length) return;
  const a = rec.approvals[0];
  S.showingApproval = a;
  $('apKind').textContent = a.kind;
  $('apSession').textContent = shortModel(rec.meta.model) + ' · ' + rec.meta.title;
  $('apDetail').textContent = a.detail;
  const inner = $('approvalModal').querySelector('.modal-inner');
  inner.classList.toggle('danger-modal', !!a.danger);
  $('apWarn').style.display = a.danger ? 'block' : 'none';
  $('approvalModal').style.display = 'flex';
}
function respondApproval(ok) {
  const a = S.showingApproval; if (!a) return;
  $('approvalModal').style.display = 'none';
  H.respondApproval(a.id, ok);
  const rec = S.recs.get(a.sessionId);
  if (rec) rec.approvals = rec.approvals.filter((x) => x.id !== a.id);
  S.showingApproval = null;
  renderSidebar();
  setTimeout(maybeShowApproval, 60);
}
$('apAllow').onclick = () => respondApproval(true);
$('apDeny').onclick = () => respondApproval(false);
$('apAlways').onclick = () => {
  const a = S.showingApproval; if (!a) return;
  $('approvalModal').style.display = 'none';
  H.respondApproval(a.id, true, true);
  const rec = S.recs.get(a.sessionId);
  if (rec) { rec.approvals = rec.approvals.filter((x) => x.id !== a.id); addLine(rec, 'done', '✓ rule saved: always allow "' + String(a.detail || '').split(/\s+/).slice(0, 2).join(' ') + '…" here'); }
  S.showingApproval = null;
  renderSidebar();
  setTimeout(maybeShowApproval, 60);
};
document.addEventListener('keydown', (e) => {
  if ($('approvalModal').style.display !== 'flex') return;
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); respondApproval(true); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); respondApproval(false); }
}, true);

// ---------------------------------------------------------------- right panel (tabs)
const TABS = ['changes', 'files', 'tasks', 'preview'];
function showPanel(tab) {
  S.panel = tab;
  $('rightPanel').style.display = '';
  for (const t of TABS) $('tab-' + t).style.display = t === tab ? '' : 'none';
  for (const b of document.querySelectorAll('.ptab')) b.classList.toggle('on', b.dataset.tab === tab);
  if (tab === 'changes') refreshGit();
  else if (tab === 'files') refreshFiles();
  else if (tab === 'tasks') renderTasks();
}
function closePanel() { S.panel = null; $('rightPanel').style.display = 'none'; }
function togglePanel(tab) { (S.panel === tab) ? closePanel() : showPanel(tab); }
for (const b of document.querySelectorAll('.ptab')) b.onclick = () => showPanel(b.dataset.tab);
$('panelClose').onclick = closePanel;
function toggleDiff() { togglePanel('changes'); }
$('diffToggle').onclick = toggleDiff;
$('gitRefresh').onclick = () => refreshGit();
$('gitCommitBtn').onclick = async () => {
  const rec = active(); if (!rec) return;
  const msg = prompt('Commit message:', 'Changes via Harness Code');
  if (msg === null) return;
  const r = await H.gitCommit(rec.meta.id, msg);
  addLine(rec, r.error ? 'err' : 'done', r.error ? '⚠︎ ' + r.error : '✓ ' + r.out);
  refreshGit();
};
$('gitPrBtn').onclick = async () => {
  const rec = active(); if (!rec) return;
  const r = await H.gitPr(rec.meta.id);
  if (r.error) addLine(rec, 'err', '⚠︎ ' + r.error);
};
async function refreshGit() {
  const rec = active(); if (!rec) return;
  const st = await H.gitStatus(rec.meta.id);
  const box = $('gitFiles');
  if (!st.repo) {
    $('gitBranch').textContent = '';
    box.innerHTML = '<div class="git-empty">Not a git repository.<br>Inline diffs still appear in the chat.</div>';
    $('gitDiffView').textContent = '';
    return;
  }
  $('gitBranch').textContent = '⎇ ' + st.branch;
  if (!st.files.length) {
    box.innerHTML = '<div class="git-empty">Working tree clean.</div>';
    $('gitDiffView').textContent = '';
    S.selGitFile = null;
    return;
  }
  box.innerHTML = '';
  for (const f of st.files) {
    const el = document.createElement('div');
    el.className = 'gf' + (f.path === S.selGitFile ? ' sel' : '');
    const stLetter = f.status === '??' ? 'U' : f.status[0];
    el.innerHTML = '<span class="g-st ' + esc(stLetter) + '">' + esc(f.status === '??' ? 'U' : f.status) + '</span><span class="g-path">' + esc(f.path) + '</span><button class="gf-x" title="Discard changes to this file">✕</button>';
    el.onclick = () => { S.selGitFile = f.path; refreshGitSel(); showFileDiff(f.path); };
    el.querySelector('.gf-x').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Discard changes to ' + f.path + '?' + (stLetter === 'U' ? ' (deletes the untracked file)' : ''))) return;
      const r = await H.gitDiscard(rec.meta.id, f.path, f.status);
      if (r.error) alert(r.error);
      refreshGit();
    };
    box.appendChild(el);
  }
  if (S.selGitFile && st.files.some((f) => f.path === S.selGitFile)) showFileDiff(S.selGitFile);
  else if (st.files.length) { S.selGitFile = st.files[0].path; refreshGitSel(); showFileDiff(S.selGitFile); }
}
function refreshGitSel() {
  for (const el of document.querySelectorAll('.gf')) {
    el.classList.toggle('sel', el.querySelector('.g-path').textContent === S.selGitFile);
  }
}
async function showFileDiff(file) {
  const rec = active(); if (!rec) return;
  const { diff } = await H.gitDiff(rec.meta.id, file);
  const view = $('gitDiffView');
  if (!diff) { view.textContent = '(no diff)'; return; }
  view.innerHTML = diff.split('\n').map((l) => {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted')) return '<span class="gl-meta">' + esc(l) + '</span>';
    if (l.startsWith('@@')) return '<span class="gl-hunk">' + esc(l) + '</span>';
    if (l.startsWith('+')) return '<span class="gl-add">' + esc(l) + '</span>';
    if (l.startsWith('-')) return '<span class="gl-del">' + esc(l) + '</span>';
    return esc(l) + '\n';
  }).join('');
}

// ---------------------------------------------------------------- run popover + more menu
const MENU_IDS = ['runPop', 'moreMenu', 'modeMenu', 'plusMenu', 'effortMenu', 'usageMenu'];
const MENU_TRIGGERS = ['#runBtn', '#moreBtn', '#modeBtn', '#plusBtn', '#effortBtn', '#usageLabel'];
function hideMenus() { for (const id of MENU_IDS) $(id).style.display = 'none'; }
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menu') && !MENU_TRIGGERS.some((sel) => e.target.closest(sel))) hideMenus();
});

$('runBtn').onclick = async () => {
  const rec = active(); if (!rec) return;
  const wasOpen = $('runPop').style.display !== 'none';
  hideMenus();
  if (wasOpen) return;
  $('runPop').style.display = '';
  $('runCmd').value = localStorage.getItem('runCmd:' + rec.meta.cwd) || '';
  $('runCmd').focus();
  const scripts = await H.projectScripts(rec.meta.id);
  const box = $('runScripts'); box.innerHTML = '';
  for (const s of scripts.slice(0, 12)) {
    const row = document.createElement('div'); row.className = 'menu-item';
    row.innerHTML = '<span class="p-main">' + esc(s.name) + '</span><span class="mi-hint">' + esc(s.command) + '</span>';
    row.onclick = () => { $('runCmd').value = s.command; startRun(); };
    box.appendChild(row);
  }
};
async function startRun() {
  const rec = active(); if (!rec) return;
  const command = $('runCmd').value.trim();
  if (!command) return;
  localStorage.setItem('runCmd:' + rec.meta.cwd, command);
  hideMenus();
  const t = await H.taskStart(rec.meta.id, command);
  if (t && t.error) { addLine(rec, 'err', '⚠︎ ' + t.error); return; }
  if (t) { S.tasks.set(t.id, t); S.selTask = t.id; showPanel('tasks'); }
}
$('runStart').onclick = startRun;
$('runCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startRun(); } if (e.key === 'Escape') hideMenus(); });

$('moreBtn').onclick = () => {
  const wasOpen = $('moreMenu').style.display !== 'none';
  hideMenus();
  if (!wasOpen) $('moreMenu').style.display = '';
};
$('moreMenu').addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item'); if (!item) return;
  const act = item.dataset.act;
  hideMenus();
  const rec = active();
  if (act === 'files' || act === 'tasks' || act === 'preview') showPanel(act);
  else if (act === 'sessions') H.openSessionsFolder();
  else if (rec && (act === 'finder' || act === 'terminal' || act === 'vscode')) {
    const r = await H.openIn(rec.meta.id, act);
    if (r && r.error) addLine(rec, 'err', '⚠︎ ' + r.error);
  }
});

// ---------------------------------------------------------------- background tasks
function taskDot(t) { return t.status === 'running' ? '<span class="t-dot run">●</span>' : '<span class="t-dot dead">●</span>'; }
function renderTasks() {
  const box = $('taskListEl'); box.innerHTML = '';
  const list = [...S.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  const running = list.filter((t) => t.status === 'running').length;
  $('taskBadge').style.display = running ? '' : 'none';
  $('taskBadge').textContent = running;
  if (!list.length) { box.innerHTML = '<div class="git-empty">No background tasks. Start one with ▷ in the toolbar.</div>'; $('taskLogEl').textContent = ''; return; }
  for (const t of list) {
    const row = document.createElement('div'); row.className = 'task-row' + (t.id === S.selTask ? ' sel' : '');
    row.innerHTML = taskDot(t) +
      '<span class="t-name">' + esc(t.name) + (t.status === 'exited' ? ' <span class="mi-hint">(exit ' + t.exitCode + ')</span>' : '') + '</span>' +
      (t.url ? '<span class="t-url">' + esc(t.url.replace(/^https?:\/\//, '')) + '</span>' : '') +
      '<button class="t-stop" title="' + (t.status === 'running' ? 'Stop' : 'Remove') + '">' + (t.status === 'running' ? '■' : '✕') + '</button>';
    row.onclick = async () => { S.selTask = t.id; renderTasks(); $('taskLogEl').textContent = await H.taskLog(t.id); $('taskLogEl').scrollTop = 1e9; };
    row.querySelector('.t-stop').onclick = async (e) => {
      e.stopPropagation();
      if (t.status === 'running') await H.taskStop(t.id);
      else { await H.taskRemove(t.id); S.tasks.delete(t.id); if (S.selTask === t.id) { S.selTask = null; $('taskLogEl').textContent = ''; } renderTasks(); }
    };
    box.appendChild(row);
  }
  if (S.selTask && S.tasks.has(S.selTask)) H.taskLog(S.selTask).then((l) => { $('taskLogEl').textContent = l; $('taskLogEl').scrollTop = 1e9; });
}
H.onTaskEvent((e) => {
  if (e.type === 'log') {
    if (S.panel === 'tasks' && e.id === S.selTask) {
      const el = $('taskLogEl');
      const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      el.textContent = (el.textContent + e.chunk).slice(-60000);
      if (stick) el.scrollTop = el.scrollHeight;
    }
    return;
  }
  H.taskList().then((list) => {
    S.tasks = new Map(list.map((t) => [t.id, t]));
    if (S.panel === 'tasks') renderTasks();
    const running = list.filter((t) => t.status === 'running').length;
    $('taskBadge').style.display = running ? '' : 'none';
    $('taskBadge').textContent = running;
  });
  if (e.type === 'url') setPreview(e.url, true);
});

// ---------------------------------------------------------------- preview (webview)
let webview = null;
function setPreview(url, autoshow) {
  if (!url) return;
  $('previewUrl').value = url;
  if (autoshow) showPanel('preview');
  const host = $('previewHost');
  if (!webview) {
    host.innerHTML = '';
    webview = document.createElement('webview');
    webview.setAttribute('partition', 'preview');
    host.appendChild(webview);
  }
  webview.setAttribute('src', url);
}
$('previewGo').onclick = () => { const u = $('previewUrl').value.trim(); if (u) setPreview(/^https?:/.test(u) ? u : 'http://' + u, false); else if (webview) webview.reload(); };
$('previewUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('previewGo').onclick(); });
$('previewExt').onclick = () => { const u = $('previewUrl').value.trim(); if (u) H.openExternal(/^https?:/.test(u) ? u : 'http://' + u); };

// ---------------------------------------------------------------- files panel
async function refreshFiles() {
  const rec = active(); if (!rec) return;
  $('filesRoot').textContent = shortDir(rec.meta.cwd);
  $('filePreview').style.display = 'none';
  S.selFile = null;
  const tree = $('fileTree'); tree.innerHTML = '';
  await renderTreeLevel(tree, '', 0);
}
$('filesRefresh').onclick = () => refreshFiles();
async function renderTreeLevel(container, sub, depth) {
  const rec = active(); if (!rec || depth > 8) return;
  const entries = await H.fileTree(rec.meta.id, sub || '.');
  for (const e of entries) {
    const rel = sub ? sub + '/' + e.name : e.name;
    const row = document.createElement('div'); row.className = 'ft-row';
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    row.innerHTML = '<span class="ft-i">' + (e.dir ? '▸' : '·') + '</span>' + esc(e.name) + (e.dir ? '/' : '');
    container.appendChild(row);
    if (e.dir) {
      let kids = null;
      row.onclick = async () => {
        if (kids) { kids.remove(); kids = null; row.querySelector('.ft-i').textContent = '▸'; return; }
        kids = document.createElement('div');
        row.after(kids);
        row.querySelector('.ft-i').textContent = '▾';
        await renderTreeLevel(kids, rel, depth + 1);
      };
    } else {
      row.onclick = async () => {
        for (const r of document.querySelectorAll('.ft-row.sel')) r.classList.remove('sel');
        row.classList.add('sel');
        S.selFile = rel;
        const res = await H.fileRead(rec.meta.id, rel);
        const fp = $('filePreview');
        fp.style.display = '';
        fp.textContent = res.error ? '⚠︎ ' + res.error : res.binary ? '(binary file, ' + res.bytes + ' bytes)' : res.content;
      };
    }
  }
}

// ---------------------------------------------------------------- model sheet
async function openModelSheet(forceRefresh) {
  $('modelSheet').style.display = 'flex';
  $('modelSearch').value = ''; $('modelSearch').focus();
  if (!S.models.length || forceRefresh) {
    $('modelCount').textContent = 'Loading…';
    S.models = await H.listModels(!!forceRefresh);
  }
  renderModels('');
}
$('modelBtn').onclick = () => openModelSheet(false);
$('modelRefresh').onclick = () => openModelSheet(true);
$('modelClose').onclick = () => { $('modelSheet').style.display = 'none'; };
$('modelSearch').addEventListener('input', (e) => renderModels(e.target.value));
$('modelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) chooseModel(q); }
  if (e.key === 'Escape') { $('modelSheet').style.display = 'none'; }
});
function priceStr(m) {
  if (!m.pricing) return '';
  const pin = m.pricing.prompt * 1e6, pout = m.pricing.completion * 1e6;
  if (!pin && !pout) return 'free';
  return '$' + pin.toFixed(2) + ' / $' + pout.toFixed(2) + ' per M';
}
function renderModels(q) {
  const rec = active();
  const s = q.trim().toLowerCase();
  const list = s ? S.models.filter((m) => m.value.toLowerCase().includes(s) || m.label.toLowerCase().includes(s)) : S.models;
  $('modelCount').textContent = list.length + ' of ' + S.models.length + ' models' +
    (s && !S.models.some((m) => m.value === q.trim()) ? ' · Enter to use “' + q.trim() + '”' : '');
  const box = $('modelList'); box.innerHTML = '';
  for (const m of list.slice(0, 400)) {
    const row = document.createElement('div');
    row.className = 'model-row' + (rec && m.value === rec.meta.model ? ' sel' : '');
    row.innerHTML = '<div class="m-line"><div>' + esc(m.label) + (m.reasoning ? ' <span class="mi-hint" title="Supports reasoning effort">🧠</span>' : '') + '</div><div class="m-price">' + esc(priceStr(m)) + '</div></div>' +
      '<div class="mv">' + esc(m.value) + (m.context ? ' · ' + Math.round(m.context / 1000) + 'k ctx' : '') + '</div>';
    row.onclick = () => chooseModel(m.value);
    box.appendChild(row);
  }
}
async function chooseModel(v) {
  await setSessionConfig({ model: v });
  $('modelSheet').style.display = 'none';
}

// ---------------------------------------------------------------- settings page
$('settingsBtn').onclick = () => {
  $('settingsSheet').style.display = 'flex';
  $('keyInput').value = '';
  renderMcpList(); renderSkillsList(); renderPluginsList(); renderSpend(); renderRules();
  H.getConfig().then((c) => { $('sandboxToggle').checked = !!c.sandboxBash; $('suggestToggle').checked = !!c.suggestions; });
};
$('sandboxToggle').onchange = () => H.setConfig({ sandboxBash: $('sandboxToggle').checked });
$('suggestToggle').onchange = () => H.setConfig({ suggestions: $('suggestToggle').checked });
async function renderRules() {
  const rules = await H.rulesList();
  const box = $('rulesList'); box.innerHTML = '';
  if (!rules.length) { box.innerHTML = '<div class="muted">No rules yet — use "Always allow" on an approval prompt.</div>'; return; }
  rules.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'sl-row';
    row.innerHTML = '<div class="sl-main"><b>' + esc(r.kind) + '</b> <span class="mi-hint mono">' + esc(r.prefix) + '…</span>' +
      '<div class="mi-hint">' + (r.cwd ? esc(shortDir(r.cwd)) : 'all projects') + '</div></div>' +
      '<button class="mini-btn">✕</button>';
    row.querySelector('button').onclick = async () => { await H.ruleRemove(i); renderRules(); };
    box.appendChild(row);
  });
}

// AI spend (General section)
function money(v) { return '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2)); }
async function renderSpend() {
  const s = await H.spendSummary();
  if (!s) return;
  $('spendGrid').innerHTML =
    '<span>Today</span><span>' + money(s.today) + '</span>' +
    '<span>This week</span><span>' + money(s.week) + '</span>' +
    '<span>This month</span><span>' + money(s.month) + '</span>' +
    '<span>YTD</span><span>' + money(s.ytd) + '</span>' +
    '<span>All time</span><span>' + money(s.allTime) + ' <span class="mi-hint">Harness only</span></span>' +
    (s.credits && s.credits.used != null
      ? '<span>Account</span><span>' + money(s.credits.used) + (s.credits.total ? ' of $' + s.credits.total.toFixed(2) + ' credits' : '') + ' <span class="mi-hint">whole OpenRouter key</span></span>'
      : '');
  const max = Math.max(...s.bars.map((b) => b.cost), 0.0001);
  $('spendBars').innerHTML = s.bars.map((b) =>
    '<div class="b" style="height:' + Math.max(2, Math.round(b.cost / max * 100)) + '%" title="' + b.day + ' · ' + money(b.cost) + '"></div>'
  ).join('');
}
$('settingsClose').onclick = () => { $('settingsSheet').style.display = 'none'; };
$('sessionsFolderBtn').onclick = () => H.openSessionsFolder();
$('keySave').onclick = async () => {
  const k = $('keyInput').value.trim();
  if (k) { await H.setConfig({ apiKey: k }); S.models = []; $('keyInput').value = ''; }
};
for (const b of document.querySelectorAll('.snav')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.snav')) x.classList.toggle('on', x === b);
    for (const sec of document.querySelectorAll('.ssec')) sec.style.display = 'none';
    $('sec-' + b.dataset.sec).style.display = '';
  };
}

// MCP servers section
async function renderMcpList() {
  const list = await H.mcpList();
  const box = $('mcpList'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="muted">No servers yet — add one below.</div>'; return; }
  for (const s of list) {
    const row = document.createElement('div'); row.className = 'sl-row';
    const dot = s.status === 'running' ? '<span class="dot ok">●</span>' : s.status === 'starting' ? '<span class="dot run">●</span>' : '<span class="dot bad">●</span>';
    row.innerHTML = dot + '<div class="sl-main"><b>' + esc(s.name) + '</b> <span class="mi-hint">' + esc(s.status) +
      (s.status === 'running' ? ' · ' + s.tools.length + ' tools' : '') + (s.error ? ' · ' + esc(s.error.slice(0, 80)) : '') + '</span>' +
      '<div class="mi-hint mono">' + esc(s.command) + '</div>' +
      (s.tools.length ? '<div class="mi-hint">' + esc(s.tools.slice(0, 8).join(', ')) + (s.tools.length > 8 ? '…' : '') + '</div>' : '') + '</div>' +
      '<button class="mini-btn" data-a="toggle">' + (s.enabled ? 'Disable' : 'Enable') + '</button>' +
      '<button class="mini-btn" data-a="restart">⟳</button>' +
      '<button class="mini-btn" data-a="remove">✕</button>';
    row.querySelector('[data-a=toggle]').onclick = async () => { await H.mcpToggle(s.name, !s.enabled); renderMcpList(); };
    row.querySelector('[data-a=restart]').onclick = async () => { await H.mcpRestart(s.name); renderMcpList(); };
    row.querySelector('[data-a=remove]').onclick = async () => { if (confirm('Remove MCP server "' + s.name + '"?')) { await H.mcpRemove(s.name); renderMcpList(); } };
    box.appendChild(row);
  }
}
$('mcpAddBtn').onclick = async () => {
  const r = await H.mcpAdd($('mcpName').value.trim(), $('mcpCmd').value.trim());
  if (r.error) alert(r.error);
  else { $('mcpName').value = ''; $('mcpCmd').value = ''; }
  renderMcpList();
};
H.onMcpUpdated(() => { if ($('settingsSheet').style.display === 'flex') renderMcpList(); });

// Skills section
async function loadSkills() { S.skills = await H.skillsList(); }
async function renderSkillsList() {
  await loadSkills();
  const box = $('skillsListEl'); box.innerHTML = '';
  if (!S.skills.length) { box.innerHTML = '<div class="muted">No skills yet — add one below, then type /name in the composer.</div>'; return; }
  for (const s of S.skills) {
    const row = document.createElement('div'); row.className = 'sl-row';
    row.innerHTML = '<div class="sl-main"><b>/' + esc(s.name) + '</b> <span class="mi-hint">' + esc(s.description || '') + '</span></div>' +
      '<button class="mini-btn" data-a="edit">Edit</button><button class="mini-btn" data-a="remove">✕</button>';
    row.querySelector('[data-a=edit]').onclick = () => { $('skillName').value = s.name; $('skillContent').value = s.content; };
    row.querySelector('[data-a=remove]').onclick = async () => { if (confirm('Delete skill /' + s.name + '?')) { await H.skillDelete(s.name); renderSkillsList(); } };
    box.appendChild(row);
  }
}
$('skillSaveBtn').onclick = async () => {
  const r = await H.skillSave($('skillName').value.trim(), $('skillContent').value);
  if (r.error) alert(r.error);
  else { $('skillName').value = ''; $('skillContent').value = ''; }
  renderSkillsList();
};

// Plugins section
async function renderPluginsList() {
  const list = await H.pluginList();
  const box = $('pluginList'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="muted">No plugins installed — add one below.</div>'; return; }
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'sl-row';
    row.innerHTML = '<span class="dot ' + (p.enabled ? 'ok' : 'bad') + '">●</span>' +
      '<div class="sl-main"><b>' + esc(p.name) + '</b> <span class="mi-hint">' + esc(p.version || '') + ' ' + esc(p.description || '') + '</span>' +
      '<div class="mi-hint">' + p.skills.length + ' skills' + (p.skills.length ? ' (' + p.skills.map((s) => '/' + s).join(' ') + ')' : '') +
      ' · ' + p.mcpServers.length + ' MCP servers</div></div>' +
      '<button class="mini-btn" data-a="toggle">' + (p.enabled ? 'Disable' : 'Enable') + '</button>' +
      '<button class="mini-btn" data-a="remove">✕</button>';
    row.querySelector('[data-a=toggle]').onclick = async () => { await H.pluginToggle(p.dir, !p.enabled); await loadSkills(); renderPluginsList(); renderMcpList(); };
    row.querySelector('[data-a=remove]').onclick = async () => {
      if (confirm('Uninstall plugin "' + p.name + '"? This deletes its folder.')) { await H.pluginRemove(p.dir); await loadSkills(); renderPluginsList(); renderMcpList(); }
    };
    box.appendChild(row);
  }
}
$('pluginInstallBtn').onclick = async () => {
  const r = await H.pluginInstall($('pluginSource').value.trim());
  if (r.error) alert(r.error);
  else $('pluginSource').value = '';
  await loadSkills();
  renderPluginsList(); renderMcpList();
};

// ---------------------------------------------------------------- appshot + agent-driven browser
H.onAppshot((a) => {
  const rec = active(); if (!rec) return;
  rec.attachments = rec.attachments || [];
  rec.attachments.push({ name: a.name, dataUrl: a.dataUrl });
  renderAttachRow();
  addLine(rec, 'done', '📸 appshot attached — describe what you want done with it');
  $('input').focus();
});
H.onPreviewOpen(({ url }) => setPreview(url, true));

// ---------------------------------------------------------------- global keys
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // number keys pick a mode while the mode menu is open
  if ($('modeMenu').style.display !== 'none' && e.key >= '1' && e.key <= '5') {
    e.preventDefault(); hideMenus();
    setSessionConfig({ mode: MODES[+e.key - 1].key });
    return;
  }
  if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); attachFiles(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openModelSheet(false); }
  else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('sideToggle').onclick(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDiff(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); togglePanel('files'); }
  else if (mod && e.key >= '1' && e.key <= '9') {
    const idx = +e.key - 1;
    if (S.order[idx]) { e.preventDefault(); activate(S.order[idx]); }
  }
  else if (e.key === 'Escape' && $('approvalModal').style.display !== 'flex') {
    if ($('modelSheet').style.display === 'flex') $('modelSheet').style.display = 'none';
    else if ($('settingsSheet').style.display === 'flex') $('settingsSheet').style.display = 'none';
    else if (S.cliView) closeCliView();
  }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  const metas = await H.sessionsList();
  if (!metas.length) await H.sessionCreate({});
  await refreshSessions();
  if (S.order.length) activate(S.order[0]);
  const cfg = await H.getConfig();
  if (!cfg.hasKey) $('settingsSheet').style.display = 'flex';
  loadSkills();
  // the effort chip needs per-model reasoning flags — load the (cached) catalog now
  S.models = await H.listModels(false);
  updateTitlebar();
  setInterval(renderSidebar, 60000);   // keep "2m ago" labels fresh
})();
