// Registering a new passkey, shared by creating a group and joining one by QR. Each passkey gets
// a fresh random WebAuthn user handle, never reused, so every device is its own account.
import { randomBytes, randomUUID } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';

// EdDSA, ES256, RS256: what browsers' authenticators use. (v14's default adds experimental ML-DSA.)
export const ALGORITHMS = [-8, -7, -257];

/**
 * Registration options for a new discoverable passkey named `name`. `localDevice` asks for this
 * device's own authenticator rather than the browser's "use a phone" QR.
 */
export function registrationOptions(rp, { name, excludeCredentials = [], localDevice = false }) {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: randomBytes(32),
    userName: name,
    userDisplayName: name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    ...(localDevice ? { preferredAuthenticatorType: 'localDevice' } : {}),
    excludeCredentials,
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

/** The verified registration info, or null. Never throws: the error text can echo challenges. */
export async function verifyRegistration(rp, response, challenge) {
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    return verification.verified ? verification.registrationInfo : null;
  } catch {
    return null;
  }
}

/** Inserts the passkey and its credential; call inside a transaction. Returns { id, label, role }. */
export function insertPasskey(db, { groupId, label, role, userHandle, registrationInfo, now }) {
  const { credential, credentialBackedUp } = registrationInfo;
  const passkey = { id: randomUUID(), label, role };
  db.prepare(
    `INSERT INTO passkeys (id, group_id, label, role, user_handle, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(passkey.id, groupId, label, role, userHandle, now, now);
  db.prepare(
    `INSERT INTO credentials (credential_id, passkey_id, public_key, sign_count, transports, backed_up)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    credential.id,
    passkey.id,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    credentialBackedUp ? 1 : 0,
  );
  return passkey;
}
