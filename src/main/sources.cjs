const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { convert } = require('html-to-text');

const sources = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge', wowup: 'WowUp Hub' };
const websiteHosts = {
  wowinterface: ['www.wowinterface.com', 'wowinterface.com'],
  tukui: ['tukui.org', 'www.tukui.org'],
  curseforge: ['www.curseforge.com', 'curseforge.com'],
  wowup: ['wowup.io', 'www.wowup.io'],
};
const imageHosts = {
  wowinterface: ['cdn-wow.mmoui.com', 'cdn.wowinterface.com', 'www.wowinterface.com'],
  tukui: ['storage.tukui.org'],
  curseforge: ['media.forgecdn.net', 'mediafilez.forgecdn.net', 'edge.forgecdn.net'],
  wowup: ['repository-images.githubusercontent.com', 'avatars.githubusercontent.com', 'raw.githubusercontent.com', 'gitlab.com'],
};
const imageLimit = 6 * 1024 ** 2;
const catalogLimit = 20 * 1024 ** 2;
const archiveLimit = 128 * 1024 ** 2;
const wowi = 'https://api.mmoui.com/v3/game/WOW';
const tukui = 'https://api.tukui.org/v1';
const forge = 'https://api.curseforge.com/v1';
const hub = 'https://hub.wowup.io/addons';
const hubDownloads = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'gitlab.com'];
// The official Forever release is listed on CurseForge and absent from WowUp Hub.
const detailsForever = {
  id: '61284', title: 'Details! Damage Meter', author: 'Terciob',
  summary: 'Damage and healing meter for World of Warcraft. Download the WoW Forever release from CurseForge.',
  url: 'https://www.curseforge.com/wow/addons/details/files/all?gameVersionTypeId=88568&page=1&pageSize=20&showAlphaFiles=hide',
  canInstall: false,
};

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

function forClient(entry, versions, client) {
  const isCompatible = compatible(versions, client);
  return { ...entry, isCompatible, canInstall: isCompatible && entry.canInstall };
}

function matchesQuery(needle, ...fields) {
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}

const searchTitle = (value) => value.toLowerCase().replaceAll('!', '').replace(/\s+/g, ' ').trim();

function interfaceVersion(input) {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 10000) return null;
  return [Math.floor(value / 10000), Math.floor(value / 100) % 100, value % 100].join('.');
}

function hubGame({ edition, version }) {
  if (edition === 'progression') {
    return { 3: 'wotlk', 4: 'cata', 5: 'mists' }[version?.split('.')[0]] || 'mists';
  }
  return { era: 'classic', anniversary: 'burningCrusade', titan: 'wotlk', forever: 'forever' }[edition] || 'retail';
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

  function hubFiles(item) {
    return (item.releases || []).filter((file) => !file.prerelease && sourceUrl(hubDownloads, file.download_url))
      .map((file) => ({
        ...file, versions: (file.game_versions || []).flatMap((tag) => tag.interfaces || [tag.interface])
          .map(interfaceVersion).filter(Boolean),
      })).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  }

  function hubRelease(files, client, revision) {
    return files.find((file) => (revision === undefined || String(file.id) === revision)
      && compatible(file.versions, client));
  }

  function hubEntry(item, file) {
    const isCompatible = Boolean(file);
    return { ...publicEntry('wowup', {
      id: item.id, title: item.repository_name, author: item.owner_name, url: `https://wowup.io/addons/${item.id}`,
      image: item.image_url || item.owner_image_url, downloads: item.total_download_count, canInstall: isCompatible,
    }), isCompatible };
  }

  async function getWowiListing(id) {
    const list = await cached(`${wowi}/filelist.json`, 'wowinterface');
    return list.find((item) => String(item.UID) === id);
  }

  async function searchSource(source, query, client) {
    const needle = query.toLowerCase();
    if (source === 'wowinterface') {
      const list = await cached(`${wowi}/filelist.json`, source);
      return list.filter((item) => matchesQuery(needle, item.UIName, item.UIAuthorName))
        .map((item) => forClient(wowiEntry(item), wowiVersions(item), client));
    }
    if (source === 'tukui') {
      const list = await cached(`${tukui}/addons`, source);
      return list.filter((item) => matchesQuery(needle, item.name, item.author, item.small_desc))
        .map((item) => forClient(tukuiEntry(item), item.patch, client));
    }
    if (source === 'wowup') {
      const game = hubGame(client);
      const path = query ? `search/${game}?${new URLSearchParams({ query, limit: '50' })}` : `featured/${game}?count=60`;
      const { addons } = await json(`${hub}/${path}`, source);
      return addons.map((item) => hubEntry(item, hubRelease(hubFiles(item), client)));
    }
    const params = new URLSearchParams({ gameId: '432', searchFilter: query, pageSize: '50', sortField: '2', sortOrder: 'desc' });
    if (!query && client.edition === 'retail') params.set('gameVersionTypeId', '517');
    const { data } = await json(`${forge}/mods/search?${params}`, source);
    return data.filter((item) => item.gameId === 432)
      .map((item) => forClient(forgeEntry(item), forgeVersions(item), client));
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
        items.push(...(needle ? outcome.value : outcome.value.filter((item) => item.isCompatible)));
      } else {
        warnings.push(`${sources[selected[index]]} is unavailable. Try searching again later.`);
      }
    });
    const titleQuery = searchTitle(query);
    if (client.edition === 'forever' && (source === 'all' || source === 'curseforge')
      && titleQuery && searchTitle(detailsForever.title).includes(titleQuery)) {
      const index = items.findIndex((item) => item.source === 'curseforge' && item.id === detailsForever.id);
      const result = items[index];
      if (!result?.canInstall) {
        const listing = { ...publicEntry('curseforge', detailsForever), isCompatible: true, externalOnly: true };
        if (result) items[index] = listing;
        else items.push(listing);
      }
    }
    const rank = (item) => {
      const title = searchTitle(item.title);
      return title === titleQuery ? 2 : title.startsWith(titleQuery) ? 1 : 0;
    };
    items.sort((a, b) => rank(b) - rank(a) || Number(b.isCompatible) - Number(a.isCompatible)
      || b.downloads - a.downloads || a.title.localeCompare(b.title));
    const curseForgeSearch = query && source === 'all' && !key
      ? `https://www.curseforge.com/wow/search?${new URLSearchParams({ class: 'addons', search: query })}`
      : null;
    return { items: items.slice(0, 60), warnings, curseForgeSearch };
  }

  async function release(source, id, client, revision) {
    const unavailable = revision === undefined ? 'No compatible release is available for this WoW client.'
      : 'The installed release is unavailable.';
    if (source === 'wowup' && /^\d{1,12}$/.test(id)) {
      const { addon } = await cached(`${hub}/${id}`, source);
      const file = hubRelease(hubFiles(addon), client, revision);
      if (file) return { source, id, title: addon.repository_name, version: file.name || file.tag_name,
        time: Date.parse(file.published_at), revision: String(file.id), url: file.download_url };
    }
    if (source === 'wowinterface' && /^\d{1,12}$/.test(id)) {
      const entry = await getWowiListing(id);
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

  function images(source, urls) {
    return [...new Set(urls.map((url) => imageUrl(source, url)).filter(Boolean))].slice(0, 12);
  }

  async function project(source, id, client) {
    if (source === 'wowup' && /^\d{1,12}$/.test(id)) {
      const { addon } = await cached(`${hub}/${id}`, source);
      const files = hubFiles(addon);
      const latest = hubRelease(files, client);
      const changelog = latest?.body || (latest && await cached(`${hub}/${id}/releases/${latest.id}`, source)
        .then(({ release }) => release.body).catch(() => ''));
      return { ...hubEntry(addon, latest), description: webText(addon.description), changelog: webText(changelog),
        versions: [...new Set(files.flatMap((file) => file.versions))], version: latest?.name || latest?.tag_name,
        time: Date.parse(latest?.published_at), screenshots: images(source, (latest?.previews || []).map(({ url }) => url)),
      };
    }
    if (source === 'wowinterface' && /^\d{1,12}$/.test(id)) {
      const [entry, detail] = await Promise.all([
        getWowiListing(id),
        json(`${wowi}/filedetails/${id}.json`, source).then((items) => items[0]),
      ]);
      if (entry && detail) return forClient({ ...wowiEntry(entry),
        description: forumText(detail.UIDescription), changelog: forumText(detail.UIChangeLog),
        versions: wowiVersions(entry), version: detail.UIVersion, time: Number(detail.UIDate),
        screenshots: images(source, entry.UIIMGs || []),
        canInstall: Boolean(detail.UIDownload),
      }, wowiVersions(entry), client);
    }
    if (source === 'tukui' && /^(elvui|tukui)$/.test(id)) {
      const [item, changelog] = await Promise.all([
        json(`${tukui}/addon/${id}`, source),
        fetchText(`${tukui}/changelog/${id}`, source).catch(() => ''),
      ]);
      return forClient({ ...tukuiEntry(item), description: item.desc, changelog,
        versions: item.patch, version: item.version, time: Date.parse(item.last_update),
        screenshots: images(source, [item.screenshot_url, ...(item.gallery_url || [])]),
        canInstall: Boolean(item.url),
      }, item.patch, client);
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
      const versions = forgeVersions(mod);
      return forClient({ ...entry, description: description || entry.summary, changelog,
        versions, version: latest?.displayName || latest?.fileName, time: Date.parse(latest?.fileDate),
        screenshots: images(source, (mod.screenshots || []).map(({ url }) => url)),
      }, versions, client);
    }
    throw new Error('This addon project is unavailable.');
  }

  async function download(file, destination) {
    const hosts = {
      wowinterface: ['cdn.wowinterface.com', 'www.wowinterface.com', 'cdn-wow.mmoui.com', 'downloads.wowinterface.com'],
      tukui: ['api.tukui.org'],
      curseforge: ['edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net'],
      wowup: hubDownloads,
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
