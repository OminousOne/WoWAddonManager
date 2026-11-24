const builderStorageKey = 'custom-addon-builder';
const builderNames = { claude: 'Claude', codex: 'Codex' };
const builderState = {
  draft: null, keys: new Set(), accounts: new Set(), operation: null,
};

function builderClient() {
  return state.installations.find(({ id }) => id === state.selection);
}

function builderStatus(selector, message) {
  $(selector).textContent = message;
}

function readBuilderForm() {
  return {
    title: $('#builder-title').value,
    request: $('#builder-request').value,
    lua: $('#builder-lua').value,
  };
}

function persistBuilder() {
  const { title, request, lua } = readBuilderForm();
  try {
    localStorage.setItem(builderStorageKey, JSON.stringify({
      title, request,
      draft: builderState.draft && { ...builderState.draft, lua },
      provider: $('#builder-provider').value,
      auth: $('#builder-auth').value,
    }));
  } catch {
    builderStatus('#builder-status', 'Ledger could not save this draft locally. Export a ZIP to keep a copy.');
  }
}

function restoreBuilder() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(builderStorageKey)); }
  catch { return; }
  if (!saved) return;
  $('#builder-title').value = saved.title || '';
  $('#builder-request').value = saved.request || '';
  if (Object.hasOwn(builderNames, saved.provider)) $('#builder-provider').value = saved.provider;
  if (saved.auth === 'key') $('#builder-auth').value = 'key';
  if (saved.draft?.id && saved.draft.target) {
    builderState.draft = saved.draft;
    $('#builder-lua').value = saved.draft.lua || '';
  }
}

function renderBuilder(client = builderClient()) {
  const { draft, operation } = builderState;
  const provider = $('#builder-provider').value;
  const withKey = $('#builder-auth').value === 'key';
  const busy = Boolean(operation) || state.busy;
  const available = withKey ? builderState.keys.has(provider) : builderState.accounts.has(provider);
  const compatible = Boolean(draft && client?.edition === draft.target.edition
    && client.version?.split('.').slice(0, 3).join('.') === draft.target.version.split('.').slice(0, 3).join('.'));

  $('#builder-account-row').hidden = withKey;
  $('#builder-key-form').hidden = !withKey;
  $('#builder-clear-key').disabled = busy || !available;
  $('#builder-connect').textContent = provider === 'claude' ? 'Check Claude Code login' : available ? 'Check connection' : 'Connect account';
  $('#builder-account-hint').textContent = provider === 'claude' ? 'Sign in in Terminal with claude auth login.' : 'Sign in with your ChatGPT account in the browser.';
  $('#builder-connection').textContent = withKey
    ? (available ? 'API key saved' : 'Save an API key to generate with ' + builderNames[provider] + '.')
    : (available ? 'Account connected' : '');
  $('#builder-client').textContent = client?.version ? `Target: ${client.label} ${client.version}`
    : client ? 'Ledger could not detect this client’s version. Rescan a fully installed client.'
      : 'Add a World of Warcraft installation to choose a target version.';
  $('#builder-output').hidden = !draft;
  $('#builder-output').setAttribute('aria-busy', String(operation === 'generate'));
  $('#builder-summary').textContent = draft?.summary || '';
  $('#builder-target').textContent = draft ? `${draft.target.label} ${draft.target.version}` : '';
  $('#builder-generate').textContent = operation === 'generate' ? 'Generating…' : draft ? 'Generate revision' : 'Generate draft';
  setPending($('#builder-generate'), operation === 'generate');
  setPending($('#builder-connect'), operation === 'connect');
  setPending($('#builder-export'), operation === 'export');
  $('#builder-stop').hidden = !['generate', 'connect'].includes(operation);
  $('#builder-install').disabled = busy || !compatible || !$('#builder-lua').value.trim();
  $('#builder-install').title = compatible ? '' : 'Select a matching WoW client or generate a revision for the selected client.';
  $('#builder-export').disabled = busy || !$('#builder-lua').value.trim();
  $('#builder-generate').disabled = busy || !available || !client?.version;
  for (const id of ['provider', 'auth', 'connect', 'key', 'save-key', 'title', 'request', 'lua', 'new']) {
    $(`#builder-${id}`).disabled = busy;
  }
}

async function runBuilder(operation, status, task) {
  if (builderState.operation || state.busy) return;
  builderState.operation = operation;
  builderStatus(status, '');
  renderBuilder();
  try { await task(); }
  catch (error) { builderStatus(status, error.message); }
  finally {
    builderState.operation = null;
    renderBuilder();
  }
}

function draftPayload() {
  const { id, target } = builderState.draft;
  const { title, lua } = readBuilderForm();
  return { id, title, lua, edition: target.edition, interface: target.interface };
}

for (const field of ['provider', 'auth']) {
  $(`#builder-${field}`).addEventListener('change', () => {
    $('#builder-key').value = '';
    builderStatus('#builder-status', '');
    persistBuilder();
    renderBuilder();
  });
}

for (const field of ['title', 'request', 'lua']) {
  $(`#builder-${field}`).addEventListener('input', () => {
    persistBuilder();
    if (field === 'lua') renderBuilder();
  });
}

$('#builder-connect').addEventListener('click', () => runBuilder('connect', '#builder-status', async () => {
  const provider = $('#builder-provider').value;
  builderState.accounts.delete(provider);
  builderStatus('#builder-status', provider === 'codex' ? 'Checking your connection or opening sign-in…' : 'Checking Claude Code login…');
  if (await api.builderAccount(provider)) builderState.accounts.add(provider);
  builderStatus('#builder-status', '');
}));

function saveBuilderKey(value) {
  return runBuilder('key', '#builder-status', async () => {
    const provider = $('#builder-provider').value;
    if (await api.builderKey(provider, value)) builderState.keys.add(provider);
    else builderState.keys.delete(provider);
    $('#builder-key').value = '';
  });
}

$('#builder-key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('#builder-key').value.trim();
  if (key) saveBuilderKey(key);
});
$('#builder-clear-key').addEventListener('click', () => saveBuilderKey(''));
$('#builder-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runBuilder('generate', '#builder-status', async () => {
    builderStatus('#builder-status', 'Waiting for ' + builderNames[$('#builder-provider').value] + '…');
    const result = await api.builderGenerate(state.selection, $('#builder-provider').value, $('#builder-auth').value, readBuilderForm());
    const id = builderState.draft?.id || crypto.randomUUID();
    builderState.draft = { id, target: result.target, summary: result.summary };
    $('#builder-lua').value = result.lua;
    $('#builder-request').value = '';
    builderStatus('#builder-status', 'Draft ready for review.');
    builderStatus('#builder-output-status', '');
    persistBuilder();
  });
});
$('#builder-stop').addEventListener('click', () => api.builderStop().catch((error) => builderStatus('#builder-status', error.message)));
$('#builder-new').addEventListener('click', () => {
  if ($('#builder-title').value || $('#builder-request').value || builderState.draft) {
    if (!window.confirm('Start a new draft? This clears the current draft from the builder.')) return;
  }
  builderState.draft = null;
  $('#builder-form').reset();
  $('#builder-lua').value = '';
  builderStatus('#builder-status', '');
  builderStatus('#builder-output-status', '');
  persistBuilder();
  renderBuilder();
});
$('#builder-export').addEventListener('click', () => runBuilder('export', '#builder-output-status', async () => {
  if (await api.builderExport(draftPayload())) builderStatus('#builder-output-status', 'Addon ZIP exported.');
}));
$('#builder-install').addEventListener('click', () => {
  const client = builderClient();
  run(async () => {
    builderStatus('#builder-output-status', '');
    if (await api.builderInstall(client.id, draftPayload())) {
      builderStatus('#builder-output-status', `Installed for ${client.label}. Open My AddOns to see it.`);
      await readAddons();
    }
  }, $('#builder-install'));
});

restoreBuilder();
api.builderKeys().then((keys) => {
  builderState.keys = new Set(keys);
  renderBuilder();
}).catch((error) => builderStatus('#builder-status', error.message));
