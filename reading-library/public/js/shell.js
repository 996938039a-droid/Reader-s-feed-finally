import { esc, icon, toggleTheme } from './util.js';

/** The top bar used by the library and highlights pages. */
export function topbar(active, { search = false } = {}) {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<header class="topbar">
    <a class="brand" href="#/">Library</a>
    <nav class="nav" aria-label="Main">
      <a class="link" href="#/" ${active === 'library' ? 'aria-current="page"' : ''}>Library</a>
      <a class="link" href="#/highlights" ${active === 'highlights' ? 'aria-current="page"' : ''}>Highlights</a>
      <a class="link" href="#/sources" ${active === 'sources' ? 'aria-current="page"' : ''}>Sources</a>
    </nav>
    ${search ? `<label class="search"><span class="sr">Search</span>${icon('search')}<input id="q" type="search" placeholder="Search titles, authors, tags…" autocomplete="off"></label>` : '<span class="spacer"></span>'}
    <button class="icon-btn" id="add-toggle" aria-label="Add a link" title="Add a link">${icon('plus')}</button>
    <button class="icon-btn" id="theme-btn" aria-label="Toggle dark mode" title="Dark / light">${icon(dark ? 'sun' : 'moon')}</button>
    <button class="icon-btn" id="settings-btn" aria-label="Settings" title="Settings">${icon('gear')}</button>
  </header>`;
}

export function wireTopbar(root, { onSettings, onAdd }) {
  root.querySelector('#theme-btn').onclick = (e) => {
    toggleTheme();
    e.currentTarget.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
  };
  root.querySelector('#settings-btn').onclick = onSettings;
  root.querySelector('#add-toggle').onclick = onAdd;
}
export { esc };
