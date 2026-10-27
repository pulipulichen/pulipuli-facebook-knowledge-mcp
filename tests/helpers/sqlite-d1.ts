import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** Run the production SQL against SQLite; only the D1 binding API is adapted. */
export function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../migrations/0001_initial.sql", import.meta.url), "utf8"));
  function prepare(sql: string, values: any[] = []): any {
    return {
      bind: (...args: any[]) => prepare(sql, args),
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
  }
  const db = {
    prepare,
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
