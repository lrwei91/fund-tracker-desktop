# fund-tracker 逐模块 Code Review 问题清单

> 评审日期：2026-07-08 ｜ 评审人：Senior Developer
> 严重度：🔴 高（须修）｜ 🟡 中（应修）｜ 🟢 低（建议）
> 每条格式：`文件:行` — 问题 — 建议

---

## app/api/ （数据层，纯 Node）

### _utils.js
- 🟢 `emGet`（`_utils.js:61`）重试策略优秀：403/4xx 不重试、指数退避 + 随机抖动、限流意识强。保持，作为团队范本。
- 🟢 `toNumber` / `formatPct` / `formatYi` / `tencentSymbol` 纯函数，可单测。

### market-data.js
- 🟡 `market-data.js:77` `loadSector` 取 `slice(0,10)`，但 `render-market.js:316` 只显示 `slice(0,5)`。两处魔法数字不一致，应共用常量 `SECTOR_TOP_N = 5`。
- 🟡 `market-data.js:160-161` 注释自相矛盾（"大单"=f66 超大单），代码实际 `large: sum('f72')`（大单）。注释误导，修正以免后人改错。代码本身正确。
- 🟡 `market-data.js:111` `shanghaiDateKey()` 与 `utils.getShanghaiDateKey()` 重复实现，应复用 `utils`。
- 🟢 `loadNorthFund`（`market-data.js:174`）用裸 `fetchJson` 到 `data.hexin.cn`，无重试/无降级。北向单源，挂了静默。建议改走 `emGet` 或加容错（低优先）。

### stock.js
- 🟢 腾讯 quote 解析 + 昨收反推 fallback 写得好。
- 🟡 `stock.js:49` `volume: data[36] || data[6]` 魔法下标无注释（同文件其它字段有）。补注释或字段映射。

### stock-kline.js
- 🟢 `computeTechnicalAnalysis` / `computeChipDistribution`（`stock-kline.js:199/300`）是纯函数范本，**必须单测**（金融计算，最该测）。
- 🟡 `stock-kline.js:225-263` 评分阈值（8/-8/10/-12…）与 verdict 切分（-15/15/35/-35）是魔法数字，提到模块顶部常量。
- 🟡 `stock-kline.js:25` `parseKline` 用 `parts[1]..parts[10]` 魔法下标，依赖东财字段顺序。建议字段映射表 + 单测固化，防接口字段变化。

### limit-up.js
- 🟢 四池 map + summary 计算清晰，应单测。
- 🟡 `limit-up.js:9` `ZTB_UT` 硬编码 token。提到常量/配置，并确认不误提交敏感值（当前为公开参数，风险低）。

### stock-minute.js
- 🟢 tdxrs 多候选降级 + 东财 fallback 稳健。
- 🟡 `stock-minute.js:14` `marketOf` 与 `fund-flow-120d.js:13 marketCode`、`stock.js/_utils.js tencentSymbol` 三处重复 market 判定且写法略不同（`/^(5|6|9)/` vs `startsWith('6'|'9')`）。北交所(8/4)行为可能不一致。统一到 `_utils.js`。

### fund-flow-120d.js
- 🟢 串行限流 + 腾讯名称兜底 + 东财降级，稳健。
- 🟡 `fund-flow-120d.js:13-22` 在此又各实现 `marketCode` / `tencentSymbol` 一份，注释"与 api/stock.js 同步"靠人肉，迟早漂。抽 `_utils.js`。
- 🟡 `fund-flow-120d.js:80` `summarize` 字段顺序依赖（parts[1]..parts[6]），加单测固化。

---

## app/modules/ （渲染层）

### state.js
- 🟡 `state.js:205` 暴露整个运行时 state 为可变对象，无封装。按规范第 3 节改为"只读快照 + 受控写入"。
- 🟡 `state.js:18` `SHORT_CACHE_KEYS` 是缓存 key 的部分来源，但 `render-signals.js:158` 的 `DRAGON_TIGER_CACHE_KEY` 不在此列。统一到单一来源（规范第 6 节）。

### utils.js
- 🟢 工具集清晰、时区处理正确。范本。

### storage.js
- 🟡 与 `main.js` `CONFIG_STORAGE_KEYS` 内容一致但**两份独立维护**，将来必漂。改单一来源（规范第 6 节）。
- 🟢 迁移 shim 设计好。

### cache.js
- 🟢 缓存 helper 清晰，legacy 懒清理设计好。无问题。

### render-market.js
- 🟡 `render-market.js:253/282` `loadCapitalData`/`loadSectorData` 失败且无缓存时静默 `return`，与 index 的"行情获取失败"不一致。建议失败时也 `showStatusToast`。
- 🟡 `render-market.js:316` 硬编码 `slice(0,5)` 与 api `slice(0,10)` 不一致（见 market-data）。

### render-signals.js
- 🟡 `render-signals.js:158` `DRAGON_TIGER_CACHE_KEY = 'fund_tracker_dragon_tiger_cache'` 散落魔法字符串，不归入 `state.js` 缓存 key 体系。迁入 `SHORT_CACHE_KEYS`。
- 🟡 `render-signals.js:250-292` `renderRow` 四分支大量重复结构，抽公共模板减少复制。
- 🟢 容错与 toast 提示完善。

### render-news.js
- 🔴 `render-news.js:13-17` `stripHtmlTags` 用 `tmp.innerHTML = html` 解析外部新闻 HTML，会执行 `<img onerror>` 等事件处理器——潜在脚本执行。改为 `new DOMParser().parseFromString(html,'text/html').body.textContent`。
- 🟢 其余渲染均走 `escapeHtml`，良好。

### render-alerts.js
- 🟡 `render-alerts.js:225` `checkAlerts` 直接读写 `state.watchAlertState` 并跨模块读 `window.AppWatchlist.getWatchTabs()`。耦合可接受但 state 全局可变（规范第 3 节）。
- 🟢 toast 创建/销毁/计时器管理规范，良好。

### render-watchlist.js（1833 行）🔴
- 🔴 `render-watchlist.js` 单文件 1833 行，混合分组管理 / 行情渲染 / 迷你图 / 成本编辑 / 资金流弹窗 / 自选指数。必须拆分（规范第 2 节）。头号维护负担。
- 🟡 内部 `getPrevChangePct` / `persistCurrentChangePct` 引用 `PREV_KEY`（`state.js`），缓存 key 散落。
- 🟡 大文件内 `innerHTML` 拼接多，需确认用户备注名 `watchlistRemarks` 经 innerHTML 插入时是否 escape。建议做一次 innerHTML 专项扫描（同 render-news 的 stripHtmlTags 一并处理）。

### app.js
- 🟢 入口编排清晰，自动刷新"先停后起"模式正确。无问题。

---

## renderer/ （独立浮窗）

### holding-widget.js
- 🟡 `holding-widget.js:28/37/54/60` 重复实现 `escapeHtml` / `sanitizeCodes` / `formatPct` / `quoteClass`（`utils.js` 已有），未复用。抽共享或注明。
- 🟡 `holding-widget.js:281` `window.addEventListener('storage', ...)` 依赖跨窗口 localStorage 事件同步行情缓存；该事件只在其它文档变更时触发，且耦合 config shim 行为，脆弱。建议浮窗统一走已有 `shell.onHoldingWidgetRefresh` IPC，storage 事件仅作补充并写明。

### storage.js
- 🟡 与 `app/modules/storage.js` 完全重复（16 行 config key + 迁移逻辑）。两处维护，应共享或生成。

---

## 页面与样式

### index.html
- 🟢 CSP 优秀：`script-src 'self'`、无 unsafe-inline、object-src none、base-uri self。范本。
- 🟢 结构与可访问性（aria-label / role / tabindex）做得好。无问题。

### styles.css（3549 行）
- 🟡 体积大（CSS 通常可接受），建议专项确认有无死样式、是否按卡片拆分。低（未细读）。

---

## 优先修复顺序（建议）

1. 🔴 `render-news.js:13` stripHtmlTags XSS（改 1 处，立竿见影）
2. 🔴 拆 `render-watchlist.js` 1833 行（排期，最大维护收益）
3. 🟡 缓存 key / config key 单一来源（state.js 收口）
4. 🟡 抽 `_utils.js`：market 判定 / 时区 / escapeHtml 复用，消三处重复
5. 🟡 补齐 ESLint + Vitest + CI（门禁，见 code-standards.md 第 8 节）
6. 🟢 给纯逻辑补单测：stock-kline / limit-up / utils 交易时段

---

## 建议单测覆盖（Vitest，不启 Electron）

| 目标 | 文件 | 理由 |
|------|------|------|
| 技术面评分 | `app/api/stock-kline.js` `computeTechnicalAnalysis` | 金融计算，错则误导 |
| 筹码分布 | `app/api/stock-kline.js` `computeChipDistribution` | 同上 |
| 打板四池映射 | `app/api/limit-up.js` `mapZt/Zb/Dt/Yzt` + summary | 字段顺序易变 |
| 重试策略 | `app/api/_utils.js` `emGet` | 403/4xx 不重试、退避 |
| 交易时段 | `app/modules/utils.js` `isIntradayRefreshWindow` 等 | 时区/边界易错 |
| 数值归一 | `app/api/_utils.js` `toNumber` / `formatPct` | 边界值 |
