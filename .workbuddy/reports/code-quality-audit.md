# 代码质量审计与团队提升路线

> 审计对象：`fund-tracker`（恭喜发财 Electron 桌面应用）
> 审计范围：`main.js` / `preload.js` / `app/**` / `renderer/**`（约 1.17 万行）
> 审计日期：2026-07-08

## 一句话结论

团队工程底子**明显在中高级以上**——安全基线、分层架构、容错、注释都到位。当前瓶颈不在"会不会写"，而在**缺少工程纪律与质量门禁**：没有 lint / 测试 / CI，且存在一个 1833 行的巨型模块和全局可变状态。补上质量防线，比加功能更能提升整体水平。

---

## 一、已经做对的（团队强项，先给正反馈）

| 维度 | 表现 |
|------|------|
| Electron 安全基线 | `contextIsolation` + `sandbox` + `nodeIntegration:false` 全开；`isInside()` 路径穿越防护；config key 白名单校验（`main.js:128`） |
| 分层架构 | 主进程 / preload 桥 / api 数据层 / modules 渲染层职责分明；IIFE + 显式依赖注释 |
| 容错 | `localStorage` 读取几乎全部 `try/catch`；`readUserConfig` 有缓存与降级 |
| API 韧性 | `emGet` 重试策略有思考：403 不重试、指数退避 + 随机抖动、明确不重试 4xx（`app/api/_utils.js:61`） |
| 时区/交易日 | 交易时段判断集中在 `utils`，时区用 `Asia/Shanghai` 正确处理 |
| 迁移与版本意识 | `storage.js` 的 localStorage→config.json 迁移 shim；alert state 带 `WATCH_ALERT_SCHEMA_VERSION` |
| 注释质量 | 讲"为什么"而非"做什么"，中文清晰（如为何 Windows 关硬件加速） |

---

## 二、需要补强的（按优先级）

### P0 · 工程纪律 / 质量门禁（最高杠杆，最低风险）

- **无任何自动化门禁**：无 ESLint、无 Prettier、无测试框架、无 CI。
  - `package.json` 的 `check` 脚本仅做 `node --check` 语法检查（连风格都不管）。
  - 新人提交什么都能进，风格靠"人肉自觉"，隐患随人数线性增长。
- **零测试**：金融计算、缓存 TTL、config 迁移、schema 升级全是隐性知识。任一改动都靠"手测 + 祈祷"，回归成本极高。

### P1 · 可维护性

- **`app/modules/render-watchlist.js` 共 1833 行单文件巨模块**：混合了分组管理、行情渲染、迷你走势图、持仓成本编辑、单股资金流弹窗、自选指数。任何人改它都如履薄冰，是头号维护负担。
- **全局可变状态 `window.AppState`**：所有模块直接读写同一可变对象，无封装、无单向数据流。自动刷新 4 个 `setInterval` 并发写同一 state，存在竞态隐患；跨模块耦合靠 `if (window.AppMarket)` 式守卫，脆弱且隐式。
- **配置 key 与缓存 key 管理分散**：`main.js` 的 `CONFIG_STORAGE_KEYS` 与 `storage.js` 的 `CONFIG_KEYS` 目前内容一致（各 16 个，这点做得对），但**两份独立维护**（改一处忘改另一处就会静默漂移）。更关键的是**运行时缓存 key 完全没有集中**：一部分在 `state.js` 的 `SHORT_CACHE_KEYS`，另一部分却是散落的魔法字符串（如 `render-signals.js:158` 的 `DRAGON_TIGER_CACHE_KEY`、注释里提到的 `PREV_KEY`），新增缓存随时会出现命名/清理不一致。

### P2 · 健壮性 / 安全

- **XSS 面**：`innerHTML` 大量使用。多数走 `escapeHtml`，但：
  - `render-news.js:15` 的 `stripHtmlTags` 用 `innerHTML` 解析外部新闻 HTML，事件处理器属性（`onerror` 等）会触发执行。
  - 用户备注名（`watchlistRemarks`）若经 `innerHTML` 注入且未转义，是潜在存储型注入。桌面端影响有限，但应统一收口到 `textContent` / 白名单 sanitizer。
- **渲染与数据获取耦合**：`render-*` 同文件既 fetch 又渲染，纯逻辑无法单测。

### P3 · 可选长期

- **无 TypeScript**：金融计算 + schema 版本 + 多源数据，类型能挡掉一类 bug；但迁移成本高，列为可选。
- **`configStorage` 同步 IPC 契约混乱**：`sendSync` 返回有时是已解析对象、有时是字符串（`main.js` 的 encode/decode 逻辑），调用方需自行判断。

---

## 三、建议的起步动作（待你确认范围）

1. **搭质量门禁**（推荐，低风险高杠杆）：ESLint + Prettier + 测试框架（Vitest）+ GitHub Actions CI，先从"不改动业务代码"的静态检查与少量核心逻辑单测切入。
2. **先出规范 + 完整 Code Review**：把上述强项/红线写成团队《代码规范》，并对每个模块做逐文件评审留档。
3. **拆 `render-watchlist.js`**：按职责拆成 5~6 个聚焦模块（分组 / 列表渲染 / 迷你图 / 成本编辑 / 资金流弹窗 / 自选指数）。属大改动，需先界定边界。
4. **治理架构债**：把 `window.AppState` 收口为带 getter/action 的单一状态模块；config key 收敛为单一来源并自动派生到 main/storage。

> 以上 4 项互补，建议按顺序推进。具体从哪一项先动手，等你拍板。
