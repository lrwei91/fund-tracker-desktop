const { app, BrowserWindow, ipcMain, protocol, session } = require('electron')
const path = require('path')
const { createConfigStore } = require('./desktop/config-store')
const { registerProtocol } = require('./desktop/protocol-router')
const { createWindowManager } = require('./desktop/window-manager')

const IS_WINDOWS = process.platform === 'win32'
if (IS_WINDOWS) app.disableHardwareAcceleration()

protocol.registerSchemesAsPrivileged([{
  scheme: 'fund-tracker',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

const APP_ROOT = path.join(__dirname, 'app')
const RENDERER_ROOT = path.join(__dirname, 'renderer')
const configStore = createConfigStore(() => app.getPath('userData'))
const appUrl = (pathname) => `fund-tracker://app/${String(pathname || 'index.html').replace(/^\/+/, '')}`

function localDataPaths() {
  const userData = app.getPath('userData')
  return {
    userData,
    config: configStore.filePath(),
    localStorage: path.join(userData, 'Local Storage', 'leveldb'),
    sessionStorage: path.join(userData, 'Session Storage'),
    cache: path.join(userData, 'Cache'),
  }
}

async function clearLocalDataAndQuit(reason) {
  console.info('[fund-tracker] local data paths', { reason, platform: process.platform, ...localDataPaths() })
  try {
    await Promise.all(BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map(async (win) => {
      await win.webContents.executeJavaScript('try { localStorage.clear(); sessionStorage.clear(); true } catch (e) { false }', true)
    }))
    await configStore.clear()
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] })
    await session.defaultSession.clearCache()
  } catch (error) {
    console.error('[fund-tracker] local data clear failed', error && error.message ? error.message : error)
  } finally {
    BrowserWindow.getAllWindows().forEach((win) => { if (!win.isDestroyed()) win.destroy() })
    app.quit()
  }
}

const windows = createWindowManager({
  app, BrowserWindow, ipcMain,
  Menu: require('electron').Menu,
  Tray: require('electron').Tray,
  nativeImage: require('electron').nativeImage,
  screen: require('electron').screen,
  appUrl, isWindows: IS_WINDOWS,
  onClearAndQuit: clearLocalDataAndQuit,
  preloadPath: path.join(__dirname, 'preload.js'),
})

app.whenReady().then(() => {
  console.info('[fund-tracker] local data paths', { reason: 'app-ready', platform: process.platform, ...localDataPaths() })
  ipcMain.handle('config-storage-load', () => configStore.load())
  ipcMain.handle('config-storage-patch', (_event, changes) => configStore.patch(changes))
  ipcMain.handle('config-storage-path', () => configStore.filePath())
  windows.registerIpc()
  registerProtocol({ app, appRoot: APP_ROOT, protocol, rendererRoot: RENDERER_ROOT })
  windows.createMainWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) windows.createMainWindow(); else windows.showAppFromDock() })
})

app.on('window-all-closed', () => {
  windows.removeTrayIcon()
  if (process.platform !== 'darwin') app.quit()
})
