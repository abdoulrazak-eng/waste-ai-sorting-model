-- Additive and safe to rerun. Keep historical rows unassigned.
ALTER TABLE logs ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE logs ADD COLUMN IF NOT EXISTS kiosk_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS ix_logs_business_id ON logs (business_id);
CREATE INDEX IF NOT EXISTS ix_logs_kiosk_id ON logs (kiosk_id);
ALTER TABLE learning ADD COLUMN IF NOT EXISTS business_id VARCHAR(36);
ALTER TABLE learning ADD COLUMN IF NOT EXISTS kiosk_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS ix_learning_business_id ON learning (business_id);
CREATE INDEX IF NOT EXISTS ix_learning_kiosk_id ON learning (kiosk_id);
