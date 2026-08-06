function createWindowManager(options) {
  const {
    BrowserWindow, Menu, screen, Tray, nativeImage, ipcMain,
    appUrl, isWindows, onClearAndQuit, preloadPath,
  } = options
  const WIDGET_W = 320
  const WIDGET_H = 58
  const WIDGET_MARGIN = 20
  const ALERT_W = 420
  const ALERT_H = 116
  const ALERT_MARGIN_TOP = 24
  const ALERT_TTL_MS = 6000
  const mainChrome = process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 14 } }
    : {}
  let mainWin = null
  let holdingWin = null
  let alertWin = null
  let alertReady = false
  let pendingAlert = null
  let alertHideTimer = null
  let tray = null
  let lastHiddenWindow = 'main'

  function diagnostics(win, name) {
    win.webContents.on('render-process-gone', (_event, details) => console.error('[fund-tracker] renderer gone', { name, details }))
    win.webContents.on('unresponsive', () => console.error('[fund-tracker] window unresponsive', { name }))
  }

  function trayIcon() {
    const size = 16
    const bitmap = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1
      const mark = (x >= 4 && x <= 11 && y >= 4 && y <= 5) || (x >= 4 && x <= 6 && y >= 4 && y <= 11)
        || (x >= 4 && x <= 11 && y >= 10 && y <= 11) || (x >= 9 && x <= 11 && y >= 8 && y <= 11)
      bitmap[i] = border ? 0x00 : (mark ? 0x00 : 0x08)
      bitmap[i + 1] = border ? 0x00 : (mark ? 0xab : 0x06)
      bitmap[i + 2] = border ? 0x00 : (mark ? 0xff : 0x05)
      bitmap[i + 3] = 0xff
    }
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
  }

  function removeTrayIcon() { if (tray) { tray.destroy(); tray = null } }
  function bounds() {
    const source = mainWin && !mainWin.isDestroyed() ? mainWin : BrowserWindow.getFocusedWindow()
    const display = source ? screen.getDisplayMatching(source.getBounds()) : screen.getPrimaryDisplay()
    return { x: display.workArea.x + display.workArea.width - WIDGET_W - WIDGET_MARGIN, y: display.workArea.y + display.workArea.height - WIDGET_H - WIDGET_MARGIN, width: WIDGET_W, height: WIDGET_H }
  }
  function alertBounds() {
    const display = mainWin && !mainWin.isDestroyed()
      ? screen.getDisplayMatching(mainWin.getBounds())
      : screen.getPrimaryDisplay()
    const area = display.workArea
    return {
      x: area.x + Math.round((area.width - ALERT_W) / 2),
      y: area.y + ALERT_MARGIN_TOP,
      width: ALERT_W,
      height: ALERT_H,
    }
  }
  function normalizeAlert(rawAlert) {
    if (!rawAlert || typeof rawAlert !== 'object') return null
    const price = Number(rawAlert.price)
    const changePct = Number(rawAlert.changePct)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct)) return null
    const optionalNumber = (value) => {
      const number = Number(value)
      return Number.isFinite(number) && number > 0 ? number : null
    }
    return {
      code: String(rawAlert.code || '').slice(0, 32),
      name: String(rawAlert.name || rawAlert.code || '自选股').slice(0, 80),
      price,
      openPrice: optionalNumber(rawAlert.openPrice),
      changePct,
      basePrice: optionalNumber(rawAlert.basePrice),
      baseLabel: String(rawAlert.baseLabel || '基准').slice(0, 16),
      threshold: optionalNumber(rawAlert.threshold),
      time: typeof rawAlert.time === 'string' ? rawAlert.time : new Date().toISOString(),
      opacity: Math.max(0.2, Math.min(1, Number(rawAlert.opacity) || 1)),
      soundEnabled: rawAlert.soundEnabled !== false,
    }
  }
  function displayPendingAlert() {
    if (!alertReady || !pendingAlert || !alertWin || alertWin.isDestroyed()) return
    const alert = pendingAlert
    pendingAlert = null
    alertWin.setBounds(alertBounds())
    alertWin.webContents.send('stock-alert', alert)
    alertWin.showInactive()
    if (alertHideTimer) clearTimeout(alertHideTimer)
    alertHideTimer = setTimeout(() => {
      alertHideTimer = null
      if (alertWin && !alertWin.isDestroyed()) alertWin.hide()
    }, ALERT_TTL_MS)
  }
  function createAlertWindow() {
    if (alertWin && !alertWin.isDestroyed()) return alertWin
    alertReady = false
    alertWin = new BrowserWindow({
      ...alertBounds(), title: '自选股涨跌提醒', frame: false, transparent: true,
      backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, show: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, hasShadow: false,
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    diagnostics(alertWin, 'stock-alert')
    alertWin.setMenuBarVisibility(false)
    alertWin.setAlwaysOnTop(true, 'screen-saver')
    alertWin.setIgnoreMouseEvents(true)
    alertWin.loadURL(appUrl('renderer/alert-popup.html'))
    alertWin.webContents.on('did-finish-load', () => {
      alertReady = true
      displayPendingAlert()
    })
    alertWin.on('closed', () => {
      if (alertHideTimer) clearTimeout(alertHideTimer)
      alertHideTimer = null
      alertReady = false
      alertWin = null
    })
    return alertWin
  }
  function showStockAlert(rawAlert) {
    const alert = normalizeAlert(rawAlert)
    if (!alert) return { ok: false, error: 'Invalid alert payload' }
    pendingAlert = alert
    createAlertWindow()
    displayPendingAlert()
    return { ok: true }
  }
  function refreshQuoteWindows() {
    if (holdingWin && !holdingWin.isDestroyed()) holdingWin.webContents.send('holding-widget-refresh')
  }
  function showHoldingWindow() {
    if (!holdingWin || holdingWin.isDestroyed()) return
    removeTrayIcon()
    if (isWindows) holdingWin.showInactive()
    else { holdingWin.show(); holdingWin.focus() }
  }
  function restoreMainWindow() {
    if (holdingWin && !holdingWin.isDestroyed()) holdingWin.hide()
    removeTrayIcon()
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore()
      if (!mainWin.isVisible()) mainWin.show()
      mainWin.focus()
    }
  }
  function restoreHoldingFromTray() {
    removeTrayIcon()
    if (holdingWin && !holdingWin.isDestroyed()) { holdingWin.setBounds(bounds()); refreshQuoteWindows(); showHoldingWindow() }
    else createHoldingWidget()
  }
  function restoreFromTray() {
    if (lastHiddenWindow === 'holding') restoreHoldingFromTray()
    else restoreMainWindow()
  }
  function ensureTrayIcon() {
    if (!isWindows || tray) return
    tray = new Tray(trayIcon())
    tray.setToolTip('恭喜发财')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: lastHiddenWindow === 'holding' ? '显示持仓浮窗' : '显示主窗口', click: restoreFromTray },
      { label: '退出并清除本地数据', click: () => onClearAndQuit('windows-tray-quit') },
    ]))
    tray.on('click', restoreFromTray)
    tray.on('double-click', restoreFromTray)
  }

  function createMainWindow() {
    mainWin = new BrowserWindow({
      width: 592, height: 820, minWidth: 540, minHeight: 680, title: '恭喜发财', backgroundColor: '#050608', ...mainChrome,
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    diagnostics(mainWin, 'main')
    mainWin.loadURL(appUrl('index.html'))
    Menu.setApplicationMenu(null)
    mainWin.on('minimize', () => {
      lastHiddenWindow = 'main'
      if (isWindows) ensureTrayIcon()
    })
    mainWin.on('closed', () => {
      if (alertWin && !alertWin.isDestroyed()) alertWin.destroy()
      mainWin = null
    })
    return mainWin
  }

  function createHoldingWidget() {
    if (holdingWin && !holdingWin.isDestroyed()) return holdingWin
    holdingWin = new BrowserWindow({
      ...bounds(), title: '持仓库', frame: false, transparent: !isWindows, backgroundColor: isWindows ? '#050608' : '#00000000',
      alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: !isWindows, minWidth: WIDGET_W, maxWidth: WIDGET_W, minHeight: WIDGET_H,
      maxHeight: WIDGET_H, hasShadow: isWindows,
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    diagnostics(holdingWin, 'holding')
    holdingWin.setMenuBarVisibility(false)
    holdingWin.loadURL(appUrl('renderer/holding-widget.html'))
    holdingWin.webContents.on('did-finish-load', () => { refreshQuoteWindows(); showHoldingWindow() })
    holdingWin.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') restoreMainWindow() })
    const onMainClose = () => { if (holdingWin && !holdingWin.isDestroyed()) holdingWin.destroy() }
    if (mainWin && !mainWin.isDestroyed()) mainWin.on('close', onMainClose)
    holdingWin.on('closed', () => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.removeListener('close', onMainClose)
      removeTrayIcon(); holdingWin = null
    })
    return holdingWin
  }

  function openHoldingWidget() {
    if (holdingWin && !holdingWin.isDestroyed()) {
      holdingWin.setBounds(bounds()); refreshQuoteWindows()
      if (!holdingWin.isVisible()) showHoldingWindow()
      else if (!isWindows) holdingWin.focus()
    } else createHoldingWidget()
    if (mainWin && !mainWin.isDestroyed()) { mainWin.hide(); lastHiddenWindow = 'main' }
    return { ok: true }
  }
  function minimizeHoldingWidget() { if (holdingWin && !holdingWin.isDestroyed()) { holdingWin.hide(); lastHiddenWindow = 'holding'; ensureTrayIcon() } }
  function closeHoldingWidget() { if (holdingWin && !holdingWin.isDestroyed()) holdingWin.hide(); removeTrayIcon() }
  function showAppFromDock() {
    if ((mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized())
      || (holdingWin && !holdingWin.isDestroyed() && holdingWin.isVisible())) return
    if (lastHiddenWindow === 'holding' && holdingWin && !holdingWin.isDestroyed()) { holdingWin.setBounds(bounds()); refreshQuoteWindows(); showHoldingWindow(); return }
    if (mainWin && !mainWin.isDestroyed()) { restoreMainWindow(); return }
    createMainWindow()
  }
  function registerIpc() {
    ipcMain.handle('open-holding-window', () => openHoldingWidget())
    ipcMain.handle('minimize-holding-window', () => { minimizeHoldingWidget(); return { ok: true } })
    ipcMain.handle('maximize-holding-window', () => { restoreMainWindow(); return { ok: true } })
    ipcMain.handle('close-holding-window', () => { closeHoldingWidget(); return { ok: true } })
    ipcMain.handle('show-stock-alert', (_event, alert) => showStockAlert(alert))
  }

  return { createMainWindow, registerIpc, removeTrayIcon, showAppFromDock }
}

module.exports = { createWindowManager }
