// 财经新闻：金十 / 财联社 / 东方财富。分页与刷新最新分离。
(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var KEYS = state.KEYS;
    var SOURCES = {
        jin10: { label: '金十快讯', path: '/news' },
        cls: { label: '财联社', path: '/cls-news' },
        eastmoney: { label: '东财资讯', path: '/global-news' },
    };

    function stripHtmlTags(html) {
        if (!html) return '';
        try {
            var doc = new DOMParser().parseFromString(String(html), 'text/html');
            return doc.body ? (doc.body.textContent || '') : '';
        } catch (e) {
            return String(html).replace(/<[^>]*>/g, '');
        }
    }

    function formatNewsTime(timeStr) {
        if (!timeStr) return '';
        var parts = String(timeStr).split(' ');
        if (parts.length < 2) return String(timeStr);
        return parts[0] === utils.getShanghaiDateKey()
            ? parts[1].substring(0, 5)
            : parts[0].substring(5) + ' ' + parts[1].substring(0, 5);
    }

    function emptyNewsState(source) {
        return { items: [], cursor: null, hasMore: true, isLoading: false, error: false, actualSource: source, degraded: false };
    }

    function initNewsSourceTabs() {
        if (!Object.prototype.hasOwnProperty.call(SOURCES, state.currentNewsSource)) state.currentNewsSource = 'jin10';
        document.querySelectorAll('.news-source-tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.getAttribute('data-source') === state.currentNewsSource);
            tab.addEventListener('click', function () {
                tab.parentElement.querySelectorAll('.news-source-tab').forEach(function (item) { item.classList.remove('active'); });
                tab.classList.add('active');
                state.currentNewsSource = tab.getAttribute('data-source');
                try { window.AppStorage.setItem(KEYS.NEWS_SOURCE_KEY, state.currentNewsSource); } catch (e) {}
                if (!state.newsState[state.currentNewsSource]) resetNewsState(state.currentNewsSource);
                renderNewsList();
                if (!state.newsState[state.currentNewsSource].items.length) loadMoreNews();
            });
        });
    }

    function resetNewsState(source) {
        state.newsState[source] = emptyNewsState(source);
    }

    var newsScrollHandler = null;
    function initNewsScroll() {
        if (newsScrollHandler) return;
        var ticking = false;
        newsScrollHandler = function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () { ticking = false; maybeLoadMoreNews(); });
        };
        window.addEventListener('scroll', newsScrollHandler, { passive: true });
        window.addEventListener('resize', newsScrollHandler, { passive: true });
    }

    function maybeLoadMoreNews() {
        if (state.currentTab !== 'news') return;
        var current = state.newsState[state.currentNewsSource];
        if (!current || current.isLoading || !current.hasMore) return;
        if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 400) loadMoreNews();
    }

    function normalizeRow(source, item) {
        if (source === 'jin10') {
            return {
                id: String(item.id || ''),
                title: '',
                summary: stripHtmlTags(item.data && item.data.content),
                time: item.time || '',
                url: item.url || '',
            };
        }
        return {
            id: String(item.id || item.url || ''),
            title: item.title || '',
            summary: item.summary || '',
            time: item.time || '',
            url: item.url || '',
        };
    }

    function itemKey(item) {
        return item.id || [item.time, item.title, item.summary].join('|');
    }

    function mergeUnique(first, second) {
        var seen = {};
        return first.concat(second).filter(function (item) {
            var key = itemKey(item);
            if (!key || seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    async function requestPage(source, cursor) {
        var config = SOURCES[source];
        var query = { limit: String(KEYS.NEWS_PAGE_SIZE[source]) };
        if (cursor) query.cursor = cursor;
        var res = await window.AppDataClient.fetch(config.path, query, { force: !cursor });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success) throw new Error(json.message || '数据异常');
        var payload = json.data || {};
        return {
            actualSource: payload.source || source,
            degraded: !!(json.meta && json.meta.degraded),
            rows: (Array.isArray(payload.data) ? payload.data : []).map(function (item) { return normalizeRow(source, item); }),
            cursor: payload.nextCursor || null,
            hasMore: !!payload.hasMore && !!payload.nextCursor,
        };
    }

    async function loadMoreNews() {
        var source = state.currentNewsSource;
        var current = state.newsState[source];
        if (!current || current.isLoading || (current.items.length && !current.hasMore)) return;
        current.isLoading = true;
        renderNewsList();
        try {
            var page = await requestPage(source, current.cursor);
            current.items = mergeUnique(current.items, page.rows);
            current.cursor = page.cursor;
            current.hasMore = page.hasMore;
            current.actualSource = page.actualSource;
            current.degraded = page.degraded;
            current.error = false;
        } catch (error) {
            console.error(SOURCES[source].label + '获取失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            renderNewsList();
        }
    }

    async function refreshNewsData() {
        var source = state.currentNewsSource;
        var current = state.newsState[source];
        if (!current || current.isLoading) return;
        if (!current.items.length) return loadMoreNews();
        current.isLoading = true;
        try {
            var page = await requestPage(source, null);
            current.items = mergeUnique(page.rows, current.items);
            current.actualSource = page.actualSource;
            current.degraded = page.degraded;
            current.error = false;
        } catch (error) {
            console.error(SOURCES[source].label + '刷新失败:', error);
            current.error = true;
        } finally {
            current.isLoading = false;
            renderNewsList();
        }
    }

    function actualSourceLabel(source) {
        return SOURCES[source] ? SOURCES[source].label : source;
    }

    function renderNewsList() {
        var container = document.getElementById('news-list');
        if (!container) return;
        var current = state.newsState[state.currentNewsSource];
        if (!current) return;
        if (current.isLoading && !current.items.length) {
            container.innerHTML = '<div class="news-status news-loading">加载中...</div>';
            return;
        }
        if (current.error && !current.items.length) {
            container.innerHTML = '<div class="news-status news-error">' + utils.escapeHtml(SOURCES[state.currentNewsSource].label + '加载失败') + '</div>';
            return;
        }
        if (!current.items.length) {
            container.innerHTML = '<div class="news-status news-empty">暂无' + utils.escapeHtml(SOURCES[state.currentNewsSource].label) + '</div>';
            return;
        }
        var sourceStatus = '<div class="news-actual-source' + (current.degraded ? ' degraded' : '') + '">' +
            utils.escapeHtml(current.degraded ? '已降级至 ' + actualSourceLabel(current.actualSource) : '当前来源 ' + actualSourceLabel(current.actualSource)) + '</div>';
        var html = sourceStatus + current.items.map(renderNewsItem).join('');
        if (current.isLoading) html += '<div class="news-status news-loading">刷新中...</div>';
        else if (current.hasMore) html += '<div class="news-status news-loadmore">上拉加载更多</div>';
        else html += '<div class="news-status news-loadend">已经到底了</div>';
        container.innerHTML = html;
    }

    function renderNewsItem(item) {
        if (!item.title && !item.summary) return '';
        return '<div class="news-item">' +
            '<div class="news-header"><span class="news-time">' + utils.escapeHtml(formatNewsTime(item.time)) + '</span></div>' +
            (item.title ? '<div class="news-title">' + utils.escapeHtml(item.title) + '</div>' : '') +
            (item.summary ? '<div class="news-summary">' + utils.escapeHtml(item.summary) + '</div>' : '') +
            '</div>';
    }

    window.AppNews = {
        initNewsSourceTabs: initNewsSourceTabs,
        initNewsScroll: initNewsScroll,
        loadNewsData: loadMoreNews,
        loadMoreNews: loadMoreNews,
        mergeUnique: mergeUnique,
        maybeLoadMoreNews: maybeLoadMoreNews,
        refreshNewsData: refreshNewsData,
        renderNewsItem: renderNewsItem,
        renderNewsList: renderNewsList,
        resetNewsState: resetNewsState,
    };
})();
