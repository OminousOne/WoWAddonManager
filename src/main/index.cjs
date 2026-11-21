const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { openStore } = require('./store.cjs');
const { defaultRoots, discoverInstallations, scanAddons } = require('./wow.cjs');

const page = path.join(__dirname, '../renderer/index.html');
const pageUrl = pathToFileURL(page).href;
let store;

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
    backgroundColor: '#111721',
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
    handle('addons:list', async (_event, id) => scanAddons(await requireInstallation(id)));
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
