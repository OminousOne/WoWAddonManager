const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const sources = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge' };
const catalogLimit = 20 * 1024 ** 2;
const archiveLimit = 128 * 1024 ** 2;
const wowi = 'https://api.mmoui.com/v3/game/WOW';
const tukui = 'https://api.tukui.org/v1';
const forge = 'https://api.curseforge.com/v1';

function compatible(versions, client) {
  return (versions || []).some((value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.\d+(?:\.\d+)?$/);
    if (!match) return false;
    const [, majorText, minorText] = match;
    const major = Number(majorText);
    const minor = Number(minorText);
    const track = major >= 6 ? 'retail' : major === 1 ? (minor >= 60 ? 'forever' : 'era')
      : major === 2 ? 'anniversary' : major === 3 && minor >= 80 ? 'titan' : 'progression';
    if (track !== client.edition) return false;
    // Classic Progression releases for different expansions are not interchangeable.
    return track !== 'progression' || !client.version || majorText === client.version.split('.')[0];
  });
}

async function get(url, label, { hosts, headers = () => ({}), limit = catalogLimit, fetcher } = {}) {
  const signal = AbortSignal.timeout(limit === archiveLimit ? 120000 : 15000);
  const allowed = hosts || [new URL(url).hostname];
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || !allowed.includes(target.hostname)) throw new Error(`${label} returned an unexpected download address.`);
    let response;
    try {
      response = await fetcher(target, { redirect: 'manual', headers: headers(target.hostname), signal });
    } catch {
      throw new Error(`${label} could not be reached. Check your connection and retry.`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), target).href;
      continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      const error = new Error(`${label} request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return Readable.fromWeb(response.body);
  }
  throw new Error(`${label} returned too many redirects.`);
}

function limited(limit, hash) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) return callback(new Error('The provider response is too large.'));
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
}

function newCatalog(key = process.env.CURSEFORGE_API_KEY?.trim(), fetcher = fetch) {
  const cache = new Map();
  const json = async (url, source) => {
    const options = { fetcher };
    if (source === 'curseforge') options.headers = () => ({ 'x-api-key': key });
    const stream = await get(url, sources[source], options);
    const chunks = [];
    await pipeline(stream, limited(catalogLimit), async (input) => {
      for await (const chunk of input) chunks.push(chunk);
    });
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  function cached(url, source) {
    if (!cache.has(url)) {
      const promise = json(url, source);
      cache.set(url, promise);
      const timer = setTimeout(() => cache.delete(url), 5 * 60 * 1000);
      timer.unref();
      promise.catch(() => { clearTimeout(timer); cache.delete(url); });
    }
    return cache.get(url);
  }

  function publicEntry(source, id, title, author, summary, downloads = 0, canInstall = true) {
    return { source, id: String(id), title, author, summary, downloads: Number(downloads) || 0, canInstall };
  }

  const wowiVersions = (item) => item.UICompatibility?.map(({ version }) => version);
  const forgeVersions = (item) => [
    ...(item.latestFilesIndexes || []).filter((file) => file.releaseType === 1).map((file) => file.gameVersion),
    ...(item.latestFiles || []).filter((file) => file.releaseType === 1).flatMap((file) => file.gameVersions || []),
  ];

  async function searchSource(source, query, client) {
    if (source === 'wowinterface') {
      const list = await cached(`${wowi}/filelist.json`, source);
      return list.filter((item) => compatible(wowiVersions(item), client))
        .map((item) => publicEntry(source, item.UID, item.UIName, item.UIAuthorName, '', item.UIDownloadTotal));
    }
    if (source === 'tukui') {
      const list = await cached(`${tukui}/addons`, source);
      return list.filter((item) => compatible(item.patch, client))
        .map((item) => publicEntry(source, item.slug, item.name, item.author, item.small_desc));
    }
    const params = new URLSearchParams({ gameId: '432', searchFilter: query, pageSize: '50', sortField: '2', sortOrder: 'desc' });
    // Retail has a documented CurseForge type; other clients are filtered by the file metadata.
    if (client.edition === 'retail') params.set('gameVersionTypeId', '517');
    const { data } = await json(`${forge}/mods/search?${params}`, source);
    return data.filter((item) => item.gameId === 432 && compatible(forgeVersions(item), client))
      .map((item) => publicEntry(source, item.id, item.name, item.authors?.map((author) => author.name).join(', '),
        item.summary, item.downloadCount, item.allowModDistribution !== false));
  }

  async function search(query, source, client) {
    const enabled = Object.keys(sources).filter((name) => name !== 'curseforge' || key);
    const selected = source === 'all' ? enabled : enabled.filter((name) => name === source);
    const outcomes = await Promise.allSettled(selected.map((name) => searchSource(name, query, client)));
    const items = [];
    const warnings = [];
    const needle = query.toLowerCase();
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        items.push(...outcome.value.filter((item) => selected[index] === 'curseforge'
          || [item.title, item.author, item.summary].some((field) => field?.toLowerCase().includes(needle))));
      } else {
        warnings.push(`${sources[selected[index]]} is unavailable. Try searching again later.`);
      }
    });
    const rank = (item) => item.title.toLowerCase() === needle ? 2 : item.title.toLowerCase().startsWith(needle) ? 1 : 0;
    items.sort((a, b) => rank(b) - rank(a) || b.downloads - a.downloads || a.title.localeCompare(b.title));
    return { items: items.slice(0, 60), warnings };
  }

  async function release(source, id, client, revision) {
    const unavailable = revision === undefined ? 'No compatible release is available for this WoW client.'
      : 'The installed release is unavailable.';
    if (source === 'wowinterface' && /^\d{1,12}$/.test(id)) {
      const list = await cached(`${wowi}/filelist.json`, source);
      const entry = list.find((item) => String(item.UID) === id);
      if (!compatible(wowiVersions(entry || {}), client)) {
        throw new Error(unavailable);
      }
      const [item] = await json(`${wowi}/filedetails/${id}.json`, source);
      if (item?.UIDownload) {
        const currentRevision = `${item.UIDate}:${item.UIMD5 || item.UIVersion}`;
        if (revision !== undefined && currentRevision !== revision) throw new Error(unavailable);
        return { source, id, title: item.UIName, version: item.UIVersion, time: Number(item.UIDate),
          revision: currentRevision, url: item.UIDownload,
          hash: item.UIMD5 && ['md5', item.UIMD5] };
      }
    }
    if (source === 'tukui' && /^(elvui|tukui)$/.test(id)) {
      const item = await json(`${tukui}/addon/${id}`, source);
      if (item.url && compatible(item.patch, client)) {
        if (revision !== undefined && item.version !== revision) throw new Error(unavailable);
        return { source, id, title: item.name, version: item.version, time: Date.parse(item.last_update),
          revision: item.version, url: item.url };
      }
    }
    if (source === 'curseforge' && /^\d{1,12}$/.test(id)) {
      if (!key) throw new Error('Add a CurseForge API key in Sources to use CurseForge.');
      const { data: mod } = await json(`${forge}/mods/${id}`, source);
      if (mod.gameId !== 432 || mod.allowModDistribution === false) {
        throw new Error('This project is unavailable for third-party installation through CurseForge.');
      }
      const compatibleFile = (item) => item?.releaseType === 1 && item.isAvailable && compatible(item.gameVersions, client);
      let file;
      if (revision === undefined) {
        const params = new URLSearchParams();
        if (client.edition === 'retail') params.set('gameVersionTypeId', '517');
        const fileLimit = 10_000; // CurseForge caps index + pageSize.
        for (let index = 0; index < fileLimit;) {
          params.set('index', String(index));
          params.set('pageSize', String(Math.min(50, fileLimit - index)));
          const { data: files, pagination } = await json(`${forge}/mods/${id}/files?${params}`, source);
          file = files.filter(compatibleFile).sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))[0];
          index += files.length;
          if (file || !files.length || !pagination || index >= pagination.totalCount) break;
        }
      } else {
        if (!/^\d{1,12}$/.test(revision)) throw new Error(unavailable);
        const result = await json(`${forge}/mods/${id}/files/${revision}`, source).catch((error) => {
          if (error.status === 404) throw new Error(unavailable);
          throw error;
        });
        file = result.data;
        if (!compatibleFile(file) || String(file.id) !== revision) throw new Error(unavailable);
      }
      if (file) {
        const url = file.downloadUrl
          || (await json(`${forge}/mods/${id}/files/${file.id}/download-url`, source)).data;
        if (!url) throw new Error('CurseForge has no downloadable file for this project.');
        const hash = file.hashes?.find(({ algo }) => algo === 1 || algo === 2);
        return { source, id, title: mod.name, version: file.displayName || file.fileName,
          time: Date.parse(file.fileDate), revision: String(file.id), url, hash: hash && [hash.algo === 1 ? 'sha1' : 'md5', hash.value] };
      }
    }
    throw new Error(unavailable);
  }

  async function download(file, destination) {
    const hosts = {
      wowinterface: ['cdn.wowinterface.com', 'www.wowinterface.com', 'cdn-wow.mmoui.com', 'downloads.wowinterface.com'],
      tukui: ['api.tukui.org'],
      curseforge: ['edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net'],
    }[file.source];
    const body = await get(file.url, sources[file.source], {
      fetcher, hosts, limit: archiveLimit,
      headers: () => file.source === 'curseforge' ? { 'x-api-key': key } : {},
    });
    const hash = file.hash && createHash(file.hash[0]);
    await pipeline(body, limited(archiveLimit, hash), createWriteStream(destination, { flags: 'wx' }));
    if (hash && hash.digest('hex') !== file.hash[1].toLowerCase()) throw new Error('The download did not match the provider’s checksum.');
  }

  return { search, release, download, hasCurseForge: Boolean(key) };
}

module.exports = { compatible, newCatalog, sources };
