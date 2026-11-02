// อ่านไฟล์ Excel (.xlsx) / CSV แล้วดึงเบอร์โทรออกมา
import ExcelJS from 'exceljs';

const PHONE_HEADER = /(เบอร์|โทร|phone|tel|mobile|username|ยูส)/i;

/** ทำเบอร์ให้เป็นรูปแบบเดียว: ตัวเลขล้วน, Excel ที่ตัด 0 หน้าออก (9 หลักขึ้นต้น 6/8/9) เติม 0 คืน, +66 → 0 */
export function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(typeof raw === 'object' && raw && 'text' in (raw as any) ? (raw as any).text : raw).trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+66')) s = '0' + s.slice(3);
  else if (/^66\d{9}$/.test(s)) s = '0' + s.slice(2);
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 9 && /^[689]/.test(s)) s = '0' + s;
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function rowsFromCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(/[,;\t]/).map((c) => c.replace(/^"|"$/g, '').trim()));
}

async function rowsFromXlsx(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1); // exceljs เริ่ม index 1
    rows.push(vals);
  });
  return rows;
}

export interface ParsedPhones {
  phones: string[]; // ไม่ซ้ำ
  invalid: number;
  duplicates: number;
}

export async function parsePhoneFile(filename: string, buf: Buffer): Promise<ParsedPhones> {
  const rows = /\.xlsx$/i.test(filename) ? await rowsFromXlsx(buf) : rowsFromCsv(buf.toString('utf8'));
  if (rows.length === 0) return { phones: [], invalid: 0, duplicates: 0 };

  // หาคอลัมน์เบอร์จากหัวตาราง ถ้าไม่มีหัว ใช้คอลัมน์แรก
  let col = 0;
  let start = 0;
  const header = rows[0].map((c) => String(c ?? ''));
  const idx = header.findIndex((h) => PHONE_HEADER.test(h));
  if (idx >= 0) {
    col = idx;
    start = 1;
  } else if (!normalizePhone(rows[0][0])) {
    start = 1; // แถวแรกเป็นหัวตารางที่ไม่รู้จัก
  }

  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  for (let i = start; i < rows.length; i++) {
    const p = normalizePhone(rows[i][col]);
    if (!p) {
      if (rows[i][col] !== undefined && String(rows[i][col] ?? '').trim() !== '') invalid++;
      continue;
    }
    if (seen.has(p)) duplicates++;
    else seen.add(p);
  }
  return { phones: [...seen], invalid, duplicates };
}
