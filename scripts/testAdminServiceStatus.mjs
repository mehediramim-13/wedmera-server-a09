import "dotenv/config";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";

/**
 * Integration test for the admin service moderation endpoint used by the
 * dashboard:
 *
 *   PATCH /api/admin/services/:id  { "status": "Approved" | "Rejected" }
 *
 * It needs the API server and the Better Auth client to be running. It creates
 * two temporary users, one temporary service, verifies the behaviour, and
 * removes everything it created.
 *
 *   npm run test:admin-services
 */

const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")[0]
  .trim()
  .replace(/\/+$/, "");
const SERVER_URL = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`)
  .replace(/\/+$/, "");
const AUTH_BASE = `${CLIENT_URL}/api/auth`;
const API_BASE = `${SERVER_URL}/api`;

const stamp = Date.now();
const password = "TestPass123";
const adminEmail = `admin.route.test.${stamp}@wedmera.test`;
const customerEmail = `customer.route.test.${stamp}@wedmera.test`;

let client;
let db;
let users;
let sessions;
let accounts;
let services;
let serviceId;
const createdUserIds = [];

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function signUp(email, name) {
  const response = await fetch(`${AUTH_BASE}/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CLIENT_URL },
    body: JSON.stringify({ email, password, name, role: "customer" }),
  });
  const body = await readJson(response);
  assert.ok(response.ok, `sign-up ${email} failed: ${response.status} ${JSON.stringify(body)}`);
  const user = await users.findOne({ email });
  assert.ok(user, `sign-up ${email} did not create a database user`);
  createdUserIds.push(user._id);
  return user;
}

async function signIn(email) {
  const response = await fetch(`${AUTH_BASE}/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CLIENT_URL },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(response);
  assert.ok(response.ok, `sign-in ${email} failed: ${response.status} ${JSON.stringify(body)}`);

  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  assert.ok(cookies, `sign-in ${email} did not return a session cookie`);

  const tokenResponse = await fetch(`${AUTH_BASE}/token`, {
    headers: { Accept: "application/json", Origin: CLIENT_URL, Cookie: cookies },
  });
  const tokenBody = await readJson(tokenResponse);
  assert.ok(tokenResponse.ok, `token ${email} failed: ${tokenResponse.status} ${JSON.stringify(tokenBody)}`);
  const token = tokenBody?.token || tokenBody?.data?.token;
  assert.ok(token, `token ${email} response did not contain a JWT`);
  return token;
}

function requestServiceStatus(id, status, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_BASE}/admin/services/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status }),
  });
}

async function main() {
  client = new MongoClient(process.env.MONGODB_URL);
  await client.connect();
  db = client.db(process.env.DB_NAME);
  users = db.collection(process.env.USERS_COLLECTION || "user");
  sessions = db.collection("session");
  accounts = db.collection("account");
  services = db.collection("services");

  const admin = await signUp(adminEmail, "Admin Route Test");
  await signUp(customerEmail, "Customer Route Test");

  // Better Auth forbids creating admins through sign-up, so promote the test
  // user directly in the database before requesting its JWT.
  await users.updateOne({ _id: admin._id }, { $set: { role: "admin" } });

  const insert = await services.insertOne({
    serviceName: `Admin route test ${stamp}`,
    vendorId: admin._id,
    status: "Pending",
    // Keep the temporary listing out of public browse results while the test runs.
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  serviceId = insert.insertedId;

  const adminToken = await signIn(adminEmail);
  const customerToken = await signIn(customerEmail);

  let response = await requestServiceStatus(serviceId, "Approved");
  assert.equal(response.status, 401, `unauthenticated expected 401, got ${response.status}`);
  console.log("PASS unauthenticated -> 401");

  response = await requestServiceStatus(serviceId, "Approved", customerToken);
  assert.equal(response.status, 403, `non-admin expected 403, got ${response.status}`);
  console.log("PASS non-admin -> 403");

  response = await requestServiceStatus(serviceId, "Pending", adminToken);
  assert.equal(response.status, 400, `invalid status expected 400, got ${response.status}`);
  console.log("PASS invalid status -> 400");

  response = await requestServiceStatus("not-an-object-id", "Approved", adminToken);
  assert.equal(response.status, 400, `invalid id expected 400, got ${response.status}`);
  console.log("PASS invalid service id -> 400");

  response = await requestServiceStatus("aaaaaaaaaaaaaaaaaaaaaaaa", "Approved", adminToken);
  assert.equal(response.status, 404, `unknown service expected 404, got ${response.status}`);
  console.log("PASS unknown service -> 404");

  response = await requestServiceStatus(serviceId, "Approved", adminToken);
  let body = await readJson(response);
  assert.equal(response.status, 200, `approve expected 200, got ${response.status} ${JSON.stringify(body)}`);
  assert.equal(body?.success, true, "approve response did not have success: true");
  assert.equal(body?.data?.status, "Approved", "approve response did not return the updated service");
  assert.equal((await services.findOne({ _id: serviceId }))?.status, "Approved", "database status was not Approved");
  console.log("PASS admin approve -> 200 and database status Approved");

  response = await requestServiceStatus(serviceId, "Rejected", adminToken);
  body = await readJson(response);
  assert.equal(response.status, 200, `reject expected 200, got ${response.status} ${JSON.stringify(body)}`);
  assert.equal(body?.success, true, "reject response did not have success: true");
  assert.equal(body?.data?.status, "Rejected", "reject response did not return the updated service");
  assert.equal((await services.findOne({ _id: serviceId }))?.status, "Rejected", "database status was not Rejected");
  console.log("PASS admin reject -> 200 and database status Rejected");

  // The original endpoint must keep working for clients that still use it.
  response = await fetch(`${API_BASE}/admin/services/${serviceId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: "Approved" }),
  });
  assert.equal(response.status, 200, `legacy /status expected 200, got ${response.status}`);
  console.log("PASS legacy PATCH /admin/services/:id/status still works");
}

try {
  await main();
  console.log("\nAll admin service moderation checks passed.");
} catch (error) {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      if (serviceId) await services.deleteOne({ _id: serviceId });
      if (createdUserIds.length) {
        await sessions.deleteMany({ userId: { $in: createdUserIds } });
        await accounts.deleteMany({ userId: { $in: createdUserIds } });
        await users.deleteMany({ _id: { $in: createdUserIds } });
      }
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError.message);
    }
    await client.close();
  }
}
