# 检测更新与自动安装

参考本地 `server-workbench` 的 `desktop/updates.cjs` 与更新菜单（版本 `cc7047c`）：启动 30 秒后自动检查，此后每 24 小时检查；可以关闭自动检查或手动检查；发现新版后由用户确认下载，下载完成后再确认重启安装。普通退出不安装更新，不允许降级或预发行版本。

本项目沿用 Tauri 2，用 [Tauri updater](https://v2.tauri.app/plugin/updater/) 校验签名和替换应用，不引入 Electron。新增插件要求 Tauri 2.12，锁定文件中的 Tauri 依赖因此一并更新。

## 使用

设置 → 关于 → 软件更新：查看当前版本、检查更新、修改自动检查偏好。新版提示同时显示在主窗口顶部。版本说明按纯文本展示。

点击“下载更新”才开始下载，显示进度；校验失败不安装。下载完成后点击“重启并安装”，再次确认后先保存待写配置，再调用原生安装。配置保存失败会停止安装。更新包只替换应用，不包含或覆盖用户的 `config.json`、系统凭据、持仓、自选与提醒规则。

开发模式禁用网络更新与安装。macOS 支持应用包更新；Windows 自动安装仅限 NSIS 安装版，旧便携 ZIP 需要先安装一次新版安装包。当前发布目标为 macOS Apple Silicon 和 Windows x64。退出应用会丢弃尚未安装的内存下载，下次使用时重新下载，不会在普通退出时安装。

更新来源固定为本仓库 GitHub Releases 的 `latest.json`。未发布清单、平台缺失、断网、GitHub 不可达、签名错误均显示失败，可重试；不会把这些状态显示为“已是最新版本”。首次启用仍需发布含更新入口的新版本，旧版本无法凭空获得该功能。

## 原生边界

`src-tauri/src/updates.rs` 保存检查、下载、安装状态；只向主窗口提供 `update_status`、`update_preferences`、`update_check`、`update_download`、`update_install`，通过 `app-update-state` 传递进度。前端 `modules/updates.js` 负责展示及确认，不取得安装路径或下载内容。

原生更新任务独立于行情刷新，使用 updater 专用传输与签名验证。客户端不接受 renderer 提供的地址；下载起点必须属于本项目精确 HTTPS Release 路径，跳转只允许 GitHub 资产域名，限制超时、跳转次数和 128 MiB 体积。默认比较器拒绝旧版本和预发行版本。普通退出没有安装钩子。持久偏好 `fund_tracker_update_settings` 复用配置 v2 的原子写入；重新开启自动检查会在 30 秒后检查。

## 签名与构建

更新公钥位于 `tauri.conf.json`。经用户授权生成的私钥保存在仓库外：`~/.tauri/fund-tracker-desktop/updater.key`，目录权限 0700，文件权限 0600；私钥不写入文档、日志、包或 Git。请单独备份，不要把内容粘贴到聊天中。更新签名与 macOS Developer ID / Windows Authenticode 是不同机制；本项目 macOS 测试包使用临时签名，尚未新增平台证书或公证流程。

普通 `build:*:raw` 不依赖私钥。签名更新构建需要通过环境传入 `TAURI_SIGNING_PRIVATE_KEY`（路径或私钥内容）及可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：

```sh
npm run build:update:mac
npm run build:update:win
```

构建读取 `tauri.updater.conf.json`：macOS 生成已签名应用及 `.app.tar.gz` 更新包，Windows 生成按用户安装的 NSIS `.exe`；每个更新包附 `.sig`。`scripts/updater-artifacts.js` 收集为 ASCII 文件名并记录版本、公钥标识与 SHA-256；macOS 同时验证更新包内的应用签名。只有双平台文件齐全、版本与文件摘要匹配时，`npm run update:manifest` 才生成 `dist/updater/latest.json`。

## CI 与正式启用

GitHub Actions 使用 `TAURI_SIGNING_PRIVATE_KEY` Secret（对应以上私钥）及可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。经用户授权，已配置本仓库更新签名 Secret；当前私钥密码为空，不需要密码 Secret。后续更换签名密钥须同步应用公钥与发布配置，并保持既有安装版本的升级兼容。

标签 CI 验证版本与标签一致，双平台构建签名更新包并运行真实签名校验，完整清单与原有 ZIP / 校验文件一起上传 draft Release，最后公开稳定 Release 并标记 latest。缺少签名 Secret 时标签构建失败，防止发布残缺更新；已经公开的同版本资产不覆盖。正式发布仍遵守原有版本递增、标签及 CI 门禁。

## 验证

前端测试覆盖检查/下载/安装分离、取消、保存失败阻止安装、网络错误重试、偏好保存、进度及便携版限制；清单测试覆盖缺平台、错版本和文件篡改。原生测试限制下载来源。

```sh
UPDATER_ARTIFACT_DIR=dist/updater cargo test --manifest-path src-tauri/Cargo.toml updater_signed_artifact_smoke -- --nocapture
```

该 smoke 验证实际更新包签名，并确认篡改内容被拒绝，不会安装或重启应用。完整从旧版发现、下载、安装、重启、配置保留的验证，需要正式发布及独立测试安装环境；本地界面样本与签名 smoke 不代表已经完成线上升级。
