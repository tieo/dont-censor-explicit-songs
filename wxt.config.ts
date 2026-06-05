import { defineConfig } from 'wxt';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  manifest: ({ browser }) => ({
    name: "Don't Censor Explicit Songs",
    description:
      'Automatically replaces clean versions of songs on YouTube Music with their explicit counterparts.',
    version: pkg.version,
    permissions: ['storage'],
    host_permissions: ['*://music.youtube.com/*'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    },
    // Firefox / Zen / forks need a stable extension ID. Without it Firefox
    // generates a random one on temporary install (lost on restart) and
    // refuses permanent install entirely. Chrome MV3 doesn't accept the
    // key, so only emit it for Gecko targets.
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'dont-censor-explicit-songs@tieo.github.io',
          strict_min_version: '128.0',
        },
      },
    }),
  }),
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  webExt: {
    startUrls: ['https://music.youtube.com'],
    // Persistent profile (relative to project root, gitignored) so the YT Music
    // login survives dev-server restarts.
    chromiumProfile: resolve('.wxt-profile/chromium'),
    keepProfileChanges: true,
  },
});
