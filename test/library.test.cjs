const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { createLibrary } = require('../src/main/library.cjs');
const { newCatalog } = require('../src/main/sources.cjs');
const { openStore } = require('../src/main/store.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'addon-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = { id: root, directory: root, edition: 'retail' };
  const live = path.join(root, 'Interface', 'AddOns');
  const work = path.join(root, 'Interface', '.addon-ledger');
  const store = await openStore(path.join(root, 'data'));
  return { client, live, work, store, library: createLibrary(store) };
}

function source(files, version = '1.0') {
  return {
    release: async (source, id) => ({ source, id, title: 'Example', version, revision: version }),
    async download(_release, destination) {
      const zip = new ZipFile();
      for (const [name, contents] of Object.entries(files)) zip.addBuffer(Buffer.from(contents), name);
      zip.end();
      await pipeline(zip.outputStream, createWriteStream(destination));
    },
  };
}

test('lists addons through a symlinked Interface folder without a transaction workspace', async (t) => {
  const { client, library, work } = await fixture(t);
  const interfaceTarget = path.join(client.directory, 'SharedInterface');
  const addon = path.join(interfaceTarget, 'AddOns', 'Local');
  await fs.mkdir(addon, { recursive: true });
  await fs.writeFile(path.join(addon, 'Local.toc'), '## Title: Local');
  await fs.symlink(interfaceTarget, path.join(client.directory, 'Interface'), 'junction');

  assert.deepEqual((await library.list(client)).map(({ folder }) => folder), ['Local']);
  await assert.rejects(library.install(client, source({ 'Alpha/Alpha.toc': '## Title: Alpha' }),
    'tukui', 'example'), /not a regular directory/);
  await assert.rejects(fs.lstat(work), { code: 'ENOENT' });
});

test('installs grouped ZIP folders and preserves unrelated addons', async (t) => {
  const { client, library, live, work } = await fixture(t);
  await fs.mkdir(path.join(live, 'Local'), { recursive: true });
  await fs.writeFile(path.join(live, 'Local', 'Local.toc'), '## Title: Local');
  await library.install(client, source({
    'wrapper/Alpha/Alpha.toc': '## Author: A',
    'wrapper/Beta/Beta_Mainline.toc': '## Title: Beta',
    'wrapper/README.md': 'read me',
  }), 'tukui', 'example');
  const records = await library.list(client);
  assert.deepEqual(records.map(({ folders, folder }) => folders || folder), [['Alpha', 'Beta'], 'Local']);
  assert.equal(records[0].author, 'A');
  assert.deepEqual((await fs.readdir(live)).sort(), ['Alpha', 'Beta', 'Local']);
  await assert.rejects(fs.access(work));
});

test('refuses to overwrite manually installed addons using different casing', async (t) => {
  const { client, library, live, store } = await fixture(t);
  await fs.mkdir(path.join(live, 'alpha'), { recursive: true });
  const original = path.join(live, 'alpha', 'alpha.toc');
  await fs.writeFile(original, '## Title: Local');
  await assert.rejects(library.install(client, source({
    'Alpha/Alpha.toc': '## Title: New',
  }), 'tukui', 'example'), /already exists/);
  assert.equal(await fs.readFile(original, 'utf8'), '## Title: Local');
  assert.deepEqual(store.read().packages, {});
});

test('rejects unsafe ZIP paths before changing installed files', async (t) => {
  const { client, library, live } = await fixture(t);
  await assert.rejects(library.install(client, source({
    'Alpha/Alpha.toc': '## Title: Alpha',
    'Alpha/CON.txt': 'invalid on Windows',
  }), 'tukui', 'example'), /unsupported paths/);
  assert.deepEqual(await fs.readdir(live), []);
});

test('recovers an interrupted update and restores the old addon', async (t) => {
  const { client, library, live, work } = await fixture(t);
  const stage = path.join(work, 'stage');
  const oldFolder = path.join(work, 'backup', 'Alpha');
  await fs.mkdir(path.join(live, 'Alpha'), { recursive: true });
  await fs.mkdir(oldFolder, { recursive: true });
  await fs.mkdir(stage);
  await fs.writeFile(path.join(work, 'transaction.json'), JSON.stringify({
    token: 'uncommitted', incoming: ['Alpha'], outgoing: ['Alpha'],
  }));
  await fs.writeFile(path.join(live, 'Alpha', 'Alpha.toc'), '## Title: New');
  await fs.writeFile(path.join(oldFolder, 'Alpha.toc'), '## Title: Old');
  assert.equal((await library.list(client))[0].title, 'Old');
  assert.equal((await library.list(client))[0].title, 'Old');
  await assert.rejects(fs.access(work));
});

test('checks for updates, protects pinned versions, repairs and removes grouped addons', async (t) => {
  const { client, library, live } = await fixture(t);
  const first = source({ 'Alpha/Alpha.toc': '## Version: 1.0', 'Beta/Beta.toc': '## Version: 1.0' });
  const next = source({ 'Alpha/Alpha.toc': '## Version: 2.0', 'Gamma/Gamma.toc': '## Version: 2.0' }, '2.0');
  const key = 'tukui:example';
  await library.install(client, first, 'tukui', 'example');
  await fs.rm(path.join(live, 'Beta'), { recursive: true });
  assert.equal((await library.list(client))[0].damaged, true);
  await assert.rejects(library.refresh(client, next, key, 'repair'), /installed release is unavailable/);
  await library.refresh(client, first, key, 'repair');
  assert.equal((await library.list(client))[0].damaged, false);
  assert.deepEqual(await library.updates(client, next), [
    { key, revision: '1.0', version: '2.0', status: 'available' },
  ]);
  await library.pin(client, key, true);
  await assert.rejects(library.refresh(client, next, key, 'update'), /Unpin/);
  await library.pin(client, key, false);
  await library.refresh(client, next, key, 'update');
  assert.deepEqual((await fs.readdir(live)).sort(), ['Alpha', 'Gamma']);
  assert.equal((await library.list(client))[0].version, '2.0');
  await library.remove(client, key);
  assert.deepEqual(await library.list(client), []);
  assert.deepEqual(await fs.readdir(live), []);
});

test('repairs the installed CurseForge file when a newer release is available', async (t) => {
  const { client, library, live } = await fixture(t);
  const archive = path.join(client.directory, 'Example.zip');
  const betaToc = '## Version: 1.0';
  await source({ 'Alpha/Alpha.toc': '## Version: 1.0', 'Beta/Beta.toc': betaToc }).download(null, archive);
  const archiveContents = await fs.readFile(archive);
  const installed = { id: 1, releaseType: 1, isAvailable: true, gameVersions: ['12.1.5'], fileDate: '2026-01-01',
    displayName: 'Example v1', downloadUrl: 'https://edge.forgecdn.net/example-v1.zip' };
  const latest = { ...installed, id: 2, fileDate: '2026-02-01', displayName: 'Example v2',
    downloadUrl: 'https://edge.forgecdn.net/example-v2.zip' };
  const files = [installed];
  const calls = [];
  const catalog = newCatalog('fixture-key', async (url) => {
    calls.push(url.pathname);
    if (url.pathname === '/v1/mods/11') return Response.json({ data: { gameId: 432, name: 'Example' } });
    if (url.pathname === '/v1/mods/11/files') return Response.json({ data: files });
    if (url.pathname === '/v1/mods/11/files/1') return Response.json({ data: installed });
    if (url.href === installed.downloadUrl) return new Response(archiveContents);
    return new Response(null, { status: 404 });
  });
  const key = 'curseforge:11';
  await library.install(client, catalog, 'curseforge', '11');
  await library.pin(client, key, true);
  await fs.rm(path.join(live, 'Beta'), { recursive: true });
  files.unshift(latest);
  assert.deepEqual(await library.updates(client, catalog), [
    { key, revision: '1', version: 'Example v2', status: 'available' },
  ]);

  calls.length = 0;
  await library.refresh(client, catalog, key, 'repair');
  assert.deepEqual(calls, ['/v1/mods/11', '/v1/mods/11/files/1', '/example-v1.zip']);
  const [addon] = await library.list(client);
  assert.equal(addon.revision, '1');
  assert.equal(addon.pinned, true);
  assert.equal(addon.damaged, false);
  assert.equal(await fs.readFile(path.join(live, 'Beta', 'Beta.toc'), 'utf8'), betaToc);
});

test('imports local archives without associating them with an online catalog', async (t) => {
  const { client, library, live } = await fixture(t);
  const archive = path.join(client.directory, 'Example.zip');
  await source({ 'Alpha/Alpha.toc': '## Title: Local Example\n## Version: 1.5' }).download(null, archive);
  await library.importZip(client, archive);
  const [addon] = await library.list(client);
  assert.equal(addon.title, 'Local Example');
  assert.equal(addon.version, '1.5');
  assert.equal(addon.source, 'local');
  assert.deepEqual(await library.updates(client, {}), []);
  await library.remove(client, addon.key);
  assert.deepEqual(await fs.readdir(live), []);
});

test('can take over manual addons with confirmation and protects other managed projects', async (t) => {
  const { client, library, live } = await fixture(t);
  await fs.mkdir(path.join(live, 'Alpha'), { recursive: true });
  const original = path.join(live, 'Alpha', 'Alpha.toc');
  const next = source({ 'Alpha/Alpha.toc': '## Title: Catalog copy' });
  await fs.writeFile(original, '## Title: Local copy');
  assert.equal(await library.install(client, next, 'tukui', 'example', 'install', async (_addon, folders) => {
    assert.deepEqual(folders, ['Alpha']);
    return false;
  }), false);
  assert.equal(await fs.readFile(original, 'utf8'), '## Title: Local copy');
  assert.equal(await library.install(client, next, 'tukui', 'example', 'install', async () => true), true);
  assert.equal(await fs.readFile(original, 'utf8'), '## Title: Catalog copy');
  assert.equal((await library.list(client))[0].source, 'tukui');
  await assert.rejects(library.install(client, next, 'tukui', 'other', 'install', async () => {
    assert.fail('Other managed addons should never allow replacement.');
  }), /already claimed by another managed addon/);
});

async function assertAddonFiles(directory, files) {
  for (const [name, contents] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), contents, name);
  }
}

async function manualTakeoverFixture(t) {
  const setup = await fixture(t);
  const { client, library, live, store } = setup;
  const archive = path.join(client.directory, 'Keep.zip');
  await source({ 'Keep/Keep.toc': '## Title: Keep' }).download(null, archive);
  await library.importZip(client, archive);
  assert.ok(store.read().transactions[client.id]);
  const originals = {
    'alpha/alpha.toc': '## Title: Manual Alpha',
    'alpha/Local.lua': '-- Alpha local edits',
    'Beta/Beta.toc': '## Title: Manual Beta',
    'Beta/Local.lua': '-- Beta local edits',
  };
  await fs.mkdir(path.join(live, 'alpha'));
  await fs.mkdir(path.join(live, 'Beta'));
  for (const [name, contents] of Object.entries(originals)) {
    await fs.writeFile(path.join(live, name), contents);
  }
  return {
    ...setup,
    originals,
    replacements: {
      'Added/Added.toc': '## Title: Added by catalog',
      'Alpha/Alpha.toc': '## Title: Catalog Alpha',
      'Beta/Beta.toc': '## Title: Catalog Beta',
    },
    data: path.join(client.directory, 'data'),
    before: structuredClone(store.read()),
    addons: await library.list(client),
  };
}

async function assertManualTakeoverRestored({ live, work, originals, data, before }, store) {
  assert.deepEqual((await fs.readdir(live)).sort(), ['Beta', 'Keep', 'alpha']);
  await assertAddonFiles(live, originals);
  assert.deepEqual(store.read(), before);
  assert.deepEqual((await openStore(data)).read(), before);
  await assert.rejects(fs.lstat(work), { code: 'ENOENT' });
}

test('rolls back a confirmed manual takeover when the store commit fails', async (t) => {
  const setup = await manualTakeoverFixture(t);
  const { client, library, live, work, store, data, originals, replacements, addons } = setup;
  const commitError = new Error('Simulated store commit failure');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to !== path.join(data, 'library.json')) return rename(from, to);
    assert.deepEqual((await fs.readdir(live)).sort(), ['Added', 'Alpha', 'Beta', 'Keep']);
    await assertAddonFiles(live, replacements);
    await assertAddonFiles(path.join(work, 'backup'), originals);
    throw commitError;
  });
  const confirm = t.mock.fn(async (_addon, folders) => {
    assert.deepEqual([...folders].sort(), ['Beta', 'alpha']);
    return true;
  });

  await assert.rejects(library.install(client, source(replacements), 'tukui', 'example', 'install', confirm),
    (error) => error === commitError);
  assert.equal(confirm.mock.callCount(), 1);
  await assertManualTakeoverRestored(setup, store);
  for (let scan = 0; scan < 2; scan++) {
    assert.deepEqual(await library.list(client), addons);
    await assertManualTakeoverRestored(setup, store);
  }
});

test('recovers a confirmed manual takeover interrupted during incoming folder moves', async (t) => {
  const setup = await manualTakeoverFixture(t);
  const { client, live, work, data, replacements, addons } = setup;
  const stage = path.join(work, 'stage');
  const backup = path.join(work, 'backup');
  await fs.mkdir(backup, { recursive: true });
  for (const [name, contents] of Object.entries(replacements)) {
    const file = path.join(stage, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  await fs.writeFile(path.join(work, 'transaction.json'), JSON.stringify({
    token: 'uncommitted-takeover', incoming: ['Added', 'Alpha', 'Beta'], outgoing: ['Beta', 'alpha'],
  }));
  await fs.rename(path.join(live, 'Beta'), path.join(backup, 'Beta'));
  await fs.rename(path.join(live, 'alpha'), path.join(backup, 'alpha'));
  await fs.rename(path.join(stage, 'Added'), path.join(live, 'Added'));
  await fs.rename(path.join(stage, 'Alpha'), path.join(live, 'Alpha'));

  const restartedStore = await openStore(data);
  const restartedLibrary = createLibrary(restartedStore);
  for (let scan = 0; scan < 2; scan++) {
    assert.deepEqual(await restartedLibrary.list(client), addons);
    await assertManualTakeoverRestored(setup, restartedStore);
  }
});

test('rejects manual migration when an incoming folder is claimed by a damaged package', async (t) => {
  const { client, library, live, store, work } = await fixture(t);
  await library.install(client, source({ 'Alpha/Alpha.toc': '## Title: Managed' }), 'tukui', 'example');
  await fs.rm(path.join(live, 'Alpha'), { recursive: true });
  await fs.mkdir(path.join(live, 'Beta'));
  const manualToc = path.join(live, 'Beta', 'Beta.toc');
  await fs.writeFile(manualToc, '## Title: Manual');
  const before = structuredClone(store.read().packages);

  await assert.rejects(library.install(client, source({
    'alpha/alpha.toc': '## Title: Catalog Alpha',
    'Beta/Beta.toc': '## Title: Catalog Beta',
  }), 'tukui', 'other', 'install', async () => {
    assert.fail('A conflicting folder claim should block migration before confirmation.');
  }), /Folder “alpha” is already claimed by another managed addon/);

  assert.deepEqual(await fs.readdir(live), ['Beta']);
  assert.equal(await fs.readFile(manualToc, 'utf8'), '## Title: Manual');
  assert.deepEqual(store.read().packages, before);
  await assert.rejects(fs.lstat(work), { code: 'ENOENT' });
});

test('rejects importing a folder still claimed by a damaged package', async (t) => {
  const { client, library, live, store } = await fixture(t);
  await library.install(client, source({ 'Alpha/Alpha.toc': '## Title: Managed' }), 'tukui', 'example');
  await fs.rm(path.join(live, 'Alpha'), { recursive: true });
  const archive = path.join(client.directory, 'Local.zip');
  await source({ 'alpha/alpha.toc': '## Title: Local' }).download(null, archive);

  await assert.rejects(library.importZip(client, archive), /already claimed by another managed addon/);
  assert.deepEqual(Object.keys(store.read().packages[client.id]), ['tukui:example']);
  assert.deepEqual(await fs.readdir(live), []);
  assert.equal((await library.list(client))[0].damaged, true);

  await library.remove(client, 'tukui:example');
  await library.importZip(client, archive);
  assert.equal((await library.list(client))[0].title, 'Local');
});

test('rejects destructive operations on folders with conflicting recorded owners', async (t) => {
  const { client, library, live, store } = await fixture(t);
  const key = 'tukui:example';
  const original = '## Title: Installed';
  await library.install(client, source({ 'Alpha/Alpha.toc': original }), 'tukui', 'example');
  await store.write((state) => {
    state.packages[client.id]['local:legacy'] = { source: 'local', id: 'legacy', folders: ['alpha'] };
  });
  const before = structuredClone(store.read().packages);
  const conflict = /already claimed by another managed addon/;

  await assert.rejects(library.remove(client, key), conflict);
  await assert.rejects(library.refresh(client, {}, key, 'update'), conflict);
  await assert.rejects(library.refresh(client, {}, key, 'repair'), conflict);
  assert.equal(await fs.readFile(path.join(live, 'Alpha', 'Alpha.toc'), 'utf8'), original);
  assert.deepEqual(store.read().packages, before);
});
