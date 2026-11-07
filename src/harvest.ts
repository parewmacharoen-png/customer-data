// ดึงรายการฝาก/ถอนทั้งเว็บ (report-deposit / report-withdraw) ทีละเดือน ทีละหน้า
// - เก็บลงตาราง transactions (ซ้ำ = อัปเดตสถานะ)
// - ทุก username ที่เจอ → เพิ่มเข้า customers อัตโนมัติ (ไม่ต้องอัปโหลดไฟล์)
// - ครั้งแรกย้อนหลัง TX_HISTORY_MONTHS เดือน, ครั้งต่อไปเริ่มจากวันที่ดึงถึงแล้ว - TX_OVERLAP_DAYS
// - ลิมิตเว็บ 60 ครั้ง/นาที → เว้น TX_DELAY_MS, เจอ 429 รอตาม Retry-After
import { pool } from './db';
import { config } from './config';
import { Site, WebApiError } from './webApi';

export type TxType = 'deposit' | 'withdraw';

export interface TxPage {
  data: any[];
  lastPage: number;
}

export interface HarvestOptions {
  delayMs?: number;
  perPage?: number;
  historyMonths?: number;
  overlapDays?: number;
  timeoutMs?: number;
  today?: Date;
  shouldStop?: () => boolean;
  fetchPage?: (site: Site, type: TxType, start: string, end: string, page: number, perPage: number, timeoutMs: number) => Promise<TxPage>;
}

export interface HarvestResult {
  transactions: number;
  newCustomers: number;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** https://admin.x.app/api/user_report → https://admin.x.app/api/report-deposit */
export function reportUrl(site: Site, type: TxType): string {
  const u = new URL(site.api_url);
  return `${u.origin}/api/report-${type}`;
}

export async function fetchTxPage(
  site: Site, type: TxType, start: string, end: string, page: number, perPage: number, timeoutMs: number,
): Promise<TxPage> {
  let res: Response;
  try {
    res = await fetch(reportUrl(site, type), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: site.api_token, start_date: start, end_date: end, page, per_page: perPage }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new WebApiError(e?.name === 'TimeoutError' ? 'timeout' : e?.message || String(e));
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new WebApiError(`report-${type} HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    (err as any).retryAfter = Number(res.headers.get('retry-after')) || undefined;
    throw err;
  }
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebApiError(`report-${type} ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`, res.status);
  }
  return {
    data: Array.isArray(body?.data) ? body.data : [],
    lastPage: Number(body?.meta?.last_page) || 1,
  };
}

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** แบ่งช่วง [from, to] เป็นก้อนรายเดือนตามปฏิทิน (เว็บรับไม่เกิน 1 เดือน) */
export function monthWindows(from: Date, to: Date): [string, string][] {
  const out: [string, string][] = [];
  let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= last) {
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const end = monthEnd < last ? monthEnd : last;
    out.push([fmt(cur), fmt(end)]);
    cur = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  return out;
}

/** วันที่ (เวลาไทย) ของ "วันนี้" */
function bangkokToday(): Date {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

async function saveRows(site: Site, type: TxType, rows: any[]): Promise<{ tx: number; newCustomers: number }> {
  const valid = rows.filter((r) => r && r.id !== undefined && r.id !== null);
  if (valid.length === 0) return { tx: 0, newCustomers: 0 };
  await pool.query(
    `INSERT INTO transactions (site_id, type, ext_id, username, datetime, amount, status, approved_by,
       admin_username, info, customer_bank, bank_web)
     SELECT $1, $2, x.ext_id, x.username, x.datetime::timestamp, x.amount::numeric, x.status, x.approved_by,
       x.admin_username, x.info, x.customer_bank, x.bank_web
     FROM jsonb_to_recordset($3::jsonb) AS x(ext_id text, username text, datetime text, amount text, status text,
       approved_by text, admin_username text, info text, customer_bank jsonb, bank_web jsonb)
     ON CONFLICT (site_id, type, ext_id) DO UPDATE SET
       username = EXCLUDED.username, datetime = EXCLUDED.datetime, amount = EXCLUDED.amount,
       status = EXCLUDED.status, approved_by = EXCLUDED.approved_by, admin_username = EXCLUDED.admin_username,
       info = EXCLUDED.info, customer_bank = EXCLUDED.customer_bank, bank_web = EXCLUDED.bank_web, fetched_at = now()`,
    [
      site.id,
      type,
      JSON.stringify(
        valid.map((r) => ({
          ext_id: String(r.id),
          username: r.username ? String(r.username).trim() : null,
          datetime: r.datetime || null,
          amount: r.amount === null || r.amount === undefined || r.amount === '' ? null : String(r.amount),
          status: r.status ?? null,
          approved_by: r.approved_by ?? null,
          admin_username: r.admin_username ?? null,
          info: r.info ?? null,
          customer_bank: r.customer_bank ?? null,
          bank_web: r.bank_web ?? null,
        })),
      ),
    ],
  );
  const usernames = [...new Set(valid.map((r) => (r.username ? String(r.username).trim() : '')).filter(Boolean))];
  const c = await pool.query(
    `INSERT INTO customers (site_id, phone, source)
     SELECT $1, unnest($2::text[]), $3
     ON CONFLICT (site_id, phone) DO NOTHING`,
    [site.id, usernames, `report-${type}`],
  );
  return { tx: valid.length, newCustomers: c.rowCount || 0 };
}

export async function harvestSite(site: Site & { tx_synced_until?: Date | string | null }, opts: HarvestOptions = {}): Promise<HarvestResult> {
  const delayMs = opts.delayMs ?? config.tx.delayMs;
  const perPage = opts.perPage ?? config.tx.perPage;
  const historyMonths = opts.historyMonths ?? config.tx.historyMonths;
  const overlapDays = opts.overlapDays ?? config.tx.overlapDays;
  const timeoutMs = opts.timeoutMs ?? config.sync.timeoutMs;
  const fetchPage = opts.fetchPage ?? fetchTxPage;
  const shouldStop = opts.shouldStop ?? (() => false);
  const today = opts.today ?? bangkokToday();

  let from: Date;
  if (site.tx_synced_until) {
    const d = new Date(site.tx_synced_until);
    from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - overlapDays);
  } else {
    from = new Date(today.getFullYear(), today.getMonth() - historyMonths, 1);
  }

  const result: HarvestResult = { transactions: 0, newCustomers: 0, error: null };
  let first = true;

  for (const [start, end] of monthWindows(from, today)) {
    for (const type of ['deposit', 'withdraw'] as TxType[]) {
      let page = 1;
      let lastPage = 1;
      let retries = 0;
      do {
        if (shouldStop()) return result;
        if (!first) await sleep(delayMs);
        first = false;
        let resp: TxPage;
        try {
          resp = await fetchPage(site, type, start, end, page, perPage, timeoutMs);
        } catch (e: any) {
          if (e instanceof WebApiError && e.status === 429 && retries < 5) {
            retries++;
            await sleep(((e as any).retryAfter || 60) * 1000);
            continue;
          }
          // หยุดเว็บนี้ ไม่ขยับวันที่ → รอบหน้าเริ่มช่วงนี้ใหม่
          result.error = `${site.name} ${type} ${start}..${end} หน้า ${page}: ${e?.message || e}`;
          return result;
        }
        retries = 0;
        const saved = await saveRows(site, type, resp.data);
        result.transactions += saved.tx;
        result.newCustomers += saved.newCustomers;
        lastPage = resp.lastPage;
        page++;
      } while (page <= lastPage);
    }
    // ครบทั้งฝากและถอนของเดือนนี้ → จำไว้ว่าดึงถึงวันไหนแล้ว
    await pool.query('UPDATE sites SET tx_synced_until = $2 WHERE id = $1', [site.id, end]);
  }
  return result;
}
