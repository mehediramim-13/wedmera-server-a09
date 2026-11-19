import { sendResponse } from "../helpers.js";
import { sendUnauthorized } from "./unauthorized.js";

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      // Defensive: requireRole is normally mounted after requireAuth.
      return sendUnauthorized(res, "missing_token", "Authentication required.");
    }
    if (!allowedRoles.includes(req.user.role)) return sendResponse(res, 403, false, "Forbidden.");
    next();
  };
}
