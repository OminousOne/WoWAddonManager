const $ = (selector) => document.querySelector(selector);
const api = window.ledger;
const edition = $('#edition');
const filter = $('#filter');
const state = {
  installations: [], addons: [], selection: null, busy: false, view: 'library', catalog: null, curseforge: false,
};
const sourceNames = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge' };
const pages = {
  library: ['My AddOns', 'Addons installed for the selected WoW client.'],
  catalog: ['Discover', 'Find compatible addons for the selected WoW client.'],
  sources: ['Sources', 'Manage the catalogs available in Discover.'],
};

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
  for (const [view, labels] of Object.entries(pages)) {
    const active = state.view === view;
    $(`#${view}`).hidden = !active;
    if (active) {
      $(`#${view}-tab`).setAttribute('aria-current', 'page');
      $('#page-title').textContent = labels[0];
      $('#subtitle').textContent = labels[1];
    } else $(`#${view}-tab`).removeAttribute('aria-current');
  }
  $('#refresh').hidden = state.view !== 'library';
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

  if (state.view === 'catalog') return renderCatalog(selected);
  if (state.view === 'sources') {
    $('#key-status').textContent = state.curseforge ? 'Enabled' : 'Key required';
    $('#save-key').disabled = state.busy;
    $('#clear-key').disabled = state.busy || !state.curseforge;
    return;
  }

  const results = $('#results');
  filter.disabled = !selected;
  const query = filter.value.trim().toLowerCase();
  const matched = state.addons.filter((addon) => [addon.title, addon.folder, addon.author]
    .some((value) => value?.toLowerCase().includes(query)));
  $('#count').textContent = selected ? (query ? `${matched.length} of ${state.addons.length} addons`
    : `${state.addons.length} ${state.addons.length === 1 ? 'addon' : 'addons'}`) : '';
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
    title.append(el('small', addon.source ? sourceNames[addon.source] : addon.folder));
    if (addon.damaged) title.append(el('small', 'Missing files', 'warning'));
    return [title, addon.author || '—', addon.version || '—'];
  });
  results.replaceChildren(table([['Addon', '52%'], ['Author', '28%'], ['Version', '20%']], rows));
}

function renderCatalog(client) {
  const items = state.catalog?.items;
  const results = $('#catalog-results');
  $('#query').disabled = !client || state.busy;
  $('#source').disabled = !client || state.busy;
  $('#source').querySelector('[value=curseforge]').disabled = !state.curseforge;
  $('#search-button').disabled = !client || state.busy;
  if (!client) {
    results.replaceChildren(empty('Choose a WoW installation', 'Search uses your selected installation to find compatible addons.',
      button('Choose WoW folder', addFolder, true)));
    return;
  }
  if (!items?.length) {
    results.replaceChildren(empty(
      state.busy ? 'Loading catalog…' : items ? 'No matching addons' : 'Find an addon',
      items ? 'Try another name or change the source.' : 'Search by name or browse popular releases.',
    ));
    return;
  }
  const rows = items.map((item) => {
    const title = el('strong', item.title);
    title.append(el('small', item.author || sourceNames[item.source]));
    if (item.summary) title.append(el('small', item.summary, 'summary'));
    const installed = state.addons.some((addon) => addon.source === item.source && addon.id === item.id);
    const install = button(installed ? 'Installed' : item.canInstall ? 'Install' : 'Unavailable', () => run(async () => {
      await api.install(state.selection, item.source, item.id);
      await readAddons();
      notify(`${item.title} installed.`);
    }));
    install.disabled = installed || !item.canInstall || state.busy;
    install.setAttribute('aria-label', `${install.textContent} ${item.title}`);
    return [title, sourceNames[item.source], install];
  });
  results.replaceChildren(table([['Addon', '64%'], ['Source', '18%'], ['Action', '18%']], rows));
}

async function readCatalog() {
  if (!state.selection) return;
  const response = await api.search(state.selection, $('#query').value, $('#source').value);
  state.catalog = response;
  if (response.warnings.length) notify(response.warnings.join('\n'));
}

async function showPage(view) {
  if (state.busy || view === state.view) return;
  state.view = view;
  if (view === 'catalog' && !state.catalog) await run(readCatalog);
  else {
    notify();
    render();
  }
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
  state.catalog = null;
  if (state.view === 'catalog') await readCatalog();
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
    state.catalog = null;
    await readAddons();
    if (state.view === 'catalog') await readCatalog();
  });
});
filter.addEventListener('input', render);
$('#refresh').addEventListener('click', () => run(async () => setInstallations(await api.editions())));
$('#add-folder').addEventListener('click', addFolder);
$('#open-folder').addEventListener('click', () => run(() => api.openEdition(state.selection)));

for (const view of Object.keys(pages)) $(`#${view}-tab`).addEventListener('click', () => showPage(view));
$('#catalog-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(readCatalog);
});
$('#source').addEventListener('change', () => run(readCatalog));
$('#source-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!$('#api-key').value.trim()) return;
  run(async () => {
    ({ curseforge: state.curseforge } = await api.setCurseForgeKey($('#api-key').value));
    $('#api-key').value = '';
    state.catalog = null;
    notify('CurseForge key saved.');
  });
});
$('#clear-key').addEventListener('click', () => run(async () => {
  ({ curseforge: state.curseforge } = await api.setCurseForgeKey(''));
  $('#api-key').value = '';
  $('#source').value = 'all';
  state.catalog = null;
  notify('Saved CurseForge key cleared.');
}));

run(async () => {
  ({ curseforge: state.curseforge } = await api.sources());
  await setInstallations(await api.editions());
});
