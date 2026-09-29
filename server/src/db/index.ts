/**
 * Database access layer.
 *
 * - When DATABASE_URL is present the app talks to PostgreSQL (production target).
 * - Otherwise it runs on an embedded SQLite file so a student/dev can start instantly.
 *
 * All SQL in the app uses `?` placeholders and portable types (TEXT ids, TEXT ISO-8601
 * timestamps, INTEGER counters) so a single query works on both engines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

export type Row = Record<string, unknown>;

export interface DbDriver {
  kind: 'postgres' | 'sqlite';
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * PostgreSQL returns native types (booleans as true/false, counters as numbers or bigint) where
 * SQLite returns 0/1 and integers. The rest of the app was written against SQLite semantics
 * (`row.enabled === 1`, `Number(row.c)`), so rows are normalised here instead of every query site.
 */
function normaliseRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else if (typeof value === 'bigint') out[key] = Number(value);
    else out[key] = value;
  }
  return out as T;
}

function normaliseParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (p === undefined) return null;
    return p;
  });
}

/* ------------------------------- Postgres ------------------------------- */

async function createPostgres(url: string): Promise<DbDriver> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000 });

  const driver: DbDriver = {
    kind: 'postgres',
    async all<T = Row>(sql: string, params?: unknown[]) {
      const res = await pool.query(toPgPlaceholders(sql), normaliseParams(params));
      return res.rows.map((row) => normaliseRow<T>(row));
    },
    async run(sql, params) {
      await pool.query(toPgPlaceholders(sql), normaliseParams(params));
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: DbDriver = {
          kind: 'postgres',
          async all<T = Row>(sql: string, params?: unknown[]) {
            const res = await client.query(toPgPlaceholders(sql), normaliseParams(params));
            return res.rows.map((row) => normaliseRow<T>(row));
          },
          async run(sql, params) {
            await client.query(toPgPlaceholders(sql), normaliseParams(params));
          },
          async exec(sql) {
            await client.query(sql);
          },
          transaction: (nested) => nested(tx),
          async close() {},
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return driver;
}

/* -------------------------------- SQLite -------------------------------- */

async function createSqlite(file: string): Promise<DbDriver> {
  const { default: Database } = await import('better-sqlite3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const execSync = (sql: string) => db.exec(sql);
  const allSync = (sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(...normaliseParams(params)) as Row[];

  const driver: DbDriver = {
    kind: 'sqlite',
    async all<T = Row>(sql: string, params?: unknown[]) {
      return allSync(sql, params ?? []) as unknown as T[];
    },
    async run(sql, params) {
      db.prepare(sql).run(...normaliseParams(params));
    },
    async exec(sql) {
      execSync(sql);
    },
    async transaction(fn) {
      const savepoint = `sp_${Date.now().toString(36)}`;
      execSync(`SAVEPOINT ${savepoint}`);
      try {
        const out = await fn(driver);
        execSync(`RELEASE ${savepoint}`);
        return out;
      } catch (err) {
        execSync(`ROLLBACK TO ${savepoint}`);
        execSync(`RELEASE ${savepoint}`);
        throw err;
      }
    },
    async close() {
      db.close();
    },
  };
  return driver;
}

/* -------------------------------- exports ------------------------------- */

let driverPromise: Promise<DbDriver> | null = null;

export function getDb(): Promise<DbDriver> {
  if (!driverPromise) {
    driverPromise = config.databaseUrl
      ? createPostgres(config.databaseUrl).catch((err) => {
          driverPromise = null;
          throw new Error(
            `Could not connect to PostgreSQL (DATABASE_URL). ${(err as Error)?.message ?? ''}`.trim(),
          );
        })
      : createSqlite(path.join(config.dataDir, 'vroqn-nexus.db'));
  }
  return driverPromise;
}

/**
 * Verifies the connection and reports which engine is in use — called during bootstrap so a
 * misconfigured deployment fails immediately instead of on the first student request.
 */
export async function ping(): Promise<{ kind: DbDriver['kind']; ok: boolean; detail?: string }> {
  const db = await getDb();
  try {
    await db.all('SELECT 1 AS ok');
    return { kind: db.kind, ok: true };
  } catch (err) {
    return { kind: db.kind, ok: false, detail: (err as Error)?.message };
  }
}

export async function all<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
  return (await getDb()).all<T>(sql, params);
}

export async function one<T = Row>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] ?? null;
}

export async function run(sql: string, params?: unknown[]): Promise<void> {
  await (await getDb()).run(sql, params);
}

export async function transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
  return (await getDb()).transaction(fn);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}
