/**
 * Single place for every 401 so each failure is distinguishable in server logs
 * (and in development responses) without ever exposing the token.
 */
export function sendUnauthorized(res, reason, message, detail) {
  console.error(`Authentication failed: ${reason}${detail ? ` (${detail})` : ""}`);
  const body = { success: false, message };
  if (process.env.NODE_ENV !== "production") body.reason = reason;
  return res.status(401).json(body);
}
