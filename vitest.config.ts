import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/customer_data_test',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'test',
    },
  },
});
