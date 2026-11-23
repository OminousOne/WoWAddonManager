const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pipeline } = require('node:stream/promises');
const { ZipFile } = require('yazl');
const { createLibrary } = require('../src/main/library.cjs');
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
  }), /already exists/);
});
