// เรียก API user_report ของเว็บ: POST {username: เบอร์, token} → ยอดฝาก/ถอน/บัญชี/ผู้แนะนำ
export interface Site {
  id: number;
  name: string;
  api_url: string;
  api_token: string;
}

export class WebApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function fetchUserReport(site: Site, phone: string, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    res = await fetch(site.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: phone, token: site.api_token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new WebApiError(e?.name === 'TimeoutError' ? 'timeout' : e?.message || String(e));
  }
  const text = await res.text();
  if (!res.ok) throw new WebApiError(`HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new WebApiError(`ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`, res.status);
  }
}

/** API ตอบมาแต่ไม่มีข้อมูลลูกค้าคนนี้ */
export function isNotFound(data: any): boolean {
  return !data || typeof data !== 'object' || (data.total_deposit === undefined && !data.account_name);
}

// ระดับเดียวกับระบบ LINE: VIP ≥10k / VIP2 ≥100k / SUPER VIP ≥500k
export function rankOf(totalDeposit: number): string | null {
  if (totalDeposit >= 500000) return 'SUPER VIP';
  if (totalDeposit >= 100000) return 'VIP2';
  if (totalDeposit >= 10000) return 'VIP';
  return null;
}

export function toCustomerFields(data: any) {
  const totalDeposit = parseFloat(data?.total_deposit || '0') || 0;
  return {
    total_deposit: totalDeposit,
    total_withdraw: parseFloat(data?.total_withdraw || '0') || 0,
    count_deposit: parseInt(data?.count_deposit || '0', 10) || 0,
    count_withdraw: parseInt(data?.count_withdraw || '0', 10) || 0,
    account_name: data?.account_name || null,
    account_number: data?.account_number || null,
    bank_short: data?.bank_short || null,
    registered_at: data?.registered_at || null,
    referrer: data?.referrer || null,
    last_deposit: data?.last_deposit || null,
    rank: rankOf(totalDeposit),
  };
}
