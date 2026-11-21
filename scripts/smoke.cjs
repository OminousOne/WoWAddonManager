const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function retry(action, timeout = 25000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(180);
  }
  throw lastError || new Error('Timed out waiting for the desktop app.');
}

async function evaluate(socket, expression) {
  const id = Math.floor(Math.random() * 1e9);
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('Timed out evaluating the renderer.'));
    }, 3000);
    function receive({ data }) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', receive);
      resolve(message);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  if (response.error || response.result.exceptionDetails) {
    throw new Error(response.error?.message || response.result.exceptionDetails.text);
  }
  return response.result.result.value;
}

async function smoke() {
  const executable = process.argv[2] && path.resolve(process.argv[2]);
  assert.ok(executable, 'Provide the packaged application executable.');
  await fs.access(executable);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-smoke-'));
  const userData = path.join(root, 'app-data');
  const game = path.join(root, 'World of Warcraft');
  let app;
  let socket;
  try {
    await fs.mkdir(userData);
    await fs.writeFile(path.join(userData, 'library.json'), JSON.stringify({ roots: [game], packages: {} }));
    for (const [edition, addon] of [['_retail_', 'RetailFixture'], ['_anniversary_', 'ClassicFixture']]) {
      const directory = path.join(game, edition, 'Interface', 'AddOns', addon);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, addon + '.toc'), `## Title: ${addon}\n## Version: 1.0`);
    }

    app = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let logs = '';
    app.stderr.on('data', (data) => { logs = (logs + data).slice(-8000); });
    try {
      const port = await retry(async () => {
        if (app.exitCode !== null) throw new Error(`Electron exited with code ${app.exitCode}\n${logs}`);
        const details = await fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
        return Number(details.split('\n')[0]);
      });
      const page = await retry(async () => {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return pages.find((item) => item.type === 'page' && item.url.includes('/renderer/index.html'));
      });
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await retry(() => socket.readyState === WebSocket.OPEN);
      await retry(() => evaluate(socket,
        "document.querySelector('#results').textContent.includes('RetailFixture')"));
      const editions = await evaluate(socket,
        "Array.from(document.querySelector('#edition').options, (item) => item.textContent).slice(0, 2)");
      assert.deepEqual(editions, ['Retail', 'Classic Anniversary']);
      await evaluate(socket, `(() => {
        const edition = document.querySelector('#edition');
        edition.selectedIndex = 1;
        edition.dispatchEvent(new Event('change'));
      })()`);
      await retry(() => evaluate(socket,
        "document.querySelector('#results').textContent.includes('ClassicFixture')"));
      const checks = await evaluate(socket, `[
        document.title,
        typeof window.require,
        document.querySelector('#notice').textContent
      ]`);
      assert.deepEqual(checks, ['AddOn Ledger', 'undefined', '']);
      console.log('Packaged UI opened and switched between Retail and Classic Anniversary libraries.');
    } catch (error) {
      if (logs) console.error(logs);
      throw error;
    }
  } finally {
    socket?.close();
    if (app?.pid && app.exitCode === null) {
      app.kill();
      await retry(() => app.exitCode !== null || app.signalCode !== null, 5000).catch(() => app.kill('SIGKILL'));
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

smoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
