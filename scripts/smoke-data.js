// 可选真实数据 smoke。默认跳过，显式 RUN_LIVE_DATA=1 npm run smoke:data 才执行。
if (process.env.RUN_LIVE_DATA !== '1') {
  console.log('SKIP: set RUN_LIVE_DATA=1 to run live data smoke')
  process.exit(0)
}

const targets = [
  { name: 'cls', handler: require('../app/api/cls-news'), query: { limit: '3' }, validate: (body) => body.data && body.data.data.length > 0 },
  { name: 'dragon', handler: require('../app/api/dragon-tiger'), query: {}, validate: (body) => body.data && body.data.stocks.length > 0 },
  { name: 'fund', handler: require('../app/api/fund-flow-120d'), query: { codes: '600519', days: '60' }, validate: (body) => body.data && body.data.items[0] && body.data.items[0].available },
  { name: 'capital', handler: require('../app/api/market-data'), query: { type: 'capital' }, validate: (body) => body.data && body.data.northboundDaily && body.data.northboundDaily.available },
  { name: 'risk', handler: require('../app/api/stock-risk'), query: { code: '000858', limit: '3' }, validate: (body) => body.data && body.data.announcements && body.data.announcements.items.length > 0 },
  { name: 'index', handler: require('../app/api/market-data'), query: { type: 'index' }, validate: (body) => body.data && Object.values(body.data).every((item) => item.sparkline.length > 0) },
]

function memoryResponse() {
  const chunks = []
  return {
    statusCode: 200,
    setHeader() {},
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(String(chunk))) },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) },
  }
}

async function main() {
  const results = await Promise.all(targets.map(async (target) => {
    const response = memoryResponse()
    const started = Date.now()
    await target.handler({ query: target.query }, response)
    const body = response.json()
    return { name: target.name, ok: body.success === true && target.validate(body), ms: Date.now() - started, error: body.error || body.message || '' }
  }))
  results.forEach((result) => console.log(`${result.ok ? 'OK' : 'FAIL'}: ${result.name} ${result.ms}ms${result.error ? ` ${result.error}` : ''}`))
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
