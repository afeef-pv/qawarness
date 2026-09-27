import { MongoClient } from "mongodb";
import { MongoRunStore } from "./run-store";

export async function connectMongoRunStore(uri: string, database: string): Promise<{ client: MongoClient; store: MongoRunStore }> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const store = new MongoRunStore(client.db(database));
    await store.ensureIndexes();
    return { client, store };
  } catch {
    await client.close();
    throw new Error("MongoDB connection or index initialization failed; check MONGODB_URI and server availability");
  }
}
