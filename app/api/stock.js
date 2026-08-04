const { fail, fetchGbkText, ok, tencentSymbol, toNumber } = require('./_utils');

function formatTencentQuoteTime(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    return {
        raw,
        display: `${match[4]}:${match[5]}:${match[6]}`,
    };
}

module.exports = async function handler(req, res) {
    const rawCodes = String(req.query.codes || '');
    const codes = rawCodes.split(',').map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code));
    if (!codes.length) return fail(res, 400, '缺少股票代码');

    try {
        const symbols = codes.map(tencentSymbol).join(',');
        const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbols}`);
        const entries = text.split(';').filter(Boolean).map((rawLine) => {
            const line = rawLine.trim();
            const key = line.slice(2, line.indexOf('='));
            const code = key.slice(2);
            const data = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).split('~');
            if (!/^\d{6}$/.test(code) || data.length < 33) return [code, null];
            const price = toNumber(data[3]);
            const changePercent = toNumber(data[32]);
            const change = toNumber(data[31]);
            const quoteTime = formatTencentQuoteTime(data[30]);
            // 真实今日开盘价(腾讯接口 data[5])优先;若该字段缺失或异常,
            // fallback 到"基于昨收反推"——即忽略今日跳空,近似用昨收做基准
            let openPrice = toNumber(data[5]);
            if (openPrice === null || openPrice <= 0) {
                if (price !== null && changePercent !== null) {
                    const prevClose = price / (1 + changePercent / 100);
                    if (Number.isFinite(prevClose) && prevClose > 0) {
                        openPrice = Number(prevClose.toFixed(2));
                    }
                }
            }
            return [code, {
                code,
                name: data[1] || code,
                price: price === null ? '--' : price.toFixed(2),
                priceValue: price,
                change: change,
                changePercent: changePercent || 0,
                volume: data[36] || data[6] || '--',
                openPrice: openPrice,
                quoteTime: quoteTime ? quoteTime.display : '',
                quoteTimeRaw: quoteTime ? quoteTime.raw : '',
            }];
        });
        const data = {};
        const quoteTimes = [];
        entries.forEach(([code, quote]) => {
            if (quote) {
                data[code] = quote;
                if (quote.quoteTimeRaw) quoteTimes.push(quote.quoteTimeRaw);
            }
        });
        const requestTime = new Date().toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        quoteTimes.sort();
        const latestQuoteTime = quoteTimes.length
            ? formatTencentQuoteTime(quoteTimes[quoteTimes.length - 1])
            : null;
        return ok(res, data, {
            time: latestQuoteTime ? latestQuoteTime.display : requestTime,
            timeSource: latestQuoteTime ? 'quote' : 'request',
        });
    } catch (error) {
        return fail(res, 502, '真实股票行情接口不可用', { error: error.message });
    }
};
