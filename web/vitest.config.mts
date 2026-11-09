import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)), 'server-only': fileURLToPath(new URL('./tests/server-only.ts', import.meta.url)) } }, test: { include: ['tests/gasless-*.test.ts', 'tests/bso*.test.ts', 'tests/relay-*.test.ts', 'tests/tap-pending.test.ts', 'tests/flow-timing.test.ts', 'tests/relay-readiness.test.ts', 'tests/sponsorship-*.test.ts'], environment: 'node' } });
