import { connectMongoRunStore } from "./client";
const uri = Bun.env.MONGODB_URI || "mongodb://localhost:27017";
const database = Bun.env.MONGODB_DB || "qawarness";
try {
  const { client } = await connectMongoRunStore(uri, database);
  try { console.log(`MongoDB indexes ready in ${database}`); } finally { await client.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
