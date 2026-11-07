import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl });

// สร้างตารางครั้งแรก (รันซ้ำได้)
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      api_url     TEXT NOT NULL,
      api_token   TEXT NOT NULL,
      enabled     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id              SERIAL PRIMARY KEY,
      site_id         INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      phone           TEXT NOT NULL,
      source          TEXT,
      added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_deposit   NUMERIC(18,2),
      total_withdraw  NUMERIC(18,2),
      count_deposit   INT,
      count_withdraw  INT,
      account_name    TEXT,
      account_number  TEXT,
      bank_short      TEXT,
      registered_at   TEXT,
      referrer        TEXT,
      last_deposit    TEXT,
      rank            TEXT,
      synced_at       TIMESTAMPTZ,
      last_status     TEXT,
      last_error      TEXT,
      UNIQUE (site_id, phone)
    );
    CREATE INDEX IF NOT EXISTS customers_synced_at_idx ON customers (synced_at NULLS FIRST);
    CREATE INDEX IF NOT EXISTS customers_rank_idx ON customers (rank);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id           SERIAL PRIMARY KEY,
      trigger      TEXT NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at  TIMESTAMPTZ,
      total        INT NOT NULL DEFAULT 0,
      done         INT NOT NULL DEFAULT 0,
      updated      INT NOT NULL DEFAULT 0,
      not_found    INT NOT NULL DEFAULT 0,
      failed       INT NOT NULL DEFAULT 0,
      skipped_sites TEXT[] NOT NULL DEFAULT '{}',
      stop_reason  TEXT,
      last_error   TEXT
    );

    -- รายการฝาก/ถอนจาก report-deposit / report-withdraw
    CREATE TABLE IF NOT EXISTS transactions (
      id             BIGSERIAL PRIMARY KEY,
      site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,           -- deposit | withdraw
      ext_id         TEXT NOT NULL,           -- id ของเว็บ
      username       TEXT,
      datetime       TIMESTAMP,
      amount         NUMERIC(18,2),
      status         TEXT,
      approved_by    TEXT,
      admin_username TEXT,
      info           TEXT,
      customer_bank  JSONB,
      bank_web       JSONB,
      fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (site_id, type, ext_id)
    );
    CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (site_id, username, datetime);
    CREATE INDEX IF NOT EXISTS transactions_dt_idx ON transactions (datetime);

    -- ดึงรายการถึงวันไหนแล้ว (ต่อเว็บ)
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS tx_synced_until DATE;
    ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS tx_fetched INT NOT NULL DEFAULT 0;
    ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS new_customers INT NOT NULL DEFAULT 0;
  `);
}
