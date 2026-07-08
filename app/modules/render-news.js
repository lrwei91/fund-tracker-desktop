// ================================================================
// 财经新闻 — 金十快讯 / 东财资讯
// 暴露到 window.AppNews;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var KEYS = state.KEYS;

    // 用 DOMParser 解析外部新闻 HTML,只取纯文本,避免 innerHTML 执行 <img onerror> 等事件处理器(XSS)
    function stripHtmlTags(html) {
        if (!html) return '';
        try {
            var doc = new DOMParser().parseFromString(String(html), 'text/html');
            return doc.body ? (doc.body.textContent || '') : '';
        } catch (e) {
            // 解析失败兜底:去掉所有标签(不执行任何脚本)
            return String(html).replace(/<[^>]*>/g, '');
        }
    }

    function formatJin10Time(timeStr) {
        if (!timeStr) return '';
        var parts = timeStr.split(' ');
        if (parts.length < 2) return timeStr;
        var datePart = parts[0];
        var timePart = parts[1];
        var today = utils.getShanghaiDateKey();
        if (datePart === today) {
            return timePart.substring(0, 5);
        }
        return datePart.substring(5) + ' ' + timePart.substring(0, 5);
    }

    // ============================================================
    // 新闻源 tab (金十/东财)
    // ============================================================

    function initNewsSourceTabs() {
        if (!['jin10', 'eastmoney'].includes(state.currentNewsSource)) state.currentNewsSource = 'jin10';
        var tabs = document.querySelectorAll('.news-source-tab');
        tabs.forEach(function (tab) {
            tab.classList.toggle('active', tab.getAttribute('data-source') === state.currentNewsSource);
        });
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var parent = tab.parentElement;
                parent.querySelectorAll('.news-source-tab').forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                state.currentNewsSource = tab.getAttribute('data-source');
                try { localStorage.setItem(KEYS.NEWS_SOURCE_KEY, state.currentNewsSource); } catch (e) {}
                // 切换源:重置状态、清空列表、立刻展示"加载中..."
                resetNewsState(state.currentNewsSource);
                renderNewsList();
                loadNewsData();
            });
        });
    }

    function resetNewsState(source) {
        state.newsState[source] = { items: [], cursor: null, hasMore: true, isLoading: false, error: false };
    }

    // 滚动到底部时自动加载更多(用 sentinel + 距离阈值,避免频繁触发)
    var newsScrollHandler = null;
    function initNewsScroll() {
        if (newsScrollHandler) return;
        var ticking = false;
        newsScrollHandler = function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
                ticking = false;
                maybeLoadMoreNews();
            });
        };
        window.addEventListener('scroll', newsScrollHandler, { passive: true });
        window.addEventListener('resize', newsScrollHandler, { passive: true });
    }

    function maybeLoadMoreNews() {
        if (state.currentTab !== 'news') return;
        var s = state.newsState[state.currentNewsSource];
        if (!s || s.isLoading || !s.hasMore) return;
        // 距底部 400px 内即触发
        var threshold = 400;
        var scrolled = window.scrollY + window.innerHeight;
        var total = document.documentElement.scrollHeight;
        if (scrolled >= total - threshold) {
            loadNewsData();
        }
    }

    // ============================================================
    // 拉取 + 渲染
    // ============================================================

    async function loadNewsData() {
        var container = document.getElementById('news-list');
        if (!container) return;
        var s = state.newsState[state.currentNewsSource];
        if (!s || s.isLoading) return;
        if (s.items.length > 0 && !s.hasMore) return; // 已加载到底

        s.isLoading = true;
        renderNewsList();
        try {
            if (state.currentNewsSource === 'eastmoney') {
                await loadEastmoneyNews();
            } else {
                await loadJin10News();
            }
        } finally {
            s.isLoading = false;
            renderNewsList();
        }
    }

    async function loadJin10News() {
        var s = state.newsState.jin10;
        var query = { limit: String(KEYS.NEWS_PAGE_SIZE.jin10) };
        if (s.cursor) query.cursor = s.cursor;

        try {
            var res = await fetch(utils.apiUrl('/news', query));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var json = await res.json();
            if (!json.success) throw new Error(json.error || '数据异常');

            var payload = json.data || {};
            var rows = Array.isArray(payload.data) ? payload.data : [];
            if (rows.length) {
                s.items = s.items.concat(rows);
            }
            s.cursor = payload.nextCursor || null;
            s.hasMore = !!payload.hasMore && !!s.cursor;
            s.error = false;
        } catch (e) {
            console.error('金十快讯获取失败:', e);
            s.error = true;
        }
    }

    async function loadEastmoneyNews() {
        var s = state.newsState.eastmoney;
        var query = { limit: String(KEYS.NEWS_PAGE_SIZE.eastmoney) };
        if (s.cursor) query.cursor = s.cursor;

        try {
            var res = await fetch(utils.apiUrl('/global-news', query));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var json = await res.json();
            if (!json.success) throw new Error(json.error || '数据异常');

            var payload = json.data || {};
            var rows = Array.isArray(payload.data) ? payload.data : [];
            if (rows.length) {
                s.items = s.items.concat(rows);
            }
            s.cursor = payload.nextCursor || null;
            // 东财 fastNewsList 不支持分页,服务端 hasMore 始终会是 false,这里保留双保险
            s.hasMore = !!payload.hasMore && !!s.cursor;
            s.error = false;
        } catch (e) {
            console.error('东财资讯获取失败:', e);
            s.error = true;
        }
    }

    // 把当前 source 的 items 渲染到 DOM;不重新拉数据
    function renderNewsList() {
        var container = document.getElementById('news-list');
        if (!container) return;
        var s = state.newsState[state.currentNewsSource];
        if (!s) return;

        // 首屏加载:isLoading 且 items.length === 0,显示"加载中..."
        if (s.isLoading && s.items.length === 0) {
            container.innerHTML = '<div class="news-status news-loading">加载中...</div>';
            return;
        }

        // 加载出错且无内容
        if (s.error && s.items.length === 0) {
            container.innerHTML = '<div class="news-status news-error">' +
                utils.escapeHtml(state.currentNewsSource === 'eastmoney' ? '东财资讯加载失败' : '金十快讯加载失败') +
                '</div>';
            return;
        }

        // 完全空
        if (s.items.length === 0) {
            container.innerHTML = '<div class="news-status news-empty">' +
                utils.escapeHtml(state.currentNewsSource === 'eastmoney' ? '暂无东财资讯' : '暂无金十快讯') +
                '</div>';
            return;
        }

        // 正常:渲染瀑布流 + 底部 status
        var html = '';
        s.items.forEach(function (item) { html += renderNewsItem(item); });

        // 底部状态行
        if (s.isLoading) {
            html += '<div class="news-status news-loading">加载中...</div>';
        } else if (s.hasMore) {
            html += '<div class="news-status news-loadmore" id="news-loadmore-sentinel">上拉加载更多</div>';
        } else {
            html += '<div class="news-status news-loadend">已经到底了</div>';
        }
        container.innerHTML = html;
    }

    function renderNewsItem(item) {
        if (state.currentNewsSource === 'eastmoney') {
            var title = item.title || '';
            var summary = item.summary || '';
            var time = item.time || '';
            var html = '<div class="news-item">';
            html += '  <div class="news-header">';
            html += '    <span class="news-time">' + utils.escapeHtml(time) + '</span>';
            html += '  </div>';
            if (title) html += '  <div class="news-title">' + utils.escapeHtml(title) + '</div>';
            if (summary) html += '  <div class="news-summary">' + utils.escapeHtml(summary) + '</div>';
            html += '</div>';
            return html;
        }
        // jin10
        var content = item.data && item.data.content ? stripHtmlTags(item.data.content) : '';
        if (!content) return '';
        var jt = formatJin10Time(item.time);
        return '<div class="news-item">' +
            '  <div class="news-header">' +
            '    <span class="news-time">' + utils.escapeHtml(jt) + '</span>' +
            '  </div>' +
            '  <div class="news-summary">' + utils.escapeHtml(content) + '</div>' +
            '</div>';
    }

    window.AppNews = {
        initNewsSourceTabs: initNewsSourceTabs,
        initNewsScroll: initNewsScroll,
        resetNewsState: resetNewsState,
        maybeLoadMoreNews: maybeLoadMoreNews,
        loadNewsData: loadNewsData,
        loadJin10News: loadJin10News,
        loadEastmoneyNews: loadEastmoneyNews,
        renderNewsList: renderNewsList,
        renderNewsItem: renderNewsItem,
    };
})();