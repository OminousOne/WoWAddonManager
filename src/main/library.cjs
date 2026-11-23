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
        ...addon, author: local.find(({ folder }) => addon.folders.includes(folder))?.author || '',
        damaged: !addon.folders.every((folder) => local.some((entry) => entry.folder === folder)),
      }))].sort((a, b) => (a.title || a.folder).localeCompare(b.title || b.folder));
    });
  }

  async function change(client, key, prepare, { existing = false } = {}) {
    return serial(async () => {
      const paths = libraryPaths(client);
      await recover(paths, committed(client));
      const previous = packages(client)[key];
      if (Boolean(previous) !== existing) {
        throw new Error(existing ? 'This managed addon is no longer installed.' : 'This addon is already installed.');
      }
      await realDirectory(paths.base, true);
      await realDirectory(paths.live, true);
      await fs.mkdir(paths.work, { mode: 0o700 });
      const token = randomUUID();
      try {
        const next = await prepare(paths, previous);
        const incoming = next?.folders || [];
        const owned = new Set(previous?.folders || []);
        const normalize = (name) => name.normalize('NFC').toLowerCase();
        const live = new Map((await fs.readdir(paths.live, { withFileTypes: true }))
          .map((entry) => [normalize(entry.name), entry]));
        for (const folder of incoming) {
          const collision = live.get(normalize(folder));
          if (collision && (!owned.has(collision.name) || !collision.isDirectory())) {
            throw new Error(`Folder “${collision.name}” already exists. AddOn Ledger protects folders owned by other addons or installed manually.`);
          }
        }
        const outgoing = [...owned].filter((folder) => {
          const entry = live.get(normalize(folder));
          return entry?.name === folder && entry.isDirectory();
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
    });
  }

  function install(client, catalog, source, id, options) {
    return change(client, packageKey(source, id), async (paths, previous) => {
      const file = await catalog.release(source, id, client);
      const archive = path.join(paths.work, 'addon.zip');
      await catalog.download(file, archive);
      const folders = await extractAddons(archive, paths.stage);
      const { title, version, revision, time } = file;
      return { source, id, title, version, revision, time, folders, pinned: previous?.pinned || false };
    }, options);
  }

  return { list, install };
}

module.exports = { createLibrary };
