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

module.exports = { fixture, source };
