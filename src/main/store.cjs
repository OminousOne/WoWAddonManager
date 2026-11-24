const fs = require('node:fs/promises');
const path = require('node:path');

async function openStore(directory) {
  const file = path.join(directory, 'library.json');
  await fs.mkdir(directory, { recursive: true });
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { roots: [], packages: {} };
  }

  let pending = Promise.resolve();
  return {
    read: () => data,
    write(mutator) {
      const commit = pending.then(async () => {
        const updated = structuredClone(data);
        mutator(updated);
        await fs.writeFile(file + '.tmp', JSON.stringify(updated, null, 2), { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
        data = updated;
      });
      pending = commit.catch(() => {});
      return commit;
    },
  };
}

module.exports = { openStore };
