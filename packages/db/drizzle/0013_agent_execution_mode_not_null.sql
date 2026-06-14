-- Backfill null execution_mode to 'paper' and make column NOT NULL
UPDATE agents SET execution_mode = 'paper' WHERE execution_mode IS NULL;
ALTER TABLE agents ALTER COLUMN execution_mode SET NOT NULL;
ALTER TABLE agents ALTER COLUMN execution_mode SET DEFAULT 'paper';
