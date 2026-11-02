import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { normalizePhone, parsePhoneFile } from '../src/importer';

describe('normalizePhone', () => {
  it.each([
    ['0812345678', '0812345678'],
    ['081-234-5678', '0812345678'],
    ['+66812345678', '0812345678'],
    ['66812345678', '0812345678'],
    [812345678, '0812345678'], // Excel ตัด 0 หน้า
    ['abc', null],
    ['123', null],
    ['', null],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));
});

describe('parsePhoneFile', () => {
  it('reads CSV with a phone header in another column', async () => {
    const csv = 'name,เบอร์โทร\nA,0811111111\nB,0822222222\nC,0811111111\nD,xx\n';
    const r = await parsePhoneFile('a.csv', Buffer.from(csv));
    expect(r).toEqual({ phones: ['0811111111', '0822222222'], invalid: 1, duplicates: 1 });
  });

  it('reads headerless CSV', async () => {
    const r = await parsePhoneFile('a.csv', Buffer.from('0811111111\r\n0822222222\r\n'));
    expect(r.phones).toEqual(['0811111111', '0822222222']);
  });

  it('reads xlsx where Excel stored phones as numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['username', 'note']);
    ws.addRow([812345678, 'x']);
    ws.addRow(['0899999999', 'y']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parsePhoneFile('a.xlsx', buf);
    expect(r.phones).toEqual(['0812345678', '0899999999']);
  });
});
