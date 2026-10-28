import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'velvet-rope',
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
