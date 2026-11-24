const { spawn } = require('node:child_process');
const { access, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { generatedDraft } = require('./custom-addon.cjs');

const providers = { claude: 'Claude', codex: 'Codex' };
const outputSchema = {
  type: 'object',
  properties: { lua: { type: 'string' }, summary: { type: 'string' } },
  required: ['lua', 'summary'],
  additionalProperties: false,
};

function providerName(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(providers, provider)) throw new Error('Choose Claude or Codex.');
  return providers[provider];
}

function providerExecutable(provider) {
  const { platform, arch } = process;
  const target = { darwin: 'apple-darwin', linux: 'unknown-linux-musl', win32: 'pc-windows-msvc' }[platform];
  const machine = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  const suffix = platform === 'win32' ? '.exe' : '';
  try {
    if (!target || !machine) throw new Error();
    const name = provider === 'claude' ? '@anthropic-ai/claude-agent-sdk' : '@openai/codex';
    const directory = path.dirname(require.resolve(`${name}-${platform}-${arch}/package.json`));
    const binary = provider === 'claude' ? ['claude' + suffix]
      : ['vendor', `${machine}-${target}`, 'bin', 'codex' + suffix];
    return path.join(directory, ...binary).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  } catch {
    throw new Error(`${providerName(provider)} is unavailable on this build of AddOn Ledger.`);
  }
}

async function providerEnvironment(root, provider, mode, key) {
  const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SystemDrive|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|HTTPS?_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR))$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
  const directory = path.join(root, provider, mode);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (provider === 'codex') env.CODEX_HOME = directory;
  else if (mode === 'key') {
    env.CLAUDE_CONFIG_DIR = directory;
    env.ANTHROPIC_API_KEY = key;
  } else if (process.env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

function runCLI(executable, args, { cwd, env, signal, openLogin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let opened = false;
    const lines = [];
    for (const [index, pipe] of [child.stdout, child.stderr].entries()) {
      pipe.setEncoding('utf8');
      lines[index] = '';
      pipe.on('data', (chunk) => {
        lines[index] = (lines[index] + chunk).slice(-16000);
        if (!openLogin || opened || signal.aborted) return;
        const url = lines[index].match(/https:\/\/auth\.openai\.com\/[^\s\u001b]+(?=[\s\u001b])/)?.[0];
        if (url) {
          opened = true;
          openLogin(url).catch(() => {});
        }
      });
    }
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: lines[0], output: lines.join('\n') }));
  });
}

async function checkAccount(provider, executable, options) {
  const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
  const result = await runCLI(executable, args, options);
  if (result.code !== 0) return false;
  if (provider === 'codex') return /logged in using ChatGPT/i.test(result.output);
  try {
    const status = JSON.parse(result.stdout);
    return status.loggedIn === true && status.apiProvider === 'firstParty'
      && ['claude.ai', 'api_key'].includes(status.authMethod);
  } catch {
    return false;
  }
}

function accountRequired(provider) {
  return new Error(provider === 'claude'
    ? 'Run claude auth login in Terminal, then check your Claude Code login again.'
    : 'Sign in to ChatGPT with Connect account before generating with Codex.');
}

async function runClaude(prompt, cwd, env, executable, controller) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const agent = query({ prompt, options: {
    cwd, env, pathToClaudeCodeExecutable: executable, abortController: controller,
    systemPrompt: 'Generate World of Warcraft addon source in the requested output format.',
    tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false,
    settings: { disableAllHooks: true }, permissionMode: 'dontAsk', maxTurns: 3, verbatimPrompts: true,
    outputFormat: { type: 'json_schema', schema: outputSchema },
  } });
  try {
    for await (const message of agent) {
      if (message.type === 'assistant' && message.error) throw new Error(message.error);
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error) {
        throw new Error(message.errors?.join(' ') || 'Claude stopped before producing a draft.');
      }
      return message.structured_output;
    }
  } finally {
    agent.close();
  }
  throw new Error('Claude stopped before producing a draft.');
}

async function runCodex(prompt, cwd, env, executable, key, signal) {
  const { Codex } = await import('@openai/codex-sdk');
  const config = {
    forced_login_method: key ? 'api' : 'chatgpt',
    history: { persistence: 'none' },
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'cloud.skills.enabled': false,
  };
  if (key) config.cli_auth_credentials_store = 'ephemeral';
  for (const feature of ['shell_tool', 'shell_snapshot', 'stable_environment_tools', 'plugins', 'apps', 'hooks',
    'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_only', 'memories', 'goals', 'skill_search',
    'skill_mcp_dependency_install', 'browser_use', 'computer_use', 'image_generation', 'view_image']) {
    config[`features.${feature}`] = false;
  }
  const codex = new Codex({ codexPathOverride: executable, apiKey: key, env, config });
  const thread = codex.startThread({
    workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only',
    approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
  });
  const result = await thread.run(prompt, { outputSchema, signal });
  return JSON.parse(result.finalResponse);
}

function createBuilderProviders(root, openLogin) {
  let active;

  async function withProvider(provider, mode, key, work, timeout = 180000) {
    const name = providerName(provider);
    if (mode !== 'account' && mode !== 'key') throw new Error('Choose an authentication method.');
    if (mode === 'key' && !key) throw new Error(`Save a ${name} API key first.`);
    if (active) throw new Error('Wait for the active provider operation or stop it first.');
    const controller = new AbortController();
    active = controller;
    const timer = setTimeout(() => controller.abort('timeout'), timeout);
    timer.unref();
    let cwd;
    try {
      const executable = providerExecutable(provider);
      await access(executable).catch(() => { throw new Error(`${name}’s bundled runtime is unavailable.`); });
      cwd = await mkdtemp(path.join(tmpdir(), 'ledger-builder-'));
      const env = await providerEnvironment(root, provider, mode, key);
      if (controller.signal.aborted) throw new Error();
      return await work(executable, { cwd, env, signal: controller.signal }, controller);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(controller.signal.reason === 'timeout'
        ? `${name} timed out. Try again.` : 'Provider operation stopped.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
      active = null;
    }
  }

  const account = (provider, action) => withProvider(provider, 'account', undefined, async (executable, options) => {
    if (action === 'connect' && provider === 'codex' && !await checkAccount(provider, executable, options)) {
      const result = await runCLI(executable, ['login'], { ...options, openLogin });
      if (result.code !== 0) throw new Error('Codex sign-in did not finish. Try connecting again.');
    }
    const connected = await checkAccount(provider, executable, options);
    if (action === 'connect' && !connected) throw accountRequired(provider);
    return connected;
  }, action === 'connect' && provider === 'codex' ? 300000 : 15000);

  const generate = (provider, mode, key, prepare) => withProvider(provider, mode, key, async (executable, options, controller) => {
    const { prompt, target } = await prepare();
    controller.signal.throwIfAborted();
    if (mode === 'account' && !await checkAccount(provider, executable, options)) throw accountRequired(provider);
    let result;
    try {
      result = provider === 'claude'
        ? await runClaude(prompt, options.cwd, options.env, executable, controller)
        : await runCodex(prompt, options.cwd, options.env, executable, key, options.signal);
    } catch (error) {
      // Provider errors can include headers or parts of the request. Show only a classified summary.
      if (/unauthorized|authentication|invalid.api.key|\b401\b|not logged in/.test(String(error.message).toLowerCase())) {
        throw new Error(`${providers[provider]} rejected the connection. Check your login or API key.`);
      }
      if (/rate.limit|quota|billing|\b429\b/.test(String(error.message).toLowerCase())) {
        throw new Error(`${providers[provider]} reported a usage or billing limit. Check your provider account.`);
      }
      throw new Error(`${providers[provider]} could not generate a draft. Check your connection and try again.`);
    }
    return { ...generatedDraft(result), target };
  });

  return { account, generate, stop: () => active?.abort('user') };
}

module.exports = { providerName, providerExecutable, createBuilderProviders };
