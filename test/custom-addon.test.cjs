const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { customAddon, exportAddon, generationPrompt } = require('../src/main/custom-addon.cjs');
const { createLibrary } = require('../src/main/library.cjs');
const { openStore } = require('../src/main/store.cjs');

const client = { id: 'retail', label: 'Retail', edition: 'retail', version: '12.1.5.76543' };
const draft = { id: randomUUID(), title: 'Raid Reminder', interface: 120105, lua: 'print("Ready")' };

test('targets the selected WoW interface and sends the source for a revision', () => {
  const prompt = generationPrompt(client, { ...draft, request: 'Change the reminder text' });
  const request = JSON.parse(prompt.split('\n').at(-1));
  assert.deepEqual(request, {
    title: 'Raid Reminder', client: 'Retail', gameVersion: client.version, interface: 120105,
    request: 'Change the reminder text', previousLua: 'print("Ready")\n',
  });
  assert.throws(() => generationPrompt({ ...client, version: null }, { ...draft, request: 'A reminder' }), /detect.*version/);
  assert.throws(() => customAddon({ ...draft, title: 'Reminder\n## Dependencies: Something' }), /line breaks/);
  assert.throws(() => customAddon({ ...draft, id: '../WTF' }), /draft first/);
  assert.throws(() => customAddon({ ...draft, lua: 'local value =' }), /Lua syntax error on line/);
});

test('exports an addon ZIP that the regular library can import', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-custom-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = createLibrary(await openStore(path.join(root, 'store')));
  const localClient = { ...client, directory: root };
  const addon = customAddon(draft);
  const zip = path.join(root, 'Reminder.zip');
  await exportAddon(addon, zip);
  await library.importZip(localClient, zip);
  const [installed] = await library.list(localClient);
  assert.equal(installed.title, draft.title);
  const directory = path.join(root, 'Interface', 'AddOns', addon.folder);
  assert.match(await fs.readFile(path.join(directory, addon.folder + '.toc'), 'utf8'), /^## Interface: 120105\n/);
  assert.equal(await fs.readFile(path.join(directory, 'Addon.lua'), 'utf8'), draft.lua + '\n');
});

test('installs and revises a custom addon without taking ownership of an unrelated folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-custom-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const localClient = { ...client, directory: root };
  const library = createLibrary(await openStore(path.join(root, 'store')));
  const addon = customAddon(draft);
  const directory = path.join(root, 'Interface', 'AddOns', addon.folder);
  await fs.mkdir(directory, { recursive: true });
  const manualFile = path.join(directory, addon.folder + '.toc');
  await fs.writeFile(manualFile, '## Title: Manual');
  await assert.rejects(library.installCustom(localClient, addon), /already exists/);
  assert.equal(await fs.readFile(manualFile, 'utf8'), '## Title: Manual');
  await fs.rm(directory, { recursive: true });

  await library.installCustom(localClient, addon);
  await library.installCustom(localClient, customAddon({ ...draft, lua: 'print("Revised")' }));
  const [installed] = await library.list(localClient);
  assert.equal(installed.custom, true);
  assert.equal(installed.key, 'local:' + draft.id);
  assert.deepEqual(await library.updates(localClient), []);
  assert.equal(await fs.readFile(path.join(directory, 'Addon.lua'), 'utf8'), 'print("Revised")\n');
  await library.remove(localClient, installed.key);
  assert.deepEqual(await library.list(localClient), []);
});
