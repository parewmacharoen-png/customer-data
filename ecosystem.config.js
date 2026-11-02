// pm2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'customer-data',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1, // ต้องเป็น 1 ตัว (มี lock กันซ้อนอยู่แล้ว แต่ไม่จำเป็นต้องมีหลายตัว)
      exec_mode: 'fork',
      max_memory_restart: '400M',
    },
  ],
};
