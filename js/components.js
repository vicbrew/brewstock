/**
 * Load shared navigation and footer partials into every page.
 *
 * To update the nav or footer, edit partials/nav.html and partials/footer.html.
 * The active page link is highlighted automatically via the data-page attribute.
 *
 * Navigation feature flags live in data/site.json:
 *   "showBeerList"      — true shows the Beer List link in the main navigation
 *   "ticketsAvailable"  — false greys out and disables the Buy tickets link
 */

(function () {
  'use strict';

  let settingsPromise = null;

  function loadSettings() {
    if (!settingsPromise) {
      settingsPromise = fetch('data/site.json')
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Could not load data/site.json: ${response.status} ${response.statusText}`);
          }
          return response.json();
        })
        .catch((error) => {
          console.warn('Brewstock site settings load failed:', error);
          return {};
        });
    }
    return settingsPromise;
  }

  function applySiteSettings(settings) {
    const showBeerList = settings.showBeerList === true;
    document.querySelectorAll('[data-feature="beer-list"]').forEach((item) => {
      item.hidden = !showBeerList;
    });

    const ticketsAvailable = settings.ticketsAvailable !== false;
    document.querySelectorAll('[data-feature="tickets"]').forEach((link) => {
      link.classList.toggle('is-disabled', !ticketsAvailable);
      if (ticketsAvailable) {
        link.removeAttribute('aria-disabled');
        link.removeAttribute('title');
      } else {
        link.setAttribute('aria-disabled', 'true');
        link.setAttribute('title', 'Tickets are not currently available');
      }
    });
  }

  function refreshSiteSettings() {
    return loadSettings().then(applySiteSettings);
  }

  function blockUnavailableTicketClicks(event) {
    if (!(event.target instanceof Element)) return;

    const link = event.target.closest('[data-feature="tickets"].is-disabled');
    if (!link) return;

    event.preventDefault();
  }

  async function loadPartial(selector, url) {
    const container = document.querySelector(selector);
    if (!container) return;

    try {
      const [response, settings] = await Promise.all([fetch(url), loadSettings()]);
      if (!response.ok) {
        throw new Error(`Could not load ${url}: ${response.status} ${response.statusText}`);
      }
      const html = await response.text();
      container.innerHTML = html;
      highlightCurrentPage();
      applySiteSettings(settings);
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

  document.addEventListener('click', blockUnavailableTicketClicks);

  document.addEventListener('DOMContentLoaded', () => {
    refreshSiteSettings();
    loadPartial('[data-component="nav"]', 'partials/nav.html');
    loadPartial('[data-component="footer"]', 'partials/footer.html');
  });
})();
