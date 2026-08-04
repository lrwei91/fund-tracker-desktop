function createWindowManager(options) {
  const {
    BrowserWindow, Menu, screen, Tray, nativeImage, ipcMain,
    appUrl, isWindows, onClearAndQuit, preloadPath,
  } = options
  const WIDGET_W = 320
  const WIDGET_H = 58
  const WIDGET_MARGIN = 20
  const TASKBAR_TICKER_W = 260
  const TASKBAR_SYSTEM_AREA_MIN_W = 300
  const mainChrome = process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 14 } }
    : {}
  let mainWin = null
  let holdingWin = null
  let taskbarWin = null
  let tray = null
  let lastHiddenWindow = 'main'
  let taskbarTickerEnabled = true

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
  function taskbarBounds() {
    const display = mainWin && !mainWin.isDestroyed()
      ? screen.getDisplayMatching(mainWin.getBounds())
      : screen.getPrimaryDisplay()
    const area = display.workArea
    const full = display.bounds
    const topGap = area.y - full.y
    const bottomGap = (full.y + full.height) - (area.y + area.height)
    const horizontalTaskbarHeight = Math.max(topGap, bottomGap)
    if (horizontalTaskbarHeight > 0) {
      const systemAreaWidth = Math.min(
        Math.max(TASKBAR_SYSTEM_AREA_MIN_W, Math.round(area.width * 0.22)),
        Math.floor(area.width / 3),
      )
      const width = Math.min(TASKBAR_TICKER_W, Math.max(160, area.width - systemAreaWidth))
      return {
        x: area.x + area.width - width - systemAreaWidth,
        y: topGap > bottomGap ? full.y : area.y + area.height,
        width,
        height: Math.max(32, Math.min(WIDGET_H, horizontalTaskbarHeight)),
      }
    }
    return { x: area.x + area.width - TASKBAR_TICKER_W - WIDGET_MARGIN, y: area.y + area.height - 40, width: TASKBAR_TICKER_W, height: 40 }
  }
  function refreshQuoteWindows() {
    if (holdingWin && !holdingWin.isDestroyed()) holdingWin.webContents.send('holding-widget-refresh')
    if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.webContents.send('holding-widget-refresh')
  }
  function createTaskbarTicker() {
    if (!isWindows || !taskbarTickerEnabled || (taskbarWin && !taskbarWin.isDestroyed())) return taskbarWin
    taskbarWin = new BrowserWindow({
      ...taskbarBounds(), title: '恭喜发财任务栏行情', frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, hasShadow: false,
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    diagnostics(taskbarWin, 'taskbar-ticker')
    taskbarWin.setMenuBarVisibility(false)
    taskbarWin.setAlwaysOnTop(true, 'screen-saver')
    taskbarWin.setIgnoreMouseEvents(true)
    taskbarWin.loadURL(`${appUrl('renderer/holding-widget.html')}?mode=taskbar`)
    taskbarWin.webContents.on('did-finish-load', () => {
      if (!taskbarWin || taskbarWin.isDestroyed()) return
      taskbarWin.webContents.send('holding-widget-refresh')
      taskbarWin.showInactive()
    })
    taskbarWin.on('closed', () => { taskbarWin = null })
    return taskbarWin
  }
  function setTaskbarTickerEnabled(enabled) {
    taskbarTickerEnabled = enabled !== false
    if (taskbarTickerEnabled) createTaskbarTicker()
    else if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.destroy()
    return { ok: true, enabled: taskbarTickerEnabled }
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
      if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.destroy()
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
    ipcMain.handle('set-taskbar-ticker-enabled', (_event, enabled) => setTaskbarTickerEnabled(enabled))
  }

  return { createMainWindow, registerIpc, removeTrayIcon, showAppFromDock }
}

module.exports = { createWindowManager }
