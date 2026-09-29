import { SignJWT } from 'jose';
import { getPrivateKey, getKid } from './keys.js';

const ISSUER = 'docpost-auth';
const USER_TOKEN_EXPIRY = '5m';
const SERVICE_TOKEN_EXPIRY = '15m';

export async function signUserToken(user: { id: string; email: string; name: string }): Promise<string> {
  const token = await new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'RS256', kid: getKid() })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(USER_TOKEN_EXPIRY)
    .setIssuer(ISSUER)
    .sign(getPrivateKey());

  return token;
}

export async function signServiceToken(client: {
  clientId: string;
  scopes: string[];
}): Promise<string> {
  const token = await new SignJWT({
    scope: client.scopes.join(' '),
    token_use: 'service',
  })
    .setProtectedHeader({ alg: 'RS256', kid: getKid() })
    .setSubject(client.clientId)
    .setIssuedAt()
    .setExpirationTime(SERVICE_TOKEN_EXPIRY)
    .setIssuer(ISSUER)
    .sign(getPrivateKey());

  return token;
}
