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
  sources: request('sources:list'),
  setCurseForgeKey: request('sources:curseforge'),
  search: request('catalog:search'),
  install: request('catalog:install'),
  project: request('catalog:detail'),
  openProject: request('catalog:project'),
  addons: request('addons:list'),
  updates: request('addons:updates'),
  changeAddon: request('addons:change'),
  importZip: request('addons:import'),
  builderKeys: request('builder:keys'),
  builderKey: request('builder:key'),
  builderAccount: request('builder:account'),
  builderStop: request('builder:stop'),
  builderGenerate: request('builder:generate'),
  builderExport: request('builder:export'),
  builderInstall: request('builder:install'),
});
