/**
 * Render the sponsor grid from data/sponsors.json.
 *
 * To add or remove a sponsor, edit data/sponsors.json and place the sponsor's
 * logo at images/sponsors/{slug}.png (for example, images/sponsors/keg-king.png).
 */

(function () {
  'use strict';

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function createSponsorCard(sponsor) {
    const imagePath = `images/sponsors/${sponsor.slug}.png`;
    const imageAlt = `${sponsor.name} logo`;

    return `
      <article class="sponsor-card">
        <div class="sponsor-card__logo">
          <img src="${escapeHtml(imagePath)}" alt="${escapeHtml(imageAlt)}" loading="lazy" width="240" height="120">
        </div>
        <h3 class="sponsor-card__name">
          <a href="${escapeHtml(sponsor.website)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(sponsor.name)}
          </a>
        </h3>
        <p class="sponsor-card__blurb">${escapeHtml(sponsor.blurb)}</p>
      </article>
    `;
  }

  async function renderSponsors() {
    const container = document.getElementById('sponsor-grid');
    if (!container) return;

    try {
      const response = await fetch('data/sponsors.json');
      if (!response.ok) {
        throw new Error(`Could not load sponsors: ${response.status} ${response.statusText}`);
      }
      const sponsors = await response.json();

      if (!Array.isArray(sponsors) || sponsors.length === 0) {
        container.innerHTML = '<p class="section__intro">Our sponsors will be announced soon.</p>';
        return;
      }

      container.innerHTML = sponsors.map(createSponsorCard).join('');
    } catch (error) {
      console.warn('Brewstock sponsor load failed:', error);
      container.innerHTML = '<p class="section__intro">Unable to load sponsors at the moment. Please check back soon.</p>';
    }
  }

  document.addEventListener('DOMContentLoaded', renderSponsors);
})();
