# 基金盘中估值共享采集服务

Cloudflare Worker 每分钟采集已订阅基金的 DeepQ 盘中估值，并在 D1 中保留最近 7 天数据。数据为估值，不是基金正式净值或场内成交价。

## 本地验证

```bash
npm run worker:test
npm run worker:deploy:dry
npm run worker:dev
```

生产 D1 数据库 `fund-intraday` 已绑定在 `wrangler.toml`，部署工作流会先执行迁移，再发布 Worker。仓库的 `Deploy Fund Intraday Collector` 手动工作流使用 GitHub Secret `CLOUDFLARE_API_TOKEN` 和仓库变量 `CLOUDFLARE_ACCOUNT_ID`。

桌面安装包构建时需设置仓库变量 `FUND_INTRADAY_SERVICE_URL=https://fund-intraday-collector.lrwei91.workers.dev`。该地址编译进 Rust；安装令牌仅写入本地 `config.json` 的 `private` 区，不会返回 renderer。
