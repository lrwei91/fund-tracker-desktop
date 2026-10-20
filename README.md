# 恭喜发财桌面版

基于 Tauri 2 的本地桌面应用。保留原生 HTML/CSS/JavaScript 前端，行情代理、配置存储和窗口管理由 Rust 提供；不随包分发 Chromium、Node、Python 或 TDX runtime。

## 功能

以“查看持仓 → 研究标的 → 设置提醒 → 阅读报告”为主线的个人盯盘工作台，保留白纸、黑墨、荧光黄与红涨绿跌。

- **盯盘**：持仓/自选分组、成本与股数、备注、导入导出；本机计算市值、浮动盈亏和覆盖率，宽屏列表与详情并排
- **市场**：指数、资金、涨跌家数、板块；热榜、打板和轮动合并至市场观察
- **研究**：候选初筛、手动个股/批量研究、盘前盘后持仓报告与历史；分时、日 K、资金、新闻在详情内查看
- **提醒**：AND/OR 组合条件、冷却与到期设置、触发记录，保留原生持仓浮窗、透明置顶告警和提示音
- **资讯**：金十、财联社、东方财富快讯及来源切换

交易日北京时间 09:00 / 15:30 可分别启用持仓报告，默认关闭。每份最多深研市值前5只股票、一次模型请求，允许向用户配置的模型服务发送成本、股数、权重与公开资料，**不发送备注**。市值与盈亏由本机计算；遗漏标的、缺项和行情时点明确显示。应用退出或休眠期间不执行，失败不自动重试；自动报告每天最多两次请求，手动重试另行使用模型额度。交易日历当前覆盖 2025–2026，未知年份暂停自动任务。详见 [研究与提醒说明](docs/stock-research-and-alerts.md)。

默认主窗口为 1280×860，并按屏幕可用空间收缩；保留 540px 最小宽度。窄窗详情使用弹层，持仓浮窗继续独立运行。

保留场内 ETF 行情和本地持仓统计，ETF 不套用公司财报进行深度研究。基金专属页面、净值/盘中估值、筛选、诊断及共享采集已移除；旧基金记录保留但不再展示、请求或导出，旧备份仍可导入股票与自选指数部分。

## 目录

```text
.
├── app/                  # 主窗口原生前端
├── renderer/             # 持仓和提醒浮窗前端
├── src-tauri/            # Rust 桌面壳、commands、数据 gateway 和 handler
├── scripts/              # 前端准备、版本和分发 ZIP 脚本
└── dist/                 # 本地构建产物（不入库）
```

`.tauri-frontend/` 是构建前生成的静态目录，不包含旧 Node API handler。

## 开发与检查

需要 Node.js 24+、Rust stable 和平台对应的 Tauri 系统依赖。

```bash
npm install
npm start
npm run lint
npm test
npm run check
npm run smoke
```

可选真实数据检查：

```bash
RUN_LIVE_DATA=1 npm run smoke:data
```

真实数据检查受网络、休市和上游风控影响，不属于默认 CI 门禁。

## 构建

```bash
npm run build:mac:raw   # macOS arm64 .app + ZIP
npm run build:win:raw   # Windows x64 EXE + portable ZIP
```

产物输出到 `dist/`。两个分发 ZIP 执行三级水位门禁（<16 MB 健康、16–20 MB 预警、≥20 MB 阻断），同时扫描 Chromium/Node/Python/TDX 冗余运行时、记录异常大文件并生成/复核 SHA-256 与 JSON 证据；普通构建不会修改版本号。Windows portable 包依赖系统 WebView2，不携带离线运行时；现代 Windows 10/11 通常已提供，缺失时 release runtime 会显示原生提示和官方下载链接。

应用图标母版位于 `brand/app-icon-1024.png`。修改母版后运行 `npm run icons:generate`，会统一更新应用内品牌图标及 `build/icon.png`、`build/icon.icns` 和 `build/icon.ico`。

### macOS 首次打开

macOS 安装包目前未公证。若从本项目正式 Release 下载并核对 SHA-256 后，首次打开仍提示“‘恭喜发财’已损坏，无法打开”，请先将 `恭喜发财.app` 拖入“应用程序”，然后在终端执行：

```bash
sudo xattr -rd com.apple.quarantine "/Applications/恭喜发财.app"
```

按回车后输入当前 macOS 用户密码（输入时终端不会显示字符），命令完成后重新打开应用。若应用不在 `/Applications`，请将命令中的路径替换为实际位置；不要对来源不明的应用执行此命令。

## 运行与数据

前端继续通过 `window.shell` 和 `AppDataClient.fetch/fetchData` 调用桌面能力，内部传输改为 Tauri commands/events。权限仅开放事件能力，不开放任意文件系统、shell 或进程访问。

关键用户数据仍写入产品名目录下的 `config.json` v2（macOS `~/Library/Application Support/恭喜发财/config.json`，Windows `%APPDATA%\恭喜发财\config.json`），并使用原子写入和旧字段兼容。持仓成本与备注目前以本机明文配置保存，不写入诊断日志；后续存储编码迁移以 `storageEncoding` 为兼容入口。行情和新闻等 WebView 缓存可以重新拉取。

全部数据请求经过 Rust 进程内 gateway：相同在途请求合并并带 TTL 缓存；东方财富单并发、启动间隔 1–1.3 秒，403 或连续失败触发五分钟熔断；handler 保留来源、降级与不可用元数据。

主窗口刷新由前端协调器统一调度：实时行情优先、同一周期只发一个合并行情请求，普通请求并发上限为 3，页面隐藏时暂停后台刷新；迷你图按可见区域懒加载并限制为 2 个并发。持仓浮窗通过受限事件接收精简行情，启动时才回退到本地缓存。

日 K 和分时默认使用 HTTP 数据源。只有用户显式配置 `TDXRS_BIN` / `TDXRS_PYTHON` 时才启动外部 TDX 进程，安装包不包含 Python 或 TDX runtime。

数据仅供参考，不构成投资建议。
