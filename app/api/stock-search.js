const { emGet, fail, ok } = require('./_utils');

module.exports = async function handler(req, res) {
    const query = String(req.query.q || '').trim();
    if (!query) return fail(res, 400, '缺少搜索关键词');

    try {
        const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}&type=14&token=44c9d251add88e27b65ed86506f6e5da&count=8`;
        const json = await emGet(url);
        const rows = json && json.QuotationCodeTable && json.QuotationCodeTable.Data;
        const data = (rows || [])
            .filter((row) => row && row.Code && row.Name && row.SecurityTypeName && row.SecurityTypeName.includes('A'))
            .map((row) => ({ code: row.Code, name: row.Name }))
            .filter((row) => /^\d{6}$/.test(row.code));
        return ok(res, data);
    } catch (error) {
        return fail(res, 502, '真实股票搜索接口不可用', { error: error.message });
    }
};
