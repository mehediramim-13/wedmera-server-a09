import { sendResponse } from "../helpers.js";

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return sendResponse(res, 401, false, "Authentication required.");
    if (!allowedRoles.includes(req.user.role)) return sendResponse(res, 403, false, "Forbidden.");
    next();
  };
}
