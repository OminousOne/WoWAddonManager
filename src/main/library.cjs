const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { extractAddons, safeSegment } = require('./archive.cjs');
const { scanAddons } = require('./wow.cjs');

const exists = (file) => fs.lstat(file).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function realDirectory(directory, create) {
  let details = await exists(directory);
  if (!details && create) {
    await fs.mkdir(directory, { mode: 0o700 });
    details = await fs.lstat(directory);
  }
  if (details && !details.isDirectory()) {
    throw new Error('An addon management folder is not a regular directory.');
  }
  return Boolean(details);
}

function packageKey(source, id) {
  return `${source}:${id}`;
}

function newer(installed, latest) {
  if (installed.revision === latest.revision) return false;
  if (Number.isFinite(installed.time) && Number.isFinite(latest.time) && latest.time < installed.time) return false;
  return true;
}

function libraryPaths(client) {
  const base = path.join(client.directory, 'Interface');
  const work = path.join(base, '.addon-ledger');
  return {
    base, work,
    live: path.join(base, 'AddOns'),
    stage: path.join(work, 'stage'),
    backup: path.join(work, 'backup'),
    journal: path.join(work, 'transaction.json'),
  };
}

async function recover(paths, committed) {
  // A read-only scan can follow Interface when there is no transaction to recover.
  if (!await realDirectory(paths.work, false) || !await realDirectory(paths.base, false)) return;
  const pending = await fs.readFile(paths.journal, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pending && pending.token !== committed) {
    const { incoming, outgoing } = pending;
    if (![incoming, outgoing].every((folders) => Array.isArray(folders) && folders.every(safeSegment))) {
      throw new Error('The addon recovery journal is invalid.');
    }
    for (const folder of incoming) {
      if (!await exists(path.join(paths.stage, folder))) {
        const installed = path.join(paths.live, folder);
        if (await exists(installed)) await fs.rename(installed, path.join(paths.stage, folder));
      }
    }
    for (const folder of outgoing) {
      const from = path.join(paths.backup, folder);
      if (await exists(from)) await fs.rename(from, path.join(paths.live, folder));
    }
  }
  if (pending) await fs.unlink(paths.journal);
  await fs.rm(paths.work, { recursive: true, force: true });
}

function createLibrary(store) {
  let queue = Promise.resolve();

  function serial(action) {
    const operation = queue.then(action);
    queue = operation.catch(() => {});
    return operation;
  }

  const packages = (client) => store.read().packages[client.id] || {};
  const committed = (client) => store.read().transactions?.[client.id];

  async function list(client) {
    return serial(async () => {
      await recover(libraryPaths(client), committed(client));
      const local = await scanAddons(client);
      const managed = Object.values(packages(client));
      const owned = new Set(managed.flatMap(({ folders }) => folders));
      return [...local.filter(({ folder }) => !owned.has(folder)), ...managed.map((addon) => ({
        ...addon, key: packageKey(addon.source, addon.id), author: local.find(({ folder }) => addon.folders.includes(folder))?.author || '',
        damaged: !addon.folders.every((folder) => local.some((entry) => entry.folder === folder)),
      }))].sort((a, b) => (a.title || a.folder).localeCompare(b.title || b.folder));
    });
  }

  async function change(client, key, prepare, { existing = false, authorizeReplace } = {}) {
    return serial(async () => {
      const paths = libraryPaths(client);
      await recover(paths, committed(client));
      const installed = packages(client);
      const previous = installed[key];
      if (Boolean(previous) !== existing) {
        throw new Error(existing ? 'This managed addon is no longer installed.' : 'This addon is already installed.');
      }
      const normalize = (name) => name.normalize('NFC').toLowerCase();
      const otherClaims = new Set(Object.entries(installed)
        .filter(([owner]) => owner !== key)
        .flatMap(([, { folders }]) => folders.map(normalize)));
      function assertUnclaimed(folders) {
        for (const folder of folders) {
          if (otherClaims.has(normalize(folder))) {
            throw new Error(`Folder “${folder}” is already claimed by another managed addon.`);
          }
        }
      }
      const owned = new Set(previous?.folders || []);
      assertUnclaimed(owned);
      await realDirectory(paths.base, true);
      await realDirectory(paths.live, true);
      await fs.mkdir(paths.work, { mode: 0o700 });
      const token = randomUUID();
      try {
        const next = await prepare(paths, previous);
        const incoming = next?.folders || [];
        assertUnclaimed(incoming);
        const live = await fs.readdir(paths.live, { withFileTypes: true });
        const byName = new Map(live.map((entry) => [entry.name, entry]));
        const incomingNames = new Set(incoming.map(normalize));
        const collisions = live.filter((entry) => incomingNames.has(normalize(entry.name))
          && (!owned.has(entry.name) || !entry.isDirectory()));
        if (collisions.length) {
          if (!authorizeReplace || collisions.some((entry) => !entry.isDirectory())) {
            throw new Error(`Folder “${collisions[0].name}” already exists. AddOn Ledger protects folders owned by other addons or installed manually.`);
          }
          const local = new Set((await scanAddons(client)).map(({ folder }) => folder));
          if (collisions.some(({ name }) => !local.has(name))) {
            throw new Error('A folder of the same name already exists without an addon TOC. Move it before installing.');
          }
          const replacements = collisions.map(({ name }) => name);
          if (!await authorizeReplace(next, replacements)) {
            await recover(paths, committed(client));
            return false;
          }
          for (const name of replacements) owned.add(name);
        }
        const outgoing = [...owned].filter((folder) => {
          return byName.get(folder)?.isDirectory();
        });
        await fs.mkdir(paths.backup);
        await fs.writeFile(paths.journal + '.tmp', JSON.stringify({ token, incoming, outgoing }), { flag: 'wx' });
        await fs.rename(paths.journal + '.tmp', paths.journal);
        for (const folder of outgoing) await fs.rename(path.join(paths.live, folder), path.join(paths.backup, folder));
        for (const folder of incoming) await fs.rename(path.join(paths.stage, folder), path.join(paths.live, folder));
        await store.write((state) => {
          const records = state.packages[client.id] ||= {};
          if (next) records[key] = next;
          else delete records[key];
          (state.transactions ||= {})[client.id] = token;
        });
      } catch (error) {
        await recover(paths, committed(client)).catch(() => {
          throw new Error('Addon recovery needs access to your game folders. Restore access and rescan before making further changes.');
        });
        throw error;
      }
      // A committed transaction is still recoverable if cleanup cannot run immediately.
      await recover(paths, committed(client)).catch(() => {});
      return true;
    });
  }

  function install(client, catalog, source, id, mode = 'install', authorizeReplace) {
    return change(client, packageKey(source, id), async (paths, previous) => {
      if (mode === 'update' && previous.pinned) throw new Error('Unpin this addon before updating it.');
      const file = await catalog.release(source, id, client, mode === 'repair' ? previous.revision : undefined);
      if (mode === 'update' && !newer(previous, file)) throw new Error('This addon is already up to date.');
      if (mode === 'repair' && file.revision !== previous.revision) {
        throw new Error('The installed release is unavailable. Use Update to install the current release.');
      }
      const archive = path.join(paths.work, 'addon.zip');
      await catalog.download(file, archive);
      const folders = await extractAddons(archive, paths.stage);
      const { title, version, revision, time } = file;
      return { source, id, title, version, revision, time, folders, pinned: previous?.pinned || false };
    }, { existing: mode !== 'install', authorizeReplace });
  }

  function importZip(client, archive) {
    const name = path.basename(archive, path.extname(archive));
    const id = randomUUID();
    return change(client, packageKey('local', id), async (paths) => {
      const info = await fs.stat(archive);
      if (!info.isFile() || info.size > 128 * 1024 ** 2) throw new Error('Choose a ZIP file under 128 MB.');
      const folders = await extractAddons(archive, paths.stage);
      const [entry] = await scanAddons({ ...client, addonsDirectory: paths.stage });
      return { source: 'local', id, title: entry?.title || name, version: entry?.version || '', folders };
    });
  }

  function remove(client, key) {
    return change(client, key, () => null, { existing: true });
  }

  function pin(client, key, value) {
    return serial(async () => {
      const addon = packages(client)[key];
      if (!addon || addon.source === 'local') throw new Error('Select an installed catalog addon.');
      await store.write((state) => { state.packages[client.id][key].pinned = value; });
    });
  }

  function refresh(client, catalog, key, mode) {
    const addon = packages(client)[key];
    if (!addon || addon.source === 'local') throw new Error('Select an installed catalog addon.');
    return install(client, catalog, addon.source, addon.id, mode);
  }

  async function updates(client, catalog) {
    const managed = Object.entries(packages(client)).filter(([, addon]) => addon.source !== 'local');
    const results = [];
    for (let index = 0; index < managed.length; index += 4) {
      const batch = managed.slice(index, index + 4);
      results.push(...await Promise.all(batch.map(async ([key, addon]) => {
        try {
          const latest = await catalog.release(addon.source, addon.id, client);
          return { key, revision: addon.revision, version: latest.version,
            status: newer(addon, latest) ? 'available' : 'current' };
        } catch (error) {
          return { key, revision: addon.revision, status: 'unavailable', reason: error.message };
        }
      })));
    }
    return results;
  }

  return { list, install, importZip, remove, pin, refresh, updates };
}

module.exports = { createLibrary };
