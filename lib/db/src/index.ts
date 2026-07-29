import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type DbClient = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | undefined;
let _db: DbClient | undefined;

function initPool(): pg.Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL must be set. Did you forget to provision a database?",
      );
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

function initDb(): DbClient {
  if (!_db) {
    _db = drizzle(initPool(), { schema });
  }
  return _db;
}

function lazyProxy<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const value = Reflect.get(get() as object, prop, receiver);
      return typeof value === "function" ? value.bind(get()) : value;
    },
    has(_target, prop) {
      return Reflect.has(get() as object, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(get() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(get() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(get() as object);
    },
  });
}

/**
 * Lazily initialized: the pg Pool / drizzle client are only created on first
 * property access, so importing this module never requires DATABASE_URL
 * (important for Next.js build-time page-data collection). The clear
 * "DATABASE_URL must be set" error is thrown on first actual use instead.
 */
export const pool: pg.Pool = lazyProxy(initPool);
export const db: DbClient = lazyProxy(initDb);

export * from "./schema";
