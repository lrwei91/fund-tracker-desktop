// Durable config facade. App modules call this instead of monkey-patching Storage.
(function () {
    var schema = window.AppConfigSchema || { keys: [] };
    var durable = new Set(schema.keys || []);
    var pending = {};
    var flushTimer = null;
    var nativeStorage = window.localStorage;

    function getItem(key) { return nativeStorage.getItem(String(key)); }
    function setItem(key, value) {
        var normalized = String(value);
        nativeStorage.setItem(String(key), normalized);
        if (durable.has(String(key))) schedulePatch(String(key), normalized);
    }
    function removeItem(key) {
        nativeStorage.removeItem(String(key));
        if (durable.has(String(key))) schedulePatch(String(key), null);
    }
    function schedulePatch(key, value) {
        pending[key] = value;
        if (flushTimer) return;
        flushTimer = setTimeout(flush, 150);
    }
    function flush() {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        var changes = pending;
        pending = {};
        var payload = changes;
        if (!window.shell || !window.shell.configStorage || typeof window.shell.configStorage.patch !== 'function') {
            return Promise.resolve();
        }
        return window.shell.configStorage.patch(payload).catch(function (error) {
            console.warn('[fund-tracker] config write failed', error && error.message ? error.message : error);
        });
    }
    function hydrate() {
        if (!window.shell || !window.shell.configStorage || typeof window.shell.configStorage.load !== 'function') {
            return Promise.resolve();
        }
        return window.shell.configStorage.load().then(function (snapshot) {
            var data = snapshot && snapshot.data ? snapshot.data : {};
            Object.keys(data).forEach(function (key) {
                if (durable.has(key) && data[key] !== null) nativeStorage.setItem(key, String(data[key]));
            });
            var migration = {};
            durable.forEach(function (key) {
                if (!Object.prototype.hasOwnProperty.call(data, key) && nativeStorage.getItem(key) !== null) {
                    migration[key] = nativeStorage.getItem(key);
                }
            });
            if (Object.keys(migration).length) return window.shell.configStorage.patch(migration);
        }).catch(function (error) {
            console.warn('[fund-tracker] config load failed', error && error.message ? error.message : error);
        });
    }

    window.AppStorage = { flush: flush, getConfigPath: function () {
        return window.shell && typeof window.shell.getConfigPath === 'function' ? window.shell.getConfigPath() : Promise.resolve(null);
    }, getItem: getItem, hydrate: hydrate, removeItem: removeItem, setItem: setItem };
    window.addEventListener('beforeunload', function () { flush(); });
})();
