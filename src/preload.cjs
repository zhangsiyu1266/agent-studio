'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  getState: () => ipcRenderer.invoke('studio:state'),
  probe: () => ipcRenderer.invoke('studio:probe'),
  chooseProject: () => ipcRenderer.invoke('studio:choose-project'),
  selectProject: (target) => ipcRenderer.invoke('studio:projects-select', target),
  forgetProject: (target) => ipcRenderer.invoke('studio:projects-forget', target),
  createProject: (input) => ipcRenderer.invoke('studio:projects-create', input),
  chooseProjectParent: () => ipcRenderer.invoke('studio:projects-parent'),
  githubStatus: () => ipcRenderer.invoke('studio:github-status'),
  githubLogin: () => ipcRenderer.invoke('studio:github-login'),
  githubRepositories: (page) => ipcRenderer.invoke('studio:github-repositories', page),
  githubClone: (input) => ipcRenderer.invoke('studio:github-clone', input),
  githubCancel: (id) => ipcRenderer.invoke('studio:github-cancel', id),
  githubDevicePage: () => ipcRenderer.invoke('studio:github-device-page'),
  chooseAttachments: () => ipcRenderer.invoke('studio:choose-attachments'),
  importAttachments: (files) => ipcRenderer.invoke('studio:import-attachments', Array.from(files, (file) => webUtils.getPathForFile(file))),
  copyText: (text) => ipcRenderer.invoke('studio:copy', text),
  pasteText: () => ipcRenderer.invoke('studio:paste'),
  pasteImage: () => ipcRenderer.invoke('studio:paste-image'),
  startRun: (payload) => ipcRenderer.invoke('studio:start', payload),
  getRun: (id) => ipcRenderer.invoke('studio:run', id),
  cancelRun: (id) => ipcRenderer.invoke('studio:cancel', id),
  retryRun: (id) => ipcRenderer.invoke('studio:retry', id),
  saveSettings: (settings) => ipcRenderer.invoke('studio:settings', settings),
  getDiff: (id) => ipcRenderer.invoke('studio:diff', id),
  openProject: (target) => ipcRenderer.invoke('studio:open-project', target),
  exportRun: (id) => ipcRenderer.invoke('studio:export', id),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('studio:event', listener);
    return () => ipcRenderer.removeListener('studio:event', listener);
  },
});
