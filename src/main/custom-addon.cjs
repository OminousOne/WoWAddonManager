const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { ZipFile } = require('yazl');
const { parse } = require('luaparse');

const luaLimit = 96 * 1024;
const descriptionLimit = 4000;
const draftId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function addonTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 80 || /[\x00-\x1f\x7f|\u2028\u2029]/.test(title)) {
    throw new Error('Enter an addon name of 1–80 characters without line breaks or vertical bars.');
  }
  return title;
}

function interfaceVersion(client) {
  const version = /^(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:\.\d+)?$/.exec(client.version);
  if (!version) throw new Error('Ledger could not detect this WoW client’s version. Rescan a fully installed client.');
  const [major, minor, patch] = version.slice(1).map(Number);
  return major * 10000 + minor * 100 + patch;
}

function luaSource(value, { syntax = true } = {}) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > luaLimit || value.includes('\0')) {
    throw new Error('Include one Lua source file under 96 KiB.');
  }
  const lua = value.trim() + '\n';
  if (syntax) {
    try {
      parse(lua, { luaVersion: '5.1', comments: false });
    } catch (error) {
      throw new Error(Number.isInteger(error.line)
        ? `Lua syntax error on line ${error.line}, column ${error.column + 1}. Review the code or ask for a revision.`
        : 'Ledger could not validate the Lua source. Review the code or ask for a revision.');
    }
  }
  return lua;
}

function generationPrompt(client, input) {
  const title = addonTitle(input?.title);
  const request = typeof input?.request === 'string' ? input.request.trim() : '';
  if (!request || request.length > descriptionLimit) throw new Error('Describe the addon or revision in 1–4,000 characters.');
  const previousLua = input.lua ? luaSource(input.lua, { syntax: false }) : null;
  return [
    'Write a self-contained Lua 5.1 addon for World of Warcraft. Return its complete Lua source in the lua field.',
    'Use only in-game addon APIs available for this client. Never use operating-system, shell, network, or filesystem APIs.',
    'Do not automate protected gameplay actions. Use local variables and avoid naming collisions with other addons.',
    'Use no external dependencies. Ledger creates the TOC and loads only Addon.lua. Summarize the result in the summary field.',
    JSON.stringify({ title, client: client.label, gameVersion: client.version, interface: interfaceVersion(client), request, previousLua }),
  ].join('\n');
}

function generatedDraft(result) {
  const summary = typeof result?.summary === 'string' ? result.summary.trim() : '';
  if (!summary || summary.length > 2000) throw new Error('The provider returned an incomplete draft. Try again.');
  return { lua: luaSource(result.lua, { syntax: false }), summary };
}

function customAddon(input) {
  if (typeof input?.id !== 'string' || !draftId.test(input.id)) throw new Error('Generate an addon draft first.');
  if (!Number.isInteger(input.interface) || input.interface < 10000 || input.interface > 9999999) {
    throw new Error('The draft is missing a valid WoW interface version.');
  }
  const title = addonTitle(input.title);
  const folder = `Ledger_${input.id.replaceAll('-', '')}`;
  return {
    id: input.id,
    title,
    interface: input.interface,
    folder,
    files: {
      [folder + '.toc']: `## Interface: ${input.interface}\n## Title: ${title}\n## Notes: Custom addon built with AddOn Ledger\nAddon.lua\n`,
      'Addon.lua': luaSource(input.lua),
    },
  };
}

async function exportAddon(addon, destination) {
  const zip = new ZipFile();
  for (const [name, contents] of Object.entries(addon.files)) {
    zip.addBuffer(Buffer.from(contents), `${addon.folder}/${name}`);
  }
  const temporary = path.join(path.dirname(destination), `.addon-ledger-${randomUUID()}.zip`);
  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = { addonTitle, interfaceVersion, generationPrompt, generatedDraft, customAddon, exportAddon };
