// Renderer-side request coalescer. Each caller gets its own response-like view.
(function () {
    var inflight = {};

    function stableKey(path, params) {
        var query = new URLSearchParams(params || {});
        return path + '?' + Array.from(query.entries()).sort(function (a, b) {
            return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
        }).map(function (entry) { return entry[0] + '=' + entry[1]; }).join('&');
    }

    function fetchData(path, params, options) {
        var key = stableKey(path, params);
        var force = options && options.force;
        if (!force && inflight[key]) return inflight[key];
        var work = window.__TAURI__.core.invoke('fetch_data', {
            path: path,
            query: Object.fromEntries(new URLSearchParams(params || {}).entries()),
        }).then(function (data) {
            if (!data || data.success === false) {
                var error = new Error(data && (data.message || data.error) || '数据接口不可用');
                error.payload = data;
                throw error;
            }
            return data;
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

    window.AppDataClient = { fetch: fetchResponse, fetchData: fetchData, key: stableKey };
})();
