// 拆分回归冒烟:用 jsdom 以浏览器加载顺序装配 state/utils/cache + watchlist/* + 门面,
// 校验 window.AppWatchlist 公开 API 与原 render-watchlist.js 完全一致(57 个方法),
// 并跑通无需网络的几条主流程(标签页 / 列表渲染 / 自选指数渲染 / 弹窗初始化)。
// 运行: node scripts/smoke-watchlist.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const MODULES_DIR = path.join(ROOT, 'app', 'modules');

function assertIndexScriptsExist() {
    const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    const scripts = Array.from(indexHtml.matchAll(/<script\s+src="([^"]+)"/g)).map((match) => match[1]);
    const missing = scripts.filter((src) => !fs.existsSync(path.join(APP_DIR, src)));
    if (missing.length) {
        console.error('FAIL: index.html 引用了不存在的脚本 ->', missing);
        process.exit(1);
    }
    console.log('OK: index.html 脚本引用均存在,共', scripts.length, '个');
}

const html = `<!DOCTYPE html><html><body>
  <div id="watchlist-grid"></div>
  <div id="watchlist-update-time"></div>
  <div class="watchlist-header-row"></div>
  <div id="watchlist-tabs"></div>
  <div id="custom-index-grid"></div>
  <div id="custom-index-update-time"></div>
  <form id="custom-index-add-form" hidden>
    <input id="custom-index-input" />
    <button type="submit">添加</button>
    <button type="button" id="custom-index-add-cancel">取消</button>
  </form>
  <input id="stock-code-input" />
  <button id="add-stock-btn"></button>
  <div id="stock-fund-panel" hidden></div>
  <div id="stock-fund-overlay" hidden></div>
  <div id="stock-fund-body"></div>
  <div id="stock-fund-title"></div>
  <div id="stock-fund-close"></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
const { window } = dom;

// 无网络环境:fetch 一律失败,走各模块 catch 分支(渲染空缓存,不抛错)
window.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
window.prompt = () => null;
window.confirm = () => true;
window.AppAlerts = { showStatusToast() {}, saveWatchAlertState() {}, checkAlerts() {} };
window.AppStorage = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
};
window.AppMarket = {
    trendArrow: () => '─',
    readIndexPrevBucket: () => ({ data: {} }),
    persistIndexPrevIfDue() {},
    snapshotIndexPrice() { return {}; },
    setIndexPrevForCode() {},
    clearIndexPrevForCode() {},
};

function load(rel) {
    const code = fs.readFileSync(path.join(MODULES_DIR, rel), 'utf8');
    const s = window.document.createElement('script');
    s.textContent = code;
    window.document.body.appendChild(s);
}

assertIndexScriptsExist();

// 基础全局:state → utils → cache(与 index.html 顺序一致)
['state.js', 'utils.js', 'cache.js'].forEach(load);

const watchlistFiles = [
    'watchlist/_shared.js',
    'watchlist/watch-state.js',
    'watchlist/watch-tabs-ui.js',
    'watchlist/watch-io.js',
    'watchlist/watch-render.js',
    'watchlist/stock-detail.js',
    'watchlist/stock-fundflow.js',
    'watchlist/custom-index.js',
    'watchlist/watchlist.js',
];
watchlistFiles.forEach(load);

// 与原 render-watchlist.js 公开 API 逐方法对齐
const expected = [
    'isFixedWatchTab', 'getWatchTabs', 'saveWatchTabs', 'getActiveWatchTab', 'getWatchlist', 'saveActiveWatchlist',
    'initWatchlistTabs', 'renderWatchTabs', 'switchWatchTab', 'initWatchTabScroller', 'addWatchTab', 'removeWatchTab',
    'exportWatchlistData', 'importWatchlistData',
    'resolveStockInput', 'addStockToWatchlist', 'removeStockFromWatchlist', 'getAllWatchCodes', 'getHoldingCodes', 'isHoldingTab',
    'loadWatchlistData', 'loadSingleWatchQuote', 'renderWatchlist', 'renderWatchItem', 'renderCostCell', 'saveWatchlistCost',
    'getDisplayStockName', 'saveWatchlistRemarks', 'persistWatchQuoteCache', 'persistWatchQuoteUpdateTime',
    'persistCurrentChangePct', 'getPrevChangePct', 'bindWatchRemove', 'bindWatchItemClick',
    'showStockFundFlow', 'renderStockCostEditor', 'saveStockCostFromForm', 'renderStockFundFlowBody',
    'closeStockFundFlow', 'initStockFundFlowModal',
    'renderCustomIndex', 'renderCustomIndexItem', 'bindCustomIndexRemove', 'bindCustomIndexAdd', 'bindCustomIndexAddForm',
    'openCustomIndexAddForm', 'closeCustomIndexAddForm', 'addCustomIndexByInput', 'removeCustomIndex', 'loadCustomIndexData', 'loadSingleCustomIndex',
    'saveCustomIndices', 'persistCustomIndexCache', 'persistCustomIndexUpdateTime',
    'refreshStaleWatchQuotes', 'refreshStaleCustomIndex',
    'showWatchStatus', 'showCustomIndexStatus', 'showDataStatus',
];

const api = window.AppWatchlist;
if (!api) {
    console.error('FAIL: window.AppWatchlist 未定义');
    process.exit(1);
}
const missing = expected.filter((n) => typeof api[n] !== 'function');
const extra = Object.keys(api).filter((n) => expected.indexOf(n) === -1);
if (missing.length) {
    console.error('FAIL: 缺失方法 ->', missing);
    process.exit(1);
}
if (extra.length) {
    console.error('WARN: 多出未登记方法 ->', extra);
}
console.log('OK: window.AppWatchlist 公开方法齐全,共', expected.length, '个');

// 跑通无需网络的几条主流程
try {
    api.getWatchTabs();
    api.renderWatchTabs();
    api.renderWatchlist();
    api.renderCustomIndex();
    api.initWatchlistTabs();
    api.initStockFundFlowModal();
    api.renderStockFundFlowBody({ code: '600000', recent: [] }, null, null, null, { includeEditor: false });
    console.log('OK: 核心主流程(标签/列表/自选指数/弹窗初始化/资金流空态)执行无异常');

    window.AppState.watchQuoteCache['159915'] = {
        name: '创业板ETF', price: '2.35', priceValue: 2.3456, changePercent: 1,
    };
    const watchEtfHtml = api.renderWatchItem('159915', '创业板ETF', '2.35', 1, '--', undefined, false);
    if (!watchEtfHtml.includes('>2.346</div>')) throw new Error('自选股 ETF 价格未保留三位');

    window.AppState.customIndexCodes = ['510300'];
    window.AppState.customIndexCache = {
        '510300': { name: '沪深300ETF', price: '1.23', priceValue: 1.2349, changePercent: 1, change: 0.01 },
    };
    api.renderCustomIndex();
    const customIndexPrice = window.document.querySelector('#custom-index-grid .index-value');
    if (!customIndexPrice || !customIndexPrice.textContent.startsWith('1.235')) {
        throw new Error('自选指数 ETF 价格未保留三位');
    }
    api.closeCustomIndexAddForm();
    api.openCustomIndexAddForm();
    const customIndexAddForm = window.document.getElementById('custom-index-add-form');
    if (!customIndexAddForm || customIndexAddForm.hidden) throw new Error('自选指数添加表单未打开');
    api.closeCustomIndexAddForm();
    console.log('OK: 自选股/自选指数 ETF 价格均保留三位');
} catch (e) {
    console.error('FAIL: 主流程抛错 ->', e && e.stack ? e.stack : e);
    process.exit(1);
}

console.log('\nSMOKE PASSED ✓');
