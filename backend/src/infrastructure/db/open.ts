import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_PATH = join(import.meta.dirname, 'schema.sql');

/**
 * Opens (or creates) the sqlite database at `dbPath` and applies schema.sql.
 * Every statement in schema.sql is `IF NOT EXISTS`, so re-running it on
 * every open is a no-op migration -- safe to call on every boot.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}
