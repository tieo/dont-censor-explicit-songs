// CI-friendly e2e runner: builds the extension, spawns a fresh Chromium
// instance with --load-extension + an ephemeral profile, runs tests/e2e.mjs
// against it, then tears down. Doesn't touch the user's dev profile or rely
// on a pre-running browser.
//
// Usage:
//   node scripts/test-e2e.mjs                # build + run
//   CHROME_BIN=/path/to/chromium ...         # override browser
//
// Skips the build step when SKIP_BUILD=1 (useful in tight iteration loops
// where you've just rebuilt manually).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = resolve(ROOT, '.output/chrome-mv3');
const UBLOCK_DIR = resolve(ROOT, '.wxt-profile/extensions/ublock-lite');
const PORT = Number(process.env.UNCENSOR_DEV_PORT ?? 9333); // different from dev port
const BROWSER_BIN = process.env.CHROME_BIN ?? 'chromium';

if (process.env.SKIP_BUILD !== '1') {
  console.log('▶ building extension...');
  const r = spawnSync('node_modules/.bin/wxt', ['build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(EXT_DIR)) {
  console.error(`Missing extension build: ${EXT_DIR}`);
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), 'uncensor-e2e-'));
const loadExt = existsSync(UBLOCK_DIR) ? `${EXT_DIR},${UBLOCK_DIR}` : EXT_DIR;

console.log(`▶ spawning ${BROWSER_BIN} (profile=${profileDir} port=${PORT})`);
const browser = spawn(
  BROWSER_BIN,
  [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${loadExt}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--mute-audio',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
browser.stderr.on('data', () => {}); // swallow chromium spam

// Wait for CDP to come up.
async function waitForCdp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chromium CDP never became ready on port ${PORT}`);
}

const cleanup = () => {
  try { browser.kill('SIGKILL'); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let exitCode = 1;
try {
  await waitForCdp();
  console.log('▶ chromium ready; running tests...');
  const r = spawnSync('node_modules/.bin/tsx', ['tests/e2e.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, UNCENSOR_DEV_PORT: String(PORT) },
  });
  exitCode = r.status ?? 1;
} finally {
  cleanup();
}
process.exit(exitCode);
