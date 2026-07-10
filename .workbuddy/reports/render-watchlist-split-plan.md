# render-watchlist.js 拆分边界方案（待评审，未执行）

> 状态：**仅方案，未动代码**。按主人"大改动先定边界再动"的硬偏好，本文件仅供评审拍板。
> 目标文件：`app/modules/render-watchlist.js`（1833 行，~100 函数，单 IIFE 闭包）。

## 1. 现状问题
- 单文件 1833 行，混合 **7 类职责**：自选标签页模型、导入导出、列表渲染+迷你图、个股详情弹窗、资金流弹窗、自定义指数、标签拖拽滚动。
- 所有函数共享一个 IIFE 闭包，互相随意调用，无边界 → 改一处容易误伤别处，新人不敢碰。
- `app.js` 通过 `window.AppWatchlist`（约 60 个方法，见文件 1766–1832 行）消费它，这是**对外契约，拆分必须 100% 保持不变**。

## 2. 建议模块划分（8 个文件，落在 `app/modules/watchlist/`）

| 新文件 | 职责 | 对外 `window` 全局 | 依赖 |
|---|---|---|---|
| `watch-state.js` | 标签页模型 / CRUD / 持久化 / 涨跌快照 | `AppWatchState` | `AppState`, `AppUtils` |
| `watch-tabs-ui.js` | 标签栏 UI：渲染/切换/滚动/拖拽/增删 | `AppWatchTabsUI` | `AppWatchState`, `AppUtils` |
| `watch-io.js` | 导入导出 + 各类 normalize | `AppWatchIO` | `AppWatchState` |
| `watch-render.js` | 列表渲染、迷你图、成本/备注单元格、增删股票、行情加载 | `AppWatchRender` | `AppWatchState`, `AppUtils`, `AppStockDetail` |
| `stock-detail.js` | 个股详情弹窗：分时/技术面/信号/筹码、成本编辑器、格式化工具 | `AppStockDetail` | `AppUtils` |
| `stock-fundflow.js` | 资金流弹窗 | `AppStockFundFlow` | `AppUtils` |
| `custom-index.js` | 自定义指数 CRUD + 渲染 + 刷新 | `AppCustomIndex` | `AppWatchState`, `AppUtils` |
| `watchlist.js`（替身） | **门面**：聚合以上命名空间，原样重建 `window.AppWatchlist` | `AppWatchlist` | 全部以上 |

> 原 `render-watchlist.js` 删除，由 `watchlist.js` 取代；`window.AppWatchlist` 的方法签名、数量、行为与原文件逐一对齐。

## 3. 共享契约（拆后铁律）
- **可变状态只走 `AppWatchState` 或 `window.AppState`**，禁止模块内自建闭包变量跨文件共享。
- 模块间调用一律通过对方暴露的 `window.AppXxx` 全局（加载顺序保证前者先定义）。
- `index.html` 脚本顺序需改为先加载 7 个子模块，再加载门面 `watchlist.js`。
- `app.js` 对 `window.AppWatchlist.*` 的调用 **零改动**（门面兼容）。

## 4. 迁移策略（推荐分步，每步可编译可运行）
1. 建 `watch-state.js`，迁出状态模型函数，挂 `AppWatchState`。
2. 依次迁出 `watch-tabs-ui` → `watch-io` → `watch-render` → `stock-detail` → `stock-fundflow` → `custom-index`，每步仅移动函数 + 补 `window` 全局，不删原文件。
3. 写 `watchlist.js` 门面，逐方法从各命名空间聚合；此时 `window.AppWatchlist` 已可用。
4. 删除旧 `render-watchlist.js`，更新 `index.html` 脚本标签。
5. 每步 `npm run lint` + `npm test` 绿，手动冒烟测试标签页/导入导出/个股弹窗/资金流/自定义指数。

## 5. 验收标准
- `window.AppWatchlist` 公开方法集与原文件完全一致（方法名 + 签名）。
- 全量 lint 0 error、单测全绿、应用手动冒烟无回归。
- 单文件行数均 ≤ 400，职责单一，可独立阅读。

## 6. 顺带可做的质量增强（拆后）
- 给纯逻辑函数补单测：`watch-io.js` 的 `normalizeImported*`，`stock-detail.js` 的 `format*` / `trendClass` / `compareClass` / `rangeClass`，`watch-render.js` 的迷你图坐标计算。

## 7. 待主人拍板
- 是否按上述 **7+1** 划分拆（还是更粗/更细）？
- 是否接受**分步迁移**（每步一个小 PR，保持可运行）？
- 拆的同时是否顺手补上述纯逻辑单测？
- 是否允许我改 `index.html` 脚本加载顺序（门面兼容前提下 `app.js` 不动）？
