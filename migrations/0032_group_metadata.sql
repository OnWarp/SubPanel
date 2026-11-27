-- Render before execution using development/render-group-metadata.mjs.
-- Feed the renderer a fresh Wrangler --json PRAGMA table_info(groups) result.
-- SQLite cannot guard ADD COLUMN inside a static SQL file. Re-render on retry
-- so the resulting file contains only missing columns (or a no-op).
ALTER TABLE groups ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE groups ADD COLUMN remark TEXT;
