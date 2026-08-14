# AICoding 架构设计 · 行业调研报告

> 本文档为《AICoding 架构设计》核心产物之一，定位为**行业调研报告（research_report）**。
> 上游输入：主理人转交的用户诉求 + 主理人已裁决的架构事实 + `material_digest.md` 资料摘要。
> 下游输出：驱动 `business-architect`（业务架构师）的行业调研判断，最终落入《高层架构设计》§3 行业调研章节。
>
> **结构纪律**：全文按「事实 → 对比 → 建议 → 风险」四段式组织。本章节明确区分**事实 / 推断 / 建议 / 风险**：事实来自可核验公开来源或上游资料；推断为基于事实的合理推演；建议为供 `business-architect` 裁决的参考（非冻结决策）；风险为不确定性或潜在威胁。
>
> **角色声明**：本文由 `research-analyst`（研究分析师 · 查有据）产出，是 `research_report.md` 的唯一 Owner。所有取舍结论均标注为「建议」，最终业务边界冻结权归 `business-architect`；加权打分仅作评估，不构成本项目的已冻结决策。

---

## 0. 元信息：修订记录

```yaml
标题: 恭喜发财桌面版 - 行业调研报告 v1.0
版本: v1.0
状态: Approved   # Draft | Reviewing | Approved | Deprecated
创建日期: 2026-08-13
最后更新: 2026-08-13
调研人: 查有据（research-analyst）
审核人:
  - 主理人（G2 已审定）

关联文档:
  上游输入:
    - 用户诉求: 基于项目背景与资料生成完整架构方案（为 fund-tracker-desktop「恭喜发财桌面版」生成五份 AICoding 架构文档）
    - 主理人已裁决架构事实: 目标架构 = Tauri 2 + Rust；数据链路经 Rust 进程内 gateway；多源降级；原生前端；分发约束（ZIP ≤20MB、不含 Chromium/Node/Python/TDX、Windows 依赖 WebView2、macOS 未公证）
    - 资料摘要: D:/Project/fund-tracker-desktop/.workbuddy/output/material_digest.md
  下游产出:
    - 高层架构设计 §3 行业调研: 将由 business-architect 整合到此章节
```

| 版本 | 日期 | 作者 | 变更内容 | 评审状态 |
| --- | --- | --- | --- | --- |
| v1.0 | 2026-08-13 | 查有据（research-analyst） | 4 项调研问题收敛、4 家标杆盘点、加权对比矩阵、取舍建议、风险与待确认；G2 审定为实现基线 | Approved |

---

## 1. 调研问题收敛

> 调研启动前，先围绕用户诉求与主理人已裁决架构事实，收拢为明确的调研问题集合，确保调研不偏离当前项目背景（恭喜发财桌面版：Tauri 2 + Rust 本地行情工具）。

### 1.1 原始调研种子

| 编号 | 待验证论题 | 来源（用户诉求 / 主理人裁决要点） | 调研优先级 | 备注 |
| --- | --- | --- | --- | --- |
| S1 | 桌面行情/金融工具应采用何种应用外壳架构？Tauri vs Electron vs Wails/Neutralino 的取舍；Rust 进程内网关 vs 前端网关；包体积与「不携带离线运行时」约束对架构的影响 | 主理人已裁决：目标架构 = Tauri 2 + Rust；分发约束 ZIP ≤20MB、包内不含 Chromium/Node/Python/TDX | 高 | 架构范式已裁决，调研目标为验证可行性与补充证据 |
| S2 | 离线优先桌面应用的数据策略（本地缓存 / 配置原子写入 / 多源降级 / 熔断与 TTL 缓存）有哪些业界实践可借鉴 | 主理人已裁决：Rust gateway（合并在途请求 + TTL 缓存）、刷新协调器、config.json v2 原子写入；material_digest D1 §6.2/§6.3/§6.1 | 高 | 验证本项目既有的 gateway / 协调器设计合理性 |
| S3 | 多数据源聚合与可靠性（并发控制、限流、熔断、来源可追溯、空值诚实表达）的标杆做法是什么 | 主理人已裁决：东方财富单并发 + 启动间隔 1–1.3s + 403/连续失败 5 分钟熔断 + handler 保留来源/降级/不可用元数据 + null/available:false；material_digest D4 | 高 | 对照业界弹性模式查漏补缺 |
| S4 | 桌面应用的数据安全与隐私合规基线（本地配置加密、权限最小化、WebView 风险面、自动更新安全）应包含哪些控制 | 主理人已裁决：仅开放事件能力；分发约束 Windows WebView2 / macOS 未公证；material_digest D1 §6/§5.3 | 中 | 为未来安全/部署设计提供基线，资料中暂缺专门安全设计 |

### 1.2 调研问题收敛

> 将 §1.1 的种子收敛为 4 个可执行调研问题，均对齐本项目背景与已裁决事实。

| 编号 | 调研问题 | 调研对象 | 调研目标 | 预期产出 | 关联种子 |
| --- | --- | --- | --- | --- | --- |
| Q1 | 在「ZIP ≤20MB、包内不含 Chromium/Node/Python/TDX、Windows 依赖系统 WebView2」的分发约束下，Tauri 2 + Rust + 系统 WebView 的架构范式是否可行？与 Electron / Wails 在包体、运行时携带、WebView 依赖、IPC/权限模型上的差异是什么？ | Tauri 2 官方文档与对比资料、Electron 官方文档、Wails 官方站点、WebView2 文档 | 验证已裁决架构的可行性，并给出框架取舍证据 | 框架对比矩阵（§3.1）+ 范式结论（§3.2） | S1 |
| Q2 | 离线优先桌面应用的数据策略（进程内 TTL 缓存、在途请求合并、配置原子写入、多源降级、熔断）有哪些可借鉴的业界实践？本项目 Rust gateway + 刷新协调器设计是否完备？ | Azure Architecture 可靠性模式（Retry / Circuit Breaker / Cache-Aside）、本项目 material_digest（D1 §6.2/§6.3/§6.1） | 校验既有数据策略的合理性，补强缓存/降级实践 | 数据策略实践对照（§2.3 + §4.1） | S2 |
| Q3 | 多数据源聚合的可靠性模式（并发控制、限流、熔断、来源可追溯、空值诚实表达）标杆做法是什么？本项目「东方财富单并发 + 1–1.3s 间隔 + 5 分钟熔断 + 来源/降级元数据 + null/available:false」规则是否完备？ | Azure 弹性模式文献、行情类产品可靠性实践、本项目 material_digest（D4） | 校验可靠性规则完备性，识别缺口 | 可靠性规则对照（§2.3 + §4.1） | S3 |
| Q4 | 桌面应用的数据安全与隐私合规基线（本地配置加密、权限最小化、WebView 风险面、自动更新安全）应包含哪些控制？为项目未来安全/部署设计提供基线 | Tauri 安全模型 / 生命周期威胁文档、Electron 安全文档、OWASP 对齐实践、WebView2、Tauri Updater | 给出安全合规基线清单，标注已知缺口 | 安全合规基线（§2.2/§4.1 + §5.1 风险） | S4 |

> **中间确认自检（§1.2）**：本收敛方向由主理人显式给定（S1–S4 即 R1–R4），且目标架构（Tauri 2+Rust）已由主理人裁决为不可动摇前提，不存在 ≥2 种合理且未冻结的收敛理解；该收敛不影响下游边界冻结（仅确定调研范围）。故未命中协议 §2.1，且经 §2.3 反向验证 3 问（Q1 返工范围=仅本报告 §1，可控；Q2 用户/监管无感知，仅内部调研范围；Q3 与用户诉求「基于项目背景生成架构」一致）→ 不发起 `[中间确认]`。详见 §8。

---

## 2. 事实：标杆系统盘点和方案详述

> **四段式「事实」段**。只陈列调研发现的事实，不做引申建议或边界裁决。置信度标注：已核实=公开来源直接证实；推断=基于事实的合理推演；综合归纳=多来源汇总。

### 2.1 行业标杆清单

**硬指标**：≥ 3 家；至少包含 1 家头部 SaaS 代表 + 1 家开源/自研代表。

| 编号 | 标杆系统 | 厂商 / 社区 | 部署形态 | 场景覆盖 | 技术亮点 | 商业模式 | 调研来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Tauri 2 | Tauri 团队 / 开源社区（Apache-2.0 & MIT） | 桌面（Win/macOS/Linux）+ 移动（iOS/Android, v2 GA） | 轻量跨平台桌面/移动应用，系统 WebView 渲染 | Rust 核心 + 系统 WebView、声明式权限/能力/作用域(PCS)、内置 IPC、官方 Updater、v2 经第三方安全审计 | 开源（无授权费） | https://v2.tauri.app ；https://v2.tauri.app/security/ |
| B2 | Electron | OpenJS Foundation / GitHub·Microsoft（MIT） | 桌面（Win/macOS/Linux），无官方移动 | 通用桌面应用；驱动 VS Code / Slack / Discord / Figma 等头部 SaaS 桌面端 | 内嵌 Chromium + Node.js 主从进程、contextIsolation、进程沙箱、contextBridge 白名单 API | 开源框架（驱动众多头部 SaaS 桌面端，本身无授权费） | https://electronjs.org/docs/latest/tutorial/security |
| B3 | Wails 3 | Wails 团队 / 开源社区（MIT） | 桌面（Win/macOS/Linux），iOS 仅预览 | Go 后端 + 系统 WebView 的轻量桌面应用 | 系统 WebView 渲染、Go 单一二进制、清单式(manifest)权限 | 开源（无授权费） | https://wails.io/ |
| B4 | TradingView（桌面端） | TradingView Inc.（头部 SaaS） | SaaS + 桌面客户端（Win/macOS/Linux）+ 移动端 | 跨资产实时行情图表与交易社交平台，个人/专业交易者 | 实时/历史行情、多屏工作区、标签同步、跨设备同步、订阅分级 | 订阅制（freemium → 付费 tier），头部 SaaS | https://www.tradingview.com/desktop/ |

> 说明：B1、B3 为开源/自研代表；B4 为头部 SaaS 代表；B2 为开源框架但事实上是头部 SaaS 桌面端的事实标准（满足「头部 SaaS 生态」参照）。四家共同覆盖 R1（框架范式）、R2（数据策略产品参照）、R3（可靠性产品参照）、R4（安全模型参照）。

### 2.2 标杆方案详述

#### 2.2.1 B1 - Tauri 2

| 维度 | 内容 | 置信度 |
| --- | --- | --- |
| 产品定位 | 用 Rust 编写核心逻辑、使用操作系统原生 WebView 渲染 UI 的轻量跨平台桌面/移动应用框架 | 已核实 |
| 目标用户 | 需要小体积、高安全、跨平台桌面/移动应用的开发者 | 已核实 |
| 核心能力 | 系统 WebView 渲染、Rust 进程内业务逻辑、声明式权限/能力/作用域(PCS)访问控制、内置 IPC（commands/events）、官方自动更新插件、30+ 插件生态 | 已核实 |
| 架构特点 | 单一 Rust 核心进程管理多个 WebView；WebView 库在运行时由操作系统动态链接而非打包进二进制；前端经 commands/events 与核心通信，能力由 capabilities 配置约束；核心代码拥有全部系统权限，WebView 代码仅能通过已定义 IPC 层访问被暴露的资源 | 已核实 |
| 部署形态 | 桌面（Windows/macOS/Linux）+ 移动（iOS/Android，v2 GA）；Windows 依赖系统 WebView2，macOS 用 WKWebView，Linux 用 WebKitGTK | 已核实 |
| 集成方式 | Tauri commands/events + 插件系统；前端可为任意 HTML/CSS/JS 栈 | 已核实 |
| 定价模式 | 开源（Apache-2.0 / MIT 双许可），无授权费 | 已核实 |
| 优势 | 包体极小（hello world 约 600KB）、内存占用低、不携带 Chromium/Node 运行时、PCS 最小权限模型、v2 经 Radically Open Security 独立安全审计、WebView 安全补丁由 OS 维护者更快推送 | 综合归纳 |
| 局限 | 前端栈需自行加固 CSP/隔离；Rust 生态相对 Electron 的 npm 生态更年轻；不打包 WebView 导致跨平台渲染略有差异（webview drift） | 已核实 + 推断 |
| 对本项目的参考价值 | 与已裁决的 Tauri 2+Rust 架构及「包内不含 Chromium/Node、ZIP ≤20MB」分发约束高度契合；PCS 模型直接支撑「仅开放事件能力」的权限最小化要求 | 推断 |

#### 2.2.2 B2 - Electron

| 维度 | 内容 | 置信度 |
| --- | --- | --- |
| 产品定位 | 用 Web 技术构建跨平台桌面应用的框架，内嵌 Chromium 与 Node.js 运行时 | 已核实 |
| 目标用户 | 需复用 Web 技术栈、构建功能丰富桌面应用的团队；VS Code / Slack / Discord / Figma 等头部 SaaS 桌面端 | 已核实 |
| 核心能力 | 主进程 + 渲染进程模型、Node.js 完整能力、预加载脚本 + contextBridge 受限 API 暴露、进程沙箱、自动更新（electron-updater）、代码签名 | 已核实 |
| 架构特点 | 每个应用内嵌完整 Chromium（约 85–150MB）与 Node.js 运行时；渲染进程默认启用 sandbox 与 contextIsolation，Node 集成默认关闭；经 contextBridge 暴露白名单 API | 已核实 |
| 部署形态 | 桌面（Windows/macOS/Linux）；无官方移动支持 | 已核实 |
| 集成方式 | main.js / preload.js / renderer 三栈；contextBridge 暴露白名单函数 | 已核实 |
| 定价模式 | 开源（MIT），无授权费 | 已核实 |
| 优势 | 生态最成熟、文档与招聘面广、Chromium 版本随应用固定可预期、安全加固清单清晰（contextIsolation / sandbox / CSP / 最小权限 IPC） | 综合归纳 |
| 局限 | 包体大（150–300MB）、内存占用高（200–500MB）、携带 Chromium/Node 运行时、Node 默认全权限需谨慎加固 | 已核实 |
| 对本项目的参考价值 | 作为对照框架，验证「内嵌 Chromium + Node」与本项目「不含 Chromium/Node、ZIP ≤20MB」约束直接冲突，故不采纳；但其安全加固清单（contextIsolation / sandbox / CSP / 最小权限 IPC / 系统钥匙串存密）可借鉴到本项目 WebView 风险面与本地密钥治理 | 推断 |

#### 2.2.3 B3 - Wails 3

| 维度 | 内容 | 置信度 |
| --- | --- | --- |
| 产品定位 | 用 Go 编写后端、系统 WebView 渲染前端的轻量跨平台桌面框架 | 已核实 |
| 目标用户 | Go 技术栈、追求小体积原生体验的桌面开发者 | 已核实 + 推断 |
| 核心能力 | 系统 WebView 渲染、Go 后端绑定、清单式(manifest)权限、CLI 构建打包 | 已核实 + 推断 |
| 架构特点 | 与 Tauri 同属「系统 WebView + 原生后端」范式，后端语言为 Go 而非 Rust | 推断（基于 Wails 公开定位） |
| 部署形态 | 桌面（Windows/macOS/Linux）；iOS 仅预览 | 推断 |
| 集成方式 | Go 后端暴露绑定给前端；手动更新 | 推断 |
| 定价模式 | 开源（MIT） | 已核实 + 推断 |
| 优势 | 包体小（约 10–30MB）、不携带 Chromium、Go 编译为单一二进制 | 综合归纳（基于对比资料） |
| 局限 | 生态小于 Tauri/Electron；Wails 3 较新；后端语言为 Go，与本项目已裁决的 Rust 栈不符 | 推断 |
| 对本项目的参考价值 | 验证「系统 WebView + 极小包体 + 清单式权限」范式可行，但语言栈（Go vs Rust）与本项目已裁决事实不符，故仅部分借鉴其范式而非直接采用 | 推断 |

#### 2.2.4 B4 - TradingView（桌面端）

| 维度 | 内容 | 置信度 |
| --- | --- | --- |
| 产品定位 | 订阅制（SaaS）的跨资产实时行情图表与交易社交交易平台，提供 Web / 移动 / 桌面多端 | 已核实 |
| 目标用户 | 个人与专业交易者，需要多屏、实时图表、自选与提醒 | 已核实 |
| 核心能力 | 实时/历史行情、多标的图表、多显示器工作区、标签符号同步、跨设备同步布局/自选/设置 | 已核实 |
| 架构特点 | 桌面端为原生壳承载 Web 图表引擎；内部聚合多交易所/数据源（公开资料未披露具体架构，推断为服务端聚合 + 客户端轻量缓存） | 推断 |
| 部署形态 | SaaS + 桌面客户端（Windows/macOS/Linux）+ 移动端；订阅分级（free / Essential / Premium） | 已核实 |
| 集成方式 | 云端账号体系 + 客户端；行情数据经其服务端 | 已核实 + 推断 |
| 定价模式 | 订阅制（freemium → 付费 tier） | 已核实 |
| 优势 | 实时多源行情产品化成熟、轻量桌面体验、跨设备一致性 | 综合归纳 |
| 局限 | 闭源 SaaS，内部架构不可直接复用；数据口径与合规由其自有规则约束 | 推断 |
| 对本项目的参考价值 | 作为「桌面行情工具」产品范式标杆，验证实时多源行情 + 轻量桌面壳 + 跨设备同步的产品形态可行；其「数据仅供参考」免责思路与本项目 D1 §6.5 一致 | 推断 |

### 2.3 关键技术能力横向事实

> 不评分、不排序，仅按能力维度横陈各方案事实（置信度见 §2.2；下表「来源」指向可核验资料）。

| 能力维度 | B1 Tauri 2 | B2 Electron | B3 Wails 3 | B4 TradingView | 说明 / 来源 |
| --- | --- | --- | --- | --- | --- |
| 包体 / 运行时携带 | 系统 WebView，hello world 约 600KB，无 Chromium/Node | 内嵌 Chromium 约 85–150MB + Node.js，安装包 150–300MB | 系统 WebView，约 10–30MB，无 Chromium | SaaS 客户端，具体包体未公开 | 来源：https://v2.tauri.app ；https://hivebook.wiki/wiki/tauri-2x-rust-desktop-and-mobile-apps-with-a-web-frontend ；https://wails.io/ |
| 进程 / IPC 与权限模型 | Rust 核心 + WebView，PCS 声明式权限/能力/作用域，capabilities 绑定窗口/WebView | 主/渲染进程，contextIsolation(默认) + 沙箱(默认) + contextBridge 白名单 | Go 后端 + 清单式(manifest)权限 | 云端账号 + 客户端壳（闭源） | 来源：https://v2.tauri.app/security/ ；https://electronjs.org/docs/latest/tutorial/security |
| 自动更新安全 | 官方 Updater 插件：构建期私钥签名 + 运行期公钥验证 + 端点强制 HTTPS，验证不可禁用（不依赖 TUF） | electron-updater + 代码签名 | 手动更新 | 服务端推送（闭源） | 来源：https://v2.tauri.app/plugin/updater/ ；https://electronjs.org/docs/latest/tutorial/security |
| 离线 / 缓存策略 | 进程内缓存 + 本地存储（项目侧实现网关 TTL） | 同左（应用自实现） | 同左 | 客户端轻量缓存 + 服务端聚合 | 来源：本项目 material_digest D1 §6.2 + Azure Cache-Aside（https://learn.microsoft.com/zh-cn/Azure/best-practices-caching） |
| 多源可靠性（熔断/限流/降级/来源追溯） | 需自实现（本项目 Rust gateway 已落地单并发/熔断/来源元数据） | 需自实现 | 需自实现 | 服务端聚合（闭源，不可直接复用） | 来源：本项目 material_digest D4 + Azure 弹性模式（https://learn.microsoft.com/en-us/azure/architecture/web-apps/guides/enterprise-app-patterns/reliable-web-app/java/guidance） |
| 安全审计 / 威胁模型 | v2 经 Radically Open Security 独立审计 + 应用生命周期威胁文档 | 安全清单 + 社区审计工具(electronegativity) | 未明确公开 | 未公开 | 来源：https://v2.tauri.app/security/lifecycle/ ；https://electronjs.org/docs/latest/tutorial/security |

---

## 3. 对比：对比矩阵与加权评分

> **四段式「对比」段**。在 §2 的事实基础上建立对比矩阵，赋予权重并打分。评分仅作评估，不构成本项目已冻结决策。

### 3.1 对比矩阵

> **每行权重之和 = 1.00**。评估维度与权重依据本项目已裁决事实（分发约束、权限最小化、未来安全设计）设定；默认值即适用，未做反转性调整。

| 评估维度 | 权重 | 权重理由 | B1 Tauri 2 | B2 Electron | B3 Wails 3 |
| --- | --- | --- | --- | --- | --- |
| 场景契合度 | 0.30 | 本项目已裁决 Tauri 2+Rust 且分发约束为「ZIP ≤20MB、不含 Chromium/Node/Python/TDX」，框架是否贴合该约束决定可行性，权重最高 | 5 | 1 | 4 |
| 技术成熟度 | 0.20 | 框架生态、文档、招聘面与稳定版本可用性影响落地风险 | 4 | 5 | 3 |
| 集成难度（反向，越高越易） | 0.15 | 项目已有 src-tauri Rust 工程，与既有栈的契合度决定集成成本 | 5 | 3 | 3 |
| 成本（反向，越高越省） | 0.15 | 包体/运行时成本与「20MB ZIP 硬门禁、不携带离线运行时」直接相关 | 5 | 1 | 5 |
| 合规可控性 | 0.20 | 权限最小化、WebView 风险面、自动更新安全对应 R4 与已裁决「仅开放事件能力」 | 5 | 3 | 4 |
| **加权总分** | **1.00** | — | **4.80** | **2.50** | **3.80** |

**评分标尺**：每项 1~5 分，1 = 严重不符合，3 = 基本满足但存在明显局限，5 = 完美契合。反向维度（集成难度、成本）分数越高代表越易集成/越省成本。

**加权总分计算**：
- B1 Tauri 2 = 0.30×5 + 0.20×4 + 0.15×5 + 0.15×5 + 0.20×5 = 1.50 + 0.80 + 0.75 + 0.75 + 1.00 = **4.80**
- B2 Electron = 0.30×1 + 0.20×5 + 0.15×3 + 0.15×1 + 0.20×3 = 0.30 + 1.00 + 0.45 + 0.15 + 0.60 = **2.50**
- B3 Wails 3 = 0.30×4 + 0.20×3 + 0.15×3 + 0.15×5 + 0.20×4 = 1.20 + 0.60 + 0.45 + 0.75 + 0.80 = **3.80**

### 3.2 评分结论

> 基于 §3.1 加权总分，形成分层结论。每层结论引用得分作为依据；结论为「建议」，最终框架采纳与否由 `business-architect` 冻结。

- **优先借鉴**：**Tauri 2（B1）** — 适用度评分：4.80（最高）。理由：场景契合度 5/5（系统 WebView、不携带 Chromium/Node、hello world 约 600KB，直接满足已裁决分发约束）；集成难度 5/5（与既有 Rust 工程一致）；成本 5/5（极小包体、无运行时授权费）；合规可控性 5/5（PCS 权限模型、v2 独立安全审计、不打包 WebView 的安全收益）；技术成熟度 4/5（v2 GA 但生态较 Electron 年轻）。与已裁决架构一致。
- **部分借鉴**：**Wails 3（B3）** — 借鉴点：验证「系统 WebView + 极小包体（约 10–30MB）+ 清单式权限」范式可行，其轻量与权限思路可印证本项目方向。不借鉴的部分：后端语言为 Go，与本项目已裁决的 Rust 栈不符，不直接采用。评分：3.80（场景契合度 4、成本 5、合规 4，但技术成熟度 3、集成难度 3 受语言栈差异拖累）。
- **不借鉴（否决）**：**Electron（B2）** — 否决理由：场景契合度 1/5、成本 1/5——内嵌 Chromium（约 85–150MB）+ Node.js 运行时，与本项目「分发 ZIP 硬门禁 20MB、包内不含 Chromium/Node」的已裁决分发约束直接冲突，无法在不违反约束的前提下采纳。评分：2.50。其安全加固清单（contextIsolation / sandbox / CSP / 最小权限 IPC / 系统钥匙串存密）仍可作为本项目 WebView 风险面治理的参考，但不改变「不采用 Electron 框架」的结论。

### 3.3 方案组合分析

| 组合方式 | 覆盖哪些能力 | 未覆盖能力 | 组合复杂度 | 总体成本估算 |
| --- | --- | --- | --- | --- |
| Tauri 2（框架底座） + 自研 Rust gateway（弹性模式：Retry / Circuit Breaker / Cache-Aside） + TradingView 范式参考（产品形态） | R1 框架范式、R2 离线数据策略、R3 多源可靠性、R4 权限最小化与 Updater 安全基线 | 自动更新通道的商务与成本归属（需安全/部署设计定稿）；本地配置加密的具体密钥管理（需安全设计定稿）；macOS 公证（需商务决策） | 中 | 仅 Tauri 开源免费 + 自研人力；无框架授权费 |

> 说明：B4 TradingView 为产品范式参考，不参与技术栈采纳评分（§3.1 仅评估可采纳的框架 B1/B2/B3）；其价值在于用成熟 SaaS 产品印证「实时多源行情 + 轻量桌面壳」形态可行。

---

## 4. 建议：取舍决策支持

> **四段式「建议」段**。基于 §2 事实 + §3 对比，给出可被 `business-architect` 直接采用的建议。本节是建议而非最终裁决，最终边界由业务架构师冻结。

### 4.1 自研 / 采购 / 复用边界建议

| 能力项 | 建议方式 | 建议依据 | 候选方案 / 系统 | 关键前提 |
| --- | --- | --- | --- | --- |
| 桌面应用外壳框架 | 复用（已有底座） | 主理人已裁决目标架构 = Tauri 2 + Rust；§3.2 优先借鉴 Tauri（4.80），与分发约束契合 | Tauri 2 | 保持 Rust gateway 位置（已裁决），不回退 Electron |
| 进程内数据网关（gateway：合并在途请求 + TTL 缓存 + 熔断 + 来源元数据） | 自研 | 各行情源协议私有、无现成采购方案；本项目 src-tauri 已有 gateway 雏形，需参照弹性模式落地 Retry/Circuit Breaker/Cache-Aside | 自研 Rust gateway（参照 Azure 弹性模式） | 复用 src-tauri 现有结构；补充退避抖动与半开探测 |
| 刷新协调器（实时优先 / 并发上限 3 / 隐藏暂停 / 迷你图懒加载限 2 并发） | 自研 | 项目已有前端协调器设计（material_digest D1 §6.3），与 Tauri 事件能力对齐 | 前端协调器（沿用并加固） | 仅开放事件能力，不开放任意文件系统/shell |
| 多数据源适配（腾讯/东方财富/同花顺/HKEX/金十/财联社/新浪/沪深交易所/深交所 handler） | 自研 + 复用路由设计 | 各源协议私有，无统一采购；D4 路由表已定义主备源与降级；需保留来源/降级/不可用元数据 | 自研 handler（复用 D4 路由表） | 以 D4 为基线，运行时动态降级；空值用 null/available:false |
| 配置存储（config.json v2 原子写入 + 旧字段兼容） | 复用（已有实现） | 项目已有 v2 原子写入与旧字段兼容（D1 §6.1）；符合「原子写入防损坏」业界实践 | 现有 config.json v2 机制 | 保持迁移/旧字段兼容 |
| 本地配置加密（持仓成本/备注等敏感字段） | 复用（OS 能力） | R4 基线要求：不在明文文件存密；Electron 生态实践推荐系统钥匙串 | OS Keychain / 凭据管理器（Windows Credential Manager / macOS Keychain） | 需安全设计定稿密钥管理策略（见 U-02） |
| 自动更新 | 复用（生态插件） | Tauri Updater 强制签名验证 + HTTPS 端点（§2.2.1/§2.3），满足 R4 更新安全 | tauri-plugin-updater | 配置 endpoints HTTPS + 签名密钥管理（见 D-01） |
| 行情/可视化 UI | 自研 | 主理人已裁决保留原生 HTML/CSS/JavaScript 前端 | 现有原生前端 | 经 Tauri commands/events 桥接，仅开放事件能力 |

### 4.2 MVP 范围建议

> 对齐用户诉求中隐含的产品功能（源自 material_digest D1 §2 功能清单 + 已裁决架构）。用户原始诉求为「生成完整架构方案」，故 MVP 指产品首版可交付的核心能力。

| 功能（对齐用户诉求 / D1 §2） | 建议 MVP？ | 理由 |
| --- | --- | --- |
| 大盘指数 / 自选股分组 / 持仓成本与备注 | ✅ | 核心数据模型 + 本地 config.json v2 已具备；Tauri 2 + Rust 可直接承载（B1 场景契合度 5/5） |
| 分时 / 日K / 资金流 / 新闻 / 公告 | ✅ | Rust gateway 多源聚合 + TTL 缓存 + 降级已覆盖（D4 路由表）；MVP 即可接入主源 |
| 风险与机会雷达（前 8 名深度分析） | ✅ | D4 §2.5 已定义「仅深度分析前 8 名、覆盖率与缺失来源」规则，可在 MVP 落地 |
| 独立持仓浮窗 / 透明置顶提醒 / 提示音 / Windows 托盘 | ✅ | Tauri 2 原生支持菜单/托盘/多窗口（B1 能力），与已裁决架构一致 |
| 多数据源降级（腾讯主源 + 东方财富/同花顺等备用） | ✅ | D4 路由表 + gateway 熔断已在架构内；属 MVP 必备可靠性 |
| 导入 / 导出 | ⚠️（MVP 后） | 涉及文件权限与外部格式，建议在 MVP 后补足，避免过早扩大权限面 |
| 自动更新通道（CrabNebula / 自托管） | ❌（完整版） | 涉及签名密钥管理、更新服务器商务与成本（U-03），建议放到部署/安全设计阶段 |
| macOS 公证发行 | ❌（完整版） | 涉及 Apple Developer ID 年费与公证流程（U-03），MVP 先走 ZIP + 文档化 xattr 步骤 |

### 4.3 技术栈参考建议

| 技术层 | 推荐方案 | 替代方案 | 选择理由 |
| --- | --- | --- | --- |
| 应用外壳框架 | Tauri 2 | Electron（否决，包体/运行时冲突）、Wails 3（语言栈不符） | 系统 WebView + 极小包体 + PCS 权限 + 已裁决 Tauri 2+Rust；§3.2 评分 4.80 |
| 进程内网关语言 | Rust（tokio + reqwest） | Go（Wails 后端） | 已裁决 Rust，内存安全；与既有 src-tauri 一致 |
| 缓存策略 | 进程内 TTL 缓存 + 本地磁盘缓存（Cache-Aside 模式） | 无缓存（否决） | 离线优先 + 减少上游请求；Azure Cache-Aside 验证可行 |
| 可靠性模式 | 自实现 Retry + Circuit Breaker + Cache-Aside（Rust crate：如 tokio_retry / circuit-breaker 类库） | Resilience4j（Java，不适用）、Polly（.NET，不适用） | 进程内轻量，匹配 Rust 生态与 gateway 位置 |
| 本地密钥存储 | OS Keychain / 凭据管理器（keychain 风格） | 明文文件（否决）、纯自研加密 | 不将秘密存明文；Electron 安全实践同构（系统钥匙串） |
| 自动更新 | tauri-plugin-updater（强制签名 + HTTPS） | 自研更新器（否决） | 签名验证不可禁用、端点强制 TLS，满足 R4 更新安全 |

---

## 5. 风险与待确认项

> **四段式「风险」段**。列出调研中发现的主要风险、不确定信息、待业务架构师进一步裁决的依赖项，以及仍需人工补充调研的部分。

### 5.1 主要风险清单

| 编号 | 风险描述 | 触发条件 | 影响范围 | 严重程度 | 缓解建议 |
| --- | --- | --- | --- | --- | --- |
| R-01 | Windows 依赖系统 WebView2，目标机缺失时首次打开失败 | 目标 Windows 机器未安装/禁用 Edge WebView2 | Windows 分发与首次运行 | 中 | README 已说明缺失时显示原生提示与官方下载链接（D1 §5.1）；构建时可评估 Fixed Version 分发（但会增加包体，与 20MB 门禁冲突，需权衡，见 D-03） |
| R-02 | macOS 安装包未公证，正式 Release 触发隔离拦截 | 用户直接打开未公证 .app | macOS 分发信任 | 中 | 文档化 `xattr -rd com.apple.quarantine` 步骤（D1 §5.3）；长期建议申请 Apple Developer ID 公证（商务/成本决策，见 U-03） |
| R-03 | 多上游数据源限流/风控（403/429/5xx），触发熔断影响行情可用性 | 上游风控、网络抖动或批量请求 | 实时数据可用性 | 高 | 已设计熔断 + 多源降级 + 来源元数据（D4）；建议补充退避抖动与半开探测（已部分在 D4 §2.2）；监控来源健康度，缺失来源返回 null/available:false（D4 §2.4） |
| R-04 | 包内不含 Chromium/Node/Python/TDX，TDX 仅显式配置外部进程 | 用户未配置 TDXRS_BIN/TDXRS_PYTHON | 日K/分时加速能力（非核心） | 低 | 默认走 HTTP 数据源，TDX 为可选加速（D1 §6.4）；UI 提示配置方式，不影响主路径 |
| R-05 | 本地 config.json 含持仓成本/备注等敏感数据，明文存储有泄露风险 | 设备被他人访问或文件被导出 | 用户隐私 | 中 | 建议敏感字段经 OS Keychain 或加密落盘（§4.1/§4.3）；v2 原子写入已防损坏，但需叠加加密层（见 U-02、D-02） |
| R-06 | 自动更新端点若失陷可投毒（伪造更新包） | 更新服务器/构建服务器被控 | 供应链与全量用户 | 高 | Tauri Updater 强制签名 + 端点强制 HTTPS（§2.3）；私钥存硬件令牌；端点容错（仅非 2XX 才试下一个）；需安全设计定稿密钥管理（见 D-01） |

### 5.2 待确认项（需主理人 / 业务方反馈）

| 编号 | 待确认项 | 不确定性说明 | 若无法确认的备选路径 |
| --- | --- | --- | --- |
| U-01 | 各公开第三方数据源（腾讯/东方财富/同花顺/HKEX/金十/财联社/新浪/沪深交易所/深交所）的实时可用性、字段与时序稳定性，以及是否允许 redistribution 使用 | 受网络、休市与上游风控影响，无公开 SLA；版权/合规边界资料未明确 | 以 D4 路由表为基线，运行时动态降级并标注「数据仅供参考」（D1 §6.5）；仅展示来源链接，不缓存超时正文 |
| U-02 | 本地 config.json 敏感字段（持仓成本、备注）是否需加密落盘，及采用何种密钥管理（OS Keychain vs 自研 AES-GCM + 设备绑定） | 当前资料仅规定原子写入与旧字段兼容，未规定加密 | 默认 OS Keychain；否则 AES-GCM + 设备绑定密钥；需业务方确认隐私合规基线 |
| U-03 | macOS 公证与自动更新通道（CrabNebula 云 / 自托管 JSON）的商务与成本归属 | 涉及 Apple Developer 年费、更新服务器/云服务成本 | 先 ZIP 分发 + 文档化 xattr；更新走 Tauri Updater 自托管静态 JSON（GitHub Releases/S3） |
| U-04 | 上游快讯内容（金十/财联社等）的版权与合规边界 | 资料未明确快讯正文的使用与缓存时限 | 仅展示来源链接与摘要，不长期缓存正文；以来源官方页面为准 |

### 5.3 需业务架构持续关注的依赖项

| 编号 | 依赖项 | 说明 | 建议关注阶段 |
| --- | --- | --- | --- |
| D-01 | 若采用 Tauri Updater，需确定更新服务器与签名密钥管理 | 见 §4.3、§5.1 R-06；签名私钥安全存储与端点 HTTPS 是供应链安全关键 | 高层架构设计 §5.2 / 安全设计 / 部署设计 |
| D-02 | 本地配置加密与权限最小化需嵌入安全设计 | 见 §4.1、§5.1 R-05；与「仅开放事件能力」的已裁决权限模型协同 | 安全设计 |
| D-03 | Windows WebView2 运行时依赖与 Fixed Version 分发权衡（增包体 vs 兼容性） | 见 §5.1 R-01；Fixed Version 会突破 20MB 门禁，需与分发约束权衡 | 部署设计 |

---

## 6. 关键来源目录

> 集中列出全部调研所使用的公开资料、官方文档、社区仓库、分析报告等。每条来源不低于 URL 粒度，关键数据指定来源章节/段落。

**硬指标**：≥ 3 条来源，至少覆盖每家标杆；关键数据必须指定来源段落/图表位置。

| 编号 | 来源类型 | 标题 / 名称 | URL / 路径 | 相关章节 | 最后访问日期 |
| --- | --- | --- | --- | --- | --- |
| SR-01 | 官方文档 | Tauri 2 官方站点（包体 ~600KB、系统 WebView、跨平台） | https://v2.tauri.app | B1, §2.1, §2.2.1, §3.1 | 2026-08-13 |
| SR-02 | 官方文档 | Tauri Security（信任边界、PCS 权限/能力/作用域、不打包 WebView 的安全收益、CSP、隔离模式） | https://v2.tauri.app/security/ | B1, §2.2.1, §2.3, §4.1, R4 | 2026-08-13 |
| SR-03 | 官方文档 | Tauri Updater 插件（构建期私钥签名 + 运行期公钥验证 + 端点强制 HTTPS，验证不可禁用） | https://v2.tauri.app/plugin/updater/ | B1, §2.3, §4.1, §4.3, R-06 | 2026-08-13 |
| SR-04 | 官方文档 | Tauri Application Lifecycle Threats（上游/构建/分发/运行时威胁、代码签名、供应链） | https://v2.tauri.app/security/lifecycle/ | B1, §2.3, §4.1, R-06 | 2026-08-13 |
| SR-05 | 对比资料 | Tauri 2.x vs Electron/Wails/Neutralino 对比表（包体、后端语言、权限模型、自动更新） | https://hivebook.wiki/wiki/tauri-2x-rust-desktop-and-mobile-apps-with-a-web-frontend | B1/B2/B3, §2.3, §3.1 | 2026-08-13 |
| SR-06 | 官方文档 | Electron Security（contextIsolation 默认、进程沙箱默认、禁用 Node 集成、preload/contextBridge 白名单） | https://electronjs.org/docs/latest/tutorial/security | B2, §2.2.2, §2.3, §4.1 | 2026-08-13 |
| SR-07 | 官方文档 | Electron Context Isolation（隔离预加载上下文、contextBridge 安全暴露） | https://www.electronjs.org/docs/latest/tutorial/context-isolation | B2, §2.2.2, §4.1 | 2026-08-13 |
| SR-08 | 官方站点 | Wails 官方站点（Go + 系统 WebView 轻量桌面框架） | https://wails.io/ | B3, §2.1, §2.2.3, §2.3 | 2026-08-13 |
| SR-09 | 产品页 | TradingView Desktop（实时多源行情、多屏工作区、跨设备同步、订阅制） | https://www.tradingview.com/desktop/ | B4, §2.1, §2.2.4, §3.3 | 2026-08-13 |
| SR-10 | 官方文档 | Microsoft Edge WebView2（系统组件、Evergreen 分发、Windows 10/11 支持） | https://learn.microsoft.com/en-us/microsoft-edge/webview2/ | R1, R-01, §4.1 | 2026-08-13 |
| SR-11 | 架构指南 | Azure Architecture — Reliable Web App Pattern（Retry / Circuit Breaker / Cache-Aside 模式） | https://learn.microsoft.com/en-us/azure/architecture/web-apps/guides/enterprise-app-patterns/reliable-web-app/java/guidance | R2/R3, §2.3, §4.1, §4.3 | 2026-08-13 |
| SR-12 | 架构指南 | Azure 缓存指南（Cache-Aside + Circuit Breaker 回退、本地/共享缓存分层） | https://learn.microsoft.com/zh-cn/Azure/best-practices-caching | R2, §2.3, §4.1 | 2026-08-13 |
| SR-13 | 安全实践 | Electron 安全指南（系统钥匙串存密 keytar、CSP、导航校验、IPC 校验） | https://blog.hashhackers.com/blog/electron-security-guide | R4, §4.1, §4.3 | 2026-08-13 |
| SR-14 | 上游资料 | 恭喜发财桌面版 - 资料摘要 material_digest.md（D1–D4 事实、冲突 X1–X3、缺失点） | D:/Project/fund-tracker-desktop/.workbuddy/output/material_digest.md | 全局（已裁决事实基线） | 2026-08-13 |

---

## 7. 硬指标清单

> 汇总本模板所有章节的硬指标，供自动校验与人工审核使用。

| 章节 | 硬指标项 | 当前状态 | 备注 |
| --- | --- | --- | --- |
| §1 | 调研问题已收敛为 ≥ 3 条可执行问题 | ✅ | Q1–Q4，对齐 R1–R4 与已裁决事实 |
| §2.1 | 标杆系统 ≥ 3 家，含 ≥ 1 家头部 SaaS | ✅ | B1–B4；B4 TradingView 为头部 SaaS |
| §2.1 | 标杆系统 ≥ 1 家开源或自研代表 | ✅ | B1 Tauri（开源）、B3 Wails（开源） |
| §2.2 | 每家标杆有独立详述卡片 | ✅ | B1–B4 各 10 维表，标注置信度 |
| §2.3 | 关键能力横向事实无遗漏 | ✅ | 6 能力维度横陈 B1–B4 |
| §3.1 | 对比矩阵含 5 维度 + 权重 + 评分 | ✅ | 权重和 = 1.00；B1 4.80 / B2 2.50 / B3 3.80 |
| §3.2 | 评分结论含优先/部分/不借鉴三层 | ✅ | 优先 Tauri / 部分 Wails / 不借鉴 Electron |
| §4.1 | 自研/采购/复用边界有明确建议 | ✅ | 8 能力项建议表 |
| §4.2 | MVP 范围建议与用户诉求对齐 | ✅ | 对齐 D1 §2 功能清单 |
| §5.1 | 主要风险 ≥ 3 条，有缓解建议 | ✅ | R-01–R-06，均含缓解建议 |
| §6 | 关键来源可追溯（URL / 章节） | ✅ | SR-01–SR-14，≥3 条含 URL |
| 全文 | 明确区分事实 / 推断 / 建议 / 风险 | ✅ | 置信度标注 + 四段式结构 |
| 全文 | 不存在编造来源或占位符 | ✅ | 来源均为可核验 URL/路径；全文无占位符或示例前缀残留 |

---

## 8. 中间确认自检记录（协议 §2.4）

> 本节为元信息附录，记录本阶段关键决策点的中间确认自检结果，供主理人在 G3~G5 审核弹窗中追溯。结论：全程未命中协议 §2.1 / §2.2，未发起 `[中间确认]`。

### 8.1 §1.2 调研问题收敛自检

- **§2.1 判定**：未命中。收敛方向由主理人显式给定（S1–S4 = R1–R4），目标架构 Tauri 2+Rust 为已裁决不可动摇前提，不存在 ≥2 种合理且未冻结的收敛理解；该收敛仅确定调研范围，不影响下游业务边界冻结。
- **§2.3 反向验证 3 问**：
  - Q1（3 个月后被推翻的返工成本）：返工范围 = 仅本报告 §1（调研问题列表），切换成本 = 0 人月（仅为调研范围描述，不改架构/代码）。→ 可控。
  - Q2（用户/客户/监管是否感知）：仅内部调研范围调整，用户/客户/监管均无可感知的功能/合同/合规变化。→ 感知不到。
  - Q3（与用户原始诉求显式能力是否一致）：用户诉求为「基于项目背景与资料生成完整架构方案」（主理人转交原文），调研问题 Q1–Q4 均对齐该诉求与已裁决事实，未改变产品形态或对外承诺。→ 一致。

### 8.2 §2.1 标杆候选名单自检

- **§2.1 判定**：未命中。候选范围由 4 个调研方向（R1–R4）明确界定（桌面框架 / 离线数据 / 多源可靠性 / 桌面安全），可选标杆（Tauri/Electron/Wails/TradingView + 弹性模式文献）均落在该范围内；名单选择属可逆的研究证据收集，不冻结下游业务边界，无需用户裁决取舍标准。
- **§2.3 反向验证 3 问**：
  - Q1：若推翻标杆名单，仅重写本报告 §2 事实章节，不影响架构/代码，返工不超过本报告 10%。→ 可控。
  - Q2：标杆名单不向用户/客户/监管暴露，无可感知变化。→ 感知不到。
  - Q3：名单服务于调研证据，未变更用户诉求显式能力。→ 一致。

### 8.3 §3.1 权重分配自检

- **§2.1 判定**：未命中。采用模板默认权重（场景契合度 0.30 / 技术成熟度 0.20 / 集成难度 0.15 / 成本 0.15 / 合规可控性 0.20，和 = 1.00），未做反转性调整。
- **权重反转验证**：默认权重下排名为 Tauri 4.80 > Wails 3.80 > Electron 2.50，与已裁决架构（Tauri 2+Rust）一致，未出现「换权重即反转推荐排名」情形；且推荐排名不构成本项目已冻结决策（架构已由主理人裁决）。→ 未命中间确认。
- **§2.3 反向验证 3 问**：
  - Q1：权重调整仅影响本报告 §3 评分，返工小于 5%。→ 可控。
  - Q2：评分不对外暴露，用户/监管无可感知变化。→ 感知不到。
  - Q3：权重服务于评估，不改变用户诉求显式能力。→ 一致。

### 8.4 §5.2 关键事实无法核实自检

- **§2.1 判定**：未命中。无法公开核实的事实（U-01 各源 redistribution 权限、U-02 本地加密策略、U-03 macOS 公证/更新商务、U-04 快讯版权）均以「待确认项 U-xx」列入 §5.2，并给出备选路径，属非阻塞的输入缺口，不要求本阶段内发起中间确认；其裁决建议移交 `business-architect` / 安全设计 / 部署设计阶段。
- **§2.3 反向验证 3 问**：
  - Q1：待确认项若后续变更，仅影响安全/部署设计阶段文档，不影响本报告。→ 可控。
  - Q2：U-02/U-03 后续若涉及「数据加密」「发行公证」属对外承诺/合规属性，将由下游阶段按 G5 审核处理，本阶段不越权。→ 本阶段感知不到（待下游）。
  - Q3：待确认项不改变用户诉求显式能力。→ 一致。

---

> **decision**：调研报告完成，证据链闭合，下游可进入。
> 说明：4 项调研问题（Q1–Q4）均有事实支撑与加权评分结论；所有硬指标达标；U-01–U-04 为下游阶段可继续裁决的非阻塞待确认项，不阻断 G2 进入。建议 `business-architect` 在高层架构设计中采用本报告 §3.2 三层结论（优先 Tauri 2 / 部分借鉴 Wails 范式 / 不采纳 Electron）作为行业调研章节基线，并重点处理 §5.3 的 D-01/D-02/D-03 依赖项。
