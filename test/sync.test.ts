import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, migrate } from '../src/db';
import { startSync } from '../src/sync';
import { WebApiError } from '../src/webApi';

async function reset() {
  await migrate();
  await pool.query('TRUNCATE sync_runs, customers, sites RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO sites (name, api_url, api_token) VALUES ('A','http://a','t'), ('B','http://b','t')`);
  await pool.query(`INSERT INTO customers (site_id, phone, synced_at) VALUES
    (1, '0811111111', now() - interval '1 day'),
    (1, '0822222222', NULL),
    (1, '0833333333', NULL),
    (2, '0899999999', NULL)`);
  // ข้อมูลเดิมของ 0833 ต้องไม่ถูกเขียนทับเมื่อ API ตอบว่าไม่พบ
  await pool.query(`UPDATE customers SET total_deposit = 5000, account_name = 'OLD' WHERE phone = '0833333333'`);
}

async function runAndWait(fetcher: any, extra = {}) {
  const id = await startSync('manual', { delayMs: 0, maxSiteErrors: 1, fetcher, ...extra });
  await (startSync as any).lastPromise;
  return id;
}

describe('sync', () => {
  beforeEach(reset);
  afterAll(() => pool.end());

  it('updates customers oldest first, keeps data on not-found, stops a failing site', async () => {
    const calls: string[] = [];
    const id = await runAndWait(async (site: any, phone: string) => {
      calls.push(phone);
      if (site.name === 'B') throw new WebApiError('HTTP 401', 401);
      if (phone === '0833333333') return { message: 'user not found' };
      return { total_deposit: phone === '0822222222' ? '150000' : '200', account_name: 'N' + phone, referrer: 'ref1' };
    });
    expect(id).toBe(1);
    // ยังไม่เคยดึง (NULL) มาก่อน แล้วค่อยเบอร์ที่ดึงเมื่อวาน
    expect(calls).toEqual(['0822222222', '0833333333', '0899999999', '0811111111']);

    const rows = (await pool.query('SELECT phone, rank, total_deposit, account_name, last_status FROM customers ORDER BY phone')).rows;
    expect(rows).toEqual([
      { phone: '0811111111', rank: null, total_deposit: '200.00', account_name: 'N0811111111', last_status: 'ok' },
      { phone: '0822222222', rank: 'VIP2', total_deposit: '150000.00', account_name: 'N0822222222', last_status: 'ok' },
      { phone: '0833333333', rank: null, total_deposit: '5000.00', account_name: 'OLD', last_status: 'not_found' },
      { phone: '0899999999', rank: null, total_deposit: null, account_name: null, last_status: 'error' },
    ]);
    const run = (await pool.query('SELECT * FROM sync_runs WHERE id = 1')).rows[0];
    expect(run).toMatchObject({ total: 4, done: 4, updated: 2, not_found: 1, failed: 1, skipped_sites: ['B'] });
    expect(run.finished_at).not.toBeNull();
  });

  it('refuses a second concurrent run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = await startSync('manual', { delayMs: 0, fetcher: async () => { await gate; return { total_deposit: '1' }; } });
    const p = (startSync as any).lastPromise;
    expect(first).toBe(1);
    expect(await startSync('manual')).toBeNull();
    release();
    await p;
  });

  it('stops when the time limit is reached', async () => {
    await runAndWait(async () => ({ total_deposit: '1' }), { maxMs: -1 });
    const run = (await pool.query('SELECT * FROM sync_runs')).rows[0];
    expect(run.done).toBe(0);
    expect(run.stop_reason).toMatch(/หมดเวลา/);
  });
});
