import "dotenv/config";
import { MongoClient } from "mongodb";

let client;
let db;
let connectionPromise;
let initializationPromise;

export function validateRequiredEnv() {
  for (const name of ["MONGODB_URL", "DB_NAME"]) {
    if (!process.env[name]?.trim()) {
      const error = new Error(`Missing required environment variable: ${name}`);
      console.error(error.message);
      throw error;
    }
  }
}

export async function connectDB() {
  validateRequiredEnv();
  if (db) return db;
  if (!connectionPromise) {
    connectionPromise = (async () => {
      if (!client) client = new MongoClient(process.env.MONGODB_URL);
      await client.connect();
      db = client.db(process.env.DB_NAME);
      return db;
    })().catch((error) => {
      connectionPromise = null;
      console.error("MongoDB connection failed:", error.message);
      throw error;
    });
  }
  return connectionPromise;
}

export async function initDatabase() {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const database = await connectDB();
    const existing = await database.listCollections({}, { nameOnly: true }).toArray();
    const existingNames = new Set(existing.map((collection) => collection.name));
    const businessCollections = ["services", "bookings", "transactions", "stripeEvents"];

    for (const name of businessCollections) {
      if (existingNames.has(name)) continue;
      try {
        await database.createCollection(name);
      } catch (error) {
        if (error.code !== 48) throw error;
      }
    }

    await Promise.all([
      database.collection("services").createIndex({ vendorId: 1 }),
      database.collection("services").createIndex({ status: 1, isActive: 1, category: 1 }),
      database.collection("services").createIndex({ price: 1 }),
      database.collection("services").createIndex({ createdAt: -1 }),
      database.collection("bookings").createIndex({ customerId: 1 }),
      database.collection("bookings").createIndex({ vendorId: 1 }),
      database.collection("bookings").createIndex({ serviceId: 1, eventDate: 1 }),
      database.collection("transactions").createIndex({ stripeSessionId: 1 }, { unique: true }),
      database.collection("transactions").createIndex(
        { paymentKey: 1 },
        { unique: true, partialFilterExpression: { paymentKey: { $type: "string" } } },
      ),
      database.collection("transactions").createIndex({ vendorId: 1 }),
      database.collection("transactions").createIndex({ vendorId: 1, createdAt: -1 }),
    ]);

    return database;
  })().catch((error) => {
    initializationPromise = null;
    console.error("MongoDB initialization failed:", error.message);
    throw error;
  });

  return initializationPromise;
}

export function getDb() {
  if (!db) throw new Error("Database is not connected.");
  return db;
}

export async function closeDB() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
  connectionPromise = undefined;
  initializationPromise = undefined;
}
