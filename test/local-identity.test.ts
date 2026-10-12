import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { DurableCoordinator } from '../src/coordinator/index.js';
import { LocalDatabase } from '../src/coordinator/local-database.js';
import { resolveLocalIdentity } from '../src/coordinator/local-identity.js';
import { stableId } from '../src/managed/storage.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(body: (options: { root: string; owner: string; alias: string; database: LocalDatabase; nodeId: string }) => Promise<void>) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'vesper-local-identity-')));
  let database: LocalDatabase | undefined;
  try {
    const owner = join(root, 'browser'), alias = join(root, 'browser-alias');
    await mkdir(owner); await symlink(owner, alias, process.platform === 'win32' ? 'junction' : 'dir');
    database = await LocalDatabase.open(join(root, 'database'));
    await body({ root, owner, alias, database, nodeId: randomUUID() });
  } finally {
    await database?.close(); const child = relative(base, root);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('existing coordinator keeps its tenant and quota when APPDATA resolves through a different path', async () => fixture(async ({root,owner,alias,database,nodeId}) => {
  const coordinator = new DurableCoordinator({ db: database }); await coordinator.migrate();
  const tenantId = stableId(`workbench:local:${alias}`), teamKey = `local:${alias}`;
  const workspace = { tenantId, nodeId, siteId: randomUUID(), quotaDomainId: stableId(`kameleo-team:${teamKey}`), vendorTeamKey: teamKey,
    nodeIncarnationId: randomUUID(), engineProcessKey: randomUUID(), origin: 'https://owned.test', totalBrowserBudget: 1, nodeMaxBrowsers: 1 };
  await coordinator.ensureWorkspace(workspace);
  assert.notEqual(tenantId, stableId(`workbench:local:${owner}`));
  const identity = await resolveLocalIdentity({database,dataDir:root,nodeId,browserOwner:owner});
  assert.equal(identity.tenantId, tenantId); assert.equal(identity.teamKey, teamKey);
  await coordinator.ensureWorkspace({...workspace,tenantId:identity.tenantId,vendorTeamKey:identity.teamKey,nodeIncarnationId:randomUUID(),engineProcessKey:randomUUID()});
  assert.equal((await database.query('SELECT * FROM workbench_coordinator.engine_nodes')).rows.length, 1);
  assert.equal((await database.query('SELECT * FROM workbench_coordinator.quota_domains')).rows.length, 1);
  assert.deepEqual(await resolveLocalIdentity({database,dataDir:root,nodeId,browserOwner:alias}), identity);
  assert.deepEqual(JSON.parse(await readFile(join(root,'coordinator/identity.json'),'utf8')),identity);
}));

test('saved local identity rejects explicit conflicting configuration and another Browser store', async () => fixture(async ({root,owner,database,nodeId}) => {
  const options = {database,dataDir:root,nodeId,browserOwner:owner};
  const identity = await resolveLocalIdentity(options);
  await assert.rejects(resolveLocalIdentity({...options,tenantId:randomUUID()}), /conflicts/);
  await assert.rejects(resolveLocalIdentity({...options,teamKey:'other-team'}), /conflicts/);
  await mkdir(join(root,'other-browser'));
  await assert.rejects(resolveLocalIdentity({...options,browserOwner:join(root,'other-browser')}), /does not match/);
  await assert.rejects(resolveLocalIdentity({...options,nodeId:randomUUID()}), /does not match/);
  assert.deepEqual(await resolveLocalIdentity(options),identity);
}));

test('existing default quota owned by another Browser directory fails without saving a replacement identity', async () => fixture(async ({root,owner,database,nodeId}) => {
  const other = join(root,'other-browser'); await mkdir(other);
  const coordinator = new DurableCoordinator({db:database}); await coordinator.migrate();
  const teamKey = `local:${other}`;
  await coordinator.ensureWorkspace({tenantId:randomUUID(),nodeId,siteId:randomUUID(),quotaDomainId:stableId(`kameleo-team:${teamKey}`),vendorTeamKey:teamKey,nodeIncarnationId:randomUUID(),engineProcessKey:randomUUID(),origin:'https://owned.test',totalBrowserBudget:1,nodeMaxBrowsers:1});
  await assert.rejects(resolveLocalIdentity({database,dataDir:root,nodeId,browserOwner:owner}), /different Browser store/);
  await assert.rejects(readFile(join(root,'coordinator/identity.json')), {code:'ENOENT'});
}));

test('fresh embedded CLI initializes its Browser store and preserves identity on the next boot', async () => {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'vesper-embedded-boot-')));
  try {
    const dataDir = join(root,'workbench'), owner = join(root,'new-browser-store');
    const env = {...process.env,BROWSER_BACKEND:'local',VESPER_LOCAL_COORDINATOR:'true',WORKBENCH_DATA_DIR:dataDir,
      LOCAL_BROWSER_DIR:owner,LOCAL_BROWSER_EXECUTABLE:'',VESPER_BROWSER_URL:'',VESPER_BROWSER_TOKEN_FILE:'',DATABASE_URL:'',
      WORKBENCH_TENANT_ID:'',WORKBENCH_NODE_ID:'',KAMELEO_TEAM_KEY:'',WORKBENCH_TOKEN:'',KAMELEO_VNC_URL:'',
      AUTOMATIONS_DIR:join(root,'automations'),FLOWS_DIR:join(root,'flows'),EXPORT_DIR:join(root,'exports'),
      PROXY_INVENTORY_FILE:join(root,'proxy-inventory.json'),FLOW_POLICIES_FILE:'',ENABLE_TEST_FIXTURE:'false',FIXTURE_ORIGIN:''};
    await assert.rejects(realpath(owner),{code:'ENOENT'});
    const run = () => promisify(execFile)(process.execPath,['--import','tsx','src/cli.ts','list'],{env,windowsHide:true,timeout:90000,maxBuffer:1024*1024});
    assert.deepEqual(JSON.parse((await run()).stdout),[]);
    const identity = JSON.parse(await readFile(join(dataDir,'coordinator/identity.json'),'utf8'));
    assert.equal(identity.browserOwner,await realpath(owner));
    assert.deepEqual(JSON.parse((await run()).stdout),[]);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir,'coordinator/identity.json'),'utf8')),identity);
    await assert.rejects(readFile(join(dataDir,'coordinator/database.owner.json')),{code:'ENOENT'});
  } finally {
    const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
