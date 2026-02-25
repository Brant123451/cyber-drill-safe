/**
 * Electron Main Process
 * Handles window creation and IPC for proxy management
 */

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialize,
  runProxy,
  stopRunning,
  restore,
  getStatus,
} from "./proxy-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 700,
    title: "Wind \u5ba2\u6237\u7aef",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  // Cleanup: stop proxy and restore hosts on quit
  stopRunning();
  app.quit();
});

// ============================================================
// IPC Handlers - called from renderer via preload bridge
// ============================================================

ipcMain.handle("proxy:initialize", () => initialize());
ipcMain.handle("proxy:run", (_e, gatewayUrl) => runProxy(gatewayUrl));
ipcMain.handle("proxy:stop", () => stopRunning());
ipcMain.handle("proxy:restore", () => restore());
ipcMain.handle("proxy:status", () => getStatus());
