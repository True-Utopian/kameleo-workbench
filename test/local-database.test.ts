import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../src/coordinator/local-database.js';

test('local database persists transactions, rolls back errors and excludes a second owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-persisted-db-'));
  let db = await LocalDatabase.open(join(directory, 'postgres'));
  try {
    await db.query('CREATE SCHEMA workbench_coordinator; CREATE TABLE workbench_coordinator.evidence (id integer PRIMARY KEY, value text)');
    await assert.rejects(LocalDatabase.open(join(directory, 'postgres')), /owns this local database/);
    await Promise.all([1, 2, 3].map(id => db.transaction(async tx => { await tx.query('INSERT INTO evidence VALUES ($1,$2)', [id, `item-${id}`]); })));
    await assert.rejects(db.transaction(async tx => { await tx.query('INSERT INTO evidence VALUES (4,\'rollback\')'); throw new Error('Rollback transaction'); }));
    await db.close(); db = await LocalDatabase.open(join(directory, 'postgres'));
    const result = await db.query<{ id: number }>('SELECT id FROM workbench_coordinator.evidence ORDER BY id');
    assert.deepEqual(result.rows.map(row => row.id), [1, 2, 3]);
    const unlock = await db.holdNodeLock('local-node', () => {});
    await assert.rejects(db.holdNodeLock('local-node', () => {}), /Another coordinator/); await unlock();
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
