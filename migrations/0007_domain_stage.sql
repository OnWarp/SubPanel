-- Domain stage: subscription platform display settings, panel domains and
-- subscription domains. All authoritative configuration lives in D1.
-- Seeds: the platform list mirrors the link entries the user subscriptions
-- page already renders (same order, same display names), and the live
-- hostname sub.warp.dpdns.org is pre-registered as the verified primary in
-- both domain tables (Roye: preset on both sides). Domain restriction stays
-- off by default; the seeded rows only take effect once an admin turns
-- domain_restriction_enabled on.

CREATE TABLE subscription_platform_settings (
  platform TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO subscription_platform_settings (platform, display_name, enabled, sort_order, updated_at) VALUES
  ('auto', '自动识别', 1, 0, '1970-01-01T00:00:00.000Z'),
  ('mihomo', 'Mihomo', 1, 10, '1970-01-01T00:00:00.000Z'),
  ('clash', 'Clash', 1, 20, '1970-01-01T00:00:00.000Z'),
  ('clash-meta', 'Clash Meta', 1, 30, '1970-01-01T00:00:00.000Z'),
  ('stash', 'Stash', 1, 40, '1970-01-01T00:00:00.000Z'),
  ('singbox', 'sing-box', 1, 50, '1970-01-01T00:00:00.000Z'),
  ('karing', 'Karing', 1, 60, '1970-01-01T00:00:00.000Z'),
  ('surge', 'Surge', 1, 70, '1970-01-01T00:00:00.000Z'),
  ('loon', 'Loon', 1, 80, '1970-01-01T00:00:00.000Z'),
  ('quantumultx', 'Quantumult X', 1, 90, '1970-01-01T00:00:00.000Z'),
  ('v2rayn', 'v2rayN', 1, 100, '1970-01-01T00:00:00.000Z'),
  ('nekobox', 'NekoBox', 1, 110, '1970-01-01T00:00:00.000Z'),
  ('shadowrocket', 'Shadowrocket', 1, 120, '1970-01-01T00:00:00.000Z');

CREATE TABLE panel_domains (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'failed')),
  verified_at TEXT,
  last_check_at TEXT,
  last_check_error TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscription_domains (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'failed')),
  verified_at TEXT,
  last_check_at TEXT,
  last_check_error TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO panel_domains (
  id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at
) VALUES (
  'dom_panel_primary', 'sub.warp.dpdns.org', 1, 'verified',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
  '现网域名（迁移预置）', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO subscription_domains (
  id, hostname, enabled, verification_status, verified_at, last_check_at, last_check_error, note, created_at, updated_at
) VALUES (
  'dom_sub_primary', 'sub.warp.dpdns.org', 1, 'verified',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
  '现网域名（迁移预置）', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES
  ('primary_panel_domain_id', '"dom_panel_primary"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('primary_subscription_domain_id', '"dom_sub_primary"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('domain_restriction_enabled', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
