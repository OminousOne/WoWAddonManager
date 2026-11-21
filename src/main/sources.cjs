const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { convert } = require('html-to-text');

const sources = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge' };
const websiteHosts = {
  wowinterface: ['www.wowinterface.com', 'wowinterface.com'],
  tukui: ['tukui.org', 'www.tukui.org'],
  curseforge: ['www.curseforge.com', 'curseforge.com'],
};
const imageHosts = {
  wowinterface: ['cdn-wow.mmoui.com', 'cdn.wowinterface.com', 'www.wowinterface.com'],
  tukui: ['storage.tukui.org'],
  curseforge: ['media.forgecdn.net', 'mediafilez.forgecdn.net', 'edge.forgecdn.net'],
};
const imageLimit = 6 * 1024 ** 2;
const catalogLimit = 20 * 1024 ** 2;
const archiveLimit = 128 * 1024 ** 2;
const wowi = 'https://api.mmoui.com/v3/game/WOW';
const tukui = 'https://api.tukui.org/v1';
const forge = 'https://api.curseforge.com/v1';

function sourceUrl(hosts, input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const url = URL.parse(input);
  if (url?.protocol !== 'https:' || url.port || url.username || url.password
      || !hosts?.includes(url.hostname)) return null;
  return url.href;
}

const projectPage = (source, input) => sourceUrl(websiteHosts[source], input);
const imageUrl = (source, input) => sourceUrl(imageHosts[source], input);

function forumText(content = '') {
  return String(content ?? '').replace(/\[\*\]/g, '• ')
    .replace(/\[\/?(?:B|I|U|SIZE|COLOR|FONT|QUOTE|URL|IMG|LIST|LEFT|CENTER|RIGHT|TABLE|TR|TD)(?:=[^\]\r\n]*)?\]/gi, '')
    .trim();
}

function webText(content) {
  return convert(String(content || ''), { wordwrap: false, selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'iframe', format: 'skip' },
  ] });
}

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
      throw new Error(`${label} request failed (HTTP ${response.status}).`);
    }
    return response;
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

async function collect(response, limit) {
  const chunks = [];
  await pipeline(Readable.fromWeb(response.body), limited(limit), async (stream) => {
    for await (const chunk of stream) chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

async function catalogImage(source, input, fetcher = fetch) {
  const url = imageUrl(source, input);
  if (!url) throw new Error('Invalid addon image address.');
  const response = await get(url, sources[source], { hosts: imageHosts[source], fetcher, limit: imageLimit });
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) {
    await response.body.cancel();
    throw new Error('Unsupported addon image.');
  }
  return new Response(await collect(response, imageLimit), { headers: {
    'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  } });
}

function newCatalog(key = process.env.CURSEFORGE_API_KEY?.trim(), fetcher = fetch) {
  const cache = new Map();
  const fetchText = async (url, source) => {
    const options = { fetcher };
    if (source === 'curseforge') options.headers = () => ({ 'x-api-key': key });
    const response = await get(url, sources[source], options);
    return (await collect(response, catalogLimit)).toString('utf8');
  };
  const json = async (url, source) => JSON.parse(await fetchText(url, source));

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

  function publicEntry(source, { id, title, author, summary, url, image, downloads = 0, canInstall = true }) {
    return { source, id: String(id), title, author, summary, website: projectPage(source, url),
      image: imageUrl(source, image), downloads: Number(downloads) || 0, canInstall };
  }

  const wowiEntry = (item) => publicEntry('wowinterface', {
    id: item.UID, title: item.UIName, author: item.UIAuthorName, url: item.UIFileInfoURL,
    image: item.UIIMG_Thumbs?.[0] || item.UIIMGs?.[0], downloads: item.UIDownloadTotal,
  });
  const tukuiEntry = (item) => publicEntry('tukui', {
    id: item.slug, title: item.name, author: item.author, summary: item.small_desc,
    url: item.web_url, image: item.logo_square_url || item.logo_url,
  });
  const forgeEntry = (item) => publicEntry('curseforge', {
    id: item.id, title: item.name, author: item.authors?.map(({ name }) => name).join(', '), summary: item.summary,
    url: item.links?.websiteUrl, image: item.logo?.thumbnailUrl || item.logo?.url,
    downloads: item.downloadCount, canInstall: item.allowModDistribution !== false,
  });

  const wowiVersions = (item) => item.UICompatibility?.map(({ version }) => version);
  const forgeVersions = (item) => [
    ...(item.latestFilesIndexes || []).filter((file) => file.releaseType === 1).map((file) => file.gameVersion),
    ...(item.latestFiles || []).filter((file) => file.releaseType === 1).flatMap((file) => file.gameVersions || []),
  ];

  async function getWowiListing(id) {
    const list = await cached(`${wowi}/filelist.json`, 'wowinterface');
    return list.find((item) => String(item.UID) === id);
  }

  async function searchSource(source, query, client) {
    if (source === 'wowinterface') {
      const list = await cached(`${wowi}/filelist.json`, source);
      return list.filter((item) => compatible(wowiVersions(item), client))
        .map(wowiEntry);
    }
    if (source === 'tukui') {
      const list = await cached(`${tukui}/addons`, source);
      return list.filter((item) => compatible(item.patch, client))
        .map(tukuiEntry);
    }
    const params = new URLSearchParams({ gameId: '432', searchFilter: query, pageSize: '50', sortField: '2', sortOrder: 'desc' });
    // Retail has a documented CurseForge type; other clients are filtered by the file metadata.
    if (client.edition === 'retail') params.set('gameVersionTypeId', '517');
    const { data } = await json(`${forge}/mods/search?${params}`, source);
    return data.filter((item) => item.gameId === 432 && compatible(forgeVersions(item), client))
      .map(forgeEntry);
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

  async function release(source, id, client) {
    if (source === 'wowinterface' && /^\d{1,12}$/.test(id)) {
      const entry = await getWowiListing(id);
      if (!compatible(wowiVersions(entry || {}), client)) {
        throw new Error('No compatible release is available for this WoW client.');
      }
      const [item] = await json(`${wowi}/filedetails/${id}.json`, source);
      if (item?.UIDownload) {
        return { source, id, title: item.UIName, version: item.UIVersion, time: Number(item.UIDate),
          revision: `${item.UIDate}:${item.UIMD5 || item.UIVersion}`, url: item.UIDownload,
          hash: item.UIMD5 && ['md5', item.UIMD5] };
      }
    }
    if (source === 'tukui' && /^(elvui|tukui)$/.test(id)) {
      const item = await json(`${tukui}/addon/${id}`, source);
      if (item.url && compatible(item.patch, client)) {
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
      const params = new URLSearchParams({ pageSize: '50' });
      if (client.edition === 'retail') params.set('gameVersionTypeId', '517');
      const { data: files } = await json(`${forge}/mods/${id}/files?${params}`, source);
      const file = files.filter((item) => item.releaseType === 1 && item.isAvailable
        && compatible(item.gameVersions, client)).sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))[0];
      if (file) {
        const url = file.downloadUrl
          || (await json(`${forge}/mods/${id}/files/${file.id}/download-url`, source)).data;
        if (!url) throw new Error('CurseForge has no downloadable file for this project.');
        const hash = file.hashes?.find(({ algo }) => algo === 1 || algo === 2);
        return { source, id, title: mod.name, version: file.displayName || file.fileName,
          time: Date.parse(file.fileDate), revision: String(file.id), url, hash: hash && [hash.algo === 1 ? 'sha1' : 'md5', hash.value] };
      }
    }
    throw new Error('No compatible release is available for this WoW client.');
  }

  function images(source, urls) {
    return [...new Set(urls.map((url) => imageUrl(source, url)).filter(Boolean))].slice(0, 12);
  }

  async function project(source, id, client) {
    if (source === 'wowinterface' && /^\d{1,12}$/.test(id)) {
      const [entry, detail] = await Promise.all([
        getWowiListing(id),
        json(`${wowi}/filedetails/${id}.json`, source).then((items) => items[0]),
      ]);
      if (entry && detail) return { ...wowiEntry(entry),
        description: forumText(detail.UIDescription), changelog: forumText(detail.UIChangeLog),
        versions: wowiVersions(entry), version: detail.UIVersion, time: Number(detail.UIDate),
        screenshots: images(source, entry.UIIMGs || []),
        canInstall: Boolean(detail.UIDownload) && compatible(wowiVersions(entry), client),
      };
    }
    if (source === 'tukui' && /^(elvui|tukui)$/.test(id)) {
      const [item, changelog] = await Promise.all([
        json(`${tukui}/addon/${id}`, source),
        fetchText(`${tukui}/changelog/${id}`, source).catch(() => ''),
      ]);
      return { ...tukuiEntry(item), description: item.desc, changelog,
        versions: item.patch, version: item.version, time: Date.parse(item.last_update),
        screenshots: images(source, [item.screenshot_url, ...(item.gallery_url || [])]),
        canInstall: Boolean(item.url) && compatible(item.patch, client),
      };
    }
    if (source === 'curseforge' && /^\d{1,12}$/.test(id)) {
      if (!key) throw new Error('Add a CurseForge API key in Sources to use CurseForge.');
      const endpoint = `${forge}/mods/${id}`;
      const [mod, description] = await Promise.all([
        json(endpoint, source).then(({ data }) => data),
        json(`${endpoint}/description`, source).then(({ data }) => webText(data)).catch(() => ''),
      ]);
      if (mod.gameId !== 432) throw new Error('This is not a World of Warcraft addon.');
      const latest = (mod.latestFiles || []).filter((file) => file.releaseType === 1 && file.isAvailable
        && compatible(file.gameVersions, client)).sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate))[0];
      const changelog = latest ? await json(`${endpoint}/files/${latest.id}/changelog`, source)
        .then(({ data }) => webText(data)).catch(() => '') : '';
      const entry = forgeEntry(mod);
      return { ...entry, description: description || entry.summary, changelog,
        versions: forgeVersions(mod), version: latest?.displayName || latest?.fileName, time: Date.parse(latest?.fileDate),
        screenshots: images(source, (mod.screenshots || []).map(({ url }) => url)),
        canInstall: entry.canInstall && compatible(forgeVersions(mod), client),
      };
    }
    throw new Error('This addon project is unavailable.');
  }

  async function download(file, destination) {
    const hosts = {
      wowinterface: ['cdn.wowinterface.com', 'www.wowinterface.com', 'cdn-wow.mmoui.com', 'downloads.wowinterface.com'],
      tukui: ['api.tukui.org'],
      curseforge: ['edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net'],
    }[file.source];
    const response = await get(file.url, sources[file.source], {
      fetcher, hosts, limit: archiveLimit,
      headers: () => file.source === 'curseforge' ? { 'x-api-key': key } : {},
    });
    const hash = file.hash && createHash(file.hash[0]);
    await pipeline(Readable.fromWeb(response.body), limited(archiveLimit, hash), createWriteStream(destination, { flags: 'wx' }));
    if (hash && hash.digest('hex') !== file.hash[1].toLowerCase()) throw new Error('The download did not match the provider’s checksum.');
  }

  return { search, project, release, download, hasCurseForge: Boolean(key) };
}

module.exports = { catalogImage, compatible, newCatalog, projectPage, sources };
