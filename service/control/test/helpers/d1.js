import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A D1 stand-in over better-sqlite3 that runs the real migrations in Node.
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

function statement(db, sql, params = []) {
  const execute = () => {
    const prepared = db.prepare(sql);
    if (prepared.reader) return { results: prepared.all(...params), meta: { changes: 0 } };
    const info = prepared.run(...params);
    return { results: [], meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  };
  return {
    sql, execute,
    bind: (...values) => statement(db, sql, values),
    all: async () => execute(),
    run: async () => execute(),
    async first(column) {
      const row = db.prepare(sql).get(...params) ?? null;
      return column && row ? row[column] : row;
    },
  };
}

export const applyMigration = (raw, file) => raw.exec(readFileSync(`${MIGRATIONS}${file}`, "utf8"));

// `before` stops at that migration, to hold rows older releases wrote.
export function createTestD1({ before = null } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    if (before && file >= before) break;
    applyMigration(db, file);
  }
  return {
    raw: db,
    prepare: (sql) => statement(db, sql),
    batch: async (statements) => db.transaction(() => statements.map((statement) => statement.execute()))(),
  };
}
