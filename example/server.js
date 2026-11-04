// Runs the example's API on port 3001. Start the page with `npm run example:web`; open
// http://localhost:5174 in two browser profiles to try joining.
import { mkdirSync } from 'node:fs';
import { startSweeper } from '../src/server/index.js';
import { buildApp, openDb } from './app.js';

mkdirSync('example/data', { recursive: true });
const db = openDb('example/data/notes.db');
// KEYS=1 also allows device keys, for devices that can't make a passkey.
const credentials = process.env.KEYS ? ['passkey', 'key'] : undefined;
const app = buildApp({ db, origin: process.env.ORIGIN ?? 'http://localhost:5174', credentials });
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' });
startSweeper(db);
console.log('velvet-rope example API on http://127.0.0.1:3001');
