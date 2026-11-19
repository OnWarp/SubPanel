ALTER TABLE sources ADD COLUMN keep_on_failure INTEGER NOT NULL DEFAULT 1 CHECK (keep_on_failure IN (0, 1));
