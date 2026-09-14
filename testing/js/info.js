(function () {
  'use strict';

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderBody(text) {
    const lines = text.split('\n');
    const blocks = [];
    let currentList = [];
    let currentListType = null;
    let currentParagraph = null;

    function flushList() {
      if (currentList.length === 0) return;
      const tag = currentListType === 'ol' ? 'ol' : 'ul';
      blocks.push(`<${tag}>\n${currentList.map(item => `  <li>${escapeHtml(item)}</li>`).join('\n')}\n</${tag}>`);
      currentList = [];
      currentListType = null;
    }

    function flushParagraph() {
      if (currentParagraph === null) return;
      blocks.push(`<p>${escapeHtml(currentParagraph)}</p>`);
      currentParagraph = null;
    }

    for (let rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (trimmed === '') {
        flushList();
        flushParagraph();
        continue;
      }

      // Bullet list item
      const bulletMatch = trimmed.match(/^[•\-\–\—]\s+(.*)$/);
      if (bulletMatch) {
        flushParagraph();
        if (currentListType && currentListType !== 'ul') flushList();
        currentListType = 'ul';
        currentList.push(bulletMatch[1]);
        continue;
      }

      // Numbered list item
      const numberMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (numberMatch) {
        flushParagraph();
        if (currentListType && currentListType !== 'ol') flushList();
        currentListType = 'ol';
        currentList.push(numberMatch[1]);
        continue;
      }

      // Regular paragraph line
      flushList();
      if (currentParagraph === null) {
        currentParagraph = line;
      } else {
        currentParagraph += '\n' + line;
      }
    }

    flushList();
    flushParagraph();

    // Preserve single line breaks inside paragraphs
    return blocks.join('\n').replace(/<p>([\s\S]*?)<\/p>/g, (match, content) => {
      const withBreaks = content.replace(/\n/g, '<br>\n');
      return `<p>${withBreaks}</p>`;
    });
  }

  function renderSection(section) {
    const id = section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `
      <article class="info-card" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title">
        <h3 id="${escapeHtml(id)}-title">${escapeHtml(section.title)}</h3>
        ${renderBody(section.body)}
      </article>
    `;
  }

  function parseInfo(text) {
    const lines = text.split('\n');
    const sections = [];
    let current = null;

    for (let rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (trimmed === '') continue;

      if (trimmed.toLowerCase() === 'intro') {
        if (current && current.type === 'section') {
          sections.push({ title: current.title, body: current.body.join('\n') });
        }
        current = { type: 'intro', body: [] };
        continue;
      }

      const sectionMatch = trimmed.match(/^section\s+(.+)$/i);
      if (sectionMatch) {
        if (current && current.type === 'section') {
          sections.push({ title: current.title, body: current.body.join('\n') });
        }
        current = { type: 'section', title: sectionMatch[1], body: [] };
        continue;
      }

      if (current) {
        current.body.push(line);
      }
    }

    if (current && current.type === 'section') {
      sections.push({ title: current.title, body: current.body.join('\n') });
    }

    const intro = '';
    return { intro, sections };
  }

  async function renderInfo() {
    const list = document.getElementById('info-list');
    if (!list) return;

    try {
      const response = await fetch('data/info.txt');
      if (!response.ok) {
        throw new Error(`Could not load info: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const data = parseInfo(text);

      if (data.sections.length === 0) {
        list.innerHTML = '<p class="section__intro">More information will be available soon.</p>';
        return;
      }

      list.innerHTML = data.sections.map(renderSection).join('\n');
    } catch (error) {
      console.warn('Brewstock info load failed:', error);
      list.innerHTML = '<p class="section__intro">Unable to load event details at the moment. Please check back soon.</p>';
    }
  }

  document.addEventListener('DOMContentLoaded', renderInfo);
})();
