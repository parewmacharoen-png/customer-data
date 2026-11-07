import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, migrate } from '../src/db';
import { harvestSite, monthWindows, reportUrl, TxType } from '../src/harvest';
import { startSync } from '../src/sync';
import { WebApiError } from '../src/webApi';

const today = new Date(2026, 10, 7); // 7 พ.ย. 2026

async function site() {
  return (await pool.query('SELECT id, name, api_url, api_token, tx_synced_until FROM sites WHERE id = 1')).rows[0];
}

function tx(id: number, username: string, amount = '100.00') {
  return { id, datetime: '2026-10-01 10:15:00', amount, username, status: 'success', approved_by: 'auto',
    admin_username: null, info: 'x', customer_bank: { bank: 'SCB' }, bank_web: { bank: 'KBANK' } };
}

describe('harvest', () => {
  beforeEach(async () => {
    await migrate();
    await pool.query('TRUNCATE sync_runs, transactions, customers, sites RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO sites (name, api_url, api_token) VALUES ('magic','https://admin.magicvip.app/api/user_report','t')`);
    await pool.query(`INSERT INTO customers (site_id, phone) VALUES (1, '0811111111')`);
  });
  afterAll(() => pool.end());

  it('builds report URLs from the user_report URL', async () => {
    expect(reportUrl(await site(), 'deposit')).toBe('https://admin.magicvip.app/api/report-deposit');
  });

  it('splits ranges into calendar months', () => {
    expect(monthWindows(new Date(2026, 8, 29), new Date(2026, 10, 7))).toEqual([
      ['2026-09-29', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-07'],
    ]);
  });

  it('first run: pages through history, saves transactions, adds new phones', async () => {
    const calls: string[] = [];
    const fetchPage = async (_s: any, type: TxType, start: string, end: string, page: number) => {
      calls.push(`${type} ${start} ${end} p${page}`);
      if (type === 'deposit' && start === '2026-10-01') {
        return page === 1
          ? { data: [tx(1, '0811111111'), tx(2, '0822222222')], lastPage: 2 }
          : { data: [tx(3, '0833333333')], lastPage: 2 };
      }
      if (type === 'withdraw' && start === '2026-10-01') return { data: [tx(1, '0822222222', '50')], lastPage: 1 };
      return { data: [], lastPage: 1 };
    };
    const r = await harvestSite(await site(), { fetchPage, delayMs: 0, historyMonths: 1, today });
    expect(r).toEqual({ transactions: 4, newCustomers: 2, error: null });
    expect(calls).toEqual([
      'deposit 2026-10-01 2026-10-31 p1', 'deposit 2026-10-01 2026-10-31 p2', 'withdraw 2026-10-01 2026-10-31 p1',
      'deposit 2026-11-01 2026-11-07 p1', 'withdraw 2026-11-01 2026-11-07 p1',
    ]);
    const phones = (await pool.query('SELECT phone, source FROM customers ORDER BY phone')).rows;
    expect(phones).toEqual([
      { phone: '0811111111', source: null },
      { phone: '0822222222', source: 'report-deposit' },
      { phone: '0833333333', source: 'report-deposit' },
    ]);
    expect((await pool.query(`SELECT count(*)::int n FROM transactions`)).rows[0].n).toBe(4);
    expect((await site()).tx_synced_until.getDate()).toBe(7);

    // รอบถัดไป: เริ่มจากวันที่ดึงถึง - 3 วัน, รายการซ้ำอัปเดตไม่เพิ่มแถว
    calls.length = 0;
    const r2 = await harvestSite(await site(), {
      fetchPage: async (_s, type, start, end, page) => {
        calls.push(`${type} ${start} ${end} p${page}`);
        return { data: type === 'deposit' ? [{ ...tx(3, '0833333333'), status: 'cancel' }] : [], lastPage: 1 };
      },
      delayMs: 0, today,
    });
    expect(calls).toEqual(['deposit 2026-11-04 2026-11-07 p1', 'withdraw 2026-11-04 2026-11-07 p1']);
    expect(r2.newCustomers).toBe(0);
    const t3 = (await pool.query(`SELECT count(*)::int n, max(status) s FROM transactions WHERE ext_id='3' AND type='deposit'`)).rows[0];
    expect(t3).toEqual({ n: 1, s: 'cancel' });
  });

  it('stops on error without advancing the date (retries that month next time)', async () => {
    const r = await harvestSite(await site(), {
      fetchPage: async (_s, _t, start) => {
        if (start === '2026-11-01') throw new WebApiError('report-deposit HTTP 500 perSecond', 500);
        return { data: [], lastPage: 1 };
      },
      delayMs: 0, historyMonths: 1, today,
    });
    expect(r.error).toMatch(/HTTP 500/);
    expect((await site()).tx_synced_until.getDate()).toBe(31); // ถึงสิ้น ต.ค. ที่สำเร็จ
  });

  it('nightly sync runs harvest first, then user_report for the new phones', async () => {
    const reported: string[] = [];
    await startSync('manual', {
      delayMs: 0,
      harvest: { delayMs: 0, historyMonths: 0, today, fetchPage: async (_s, type) =>
        ({ data: type === 'deposit' ? [tx(9, '0899999999')] : [], lastPage: 1 }) },
      fetcher: async (_s: any, phone: string) => { reported.push(phone); return { total_deposit: '20000' }; },
    });
    await (startSync as any).lastPromise;
    expect(reported.sort()).toEqual(['0811111111', '0899999999']);
    const run = (await pool.query('SELECT tx_fetched, new_customers, updated FROM sync_runs')).rows[0];
    expect(run).toEqual({ tx_fetched: 1, new_customers: 1, updated: 2 });
  });
});
