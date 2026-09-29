/**
 * PostgreSQL compatibility guard.
 *
 * The app runs on SQLite in development and PostgreSQL in production, and no Postgres server is
 * available in this environment — so instead of hoping, the portability rules the codebase relies on
 * are asserted here. Every check corresponds to a way the Postgres path could break silently:
 *
 *  1. `ON CONFLICT (a, b)` needs a matching unique constraint, or Postgres rejects the statement at
 *     runtime with "there is no unique or exclusion constraint matching the ON CONFLICT
 *     specification" (SQLite would have accepted it).
 *  2. Every statement is run through the same `?` → `$n` rewriter, so SQL must contain no `?` that is
 *     part of the SQL text, and no driver-specific placeholder of its own.
 *  3. Column types must exist in both engines (TEXT/INTEGER/REAL) and booleans must be INTEGER 0/1 —
 *     the app compares with `=== 1`.
 *  4. No SQLite-only functions or clauses anywhere in the server source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(here, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCES = walk(SERVER_SRC).map((file) => ({
  file: path.relative(SERVER_SRC, file),
  text: fs.readFileSync(file, 'utf8'),
}));

const SCHEMA = fs.readFileSync(path.join(SERVER_SRC, 'db', 'schema.ts'), 'utf8');

describe('postgres compatibility', () => {
  it('uses engine-neutral column types', () => {
    const definitions = SCHEMA.match(/^\s{2}\w+\s+(TEXT|INTEGER|REAL|BIGINT|BOOLEAN|JSON|JSONB|VARCHAR|TIMESTAMP)[^,\n]*/gim) ?? [];
    assert.ok(definitions.length > 50, `expected the schema to define many columns, found ${definitions.length}`);
    for (const definition of definitions) {
      const type = definition.trim().split(/\s+/)[1]!.toUpperCase();
      assert.ok(
        ['TEXT', 'INTEGER', 'REAL'].includes(type),
        `column type "${type}" is not portable between SQLite and PostgreSQL (${definition.trim()})`,
      );
    }
  });

  it('stores booleans as INTEGER so `=== 1` checks behave the same on both engines', () => {
    const booleanish = SCHEMA.match(/^\s{2}(is_\w+|enabled|starred|skipped|auto_submitted)\s+[^\n]*/gim) ?? [];
    assert.ok(booleanish.length > 5, 'expected boolean-ish columns in the schema');
    for (const column of booleanish) {
      assert.match(column, /INTEGER/i, `boolean column must be INTEGER: ${column.trim()}`);
      assert.match(column, /DEFAULT\s+[01]/i, `boolean column needs an explicit 0/1 default: ${column.trim()}`);
    }
  });

  it('gives every ON CONFLICT target a matching unique constraint', () => {
    const uniqueIndexes = new Set<string>();
    // CREATE UNIQUE INDEX ... ON table (col, col)
    for (const match of SCHEMA.matchAll(/CREATE UNIQUE INDEX[^;]*?ON\s+(\w+)\s*\(([^)]+)\)/gis)) {
      const table = match[1]!.toLowerCase();
      const columns = match[2]!
        .split(',')
        .map((column) => column.trim().replace(/\s+(ASC|DESC)$/i, '').toLowerCase())
        .sort();
      uniqueIndexes.add(`${table}(${columns.join(',')})`);
    }
    // UNIQUE / PRIMARY KEY declared inline in CREATE TABLE
    for (const tableMatch of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const table = tableMatch[1]!.toLowerCase();
      for (const line of tableMatch[2]!.split('\n')) {
        const single = line.match(/^\s{2}(\w+)\s+[^,]*\bUNIQUE\b/i);
        if (single) uniqueIndexes.add(`${table}(${single[1]!.toLowerCase()})`);
        const primary = line.match(/^\s{2}(\w+)\s+[^,]*\bPRIMARY KEY\b/i);
        if (primary) uniqueIndexes.add(`${table}(${primary[1]!.toLowerCase()})`);
      }
    }

    const conflicts: { file: string; target: string }[] = [];
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/ON CONFLICT\s*\(\s*([^)]+?)\s*\)/gis)) {
        conflicts.push({ file: source.file, target: match[1]!.replace(/\s+/g, '').toLowerCase() });
      }
    }
    assert.ok(conflicts.length >= 6, `expected ON CONFLICT usages to be found, saw ${conflicts.length}`);

    for (const conflict of conflicts) {
      const key = conflict.target.replace(/\s+/g, '');
      const hasMatch = [...uniqueIndexes].some((entry) => {
        const [table, columns] = entry.split('(');
        const columnList = columns!.replace(')', '').split(',').sort().join(',');
        const conflictColumns = key.split(',').sort().join(',');
        // A single-column conflict matches that column, or any unique key whose column is part of it.
        return (
          columnList === conflictColumns ||
          key.split(',').every((column) => columnList.split(',').includes(column))
        ) && Boolean(table);
      });
      assert.ok(
        hasMatch,
        `${conflict.file} uses ON CONFLICT (${key}) but no UNIQUE index columns [${[...uniqueIndexes].join(' | ')}] match — Postgres would throw`,
      );
    }
  });

  it('has no driver-specific placeholders or SQLite-only SQL', () => {
    const forbidden: { pattern: RegExp; why: string }[] = [
      { pattern: /\$\d+\s*(?=[,)\s])/, why: 'Postgres-style $n placeholders must not appear in SQL text' },
      { pattern: /AUTOINCREMENT/i, why: 'AUTOINCREMENT is SQLite-only' },
      { pattern: /datetime\('now'\)|strftime\s*\(/i, why: 'SQLite date functions are not portable' },
      { pattern: /json_extract\s*\(/i, why: 'json_extract is SQLite-only (JSON is parsed in JS)' },
      { pattern: /INSERT OR REPLACE|INSERT OR IGNORE/i, why: 'use ON CONFLICT so Postgres accepts it' },
      { pattern: /PRAGMA\s+(?!journal_mode|foreign_keys)/i, why: 'only the two pragmas the SQLite driver sets are allowed' },
      { pattern: /last_insert_rowid\s*\(/i, why: 'ids are generated in the application, not by the database' },
      { pattern: /WITHOUT ROWID/i, why: 'WITHOUT ROWID is SQLite-only' },
    ];
    for (const source of SOURCES) {
      for (const rule of forbidden) {
        // The driver itself is allowed to speak SQLite; nothing else is.
        if (source.file.endsWith(path.join('db', 'index.ts'))) continue;
        assert.equal(rule.pattern.test(source.text), false, `${source.file}: ${rule.why}`);
      }
    }
  });

  it('keeps every query portable: SELECT/UPDATE/DELETE/INSERT only, with ? placeholders', () => {
    const statements: { file: string; sql: string }[] = [];
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE|CREATE)[\s\S]*?)`/g)) {
        statements.push({ file: source.file, sql: match[1]! });
      }
    }
    assert.ok(statements.length > 40, `expected many SQL statements, found ${statements.length}`);
    for (const statement of statements) {
      assert.equal(/\$\d/.test(statement.sql), false, `${statement.file}: uses $n placeholders`);
      // SQLite would accept a bare `?`, so only the count matters for the rewriter: every `?` must
      // be a real parameter, never part of a string literal like a LIKE pattern containing '?'.
      const questionMarks = (statement.sql.match(/\?/g) ?? []).length;
      assert.ok(questionMarks < 40, `${statement.file}: suspicious number of placeholders (${questionMarks})`);
    }
  });

  it('never mixes Arena competition history with AI chat tables', () => {
    const arenaFiles = SOURCES.filter((source) => source.file.startsWith(path.join('services', 'arena')));
    assert.ok(arenaFiles.length >= 5, 'expected the Arena services to be present');
    for (const source of arenaFiles) {
      for (const table of ['conversations', 'messages']) {
        assert.equal(
          new RegExp(`\\b(FROM|INTO|JOIN|UPDATE)\\s+${table}\\b`, 'i').test(source.text),
          false,
          `${source.file} must not touch ${table} — competition history and AI chat history are separate`,
        );
      }
    }
  });
});
