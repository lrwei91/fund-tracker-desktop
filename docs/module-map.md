# 功能与接口地图

以下是协作定位入口，不代替路由契约；实际注册以 `src-tauri/src/api/handlers/mod.rs` 为准，缓存类别以 `policy.rs` 为准。

| 功能 | 前端入口 | `fetch_data` 路由 | Rust handler |
|---|---|---|---|
| 自选股、持仓、指数报价与搜索 | `refresh-coordinator.js`、`watchlist/watch-render.js`、`custom-index.js` | `/stock`、`/stock-search`、`/market-warnings` | `stock.rs`、`signals.rs` |
| 个股详情 | `watchlist/stock-detail.js` | `/stock-minute`、`/stock-kline`、`/fund-flow-120d`、`/stock-news`、`/stock-risk` | `detail.rs`、`news.rs` |
| 大盘指数、主力资金与板块资金 | `render-market.js` | `/market-data`（`index` / `capital` / `sector`） | `market.rs` |
| 自选基金 | `render-funds.js` | `/fund-search`、`/fund-quotes`、`/fund-board-realtime` | `fund.rs` |
| 基金筛选看板 | `render-fund-board.js` | `/fund-board`、`/fund-board-trends`、`/fund-board-realtime` | `fund.rs` |
| 信号与情绪 | `render-signals.js` | `/opportunity-radar`、`/hot-rank`、`/limit-up`、`/sector-rotation`、`/intraday-screening` | `signals.rs`、`market.rs` |
| 财经快讯 | `render-news.js` | `/news`、`/cls-news`、`/global-news` | `news.rs` |

- `/dragon-tiger` 是保留的公开路由，但当前主界面不直接请求；机会雷达在 Rust 内部调用龙虎榜、资金流、重点监控和严重异动数据。`stock_monitor` / `price_anomaly` 是内部上游能力，不应从前端绕过 `/market-warnings` 或 `/opportunity-radar` 直接接入。
