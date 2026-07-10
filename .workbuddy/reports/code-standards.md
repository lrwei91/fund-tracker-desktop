# fund-tracker 团队代码规范

> 目的：把现有工程里的"好直觉"固化成团队可执行的标准，堵住质量门禁缺口。
> 适用范围：`main.js` / `preload.js` / `app/**` / `renderer/**` 全部前端与主进程代码。
> 生效方式：PR 前对照文末《评审清单》自查；CI 跑 ESLint + 单测（见第 8 节）。

---

## 1. 总体原则

- **可读性优先于聪明**：金融数据链路复杂，代码要让接手的人 3 分钟内看懂主干。
- **显式优于隐式**：跨模块依赖、存储位置、重试策略都要写明白（现有注释方向是对的，保持）。
- **失败要优雅**：任何外部接口挂了，都不能让 UI 白屏或崩溃（现有 try/catch 基调保持）。
- **不改业务行为地提升质量**：重构只改结构，不改输出。涉及字段/接口变更必须评审。

---

## 2. 分层与模块边界

当前分层（很好，保持）：

```
main.js       主进程：窗口 / 协议 / IPC / 配置落盘
preload.js    桥：contextBridge 暴露 window.shell（最小表面）
app/api/*     数据层：纯 Node，fetch 外部行情并归一化，不碰 DOM
app/modules/* 渲染层：IIFE 暴露 window.AppXxx，只碰 DOM + 状态
renderer/*    独立浮窗 renderer（独立进程，独立 storage 镜像）
```

规则：

- **api 层禁止碰 DOM / window**：只做 fetch + 归一化 + 容错，返回纯数据（`app/api/stock-kline.js` 的 `computeTechnicalAnalysis` 是纯函数范本）。
- **渲染层禁止直接 fetch 外部域名**：一律走 `utils.apiUrl('/xxx')` → 主进程协议转发，保证走统一的 retry / 超时 / 风控（`render-market.js` 已遵守，新代码照做）。
- **模块只通过 `window.AppXxx` 暴露必要接口**，且调用方一律 `if (window.AppXxx)` 守卫（`app.js` 模式），避免加载顺序耦合。
- **单文件不超过 600 行**。超过即拆分（当前 `render-watchlist.js` 1833 行是头号违规，须拆）。

---

## 3. 状态管理约定

- **`window.AppState` 是只读快照 + 受控写入**，不是任何人随便改的对象。
  - 读：`var state = window.AppState;` 直接读。
  - 写：新增运行时状态必须挂在 `state` 上并在 `state.js` 顶部注释声明；**不在各模块里随手 `state.xxx = ...`**。
- **禁止跨模块的隐式状态耦合**：A 模块要 B 模块的数据，走 B 暴露的函数（如 `window.AppWatchlist.getWatchTabs()`），不要直接读 `state.watchlistTabs`（现有 `render-alerts.js` 已正确走函数，保持）。
- **自动刷新的多个 `setInterval` 并发写同一 state 是隐患**：虽 JS 单线程不会"真竞态"，但逻辑上要防重入。刷新入口集中在 `app.js` 的 `startXxxAutoRefresh`，新增定时刷新必须先停后起（现有 `stopXxxAutoRefresh()` 先清再建的模式保持）。

---

## 4. 安全

### 4.1 Electron 基线（已达标，红线不可退）

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` 必须长期保持（`main.js:492`）。
- 自定义协议必须路径穿越防护：`isInside(root, filePath)` 校验（`main.js:100`），新增任何 `protocol.handle` 都要沿用。
- `preload.js` 只用 `contextBridge.exposeInMainWorld`，绝不直接 `require` 主进程模块给渲染层。

### 4.2 XSS（当前最该补的窟窿）

- **所有动态插入 DOM 的字符串，默认走 `utils.escapeHtml()`**（`render-signals.js` / `render-watchlist.js` 大部分已遵守）。
- **禁止用 `innerHTML` 解析外部 HTML 来取文本**：`render-news.js:13 stripHtmlTags` 用 `tmp.innerHTML = html` 会执行 `<img onerror>` 等事件处理器。改为 `DOMParser` 取 `textContent`，或先整体 escape 再处理。
- **用户可控内容（备注名 `watchlistRemarks`、股票名）一律 escape 后插入**：增加一条 ESLint 自定义规则，凡 `innerHTML =` 右侧含未转义变量即报错。
- **CSP 保持 `script-src 'self'`**（无 `'unsafe-inline'`）。当前 `style-src 'unsafe-inline'` 是 Electron 内联样式妥协，可接受，但新增代码尽量用 class 而非内联 style（`render-market.js:357` 用 `setProperty` 写宽度是对的，保持）。

---

## 5. 错误处理与容错

- **`localStorage` / `JSON.parse` 读取一律 try/catch 并给 fallback**（现有基调很好，保持）。
- **API 层统一出口**：成功 `ok(res, data)`，失败 `fail(res, code, msg)`（`app/api/_utils.js`）。新增 handler 必须包 try/catch 返回 `fail`，不允许抛到协议层。
- **重试策略集中维护**：外部行情走 `emGet`（指数退避 + 抖动 + 403/4xx 不重试）。新增端点复用 `emGet`，不要各自写 fetch。
- **降级链要显式**：主源失败 → 备用源（如 `stock-kline.js` 东财→腾讯、`stock-minute.js` tdxrs→东财），把 `fallbackReason` 带回前端便于排查。

---

## 6. 配置 key 与缓存 key 单一来源（重点整改）

现状问题：config key 在 `main.js` 与 `storage.js` 各抄一份（目前一致但随时会漂）；运行时缓存 key 散落多处。

规则：

- **config key 只定义一次**：在 `state.js` 定义权威清单，导出给 `main.js` / `storage.js` 引用，删除重复字面量。
- **缓存 key 全部收敛到 `state.js` 的 `SHORT_CACHE_KEYS` / 新增 `CACHE_KEYS`**，禁止在 `render-*.js` 里写 `'fund_tracker_xxx_cache'` 魔法字符串（如 `render-signals.js:158` 的 `DRAGON_TIGER_CACHE_KEY` 必须迁入）。
- **魔法数字集中**：刷新间隔、TOP N、评分阈值等放到模块顶部常量（如 `market-data.js` 的 `loadSector` 取 10 但 UI 只显示 5，应共用一个 `SECTOR_TOP_N` 常量）。

---

## 7. 命名、注释、魔法数字

- **注释讲"为什么"**：现有中文注释质量高（如 `limit-up.js` 讲清四池端点差异、`_utils.js` 讲清为什么 403 不重试），保持。禁止只复述代码的废话注释。
- **函数单一职责**：一个函数只做一件事，超过 40 行考虑拆（参考 `stock-kline.js` 的 `rsi` / `macd` / `bollinger` 拆分）。
- **不要重复实现已有工具**：`escapeHtml` / `formatYuan` / `tencentSymbol` / `toNumber` 已存在，跨文件需要就抽到 `_utils.js` 或 `utils.js`，不要在 `renderer/holding-widget.js` 再写一份（目前它确实又抄了一份 `escapeHtml` / `sanitizeCodes`，应复用）。
- **统一时区处理**：所有"上海时间"走 `utils.getShanghaiNow()` / `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' })`，禁止裸 `new Date().toLocaleTimeString()` 不带时区（个别 api 文件有遗漏，需排查）。

---

## 8. 测试与 CI（当前完全缺失，必须补齐）

- **静态检查**：引入 ESLint（含 `no-innerHTML` / 自定义 escape 规则）+ Prettier，`package.json` 的 `check` 从 `node --check` 升级为 `eslint .`。
- **单元测试（Vitest，跑在 Node，不启 Electron）**：优先覆盖纯逻辑——
  - `app/api/stock-kline.js` 的 `computeTechnicalAnalysis` / `computeChipDistribution`（金融计算，最该测）；
  - `app/api/_utils.js` 的 `emGet` 重试分支、`toNumber` / `formatPct`；
  - `app/modules/utils.js` 的交易时段判断；
  - `app/api/limit-up.js` 的 `mapZt/Zb/Dt/Yzt` 与 summary 计算。
- **CI**：GitHub Actions 在 PR 时跑 `eslint` + `vitest`；主分支保护，未过不让合。
- **不要求立刻 100% 覆盖**：新代码必须带单测，旧模块按风险优先级补（先 kline / limit-up / utils）。

---

## 9. PR 前评审清单（团队自查）

- [ ] 新增/修改 key 是否已收敛到 `state.js` 单一来源？
- [ ] 所有 `innerHTML =` 是否对非字面量做了 `escapeHtml`？有无用 innerHTML 解析外部 HTML？
- [ ] 新文件是否超过 600 行？超了是否拆分？
- [ ] 外部接口是否走 `emGet` / 主进程协议，有无裸 fetch 外部域名？
- [ ] 是否带了单测（纯逻辑必须）？ESLint 是否通过？
- [ ] 注释是否讲了"为什么"？魔法数字是否提为常数？
- [ ] 有没有重复实现已有工具函数？
- [ ] Electron 安全基线（isolation/sandbox/路径校验）是否保持？
