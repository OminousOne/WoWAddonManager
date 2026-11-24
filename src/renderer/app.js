const $ = (selector) => document.querySelector(selector);
const api = window.ledger;
const edition = $('#edition');
const filter = $('#filter');
const pageIntro = $('.page-intro');
const motionPreference = window.matchMedia?.('(prefers-reduced-motion: no-preference)');
const state = {
  installations: [], addons: [], selection: null, busy: false, view: 'library', catalog: null, sourceSettings: {},
  updateResults: new Map(), checking: false, checkId: 0, project: null, libraryLoading: false, libraryError: false,
};
const sourceNames = { wowinterface: 'WoWInterface', tukui: 'Tukui', curseforge: 'CurseForge', wowup: 'WowUp Hub', local: 'ZIP import' };
const pages = {
  library: ['My AddOns', 'Addons installed for the selected WoW client.'],
  catalog: ['Discover', 'Search for addons and check which releases support the selected WoW client.'],
  builder: ['Build an AddOn', 'Draft, review, and install a custom WoW addon with Codex or Claude.'],
  sources: ['Sources', 'Manage the catalogs available in Discover.'],
};
let renderedView;
let revealedCatalog;
let revealedProject;
let pageIntroAnimation;

motionPreference?.addEventListener('change', ({ matches }) => {
  if (!matches) pageIntroAnimation?.cancel();
});

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

function notify(message = '', tone = '') {
  const notice = $('#notice');
  notice.className = tone ? `notice ${tone}` : 'notice';
  notice.textContent = message;
}

function setPending(control, pending) {
  if (pending) control?.setAttribute('data-pending', '');
  else control?.removeAttribute('data-pending');
}

function animatePageIntro() {
  if (!motionPreference?.matches) return;
  pageIntroAnimation?.cancel();
  pageIntroAnimation = pageIntro.animate(
    [{ opacity: .45, translate: state.view === 'project' ? '8px 0' : '0 5px' }, { opacity: 1, translate: '0' }],
    { duration: 210, easing: 'cubic-bezier(.2, .75, .25, 1)' },
  );
}

function empty(title, description, action) {
  const box = el('div', null, 'empty');
  const mark = el('span', null, 'empty-mark');
  mark.setAttribute('aria-hidden', 'true');
  box.append(mark, el('h2', title), el('p', description));
  if (action) box.append(action);
  return box;
}

function libraryTable(rows) {
  const result = el('table', null, 'library-table');
  result.setAttribute('role', 'table');
  result.setAttribute('aria-label', 'Installed addons');
  const tableHead = result.createTHead();
  tableHead.setAttribute('role', 'rowgroup');
  const head = tableHead.insertRow();
  head.setAttribute('role', 'row');
  for (const label of ['Addon', 'Version', 'Status', 'Actions']) {
    const cell = el('th', label);
    cell.scope = 'col';
    cell.setAttribute('role', 'columnheader');
    head.append(cell);
  }
  const body = result.createTBody();
  body.setAttribute('role', 'rowgroup');
  for (const cells of rows) {
    const row = body.insertRow();
    row.setAttribute('role', 'row');
    for (const value of cells) {
      const cell = row.insertCell();
      cell.setAttribute('role', 'cell');
      cell.append(value);
    }
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
  $('#check-updates').disabled = state.busy || !state.addons.some(isOnline);
  $('#check-updates').setAttribute('aria-disabled', String(state.checking));
  $('#check-updates').textContent = state.checking ? 'Checking…' : 'Check updates';
  setPending($('#check-updates'), state.checking);
  const details = $('#client-details');
  details.textContent = selected ? (selected.version ? `Build ${selected.version}` : 'Game version unavailable') : 'Select a game folder to begin';
  details.title = selected?.directory || '';

  if (state.view === 'project') return renderProject();
  if (state.view === 'catalog') return renderCatalog(selected);
  if (state.view === 'builder') return renderBuilder(selected);
  if (state.view === 'sources') {
    const { curseforge, curseforgeKeySource, curseforgeKeySaved } = state.sourceSettings;
    const keyStatus = $('#key-status');
    keyStatus.textContent = curseforgeKeySource === 'environment' ? 'Environment key'
      : curseforgeKeySource === 'saved' ? 'Saved key' : curseforgeKeySaved ? 'Saved key unavailable' : 'Key required';
    keyStatus.className = curseforge ? 'badge enabled' : 'badge attention';
    $('#save-key').disabled = state.busy;
    $('#clear-key').disabled = state.busy || !curseforgeKeySaved;
    return;
  }

  const results = $('#results');
  filter.disabled = !selected || state.libraryLoading || state.libraryError;
  const query = filter.value.trim().toLowerCase();
  const group = $('#library-filter').value;
  const available = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && !addon.pinned);
  $('#library-filter').disabled = filter.disabled;
  $('#update-all').hidden = !available.length;
  $('#update-all').disabled = state.busy;
  $('#update-all').textContent = `Update all (${available.length})`;
  const matched = state.addons.filter((addon) => {
    if (group === 'updates' && (addon.pinned || updateFor(addon)?.status !== 'available')) return false;
    if (group === 'pinned' && !addon.pinned) return false;
    if (group === 'local' && addon.source) return false;
    return [addon.title, addon.folder, addon.author, ...(addon.folders || [])]
      .some((value) => value?.toLowerCase().includes(query));
  });
  let count = '';
  if (state.libraryLoading) count = 'Reading library…';
  else if (!filter.disabled) {
    count = query || group !== 'all' ? `${matched.length} of ${state.addons.length} addons`
      : `${state.addons.length} ${state.addons.length === 1 ? 'addon' : 'addons'}`;
  }
  $('#count').textContent = count;
  results.setAttribute('data-results', matched.length ? 'table' : 'empty');
  results.setAttribute('data-loading', String(state.libraryLoading || (!selected && state.busy)));
  results.setAttribute('aria-busy', String(state.libraryLoading));
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
  if (state.libraryLoading && !state.addons.length) {
    results.replaceChildren(empty('Reading your addons…', 'Scanning the selected client’s addon folders.'));
    return;
  }
  if (!matched.length) {
    const filtered = Boolean(query || group !== 'all');
    const recovery = filtered ? button('Clear filters', () => {
      filter.value = '';
      $('#library-filter').value = 'all';
      render();
      filter.focus();
    }) : button('Discover addons', () => showPage('catalog'), true);
    recovery.disabled = state.busy;
    results.replaceChildren(empty(
      filtered ? 'No matching addons' : 'No addons installed',
      filtered ? 'Change the search or status filter.' : 'Discover addons online or import a ZIP file.',
      recovery,
    ));
    return;
  }
  const rows = matched.map((addon) => {
    const name = addon.title || addon.folder;
    const title = el('strong', name);
    const byline = [addon.author, addon.custom ? 'Custom addon' : sourceNames[addon.source]].filter(Boolean);
    if (!byline.length && addon.folder !== name) byline.push(addon.folder);
    if (byline.length) title.append(el('small', byline.join(' · ')));
    const status = updateFor(addon);
    const version = el('span');
    const versionLabel = el('span', 'Version ', 'compact-label');
    versionLabel.setAttribute('aria-hidden', 'true');
    version.append(versionLabel, el('span', addon.version || '—'));
    if (status?.status === 'available' && status.version && !addon.pinned) {
      const nextVersion = el('small', `→ ${status.version}`, 'next-version');
      nextVersion.setAttribute('aria-label', `Available version ${status.version}`);
      version.append(nextVersion);
    }
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
    const attention = addon.damaged || (!addon.pinned && ['available', 'unavailable'].includes(status?.status));
    const badge = attention ? 'badge attention' : stateLabel === 'Up to date' ? 'badge enabled' : 'badge';
    return [title, version, el('span', stateLabel, badge), actions];
  });
  results.replaceChildren(libraryTable(rows));
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
  if (state.busy || state.checking || !client || !state.addons.some(isOnline)) return;
  const checkId = ++state.checkId;
  state.checking = true;
  if (announce) notify();
  if (!state.busy && state.view === 'library') render();
  try {
    const statuses = await api.updates(client);
    if (state.checkId !== checkId || state.selection !== client) return;
    state.updateResults = new Map(statuses.map((status) => [status.key, status]));
    if (announce && !state.busy && state.view === 'library') {
      const changed = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && !addon.pinned).length;
      const pinned = state.addons.filter((addon) => updateFor(addon)?.status === 'available' && addon.pinned).length;
      const failed = state.addons.filter((addon) => updateFor(addon)?.status === 'unavailable').length;
      const message = changed ? `${changed} ${changed === 1 ? 'update is' : 'updates are'} available.`
        : (failed || pinned) ? 'Update check finished.' : 'Your catalog addons are up to date.';
      const pinnedNote = pinned ? `${pinned} ${pinned === 1 ? 'pinned addon has' : 'pinned addons have'} newer releases.` : '';
      const failedNote = failed ? `Details are available for ${failed} failed ${failed === 1 ? 'check' : 'checks'}.` : '';
      notify([message, pinnedNote, failedNote].filter(Boolean).join(' '), failed ? 'error' : 'success');
    }
  } catch (error) {
    if (announce && checkId === state.checkId && !state.busy && state.view === 'library') notify(error.message, 'error');
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
    notify(`${addon.title} ${labels[action]}.`, 'success');
  }, { progress: { update: 'Updating addon…', repair: 'Repairing addon…', remove: 'Removing addon…' }[action] });
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
  const details = [addon.custom ? 'Custom addon' : sourceNames[addon.source] || 'Manually installed', addon.version, addon.author].filter(Boolean);
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
    for (const [index, addon] of candidates.entries()) {
      notify(`Updating ${index + 1} of ${candidates.length} · ${addon.title}`, 'pending');
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
    notify([`Updated ${completed.size} of ${candidates.length} addons.`, ...failed].join('\n'), failed.length ? 'error' : 'success');
  }, { trigger: $('#update-all') });
}

function renderCatalog(client) {
  const { items, query, warnings, curseForgeSearch, pending, error } = state.catalog || {};
  const reveal = items && items !== revealedCatalog;
  revealedCatalog = items;
  const results = $('#catalog-results');
  const status = $('#catalog-status');
  results.setAttribute('aria-busy', String(Boolean(pending)));
  setPending($('#search-button'), pending);
  status.replaceChildren();
  if (pending) status.append(el('p', 'Searching sources…'));
  if (error) status.append(el('p', error, 'warning'));
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
  if (pending) return;
  if (error) {
    results.append(empty('Could not search sources', 'Try the search again.', button('Retry search', readCatalog, true)));
    return;
  }
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
  if (reveal) grid.setAttribute('data-reveal', '');
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
  image.addEventListener('load', () => image.setAttribute('data-loaded', ''), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = `ledger-image://${source}/${encodeURIComponent(url)}`;
  if (image.complete && image.naturalWidth) image.setAttribute('data-loaded', '');
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
      notify(`${item.title} installed.`, 'success');
    }
  }, { progress: `Installing ${item.title}…` }), !installed && item.canInstall);
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
  const { entry, detail, pending, error } = state.project;
  const reveal = detail && detail !== revealedProject;
  revealedProject = detail;
  const item = detail || entry;
  const overview = el('article', null, 'panel project-overview');
  overview.setAttribute('aria-busy', String(Boolean(pending)));
  const release = el('div', null, 'project-release');
  const metadata = [];
  if (item.version) metadata.push(`Latest release: ${item.version}`);
  if (typeof item.time === 'number' && Math.abs(item.time) <= 8.64e15) {
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
  if (reveal) about.setAttribute('data-reveal', '');
  about.append(el('h2', 'About this addon'));
  if (pending || error) {
    const status = el('p', pending ? 'Loading project details…' : error, pending ? 'loading-status' : 'warning');
    status.setAttribute('role', 'status');
    about.append(status);
    if (error) {
      const actions = el('div', null, 'actions');
      actions.append(button('Retry details', () => readProject(state.project)));
      about.append(actions);
    }
  }
  const description = item.description || item.summary;
  if (description || detail) {
    about.append(el('p', description || 'This source has no description for the addon.', 'project-copy'));
  }
  if (item.versions?.length) {
    const versions = [...new Set(item.versions)].slice(0, 32);
    about.append(el('h3', 'Supported game versions'), el('p', versions.join(', ')));
  }
  root.replaceChildren(overview, about);

  if (item.screenshots?.length) {
    const gallery = el('article', null, 'panel project-content');
    if (reveal) gallery.setAttribute('data-reveal', '');
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
    if (reveal) notes.setAttribute('data-reveal', '');
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
  const loading = readProject(state.project);
  window.scrollTo(0, 0);
  $('#project-back').focus({ preventScroll: true });
  return loading;
}

async function readProject(project) {
  if (state.busy) return;
  const { entry } = project;
  project.pending = !entry.externalOnly;
  project.error = '';
  if (entry.externalOnly) project.detail = entry;
  notify();
  render();
  if (entry.externalOnly) return;
  try {
    project.detail = await api.project(state.selection, entry.source, entry.id);
  } catch (error) {
    project.error = error.message;
  } finally {
    project.pending = false;
    if (state.project === project) render();
  }
}

async function readCatalog() {
  const client = state.installations.find(({ id }) => id === state.selection);
  if (!client) return;
  const query = $('#query').value.trim();
  const source = $('#source').value;
  if (state.catalog?.pending && state.catalog.query === query && state.catalog.source === source) return;
  const search = { query, source, pending: true };
  state.catalog = search;
  if (state.view === 'catalog') renderCatalog(client);
  try {
    Object.assign(search, await api.search(client.id, query, source));
  } catch (error) {
    search.error = error.message;
  } finally {
    search.pending = false;
    if (state.catalog === search && state.view === 'catalog') renderCatalog(client);
  }
}

async function showPage(view) {
  if (view === state.view) return;
  const project = state.view === 'project' && view === state.project.returnView ? state.project : null;
  state.project = null;
  state.view = view;
  if (!state.busy) notify();
  render();
  window.scrollTo(0, project?.scroll || 0);
  if (project) {
    const key = `${project.entry.source}:${project.entry.id}`;
    const trigger = [...$(`#${view}`).querySelectorAll('[data-project-link]')]
      .find((button) => button.getAttribute('data-project-link') === key);
    (trigger || $(`#${view}-tab`)).focus({ preventScroll: true });
  } else {
    $(`#${view}-tab`).focus({ preventScroll: true });
  }
  if (view === 'catalog' && !state.catalog) await readCatalog();
}

async function run(operation, { progress, trigger } = {}) {
  if (state.busy) return;
  state.busy = true;
  setPending(trigger, true);
  notify(progress, progress ? 'pending' : '');
  render();
  try {
    await operation();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    state.busy = false;
    setPending(trigger, false);
    if ($('#notice').className === 'notice pending') notify();
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
  state.libraryLoading = Boolean(next);
  render();
  if (state.view === 'catalog') void readCatalog();
  try {
    await readAddons();
  } finally {
    state.libraryLoading = false;
  }
}

function setInstallations(found, preferred = state.selection || localStorage.getItem('edition')) {
  state.installations = found;
  return selectInstallation(found.find(({ id }) => id === preferred)?.id || found[0]?.id || null);
}

function addFolder() {
  return run(async () => {
    const found = await api.addEdition();
    if (found) await setInstallations(found.installations, found.selected);
  }).then(() => checkUpdates());
}

function saveCurseForgeKey(key) {
  return run(async () => {
    state.sourceSettings = await api.setCurseForgeKey(key);
    $('#api-key').value = '';
    if (!state.sourceSettings.curseforge) $('#source').value = 'all';
    state.catalog = null;
    cancelCheck();
    if (state.view === 'catalog') void readCatalog();
    if (key) notify('CurseForge key saved.', 'success');
    else if (state.sourceSettings.curseforge) notify('Saved key cleared. CurseForge is using the environment key.', 'success');
    else notify('Saved CurseForge key cleared.', 'success');
  }, { trigger: key ? $('#save-key') : $('#clear-key') }).then(() => checkUpdates());
}

edition.addEventListener('change', () => {
  const selected = edition.value;
  return run(() => selectInstallation(selected)).then(() => checkUpdates());
});
filter.addEventListener('input', render);
$('#refresh').addEventListener('click', () => run(
  async () => setInstallations(await api.editions()), { trigger: $('#refresh') },
).then(() => checkUpdates()));
$('#library-filter').addEventListener('change', render);
$('#check-updates').addEventListener('click', () => checkUpdates(true));
$('#update-all').addEventListener('click', updateAll);
$('#dialog-close').addEventListener('click', () => $('#addon-dialog').close());
$('#screenshot-close').addEventListener('click', () => $('#screenshot-dialog').close());
$('#project-back').addEventListener('click', () => showPage(state.project.returnView));
$('#import-zip').addEventListener('click', () => run(async () => {
  if (await api.importZip(state.selection)) {
    await readAddons();
    notify('Addon ZIP imported.', 'success');
  }
}, { trigger: $('#import-zip') }));
$('#add-folder').addEventListener('click', addFolder);
$('#open-folder').addEventListener('click', () => run(() => api.openEdition(state.selection)));

for (const view of Object.keys(pages)) $(`#${view}-tab`).addEventListener('click', () => showPage(view));
$('#catalog-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.busy) return readCatalog();
});
$('#source').addEventListener('change', () => { if (!state.busy) return readCatalog(); });
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
