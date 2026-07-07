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
  sessionConfig: (id, patch) => ipcRenderer.invoke('session-config', { id, patch }),
  sessionSend: (id, text, images) => ipcRenderer.invoke('session-send', { id, text, images }),
  sessionAbort: (id) => ipcRenderer.invoke('session-abort', id),
  sessionClear: (id) => ipcRenderer.invoke('session-clear', id),
  sessionCompact: (id) => ipcRenderer.invoke('session-compact', id),

  // pickers / catalog / project
  pickDir: (id) => ipcRenderer.invoke('pick-dir', id),
  listModels: (force) => ipcRenderer.invoke('list-models', !!force),
  listFiles: (id) => ipcRenderer.invoke('list-files', id),
  gitStatus: (id) => ipcRenderer.invoke('git-status', id),
  gitDiff: (id, file) => ipcRenderer.invoke('git-diff', { id, file }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openSessionsFolder: () => ipcRenderer.invoke('open-sessions-folder'),

  // background tasks + run
  taskStart: (sessionId, command, name) => ipcRenderer.invoke('task-start', { sessionId, command, name }),
  taskStop: (id) => ipcRenderer.invoke('task-stop', id),
  taskRemove: (id) => ipcRenderer.invoke('task-remove', id),
  taskList: () => ipcRenderer.invoke('task-list'),
  taskLog: (id) => ipcRenderer.invoke('task-log', id),
  projectScripts: (id) => ipcRenderer.invoke('project-scripts', id),
  onTaskEvent: (cb) => ipcRenderer.on('task-event', (_e, ev) => cb(ev)),

  // usage + attachments
  credits: () => ipcRenderer.invoke('credits'),
  pickFiles: (id) => ipcRenderer.invoke('pick-files', id),
  pickFolderPath: (id) => ipcRenderer.invoke('pick-folder-path', id),

  // files panel + open-in
  fileTree: (id, sub) => ipcRenderer.invoke('file-tree', { id, sub }),
  fileRead: (id, rel) => ipcRenderer.invoke('file-read', { id, rel }),
  openIn: (id, target) => ipcRenderer.invoke('open-in', { id, target }),

  // approvals + events
  respondApproval: (id, approved) => ipcRenderer.send('approval-response', { id, approved }),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, ev) => cb(ev)),
  onApproval: (cb) => ipcRenderer.on('approval', (_e, a) => cb(a)),
  onSessionsUpdated: (cb) => ipcRenderer.on('sessions-updated', () => cb()),
});
