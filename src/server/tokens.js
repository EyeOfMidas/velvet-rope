import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, base64url. */
export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
