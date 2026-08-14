CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    subscription_hash TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
    installation_id TEXT NOT NULL,
    code TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (installation_id, code),
    FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(expires_at, code);

CREATE TABLE IF NOT EXISTS fund_intraday_points (
    code TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    minute_at INTEGER NOT NULL,
    estimate_percent REAL NOT NULL,
    source TEXT NOT NULL,
    collected_at INTEGER NOT NULL,
    PRIMARY KEY (code, trade_date, minute_at)
);
CREATE INDEX IF NOT EXISTS idx_fund_points_lookup
    ON fund_intraday_points(code, trade_date, minute_at);
