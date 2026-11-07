import cron from 'node-cron';
import { config } from './config';
import { migrate } from './db';
import { createApp } from './app';
import { startSync } from './sync';

async function main() {
  await migrate();
  createApp().listen(config.port, config.host, () => {
    console.log(`customer-data เปิดที่ http://${config.host}:${config.port}`);
  });

  if (config.sync.enabled) {
    cron.schedule(
      config.sync.cron,
      () => {
        startSync('cron')
          .then((id) => !id && console.log('[cron] มีรอบอื่นกำลังรันอยู่ ข้าม'))
          .catch((e) => console.error('[cron]', e));
      },
      { timezone: 'Asia/Bangkok' },
    );
    console.log(`ตั้ง sync อัตโนมัติ: "${config.sync.cron}" (เวลาไทย)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
