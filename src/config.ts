import fs from 'fs';
import path from 'path';

// โหลด .env แบบง่าย (ไม่ทับค่าที่ตั้งไว้แล้วใน environment)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function num(name: string, def: number, min: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : def;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://localhost/customer_data',
  port: num('PORT', 3100, 1),
  // VPS หลัง nginx = 127.0.0.1 ; Railway/Docker = 0.0.0.0
  host: process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sync: {
    enabled: process.env.SYNC_ENABLED !== 'false',
    cron: process.env.SYNC_CRON || '0 2 * * *',
    delayMs: num('SYNC_DELAY_MS', 500, 100),
    timeoutMs: num('SYNC_TIMEOUT_MS', 15000, 1000),
    maxMs: num('SYNC_MAX_HOURS', 5, 0.01) * 3600 * 1000,
    maxSiteErrors: num('SYNC_MAX_SITE_ERRORS', 10, 1),
  },
  tx: {
    // ดึงรายการฝาก/ถอน (report-deposit/withdraw) เพื่อเติมรายชื่อเบอร์อัตโนมัติ
    enabled: process.env.TX_ENABLED !== 'false',
    // ครั้งแรกดึงย้อนหลังกี่เดือน
    historyMonths: num('TX_HISTORY_MONTHS', 12, 1),
    // เว้นระหว่างแต่ละครั้ง (ลิมิตเว็บ 60 ครั้ง/นาที/IP รวม 3 เส้น) 1100ms ≈ 55 ครั้ง/นาที
    delayMs: num('TX_DELAY_MS', 1100, 0),
    perPage: num('TX_PER_PAGE', 500, 1),
    // ทุกคืนดึงซ้ำย้อนหลังกี่วัน (เผื่อรายการที่สถานะเปลี่ยน)
    overlapDays: num('TX_OVERLAP_DAYS', 3, 0),
  },
};
