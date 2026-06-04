# Don't Censor Explicit Songs

Browser extension that automatically swaps clean versions of songs on YouTube Music for their explicit counterparts.

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
