const $ = (selector) => document.querySelector(selector);
const api = window.ledger;
const edition = $('#edition');
const filter = $('#filter');
const state = { installations: [], addons: [], selection: null, busy: false };

function el(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, action, primary = false) {
  const item = el('button', text, primary ? 'button primary' : 'button');
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
}

function notify(message = '') {
  const notice = $('#notice');
  notice.hidden = !message;
  notice.textContent = message;
}

function empty(title, description, action) {
  const box = el('div', null, 'empty');
  const mark = el('span', '◈', 'empty-mark');
  mark.setAttribute('aria-hidden', 'true');
  box.append(mark, el('h2', title), el('p', description));
  if (action) box.append(action);
  return box;
}

function table(headings, rows) {
  const result = el('table');
  const head = result.createTHead().insertRow();
  for (const [label, width] of headings) {
    const cell = el('th', label);
    cell.scope = 'col';
    cell.style.width = width;
    head.append(cell);
  }
  const body = result.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const value of cells) row.insertCell().append(value);
  }
  return result;
}

function render() {
  edition.replaceChildren();
  const installations = state.installations;
  const selected = installations.find(({ id }) => id === state.selection);
  if (!installations.length) edition.add(el('option', state.busy ? 'Scanning…' : 'No installation'));
  for (const install of installations) {
    const sibling = installations.some((peer) => peer.id !== install.id && peer.label === install.label);
    const label = sibling ? `${install.label} · ${install.directory}` : install.label;
    const option = el('option', label);
    option.value = install.id;
    edition.add(option);
  }
  if (selected) edition.value = selected.id;
  edition.disabled = state.busy || !selected;
  $('#open-folder').disabled = state.busy || !selected;
  $('#add-folder').disabled = state.busy;
  $('#refresh').disabled = state.busy;
  const details = $('#client-details');
  details.textContent = selected ? (selected.version || selected.directory) : 'Select a game folder to begin';
  details.title = selected?.directory || '';

  const results = $('#results');
  filter.disabled = !selected;
  const query = filter.value.trim().toLowerCase();
  const matched = state.addons.filter((addon) => [addon.title, addon.folder, addon.author]
    .some((value) => value.toLowerCase().includes(query)));
  $('#count').textContent = selected ? `${matched.length} of ${state.addons.length} addons` : '';
  if (!selected) {
    const action = button('Choose WoW folder', addFolder, true);
    action.disabled = state.busy;
    results.replaceChildren(empty(
      state.busy ? 'Scanning for World of Warcraft…' : 'Find your WoW installation',
      'Choose the World of Warcraft folder or an individual client folder to see its addons.',
      action,
    ));
    return;
  }
  if (!matched.length) {
    results.replaceChildren(empty(
      state.busy ? 'Reading your addons…' : query ? 'No matching addons' : 'No addons found',
      query ? 'Try a different addon name or author.' : 'Addons found in this client’s Interface/AddOns folder will appear here.',
    ));
    return;
  }
  const rows = matched.map((addon) => {
    const title = el('strong', addon.title || addon.folder);
    title.append(el('small', addon.folder));
    return [title, addon.author || '—', addon.version || '—'];
  });
  results.replaceChildren(table([['Addon', '52%'], ['Author', '28%'], ['Version', '20%']], rows));
}

async function run(operation) {
  if (state.busy) return;
  state.busy = true;
  notify();
  render();
  try {
    await operation();
  } catch (error) {
    notify(error.message);
  } finally {
    state.busy = false;
    render();
  }
}

async function readAddons() {
  state.addons = state.selection ? await api.addons(state.selection) : [];
}

async function setInstallations(found) {
  state.installations = found;
  const preferred = state.selection || localStorage.getItem('edition');
  state.selection = found.find(({ id }) => id === preferred)?.id || found[0]?.id || null;
  if (state.selection) localStorage.setItem('edition', state.selection);
  await readAddons();
}

function addFolder() {
  return run(async () => {
    const found = await api.addEdition();
    if (found) await setInstallations(found);
  });
}

edition.addEventListener('change', () => {
  const selected = edition.value;
  run(async () => {
    state.selection = selected;
    localStorage.setItem('edition', selected);
    state.addons = [];
    filter.value = '';
    await readAddons();
  });
});
filter.addEventListener('input', render);
$('#refresh').addEventListener('click', () => run(async () => setInstallations(await api.editions())));
$('#add-folder').addEventListener('click', addFolder);
$('#open-folder').addEventListener('click', () => run(() => api.openEdition(state.selection)));

run(async () => setInstallations(await api.editions()));
