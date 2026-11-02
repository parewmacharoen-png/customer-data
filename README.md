# customer-data

ระบบข้อมูลลูกค้า สำหรับทีมการตลาดและ CRM — **แยกจากระบบ LINE แอดมินโดยสิ้นเชิง** (โค้ด, ฐานข้อมูล, โปรเซส คนละชุด)

## ทำอะไรได้
- **ตั้งค่าเว็บ**: ใส่ API URL (`/api/user_report`) + Token ของแต่ละเว็บ (Token ไม่แสดงเต็มบนหน้าจอ)
- **นำเข้าเบอร์**: อัปโหลด .xlsx / .csv ระบบหาคอลัมน์ "เบอร์/โทร/phone/username" เอง, เติม 0 หน้าที่ Excel ตัดทิ้ง, ไม่เพิ่มเบอร์ซ้ำ
- **ดึงข้อมูลทุกคืน 02:00 (เวลาไทย)**: ยิง API เว็บทีละเบอร์ เว้น 0.5 วินาที (~120 ครั้ง/นาที; ลิมิตเว็บ 600/นาที/IP)
  - เบอร์ที่ข้อมูลเก่าที่สุด/ยังไม่เคยดึง ไปก่อน — ถ้าเกิน 5 ชม. หยุดแล้วคืนถัดไปทำต่อ
  - เว็บตอบว่าไม่พบลูกค้า → ไม่เขียนทับข้อมูลเดิม
  - เว็บไหน error ติดกัน 10 ครั้ง (Token ผิด/เว็บล่ม) → หยุดยิงเว็บนั้นในรอบนั้น, เจอ 429 พัก 60 วินาที
  - กดปุ่ม "ดึงข้อมูลเลยตอนนี้" / "หยุด" ได้จากหน้าสถานะ
- **ลูกค้า**: ค้นหา (เบอร์/ชื่อบัญชี/ผู้แนะนำ/เลขบัญชี), กรองเว็บ/ระดับ/สถานะ, เรียงตามยอดฝาก, โหลดเป็น CSV เปิดใน Excel ได้ (ภาษาไทยไม่เพี้ยน, 0 หน้าเบอร์ไม่หาย)
- ระดับ: VIP ≥ 10,000 / VIP2 ≥ 100,000 / SUPER VIP ≥ 500,000 (ยอดฝากรวม)

## ติดตั้งบน VPS (ครั้งแรก)
ต้องมี Node.js 20+ และ PostgreSQL (ใช้เครื่องเดิมได้ แต่สร้าง **ฐานข้อมูลใหม่แยก**)

```bash
# 1) ฐานข้อมูลแยกของแอปนี้
sudo -u postgres psql -c "CREATE USER customer_data WITH PASSWORD 'รหัสที่ตั้งเอง';"
sudo -u postgres psql -c "CREATE DATABASE customer_data OWNER customer_data;"

# 2) โค้ด
cd /opt && git clone https://github.com/parewmacharoen-png/customer-data.git
cd customer-data && npm ci && npm run build
cp .env.example .env && nano .env   # ใส่ DATABASE_URL, ADMIN_PASSWORD

# 3) รันด้วย pm2 (ตารางสร้างให้อัตโนมัติตอนเปิด)
pm2 start ecosystem.config.js && pm2 save
```

แอปเปิดที่ `127.0.0.1:3100` (เข้าจากภายนอกตรง ๆ ไม่ได้) ให้เปิดผ่าน nginx เช่น subdomain ใหม่:

```nginx
server {
  server_name customers.linennext.fun;
  client_max_body_size 20m;
  location / { proxy_pass http://127.0.0.1:3100; proxy_set_header Host $host; }
}
```
แล้ว `sudo certbot --nginx -d customers.linennext.fun` เพื่อเปิด https (ต้องเพิ่ม DNS ของ subdomain ก่อน)

## อัปเดตเวอร์ชัน
```bash
cd /opt/customer-data && git pull && npm ci && npm run build && pm2 restart customer-data
```

## ตั้งค่า (.env)
ดู `.env.example` — ที่ปรับบ่อย: `SYNC_DELAY_MS` (ความถี่ยิง), `SYNC_CRON` (เวลา), `SYNC_ENABLED=false` (ปิดดึงอัตโนมัติ)

## พัฒนา / ทดสอบ
```bash
npm run dev     # รันแบบ dev
npm test        # ต้องมี Postgres ทดสอบ (TEST_DATABASE_URL, ค่าเริ่มต้น postgres://postgres@localhost:5433/customer_data_test)
```

## ต่อไป
- หน้ารายงาน (VIP ทั้งหมด, ไม่ได้ฝากนาน, แยกตามผู้แนะนำ) — ขั้นที่ 2
- ถ้าเว็บเปิด API รายชื่อสมาชิกทั้งหมด → ดึงรายชื่อเบอร์อัตโนมัติแทนการอัปโหลด
- ประวัติฝาก-ถอนรายรายการ (รอผู้ให้บริการแก้ API report-deposit/withdraw/statement)
