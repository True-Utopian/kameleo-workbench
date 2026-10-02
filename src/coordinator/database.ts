import { Pool, type PoolConfig, type PoolClient } from "pg";
import type { SqlDatabase, SqlExecutor, SqlResult } from "./types.js";

const executor = (client: PoolClient): SqlExecutor => ({
  async query<T>(sql: string, values?: unknown[]): Promise<SqlResult<T>> {
    const result = await client.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  },
});

/** A connection is held only for a short database transaction, never browser I/O. */
export class PgDatabase implements SqlDatabase {
  private readonly pool: Pool;
  constructor(config: PoolConfig | string) {
    this.pool = new Pool(
      typeof config === "string" ? { connectionString: config } : config,
    );
  }
  async query<T>(sql: string, values?: unknown[]): Promise<SqlResult<T>> {
    const result = await this.pool.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }
  async transaction<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL search_path = workbench_coordinator, pg_catalog",
      );
      const result = await body(executor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async holdNodeLock(
    nodeId: string,
    onLost: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    let released = false;
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
        [`workbench-node:${nodeId}`],
      );
      if (!result.rows[0]?.held)
        throw new Error("Another workbench owns this Engine node");
    } catch (error) {
      client.release();
      throw error;
    }
    const lost = (cause: Error) => {
      if (!released) onLost(cause);
    };
    client.on("error", lost);
    return async () => {
      if (released) return;
      released = true;
      client.removeListener("error", lost);
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [`workbench-node:${nodeId}`],
        );
      } finally {
        client.release();
      }
    };
  }
  async close() {
    await this.pool.end();
  }
}
