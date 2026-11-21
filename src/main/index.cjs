const { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { openStore } = require('./store.cjs');
const { defaultRoots, discoverInstallations } = require('./wow.cjs');
const { catalogImage, newCatalog, projectPage, sources } = require('./sources.cjs');
const { createLibrary } = require('./library.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'ledger-image', privileges: { standard: true, secure: true } }]);

const page = path.join(__dirname, '../renderer/index.html');
const pageUrl = pathToFileURL(page).href;
let store;
let catalog = newCatalog();

function setCatalog(key) {
  catalog = newCatalog(key || process.env.CURSEFORGE_API_KEY?.trim());
}

function findInstallations() {
  return discoverInstallations([...store.read().roots, ...defaultRoots()]);
}

async function requireInstallation(id) {
  const installation = (await findInstallations()).find((edition) => edition.id === id);
  if (!installation) throw new Error('This WoW installation is unavailable. Scan again or select its folder.');
  return installation;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) {
      throw new Error('This action is only available in AddOn Ledger.');
    }
    try {
      return { value: await callback(event, ...args) };
    } catch (error) {
      return { error: error.code ? 'The operation could not access its files or network connection.' : error.message };
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'AddOn Ledger',
    width: 1180,
    height: 780,
    minWidth: 790,
    minHeight: 560,
    backgroundColor: '#0a101b',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  window.loadFile(page);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    store = await openStore(app.getPath('userData'));
    const library = createLibrary(store);
    protocol.handle('ledger-image', async (request) => {
      try {
        const address = new URL(request.url);
        if (request.method !== 'GET' || !Object.hasOwn(sources, address.hostname)) return new Response(null, { status: 404 });
        return await catalogImage(address.hostname, decodeURIComponent(address.pathname.slice(1)));
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    const encrypted = store.read().curseforgeKey;
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try { setCatalog(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))); }
      catch { setCatalog(); }
    }
    handle('sources:list', () => ({ curseforge: catalog.hasCurseForge }));
    handle('sources:curseforge', async (_event, value) => {
      if (typeof value !== 'string' || value.length > 512 || /[^!-~]/.test(value.trim())) {
        throw new Error('Enter a valid CurseForge API key.');
      }
      const key = value.trim();
      if (key && (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
        throw new Error('No system keychain is available. Launch with the CURSEFORGE_API_KEY environment variable instead.');
      }
      await store.write((state) => {
        if (key) state.curseforgeKey = safeStorage.encryptString(key).toString('base64');
        else delete state.curseforgeKey;
      });
      setCatalog(key);
      return { curseforge: catalog.hasCurseForge };
    });
    handle('catalog:search', async (_event, id, query, source) => {
      if (typeof query !== 'string' || (source !== 'all' && !Object.hasOwn(sources, source))) {
        throw new Error('Enter an addon name and select a source.');
      }
      return catalog.search(query.trim().slice(0, 120), source, await requireInstallation(id));
    });
    handle('catalog:detail', async (_event, client, source, id) => {
      if (typeof id !== 'string' || !Object.hasOwn(sources, source)) throw new Error('Select an addon project.');
      return catalog.project(source, id, await requireInstallation(client));
    });
    handle('catalog:project', async (_event, source, url) => {
      const page = Object.hasOwn(sources, source) ? projectPage(source, url) : null;
      if (!page) throw new Error('This project page is unavailable.');
      await shell.openExternal(page);
    });
    handle('catalog:install', async (event, client, source, id) => {
      if (typeof id !== 'string' || !Object.hasOwn(sources, source)) throw new Error('Select a valid addon result.');
      return library.install(await requireInstallation(client), catalog, source, id, 'install', async (addon, folders) => {
        const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning',
          title: 'Replace existing addon folders?',
          message: `Install ${addon.title} from ${sources[source]} and manage it here?`,
          detail: `The following manually installed folders and any edits inside them will be replaced. WoW settings in the WTF folder are preserved.\n\n${folders.join('\n')}`,
          buttons: ['Cancel', 'Replace and manage'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return response === 1;
      });
    });
    handle('editions:list', () => findInstallations());
    handle('editions:add', async (event) => {
      const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Select your World of Warcraft folder',
        properties: ['openDirectory'],
      });
      if (canceled) return null;
      const [folder] = filePaths;
      if (!(await discoverInstallations([folder])).length) {
        throw new Error('Select the World of Warcraft folder or a client folder such as _retail_.');
      }
      await store.write((state) => { state.roots = [...new Set([...state.roots, folder])]; });
      return findInstallations();
    });
    handle('addons:list', async (_event, id) => library.list(await requireInstallation(id)));
    handle('addons:updates', async (_event, id) => library.updates(await requireInstallation(id), catalog));
    handle('addons:change', async (_event, id, key, action) => {
      if (typeof key !== 'string' || !/^(wowinterface|tukui|curseforge|wowup|local):[a-z0-9-]{1,50}$/.test(key)) {
        throw new Error('Select an installed addon.');
      }
      const client = await requireInstallation(id);
      switch (action) {
        case 'pin': return library.pin(client, key, true);
        case 'unpin': return library.pin(client, key, false);
        case 'remove': return library.remove(client, key);
        case 'update':
        case 'repair': return library.refresh(client, catalog, key, action);
        default: throw new Error('Select a supported addon action.');
      }
    });
    handle('addons:import', async (event, id) => {
      const client = await requireInstallation(id);
      const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Choose a World of Warcraft addon ZIP',
        properties: ['openFile'],
        filters: [{ name: 'Addon archives', extensions: ['zip'] }],
      });
      if (canceled) return false;
      await library.importZip(client, filePaths[0]);
      return true;
    });
    handle('editions:open', async (_event, id) => {
      const { directory } = await requireInstallation(id);
      const error = await shell.openPath(directory);
      if (error) throw new Error('Could not open the installation folder.');
    });
    createWindow();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('AddOn Ledger', 'Could not open the local library. Check access to the application data folder.');
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
