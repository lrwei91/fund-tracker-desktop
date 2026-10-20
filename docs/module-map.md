# 功能与接口地图

以下是协作定位入口，不代替路由契约；实际注册以 `src-tauri/src/api/handlers/mod.rs` 为准，缓存类别以 `policy.rs` 为准。

| 功能 | 前端入口 | `fetch_data` 路由 | Rust handler |
|---|---|---|---|
| 自选股、持仓、指数报价与搜索 | `refresh-coordinator.js`、`watchlist/watch-render.js`、`custom-index.js` | `/stock`、`/stock-search`、`/market-warnings` | `stock.rs`、`signals.rs` |
| 个股详情 | `watchlist/stock-detail.js` | `/stock-minute`、`/stock-kline`、`/fund-flow-120d`、`/stock-news` | `detail.rs`、`news.rs` |
| 财务与统一研究快照 | `stock-research.js` | `/stock-fundamentals`、`/stock-research` | `research.rs` |
| AI 评分、深度研究与历史 | `stock-research.js` | `/stock-ai-research`（主窗口） | `src/research_ai.rs` |
| 盘前盘后持仓报告与原生调度 | `research-reports.js` | `/research-reports`（主窗口） | `src/research_reports.rs`、`src/trading_calendar.rs` |
| 价格提醒与触发历史 | `price-alerts.js` | `/price-alerts`（主窗口） | `src/price_alerts.rs` |
| 大盘指数、主力资金与板块资金 | `render-market.js` | `/market-data`（`index` / `capital` / `sector`） | `market.rs` |
| 信号与情绪 | `render-signals.js` | `/opportunity-radar`、`/hot-rank`、`/limit-up`、`/sector-rotation`、`/intraday-screening` | `signals.rs`、`market.rs` |
| 财经快讯 | `render-news.js` | `/news`、`/cls-news`、`/global-news` | `news.rs` |

- 新版页面导航和本机组合摘要由 `workbench.js` 管理；布局在 `workbench.css`。旧 `#signals` 链接映射研究页，未知旧页面回到盯盘。
- `/research-reports` 为原生状态接口，不进入行情 endpoint cache；普通 `config_storage_patch` 不允许覆盖 `fund_tracker_report_center`。
- `/dragon-tiger` 是保留的公开路由，但当前主界面不直接请求；机会雷达在 Rust 内部调用龙虎榜、资金流、重点监控和严重异动数据。`stock_monitor` / `price_anomaly` 是内部上游能力，不应从前端绕过 `/market-warnings` 或 `/opportunity-radar` 直接接入。`/stock-risk` 公告与解禁数据仍由统一研究快照在 Rust 内部聚合，个股详情不再单独展示该页面。
- AI 与提醒的接入及运行边界见 [功能说明](stock-research-and-alerts.md)。`/intraday-screening` 保留路由兼容，主页面已移除该独立入口。
- 软件更新：`modules/updates.js` → 主窗口专用 `update_*` commands → `src-tauri/src/updates.rs`。发布文件、签名及运行边界见 [自动更新](automatic-updates.md)。

- 基金专属页面、净值/估值/诊断接口与共享采集已移除；保留场内 ETF 行情。旧配置中的基金记录不再暴露或使用，保存股票配置时仍保留原记录；旧备份可继续导入股票部分。
