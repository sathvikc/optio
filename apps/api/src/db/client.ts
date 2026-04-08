import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { parseSslConfig } from "./ssl.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://optio:optio_dev@localhost:5432/optio";

const sslConfig = parseSslConfig(connectionString);
// postgres-js forwards unknown query params to the server as startup parameters,
// which fails for libpq-style ssl* params. Strip them before connecting.
const cleanedConnectionString = (() => {
  try {
    const u = new URL(connectionString);
    for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
      u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return connectionString;
  }
})();
const sql = postgres(cleanedConnectionString, sslConfig ? { ssl: sslConfig } : {});
export const db = drizzle(sql, { schema });
export type Database = typeof db;
