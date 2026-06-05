# Don't Censor Explicit Songs

Browser extension that automatically swaps clean versions of songs on YouTube Music for their explicit counterparts.

## Install

Grab the latest release from [Releases](https://github.com/tieo/dont-censor-explicit-songs/releases).

**Chrome (and Edge, Brave, Vivaldi):** unzip the `chrome.zip`. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, point at the unzipped folder.

**Firefox (and Zen, LibreWolf):** the build is currently unsigned, so AMO will not accept a permanent install. Use a temporary load instead. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, select the `.xpi` file. The extension stays active until you close the browser.

A permanent Firefox install needs an AMO signature. Set `MOZ_API_KEY` and `MOZ_API_SECRET` as repo secrets (from [addons.mozilla.org credentials](https://addons.mozilla.org/en-US/developers/addon/api/key/)) and the release job will produce a signed XPI.

## How it works

The extension intercepts YouTube Music's `/youtubei/v1/player` request. When the SPA loads a clean track, the videoId in the body is rewritten to an explicit sibling discovered via Innertube search. Queue items also get the explicit badge stamped on them so the UI reflects what actually plays.

## Develop

```
pnpm install
pnpm dev
```

A Chromium window opens with the extension loaded, pointed at music.youtube.com. Sign in once if you want; the profile persists.

## Build

```
pnpm build           # Chrome MV3
pnpm build:firefox   # Firefox
```

Output goes to `.output/`.

## Tests

```
pnpm test:smoke      # Innertube search + matcher, no browser
pnpm test:e2e:full   # spawns fresh Chromium, runs full e2e
```

The e2e suite drives four entry points (direct URL, search click, queue advance via player API, playlist context) across three known clean/explicit pairs.

## License

MIT
