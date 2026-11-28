-- 0034: subscription platforms gain a renderer column. The renderer decides
-- which client format a platform link returns; 'auto' is the automatic
-- (User-Agent) platform and keeps its own marker. Seed rows are backfilled
-- from the mapping in worker/domains/platforms.ts (SEED_PLATFORM_RENDERERS);
-- any other stored key falls back to 'generic'. Fresh installs still seed
-- from migration 0007; the database, not the seed list, is authoritative
-- afterwards, so custom keys are allowed from here on.
ALTER TABLE subscription_platform_settings ADD COLUMN renderer TEXT NOT NULL DEFAULT 'generic';

UPDATE subscription_platform_settings SET renderer = CASE platform
  WHEN 'auto' THEN 'auto'
  WHEN 'mihomo' THEN 'mihomo'
  WHEN 'clash' THEN 'mihomo'
  WHEN 'clash-meta' THEN 'mihomo'
  WHEN 'stash' THEN 'mihomo'
  WHEN 'singbox' THEN 'singbox'
  WHEN 'karing' THEN 'singbox'
  WHEN 'surge' THEN 'surge'
  WHEN 'loon' THEN 'loon'
  WHEN 'quantumultx' THEN 'quantumultx'
  WHEN 'v2rayn' THEN 'v2rayn'
  WHEN 'nekobox' THEN 'nekobox'
  WHEN 'shadowrocket' THEN 'shadowrocket'
  ELSE 'generic'
END;
