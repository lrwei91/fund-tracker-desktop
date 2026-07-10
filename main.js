const { app, BrowserWindow, ipcMain, Menu, protocol, screen, session, Tray, nativeImage } = require('electron')
const path = require('path')
const { createConfigStore } = require('./desktop/config-store')
const { registerProtocol } = require('./desktop/protocol-router')

const IS_WINDOWS = process.platform === 'win32'

if (IS_WINDOWS) {
  // Windows + transparent always-on-top frameless windows can be unstable on
  // some GPU drivers when the user switches apps. The UI is lightweight, so
  // preferring software compositing is the safer default for the desktop build.
  app.disableHardwareAcceleration()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fund-tracker',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

const APP_ROOT = path.join(__dirname, 'app')
const RENDERER_ROOT = path.join(__dirname, 'renderer')

const WIDGET_W = 320
const WIDGET_H = 58
const WIDGET_MARGIN = 20

let mainWin = null
let holdingWin = null
let tray = null
let lastHiddenWindow = 'main'
let isClearingAndQuitting = false
const configStore = createConfigStore(() => app.getPath('userData'))

const MAIN_WINDOW_CHROME = process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 14 } }
  : {}

function appUrl(pathname) {
  return `fund-tracker://app/${String(pathname || 'index.html').replace(/^\/+/, '')}`
}

function getLocalDataPaths() {
  const userData = app.getPath('userData')
  return {
    userData,
    config: getUserConfigPath(),
    localStorage: path.join(userData, 'Local Storage', 'leveldb'),
    sessionStorage: path.join(userData, 'Session Storage'),
    cache: path.join(userData, 'Cache'),
  }
}

function getUserConfigPath() {
  return configStore.filePath()
}

function registerConfigStorageIpc() {
  ipcMain.handle('config-storage-load', () => configStore.load())
  ipcMain.handle('config-storage-patch', (_event, changes) => configStore.patch(changes))
  ipcMain.handle('config-storage-path', () => getUserConfigPath())
}

function registerLocalProtocol() {
  registerProtocol({ app, appRoot: APP_ROOT, protocol, rendererRoot: RENDERER_ROOT })
}

function logLocalDataPaths(reason) {
  const paths = getLocalDataPaths()
  console.info('[fund-tracker] local data paths', {
    reason,
    platform: process.platform,
    ...paths,
  })
}

function wireWindowDiagnostics(win, name) {
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[fund-tracker] renderer gone', { name, details })
  })
  win.webContents.on('unresponsive', () => {
    console.error('[fund-tracker] window unresponsive', { name })
  })
}

function createTrayIcon() {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const isBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1
      const isMark = (x >= 4 && x <= 11 && y >= 4 && y <= 5)
        || (x >= 4 && x <= 6 && y >= 4 && y <= 11)
        || (x >= 4 && x <= 11 && y >= 10 && y <= 11)
        || (x >= 9 && x <= 11 && y >= 8 && y <= 11)
      if (isBorder) {
        bitmap[i] = 0x00
        bitmap[i + 1] = 0x00
        bitmap[i + 2] = 0x00
        bitmap[i + 3] = 0xff
      } else if (isMark) {
        bitmap[i] = 0x00
        bitmap[i + 1] = 0xab
        bitmap[i + 2] = 0xff
        bitmap[i + 3] = 0xff
      } else {
        bitmap[i] = 0x08
        bitmap[i + 1] = 0x06
        bitmap[i + 2] = 0x05
        bitmap[i + 3] = 0xff
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

function removeTrayIcon() {
  if (!tray) return
  tray.destroy()
  tray = null
}

function restoreHoldingFromTray() {
  removeTrayIcon()
  if (holdingWin && !holdingWin.isDestroyed()) {
    holdingWin.setBounds(getWidgetBounds())
    refreshHoldingWidget()
    showHoldingWindow()
    return
  }
  createHoldingWidget()
}

function ensureTrayIcon() {
  if (!IS_WINDOWS || tray) return
  tray = new Tray(createTrayIcon())
  tray.setToolTip('恭喜发财 - 持仓浮窗')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示持仓浮窗', click: restoreHoldingFromTray },
    {
      label: '退出并清除本地数据',
      click: () => clearLocalDataAndQuit('windows-tray-quit'),
    },
  ]))
  tray.on('click', restoreHoldingFromTray)
  tray.on('double-click', restoreHoldingFromTray)
}

async function clearRendererStorage(win) {
  if (!win || win.isDestroyed()) return
  try {
    await win.webContents.executeJavaScript(
      'try { localStorage.clear(); sessionStorage.clear(); true } catch (e) { false }',
      true
    )
  } catch (error) {
    console.warn('[fund-tracker] renderer storage clear failed', error && error.message ? error.message : error)
  }
}

async function clearLocalData() {
  const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  await Promise.all(wins.map(clearRendererStorage))
  await configStore.clear()
  try {
    await session.defaultSession.clearStorageData({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'shadercache',
        'websql',
        'serviceworkers',
        'cachestorage',
      ],
    })
  } catch (error) {
    console.warn('[fund-tracker] scoped storage clear failed, retrying full clear', error && error.message ? error.message : error)
    await session.defaultSession.clearStorageData()
  }
  await session.defaultSession.clearCache()
}

async function clearLocalDataAndQuit(reason) {
  if (isClearingAndQuitting) return
  isClearingAndQuitting = true
  logLocalDataPaths(reason)
  try {
    await clearLocalData()
  } catch (error) {
    console.error('[fund-tracker] local data clear failed', error && error.message ? error.message : error)
  } finally {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
    app.quit()
  }
}

function getWidgetBounds() {
  const sourceWin = mainWin && !mainWin.isDestroyed() ? mainWin : BrowserWindow.getFocusedWindow()
  const display = sourceWin ? screen.getDisplayMatching(sourceWin.getBounds()) : screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  return {
    x: x + width - WIDGET_W - WIDGET_MARGIN,
    y: y + height - WIDGET_H - WIDGET_MARGIN,
    width: WIDGET_W,
    height: WIDGET_H,
  }
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 592,
    height: 820,
    minWidth: 540,
    minHeight: 680,
    title: '恭喜发财',
    backgroundColor: '#050608',
    ...MAIN_WINDOW_CHROME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  wireWindowDiagnostics(mainWin, 'main')
  mainWin.loadURL(appUrl('index.html'))
  Menu.setApplicationMenu(null)
  mainWin.on('minimize', (event) => {
    if (IS_WINDOWS) {
      event.preventDefault()
      removeTrayIcon()
      app.quit()
      return
    }
    lastHiddenWindow = 'main'
  })
  mainWin.on('closed', () => { mainWin = null })
}

function refreshHoldingWidget() {
  if (!holdingWin || holdingWin.isDestroyed()) return
  holdingWin.webContents.send('holding-widget-refresh')
}

function createHoldingWidget() {
  if (holdingWin && !holdingWin.isDestroyed()) return holdingWin

  holdingWin = new BrowserWindow({
    ...getWidgetBounds(),
    title: '持仓库',
    frame: false,
    transparent: !IS_WINDOWS,
    backgroundColor: IS_WINDOWS ? '#050608' : '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: !IS_WINDOWS,
    minWidth: WIDGET_W,
    maxWidth: WIDGET_W,
    minHeight: WIDGET_H,
    maxHeight: WIDGET_H,
    hasShadow: IS_WINDOWS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  wireWindowDiagnostics(holdingWin, 'holding')
  holdingWin.setMenuBarVisibility(false)
  holdingWin.loadURL(appUrl('renderer/holding-widget.html'))

  holdingWin.webContents.on('did-finish-load', () => {
    refreshHoldingWidget()
    showHoldingWindow()
  })

  holdingWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      restoreMainWindow()
    }
  })

  if (mainWin && !mainWin.isDestroyed()) {
    const onMainClose = () => {
      if (holdingWin && !holdingWin.isDestroyed()) holdingWin.destroy()
    }
    mainWin.on('close', onMainClose)
    holdingWin.on('closed', () => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.removeListener('close', onMainClose)
      }
      removeTrayIcon()
      holdingWin = null
    })
  } else {
    holdingWin.on('closed', () => {
      removeTrayIcon()
      holdingWin = null
    })
  }

  return holdingWin
}

function restoreMainWindow() {
  if (holdingWin && !holdingWin.isDestroyed()) holdingWin.hide()
  if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
    mainWin.show()
    mainWin.focus()
  }
}

function showHoldingWindow() {
  if (!holdingWin || holdingWin.isDestroyed()) return
  removeTrayIcon()
  if (IS_WINDOWS) {
    holdingWin.showInactive()
    return
  }
  holdingWin.show()
  holdingWin.focus()
}

function minimizeHoldingWidget() {
  if (holdingWin && !holdingWin.isDestroyed()) {
    holdingWin.hide()
    lastHiddenWindow = 'holding'
    ensureTrayIcon()
  }
}

function closeHoldingWidget() {
  if (holdingWin && !holdingWin.isDestroyed()) holdingWin.hide()
  removeTrayIcon()
}

function showAppFromDock() {
  const hasVisibleWindow = BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible())
  if (hasVisibleWindow) return

  if (lastHiddenWindow === 'holding' && holdingWin && !holdingWin.isDestroyed()) {
    holdingWin.setBounds(getWidgetBounds())
    refreshHoldingWidget()
    showHoldingWindow()
    return
  }

  if (mainWin && !mainWin.isDestroyed()) {
    restoreMainWindow()
    return
  }

  createMainWindow()
}

function openHoldingWidget() {
  if (holdingWin && !holdingWin.isDestroyed()) {
    holdingWin.setBounds(getWidgetBounds())
    refreshHoldingWidget()
    if (!holdingWin.isVisible()) showHoldingWindow()
    else if (!IS_WINDOWS) holdingWin.focus()
  } else {
    createHoldingWidget()
  }

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.hide()
    lastHiddenWindow = 'main'
  }

  return { ok: true }
}

ipcMain.handle('open-holding-window', () => openHoldingWidget())
ipcMain.handle('minimize-holding-window', () => {
  minimizeHoldingWidget()
  return { ok: true }
})
ipcMain.handle('maximize-holding-window', () => {
  restoreMainWindow()
  return { ok: true }
})
ipcMain.handle('close-holding-window', () => {
  closeHoldingWidget()
  return { ok: true }
})

app.whenReady().then(() => {
  logLocalDataPaths('app-ready')
  registerConfigStorageIpc()
  registerLocalProtocol()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showAppFromDock()
  })
})

app.on('window-all-closed', () => {
  removeTrayIcon()
  if (process.platform !== 'darwin') app.quit()
})
