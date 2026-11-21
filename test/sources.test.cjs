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
    return Response.json([{ slug: 'elvui', name: 'ElvUI', patch: ['12.1.5'], author: 'Elv' }]);
  });
  const { items, warnings } = await catalog.search('elvui', 'all', { edition: 'retail' });
  assert.equal(items[0].title, 'ElvUI');
  assert.match(warnings[0], /WoWInterface/);
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
