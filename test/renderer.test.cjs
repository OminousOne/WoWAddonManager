const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function element(tag) {
  return {
    tag,
    value: '',
    children: [],
    style: {},
    listeners: {},
    descendants: new Map(),
    attributes: new Map(),
    append(...children) { this.children.push(...children); },
    add(child) { this.append(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() { this.focused = true; },
    querySelector(selector) {
      if (!this.descendants.has(selector)) this.descendants.set(selector, element(selector));
      return this.descendants.get(selector);
    },
    querySelectorAll(selector) {
      const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      return this.children.flatMap((child) => [
        ...(child.attributes.has(attribute) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    createTHead() { return this.appendElement('thead'); },
    createTBody() { return this.appendElement('tbody'); },
    insertRow() { return this.appendElement('tr'); },
    insertCell() { return this.appendElement('td'); },
    appendElement(childTag) {
      const child = element(childTag);
      this.append(child);
      return child;
    },
  };
}

async function loadRenderer(ledger) {
  const filename = path.join(__dirname, '../src/renderer/app.js');
  const script = await fs.readFile(filename, 'utf8');
  const document = { ...element('document'), createElement: element };
  const $ = document.querySelector.bind(document);
  $('#library-filter').value = 'all';
  const storage = new Map();
  const localStorage = { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) };
  await vm.runInNewContext(script, { document, localStorage, window: { ledger, scrollTo() {} } }, { filename });
  return $;
}

test('clears stale rows and update actions when a library read fails', async () => {
  const first = { id: 'A', label: 'Retail', directory: '/retail' };
  const second = { id: 'B', label: 'Classic', directory: '/classic' };
  const addon = { key: 'tukui:elvui', source: 'tukui', folder: 'ElvUI', title: 'ElvUI', revision: '1' };
  let installations = [first, second];
  const readingSecond = Promise.withResolvers();
  const secondAddons = Promise.withResolvers();
  const searches = [];
  let failRetailRead = false;
  const ledger = {
    sources: async () => ({ curseforge: false }),
    editions: async () => installations,
    addons: async (id) => {
      if (id === second.id) {
        readingSecond.resolve();
        return secondAddons.promise;
      }
      assert.equal(id, first.id);
      if (failRetailRead) throw new Error('Could not read Retail addons');
      return [addon];
    },
    updates: async () => [{ key: addon.key, revision: addon.revision, status: 'available', version: '2' }],
    search: async (id) => {
      searches.push(id);
      return { items: [], warnings: [] };
    },
  };
  const $ = await loadRenderer(ledger);
  assert.equal($('#edition').value, first.id);
  assert.equal($('#results').children[0].tag, 'table');
  assert.equal($('#update-all').hidden, false);
  await $('#catalog-tab').listeners.click();
  await $('#library-tab').listeners.click();
  assert.deepEqual(searches, [first.id]);

  failRetailRead = true;
  await $('#refresh').listeners.click();
  assert.equal($('#edition').value, first.id);
  assert.equal($('#notice').textContent, 'Could not read Retail addons');
  assert.equal($('#count').textContent, '');
  assert.equal($('#update-all').hidden, true);
  assert.equal($('#filter').disabled, true);
  failRetailRead = false;
  await $('#refresh').listeners.click();
  assert.equal($('#results').children[0].tag, 'table');
  assert.equal($('#update-all').hidden, false);

  $('#library-filter').value = 'updates';
  installations = [second];
  const refresh = $('#refresh').listeners.click();
  await Promise.race([readingSecond.promise, refresh]);
  assert.equal($('#edition').value, second.id);
  assert.equal($('#results').children[0].className, 'empty');
  secondAddons.reject(new Error('Could not read Classic addons'));
  await refresh;

  assert.equal($('#notice').textContent, 'Could not read Classic addons');
  assert.equal($('#count').textContent, '');
  assert.equal($('#library-filter').value, 'all');
  assert.equal($('#results').children[0].className, 'empty');
  assert.equal($('#update-all').hidden, true);
  assert.equal($('#check-updates').disabled, true);
  await $('#catalog-tab').listeners.click();
  assert.deepEqual(searches, [first.id, second.id]);
});

test('announces Discover searches and restores focus to the project card on return', async () => {
  const response = Promise.withResolvers();
  const client = { id: 'A', label: 'Retail', directory: '/retail' };
  const item = { source: 'tukui', id: 'elvui', title: 'ElvUI', canInstall: true };
  const warning = 'WoWInterface is unavailable.';
  const $ = await loadRenderer({
    sources: async () => ({ curseforge: false }),
    editions: async () => [client],
    addons: async () => [],
    search: () => response.promise,
    project: async () => ({ ...item, description: 'Customizable interface' }),
  });

  $('#query').value = ' ElvUI ';
  const discovering = $('#catalog-tab').listeners.click();
  assert.equal($('#catalog-status').children[0].textContent, 'Searching sources…');
  assert.equal($('#catalog-results').getAttribute('aria-busy'), 'true');
  response.resolve({ items: [item], warnings: [warning] });
  await discovering;
  assert.equal($('#catalog-results').getAttribute('aria-busy'), 'false');
  assert.deepEqual($('#catalog-status').children.map(({ textContent }) => textContent), ['1 result for “ElvUI”', warning]);

  $('#catalog').append($('#catalog-results'));
  const [open] = $('#catalog').querySelectorAll('[data-project-link]');
  await open.listeners.click();
  assert.equal($('#page-title').textContent, 'ElvUI');
  assert.equal($('#project-back').focused, true);
  await $('#project-back').listeners.click();
  const [restored] = $('#catalog').querySelectorAll('[data-project-link]');
  assert.equal(restored.focused, true);
  assert.equal($('#catalog-status').children[1].textContent, warning);
});

test('distinguishes a saved CurseForge key from the environment fallback', async () => {
  const environment = { curseforge: true, curseforgeKeySource: 'environment', curseforgeKeySaved: false };
  const saved = { curseforge: true, curseforgeKeySource: 'saved', curseforgeKeySaved: true };
  const $ = await loadRenderer({
    sources: async () => environment,
    editions: async () => [],
    setCurseForgeKey: async (key) => key ? saved : environment,
  });

  await $('#sources-tab').listeners.click();
  assert.equal($('#key-status').textContent, 'Environment key');
  assert.equal($('#clear-key').disabled, true);
  $('#api-key').value = 'fixture';
  await $('#source-form').listeners.submit({ preventDefault() {} });
  assert.equal($('#api-key').value, '');
  assert.equal($('#key-status').textContent, 'Saved key');
  assert.equal($('#clear-key').disabled, false);
  await $('#clear-key').listeners.click();
  assert.equal($('#key-status').textContent, 'Environment key');
  assert.equal($('#clear-key').disabled, true);
  assert.match($('#notice').textContent, /using the environment key/);
});

test('allows clearing a saved CurseForge key that is unavailable', async () => {
  const $ = await loadRenderer({
    sources: async () => ({ curseforge: false, curseforgeKeySource: null, curseforgeKeySaved: true }),
    editions: async () => [],
    setCurseForgeKey: async () => ({ curseforge: false, curseforgeKeySource: null, curseforgeKeySaved: false }),
  });

  await $('#sources-tab').listeners.click();
  assert.equal($('#key-status').textContent, 'Saved key unavailable');
  assert.equal($('#clear-key').disabled, false);
  await $('#clear-key').listeners.click();
  assert.equal($('#key-status').textContent, 'Key required');
  assert.equal($('#clear-key').disabled, true);
});
