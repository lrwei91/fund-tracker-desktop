// Local UI sample. Uses synthetic holdings and existing route fixtures; no real
// credentials, user config, network data or model requests. Run: node scripts/preview-workbench.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/fixtures/routes.json'), 'utf8'));
const quotes = {
    '600519': { code: '600519', name: '贵州茅台', price: '1452.00', priceValue: 1452, change: 18, changePercent: 1.26, quoteTimeRaw: '20261020150000', openPrice: 1438 },
    '300750': { code: '300750', name: '宁德时代', price: '264.80', priceValue: 264.8, change: -3.2, changePercent: -1.19, quoteTimeRaw: '20261020150000', openPrice: 268 },
    '510300': { code: '510300', name: '沪深300ETF', price: '4.218', priceValue: 4.218, change: .032, changePercent: .76, quoteTimeRaw: '20261020150000', openPrice: 4.19 },
    '920982': { code: '920982', name: '锦波生物', price: '176.00', priceValue: 176, change: 2, changePercent: 1.15, quoteTimeRaw: '20261020150000', openPrice: 174 },
};
const cost = { '600519': { cost: 1380, shares: 100 }, '300750': { cost: 280, shares: 500 }, '510300': { cost: 4, shares: 10000 } };
const config = { fund_tracker_watchlist_tabs: [{ id: 'default', name: '持仓股', codes: ['600519', '300750', '510300'] }, { id: 'candidate', name: '候选股', codes: ['920982'] }], fund_tracker_watchlist_cost: cost, fund_tracker_settings: { autoRefresh: false }, fund_tracker_custom_indices: [] };
const sampleReport = { id: 'preview-report', tradeDate: '2026-10-20', slot: 'afterClose', status: 'partial', automatic: true, read: false, createdAt: '2026-10-20T07:30:00Z', finishedAt: '2026-10-20T07:31:00Z', model: '界面样本 · 未调用模型', message: '样本报告，展示部分资料覆盖状态', facts: { expectedQuoteDate: '2026-10-20', portfolio: { marketValue: 319780, unrealizedPnl: 1780, holdingCount: 3, valueCount: 3, pnlCount: 3 }, snapshots: [{ code: '600519', name: '贵州茅台' }], excluded: [{ code: '510300', reason: '场内 ETF 仅计入统计，未深研' }] }, report: { summary: '这是用于界面验收的合成样本。实际报告会展示资料时点、覆盖范围与组合风险。', portfolioRisks: ['可用持仓存在集中度，需要结合原始资料核对。'], watchConditions: ['核对最新公告与行情日期。'], limitations: ['样本数据，不代表真实研究。'], stocks: [{ code: '600519', score: 60, summary: '样本说明，不构成投资判断。', bull: [{ text: '仅展示证据布局', source: 'quote' }], bear: [], watchConditions: ['观察资料变化'], invalidConditions: ['基础资料失效'] }] } };
function bridge() {
    return `(() => {
        const fixtures = ${JSON.stringify(fixtures)}, quotes = ${JSON.stringify(quotes)}, data = ${JSON.stringify(config)}, report = ${JSON.stringify(sampleReport)};
        window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args = {}) => {
            if (command === 'config_storage_load') return { version: 2, data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, JSON.stringify(v)])) };
            if (command === 'config_storage_patch') return { ok: true };
            if (command === 'ai_settings_status') return { configured: false, settings: null };
            if (command === 'update_status') return { status: 'idle', currentVersion: '1.0.12', automatic: false };
            if (command !== 'fetch_data') return { ok: true };
            const route = args.path.replace(/^\\//, ''), q = args.query || {};
            if (route === 'stock') return { success: true, data: quotes, time: '15:00:00', meta: { stale: false, degraded: false } };
            if (route === 'research-reports') {
                if (q.op === 'get') return { success: true, data: report };
                if (q.op && q.op !== 'read') return { success: false, message: '界面样本：任务和模型调用已禁用' };
                return { success: true, data: { settings: { premarket: false, afterClose: false }, items: [report], calendarKnown: true } };
            }
            if (route === 'stock-ai-research' && q.mode !== 'history') return { success: false, message: '界面样本：模型调用已禁用' };
            return fixtures[route] || { success: false, message: '界面样本未提供此数据' };
        } } };
        document.title = '恭喜发财 · 合成数据界面验收';
    })();`;
}
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (url.pathname === '/preview-bridge.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bridge()); return; }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, 'app', '.' + relative);
    if (!file.startsWith(path.join(root, 'app') + path.sep)) { res.writeHead(403).end(); return; }
    try {
        let body = fs.readFileSync(file);
        if (file.endsWith('/index.html')) body = body.toString().replace('<script src="tauri-shell.js">', '<script src="/preview-bridge.js"></script><script src="tauri-shell.js">');
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
        res.end(body);
    } catch { res.writeHead(404).end(); }
});
server.listen(47431, '127.0.0.1', () => console.log('Synthetic UI preview: http://127.0.0.1:47431 (model calls disabled)'));
