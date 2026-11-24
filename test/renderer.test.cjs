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
    append(...children) { this.children.push(...children); },
    add(child) { this.append(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    setAttribute() {},
    removeAttribute() {},
    querySelector(selector) {
      if (!this.descendants.has(selector)) this.descendants.set(selector, element(selector));
      return this.descendants.get(selector);
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

test('clears stale rows and update actions when a library read fails', async () => {
  const filename = path.join(__dirname, '../src/renderer/app.js');
  const script = await fs.readFile(filename, 'utf8');
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
  const document = { ...element('document'), createElement: element };
  const $ = document.querySelector.bind(document);
  $('#library-filter').value = 'all';
  const storage = new Map();
  const localStorage = { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) };

  await vm.runInNewContext(script, { document, localStorage, window: { ledger, scrollTo() {} } }, { filename });
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
