// ดึงข้อมูลลูกค้าทุกเบอร์จาก API เว็บ ทีละเบอร์แบบเว้นช่วง
// - เรียงจากเบอร์ที่ข้อมูลเก่าสุด/ยังไม่เคยดึงก่อน ถ้าหมดเวลาคืนถัดไปทำต่อ
// - API ตอบว่าไม่พบลูกค้า → ไม่เขียนทับข้อมูลเดิม
// - เว็บไหน error ติดกันหลายครั้ง (token ผิด/เว็บล่ม) → หยุดยิงเว็บนั้นในรอบนั้น
// - 429 (ยิงถี่เกิน) → พัก 60 วินาที
import { PoolClient } from 'pg';
import { pool } from './db';
import { config } from './config';
import { fetchUserReport, isNotFound, Site, toCustomerFields, WebApiError } from './webApi';

const LOCK_ID = 7_310_001; // pg advisory lock กันรันซ้อน

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopRequested = false;
let running = false;

export function isRunning() {
  return running;
}

export function requestStop() {
  stopRequested = true;
}

export interface SyncOptions {
  delayMs?: number;
  timeoutMs?: number;
  maxMs?: number;
  maxSiteErrors?: number;
  rateLimitPauseMs?: number;
  fetcher?: typeof fetchUserReport;
}

/** เริ่ม sync คืน run id หรือ null ถ้ามีรอบอื่นรันอยู่ */
export async function startSync(trigger: 'cron' | 'manual', opts: SyncOptions = {}): Promise<number | null> {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const r = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    locked = r.rows[0].ok;
  } catch (e) {
    lockClient.release();
    throw e;
  }
  if (!locked) {
    lockClient.release();
    return null;
  }
  const run = await pool.query('INSERT INTO sync_runs (trigger) VALUES ($1) RETURNING id', [trigger]);
  const runId: number = run.rows[0].id;
  running = true;
  stopRequested = false;
  const done = runSync(runId, opts).finally(async () => {
    running = false;
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lockClient.release();
    }
  });
  (startSync as any).lastPromise = done; // ให้เทสรอได้
  return runId;
}

async function runSync(runId: number, opts: SyncOptions): Promise<void> {
  const delayMs = opts.delayMs ?? config.sync.delayMs;
  const timeoutMs = opts.timeoutMs ?? config.sync.timeoutMs;
  const maxMs = opts.maxMs ?? config.sync.maxMs;
  const maxSiteErrors = opts.maxSiteErrors ?? config.sync.maxSiteErrors;
  const rateLimitPauseMs = opts.rateLimitPauseMs ?? 60000;
  const fetcher = opts.fetcher ?? fetchUserReport;

  const s = { total: 0, done: 0, updated: 0, notFound: 0, failed: 0, skippedSites: [] as string[], stopReason: null as string | null, lastError: null as string | null };
  const save = (finished = false) =>
    pool.query(
      `UPDATE sync_runs SET total=$2, done=$3, updated=$4, not_found=$5, failed=$6, skipped_sites=$7,
         stop_reason=$8, last_error=$9, finished_at = CASE WHEN $10 THEN now() ELSE finished_at END
       WHERE id=$1`,
      [runId, s.total, s.done, s.updated, s.notFound, s.failed, s.skippedSites, s.stopReason, s.lastError, finished],
    );

  const t0 = Date.now();
  try {
    const sites = new Map<number, Site>();
    for (const row of (await pool.query('SELECT id, name, api_url, api_token FROM sites WHERE enabled')).rows) {
      sites.set(row.id, row);
    }
    const jobs = (
      await pool.query(
        `SELECT c.id, c.site_id, c.phone FROM customers c JOIN sites s ON s.id = c.site_id
         WHERE s.enabled ORDER BY c.synced_at ASC NULLS FIRST, c.id`,
      )
    ).rows as { id: number; site_id: number; phone: string }[];
    s.total = jobs.length;
    await save();
    console.log(`[sync #${runId}] เริ่ม ${jobs.length} เบอร์`);

    const siteErrors = new Map<number, number>();
    const deadSites = new Set<number>();

    for (const job of jobs) {
      if (stopRequested) {
        s.stopReason = 'สั่งหยุด';
        break;
      }
      if (Date.now() - t0 > maxMs) {
        s.stopReason = 'หมดเวลาที่กำหนด (รอบถัดไปทำต่อจากเบอร์ที่เก่าที่สุด)';
        break;
      }
      const site = sites.get(job.site_id)!;
      if (deadSites.has(site.id)) {
        s.done++;
        continue;
      }

      let result: 'ok' | 'not_found' | 'error' | 'rate_limited';
      try {
        const data = await fetcher(site, job.phone, timeoutMs);
        if (isNotFound(data)) {
          result = 'not_found';
          await pool.query(`UPDATE customers SET last_status='not_found', last_error=NULL WHERE id=$1`, [job.id]);
        } else {
          result = 'ok';
          const f = toCustomerFields(data);
          await pool.query(
            `UPDATE customers SET total_deposit=$2, total_withdraw=$3, count_deposit=$4, count_withdraw=$5,
               account_name=$6, account_number=$7, bank_short=$8, registered_at=$9, referrer=$10,
               last_deposit=$11, rank=$12, synced_at=now(), last_status='ok', last_error=NULL
             WHERE id=$1`,
            [job.id, f.total_deposit, f.total_withdraw, f.count_deposit, f.count_withdraw, f.account_name,
             f.account_number, f.bank_short, f.registered_at, f.referrer, f.last_deposit, f.rank],
          );
        }
      } catch (e: any) {
        const status = e instanceof WebApiError ? e.status : undefined;
        const msg = e?.message || String(e);
        if (status === 404) {
          result = 'not_found';
          await pool.query(`UPDATE customers SET last_status='not_found', last_error=NULL WHERE id=$1`, [job.id]);
        } else {
          result = status === 429 ? 'rate_limited' : 'error';
          s.lastError = `${site.name} ${job.phone}: ${msg}`;
          await pool.query(`UPDATE customers SET last_status='error', last_error=$2 WHERE id=$1`, [job.id, msg.slice(0, 500)]);
        }
      }

      s.done++;
      if (result === 'ok') s.updated++;
      else if (result === 'not_found') s.notFound++;
      else s.failed++;

      if (result === 'error') {
        const n = (siteErrors.get(site.id) || 0) + 1;
        siteErrors.set(site.id, n);
        if (n >= maxSiteErrors) {
          deadSites.add(site.id);
          s.skippedSites.push(site.name);
          console.warn(`[sync #${runId}] เว็บ "${site.name}" error ติดกัน ${n} ครั้ง หยุดยิงเว็บนี้ (เช็ก API URL/Token)`);
        }
      } else {
        siteErrors.set(site.id, 0);
      }

      if (s.done % 20 === 0) await save();
      if (result === 'rate_limited') await sleep(rateLimitPauseMs);
      await sleep(delayMs);
    }
  } catch (e: any) {
    s.lastError = e?.message || String(e);
    s.stopReason = 'error';
    console.error(`[sync #${runId}] ล้มเหลว: ${s.lastError}`);
  } finally {
    await save(true);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(
      `[sync #${runId}] จบ ${s.done}/${s.total} ใน ${mins} นาที: อัปเดต ${s.updated}, ไม่พบ ${s.notFound}, ล้มเหลว ${s.failed}` +
        (s.stopReason ? `, หยุดเพราะ: ${s.stopReason}` : ''),
    );
  }
}
