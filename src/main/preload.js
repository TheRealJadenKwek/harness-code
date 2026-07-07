'use strict';
// Safe bridge between the sandboxed renderer and the Node main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  listModels: () => ipcRenderer.invoke('list-models'),
  newSession: () => ipcRenderer.invoke('new-session'),
  send: (text) => ipcRenderer.invoke('send', text),
  abort: () => ipcRenderer.invoke('abort'),
  respondApproval: (id, approved) => ipcRenderer.send('approval-response', { id, approved }),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, ev) => cb(ev)),
  onApproval: (cb) => ipcRenderer.on('approval', (_e, a) => cb(a)),
});
