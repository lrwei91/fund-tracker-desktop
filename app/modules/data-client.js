// Renderer-side request coalescer. Each caller gets its own response-like view.
(function () {
    var inflight = {};

    function AppDataError(message, details) {
        Error.call(this, message);
        this.name = 'AppDataError';
        this.message = message || '数据接口不可用';
        details = details || {};
        this.route = details.route || '';
        this.code = details.code || 'upstream_error';
        this.retryable = details.retryable !== false;
        this.status = details.status == null ? null : details.status;
        this.payload = details.payload || null;
        if (Error.captureStackTrace) Error.captureStackTrace(this, AppDataError);
    }
    AppDataError.prototype = Object.create(Error.prototype);
    AppDataError.prototype.constructor = AppDataError;

    function stableKey(path, params) {
        var query = new URLSearchParams(params || {});
        return path + '?' + Array.from(query.entries()).sort(function (a, b) {
            return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
        }).map(function (entry) { return entry[0] + '=' + entry[1]; }).join('&');
    }

    function normalizeFailure(path, data) {
        var details = data && typeof data === 'object' ? data : {};
        var code = details.errorCode || (details.meta && details.meta.errorCode) || 'upstream_error';
        var message = details.message || details.error || '数据接口不可用';
        return new AppDataError(message, {
            route: path,
            code: code,
            retryable: details.retryable,
            status: details.status,
            payload: data,
        });
    }

    function fetchData(path, params, options) {
        var key = stableKey(path, params);
        var force = options && options.force;
        if (!force && inflight[key]) return inflight[key];
        var tauri = window.__TAURI__;
        if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
            return Promise.reject(new AppDataError('桌面数据通道不可用', {
                route: path,
                code: 'bridge_unavailable',
                retryable: false,
            }));
        }
        var work = Promise.resolve().then(function () {
            return tauri.core.invoke('fetch_data', {
                path: path,
                query: Object.fromEntries(new URLSearchParams(params || {}).entries()),
            });
        }).then(function (data) {
            if (!data || data.success === false) throw normalizeFailure(path, data);
            return data;
        }).catch(function (error) {
            if (error instanceof AppDataError) throw error;
            throw new AppDataError(error && error.message ? error.message : '数据接口不可用', {
                route: path,
                code: 'bridge_error',
                payload: error,
            });
        });
        inflight[key] = work;
        return work.finally(function () {
            if (inflight[key] === work) delete inflight[key];
        });
    }

    function fetchResponse(path, params, options) {
        return fetchData(path, params, options).then(function (data) {
            return { ok: true, status: 200, json: function () { return Promise.resolve(data); } };
        });
    }

    window.AppDataClient = {
        AppDataError: AppDataError,
        fetch: fetchResponse,
        fetchData: fetchData,
        key: stableKey,
        normalizeFailure: normalizeFailure,
    };
})();
