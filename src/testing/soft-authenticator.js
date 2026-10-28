// A software WebAuthn authenticator for API tests. It holds real ES256 keys (node:crypto) and
// produces real `none` attestations and assertions, so the server's verification runs unmocked.
//
//   const auth = createSoftAuthenticator({ origin: 'http://localhost:5173' });
//   const registrationJSON = auth.register(creationOptionsJSON);
//   const assertionJSON = auth.authenticate(requestOptionsJSON); // uses the last registered credential
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function coseEs256PublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return isoCBOR.encode(
    new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
}

export function createSoftAuthenticator({ origin, userVerified = true } = {}) {
  const credentials = [];

  function flags(extra = 0) {
    return FLAG_UP | (userVerified ? FLAG_UV : 0) | extra;
  }

  function clientData(type, challenge, overrideOrigin) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: overrideOrigin ?? origin, crossOrigin: false }),
    );
  }

  return {
    credentials,

    /** Answer PublicKeyCredentialCreationOptionsJSON with a RegistrationResponseJSON. */
    register(options, { origin: overrideOrigin } = {}) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const credentialId = randomBytes(16);
      const credential = {
        id: b64url(credentialId),
        privateKey,
        rpId: options.rp.id,
        userHandle: options.user.id,
        counter: 0,
      };

      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(options.rp.id),
        Buffer.from([flags(FLAG_AT)]),
        uint32(credential.counter),
        Buffer.alloc(16), // AAGUID: zeros for `none` attestation
        idLength,
        credentialId,
        coseEs256PublicKey(publicKey),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );

      credentials.push(credential);
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge, overrideOrigin)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    /** Answer PublicKeyCredentialRequestOptionsJSON with an AuthenticationResponseJSON. */
    authenticate(options, { credential = credentials.at(-1), origin: overrideOrigin } = {}) {
      if (!credential) throw new Error('soft authenticator has no credential');
      credential.counter += 1;
      const authData = Buffer.concat([
        sha256(options.rpId ?? credential.rpId),
        Buffer.from([flags()]),
        uint32(credential.counter),
      ]);
      const clientDataJSON = clientData('webauthn.get', options.challenge, overrideOrigin);
      const signature = sign(
        'sha256',
        Buffer.concat([authData, sha256(clientDataJSON)]),
        credential.privateKey,
      );
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          userHandle: credential.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
