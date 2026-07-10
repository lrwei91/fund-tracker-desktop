# 项目记忆 · fund-tracker

## 设计方向（2026-07-08 确定）
- 前端 UI 重构参考项目：`yespsam/a-share-us-catalyst`（九点猫研 CatDesk 9）。
- 用户拍板两项决策：
  1. **主题 = 深色猫系**：保留「恭喜发财」暗色底，套用 CatDesk 的 2px 浅色描边 + 硬阴影(贴纸/新粗野)卡片语言、旋转图标徽章、猫头品牌。
  2. **布局 = 响应式自适应**：主窗口放宽到 1180px（minWidth 760），窄屏自动折叠侧栏、卡片列数 3→2→1。
- 关键约束：A 股惯例 **红涨绿跌**，`.positive`=红、`.negative`=绿，重构 CSS 时务必保留。
- 设计系统集中在 `app/styles.css`，已完整覆盖各 JS 模块生成的 class（行情/自选/资金流/板块/龙虎榜/涨停/快讯/弹窗/告警 toast/个股详情）。
- 静态预览页：`preview-dark-catdesk.html`（链接 app/styles.css，含示例数据，可在浏览器直接看效果，无需启动 Electron）。

## 数据源状态（2026-07-09 排查）
| 数据源 | 状态 | 影响API | 替代方案 |
|--------|------|---------|---------|
| push2his.eastmoney.com | ❌ 空回复 | stock-minute, stock-kline, fund-flow-120d | tdxrs / 腾讯 / push2ex |
| push2.eastmoney.com (clist/fflow) | ❌ 空回复 | market-data, fund-flow-120d | 同花顺行业 / tdxrs |
| flash-api.jin10.com | ❌ HTTP 502 | news | np-weblist.eastmoney.com |
| data.hexin.cn | ❌ Nginx Forbidden | market-data(北向) | 降级返回空 |
| qt.gtimg.cn / web.ifzq.gtimg.cn | ✅ | stock, kline, minute, market-data | — |
| push2ex.eastmoney.com | ✅ | limit-up | — |
| push2 (ulist.np/get) | ✅ | hot-rank(部分) | — |

## tdxrs
- 已安装: `pip3 install tdxrs==0.6.5`
- 可用路径: `python3 -m tdxrs`
- 命令: minutes(分时), bars(K线), quote(行情), trades(逐笔)等

## 2026-07-09 修复清单
- **stock-minute.js**: tdxrs 候选链可用 + 新增腾讯分时 API 作为第二 fallback
- **stock-kline.js**: 新增 tdxrs bars 作为首要源(通达信直连)，腾讯复权K线为 fallback
- **fund-flow-120d.js**: 多端点重试(push2his→push2)，单股失败不阻塞
- **news.js**: 新增东财快讯(np-weblist) 作为金十502 fallback
- **market-data.js**: 主力资金 + 北向资金异常时优雅降级
