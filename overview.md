# API 数据源排查与修复报告

## 问题：分时加载 HTTP 502

分时数据 (`stock-minute.js`) 走两条路：
1. **tdxrs CLI** → `tdxrs` 未安装，所有候选链都失败
2. **东方财富 push2his** → `push2his.eastmoney.com` 空回复

两条路都走不通 → 最终返回 502。

## 修复方案

### 1. 安装 tdxrs（通达信直连工具）
```bash
pip3 install tdxrs==0.6.5
```
已安装成功，`python3 -m tdxrs` 路径在候选链中可直接使用。9/10 服务器连通，平均延迟 206ms。

### 2. 新增腾讯分时 API fallback
在 tdxrs 和东财之间插入腾讯分钟 API (`web.ifzq.gtimg.cn/appstock/app/minute/query`)，已验证返回完整分钟数据。

### 3. 全面排查所有 API 数据源

| 数据源 | 状态 | 所属API | 修复 |
|--------|------|---------|------|
| push2his.eastmoney.com | ❌ 空回复 | minute, kline, fund-flow | 已替换/加 fallback |
| push2.eastmoney.com | ❌ 空回复 | market-data, fund-flow | 已降级/加 fallback |
| flash-api.jin10.com | ❌ HTTP 502 | news | 已加东财 fallback |
| data.hexin.cn | ❌ Nginx Forbidden | market-data(北向) | 已降级 |
| tdxrs (通达信) | ✅ 已安装 | minute, kline | 新装为首选源 |
| 腾讯 qt.gtimg.cn | ✅ | stock, kline, market-data | 已有 fallback |
| push2ex.eastmoney.com | ✅ | limit-up | 正常 |
| np-weblist.eastmoney.com | ✅ | news(新), global-news | 新闻 fallback |
| datacenter-web.eastmoney.com | ✅ | dragon-tiger | 正常 |

### 修改的文件
- `app/api/stock-minute.js` — tdxrs 候选链 + 腾讯分时 fallback
- `app/api/stock-kline.js` — 新增 tdxrs bars 为首要源，多源串联
- `app/api/fund-flow-120d.js` — 多端点重试，单股失败不阻塞
- `app/api/news.js` — 新增东财快讯作为金十 502 fallback
- `app/api/market-data.js` — 主力资金 + 北向资金异常时降级
