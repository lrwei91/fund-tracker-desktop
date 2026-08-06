# 恭喜发财桌面版

独立 Electron 桌面仓库。主窗口、行情看板、API 代理和持仓浮窗都随应用一起打包；Web 版在原 `fund-tracker` 仓库独立维护。

## 功能

- 大盘指数：上证、深证、创业板、科创 50
- 自选股：分组、搜索、添加/移除、持仓成本编辑
- 自选数据导入导出：备份/恢复自选股分组、当前分组、自选指数、持仓成本和股数
- 资金流向：主力/大单/中单/小单、沪股通盘中参考、HKEX 北向官方日成交额
- 自选股资金流：5/20/60 日主力净流入和趋势
- 自选股研究卡：分时、日 K 技术评分、支撑压力、筹码估算、新闻催化/风险词、公告、未来 90 天解禁、触发条件和失效条件
- 机会雷达：汇总热榜、涨停池、板块资金、龙虎榜、技术面和个股新闻，输出今日候选股综合分
- 市场信号：机会雷达、热榜、打板情绪（涨停/炸板/跌停/昨涨停）
- 财经快讯：金十、财联社、东方财富；首屏失败时使用独立来源自动降级
- 桌面浮窗：独立 Electron renderer，读取主窗口本地数据
- 桌面提醒：持仓股越过涨跌阈值时，以独立置顶的小牛/小熊卡片和提示音提醒，支持在设置中直接测试

## 目录结构

```text
.
├── app/                  # 主窗口本地 renderer 和本地 API
│   ├── api/              # Electron 自定义协议转发的 API handler
│   ├── modules/          # 主窗口渲染模块
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── renderer/             # Electron 专用独立 renderer
│   ├── holding-widget.html
│   ├── holding-widget.css
│   └── holding-widget.js
├── main.js               # Electron 主进程、窗口、协议、IPC
├── preload.js            # 安全暴露 window.shell
├── desktop/              # 配置存储与自定义协议路由
├── package.json          # Electron 启动和打包配置
└── package-lock.json
```

## 开发

```bash
npm install
npm start
```

如需打开 Chrome DevTools Protocol：

```bash
npm start -- --remote-debugging-port=9229
```

## 构建

```bash
npm run build:mac
npm run build:win
npm run build:all
```

构建产物输出到 `dist/`，该目录不入库。

`build:win` 只产出无需安装的单个 portable `.exe`；`build:mac` 只产出单个 `.zip` 分发文件，解压后仍是 macOS 要求的 `.app` 应用包。不再生成 DMG 或 NSIS 安装包。

打包命令不会修改版本号。发布前请通过显式 release/tag 流程更新版本；`build:*:raw` 用于 CI 与本地验证。

macOS 打包版复制到 `/Applications` 后，如遇到系统拦截或提示无权限打开，可执行：

```bash
xattr -cr "/Applications/恭喜发财.app"
chmod +x "/Applications/恭喜发财.app/Contents/MacOS/恭喜发财"
```

## 运行模型

`main.js` 注册 `fund-tracker://app/` 自定义协议：

- `fund-tracker://app/index.html` 加载 `app/index.html`
- `fund-tracker://app/api/...` 转发到 `app/api/*.js`
- `fund-tracker://app/renderer/holding-widget.html` 加载 `renderer/holding-widget.html`
- `fund-tracker://app/renderer/alert-popup.html` 加载独立桌面提醒卡片

主窗口和浮窗通过异步 IPC 共享 `config.json`。自选股分组、当前分组、自选指数、持仓成本/股数、持仓备注名、设置、小丑模式等关键用户数据写入该文件；行情/新闻等临时缓存仍保留在 Chromium `localStorage`。首次启动会迁移旧 localStorage 中的关键用户配置。

所有上游请求都会经过进程内 data gateway：相同请求会合并，东方财富严格单并发、请求间隔 1–1.3 秒，遇到 403 或连续网络错误会暂时熔断并切换独立备用源。接口返回会说明实际来源和降级状态。

日 K 和分时默认可由腾讯 HTTP 接口独立完成。开发环境会探测本机 `tdxrs`；打包版只有在显式配置 `TDXRS_BIN` / `TDXRS_PYTHON` 时才将其作为可选加速源，不要求用户额外安装 Python。

顶部“导入/导出”会备份/恢复自选股分组、当前分组、自选指数、持仓成本、股数和备注名；导入兼容旧版 `costPrice`、`buyPrice`、`quantity`、`positions`、`customIndices` 等字段。

Windows 打包版的关键用户配置默认在 `%APPDATA%\恭喜发财\config.json`；开发模式通常在 `%APPDATA%\fund-tracker-electron\config.json`。浏览器 `localStorage` 临时缓存位于 `Local Storage\leveldb`。应用启动和 Windows 清理退出时会在日志里输出实际 `userData`、`config`、`localStorage`、`sessionStorage` 和 `Cache` 路径。

Windows 主窗口最小化后仍保留任务栏按钮和系统托盘入口；持仓浮窗保持独立，点击最小化会隐藏到系统托盘。

## 数据说明

行情和新闻来自腾讯财经、同花顺、金十、财联社、东方财富、沪深交易所、HKEX 和新浪财经等公开接口。深股通分钟序列不再作为可靠净流入展示；HKEX 数据为日成交额，不代表净买入。本应用仅做本地展示和代理转发，数据仅供参考，不构成投资建议。

可选真实数据检查：

```bash
RUN_LIVE_DATA=1 npm run smoke:data
```

该检查访问实时第三方接口，可能受休市、网络或上游风控影响，因此不放入默认 CI 门禁。
