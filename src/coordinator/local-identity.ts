import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { durableWrite, stableId } from '../managed/storage.js';
import type { SqlDatabase } from './types.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface LocalIdentity { schemaVersion: 1; nodeId: string; tenantId: string; teamKey: string; browserOwner: string }

/** Keep a local coordinator's ownership stable across Windows APPDATA aliases. */
export async function resolveLocalIdentity(options: {
  database: SqlDatabase; dataDir: string; nodeId: string; browserOwner: string;
  tenantId?: string; teamKey?: string;
}): Promise<LocalIdentity> {
  if (!uuid.test(options.nodeId)) throw new Error('Invalid local coordinator node ID');
  const browserOwner = await realpath(options.browserOwner), file = join(options.dataDir, 'coordinator/identity.json');
  let saved: LocalIdentity | undefined;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved && (saved.schemaVersion !== 1 || saved.nodeId !== options.nodeId || !uuid.test(saved.tenantId) || typeof saved.teamKey !== 'string' || !saved.teamKey || saved.browserOwner !== browserOwner))
    throw new Error('Local coordinator identity does not match this node and Browser store');

  const exists = await options.database.query<{ relation: string | null }>("SELECT to_regclass('workbench_coordinator.engine_nodes') AS relation");
  let existing: { tenant_id: string; id: string; workspace_key: string; quota_domain_id: string; vendor_team_key: string } | undefined;
  if (exists.rows[0]?.relation) {
    const nodes = await options.database.query<NonNullable<typeof existing>>(`SELECT n.tenant_id,n.id,n.workspace_key,n.quota_domain_id,q.vendor_team_key
      FROM workbench_coordinator.engine_nodes n JOIN workbench_coordinator.quota_domains q ON q.id=n.quota_domain_id
      WHERE n.id=$1 OR n.workspace_key=$1`, [options.nodeId]);
    if (nodes.rows.length > 1) throw new Error('Ambiguous existing local coordinator identity');
    existing = nodes.rows[0];
    if (existing) {
      if (existing.id !== options.nodeId || existing.workspace_key !== options.nodeId || !uuid.test(existing.tenant_id) || existing.quota_domain_id !== stableId(`kameleo-team:${existing.vendor_team_key}`))
        throw new Error('Invalid existing local coordinator identity');
      // Existing explicit team keys remain supported. A default local key must
      // resolve to this same physical Browser store before migration is allowed.
      if (existing.vendor_team_key.startsWith('local:') && await realpath(existing.vendor_team_key.slice(6)) !== browserOwner)
        throw new Error('Existing local coordinator belongs to a different Browser store');
      if (saved && (saved.tenantId !== existing.tenant_id || saved.teamKey !== existing.vendor_team_key))
        throw new Error('Saved local coordinator identity differs from its database');
    }
  }
  const identity: LocalIdentity = saved ?? {
    schemaVersion: 1, nodeId: options.nodeId, browserOwner,
    tenantId: existing?.tenant_id ?? (options.tenantId || stableId(`workbench:local:${browserOwner}`)),
    teamKey: existing?.vendor_team_key ?? (options.teamKey || `local:${browserOwner}`),
  };
  if (!uuid.test(identity.tenantId) || !identity.teamKey || (options.tenantId && options.tenantId !== identity.tenantId) || (options.teamKey && options.teamKey !== identity.teamKey))
    throw new Error('Configured local coordinator identity conflicts with the saved workspace');
  if (!saved) await durableWrite(file, JSON.stringify(identity));
  return identity;
}
