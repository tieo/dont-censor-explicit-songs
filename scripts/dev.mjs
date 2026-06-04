// Dev runner: builds the extension, launches a system Chromium (or Chrome)
// with the extension + uBlock Origin Lite loaded, attaches Playwright over
// CDP, and tees every relevant console line from a music.youtube.com page
// into /tmp/yt-console.log so we can inspect the extension's behavior.
//
// Differs from `wxt dev` because that uses --remote-debugging-pipe which
// locks Playwright (and us) out of the browser. We need CDP for the e2e
// tests, so we launch the browser ourselves.

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = resolve(ROOT, '.output/chrome-mv3');
const UBLOCK_DIR = resolve(ROOT, '.wxt-profile/extensions/ublock-lite');
const PROFILE_DIR = resolve(ROOT, '.wxt-profile/chromium');
const PORT = Number(process.env.UNCENSOR_DEV_PORT ?? 9222);
const LOG = process.env.UNCENSOR_LOG ?? '/tmp/yt-console.log';
const BROWSER_BIN = process.env.CHROME_BIN ?? 'chromium';

mkdirSync(PROFILE_DIR, { recursive: true });

if (!existsSync(EXT_DIR)) {
  console.error(`Missing extension build: ${EXT_DIR}\nRun \`pnpm build\` first.`);
  process.exit(1);
}
if (!existsSync(UBLOCK_DIR)) {
  console.warn(`uBlock Origin Lite not found at ${UBLOCK_DIR}; launching without it.`);
  console.warn(`(Download a uBO Lite chromium release zip into ${UBLOCK_DIR} to enable.)`);
}

writeFileSync(LOG, `--- session start ${new Date().toISOString()} ---\n`);
const logLine = (s) => appendFileSync(LOG, s + '\n');

const loadExt = existsSync(UBLOCK_DIR) ? `${EXT_DIR},${UBLOCK_DIR}` : EXT_DIR;

const browserProc = spawn(
  BROWSER_BIN,
  [
    `--user-data-dir=${PROFILE_DIR}`,
    `--load-extension=${loadExt}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    'https://music.youtube.com',
  ],
  { stdio: 'inherit' },
);

await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];

function wirePage(page) {
  const url = page.url();
  if (!url.includes('music.youtube.com')) return;
  logLine(`[page] attached ${url}`);

  page.on('console', (msg) => {
    const text = msg.text();
    // Only echo uncensor lines + warnings/errors to keep the log focused.
    if (text.includes('[uncensor]') || msg.type() === 'error' || msg.type() === 'warning') {
      logLine(`[${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', (err) => logLine(`[pageerror] ${err.message}`));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) logLine(`[nav] ${frame.url()}`);
  });
}

ctx.pages().forEach(wirePage);
ctx.on('page', wirePage);

logLine(`[runner] attached over CDP, ${ctx.pages().length} page(s)`);
console.log(`Console log: ${LOG}`);
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', async () => {
  await browser.close().catch(() => {});
  browserProc.kill();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await browser.close().catch(() => {});
  browserProc.kill();
  process.exit(0);
});

await new Promise(() => {});
