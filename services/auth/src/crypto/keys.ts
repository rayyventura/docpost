import crypto from 'node:crypto';
import { exportJWK, importSPKI, importPKCS8 } from 'jose';
import type { CryptoKey as JoseCryptoKey, JWK } from 'jose';

let privateKey: JoseCryptoKey;
let publicKey: JoseCryptoKey;
let kid: string;

export async function initKeys(): Promise<void> {
  const privateKeyPem = process.env.JWT_PRIVATE_KEY;
  const publicKeyPem = process.env.JWT_PUBLIC_KEY;

  if (privateKeyPem && publicKeyPem) {
    // Production: read keys from environment
    privateKey = await importPKCS8(privateKeyPem, 'RS256');
    publicKey = await importSPKI(publicKeyPem, 'RS256');
  } else {
    // Development: generate a key pair on startup
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    privateKey = await importPKCS8(keyPair.privateKey as string, 'RS256');
    publicKey = await importSPKI(keyPair.publicKey as string, 'RS256');
  }

  // Generate a deterministic kid based on the public key thumbprint
  const jwk = await exportJWK(publicKey);
  kid = generateKid(jwk);
}

function generateKid(jwk: JWK): string {
  const thumbprintInput = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(thumbprintInput).digest('base64url').slice(0, 16);
}

export function getPrivateKey(): JoseCryptoKey {
  if (!privateKey) {
    throw new Error('Keys not initialized. Call initKeys() first.');
  }
  return privateKey;
}

export function getPublicKey(): JoseCryptoKey {
  if (!publicKey) {
    throw new Error('Keys not initialized. Call initKeys() first.');
  }
  return publicKey;
}

export function getKid(): string {
  if (!kid) {
    throw new Error('Keys not initialized. Call initKeys() first.');
  }
  return kid;
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(getPublicKey());
  return {
    keys: [
      {
        ...jwk,
        alg: 'RS256',
        use: 'sig',
        kid: getKid(),
      },
    ],
  };
}
