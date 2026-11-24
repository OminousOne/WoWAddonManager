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
  await fs.mkdir(classic);
  await fs.writeFile(path.join(root, '.build.info'),
    'Active!DEC:1|Version!STRING:0|Product!STRING:0\n0|11.0.0.3|wow\n1|12.1.5.8|wow\n1|1.60.1.5|wowf');
  await fs.writeFile(path.join(classic, '.flavor.info'), 'Product Flavor!STRING:0\r\nwowf\r\n');
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

test('discovers client and Interface junctions and ignores dangling Interface links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-wow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const clientFolder = path.join(root, 'SharedRetail');
  const interfaceFolder = path.join(root, 'SharedInterface');
  const addon = path.join(interfaceFolder, 'AddOns', 'Example');
  const retail = path.join(root, '_retail_');
  const classic = path.join(root, '_classic_era_');
  await fs.mkdir(addon, { recursive: true });
  await fs.mkdir(clientFolder);
  await fs.mkdir(classic);
  await fs.symlink(clientFolder, retail, 'junction');
  await fs.symlink(interfaceFolder, path.join(clientFolder, 'Interface'), 'junction');
  await fs.symlink(path.join(root, 'Missing'), path.join(classic, 'Interface'), 'junction');
  await fs.writeFile(path.join(addon, 'Example.toc'), '## Title: Linked addon');

  const [installation] = await discoverInstallations([retail]);
  assert.equal(installation.edition, 'retail');
  assert.equal(installation.directory, await fs.realpath(clientFolder));
  assert.deepEqual(await discoverInstallations([root, retail]), [installation]);
  assert.equal((await scanAddons(installation))[0].title, 'Linked addon');
});

test('detects the game track from build metadata inside a standalone client', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-wow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const clientFolder = path.join(root, '_classic_beta_');
  await fs.mkdir(clientFolder);
  await fs.writeFile(path.join(clientFolder, '.build.info'),
    'Active!DEC:1|Version!STRING:0|Product!STRING:0\n1|1.60.1.5|wowf');
  await fs.writeFile(path.join(clientFolder, '.flavor.info'), 'Product Flavor!STRING:0\r\nWoWF\r\n');

  const [installation] = await discoverInstallations([clientFolder]);
  assert.equal(installation.edition, 'forever');
  assert.equal(installation.version, '1.60.1.5');
});

test('prefers the client TOC, then the game family TOC, then the generic TOC', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-wow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '_classic_');
  const fixtures = {
    Specific: {
      '-Mists.TOC': 'Mists',
      '_Cata.toc': 'Cata',
      '_WotLKC.toc': 'Wrath',
      '_Vanilla.toc': 'Era',
      '-BCC.toc': 'Legacy BCC',
      '_BCC.toc': 'Invalid BCC',
      '_TBC.toc': 'Anniversary',
      '_Titan.toc': 'Titan',
      '_Camelot.toc': 'Forever',
      '_Classic.toc': 'Classic',
      '_Standard.toc': 'Standard',
      '_Mainline.toc': 'Mainline',
      '.toc': 'Generic',
    },
    ClassicOnly: { '_Classic.toc': 'Classic' },
    MainlineOnly: { '_Mainline.toc': 'Mainline' },
    StandardOnly: { '_Standard.toc': 'Standard' },
    LegacyBccOnly: { '-BCC.toc': 'Legacy BCC' },
    InvalidBccOnly: { '_BCC.toc': 'Invalid BCC' },
    BccWithFamily: { '-BCC.toc': 'Legacy BCC', '_Classic.toc': 'Classic' },
    BccWithGeneric: { '-BCC.toc': 'Legacy BCC', '.toc': 'Generic' },
    CataOnly: { '_Cata.toc': 'Cata' },
    CataWithFamily: { '_Cata.toc': 'Cata', '_Classic.toc': 'Classic' },
    Generic: { '.toc': 'Generic' },
  };
  for (const [name, tocs] of Object.entries(fixtures)) {
    const folder = path.join(directory, 'Interface', 'AddOns', name);
    await fs.mkdir(folder, { recursive: true });
    for (const [ending, title] of Object.entries(tocs)) {
      await fs.writeFile(path.join(folder, `${name}${ending}`), `## Title: ${title}\n`);
    }
  }

  const classicFamily = { ClassicOnly: 'Classic', CataWithFamily: 'Classic', BccWithFamily: 'Classic' };
  const legacyAnniversary = {
    ...classicFamily,
    LegacyBccOnly: 'Legacy BCC',
    BccWithFamily: 'Legacy BCC',
    BccWithGeneric: 'Legacy BCC',
  };
  const mainlineFamily = { MainlineOnly: 'Mainline' };
  const standardRetail = { ...mainlineFamily, StandardOnly: 'Standard' };
  const cases = [
    ['progression', '5.5.4.1', 'Mists', classicFamily],
    ['progression', '4.4.2.1', 'Cata', { ...classicFamily, CataOnly: 'Cata', CataWithFamily: 'Cata' }],
    ['progression', '3.4.3.1', 'Wrath', classicFamily],
    ['progression', null, 'Classic', classicFamily],
    ['era', '1.15.8.1', 'Era', classicFamily],
    ['anniversary', '2.5.4.1', 'Legacy BCC', legacyAnniversary],
    ['anniversary', '2.5.5.1', 'Anniversary', classicFamily],
    ['anniversary', '2.5.6.1', 'Anniversary', classicFamily],
    ['anniversary', null, 'Anniversary', classicFamily],
    ['titan', '3.80.1.1', 'Titan', classicFamily],
    ['forever', '1.60.1.1', 'Forever', mainlineFamily],
    ['retail', '12.1.4.1', 'Mainline', mainlineFamily],
    ['retail', null, 'Mainline', mainlineFamily],
    ['retail', '12.1.5.1', 'Standard', standardRetail],
    ['retail', '12.2.0.1', 'Standard', standardRetail],
  ];
  for (const [edition, version, title, expected] of cases) {
    const library = await scanAddons({ directory, edition, version });
    assert.deepEqual(Object.fromEntries(library.map(({ folder, title }) => [folder, title])), {
      Specific: title,
      Generic: 'Generic',
      BccWithGeneric: 'Generic',
      ...expected,
    }, `${edition} ${version ?? 'without build info'}`);
  }
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
