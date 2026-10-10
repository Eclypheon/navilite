import './styles.css';
import { boot } from './ui/app.ts';

const root = document.getElementById('app');

if (root) {
  boot(root).catch((error: unknown) => {
    const message = error instanceof Error ? `${error.message}` : String(error);
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'empty';
    const heading = document.createElement('h1');
    heading.textContent = 'Navilite failed to start';
    const detail = document.createElement('p');
    detail.textContent = message;
    box.append(heading, detail);
    root.append(box);
  });
}

/**
 * The service worker only makes sense for a built, same-origin deployment — registering
 * it against the dev server would cache Vite's module graph and confuse everything.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
      console.warn('[navilite] service worker registration failed', error);
    });
  });
}
