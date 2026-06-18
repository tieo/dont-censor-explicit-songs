import { PREFS_STORAGE_KEY, normalizePrefs } from '../../src/prefs';

const checkbox = document.getElementById('mvAudioSwap') as HTMLInputElement;

async function init() {
  const got = await browser.storage.local.get(PREFS_STORAGE_KEY);
  const prefs = normalizePrefs(got[PREFS_STORAGE_KEY]);
  checkbox.checked = prefs.musicVideoAudioSwap;
}

checkbox.addEventListener('change', async () => {
  const got = await browser.storage.local.get(PREFS_STORAGE_KEY);
  const prefs = normalizePrefs(got[PREFS_STORAGE_KEY]);
  prefs.musicVideoAudioSwap = checkbox.checked;
  await browser.storage.local.set({ [PREFS_STORAGE_KEY]: prefs });
});

void init();
