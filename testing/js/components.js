/**
 * Load shared navigation and footer partials into every page.
 *
 * To update the nav or footer, edit partials/nav.html and partials/footer.html.
 * The active page link is highlighted automatically via the data-page attribute.
 */

(function () {
  'use strict';

  async function loadPartial(selector, url) {
    const container = document.querySelector(selector);
    if (!container) return;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load ${url}: ${response.status} ${response.statusText}`);
      }
      const html = await response.text();
      container.innerHTML = html;
      highlightCurrentPage();
    } catch (error) {
      console.warn('Brewstock partial load failed:', error);
      // The static fallback inside the container remains visible.
    }
  }

  function highlightCurrentPage() {
    const page = document.body.dataset.page;
    if (!page) return;

    document.querySelectorAll('.main-nav a[data-page]').forEach((link) => {
      if (link.dataset.page === page) {
        link.setAttribute('aria-current', 'page');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPartial('[data-component="nav"]', 'partials/nav.html');
    loadPartial('[data-component="footer"]', 'partials/footer.html');
  });
})();
