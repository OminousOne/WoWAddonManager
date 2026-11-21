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
    append(...children) { this.children.push(...children); },
    add(child) { this.append(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    setAttribute() {},
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

test('clears the previous installation’s addons when a rescan switches clients and reading fails', async () => {
  const filename = path.join(__dirname, '../src/renderer/app.js');
  const script = await fs.readFile(filename, 'utf8');
  const first = { id: 'A', label: 'Retail', directory: '/retail' };
  const second = { id: 'B', label: 'Classic', directory: '/classic' };
  let installations = [first, second];
  const ledger = {
    editions: async () => installations,
    addons: async (id) => {
      if (id === second.id) throw new Error('Could not read Classic addons');
      assert.equal(id, first.id);
      return [{ folder: 'RetailOnly', title: 'Retail Only', author: '', version: '' }];
    },
  };
  const elements = new Map();
  const document = {
    createElement: element,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element(selector));
      return elements.get(selector);
    },
  };
  const storage = new Map();
  const localStorage = { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) };

  await vm.runInNewContext(script, { document, localStorage, window: { ledger } }, { filename });
  assert.equal(elements.get('#edition').value, first.id);
  assert.equal(elements.get('#count').textContent, '1 of 1 addons');
  assert.equal(elements.get('#results').children[0].tag, 'table');

  installations = [second];
  await elements.get('#refresh').listeners.click();

  assert.equal(elements.get('#edition').value, second.id);
  assert.equal(elements.get('#notice').textContent, 'Could not read Classic addons');
  assert.equal(elements.get('#count').textContent, '0 of 0 addons');
  assert.equal(elements.get('#results').children[0].className, 'empty');
});
