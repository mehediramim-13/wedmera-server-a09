import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks;
let jwksUrl;

function getJwks(url) {
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url), {
      // The JWKS endpoint belongs to the client app. Keep a short timeout so
      // an unreachable client cannot stall protected requests, and a short
      // cooldown so a transient outage recovers quickly without hammering it.
      timeoutDuration: 5000,
      cooldownDuration: 5000,
      cacheMaxAge: 10 * 60 * 1000,
    });
    jwksUrl = url;
  }
  return jwks;
}

export function verifyToken(token) {
  // Use the configured Better Auth JWKS endpoint exactly as provided. Trim
  // only surrounding whitespace so a stray space in .env cannot break it.
  const configuredUrl = process.env.JWKS_URL?.trim();
  if (!configuredUrl) throw new Error("Missing required environment variable: JWKS_URL");

  const options = {};
  const issuer = process.env.JWT_ISSUER?.trim();
  const audience = process.env.JWT_AUDIENCE?.trim();
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;

  // Deliberately do not pass `algorithms`: Better Auth's JWT plugin signs with
  // EdDSA by default, and pinning an algorithm here would reject valid tokens
  // after a key/algorithm rotation. The signature and time claims are still
  // fully verified by jose.
  return jwtVerify(token, getJwks(configuredUrl), options);
}
