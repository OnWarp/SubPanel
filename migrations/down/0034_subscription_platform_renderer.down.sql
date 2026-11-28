-- Roll back 0034: drop the renderer column. Platform rows keep their other
-- columns; custom keys added after 0034 stay in the table.
ALTER TABLE subscription_platform_settings DROP COLUMN renderer;
