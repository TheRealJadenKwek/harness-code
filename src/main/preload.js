'use strict';
// Safe bridge between the sandboxed renderer and the Node main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  // config
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),

  // sessions
  sessionsList: () => ipcRenderer.invoke('sessions-list'),
  sessionCreate: (opts) => ipcRenderer.invoke('session-create', opts || {}),
  sessionDelete: (id) => ipcRenderer.invoke('session-delete', id),
  sessionGet: (id) => ipcRenderer.invoke('session-get', id),
  sessionRename: (id, title) => ipcRenderer.invoke('session-rename', { id, title }),
  sessionMeta: (id, patch) => ipcRenderer.invoke('session-meta', { id, patch }),
  sessionConfig: (id, patch) => ipcRenderer.invoke('session-config', { id, patch }),
  sessionSend: (id, text, images, modelText) => ipcRenderer.invoke('session-send', { id, text, images, modelText }),
  sessionAbort: (id) => ipcRenderer.invoke('session-abort', id),
  sessionClear: (id) => ipcRenderer.invoke('session-clear', id),
  sessionCompact: (id) => ipcRenderer.invoke('session-compact', id),
  sessionRevert: (id, ckptId) => ipcRenderer.invoke('session-revert', { id, ckptId }),
  trashList: () => ipcRenderer.invoke('trash-list'),
  trashRestore: (id) => ipcRenderer.invoke('trash-restore', id),
  trashPurge: (id) => ipcRenderer.invoke('trash-purge', id),

  // pickers / catalog / project
  pickDir: (id) => ipcRenderer.invoke('pick-dir', id),
  listModels: (force) => ipcRenderer.invoke('list-models', !!force),
  listFiles: (id) => ipcRenderer.invoke('list-files', id),
  gitStatus: (id) => ipcRenderer.invoke('git-status', id),
  gitDiff: (id, file) => ipcRenderer.invoke('git-diff', { id, file }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  clipboardWrite: (t) => ipcRenderer.invoke('clipboard-write', String(t)),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  openSessionsFolder: () => ipcRenderer.invoke('open-sessions-folder'),

  // background tasks + run
  taskStart: (sessionId, command, name) => ipcRenderer.invoke('task-start', { sessionId, command, name }),
  taskStop: (id) => ipcRenderer.invoke('task-stop', id),
  taskRemove: (id) => ipcRenderer.invoke('task-remove', id),
  taskList: () => ipcRenderer.invoke('task-list'),
  taskLog: (id) => ipcRenderer.invoke('task-log', id),
  projectScripts: (id) => ipcRenderer.invoke('project-scripts', id),
  onTaskEvent: (cb) => ipcRenderer.on('task-event', (_e, ev) => cb(ev)),

  // fork / goal / mcp / skills
  sessionFork: (id) => ipcRenderer.invoke('session-fork', id),
  sessionRewind: (id, n) => ipcRenderer.invoke('session-rewind', { id, n }),
  sessionForkAt: (id, n) => ipcRenderer.invoke('session-fork-at', { id, n }),
  sessionGoal: (id, goal) => ipcRenderer.invoke('session-goal', { id, goal }),
  mcpList: () => ipcRenderer.invoke('mcp-list'),
  mcpAdd: (name, command) => ipcRenderer.invoke('mcp-add', { name, command }),
  mcpRemove: (name) => ipcRenderer.invoke('mcp-remove', name),
  mcpToggle: (name, enabled) => ipcRenderer.invoke('mcp-toggle', { name, enabled }),
  mcpRestart: (name) => ipcRenderer.invoke('mcp-restart', name),
  onMcpUpdated: (cb) => ipcRenderer.on('mcp-updated', () => cb()),
  pluginList: () => ipcRenderer.invoke('plugin-list'),
  pluginInstall: (source) => ipcRenderer.invoke('plugin-install', source),
  pluginToggle: (dir, enabled) => ipcRenderer.invoke('plugin-toggle', { dir, enabled }),
  pluginRemove: (dir) => ipcRenderer.invoke('plugin-remove', dir),
  skillsList: () => ipcRenderer.invoke('skills-list'),
  skillSave: (name, content) => ipcRenderer.invoke('skill-save', { name, content }),
  skillDelete: (name) => ipcRenderer.invoke('skill-delete', name),
  onAppshot: (cb) => ipcRenderer.on('appshot', (_e, a) => cb(a)),
  onSuggest: (cb) => ipcRenderer.on('suggest', (_e, a) => cb(a)),
  onPreviewOpen: (cb) => ipcRenderer.on('preview-open', (_e, a) => cb(a)),

  // usage + attachments
  credits: () => ipcRenderer.invoke('credits'),
  spendSummary: () => ipcRenderer.invoke('spend-summary'),
  pickFiles: (id, vision) => ipcRenderer.invoke('pick-files', { id, vision }),
  pickFolderPath: (id) => ipcRenderer.invoke('pick-folder-path', id),

  // files panel + open-in
  fileTree: (id, sub) => ipcRenderer.invoke('file-tree', { id, sub }),
  fileRead: (id, rel) => ipcRenderer.invoke('file-read', { id, rel }),
  openIn: (id, target) => ipcRenderer.invoke('open-in', { id, target }),

  // approvals + events
  respondApproval: (id, approved, always) => ipcRenderer.send('approval-response', { id, approved, always }),
  sessionSteer: (id, text) => ipcRenderer.invoke('session-steer', { id, text }),
  sessionWorktree: (id) => ipcRenderer.invoke('session-worktree', id),
  gitCommit: (id, message) => ipcRenderer.invoke('git-commit', { id, message }),
  gitPr: (id) => ipcRenderer.invoke('git-pr', id),
  rulesList: () => ipcRenderer.invoke('rules-list'),
  sessionsSearch: (q) => ipcRenderer.invoke('sessions-search', q),
  cliSessions: () => ipcRenderer.invoke('cli-sessions'),
  cliSessionGet: (fp) => ipcRenderer.invoke('cli-session-get', fp),
  gitDiscard: (id, file, status) => ipcRenderer.invoke('git-discard', { id, file, status }),
  selfUpdate: () => ipcRenderer.invoke('self-update'),
  appRelaunch: () => ipcRenderer.invoke('app-relaunch'),
  transcribe: (b64) => ipcRenderer.invoke('transcribe', b64),
  micPermission: () => ipcRenderer.invoke('mic-permission'),
  ruleRemove: (idx) => ipcRenderer.invoke('rule-remove', idx),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, ev) => cb(ev)),
  onApproval: (cb) => ipcRenderer.on('approval', (_e, a) => cb(a)),
  onSessionsUpdated: (cb) => ipcRenderer.on('sessions-updated', () => cb()),
});
