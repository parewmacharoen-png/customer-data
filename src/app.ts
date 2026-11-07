import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { pool } from './db';
import { config } from './config';
import { isRunning, requestStop, startSync } from './sync';
import { parsePhoneFile } from './importer';
import { fetchTxPage, fmt, reportUrl, TxType } from './harvest';
import { fetchUserReport } from './webApi';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Basic Auth ทั้งแอป
function auth(req: Request, res: Response, next: NextFunction) {
  if (!config.adminPassword) {
    res.status(500).send('ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน .env');
    return;
  }
  const h = req.headers.authorization || '';
  const [user, pass] = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s) : [];
  if (user !== undefined && safeEqual(user, config.adminUser) && safeEqual(pass ?? '', config.adminPassword)) {
    next();
    return;
  }
  res.set('WWW-Authenticate', 'Basic realm="customer-data"').status(401).send('ต้องเข้าสู่ระบบ');
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

const maskToken = (t: string) => (t.length <= 6 ? '••••' : `${t.slice(0, 3)}••••${t.slice(-3)}`);

const SORTS: Record<string, string> = {
  deposit: 'total_deposit DESC NULLS LAST',
  withdraw: 'total_withdraw DESC NULLS LAST',
  synced: 'synced_at DESC NULLS LAST',
  phone: 'phone ASC',
};

function customerFilter(q: any) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.site) {
    args.push(Number(q.site));
    where.push(`c.site_id = $${args.length}`);
  }
  if (q.rank === 'none') where.push('c.rank IS NULL');
  else if (q.rank) {
    args.push(String(q.rank));
    where.push(`c.rank = $${args.length}`);
  }
  if (q.status) {
    args.push(String(q.status));
    where.push(`c.last_status = $${args.length}`);
  }
  if (q.search) {
    args.push(`%${String(q.search).trim()}%`);
    const p = `$${args.length}`;
    where.push(`(c.phone ILIKE ${p} OR c.account_name ILIKE ${p} OR c.referrer ILIKE ${p} OR c.account_number ILIKE ${p})`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function createApp() {
  const app = express();
  app.use(auth);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- สถานะ sync ----------
  app.get('/api/status', wrap(async (_req, res) => {
    const last = (await pool.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')).rows[0] || null;
    const counts = (
      await pool.query(`SELECT count(*)::int AS customers,
          count(*) FILTER (WHERE synced_at IS NOT NULL)::int AS synced,
          count(*) FILTER (WHERE rank IS NOT NULL)::int AS vip,
          (SELECT count(*)::int FROM transactions) AS transactions
        FROM customers`)
    ).rows[0];
    res.json({ running: isRunning(), lastRun: last, counts, cron: config.sync.enabled ? config.sync.cron : null });
  }));

  // ดึงเอง: ไม่ส่ง body = ทำเหมือนรอบอัตโนมัติ
  // body: { site_id?, from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', deposit?: bool, withdraw?: bool, report?: bool }
  app.post('/api/sync/run', wrap(async (req, res) => {
    const b = req.body || {};
    const parseDate = (v: unknown) => {
      if (!v) return undefined;
      const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    };
    const from = parseDate(b.from);
    const to = parseDate(b.to);
    if (from === null || to === null || (from && to && from > to)) {
      res.status(400).json({ message: 'วันที่ไม่ถูกต้อง' });
      return;
    }
    const types = (['deposit', 'withdraw'] as TxType[]).filter((t) => b[t] !== false);
    const id = await startSync('manual', {
      siteIds: b.site_id ? [Number(b.site_id)] : undefined,
      harvest: types.length ? { from, to, types } : false,
      report: b.report !== false,
    });
    res.json(id ? { started: true, runId: id } : { started: false, message: 'มีการ sync กำลังรันอยู่' });
  }));

  app.post('/api/sync/stop', (_req, res) => {
    requestStop();
    res.json({ ok: true });
  });

  // ---------- เว็บ (API URL + Token) ----------
  app.get('/api/sites', wrap(async (_req, res) => {
    const rows = (
      await pool.query(`SELECT s.id, s.name, s.api_url, s.api_token, s.enabled,
          (SELECT count(*)::int FROM customers c WHERE c.site_id = s.id) AS customers,
          to_char(s.tx_synced_until, 'YYYY-MM-DD') AS tx_synced_until
        FROM sites s ORDER BY s.id`)
    ).rows;
    res.json(rows.map((r) => ({ ...r, api_token: maskToken(r.api_token) })));
  }));

  app.post('/api/sites', wrap(async (req, res) => {
    const { name, api_url, api_token } = req.body || {};
    if (!name || !api_url || !api_token) {
      res.status(400).json({ message: 'กรอก ชื่อ / API URL / Token ให้ครบ' });
      return;
    }
    const r = await pool.query(
      'INSERT INTO sites (name, api_url, api_token) VALUES ($1, $2, $3) RETURNING id',
      [String(name).trim(), String(api_url).trim(), String(api_token).trim()],
    );
    res.json({ id: r.rows[0].id });
  }));

  // แก้ไข: ส่งเฉพาะช่องที่จะเปลี่ยน (token ว่าง = ใช้ค่าเดิม)
  app.put('/api/sites/:id', wrap(async (req, res) => {
    const { name, api_url, api_token, enabled } = req.body || {};
    await pool.query(
      `UPDATE sites SET name = COALESCE($2, name), api_url = COALESCE($3, api_url),
         api_token = COALESCE($4, api_token), enabled = COALESCE($5, enabled) WHERE id = $1`,
      [Number(req.params.id), name?.trim() || null, api_url?.trim() || null, api_token?.trim() || null,
       typeof enabled === 'boolean' ? enabled : null],
    );
    res.json({ ok: true });
  }));

  // ทดสอบ API: ยิง report-deposit (7 วันล่าสุด, 3 รายการ) และ user_report (ถ้าใส่เบอร์) แล้วคืนคำตอบดิบ
  app.post('/api/sites/:id/test', wrap(async (req, res) => {
    const site = (await pool.query('SELECT id, name, api_url, api_token FROM sites WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!site) {
      res.status(404).json({ message: 'ไม่พบเว็บ' });
      return;
    }
    const hide = (t: string) => (site.api_token ? t.split(site.api_token).join('***') : t);
    const call = async (fn: () => Promise<unknown>) => {
      try {
        return { ok: true, body: hide(JSON.stringify(await fn(), null, 2)).slice(0, 3000) };
      } catch (e: any) {
        return { ok: false, body: hide(String(e?.message || e)).slice(0, 3000) };
      }
    };
    const end = new Date();
    const start = new Date(end.getTime() - 6 * 86400000);
    const out: any = {
      deposit: {
        url: reportUrl(site, 'deposit'),
        range: `${fmt(start)} .. ${fmt(end)}`,
        ...(await call(async () => (await fetchTxPage(site, 'deposit', fmt(start), fmt(end), 1, 3, 15000)).raw)),
      },
    };
    const phone = String(req.body?.phone || '').trim();
    if (phone) out.user_report = { url: site.api_url, ...(await call(() => fetchUserReport(site, phone, 15000))) };
    res.json(out);
  }));

  app.delete('/api/sites/:id', wrap(async (req, res) => {
    await pool.query('DELETE FROM sites WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- นำเข้าเบอร์ ----------
  app.post('/api/import', upload.single('file'), wrap(async (req, res) => {
    const siteId = Number(req.body?.site_id);
    if (!req.file || !siteId) {
      res.status(400).json({ message: 'เลือกเว็บและไฟล์ก่อน' });
      return;
    }
    const parsed = await parsePhoneFile(req.file.originalname, req.file.buffer);
    let added = 0;
    for (let i = 0; i < parsed.phones.length; i += 1000) {
      const chunk = parsed.phones.slice(i, i + 1000);
      const r = await pool.query(
        `INSERT INTO customers (site_id, phone, source)
         SELECT $1, unnest($2::text[]), $3
         ON CONFLICT (site_id, phone) DO NOTHING`,
        [siteId, chunk, req.file.originalname],
      );
      added += r.rowCount || 0;
    }
    res.json({
      found: parsed.phones.length,
      added,
      alreadyExists: parsed.phones.length - added,
      duplicatesInFile: parsed.duplicates,
      invalid: parsed.invalid,
    });
  }));

  // ---------- ลูกค้า ----------
  app.get('/api/customers', wrap(async (req, res) => {
    const { sql, args } = customerFilter(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const order = SORTS[String(req.query.sort)] || SORTS.deposit;
    const total = (await pool.query(`SELECT count(*)::int AS n FROM customers c ${sql}`, args)).rows[0].n;
    const rows = (
      await pool.query(
        `SELECT c.*, s.name AS site_name FROM customers c JOIN sites s ON s.id = c.site_id ${sql}
         ORDER BY ${order}, c.id LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        args,
      )
    ).rows;
    res.json({ total, page, limit, rows });
  }));

  app.get('/api/customers/export.csv', wrap(async (req, res) => {
    const { sql, args } = customerFilter(req.query);
    const order = SORTS[String(req.query.sort)] || SORTS.deposit;
    const rows = (
      await pool.query(
        `SELECT s.name AS site, c.phone, c.account_name, c.bank_short, c.account_number, c.rank,
           c.total_deposit, c.count_deposit, c.total_withdraw, c.count_withdraw, c.last_deposit,
           c.registered_at, c.referrer, c.synced_at, c.last_status
         FROM customers c JOIN sites s ON s.id = c.site_id ${sql} ORDER BY ${order}, c.id`,
        args,
      )
    ).rows;
    const head = ['เว็บ', 'เบอร์', 'ชื่อบัญชี', 'ธนาคาร', 'เลขบัญชี', 'ระดับ', 'ยอดฝากรวม', 'ครั้งฝาก',
      'ยอดถอนรวม', 'ครั้งถอน', 'ฝากล่าสุด', 'วันที่สมัคร', 'ผู้แนะนำ', 'อัปเดตล่าสุด', 'สถานะ'];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      // ="..." กัน Excel ตัด 0 หน้าเบอร์/เลขบัญชี
      return /^0\d+$/.test(s) ? `="${s}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [head.join(','), ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    const dup = err?.code === '23505';
    res.status(dup ? 409 : 500).json({ message: dup ? 'ชื่อซ้ำกับที่มีอยู่' : err?.message || 'error' });
  });

  return app;
}
