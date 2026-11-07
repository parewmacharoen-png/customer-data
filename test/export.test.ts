import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { pool, migrate } from '../src/db';
import { createApp } from '../src/app';

let server: Server;
let base: string;
const auth = { Authorization: 'Basic ' + Buffer.from('admin:test').toString('base64') };

beforeAll(async () => {
  await migrate();
  await pool.query('TRUNCATE sync_runs, transactions, customers, sites RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO sites (name, api_url, api_token) VALUES ('MB', 'http://x/api/user_report', 't')`);
  await pool.query(`INSERT INTO customers (site_id, phone, rank, referrer) VALUES (1, '0800000001', 'VIP', 'ref1')`);
  await pool.query(`INSERT INTO transactions (site_id, type, ext_id, username, datetime, amount, status, customer_bank, bank_web, info) VALUES
    (1, 'deposit',  '1', '0800000001', '2026-11-01 00:00:00', 300, 'success', '{"account_name":"ทดสอบ หนึ่ง","bank":"KTB","account_number":"0123456789"}', '{"bank":"KTB","account_number":"666"}', 'a, "b"'),
    (1, 'withdraw', '2', '0800000001', '2026-11-03 23:59:59', 500, 'success', null, null, null),
    (1, 'deposit',  '3', '0800000002', '2026-11-05 10:00:00', 100, 'cancel', null, null, null)`);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

async function csv(q: string) {
  const r = await fetch(base + '/api/transactions/export.csv?' + q, { headers: auth });
  expect(r.status).toBe(200);
  return (await r.text()).replace(/^﻿/, '').split('\r\n');
}

describe('transactions export', () => {
  it('exports everything with Thai headers, customer rank, safe phone/account cells', async () => {
    const lines = await csv('');
    expect(lines[0]).toMatch(/^เว็บ,ประเภท,วันเวลา,เบอร์,จำนวนเงิน/);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      'MB,ฝาก,2026-11-01 00:00:00,="0800000001",300.00,success,ทดสอบ หนึ่ง,KTB,="0123456789",KTB 666,,,"a, ""b""",1,VIP,ref1',
    );
  });

  it('filters by date range (to = whole day) and type', async () => {
    expect(await csv('from=2026-11-01&to=2026-11-03')).toHaveLength(3);
    const w = await csv('type=withdraw');
    expect(w).toHaveLength(2);
    expect(w[1]).toContain('ถอน,2026-11-03 23:59:59');
    expect(await csv('from=2026-11-04')).toHaveLength(2);
  });
});
