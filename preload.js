const { contextBridge, ipcRenderer } = require('electron')

// 暴露给本地 renderer 的安全桌面 API。
contextBridge.exposeInMainWorld('shell', {
    openHoldingWindow: () => ipcRenderer.invoke('open-holding-window'),
    minimizeHoldingWindow: () => ipcRenderer.invoke('minimize-holding-window'),
    maximizeHoldingWindow: () => ipcRenderer.invoke('maximize-holding-window'),
    closeHoldingWindow: () => ipcRenderer.invoke('close-holding-window'),
    showStockAlert: (alert) => ipcRenderer.invoke('show-stock-alert', alert),
    isWindows: process.platform === 'win32',
    getConfigPath: () => ipcRenderer.invoke('config-storage-path'),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    configStorage: {
        load: () => ipcRenderer.invoke('config-storage-load'),
        patch: (changes) => ipcRenderer.invoke('config-storage-patch', changes || {}),
    },
    onHoldingWidgetRefresh: (callback) => {
        if (typeof callback !== 'function') return () => {}
        const listener = () => callback()
        ipcRenderer.on('holding-widget-refresh', listener)
        return () => ipcRenderer.removeListener('holding-widget-refresh', listener)
    },
    onStockAlert: (callback) => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, alert) => callback(alert)
        ipcRenderer.on('stock-alert', listener)
        return () => ipcRenderer.removeListener('stock-alert', listener)
    },
})
