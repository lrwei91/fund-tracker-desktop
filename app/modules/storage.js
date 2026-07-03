// ================================================================
// 用户配置存储 shim
// 关键用户数据写入 Electron config.json;行情/新闻等临时缓存仍走 localStorage。
// 暴露到 window.AppStorage,并拦截 localStorage 的 get/set/remove。
// ================================================================

(function () {
    var CONFIG_KEYS = [
        'fund_tracker_settings',
        'fund_tracker_active_main_tab',
        'fund_tracker_news_source',
        'fund_tracker_collapse_state',
        'fund_tracker_sector_tab',
        'fund_tracker_alert_settings',
        'fund_tracker_watch_alert_state',
        'fund_tracker_custom_indices',
        'fund_tracker_watchlist_cost',
        'fund_tracker_watchlist_remarks',
        'fund_tracker_watchlist',
        'fund_tracker_watchlist_tabs',
        'fund_tracker_active_watch_tab',
        'fund_tracker_hot_rank_source',
        'fund_tracker_limit_up_tab',
        'fund_tracker_holding_clown_mode',
    ];
    var CONFIG_KEY_MAP = {};
    CONFIG_KEYS.forEach(function (key) { CONFIG_KEY_MAP[key] = true; });

    var nativeGetItem = Storage.prototype.getItem;
    var nativeSetItem = Storage.prototype.setItem;
    var nativeRemoveItem = Storage.prototype.removeItem;
    var shellStorage = window.shell && window.shell.configStorage;

    function isConfigKey(key) {
        return !!CONFIG_KEY_MAP[String(key)];
    }

    function readConfigItem(key) {
        if (!shellStorage || typeof shellStorage.getItem !== 'function') return null;
        try {
            return shellStorage.getItem(String(key));
        } catch (e) {
            return null;
        }
    }

    function writeConfigItem(key, value) {
        if (!shellStorage || typeof shellStorage.setItem !== 'function') return false;
        try {
            return !!shellStorage.setItem(String(key), String(value));
        } catch (e) {
            return false;
        }
    }

    function removeConfigItem(key) {
        if (!shellStorage || typeof shellStorage.removeItem !== 'function') return false;
        try {
            return !!shellStorage.removeItem(String(key));
        } catch (e) {
            return false;
        }
    }

    function migrateConfigKey(key) {
        if (!shellStorage || !isConfigKey(key)) return;
        if (readConfigItem(key) !== null) return;
        var oldValue = nativeGetItem.call(localStorage, key);
        if (oldValue !== null) writeConfigItem(key, oldValue);
    }

    function migrateConfigKeys() {
        CONFIG_KEYS.forEach(migrateConfigKey);
    }

    if (shellStorage) {
        migrateConfigKeys();
        Storage.prototype.getItem = function (key) {
            if (this === localStorage && isConfigKey(key)) {
                var configValue = readConfigItem(key);
                if (configValue !== null) return configValue;
            }
            return nativeGetItem.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
            if (this === localStorage && isConfigKey(key)) {
                writeConfigItem(key, value);
            }
            return nativeSetItem.call(this, key, value);
        };
        Storage.prototype.removeItem = function (key) {
            if (this === localStorage && isConfigKey(key)) {
                removeConfigItem(key);
            }
            return nativeRemoveItem.call(this, key);
        };
    }

    window.AppStorage = {
        isConfigKey: isConfigKey,
        migrateConfigKeys: migrateConfigKeys,
        getConfigPath: function () {
            return window.shell && typeof window.shell.getConfigPath === 'function'
                ? window.shell.getConfigPath()
                : Promise.resolve(null);
        },
    };
})();
