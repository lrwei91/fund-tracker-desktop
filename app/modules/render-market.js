// ================================================================
// 市场行情 — 大盘指数 / 资金流 / 板块
// 暴露到 window.AppMarket;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var KEYS = state.KEYS;

    // ============================================================
    // 大盘指数 prev 快照 helpers (半小时对比箭头基准)
    // 结构:{ market: { _updatedAt, data: { id: priceValue } }, custom: 同上 }
    // ============================================================

    function getIndexPrevPct() {
        try {
            var raw = JSON.parse(localStorage.getItem(KEYS.INDEX_PREV_KEY));
            if (raw && typeof raw === 'object') return raw;
        } catch (e) { /* ignore */ }
        return { market: { _updatedAt: 0, data: {} }, custom: { _updatedAt: 0, data: {} } };
    }

    function readIndexPrevBucket(bucket) {
        var cur = getIndexPrevPct();
        var b = cur[bucket];
        if (!b || typeof b !== 'object') return { _updatedAt: 0, data: {} };
        return {
            _updatedAt: typeof b._updatedAt === 'number' ? b._updatedAt : 0,
            data: b.data && typeof b.data === 'object' ? b.data : {},
        };
    }

    // 仅当距上次落盘 ≥ INDEX_REFRESH_SECONDS 秒时,才把 currentMap 写入 bucket.data 并刷新 _updatedAt
    function persistIndexPrevIfDue(bucket, currentMap, now) {
        var bucketObj = readIndexPrevBucket(bucket);
        var nowMs = typeof now === 'number' ? now : Date.now();
        var due = (nowMs - bucketObj._updatedAt) >= KEYS.INDEX_REFRESH_SECONDS * 1000;
        if (!due) return false;
        var cleanData = {};
        Object.keys(currentMap || {}).forEach(function (k) {
            var v = currentMap[k];
            if (typeof v === 'number' && Number.isFinite(v)) cleanData[k] = v;
        });
        var cur = getIndexPrevPct();
        cur[bucket] = { _updatedAt: nowMs, data: cleanData };
        try { localStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
        return true;
    }

    // 单点写入 prev(新增自选指数时立刻给一个 prev,让首渲染箭头 = self-vs-self = '─')
    function setIndexPrevForCode(bucket, code, pct) {
        if (typeof pct !== 'number' || !Number.isFinite(pct)) return;
        var cur = getIndexPrevPct();
        var b = readIndexPrevBucket(bucket);
        b.data[code] = pct;
        // 单点写入不动 _updatedAt,避免污染节流基准
        cur[bucket] = b;
        try { localStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
    }

    // 移除自选指数时同步清掉 prev,避免幽灵 prev
    function clearIndexPrevForCode(bucket, code) {
        var cur = getIndexPrevPct();
        var b = readIndexPrevBucket(bucket);
        if (Object.prototype.hasOwnProperty.call(b.data, code)) {
            delete b.data[code];
            cur[bucket] = b;
            try { localStorage.setItem(KEYS.INDEX_PREV_KEY, JSON.stringify(cur)); } catch (e) {}
        }
    }

    // 半小时对比箭头
    function trendArrow(current, prev) {
        if (prev === undefined || prev === null) return '─';
        if (current > prev) return '▲';
        if (current < prev) return '▼';
        return '─';
    }

    // 抽出 { key: priceValue } 快照,trend-arrow 用价格本身做对比基准
    function snapshotIndexPrice(data) {
        var out = {};
        if (!data || typeof data !== 'object') return out;
        Object.keys(data).forEach(function (id) {
            var d = data[id];
            if (d && typeof d.priceValue === 'number' && Number.isFinite(d.priceValue)) {
                out[id] = d.priceValue;
            }
        });
        return out;
    }

    // ============================================================
    // 大盘指数 — UI 更新
    // ============================================================

    function formatSignedPct(value) {
        var number = Number(value);
        if (!Number.isFinite(number)) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function sparklinePath(values, width, height, pad) {
        var min = Math.min.apply(Math, values);
        var max = Math.max.apply(Math, values);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            min -= Math.max(0.01, Math.abs(min) * 0.001);
            max += Math.max(0.01, Math.abs(max) * 0.001);
        }
        return values.map(function (value, index) {
            var x = pad + index / Math.max(1, values.length - 1) * (width - pad * 2);
            var y = pad + (max - value) / (max - min) * (height - pad * 2);
            return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
        }).join(' ');
    }

    function buildIndexSparklineValues(data, prev) {
        var current = typeof data.priceValue === 'number' ? data.priceValue : null;
        if (!Number.isFinite(current)) return [];
        var pct = typeof data.changePercent === 'number' ? data.changePercent : 0;
        var start = typeof prev === 'number' && Number.isFinite(prev) && prev > 0
            ? prev
            : current / (1 + pct / 100 || 1);
        if (!Number.isFinite(start) || start <= 0) start = current;
        var seed = String(data.name || '').split('').reduce(function (sum, ch) { return sum + ch.charCodeAt(0); }, 0);
        var values = [];
        for (var i = 0; i < 18; i++) {
            var t = i / 17;
            var wave = Math.sin((seed % 7 + 1) * t * Math.PI) * 0.0018;
            var zig = ((seed + i * 11) % 9 - 4) * 0.00045;
            values.push(start + (current - start) * t + current * (wave + zig));
        }
        values[values.length - 1] = current;
        return values;
    }

    function renderIndexSparkline(container, data, cls, prev) {
        var spark = container.querySelector('.index-sparkline');
        if (!spark) {
            spark = document.createElement('div');
            spark.className = 'index-sparkline';
            container.appendChild(spark);
        }
        var values = buildIndexSparklineValues(data, prev);
        if (!values.length) {
            spark.innerHTML = '';
            return;
        }
        var path = sparklinePath(values, 74, 28, 3);
        spark.className = 'index-sparkline ' + cls;
        spark.innerHTML = '<svg viewBox="0 0 74 28" aria-hidden="true" focusable="false">' +
            '<path d="' + path + '"></path>' +
            '</svg>';
    }

    function updateIndexUI(id, data) {
        if (!data) return;
        var item = document.querySelector('[data-index="' + id + '"]');
        var v = document.getElementById(id + '-value');
        var c = document.getElementById(id + '-change');
        var n = item ? item.querySelector('.index-name') : null;
        if (!v || !c) return;
        v.textContent = data.value;
        c.textContent = formatSignedPct(data.changePercent);
        c.title = data.change || c.textContent;
        if (n && data.name) n.textContent = data.name;
        v.className = 'index-value';
        c.className = 'index-change';
        var cls = data.changePercent > 0 ? 'positive' : data.changePercent < 0 ? 'negative' : 'neutral';
        if (item) item.classList.remove('positive', 'negative', 'neutral');
        if (item) item.classList.add(cls);
        v.classList.add(cls);
        c.classList.add(cls);
        // 半小时对比箭头:跟价格绑定,内部读 prev 价格快照
        var prev = readIndexPrevBucket('market').data[id];
        var arrow = trendArrow(
            typeof data.priceValue === 'number' ? data.priceValue : null,
            typeof prev === 'number' ? prev : null
        );
        var existing = v.querySelector('.trend-arrow');
        if (existing) existing.remove();
        if (arrow) {
            var span = document.createElement('span');
            span.className = 'trend-arrow';
            span.textContent = arrow;
            v.appendChild(span);
        }
        if (item) renderIndexSparkline(item, data, cls, prev);
    }

    // ============================================================
    // loadIndexData / loadCapitalData / loadSectorData
    // ============================================================

    async function loadIndexData(force) {
        var cached = force ? null : cache.readTimedCache(KEYS.SHORT_CACHE_KEYS.index, KEYS.SHORT_CACHE_TTL.index);
        if (cached) {
            state.liveIndexData = cached;
            Object.keys(cached).forEach(function (id) { updateIndexUI(id, cached[id]); });
            var meta = cache.readJson(KEYS.SHORT_CACHE_KEYS.index, null);
            if (meta && meta.updatedAt) {
                utils.setLastUpdated('行情已更新', utils.formatShanghaiTime(meta.updatedAt));
            }
            return;
        }

        try {
            var res = await fetch(utils.apiUrl('/market-data', { type: 'index' }));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            state.liveIndexData = result.data;
            cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.index, result.data);
            Object.keys(result.data).forEach(function (id) { updateIndexUI(id, result.data[id]); });
            // 节流落盘:刷新节奏不变,只决定 prev 落盘的节奏
            persistIndexPrevIfDue('market', snapshotIndexPrice(result.data));
            utils.setLastUpdated('行情已更新');
        } catch (e) {
            if (!state.liveIndexData) utils.setLastUpdated('行情获取失败');
        }
    }

    async function loadCapitalData(force) {
        var newData = null;
        var cached = force ? null : cache.readTimedCache(KEYS.SHORT_CACHE_KEYS.capital, KEYS.SHORT_CACHE_TTL.capital);
        if (cached) {
            newData = cached;
        }

        try {
            if (!newData) {
                var res = await fetch(utils.apiUrl('/market-data', { type: 'capital' }));
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var result = await res.json();
                if (result.success && result.data && result.data.mainFund && result.data.mainFund.value !== undefined) {
                    newData = result.data;
                    cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.capital, result.data);
                }
            }
        } catch (e) {
            newData = cached || null;
        }

        if (newData) {
            state.liveCapitalData = newData;
        }

        if (!state.liveCapitalData) return;
        renderCapitalUI(state.liveCapitalData);
    }

    async function loadSectorData(force) {
        var newData = null;
        var cached = force ? null : cache.readTimedCache(KEYS.SHORT_CACHE_KEYS.sector, KEYS.SHORT_CACHE_TTL.sector);
        if (cached) {
            newData = cached;
        }

        try {
            if (!newData) {
                var res = await fetch(utils.apiUrl('/market-data', { type: 'sector' }));
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var result = await res.json();
                if (result.success && result.data && result.data.inflow) {
                    newData = result.data;
                    cache.writeTimedCache(KEYS.SHORT_CACHE_KEYS.sector, result.data);
                }
            }
        } catch (e) {
            newData = cached || null;
        }

        if (newData) {
            state.liveSectorData = newData;
        }

        if (!state.liveSectorData) return;
        renderSectorUI(state.liveSectorData);
    }

    // ============================================================
    // 资金流 / 板块 UI 渲染
    // ============================================================

    // 6 格子: 资金 4 档 (主力/大单/中单/小单) + 北向 2 通道 (沪股通/深股通)
    function renderCapitalUI(cap) {
        var cells = [
            { id: 'main-fund-value', data: cap.mainFund },
            { id: 'large-value',     data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.large },
            { id: 'medium-value',    data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.medium },
            { id: 'small-value',     data: cap.mainFund && cap.mainFund.breakdown && cap.mainFund.breakdown.small },
            { id: 'north-hgt-value', data: cap.northHgt },
            { id: 'north-sgt-value', data: cap.northSgt },
        ];
        cells.forEach(function (cell) {
            var el = document.getElementById(cell.id);
            if (!el) return;
            el.textContent = cell.data && cell.data.value ? cell.data.value : '--';
            el.className = 'capital-value';
            if (cell.data && typeof cell.data.isPositive === 'boolean') {
                el.classList.add(cell.data.isPositive ? 'positive' : 'negative');
            }
        });
    }

    function renderSectorUI(sectors) {
        var inflowEl = document.getElementById('sector-bars-inflow');
        var outflowEl = document.getElementById('sector-bars-outflow');
        if (!inflowEl || !outflowEl) return;

        var inflowList = (sectors.inflow || []).slice(0, 5);
        var outflowList = (sectors.outflow || []).slice(0, 5);
        var maxAbs = 1;
        inflowList.forEach(function (s) { if (s.mainFundYuan > maxAbs) maxAbs = s.mainFundYuan; });
        outflowList.forEach(function (s) { if (Math.abs(s.mainFundYuan) > maxAbs) maxAbs = Math.abs(s.mainFundYuan); });

        function pctOf(s) {
            return (Math.abs(s.mainFundYuan || 0) / maxAbs * 100).toFixed(1);
        }
        function pctClass(v) { return v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral'; }
        function changeStr(c) {
            if (typeof c !== 'number' || !c) return '';
            return (c > 0 ? '+' : '') + c.toFixed(2) + '%';
        }

        function renderBars(items, sign) {
            if (!items.length) return '<div class="list-empty">暂无' + (sign > 0 ? '流入' : '流出') + '数据</div>';
            return items.map(function (s) {
                var w = pctOf(s);
                var cls = pctClass(s.changePct);
                return '<div class="sector-bar-row">' +
                    '<div class="sector-bar-name">' +
                        '<span class="sector-bar-label">' + utils.escapeHtml(s.name) + '</span>' +
                        '<span class="sector-bar-change ' + cls + '">' + utils.escapeHtml(changeStr(s.changePct)) + '</span>' +
                    '</div>' +
                    '<div class="sector-bar-track">' +
                        '<div class="sector-bar-fill ' + (sign > 0 ? 'positive' : 'negative') + '" data-w="' + w + '"></div>' +
                    '</div>' +
                    '<div class="sector-bar-value ' + (sign > 0 ? 'positive' : 'negative') + '">' + utils.escapeHtml(s.value) + '</div>' +
                    '<div class="sector-bar-leader">' + utils.escapeHtml(s.leader || '') + '</div>' +
                '</div>';
            }).join('');
        }

        inflowEl.innerHTML = renderBars(inflowList, 1);
        outflowEl.innerHTML = renderBars(outflowList, -1);
        // 渲染后批量把 data-w 转成实际宽度(避免在 HTML 字符串里写 inline style,
        // 通过 setProperty 写入动态宽度，避免拼接内联样式字符串。
        [inflowEl, outflowEl].forEach(function (container) {
            var fills = container.querySelectorAll('.sector-bar-fill[data-w]');
            fills.forEach(function (fill) {
                fill.style.width = fill.getAttribute('data-w') + '%';
            });
        });
    }

    window.AppMarket = {
        // prev 快照
        getIndexPrevPct: getIndexPrevPct,
        readIndexPrevBucket: readIndexPrevBucket,
        persistIndexPrevIfDue: persistIndexPrevIfDue,
        setIndexPrevForCode: setIndexPrevForCode,
        clearIndexPrevForCode: clearIndexPrevForCode,
        trendArrow: trendArrow,
        snapshotIndexPrice: snapshotIndexPrice,
        // 指数 UI / load
        updateIndexUI: updateIndexUI,
        loadIndexData: loadIndexData,
        // 资金 / 板块
        loadCapitalData: loadCapitalData,
        loadSectorData: loadSectorData,
        renderCapitalUI: renderCapitalUI,
        renderSectorUI: renderSectorUI,
    };
})();
