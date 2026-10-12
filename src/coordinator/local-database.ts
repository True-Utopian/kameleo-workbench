import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SqlDatabase, SqlExecutor, SqlResult } from './types.js';
import { acquireProcessLock } from '@true-utopian/vesper-browser';

export interface NodeDatabase extends SqlDatabase {
  holdNodeLock(nodeId: string, onLost: (error: Error) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** One persisted local PostgreSQL instance, owned by one OS process. Not a multi-node database. */
export class LocalDatabase implements NodeDatabase {
  private engine!: PGlite;
  private tail: Promise<unknown> = Promise.resolve();
  private identity = randomUUID();
  private closing = false;
  private held = false;
  private monitor?: NodeJS.Timeout;
  private unlock?: () => Promise<void>;
  private constructor(private directory: string, private lock: string) {}
  static async open(directory: string) {
    directory = resolve(directory);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    const lock = `${directory}.owner.json`, db = new LocalDatabase(directory, lock);
    try {
      const prior = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw new Error('Invalid local database owner');
      try { process.kill(prior.pid, 0); throw new Error('Another process owns this local database'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    db.unlock = await acquireProcessLock(directory, () => { db.closing = true; });
    try {
      const prior = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
      try { process.kill(prior.pid, 0); throw new Error('Another process owns this local database'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await rm(lock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await db.unlock(); throw error; } }
    const handle = await open(lock, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, identity: db.identity })); await handle.sync(); } finally { await handle.close(); }
    try {
      db.engine = new PGlite(directory); await db.engine.waitReady;
      return db;
    } catch (error) { await db.engine?.close().catch(() => {}); await rm(lock, { force: true }); await db.unlock(); throw error; }
  }
  private serial<T>(action: () => Promise<T>) {
    if (this.closing) return Promise.reject(new Error('Local database is closing'));
    const next = this.tail.catch(() => {}).then(action); this.tail = next; return next;
  }
  private executor(engine: Pick<PGlite, 'query' | 'exec'>): SqlExecutor {
    return { query: async <T>(sql: string, values?: unknown[]): Promise<SqlResult<T>> => {
      const result = values ? await engine.query<T>(sql, values) : (await engine.exec(sql)).at(-1);
      return { rows: (result?.rows ?? []) as T[], rowCount: result?.affectedRows };
    } };
  }
  query<T>(sql: string, values?: unknown[]) { return this.serial(() => this.executor(this.engine).query<T>(sql, values)); }
  transaction<T>(body: (tx: SqlExecutor) => Promise<T>) {
    return this.serial(() => this.engine.transaction(async tx => {
      await tx.exec('SET LOCAL search_path = workbench_coordinator, pg_catalog');
      return body(this.executor(tx));
    }));
  }
  async holdNodeLock(_nodeId: string, onLost: (error: Error) => void) {
    if (this.held || this.closing) throw new Error('Another coordinator owns this local database');
    this.held = true;
    this.monitor = setInterval(() => { void readFile(this.lock, 'utf8').then(raw => {
      if (JSON.parse(raw).identity !== this.identity) throw new Error('Local database ownership changed');
    }).catch(error => { clearInterval(this.monitor); this.closing = true; onLost(error); }); }, 2000);
    this.monitor.unref();
    return async () => { clearInterval(this.monitor); this.held = false; };
  }
  async close() {
    this.closing = true; clearInterval(this.monitor); await this.tail.catch(() => {}); await this.engine.close();
    const current = JSON.parse(await readFile(this.lock, 'utf8').catch(() => '{}'));
    if (current.identity === this.identity) await rm(this.lock, { force: true });
    await this.unlock?.();
  }
}
