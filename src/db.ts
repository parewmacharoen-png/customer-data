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
  `);
}
