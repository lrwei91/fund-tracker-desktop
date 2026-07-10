// 自选股 120 日资金流（接 push2 fflow/daykline/get）
// 取代项目"多日资金"卡片中"按当日数据假装多日"的旧实现
// 注意:此接口为个股维度(非行业板块),更符合"自选股用户最关心我关注的几只股最近资金动向"的价值
//   — 行业板块连续 N 日维度没有现成端点,行业多日需要 N×N 次拉取(不可行)

const { API_TIMEOUTS, emGet, fail, fetchGbkText, ok } = require('./_utils');

const MAX_CODES = 10;   // 单次最多 10 只,防并发打东财
const MAX_DAYS = 120;
const MIN_DAYS = 5;
const PER_REQUEST_SLEEP_MS = 200;  // 串行间隔,降低东财风控触发概率

function marketCode(code) {
    // 6/9 开头 → 沪市 (market=1);其它 → 深市/北市 (market=0)
    // 北市 (8/4 开头) 实测走 0 也工作,东财 secid 实际是 0/1 二元
    return (code.startsWith('6') || code.startsWith('9')) ? 1 : 0;
}

function tencentSymbol(code) {
    // 与 api/stock.js 同步:5/6/9 开头 → sh,否则 sz
    return `${/^(5|6|9)/.test(code) ? 'sh' : 'sz'}${code}`;
}

// 批量从腾讯 quote 拿名称(单次 HTTP 拿全,避免依赖前端缓存时机)
async function fetchNames(codes) {
    if (!codes.length) return {};
    const symbols = codes.map(tencentSymbol).join(',');
    let text;
    try {
        text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbols}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: API_TIMEOUTS.fast,
        });
    } catch (e) {
        // 名称拉取失败不影响主流程,fallback 到空 name,前端会用 code 兜底
        return {};
    }
    const map = {};
    text.split(';').filter(Boolean).forEach((rawLine) => {
        const line = rawLine.trim();
        const eq = line.indexOf('=');
        if (eq < 0) return;
        const key = line.slice(2, eq);
        const code = key.startsWith('sh') || key.startsWith('sz') ? key.slice(2) : key;
        const quoteMatch = line.match(/="([\s\S]+?)"/);
        if (!quoteMatch) return;
        const parts = quoteMatch[1].split('~');
        if (parts.length >= 2 && code && /^\d{6}$/.test(code)) {
            map[code] = parts[1];
        }
    });
    return map;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOneCode(code, days) {
    const secid = `${marketCode(code)}.${code}`;
    const params = new URLSearchParams({
        secid,
        klt: '101',          // 日级
        lmt: String(days),
        fields1: 'f1,f2,f3,f7',
        fields2: 'f51,f52,f53,f54,f55,f56,f57',  // date,main,small,mid,large,super,pct
    });
    // 注: push2his 是主力资金流稳定版,但2026-07起部分环境不可用
    // 尝试多个域名: push2his(主) → push2ex(备) → push2(备2)
    const endpoints = [
        `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${params.toString()}`,
        `https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?${params.toString()}`,
    ];
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: 'https://quote.eastmoney.com/',
    };
    for (const url of endpoints) {
        try {
            const json = await emGet(url, { headers, timeout: API_TIMEOUTS.push2 });
            const klines = json && json.data && Array.isArray(json.data.klines) ? json.data.klines : [];
            if (klines.length) return klines;
        } catch (_error) {}
    }
    // 所有端点均不可用 — 返回空数组,上层会跳过此股票
    return [];
}

function summarize(klines, code, name) {
    // push2 fflow/daykline 字段顺序(实测,2026-06 验证):
    //   parts[0] = date
    //   parts[1] = main_net   (主力 = 超大单+大单)
    //   parts[2] = small_net  (小单, <4万)
    //   parts[3] = mid_net    (中单, 4-20万)
    //   parts[4] = large_net  (大单, 20-100万)
    //   parts[5] = super_net  (超大单, ≥100万)
    //   parts[6] = pct        (涨跌幅%)
    // 数学验证 main ≈ large + super  (今天 6/26 茅台 -6.24亿 = -3.35亿 + -2.89亿 ✓)
    const recent = klines.map((line) => {
        const parts = line.split(',');
        return {
            date: parts[0] || '',
            mainNet: Number(parts[1]) || 0,
            smallNet: Number(parts[2]) || 0,
            midNet: Number(parts[3]) || 0,
            largeNet: Number(parts[4]) || 0,
            superNet: Number(parts[5]) || 0,
            pct: Number(parts[6]) || 0,
        };
    });
    const sumWindow = (key, window) => recent.slice(-Math.min(window, recent.length))
        .reduce((sum, r) => sum + (r[key] || 0), 0);
    const last = recent[recent.length - 1];
    return {
        code,
        name: name || '',
        recent: recent.slice(-10),  // 最近 10 日明细(渲染紧凑)
        summary: {
            main_5d: sumWindow('mainNet', 5),
            main_20d: sumWindow('mainNet', 20),
            main_60d: sumWindow('mainNet', 60),
            // 持仓股表格 "今日资金流" 用: 4 档当日拆分 (散户视角主力/大单/中单/小单)
            // 注意: 主力 = parts[1] (已含超大+大); 大单 parts[4]; 中单 parts[3]; 小单 parts[2]
            today: last ? {
                main:   last.mainNet   || 0,
                large:  last.largeNet  || 0,
                medium: last.midNet    || 0,
                small:  last.smallNet  || 0,
            } : null,
        },
        latestDate: last ? last.date : null,
    };
}

module.exports = async function handler(req, res) {
    try {
        const codesRaw = String(req.query.codes || '').split(',')
            .map((s) => s.trim())
            .filter((s) => /^\d{6}$/.test(s));
        if (!codesRaw.length) return fail(res, 400, '缺少股票代码');
        const codes = codesRaw.slice(0, MAX_CODES);
        const days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, parseInt(req.query.days, 10) || 60));

        // 先拉一次腾讯 quote 拿名称(1 次 HTTP,失败 fallback 到空 name)
        const nameMap = await fetchNames(codes);
        // 串行拉取(东财绝不开并发,防封铁律)
        const items = [];
        for (const code of codes) {
            try {
                const klines = await fetchOneCode(code, days);
                items.push(summarize(klines, code, nameMap[code]));
            } catch (error) {
                items.push({ code, name: nameMap[code] || '', error: error.message, recent: [], summary: null });
            }
            if (codes.length > 1) await sleep(PER_REQUEST_SLEEP_MS);
        }
        return ok(res, { days, count: items.length, items });
    } catch (error) {
        return fail(res, 502, '真实 120 日资金流接口不可用', { error: error.message });
    }
};
