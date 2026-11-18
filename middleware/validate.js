import { sendResponse } from "../helpers.js";

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return sendResponse(res, 400, false, "Validation failed.", undefined, errors);
    }
    req.validated = result.data;
    next();
  };
}
