const { contextBridge, ipcRenderer } = require('electron');

function request(channel) {
  return async (...args) => {
    const result = await ipcRenderer.invoke(channel, ...args);
    if (result.error) throw new Error(result.error);
    return result.value;
  };
}

contextBridge.exposeInMainWorld('ledger', {
  editions: request('editions:list'),
  addEdition: request('editions:add'),
  openEdition: request('editions:open'),
  addons: request('addons:list'),
});
