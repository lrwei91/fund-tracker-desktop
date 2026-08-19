---
name: fund-tracker-desktop
description: 用于维护恭喜发财 Tauri 桌面端的行情 gateway、Rust handler、持久配置、刷新调度、窗口功能或发布包时
version: 1.0.0
author: lrwei91
license: MIT
metadata:
  hermes:
    tags: [tauri, rust, desktop, stock-data, fund-tracker]
---

# Fund Tracker Desktop

Tauri 2 + Rust + 原生前端的行情与基金桌面工作台维护入口。

## 边界

- 保持 Tauri 2、Rust、原生 HTML/CSS/JavaScript 架构；不擅自引入 React、TypeScript、Vite 或大型状态管理。
- renderer 只能使用受限 commands/events；不扩大文件系统、shell、进程权限，新增外链必须进入精确 HTTPS allowlist。
- 行情请求复用 Rust gateway 的合并、限速、熔断、缓存、来源和降级语义；不在前端绕过 gateway 访问上游。
- 用户数据通过 `AppStorage`/Tauri command 原子写入 `config.json` v2；`localStorage` 只能做镜像或可重建缓存。
- `dist/`、`.tauri-frontend/` 和本地发布产物是生成结果，不作为源码修复目标；发布、标签、上传和远程写入需明确授权。

## 核心结构

| 功能 | 前端入口 | Rust / 数据入口 |
|---|---|---|
| 主窗口刷新 | `app/modules/refresh-coordinator.js` | 合并请求、优先级、并发和隐藏页暂停 |
| 行情与信号 | `app/modules/render-market.js`、`app/modules/render-signals.js` | `src-tauri/src/api/handlers/market.rs`、`signals.rs` |
| 自选/持仓/基金 | `app/modules/watchlist/`、`app/modules/render-funds.js`、`app/modules/render-fund-board.js` | `stock.rs`、`detail.rs`、`fund.rs` |
| API 路由 | `app/modules/data-client.js` 的 `fetch_data` | `routes.rs`、`policy.rs`、`http.rs`、`handlers/` |
| 持久化与窗口 | `app/config-schema.js`、`window.shell` | `lib.rs`、`windows.rs`、`config.rs` |

新增、删除或改名路由时，必须同步 `handlers/mod.rs`、`policy.rs`、`src-tauri/fixtures/routes.json`、前端调用、真实数据 smoke 清单和测试。

## 使用

```bash
# 开始前保护已有改动
git status --short --branch

# 基础门禁
npm run check
npm run lint
npm test

# 业务链路 smoke
npm run smoke
npm run smoke:refresh

# Rust 检查
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# 仅在明确需要时做真实数据检查或构建
RUN_LIVE_DATA=1 npm run smoke:data
npm run build:mac:raw
npm run size:check
```

真实数据检查受网络、休市和上游风控影响；失败时说明环境限制，不把它改写成代码门禁通过。

## 当前 5 大坑

### 1. 越过 Rust gateway 请求行情

**触发**：前端新增 `fetch` 直接访问上游。**表现**：绕过限速、缓存、熔断和来源元数据。**修法**：新增 handler 和 policy 路由，从 `AppDataClient` 进入，并补 fixture/smoke。

### 2. 误把未知数据渲染成确定结论

**触发**：空值、旧缓存、成交额或降级响应进入卡片。**表现**：页面把 stale/degraded 显示成最新行情或“已触发”。**修法**：保留来源和状态，区分 loading、empty、error、stale、degraded 与 prediction。

### 3. 破坏 `config.json` v2 兼容

**触发**：新增字段只改前端或直接改旧字段含义。**表现**：已有持仓、备注或窗口配置无法读取。**修法**：同步 `app/config-schema.js` 与 `src-tauri/src/config.rs`，走原子写入并保留旧字段。

### 4. 把重复定时器塞进页面模块

**触发**：行情、基金或信号新增独立 `setInterval`。**表现**：重复请求、隐藏页面仍刷新、并发超限。**修法**：接入 `refresh-coordinator.js` 的周期、优先级和暂停机制。

### 5. 把本地 build 当发布完成

**触发**：构建成功后直接宣称已发布。**表现**：没有标签、CI、Release 资产和 SHA-256 证据。**修法**：本地检查、构建、打包、上传和 Release 分开报告，未经授权不做外部操作。

## 验证清单

- [ ] 未扩大 Tauri capability、外链 allowlist 或用户数据写入范围。
- [ ] JS/Rust 改动通过相称的 lint、test、check、smoke；真实数据失败已单独标注。
- [ ] 路由或配置改动同步 owner 文件、fixture、调用方和兼容测试。
- [ ] 生成目录、版本号和已有用户改动未被顺手覆盖。
- [ ] 未提交凭据、诊断敏感信息、安装包或临时构建产物。

## references/

本 skill 无 `references/` 目录；仓库根项目规则、`README.md` 和 `docs/overview.md` 是项目真源。
