(function () {
    var tauri = window.__TAURI__;
    if (!tauri || !tauri.core || !tauri.event) return;
    var invoke = tauri.core.invoke;
    var listen = tauri.event.listen;

    function subscribe(event, callback) {
        var disposed = false;
        var unlisten = null;
        listen(event, function (message) {
            if (!disposed && typeof callback === 'function') callback(message.payload);
        }).then(function (fn) {
            if (disposed) fn();
            else unlisten = fn;
        });
        return function () {
            disposed = true;
            if (unlisten) unlisten();
        };
    }

    window.shell = {
        openHoldingWindow: function () { return invoke('open_holding_window'); },
        minimizeHoldingWindow: function () { return invoke('minimize_holding_window'); },
        maximizeHoldingWindow: function () { return invoke('maximize_holding_window'); },
        closeHoldingWindow: function () { return invoke('close_holding_window'); },
        syncHoldingWidget: function (state) { return invoke('holding_widget_sync', { state: state || {} }); },
        showStockAlert: function (alert) { return invoke('show_stock_alert', { alert: alert }); },
        aiSettingsStatus: function () { return invoke('ai_settings_status'); },
        updateStatus: function () { return invoke('update_status'); },
        updateCheck: function () { return invoke('update_check'); },
        updateDownload: function () { return invoke('update_download'); },
        updateInstall: function () { return invoke('update_install'); },
        updatePreferences: function (automatic) { return invoke('update_preferences', { automatic: !!automatic }); },
        onUpdateState: function (callback) { return subscribe('app-update-state', callback); },
        aiSettingsSave: function (options, apiKey, clearKey) { return invoke('ai_settings_save', { options: options, apiKey: apiKey || null, clearKey: !!clearKey }); },
        onPriceAlertHit: function (callback) { return subscribe('price-alert-hit', callback); },
        onPriceAlertError: function (callback) { return subscribe('price-alert-error', callback); },
        isWindows: navigator.userAgent.indexOf('Windows') >= 0,
        getConfigPath: function () { return invoke('config_storage_path'); },
        openExternalUrl: function (url) { return invoke('open_external_url', { url: url }); },
        configStorage: {
            load: function () { return invoke('config_storage_load'); },
            patch: function (changes) { return invoke('config_storage_patch', { changes: changes || {} }); },
        },
        onHoldingWidgetRefresh: function (callback) { return subscribe('holding-widget-refresh', callback); },
        onHoldingWidgetState: function (callback) { return subscribe('holding-widget-state', callback); },
        onHoldingWidgetVisibility: function (callback) { return subscribe('holding-widget-visibility', callback); },
        onStockAlert: function (callback) { return subscribe('stock-alert', callback); },
    };
})();
