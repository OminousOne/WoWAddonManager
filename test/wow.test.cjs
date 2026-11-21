const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultRoots, discoverInstallations, scanAddons } = require('../src/main/wow.cjs');

test('detects individual editions, deduplicates roots, and reads the applicable TOC', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-wow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const retail = path.join(root, '_retail_');
  const classic = path.join(root, '_classic_beta_');
  const addon = path.join(retail, 'Interface', 'AddOns', 'Example');
  await fs.mkdir(addon, { recursive: true });
  const otherTrack = path.join(path.dirname(addon), 'OtherTrack');
  await fs.mkdir(otherTrack);
  await fs.writeFile(path.join(otherTrack, 'OtherTrack_Vanilla.toc'), '## Title: Era Only\n');
  await fs.mkdir(classic);
  await fs.writeFile(path.join(root, '.build.info'),
    'Active!DEC:1|Version!STRING:0|Product!STRING:0\n0|11.0.0.3|wow\n1|12.1.5.8|wow\n1|1.60.1.5|wow_classic_beta');
  await fs.writeFile(path.join(classic, '.flavor.info'), 'wow_classic_beta');
  await fs.writeFile(path.join(addon, 'Example.toc'), '## Title: Generic\n');
  await fs.writeFile(path.join(addon, 'Example_Mainline.toc'),
    '\uFEFF## Title: |cffff0000Example|r\r\n## Version: 1.2\r\n## Author: Tester');
  const installations = await discoverInstallations([root, retail]);
  assert.deepEqual(installations.map(({ edition, version }) => [edition, version]),
    [['retail', '12.1.5.8'], ['forever', '1.60.1.5']]);
  assert.deepEqual(await scanAddons(installations[0]), [
    { folder: 'Example', title: 'Example', version: '1.2', notes: '', author: 'Tester' },
  ]);
  assert.deepEqual(await scanAddons(installations[1]), []);
});

test('scans ordinary and linked addon directories and skips dangling links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-wow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const retail = path.join(root, '_retail_');
  const addons = path.join(retail, 'Interface', 'AddOns');
  const ordinary = path.join(addons, 'Example');
  const linked = path.join(root, 'Linked');
  await fs.mkdir(ordinary, { recursive: true });
  await fs.mkdir(linked);
  await fs.writeFile(path.join(ordinary, 'Example.toc'), '## Title: Example\n');
  await fs.writeFile(path.join(linked, 'Linked.toc'), '## Title: Linked\n');
  await fs.symlink(linked, path.join(addons, 'Linked'), 'junction');
  await fs.symlink(path.join(root, 'Missing'), path.join(addons, 'Broken'), 'junction');

  const library = await scanAddons({ directory: retail, edition: 'retail' });
  assert.deepEqual(library.map(({ folder, title }) => [folder, title]), [
    ['Example', 'Example'],
    ['Linked', 'Linked'],
  ]);
});

test('includes platform-specific default roots', () => {
  assert.ok(defaultRoots('darwin').includes('/Applications/World of Warcraft'));
  assert.ok(defaultRoots('win32', { SystemDrive: 'D:' }).includes('D:\\Games\\World of Warcraft'));
  assert.ok(defaultRoots('linux', { WINEPREFIX: '/wine' }, '/home/test')
    .includes(path.join('/wine', 'drive_c', 'Program Files (x86)', 'World of Warcraft')));
});
