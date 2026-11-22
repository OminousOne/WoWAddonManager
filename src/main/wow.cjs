const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');

const editions = {
  _retail_: ['Retail', 'retail', 'wow'],
  _classic_: ['Classic Progression', 'progression', 'wow_classic'],
  _classic_era_: ['Classic Era', 'era', 'wow_classic_era'],
  _anniversary_: ['Classic Anniversary', 'anniversary', 'wow_anniversary'],
  _forever_: ['WoW Forever', 'forever', 'wow_forever'],
  _classic_forever_: ['WoW Forever', 'forever', 'wow_forever'],
  _ptr_: ['Retail PTR', 'retail', 'wowt'],
  _xptr_: ['Retail PTR 2', 'retail', 'wowxptr'],
  _beta_: ['Retail Beta', 'retail', 'wow_beta'],
  _classic_ptr_: ['Classic PTR', 'progression', 'wow_classic_ptr'],
  _classic_beta_: ['Classic Beta', 'progression', 'wow_classic_beta'],
  _classic_era_ptr_: ['Classic Era PTR', 'era', 'wow_classic_era_ptr'],
  _classic_titan_: ['Classic Titan', 'titan', 'wow_classic_titan'],
};

function defaultRoots(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') {
    return ['/Applications/World of Warcraft', path.join(home, 'Applications', 'World of Warcraft')];
  }
  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    return [env['ProgramFiles(x86)'], env.ProgramFiles, path.win32.join(drive + '\\', 'Games')]
      .filter(Boolean).map((directory) => path.win32.join(directory, 'World of Warcraft'));
  }
  const prefixes = [
    env.WINEPREFIX,
    path.join(home, '.wine'),
    path.join(home, 'Games', 'world-of-warcraft'),
    path.join(home, 'Games', 'battlenet'),
    path.join(home, 'Games', 'battle-net'),
  ].filter(Boolean);
  return [
    path.join(home, 'Games', 'World of Warcraft'),
    ...prefixes.flatMap((prefix) => ['Program Files (x86)', 'Program Files'].map(
      (programs) => path.join(prefix, 'drive_c', programs, 'World of Warcraft'),
    )),
  ];
}

async function readSmall(file, limit = 262144) {
  const handle = await fs.open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) return '';
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function buildVersions(contents) {
  const [header, ...rows] = contents.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const columns = header.split('|').map((field) => field.split('!')[0]);
  const product = columns.indexOf('Product');
  const version = columns.indexOf('Version');
  const active = columns.indexOf('Active');
  const result = new Map();
  if (product < 0 || version < 0) return result;
  for (const row of rows) {
    const fields = row.split('|');
    if (fields[product] && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(fields[version])) {
      if (!result.has(fields[product]) || fields[active] === '1') {
        result.set(fields[product], fields[version]);
      }
    }
  }
  return result;
}

function gameTrack(edition, version) {
  const [major, minor] = String(version).split('.').map(Number);
  if (!major || edition === 'retail') return edition;
  if (major === 1) return minor >= 60 ? 'forever' : 'era';
  if (major === 2) return 'anniversary';
  if (major === 3 && minor >= 80) return 'titan';
  return 'progression';
}

async function discoverInstallations(roots) {
  const found = new Map();
  for (const candidate of roots) {
    const selected = await fs.realpath(candidate).catch(() => null);
    if (!selected) continue;
    const name = path.basename(selected).toLowerCase();
    const root = editions[name] ? path.dirname(selected) : selected;
    const children = editions[name] ? [name] : Object.keys(editions);
    const versions = buildVersions(await readSmall(path.join(root, '.build.info')).catch(() => ''));
    for (const folder of children) {
      const directory = editions[name] ? selected : path.join(root, folder);
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      if (!entries.some((entry) => (
        /^\.(flavor\.info|build\.info)$/i.test(entry.name) ||
        /^Wow.*\.(exe|app)$/i.test(entry.name) ||
        (entry.isDirectory() && /^Interface$/i.test(entry.name))
      ))) continue;
      const [label, edition, product] = editions[folder];
      const flavor = (await readSmall(path.join(directory, '.flavor.info'), 2048).catch(() => ''))
        .match(/^\s*(wow[a-z0-9_]*)(?=[|\s]|$)/im)?.[1];
      const version = versions.get(flavor) || versions.get(product) || null;
      const track = gameTrack(edition, version);
      const id = await fs.realpath(directory).catch(() => null);
      if (id) found.set(id, { id, directory: id, label, edition: track, version });
    }
  }
  return [...found.values()];
}

function parseToc(contents) {
  const fields = {};
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^##\s*([\w-]+)\s*:\s*(.*)/);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const plain = (value) => (value || '').replace(/\|c[0-9a-f]{8}|\|r/gi, '');
  return {
    title: plain(fields.title),
    version: plain(fields.version),
    author: plain(fields.author),
    notes: plain(fields.notes),
  };
}

const editionTocSuffixes = {
  retail: ['Mainline'],
  era: ['Vanilla', 'Classic'],
  anniversary: ['BCC', 'TBC', 'Classic'],
  forever: ['Forever', 'Camelot', 'Mainline'],
  titan: ['Titan', 'Wrath', 'Classic'],
};

const progressionTocSuffixes = {
  3: ['Wrath', 'WotLKC'],
  4: ['Cata'],
  5: ['Mists'],
};

function tocSuffixes({ edition, version }) {
  if (edition !== 'progression') return editionTocSuffixes[edition] || [];
  const major = Number(version?.split('.')[0]);
  return [...(progressionTocSuffixes[major] || []), 'Classic'];
}

async function scanAddons(installation) {
  const directory = path.join(installation.directory, 'Interface', 'AddOns');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const addonEntries = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
  const suffixes = tocSuffixes(installation);
  const addons = await Promise.all(addonEntries.map(async (entry) => {
    const { name } = entry;
    const folder = path.join(directory, name);
    const names = await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
      if (entry.isSymbolicLink() && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return [];
      throw error;
    });
    const files = new Map(names.filter((entry) => entry.isFile())
      .map((entry) => [entry.name.toLowerCase(), entry.name]));
    const candidates = suffixes.flatMap((suffix) => (
      [`${name}-${suffix}.toc`, `${name}_${suffix}.toc`]
    ));
    candidates.push(`${name}.toc`);
    const toc = candidates.map((candidate) => files.get(candidate.toLowerCase())).find(Boolean);
    if (!toc) return null;
    return { folder: name, ...parseToc(await readSmall(path.join(folder, toc))) };
  }));
  return addons.filter(Boolean).sort((a, b) => (a.title || a.folder).localeCompare(b.title || b.folder));
}

module.exports = { buildVersions, defaultRoots, discoverInstallations, gameTrack, parseToc, scanAddons };
