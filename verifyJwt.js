import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks;

export function verifyToken(token) {
  if (!process.env.JWKS_URL) throw new Error("Missing required environment variable: JWKS_URL");
  if (!jwks) jwks = createRemoteJWKSet(new URL(process.env.JWKS_URL));
  const options = {};
  if (process.env.JWT_ISSUER) options.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) options.audience = process.env.JWT_AUDIENCE;
  return jwtVerify(token, jwks, options);
}
