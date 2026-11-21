const assert = require('node:assert/strict');
const test = require('node:test');
const { compatible, newCatalog } = require('../src/main/sources.cjs');

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
