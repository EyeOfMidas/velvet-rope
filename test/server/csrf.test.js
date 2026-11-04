import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';

let app;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
const inject = (opts) => {
  app ??= buildApp({ db: openDb(':memory:') });
  return app.inject(opts);
};

describe('csrf guard', () => {
  it('lets a body-less DELETE through with just the header', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/nothing', headers: { 'x-velvet-rope': '1' } });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a request without the header, even body-less', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/nothing' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('refuses a text/plain body', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/nothing',
      headers: { 'x-velvet-rope': '1', 'content-type': 'text/plain' },
      payload: 'hi',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('needs nothing on a safe method', async () => {
    const res = await inject({ method: 'GET', url: '/api/nothing' });
    expect(res.statusCode).toBe(404);
  });
});
