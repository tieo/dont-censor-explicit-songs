// ISOLATED-world bridge. The main interceptor runs in world:MAIN and therefore
// can't read chrome.storage, so this companion script reads prefs and forwards
// them to the page via window.postMessage — re-posting whenever they change.

import {
  PREFS_STORAGE_KEY,
  PREFS_MESSAGE_SOURCE,
  normalizePrefs,
  type Prefs,
} from '../src/prefs';

export default defineContentScript({
  matches: ['*://music.youtube.com/*'],
  runAt: 'document_start',
  // default (ISOLATED) world — has access to the extension APIs.
  main() {
    const post = (prefs: Prefs) => {
      window.postMessage({ source: PREFS_MESSAGE_SOURCE, prefs }, '*');
    };

    const load = async () => {
      try {
        const got = await browser.storage.local.get(PREFS_STORAGE_KEY);
        post(normalizePrefs(got[PREFS_STORAGE_KEY]));
      } catch {
        post(normalizePrefs(undefined));
      }
    };

    void load();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[PREFS_STORAGE_KEY]) {
        post(normalizePrefs(changes[PREFS_STORAGE_KEY].newValue));
      }
    });

    // MAIN world starts at document_start too; if it asks for a (re)broadcast
    // after it has wired its listener, answer.
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data?.source === PREFS_MESSAGE_SOURCE + ':request') {
        void load();
      }
    });
  },
});
