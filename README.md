# 恭喜发财桌面版

基于 Tauri 2 的本地桌面应用。保留原生 HTML/CSS/JavaScript 前端，行情代理、配置存储和窗口管理由 Rust 提供；不随包分发 Chromium、Node、Python 或 TDX runtime。

## 功能

- 大盘指数、自选股分组、持仓成本与备注、导入导出
- 分时、日 K、资金流、新闻、公告、风险与机会雷达
- 独立持仓浮窗、透明置顶提醒、提示音和 Windows 托盘
- 腾讯、同花顺、金十、财联社、东方财富、交易所、HKEX 和新浪等数据源降级

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

产物输出到 `dist/`。两个分发 ZIP 的硬门禁均为 20 MB；普通构建不会修改版本号。Windows portable 包依赖系统 WebView2，不携带离线运行时；现代 Windows 10/11 通常已提供，缺失时 release runtime 会显示原生提示和官方下载链接。

## 运行与数据

前端继续通过 `window.shell` 和 `AppDataClient.fetch/fetchData` 调用桌面能力，内部传输改为 Tauri commands/events。权限仅开放事件能力，不开放任意文件系统、shell 或进程访问。

关键用户数据仍写入产品名目录下的 `config.json` v2（macOS `~/Library/Application Support/恭喜发财/config.json`，Windows `%APPDATA%\恭喜发财\config.json`），并使用原子写入和旧字段兼容。行情和新闻等 WebView 缓存可以重新拉取。

全部数据请求经过 Rust 进程内 gateway：相同在途请求合并并带 TTL 缓存；东方财富单并发、启动间隔 1–1.3 秒，403 或连续失败触发五分钟熔断；handler 保留来源、降级与不可用元数据。

日 K 和分时默认使用 HTTP 数据源。只有用户显式配置 `TDXRS_BIN` / `TDXRS_PYTHON` 时才启动外部 TDX 进程，安装包不包含 Python 或 TDX runtime。

数据仅供参考，不构成投资建议。
