import { sendResponse } from "../helpers.js";

export function notFound(req, res) {
  return sendResponse(res, 404, false, "Route not found.");
}

export function errorHandler(error, req, res, next) {
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return sendResponse(res, 400, false, "Invalid JSON body.");
  }
  if (error?.code === 11000) return sendResponse(res, 409, false, "Duplicate record.");
  console.error(error?.message || error);
  return sendResponse(res, 500, false, "Something went wrong on the server.");
}
