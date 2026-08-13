# 恭喜发财桌面版协作约定

## 目标

在不破坏本地用户数据、桌面权限边界或行情可靠性规则的前提下，以最小改动交付可验证的 Tauri 桌面功能与修复。

## 成功标准

- 改动解决用户提出的问题，不引入无关重构、新框架或未经要求的数据口径。
- 主窗口、持仓浮窗、提醒窗口及 `window.shell` / `AppDataClient` 契约保持兼容；已有 `config.json` v2 数据可继续读取。
- 页面如实表达数据来源、缓存、降级和不可用状态；不得把未知、空值、成交额或旧缓存伪装成确定结论、净流入或最新行情。
- 修改后运行与风险相称的检查，并明确报告已验证项、未验证项和剩余风险。

## 项目边界

- 保持 Tauri 2 + Rust + 原生 HTML/CSS/JavaScript 架构；不要迁移 React、TypeScript、Vite，或引入大型状态管理方案，除非用户明确要求。
- `src-tauri/src/lib.rs`、`windows.rs` 和 `config.rs` 负责受限 commands、窗口/事件及持久配置；renderer 不得获得任意文件系统、shell 或进程权限。新增外链必须进入精确 HTTPS allowlist。
- 前端数据请求继续通过 `app/modules/data-client.js` 调用 `fetch_data`；Rust 路由、策略、缓存和上游请求分别由 `src-tauri/src/api/routes.rs`、`policy.rs`、`http.rs` 与 `handlers/` 管理。新增或调整外部请求必须复用 gateway 的合并、限速、熔断、体积限制和降级语义。
- `app/modules/refresh-coordinator.js` 是主窗口刷新调度入口。新增行情、基金看板或信号刷新时接入现有周期、优先级、并发和隐藏页面暂停机制，不另建重复定时器。
- 持久用户数据通过 `AppStorage` / Tauri command 原子写入 `config.json` v2；`localStorage` 仅作前端镜像或可重建缓存。新增持久字段时同步 `app/config-schema.js` 与 `src-tauri/src/config.rs`，并保持旧字段兼容。
- `dist/` 和 `.tauri-frontend/` 是生成产物，不入库；普通构建不得隐式修改版本号。图标以 `brand/app-icon-1024.png` 为母版，通过 `npm run icons:generate` 更新各平台资源。

## 数据与界面规则

- A 股代码路由统一复用 `src-tauri/src/api/symbol.rs`，不得把北交所 `920xxx` 或旧 43/83/87 代码静默映射到沪深市场。
- 自选、持仓、基金看板和信号页必须保留红涨绿跌、来源标识及 loading / empty / error / stale / degraded 状态。严重异动“已触发”和“预警/预测”是不同状态，不得混用标签。
- 基金搜索、行情和基金看板逻辑优先放在 `src-tauri/src/api/handlers/fund.rs` 与 `app/modules/render-funds.js` / `render-fund-board.js`；市场信号优先放在 `src-tauri/src/api/handlers/signals.rs` 与 `app/modules/render-signals.js`，不要把新逻辑继续堆回通用入口。
- 页面视觉改动遵循 `docs/design-brief.md`，保持白纸、黑墨、荧光黄的高密度工作台语言，并覆盖浅色、深色、键盘焦点、弹窗和 reduced-motion 状态。

## 功能与接口地图

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
- 新增、删除或改名路由时，必须同步 `handlers/mod.rs`、`policy.rs`、`src-tauri/fixtures/routes.json`、真实数据 smoke 清单、对应前端调用与测试，并更新上表；Live 路由不得回退到 stale endpoint cache。

## 工作方式

- 开始前检查 `git status`、相关入口、调用链、测试和运行方式；能从仓库或真实输出确认的事实不靠猜测。
- 优先复用现有模块、helper、数据契约和测试 fixture，只修改完成目标所必需的文件。
- 工作区存在无关改动时保留它们，不回滚、不覆盖，也不使用 `git add -A` 混入本次提交。
- 架构、构建和数据源事实以 `README.md` 与 `docs/overview.md` 为准；本文件只维护协作约束，不复制完整架构说明。

## 验证规则

- JavaScript 或 UI 逻辑：至少运行相关 Vitest；提交前运行 `npm run lint`、`npm test` 和 `npm run check`。
- 自选、持仓、基金、信号、浮窗或初始化链路：运行 `npm run smoke`；修改刷新调度时再运行 `npm run smoke:refresh`。
- Rust/API 改动：运行相关测试，并在提交前运行 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 和 `cargo test --manifest-path src-tauri/Cargo.toml`。
- 第三方真实数据可用 `RUN_LIVE_DATA=1 npm run smoke:data` 验证；网络、休市或上游风控导致未运行/失败时单独说明，不把它当作代码正确性结论。
- 修改图标、Tauri commands、窗口、配置或打包链路时，运行对应 `build:*:raw` 和 `npm run size:check`，或说明未打包原因。

## 发布与外部操作

- 本地只读检查和本地代码修改可直接执行。push、标签、GitHub Release、上传安装包、远程配置写入、删除文件或覆盖用户数据前，必须取得明确授权；同一轮已授权发布流程可以完整执行。
- 发版时使用 `npm run version:bump` 统一更新版本，提交后推送 `main` 和注释标签 `vX.Y.Z`。标签 CI 会在质量与双平台打包全部通过后自动创建 Release，不要并行手工创建重复发行版。
- 发布完成前核对标签、提交、CI 结论、Release 资产名、ZIP 完整性和 SHA-256；只把 CI 生成的 macOS/Windows 包作为正式资产。
- 需求、数据口径或目标环境缺少会显著改变结果的关键信息时停止并请求决策；其余可从现场确认的细节自行处理。
- 完成后用中文给出结论：改了什么、验证了什么、未验证什么，以及剩余风险或下一步。
