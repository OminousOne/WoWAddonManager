const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogImage, compatible, newCatalog, projectPage } = require('../src/main/sources.cjs');

test('isolates edition tags and Classic Progression expansions', () => {
  assert.equal(compatible(['12.1.5', '1.15.9'], { edition: 'forever' }), false);
  assert.equal(compatible(['1.60.1'], { edition: 'forever' }), true);
  assert.equal(compatible(['5.5.4'], { edition: 'progression', version: '4.4.2' }), false);
  assert.equal(compatible(['5.5.4'], { edition: 'progression', version: '5.5.3' }), true);
});

test('keeps working results when a catalog fails', async () => {
  const catalog = newCatalog('', async (url) => {
    if (url.host === 'api.mmoui.com') return new Response('error', { status: 500 });
    if (url.host === 'hub.wowup.io') return Response.json({ addons: [] });
    return Response.json([{ slug: 'elvui', name: 'ElvUI', patch: ['12.1.5'], author: 'Elv' }]);
  });
  const { items, warnings } = await catalog.search('elvui', 'all', { edition: 'retail' });
  assert.equal(items[0].title, 'ElvUI');
  assert.match(warnings[0], /WoWInterface/);
});

test('finds Questie across editions and restricts browsing and installation to compatible releases', async () => {
  const questie = { UID: '24994', UIName: 'Questie', UICompatibility: [{ version: '1.13.7' }] };
  const related = { UID: '42', UIName: 'Questie Helper', UIDownloadTotal: '2000000',
    UICompatibility: [{ version: '12.1.5' }] };
  const catalog = newCatalog('', async (url) => {
    if (url.host === 'api.tukui.org') return Response.json([]);
    if (url.host === 'hub.wowup.io') return Response.json({ addons: [] });
    return Response.json(url.pathname.endsWith('/filelist.json') ? [questie, related]
      : [{ UIName: 'Questie', UIDownload: 'https://cdn.wowinterface.com/example.zip' }]);
  });
  const retail = { edition: 'retail' };
  const classic = { edition: 'era' };
  const { items, curseForgeSearch } = await catalog.search('qUeStIe', 'all', retail);
  assert.deepEqual(items.map(({ title, isCompatible, canInstall }) => [title, isCompatible, canInstall]),
    [['Questie', false, false], ['Questie Helper', true, true]]);
  const browserSearch = new URL(curseForgeSearch);
  assert.equal(browserSearch.origin + browserSearch.pathname, 'https://www.curseforge.com/wow/search');
  assert.equal(browserSearch.searchParams.get('search'), 'qUeStIe');
  const browse = await catalog.search('', 'all', retail);
  assert.deepEqual(browse.items.map(({ title }) => title), ['Questie Helper']);
  assert.equal(browse.curseForgeSearch, null);

  const detail = await catalog.project('wowinterface', questie.UID, retail);
  assert.equal(detail.isCompatible, false);
  assert.equal(detail.canInstall, false);
  await assert.rejects(catalog.release('wowinterface', questie.UID, retail), /No compatible release/);
  const classicSearch = await catalog.search('Questie', 'wowinterface', classic);
  assert.equal(classicSearch.items[0].canInstall, true);
  assert.equal(classicSearch.curseForgeSearch, null);
});

test('WowUp Hub searches the Forever catalog and selects stable downloads per client', async () => {
  const stable = { id: 252911, name: 'Questie.zip', published_at: '2026-11-21',
    game_versions: [{ game_type: 'forever', interface: '16001' }],
    download_url: 'https://github.com/Questie/Questie/releases/download/v1/Questie.zip' };
  const older = { ...stable, id: 252910, published_at: '2026-11-20',
    download_url: 'https://github.com/Questie/Questie/releases/download/v0/Questie.zip' };
  const questie = { id: 47671, repository_name: 'Questie', description: '<p>Quest helper</p>', releases: [
    { ...stable, id: 3, published_at: '2026-11-22', prerelease: true },
    { ...stable, id: 4, published_at: '2026-11-23', download_url: 'https://unrelated.example/Questie.zip' },
    stable,
    { ...stable, id: 252900, published_at: '2026-11-01' },
  ] };
  const another = { id: 275, repository_name: 'Better Vendor Price', releases: [
    { ...stable, id: 7, name: 'BetterVendorPrice.zip',
      download_url: 'https://github.com/mooreatv/BetterVendorPrice/releases/download/v1/BetterVendorPrice.zip' },
  ] };
  const catalog = newCatalog('', async (url) => {
    assert.equal(url.host, 'hub.wowup.io');
    if (url.pathname === '/addons/47671/releases/252911') return Response.json({ release: { body: '<p>Fixes</p>' } });
    if (url.pathname === '/addons/47671/releases/252910') return Response.json({ release: older });
    if (url.pathname === '/addons/47671/releases/3') return new Response(null, { status: 404 });
    if (url.pathname === '/addons/47671') return Response.json({ addon: questie });
    if (url.pathname === '/addons/featured/forever') return Response.json({ addons: [questie, another] });
    assert.equal(url.pathname, '/addons/search/forever');
    const query = url.searchParams.get('query');
    return Response.json({ addons: query === 'Questie' ? [questie] : [another] });
  });
  const forever = { edition: 'forever', version: '1.60.1' };
  for (const query of ['Questie', 'Better Vendor Price']) {
    const { items, warnings } = await catalog.search(query, 'wowup', forever);
    assert.deepEqual(warnings, []);
    assert.equal(items[0].title, query);
    assert.equal(items[0].canInstall, true);
  }
  const browse = await catalog.search('', 'wowup', forever);
  assert.equal(browse.items.length, 2);
  const detail = await catalog.project('wowup', '47671', forever);
  assert.deepEqual(detail.versions, ['1.60.1']);
  assert.equal(detail.description, 'Quest helper');
  assert.equal(detail.changelog, 'Fixes');
  assert.equal((await catalog.release('wowup', '47671', forever)).revision, '252911');
  const recorded = await catalog.release('wowup', '47671', forever, '252910');
  assert.equal(recorded.revision, '252910');
  assert.equal(recorded.url, older.download_url);
  assert.equal((await catalog.release('wowup', '47671', forever, '252900')).revision, '252900');
  await assert.rejects(catalog.release('wowup', '47671', forever, '3'), /installed release is unavailable/);
  await assert.rejects(catalog.release('wowup', '47671', { edition: 'era' }), /No compatible release/);
});

test('CurseForge text search includes Classic results for Retail and preserves distribution restrictions', async () => {
  const catalog = newCatalog('fixture-key', async (url) => {
    assert.equal(url.pathname, '/v1/mods/search');
    assert.equal(url.searchParams.get('gameVersionTypeId'), url.searchParams.get('searchFilter') ? null : '517');
    return Response.json({ data: [
      { id: 1, name: 'Questie', gameId: 432, latestFilesIndexes: [{ releaseType: 1, gameVersion: '2.5.6' }] },
      { id: 2, name: 'Questie Helper', gameId: 432, allowModDistribution: false,
        latestFilesIndexes: [{ releaseType: 1, gameVersion: '12.1.5' }] },
    ] });
  });
  const retail = { edition: 'retail' };
  const { items, curseForgeSearch } = await catalog.search('Questie', 'curseforge', retail);
  assert.deepEqual(items.map(({ title, isCompatible, canInstall }) => [title, isCompatible, canInstall]),
    [['Questie', false, false], ['Questie Helper', true, false]]);
  assert.equal(curseForgeSearch, null);
  const browse = await catalog.search('', 'curseforge', retail);
  assert.deepEqual(browse.items.map(({ title }) => title), ['Questie Helper']);
});

test('finds the official Details! Forever files when no installable CurseForge result is available', async () => {
  const forever = { edition: 'forever', version: '1.60.1' };
  const query = 'Details Damage Meter';
  const withoutKey = newCatalog('', async (url) => {
    assert.notEqual(url.host, 'api.curseforge.com');
    return Response.json(url.host === 'hub.wowup.io' ? { addons: [] } : []);
  });
  const { items, warnings } = await withoutKey.search(query, 'all', forever);
  assert.deepEqual(warnings, []);
  assert.equal(items.length, 1);
  const [entry] = items;
  assert.equal(entry.title, 'Details! Damage Meter');
  assert.equal(entry.source, 'curseforge');
  assert.equal(entry.isCompatible, true);
  assert.equal(entry.canInstall, false);
  assert.equal(entry.externalOnly, true);
  const files = new URL(entry.website);
  assert.equal(files.origin + files.pathname, 'https://www.curseforge.com/wow/addons/details/files/all');
  assert.equal(files.searchParams.get('gameVersionTypeId'), '88568');
  assert.deepEqual((await withoutKey.search('Details!', 'all', forever)).items, items);
  assert.deepEqual((await withoutKey.search(query, 'wowup', forever)).items, []);
  assert.deepEqual((await withoutKey.search(query, 'all', { edition: 'era' })).items, []);
  assert.deepEqual((await withoutKey.search('', 'all', forever)).items, []);

  const listing = { id: 61284, name: 'Details! Damage Meter', gameId: 432,
    latestFilesIndexes: [{ releaseType: 1, gameVersion: '1.60.1' }],
  };
  const withKey = newCatalog('fixture-key', async () => Response.json({ data: [listing] }));
  const live = await withKey.search(query, 'curseforge', forever);
  assert.equal(live.items.length, 1);
  assert.equal(live.items[0].id, '61284');
  assert.equal(live.items[0].canInstall, true);
  assert.equal(live.items[0].externalOnly, undefined);

  listing.allowModDistribution = false;
  assert.deepEqual((await withKey.search(query, 'curseforge', forever)).items, items);
});

test('CurseForge selects a stable compatible release and honors distribution permissions', async () => {
  const calls = [];
  const catalog = newCatalog('fixture-key', async (url, options) => {
    assert.equal(url.host, 'api.curseforge.com');
    assert.equal(options.headers['x-api-key'], 'fixture-key');
    calls.push(url.pathname);
    if (url.pathname.endsWith('/files')) return Response.json({ data: [
      { id: 25, releaseType: 2, isAvailable: true, gameVersions: ['12.1.5'], fileDate: '2026-03-01' },
      { id: 24, releaseType: 1, isAvailable: true, gameVersions: ['5.5.4'], fileDate: '2026-02-01' },
      { id: 23, releaseType: 1, isAvailable: true, gameVersions: ['12.1.5'], fileDate: '2026-01-01',
        downloadUrl: 'https://edge.forgecdn.net/example.zip', displayName: 'Example v1' },
    ] });
    return Response.json({ data: { gameId: 432, name: 'Example', allowModDistribution: url.pathname.endsWith('/11') } });
  });
  const client = { edition: 'retail' };
  assert.equal((await catalog.release('curseforge', '11', client)).revision, '23');
  await assert.rejects(catalog.release('curseforge', '12', client), /unavailable for third-party/);
  assert.deepEqual(calls, ['/v1/mods/11', '/v1/mods/11/files', '/v1/mods/12']);
});

test('CurseForge follows file pagination and resolves a recorded historical release by ID', async () => {
  const pages = [];
  const latest = { id: 100, releaseType: 1, isAvailable: true, gameVersions: ['1.60.1'], fileDate: '2026-11-21',
    downloadUrl: 'https://edge.forgecdn.net/latest.zip' };
  const older = { ...latest, id: 25, fileDate: '2026-11-20', downloadUrl: 'https://edge.forgecdn.net/older.zip' };
  const catalog = newCatalog('fixture-key', async (url) => {
    switch (url.pathname) {
      case '/v1/mods/11':
        return Response.json({ data: { gameId: 432, name: 'Example' } });
      case '/v1/mods/11/files': {
        const index = Number(url.searchParams.get('index'));
        pages.push(index);
        assert.equal(url.searchParams.get('pageSize'), '50');
        if (index === 0) {
          const files = Array.from({ length: 50 }, (_, i) => ({ ...latest, id: 150 - i,
            ...(i % 2 ? { gameVersions: ['1.15.9'] } : { releaseType: 2 }),
          }));
          return Response.json({ data: files, pagination: { index, pageSize: 50, resultCount: 50, totalCount: 51 } });
        }
        assert.equal(index, 50);
        return Response.json({ data: [latest], pagination: { index, pageSize: 50, resultCount: 1, totalCount: 51 } });
      }
      case '/v1/mods/11/files/25':
        return Response.json({ data: older });
      case '/v1/mods/11/files/26':
        return new Response(null, { status: 404 });
      default:
        assert.fail(`Unexpected request to ${url.pathname}`);
    }
  });
  const client = { edition: 'forever' };
  assert.equal((await catalog.release('curseforge', '11', client)).revision, '100');
  const recorded = await catalog.release('curseforge', '11', client, '25');
  assert.equal(recorded.revision, '25');
  assert.equal(recorded.url, older.downloadUrl);
  await assert.rejects(catalog.release('curseforge', '11', client, '26'), /installed release is unavailable/);
  assert.deepEqual(pages, [0, 50]);
});

test('project links stay on the source’s HTTPS website', () => {
  assert.equal(projectPage('tukui', 'https://tukui.org/elvui'), 'https://tukui.org/elvui');
  assert.equal(projectPage('tukui', 'https://tukui.org.invalid/elvui'), null);
  assert.equal(projectPage('curseforge', 'file:///private/data'), null);
});

test('WoWInterface project combines gallery, description, and compatibility from both endpoints', async () => {
  const photo = 'https://cdn-wow.mmoui.com/preview/example.jpg';
  const catalog = newCatalog('', async (url) => url.pathname.endsWith('/filelist.json')
    ? Response.json([{ UID: '11', UIName: 'Example', UIIMGs: [photo, 'https://invalid.example/image.jpg'],
      UICompatibility: [{ version: '12.1.5' }] }])
    : Response.json([{ UIDescription: '[B]Useful addon[/B]', UIChangeLog: '[LIST][*]Fixed a bug[/LIST]',
      UIVersion: '2.0', UIDownload: 'https://cdn.wowinterface.com/example.zip' }]));
  const project = await catalog.project('wowinterface', '11', { edition: 'retail' });
  assert.equal(project.description, 'Useful addon');
  assert.equal(project.changelog, '• Fixed a bug');
  assert.deepEqual(project.screenshots, [photo]);
  assert.equal(project.image, photo);
  assert.equal(project.canInstall, true);
  assert.equal((await catalog.project('wowinterface', '11', { edition: 'era' })).canInstall, false);
});

test('CurseForge project converts its full description and changelog to readable text', async () => {
  const screenshot = 'https://media.forgecdn.net/example.png';
  const catalog = newCatalog('fixture-key', async (url) => {
    if (url.pathname.endsWith('/description')) return Response.json({ data: '<p>Full description</p><script>ignored()</script>' });
    if (url.pathname.endsWith('/changelog')) return Response.json({ data: '<p>Release notes</p>' });
    return Response.json({ data: { id: 77, gameId: 432, name: 'Example',
      screenshots: [{ url: screenshot }],
      latestFiles: [{ id: 80, isAvailable: true, displayName: '1.2', releaseType: 1, gameVersions: ['12.1.5'] }],
    } });
  });
  const project = await catalog.project('curseforge', '77', { edition: 'retail' });
  assert.equal(project.description, 'Full description');
  assert.equal(project.changelog, 'Release notes');
  assert.equal(project.version, '1.2');
  assert.deepEqual(project.screenshots, [screenshot]);
});

test('addon images enforce source hosts, redirect boundaries, and raster types', async () => {
  const sample = 'https://storage.tukui.org/example.png';
  const image = await catalogImage('tukui', sample, async (url, options) => {
    assert.equal(url.href, sample);
    assert.deepEqual(options.headers, {});
    return new Response('raster data', { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(await image.text(), 'raster data');
  await assert.rejects(catalogImage('tukui', 'file:///tmp/example.png', async () => {
    assert.fail('Invalid image URLs must never fetch.');
  }), /Invalid addon image/);
  await assert.rejects(catalogImage('tukui', sample, async () => Response.redirect('https://invalid.example/image.png')),
    /unexpected download address/);
  await assert.rejects(catalogImage('tukui', sample, async () => new Response('<svg/>', {
    headers: { 'Content-Type': 'image/svg+xml' },
  })), /Unsupported addon image/);
});

test('CurseForge selects a stable compatible release from a later file page', async () => {
  const offsets = [];
  const catalog = newCatalog('fixture-key', async (url) => {
    if (!url.pathname.endsWith('/files')) {
      return Response.json({ data: { gameId: 432, name: 'Example', allowModDistribution: true } });
    }
    const index = Number(url.searchParams.get('index'));
    offsets.push(index);
    const data = index === 0 ? Array.from({ length: 50 }, (_, i) => ({
      id: 100 - i, releaseType: 1, isAvailable: true, gameVersions: ['5.5.4'], fileDate: '2026-03-01',
    })) : [{
      id: 50, releaseType: 1, isAvailable: true, gameVersions: ['1.60.1'], fileDate: '2026-02-01',
      downloadUrl: 'https://edge.forgecdn.net/example.zip', displayName: 'Example v1',
    }];
    return Response.json({ data, pagination: { index, pageSize: 50, resultCount: data.length, totalCount: 51 } });
  });
  assert.equal((await catalog.release('curseforge', '11', { edition: 'forever' })).revision, '50');
  assert.deepEqual(offsets, [0, 50]);
});
