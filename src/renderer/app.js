const $ = (selector) => document.querySelector(selector);
const api = window.ledger;
const edition = $('#edition');
const filter = $('#filter');
const state = {
  installations: [], addons: [], selection: null, busy: false, view: 'library', catalog: null, sourceSettings: {},
  updateResults: new Map(), checking: false, checkId: 0, project: null, catalogPending: false, libraryError: false,
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
    const { curseforgeKeySource, curseforgeKeySaved } = state.sourceSettings;
    $('#key-status').textContent = curseforgeKeySource === 'environment' ? 'Environment key'
      : curseforgeKeySource === 'saved' ? 'Saved key' : curseforgeKeySaved ? 'Saved key unavailable' : 'Key required';
    $('#save-key').disabled = state.busy;
    $('#clear-key').disabled = state.busy || !curseforgeKeySaved;
    return;
  }

  const results = $('#results');
  filter.disabled = !selected || state.libraryError;
  const query = filter.value.trim().toLowerCase();
  const group = $('#library-filter').value;
  const available = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && !addon.pinned);
  $('#library-filter').disabled = !selected || state.libraryError;
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
  $('#count').textContent = selected && !state.libraryError ? (query || group !== 'all' ? `${matched.length} of ${state.addons.length} addons`
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
  if (state.libraryError) {
    results.replaceChildren(empty('Could not read this library', 'Rescan the library to try again.'));
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
    const actions = el('div', null, 'row-actions');
    if (status?.status === 'available' && !addon.pinned) {
      const update = button('Update', () => changeAddon(addon, 'update'), true);
      update.disabled = state.busy;
      update.setAttribute('aria-label', `Update ${addon.title || addon.folder}`);
      actions.append(update);
    }
    const details = button('Details', () => showAddon(addon));
    details.disabled = state.busy;
    details.setAttribute('aria-label', `Details for ${addon.title || addon.folder}`);
    if (isOnline(addon)) details.setAttribute('data-project-link', addon.key);
    actions.append(details);
    const attention = addon.damaged || (!addon.pinned && status?.status === 'available');
    return [title, version, el('span', stateLabel, attention ? 'badge attention' : 'badge'), actions];
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
  if (!state.busy && state.view === 'library') render();
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
      if (!state.busy && state.view === 'library') render();
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
    if (action === 'update') {
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
    actions.push(action('Repair installed version', 'repair'));
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
  const { items, query, warnings, curseForgeSearch } = state.catalog || {};
  const results = $('#catalog-results');
  const status = $('#catalog-status');
  results.setAttribute('aria-busy', String(state.catalogPending));
  status.replaceChildren();
  if (state.catalogPending) status.append(el('p', 'Searching sources…'));
  if (items) {
    const count = `${items.length} ${items.length === 1 ? 'result' : 'results'}`;
    status.append(el('p', query ? `${count} for “${query}”` : `${count} for this client`));
    if (warnings.length) status.append(el('p', warnings.join('\n'), 'warning'));
  }
  $('#query').disabled = !client || state.busy;
  $('#source').disabled = !client || state.busy;
  $('#source').querySelector('[value=curseforge]').disabled = !state.sourceSettings.curseforge;
  $('#search-button').disabled = !client || state.busy;
  if (!client) {
    const choose = button('Choose WoW folder', addFolder, true);
    choose.disabled = state.busy;
    results.replaceChildren(empty('Choose a WoW installation', 'Choose the installation you want to manage.', choose));
    return;
  }
  results.replaceChildren();
  if (state.catalogPending) return;
  if (curseForgeSearch) {
    const external = button('Search CurseForge in browser ↗', () => run(() => api.openProject('curseforge', curseForgeSearch)));
    external.className = 'text-button catalog-external';
    external.disabled = state.busy;
    results.append(external);
  }
  if (!items?.length) {
    results.append(empty(
      items ? 'No matching addons' : 'Find an addon',
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

function catalogAction(item) {
  if (item.externalOnly) {
    const action = button('View Forever files ↗', () => run(() => api.openProject(item.source, item.website)), true);
    action.disabled = state.busy;
    return action;
  }
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
  open.setAttribute('data-project-link', `${item.source}:${item.id}`);
  title.append(open);
  const info = el('div', null, 'card-info');
  const author = [sourceNames[item.source], item.author].filter(Boolean).join(' · ');
  info.append(title, el('p', author, 'card-meta'));
  if (item.summary) info.append(el('p', item.summary, 'card-summary'));
  const footer = el('footer', null, 'card-actions');
  footer.append(catalogAction(item));
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
  choices.append(catalogAction(item));
  if (item.website && !item.externalOnly) {
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
  const returnView = state.view;
  $('#project-back').textContent = returnView === 'library' ? '← Back to My AddOns' : '← Back to Discover';
  state.project = { entry: item, detail: null, returnView, scroll: window.scrollY };
  state.view = 'project';
  window.scrollTo(0, 0);
  await run(async () => {
    state.project.detail = item.externalOnly ? item : await api.project(state.selection, item.source, item.id);
  });
  $('#project-back').focus();
}

async function readCatalog() {
  if (!state.selection) return;
  const query = $('#query').value.trim();
  state.catalog = null;
  state.catalogPending = true;
  render();
  try {
    state.catalog = { ...await api.search(state.selection, query, $('#source').value), query };
  } finally {
    state.catalogPending = false;
  }
}

async function showPage(view) {
  if (state.busy || view === state.view) return;
  const project = state.view === 'project' && view === state.project.returnView ? state.project : null;
  state.project = null;
  state.view = view;
  if (view === 'catalog' && !state.catalog) await run(readCatalog);
  else {
    notify();
    render();
  }
  window.scrollTo(0, project?.scroll || 0);
  if (project) {
    const key = `${project.entry.source}:${project.entry.id}`;
    const trigger = [...$(`#${view}`).querySelectorAll('[data-project-link]')]
      .find((button) => button.getAttribute('data-project-link') === key);
    (trigger || $(`#${view}-tab`)).focus({ preventScroll: true });
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
  try {
    state.addons = state.selection ? await api.addons(state.selection) : [];
    state.libraryError = false;
  } catch (error) {
    state.addons = [];
    state.libraryError = true;
    cancelCheck();
    throw error;
  }
}

async function selectInstallation(next) {
  cancelCheck();
  if (state.selection !== next) {
    state.addons = [];
    state.libraryError = false;
    filter.value = '';
    $('#library-filter').value = 'all';
    if (state.view === 'project') {
      state.view = state.project.returnView;
      state.project = null;
    }
  }
  state.selection = next;
  state.catalog = null;
  if (state.selection) localStorage.setItem('edition', state.selection);
  render();
  await readAddons();
  if (state.view === 'catalog') await readCatalog();
}

function setInstallations(found) {
  state.installations = found;
  const preferred = state.selection || localStorage.getItem('edition');
  return selectInstallation(found.find(({ id }) => id === preferred)?.id || found[0]?.id || null);
}

function addFolder() {
  return run(async () => {
    const found = await api.addEdition();
    if (found) await setInstallations(found);
  }).then(() => checkUpdates());
}

function saveCurseForgeKey(key) {
  return run(async () => {
    state.sourceSettings = await api.setCurseForgeKey(key);
    $('#api-key').value = '';
    if (!state.sourceSettings.curseforge) $('#source').value = 'all';
    state.catalog = null;
    cancelCheck();
    void checkUpdates();
    if (key) notify('CurseForge key saved.');
    else if (state.sourceSettings.curseforge) notify('Saved key cleared. CurseForge is using the environment key.');
    else notify('Saved CurseForge key cleared.');
  });
}

edition.addEventListener('change', () => {
  const selected = edition.value;
  return run(() => selectInstallation(selected)).then(() => checkUpdates());
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
  const key = $('#api-key').value.trim();
  if (key) return saveCurseForgeKey(key);
});
$('#clear-key').addEventListener('click', () => saveCurseForgeKey(''));

run(async () => {
  state.sourceSettings = await api.sources();
  await setInstallations(await api.editions());
}).then(() => checkUpdates());
