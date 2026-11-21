const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const maxEntries = 16000;
const maxExtracted = 512 * 1024 ** 2;

function safeSegment(name) {
  return Boolean(name) && name !== '.' && name !== '..' && name.length <= 255
    && !/[<>:"/\\|?*\x00-\x1f]|[. ]$|^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name);
}

function openArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function readEntries(zip) {
  return new Promise((resolve, reject) => {
    const files = [];
    const paths = new Map();
    let bytes = 0;
    zip.on('error', reject);
    zip.on('end', () => resolve(files));
    zip.on('entry', (entry) => {
      const directory = entry.fileName.endsWith('/');
      const parts = entry.fileName.replace(/\/$/, '').split('/');
      const type = (entry.externalFileAttributes >>> 28) & 15;
      bytes += entry.uncompressedSize;
      if (parts.length > 24 || entry.fileName.length > 700 || !parts.every(safeSegment)
        || ![0, 4, 8].includes(type) || (type === 4 && !directory) || (type === 8 && directory)
        || entry.isEncrypted() || bytes > maxExtracted) {
        reject(new Error('The ZIP contains unsupported paths, links, or sizes.'));
        return;
      }
      let parent = '';
      for (const [index, part] of parts.entries()) {
        const full = parent + part;
        const key = full.normalize('NFC').toLowerCase();
        const isDirectory = directory || index < parts.length - 1;
        const prior = paths.get(key);
        if (prior && (!prior.directory || !isDirectory || prior.name !== full)) {
          reject(new Error('The ZIP contains overlapping paths.'));
          return;
        }
        paths.set(key, { name: full, directory: isDirectory });
        parent = full + '/';
      }
      if (!directory) files.push({ entry, parts });
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function isAddonToc(parts) {
  const filename = parts.at(-1).toLowerCase();
  const prefix = parts.at(-2)?.toLowerCase();
  return prefix && filename.endsWith('.toc') && (filename === prefix + '.toc'
    || filename.startsWith(prefix + '_') || filename.startsWith(prefix + '-'));
}

function rootLayout(files) {
  const direct = files.filter(({ parts }) => parts.length === 2 && isAddonToc(parts));
  if (direct.length) return { trim: 0, folders: new Set(direct.map(({ parts }) => parts[0])) };
  const nested = files.filter(({ parts }) => parts.length === 3 && isAddonToc(parts));
  const wrappers = new Set(nested.map(({ parts }) => parts[0]));
  if (wrappers.size !== 1) throw new Error('The ZIP does not contain recognizable WoW addon folders.');
  return { trim: 1, wrapper: nested[0].parts[0], folders: new Set(nested.map(({ parts }) => parts[1])) };
}

async function extractAddons(file, destination) {
  let zip;
  try {
    zip = await openArchive(file);
    if (zip.entryCount > maxEntries) throw new Error('The ZIP contains too many files.');
    const entries = await readEntries(zip);
    const { trim, wrapper, folders } = rootLayout(entries);
    for (const { entry, parts } of entries) {
      if ((trim && parts[0] !== wrapper) || !folders.has(parts[trim])) continue;
      const target = path.join(destination, ...parts.slice(trim));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stream = await new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, contents) => error ? reject(error) : resolve(contents));
      });
      await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
    }
    return [...folders].sort();
  } catch (error) {
    if (error.code) throw error;
    throw new Error(`Could not unpack addon. ${error.message}`);
  } finally {
    zip?.close();
  }
}

module.exports = { extractAddons, safeSegment };
