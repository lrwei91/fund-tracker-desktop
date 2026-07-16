const { contextBridge, ipcRenderer } = require('electron')

// 暴露给本地 renderer 的安全桌面 API。
contextBridge.exposeInMainWorld('shell', {
    openHoldingWindow: () => ipcRenderer.invoke('open-holding-window'),
    minimizeHoldingWindow: () => ipcRenderer.invoke('minimize-holding-window'),
    maximizeHoldingWindow: () => ipcRenderer.invoke('maximize-holding-window'),
    closeHoldingWindow: () => ipcRenderer.invoke('close-holding-window'),
    setTaskbarTickerEnabled: (enabled) => ipcRenderer.invoke('set-taskbar-ticker-enabled', enabled !== false),
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
})
