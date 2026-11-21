const $ = (selector) => document.querySelector(selector);
const api = window.ledger;
const edition = $('#edition');
const filter = $('#filter');
const state = {
  installations: [], addons: [], selection: null, busy: false, view: 'library', catalog: null, curseforge: false,
  updateResults: new Map(), checking: false, checkId: 0, project: null, catalogScroll: 0,
};
const sourceNames = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge', wowup: 'WowUp Hub', local: 'ZIP import' };
const pages = {
  library: ['My AddOns', 'Addons installed for the selected WoW client.'],
  catalog: ['Discover', 'Search for addons and check which releases support the selected WoW client.'],
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
  const inProject = state.view === 'project';
  for (const view of Object.keys(pages)) {
    const active = state.view === view;
    $(`#${view}`).hidden = !active;
    const tab = $(`#${view}-tab`);
    if (active || (inProject && view === state.project.returnView)) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const item = state.project?.detail || state.project?.entry;
  const [title, subtitle] = inProject
    ? [item.title, [sourceNames[item.source], item.author].filter(Boolean).join(' · ')]
    : pages[state.view];
  $('#project').hidden = !inProject;
  $('#project-back').hidden = !inProject;
  $('#project-back').disabled = state.busy;
  $('#page-title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#library-actions').hidden = state.view !== 'library';
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
  $('#import-zip').disabled = state.busy || !selected;
  $('#check-updates').disabled = state.busy || state.checking || !state.addons.some(isOnline);
  $('#check-updates').textContent = state.checking ? 'Checking…' : 'Check updates';
  const details = $('#client-details');
  details.textContent = selected ? (selected.version || selected.directory) : 'Select a game folder to begin';
  details.title = selected?.directory || '';

  if (state.view === 'project') return renderProject();
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
  const group = $('#library-filter').value;
  const available = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && !addon.pinned);
  $('#library-filter').disabled = !selected;
  $('#update-all').hidden = !available.length;
  $('#update-all').disabled = state.busy;
  $('#update-all').textContent = `Update all (${available.length})`;
  const matched = state.addons.filter((addon) => {
    if (group === 'updates' && updateFor(addon)?.status !== 'available') return false;
    if (group === 'pinned' && !addon.pinned) return false;
    if (group === 'local' && addon.source) return false;
    return [addon.title, addon.folder, addon.author, ...(addon.folders || [])]
      .some((value) => value?.toLowerCase().includes(query));
  });
  $('#count').textContent = selected ? (query || group !== 'all' ? `${matched.length} of ${state.addons.length} addons`
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
    const filtered = query || group !== 'all';
    results.replaceChildren(empty(
      state.busy ? 'Reading your addons…' : filtered ? 'No matching addons' : 'No addons found',
      filtered ? 'Change the search or status filter.' : 'Discover addons online or import a ZIP file.',
      !filtered && !state.busy ? button('Discover addons', () => showPage('catalog'), true) : undefined,
    ));
    return;
  }
  const rows = matched.map((addon) => {
    const title = el('strong', addon.title || addon.folder);
    title.append(el('small', addon.author || (addon.source ? sourceNames[addon.source] : addon.folder)));
    const status = updateFor(addon);
    const version = el('span', addon.version || '—');
    if (status?.status === 'available') version.append(el('small', status.version, 'warning'));
    const stateLabel = addon.damaged ? 'Missing files' : addon.pinned ? 'Pinned' : status?.status === 'available'
      ? 'Update available' : status?.status === 'current' ? 'Up to date' : status?.status === 'unavailable'
        ? 'Check failed' : addon.source ? 'Installed' : 'Manual';
    const action = status?.status === 'available' && !addon.pinned
      ? button('Update', () => changeAddon(addon, 'update'), true)
      : button('Details', () => showAddon(addon));
    action.disabled = state.busy;
    action.setAttribute('aria-label', `${action.textContent} ${addon.title || addon.folder}`);
    const actions = el('div', null, 'row-actions');
    actions.append(action);
    if (action.textContent === 'Update') {
      const more = button('⋯', () => showAddon(addon));
      more.disabled = state.busy;
      more.setAttribute('aria-label', `Details for ${addon.title || addon.folder}`);
      actions.append(more);
    }
    return [title, version, el('span', stateLabel, status?.status === 'available' && !addon.pinned ? 'badge' : ''), actions];
  });
  results.replaceChildren(table([['Addon', '37%'], ['Version', '22%'], ['Status', '20%'], ['Actions', '21%']], rows));
}

function isOnline(addon) {
  return addon.source && addon.source !== 'local';
}

function updateFor(addon) {
  const result = state.updateResults.get(addon.key);
  return result?.revision === addon.revision ? result : undefined;
}

async function checkUpdates(announce = false) {
  const client = state.selection;
  if (!client || !state.addons.some(isOnline)) return;
  const checkId = ++state.checkId;
  state.checking = true;
  if (announce) notify();
  if (!state.busy) render();
  try {
    const statuses = await api.updates(client);
    if (state.checkId !== checkId || state.selection !== client) return;
    state.updateResults = new Map(statuses.map((status) => [status.key, status]));
    if (announce) {
      const changed = statuses.filter(({ status }) => status === 'available').length;
      const failed = statuses.filter(({ status }) => status === 'unavailable').length;
      const message = changed ? `${changed} ${changed === 1 ? 'update is' : 'updates are'} available.`
        : failed ? 'Update check finished.' : 'Your catalog addons are up to date.';
      notify(failed ? `${message} Details are available for ${failed} failed ${failed === 1 ? 'check' : 'checks'}.` : message);
    }
  } catch (error) {
    if (announce && checkId === state.checkId) notify(error.message);
  } finally {
    if (checkId === state.checkId) {
      state.checking = false;
      if (!state.busy) render();
    }
  }
}

function cancelCheck() {
  state.checkId++;
  state.checking = false;
  state.updateResults.clear();
}

async function changeAddon(addon, action) {
  return run(async () => {
    await api.changeAddon(state.selection, addon.key, action);
    await readAddons();
    if (action === 'update' || action === 'repair') {
      const current = state.addons.find(({ key }) => key === addon.key);
      if (current) state.updateResults.set(addon.key, { revision: current.revision, status: 'current' });
    }
    const labels = { update: 'updated', repair: 'repaired', pin: 'pinned', unpin: 'unpinned', remove: 'removed' };
    notify(`${addon.title} ${labels[action]}.`);
  });
}

function confirmRemove(addon) {
  const dialog = $('#remove-dialog');
  dialog.returnValue = 'cancel';
  $('#remove-description').textContent = `Remove ${addon.title} and its ${addon.folders.length === 1 ? 'addon folder' : 'addon folders'} from this client? Its in-game settings stay in the WTF folder.`;
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'remove') changeAddon(addon, 'remove');
  }, { once: true });
  dialog.showModal();
}

function showAddon(addon) {
  const dialog = $('#addon-dialog');
  const update = updateFor(addon);
  $('#addon-dialog-title').textContent = addon.title || addon.folder;
  const details = [sourceNames[addon.source] || 'Manually installed', addon.version, addon.author].filter(Boolean);
  if (addon.notes) details.push(addon.notes);
  if (update?.reason) details.push(update.reason);
  if (addon.damaged) details.push('One or more managed addon folders are missing.');
  $('#addon-dialog-details').textContent = details.join(' · ');
  $('#addon-dialog-folders').replaceChildren(...(addon.folders || [addon.folder]).map((folder) => el('li', folder)));
  const action = (label, type, primary) => button(label, () => {
    dialog.close();
    changeAddon(addon, type);
  }, primary);
  const actions = [];
  if (isOnline(addon)) {
    actions.push(button('View project', () => {
      dialog.close();
      openProject({ ...addon, canInstall: false });
    }));
    if (update?.status === 'available' && !addon.pinned) actions.push(action('Update addon', 'update', true));
    if (update?.status !== 'available') actions.push(action('Repair', 'repair'));
    actions.push(action(addon.pinned ? 'Unpin' : 'Pin version', addon.pinned ? 'unpin' : 'pin'));
  }
  if (addon.key) {
    actions.push(button('Remove…', () => {
      dialog.close();
      confirmRemove(addon);
    }));
  }
  $('#addon-dialog-actions').replaceChildren(...actions);
  dialog.showModal();
}

function updateAll() {
  return run(async () => {
    const candidates = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && !addon.pinned);
    const failed = [];
    const completed = new Set();
    for (const addon of candidates) {
      try {
        await api.changeAddon(state.selection, addon.key, 'update');
        completed.add(addon.key);
      } catch (error) {
        failed.push(`${addon.title} · ${error.message}`);
      }
    }
    await readAddons();
    for (const addon of state.addons) {
      if (completed.has(addon.key)) state.updateResults.set(addon.key, { revision: addon.revision, status: 'current' });
    }
    notify([`Updated ${completed.size} of ${candidates.length} addons.`, ...failed].join('\n'));
  });
}

function renderCatalog(client) {
  const items = state.catalog?.items;
  const results = $('#catalog-results');
  const curseForgeSearch = state.catalog?.curseForgeSearch;
  $('#query').disabled = !client || state.busy;
  $('#source').disabled = !client || state.busy;
  $('#source').querySelector('[value=curseforge]').disabled = !state.curseforge;
  $('#search-button').disabled = !client || state.busy;
  if (!client) {
    results.replaceChildren(empty('Choose a WoW installation', 'Choose the installation you want to manage.',
      button('Choose WoW folder', addFolder, true)));
    return;
  }
  results.replaceChildren();
  if (curseForgeSearch) {
    const external = button('Search CurseForge in browser ↗', () => run(() => api.openProject('curseforge', curseForgeSearch)));
    external.className = 'text-button catalog-external';
    external.disabled = state.busy;
    results.append(external);
  }
  if (!items?.length) {
    results.append(empty(
      state.busy ? 'Loading catalog…' : items ? 'No matching addons' : 'Find an addon',
      items ? 'Try another name or change the source.' : 'Search by name or browse popular releases.',
    ));
    return;
  }
  const grid = el('div', null, 'catalog-grid');
  grid.append(...items.map(catalogCard));
  results.append(grid);
}

function media(source, url, { alt = '', cover = false, lazy = true } = {}) {
  const container = el('div', null, cover ? 'addon-media cover' : 'addon-media');
  const placeholder = el('span', '◈');
  placeholder.setAttribute('aria-hidden', 'true');
  container.append(placeholder);
  if (!url) return container;
  const image = el('img');
  image.alt = alt;
  image.loading = lazy ? 'lazy' : 'eager';
  image.decoding = 'async';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = `ledger-image://${source}/${encodeURIComponent(url)}`;
  container.append(image);
  return container;
}

function catalogInstall(item) {
  const installed = state.addons.some((addon) => addon.source === item.source && addon.id === item.id);
  const availability = item.isCompatible === false ? 'No compatible release' : 'Unavailable';
  const action = button(installed ? 'Installed' : item.canInstall ? 'Install' : availability, () => run(async () => {
    if (await api.install(state.selection, item.source, item.id)) {
      await readAddons();
      notify(`${item.title} installed.`);
    }
  }), true);
  action.disabled = installed || !item.canInstall || state.busy || !state.selection;
  action.setAttribute('aria-label', `${action.textContent} ${item.title}`);
  return action;
}

function catalogCard(item) {
  const card = el('article', null, 'addon-card');
  const title = el('h2');
  const open = button(item.title, () => openProject(item));
  open.className = 'card-title';
  open.disabled = state.busy;
  title.append(open);
  const info = el('div', null, 'card-info');
  const author = [sourceNames[item.source], item.author].filter(Boolean).join(' · ');
  info.append(title, el('p', author, 'card-meta'));
  if (item.summary) info.append(el('p', item.summary, 'card-summary'));
  const footer = el('footer', null, 'card-actions');
  footer.append(catalogInstall(item));
  card.append(media(item.source, item.image, { cover: item.source === 'wowinterface' }), info, footer);
  return card;
}

function renderProject() {
  const root = $('#project');
  const { entry, detail } = state.project;
  const item = detail || entry;
  const overview = el('article', null, 'panel project-overview');
  const release = el('div', null, 'project-release');
  const metadata = [];
  if (item.version) metadata.push(`Latest release: ${item.version}`);
  if (Number.isFinite(item.time)) {
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(item.time);
    metadata.push(`Updated ${date}`);
  }
  if (item.downloads) metadata.push(`${new Intl.NumberFormat().format(item.downloads)} downloads`);
  for (const line of metadata) release.append(el('p', line));
  const choices = el('div', null, 'actions');
  choices.append(catalogInstall(item));
  if (item.website) {
    const external = button(`Open on ${sourceNames[item.source]} ↗`, () => run(() => api.openProject(item.source, item.website)));
    external.disabled = state.busy;
    choices.append(external);
  }
  release.append(choices);
  overview.append(media(item.source, item.image, { cover: item.source === 'wowinterface', lazy: false }), release);

  const about = el('article', null, 'panel project-content');
  const description = item.description || item.summary
    || (state.busy && !detail ? 'Loading project details…' : 'This source has no description for the addon.');
  about.append(el('h2', 'About this addon'), el('p', description, 'project-copy'));
  if (item.versions?.length) {
    const versions = [...new Set(item.versions)].slice(0, 32);
    about.append(el('h3', 'Supported game versions'), el('p', versions.join(', ')));
  }
  root.replaceChildren(overview, about);

  if (item.screenshots?.length) {
    const gallery = el('article', null, 'panel project-content');
    gallery.append(el('h2', 'Screenshots'));
    const photos = el('div', null, 'screenshot-grid');
    for (const [index, url] of item.screenshots.entries()) {
      const name = `${item.title} screenshot ${index + 1}`;
      const preview = button(null, () => {
        $('#screenshot-title').textContent = name;
        $('#screenshot-view').replaceChildren(media(item.source, url, { alt: name, lazy: false }));
        $('#screenshot-dialog').showModal();
      });
      preview.className = 'screenshot-button';
      preview.setAttribute('aria-label', `Enlarge ${name}`);
      preview.append(media(item.source, url, { cover: true }));
      photos.append(preview);
    }
    gallery.append(photos);
    root.append(gallery);
  }

  if (item.changelog?.trim()) {
    const notes = el('details', null, 'panel project-content release-notes');
    notes.append(el('summary', 'Release notes'), el('p', item.changelog, 'project-copy'));
    root.append(notes);
  }
}

async function openProject(item) {
  if (state.busy) return;
  state.catalogScroll = window.scrollY;
  const returnView = state.view;
  $('#project-back').textContent = returnView === 'library' ? '← Back to My AddOns' : '← Back to Discover';
  state.project = { entry: item, detail: null, returnView };
  state.view = 'project';
  window.scrollTo(0, 0);
  await run(async () => { state.project.detail = await api.project(state.selection, item.source, item.id); });
  $('#project-back').focus();
}

async function readCatalog() {
  if (!state.selection) return;
  const response = await api.search(state.selection, $('#query').value, $('#source').value);
  state.catalog = response;
  if (response.warnings.length) notify(response.warnings.join('\n'));
}

async function showPage(view) {
  if (state.busy || view === state.view) return;
  const returning = state.view === 'project' && view === state.project.returnView;
  state.project = null;
  state.view = view;
  if (view === 'catalog' && !state.catalog) await run(readCatalog);
  else {
    notify();
    render();
  }
  window.scrollTo(0, returning ? state.catalogScroll : 0);
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
  const next = found.find(({ id }) => id === preferred)?.id || found[0]?.id || null;
  if (state.selection !== next) {
    cancelCheck();
    state.addons = [];
    if (state.view === 'project') {
      state.view = 'catalog';
      state.project = null;
    }
  }
  state.selection = next;
  state.catalog = null;
  if (state.selection) localStorage.setItem('edition', state.selection);
  await readAddons();
  if (state.view === 'catalog') await readCatalog();
}

function addFolder() {
  return run(async () => {
    const found = await api.addEdition();
    if (found) await setInstallations(found);
  }).then(() => checkUpdates());
}

edition.addEventListener('change', () => {
  const selected = edition.value;
  run(async () => {
    cancelCheck();
    state.selection = selected;
    localStorage.setItem('edition', selected);
    state.addons = [];
    filter.value = '';
    state.catalog = null;
    if (state.view === 'project') {
      state.view = 'catalog';
      state.project = null;
    }
    await readAddons();
    if (state.view === 'catalog') await readCatalog();
  }).then(() => checkUpdates());
});
filter.addEventListener('input', render);
$('#refresh').addEventListener('click', () => run(async () => setInstallations(await api.editions())).then(() => checkUpdates()));
$('#library-filter').addEventListener('change', render);
$('#check-updates').addEventListener('click', () => checkUpdates(true));
$('#update-all').addEventListener('click', updateAll);
$('#dialog-close').addEventListener('click', () => $('#addon-dialog').close());
$('#screenshot-close').addEventListener('click', () => $('#screenshot-dialog').close());
$('#project-back').addEventListener('click', () => showPage(state.project.returnView));
$('#import-zip').addEventListener('click', () => run(async () => {
  if (await api.importZip(state.selection)) {
    await readAddons();
    notify('Addon ZIP imported.');
  }
}));
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
}).then(() => checkUpdates());
