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
        showStockAlert: function (alert) { return invoke('show_stock_alert', { alert: alert }); },
        isWindows: navigator.userAgent.indexOf('Windows') >= 0,
        getConfigPath: function () { return invoke('config_storage_path'); },
        openExternalUrl: function (url) { return invoke('open_external_url', { url: url }); },
        configStorage: {
            load: function () { return invoke('config_storage_load'); },
            patch: function (changes) { return invoke('config_storage_patch', { changes: changes || {} }); },
        },
        onHoldingWidgetRefresh: function (callback) { return subscribe('holding-widget-refresh', callback); },
        onStockAlert: function (callback) { return subscribe('stock-alert', callback); },
    };
})();
