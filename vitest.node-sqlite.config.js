// The whole suite on node:sqlite instead of whichever driver is found first.
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

export default mergeConfig(
  base,
  defineConfig({ test: { name: 'velvet-rope (node:sqlite)', env: { VELVET_ROPE_DRIVER: 'node:sqlite' } } }),
);
