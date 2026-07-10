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
        var url = window.AppUtils.apiUrl(path, params);
        var work = window.fetch(url).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
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
