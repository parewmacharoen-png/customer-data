import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { pool, migrate } from '../src/db';
import { createApp } from '../src/app';

let server: Server;
let base: string;
const auth = { Authorization: 'Basic ' + Buffer.from('admin:test').toString('base64') };

beforeAll(async () => {
  await migrate();
  await pool.query('TRUNCATE sync_runs, customers, sites RESTART IDENTITY CASCADE');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

describe('api', () => {
  it('requires login', async () => {
    expect((await fetch(base + '/api/status')).status).toBe(401);
    const bad = { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') };
    expect((await fetch(base + '/api/status', { headers: bad })).status).toBe(401);
  });

  it('site → import → list → export, token masked', async () => {
    const r = await fetch(base + '/api/sites', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'kw', api_url: 'http://x/api/user_report', api_token: 'secret-token-123' }),
    });
    expect(r.status).toBe(200);
    const sites = await (await fetch(base + '/api/sites', { headers: auth })).json();
    expect(sites[0].api_token).toBe('sec••••123');

    const fd = new FormData();
    fd.append('site_id', '1');
    fd.append('file', new Blob(['เบอร์\n0811111111\n812222222\n0811111111\n']), 'list.csv');
    const imp = await (await fetch(base + '/api/import', { method: 'POST', headers: auth, body: fd })).json();
    expect(imp).toMatchObject({ found: 2, added: 2, duplicatesInFile: 1 });

    const again = new FormData();
    again.append('site_id', '1');
    again.append('file', new Blob(['0811111111\n']), 'list.csv');
    expect((await (await fetch(base + '/api/import', { method: 'POST', headers: auth, body: again })).json()).added).toBe(0);

    await pool.query(`UPDATE customers SET total_deposit = 20000, rank = 'VIP' WHERE phone = '0812222222'`);
    const list = await (await fetch(base + '/api/customers?rank=VIP', { headers: auth })).json();
    expect(list.total).toBe(1);
    expect(list.rows[0].phone).toBe('0812222222');

    const search = await (await fetch(base + '/api/customers?search=0811', { headers: auth })).json();
    expect(search.total).toBe(1);

    const raw = Buffer.from(await (await fetch(base + '/api/customers/export.csv', { headers: auth })).arrayBuffer());
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM ให้ Excel อ่านภาษาไทยได้
    const csv = raw.toString('utf8');
    expect(csv).toContain('เว็บ,เบอร์');
    expect(csv).toContain('="0812222222"');
  });
  it('rejects a bad manual date range', async () => {
    const r = await fetch(base + '/api/sync/run', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-11-05', to: '2026-11-01' }),
    });
    expect(r.status).toBe(400);
  });

  it('test endpoint shows the raw web reply with the token hidden', async () => {
    const http = await import('http');
    const fake = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 200, data: [], meta: { last_page: 1 }, echo: JSON.parse(b).token, path: req.url }));
      });
    }).listen(0);
    const port = (fake.address() as any).port;
    await pool.query(`INSERT INTO sites (name, api_url, api_token) VALUES ('t', 'http://127.0.0.1:${port}/api/user_report', 'sekret-xyz')`);
    const id = (await pool.query(`SELECT id FROM sites WHERE name = 't'`)).rows[0].id;
    const r = await (await fetch(base + `/api/sites/${id}/test`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0811111111' }),
    })).json();
    fake.close();
    expect(r.deposit.ok).toBe(true);
    expect(r.deposit.body).toContain('/api/report-deposit');
    expect(r.deposit.body).not.toContain('sekret-xyz');
    expect(r.user_report.ok).toBe(true);
    await pool.query(`DELETE FROM sites WHERE name = 't'`);
  });

});
