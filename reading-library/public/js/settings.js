import { COLORS, DEFAULT_LABELS, applyTheme, esc, getPrefs, setPrefs, toast, icon } from './util.js';
import { setPass } from './api.js';
import { openSheet } from './ui.js';
import { store } from './store.js';

export function openSettings({ onSignOut } = {}) {
  const p = getPrefs();
  const bookmarklet = `javascript:(()=>{location.href='${location.origin}/?add='+encodeURIComponent(location.href)})()`;
  const sheet = openSheet({
    title: 'Settings',
    body: `
      <div class="field"><span class="lbl">Appearance</span>
        <div class="seg" role="group" aria-label="Theme">
          ${['auto', 'light', 'dark'].map((t) => `<button data-theme="${t}" aria-pressed="${p.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
        <p class="hint">Auto follows your device. You can also flip it with the moon button at the top.</p>
      </div>
      <div class="field"><span class="lbl">Reading</span>
        <label class="row"><input type="checkbox" id="s-full" ${p.fullscreen ? 'checked' : ''}> Go full screen when I open an article</label>
        <p class="hint">On iPhone and iPad, browsers cannot go full screen. Use Share → Add to Home Screen and the app opens with no browser bars at all.</p>
      </div>
      <div class="field"><span class="lbl">Highlight colour names</span>
        <div class="swatch-row">
          ${COLORS.map((c) => `<label><span class="swatch ${c}"></span><input type="text" data-label="${c}" value="${esc(p.labels[c])}" maxlength="24" aria-label="${c} label"></label>`).join('')}
        </div>
      </div>
      <div class="field"><span class="lbl">Save from anywhere</span>
        <p class="hint">Drag this to your bookmarks bar. Click it on any page to add that page to your library.</p>
        <div class="row"><a class="btn" href="${esc(bookmarklet)}" onclick="return false" draggable="true">+ Add to Library</a>
        <button class="btn" id="s-copy">${icon('copy')} Copy bookmarklet</button></div>
        <p class="hint">On Android, install this app, then use Share → Reading Library from any browser or app.</p>
      </div>
      <div class="field"><span class="lbl">This device</span>
        <div class="row">
          <a class="btn" href="/setup.html">Setup &amp; classify tools</a>
          <button class="btn" id="s-clear">Clear offline copies</button>
          <button class="btn danger" id="s-out">Sign out</button>
        </div>
      </div>`,
  });
  const b = sheet.body;
  b.querySelectorAll('[data-theme]').forEach((btn) => btn.addEventListener('click', () => {
    setPrefs({ theme: btn.dataset.theme });
    b.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
  }));
  b.querySelector('#s-full').onchange = (e) => setPrefs({ fullscreen: e.target.checked });
  b.querySelectorAll('[data-label]').forEach((inp) => inp.addEventListener('input', () => {
    const labels = { ...getPrefs().labels, [inp.dataset.label]: inp.value.trim() || DEFAULT_LABELS[inp.dataset.label] };
    setPrefs({ labels });
  }));
  b.querySelector('#s-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(bookmarklet); toast('Bookmarklet copied'); } catch { toast('Could not copy. Drag the button instead.'); }
  };
  b.querySelector('#s-clear').onclick = async () => { await store.clear('content'); toast('Offline copies removed'); };
  b.querySelector('#s-out').onclick = () => { setPass(''); sheet.close(); onSignOut?.(); };
  applyTheme(p.theme);
}
