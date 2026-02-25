/**
 * Preload script - bridges Electron IPC to renderer
 * Exposes safe API to the React app via window.electronAPI
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  proxyInitialize: () => ipcRenderer.invoke("proxy:initialize"),
  proxyRun: (gatewayUrl) => ipcRenderer.invoke("proxy:run", gatewayUrl),
  proxyStop: () => ipcRenderer.invoke("proxy:stop"),
  proxyRestore: () => ipcRenderer.invoke("proxy:restore"),
  proxyStatus: () => ipcRenderer.invoke("proxy:status"),
});
