import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("Missing required environment variable: ADMIN_EMAIL");
  if (!process.env.MONGODB_URL) throw new Error("Missing required environment variable: MONGODB_URL");
  if (!process.env.DB_NAME) throw new Error("Missing required environment variable: DB_NAME");

  const client = new MongoClient(process.env.MONGODB_URL);
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);
    const users = db.collection(process.env.USERS_COLLECTION || "user");
    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) throw new Error(`Better Auth user not found for ${email}. Sign up on the client first.`);
    await users.updateOne(
      { _id: user._id },
      { $set: { role: "admin", isBlocked: false, updatedAt: new Date() } },
    );
    console.log(`Promoted ${email} (${String(user._id)}) to admin.`);
  } finally {
    await client.close();
  }
}

seedAdmin().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
