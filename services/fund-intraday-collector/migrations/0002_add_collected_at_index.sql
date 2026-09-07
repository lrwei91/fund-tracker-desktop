-- 解决 D1 读取配额耗尽问题
-- collected_at 无索引，导致每分钟清理全表扫描（500万行免费额度快速耗尽）

-- fund_intraday_points: WHERE collected_at < ? 查询必须走索引
CREATE INDEX IF NOT EXISTS idx_fund_points_collected_at ON fund_intraday_points(collected_at);

-- subscriptions: WHERE expires_at > ? GROUP BY code 查询走索引
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_code ON subscriptions(expires_at, code);

-- installations: WHERE expires_at <= ? 查询走索引
CREATE INDEX IF NOT EXISTS idx_installations_expires_at ON installations(expires_at);
