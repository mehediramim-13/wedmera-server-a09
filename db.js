import "dotenv/config";
import { MongoClient } from "mongodb";

let client;
let db;
let connectionPromise;
let indexesCreated = false;

export function validateRequiredEnv() {
  const required = ["MONGODB_URL", "DB_NAME", "JWKS_URL", "CLIENT_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "IMGBB_API_KEY"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
}

export async function connectDB() {
  validateRequiredEnv();
  if (db && indexesCreated) return db;
  if (!connectionPromise) {
    connectionPromise = (async () => {
      if (!client) client = new MongoClient(process.env.MONGODB_URL);
      await client.connect();
      db = client.db(process.env.DB_NAME);
      if (!indexesCreated) {
        await Promise.all([
          db.collection("services").createIndex({ vendorId: 1 }),
          db.collection("services").createIndex({ status: 1, isActive: 1, category: 1 }),
          db.collection("services").createIndex({ serviceName: "text", description: "text", location: "text" }),
          db.collection("bookings").createIndex({ customerId: 1 }),
          db.collection("bookings").createIndex({ vendorId: 1 }),
          db.collection("bookings").createIndex({ serviceId: 1, eventDate: 1 }),
          db.collection("transactions").createIndex({ stripeSessionId: 1 }, { unique: true }),
          db.collection("transactions").createIndex({ vendorId: 1 }),
        ]);
        indexesCreated = true;
      }
      return db;
    })().catch((error) => {
      connectionPromise = null;
      throw error;
    });
  }
  return connectionPromise;
}

export function getDb() {
  if (!db) throw new Error("Database is not connected.");
  return db;
}
