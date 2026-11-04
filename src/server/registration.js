// Registering a new member and their passkey device, shared by creating a group and joining one by
// QR. Each passkey gets a fresh random WebAuthn user handle, never reused, so every device is its
// own WebAuthn account.
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

/** Inserts a member (a person); call inside a transaction. Returns { id, name, role }. */
export function insertMember(db, { id = randomUUID(), groupId, name, role, now }) {
  const member = { id, name, role };
  db.prepare('INSERT INTO members (id, group_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    member.id,
    groupId,
    name,
    role,
    now,
  );
  return member;
}

/**
 * Inserts a device of the member, and its credential when a passkey was registered; call inside a
 * transaction. Returns { id, label, kind }.
 */
export function insertDevice(
  db,
  { id = randomUUID(), memberId, label, kind = 'passkey', userHandle = null, registrationInfo, now },
) {
  const device = { id, label, kind };
  db.prepare(
    `INSERT INTO devices (id, member_id, group_id, label, kind, user_handle, created_at, last_used_at)
     SELECT ?, id, group_id, ?, ?, ?, ?, ? FROM members WHERE id = ?`,
  ).run(device.id, label, kind, userHandle, now, now, memberId);
  if (registrationInfo) insertCredential(db, { deviceId: device.id, registrationInfo });
  return device;
}

/** Inserts the credential a verified registration made, for a device; call inside a transaction. */
export function insertCredential(db, { deviceId, registrationInfo }) {
  const { credential, credentialBackedUp } = registrationInfo;
  db.prepare(
    `INSERT INTO credentials (credential_id, device_id, public_key, sign_count, transports, backed_up)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    credential.id,
    deviceId,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    credentialBackedUp ? 1 : 0,
  );
}
