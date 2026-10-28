import { describe, it, expect } from 'vitest';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { createSoftAuthenticator } from '../src/testing/soft-authenticator.js';

const origin = 'http://localhost:5173';
const rpID = 'localhost';

describe('soft authenticator', () => {
  it('produces registrations and assertions that @simplewebauthn/server verifies', async () => {
    const auth = createSoftAuthenticator({ origin });
    const regOptions = await generateRegistrationOptions({ rpName: 'T', rpID, userName: 'u' });
    const reg = await verifyRegistrationResponse({
      response: auth.register(regOptions),
      expectedChallenge: regOptions.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    expect(reg.verified).toBe(true);
    expect(reg.registrationInfo.fmt).toBe('none');

    const authOptions = await generateAuthenticationOptions({ rpID });
    const assertion = auth.authenticate(authOptions);
    expect(assertion.response.userHandle).toBe(regOptions.user.id);
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: authOptions.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: reg.registrationInfo.credential,
    });
    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(1);
  });

  it('can be told to answer from another origin, which verification rejects', async () => {
    const auth = createSoftAuthenticator({ origin });
    const options = await generateRegistrationOptions({ rpName: 'T', rpID, userName: 'u' });
    await expect(
      verifyRegistrationResponse({
        response: auth.register(options, { origin: 'https://evil.example' }),
        expectedChallenge: options.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      }),
    ).rejects.toThrow(/origin/i);
  });
});
