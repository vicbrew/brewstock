/**
 * Brewstock photo gallery.
 *
 * Reads gallery.json from the public image bucket, renders a thumbnail grid and
 * opens full-size images in a lightbox.
 *
 * gallery.json shape:
 *   {
 *     "baseUrl": "https://img.brewstock.org",
 *     "images": [
 *       { "key": "IMG_0001.jpg", "large": "large/IMG_0001.jpg", "thumb": "thumbs/IMG_0001.jpg", "uploadedAt": "..." }
 *     ]
 *   }
 *
 * The array order is the gallery order, controlled in admin/.
 */
(function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://img.brewstock.org';
  const GALLERY_JSON_URL = DEFAULT_BASE_URL + '/gallery.json';
  const SWIPE_THRESHOLD = 50;
  const DEFAULT_PAGE_SIZE = 24;
  const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];
  const PAGE_SIZE_STORAGE_KEY = 'brewstock.gallery.pageSize';
  const SORT_STORAGE_KEY = 'brewstock.gallery.sort';
  const SORT_OPTIONS = ['taken-asc', 'added-desc', 'random'];
  const DEFAULT_SORT = 'taken-asc';
  const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

  const state = {
    baseUrl: DEFAULT_BASE_URL + '/',
    sourceImages: [],
    images: [],
    sort: DEFAULT_SORT,
    seed: 0,
    index: -1,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    zoomStep: 0,
    pan: null,
    panMoved: false,
    previousFocus: null,
    preloaded: new Set(),
    touchStart: null,
    isDownloading: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function toAbsoluteUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return state.baseUrl + String(path).replace(/^\/+/, '');
  }

  function imageUrl(image, size) {
    return toAbsoluteUrl(image[size]);
  }

  function photoAlt(index) {
    return `Brewstock 2026 photo ${index + 1} of ${state.images.length}`;
  }

  /* ---------- sorting ---------- */

  function mulberry32(seed) {
    let value = seed;

    return function next() {
      value |= 0;
      value = (value + 0x6d2b79f5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list) {
    const rng = mulberry32(state.seed);
    const result = list.slice();

    for (let index = result.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      const held = result[index];
      result[index] = result[swap];
      result[swap] = held;
    }

    return result;
  }

  function sortImages(images) {
    const list = images.slice();

    if (state.sort === 'random') return shuffled(list);

    // Array.prototype.sort is stable, so anything without a date (or without a
    // date added) keeps the order it has in gallery.json.
    if (state.sort === 'added-desc') {
      return list.sort((a, b) => {
        const addedA = a.uploadedAt || '';
        const addedB = b.uploadedAt || '';
        if (!addedA && !addedB) return 0;
        if (!addedA) return 1;
        if (!addedB) return -1;
        return addedA < addedB ? 1 : addedA > addedB ? -1 : 0;
      });
    }

    // Date taken, oldest first. Images with no capture date go last.
    return list.sort((a, b) => {
      const takenA = a.takenAt || '';
      const takenB = b.takenAt || '';
      if (!takenA && !takenB) return 0;
      if (!takenA) return 1;
      if (!takenB) return -1;
      return takenA < takenB ? -1 : takenA > takenB ? 1 : 0;
    });
  }

  function applySort() {
    state.images = sortImages(state.sourceImages);
    state.page = 1;
    renderGrid();
  }

  function restoreSort() {
    let saved = '';

    try {
      saved = localStorage.getItem(SORT_STORAGE_KEY) || '';
    } catch (_error) {
      saved = '';
    }

    if (SORT_OPTIONS.indexOf(saved) !== -1) {
      state.sort = saved;
    }

    $('gallery-sort').value = state.sort;
  }

  function setSort(value) {
    if (SORT_OPTIONS.indexOf(value) === -1) return;

    state.sort = value;
    state.seed = Math.floor(Math.random() * 4294967296);

    try {
      localStorage.setItem(SORT_STORAGE_KEY, value);
    } catch (_error) {
      // Storage may be unavailable; the choice simply will not be remembered.
    }

    applySort();
  }

  /* ---------- grid ---------- */

  function createTile(image, index) {
    const item = document.createElement('li');
    item.className = 'gallery-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-tile';
    button.dataset.index = String(index);
    button.setAttribute('aria-label', `View photo ${index + 1} of ${state.images.length} full size`);

    const img = document.createElement('img');
    img.src = imageUrl(image, 'thumb');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 500;
    img.height = 500;

    img.addEventListener('error', () => {
      button.classList.add('is-broken');
      img.remove();
    });

    button.append(img);
    item.append(button);
    return item;
  }

  function renderGrid() {
    const grid = $('gallery-grid');
    const fragment = document.createDocumentFragment();

    const pageCount = totalPages();
    state.page = Math.min(Math.max(1, state.page), pageCount);

    const start = (state.page - 1) * state.pageSize;
    const end = Math.min(start + state.pageSize, state.images.length);

    for (let index = start; index < end; index += 1) {
      fragment.append(createTile(state.images[index], index));
    }

    grid.replaceChildren(fragment);
    renderStatus(start, end);
    renderPager(pageCount);
  }

  function totalPages() {
    return Math.max(1, Math.ceil(state.images.length / state.pageSize));
  }

  function renderStatus(start, end) {
    const status = $('gallery-status');
    const total = state.images.length;

    if (total === 0) {
      status.textContent = 'No photos have been added to the gallery yet. Please check back soon.';
      return;
    }

    const photos = total === 1 ? 'photo' : 'photos';

    if (state.pageSize >= total) {
      status.textContent = `${total} ${photos}`;
    } else {
      status.textContent = `Showing ${start + 1}–${end} of ${total} ${photos}`;
    }
  }

  function renderPager(pageCount) {
    const pager = $('gallery-pager');
    const showPager = pageCount > 1;

    pager.hidden = !showPager;
    if (!showPager) return;

    $('gallery-page-label').textContent = `Page ${state.page} of ${pageCount}`;
    $('gallery-prev').disabled = state.page <= 1;
    $('gallery-next').disabled = state.page >= pageCount;
  }

  function goToPage(page, options) {
    const pageCount = totalPages();
    const next = Math.min(Math.max(1, page), pageCount);
    if (next === state.page) return;

    state.page = next;
    renderGrid();

    const settings = options || {};
    if (settings.focusPager) {
      const button = settings.direction === 'previous' ? $('gallery-prev') : $('gallery-next');
      if (!button.disabled) button.focus();
    }

    const anchor = $('gallery-title');
    if (anchor && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function applyPageSize(value) {
    const size = Number(value);
    if (PAGE_SIZE_OPTIONS.indexOf(size) === -1) return;

    state.pageSize = size;
    state.page = 1;

    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
    } catch (_error) {
      // Storage may be unavailable; the choice simply will not be remembered.
    }

    renderGrid();
  }

  function restorePageSize() {
    let saved = 0;

    try {
      saved = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    } catch (_error) {
      saved = 0;
    }

    if (PAGE_SIZE_OPTIONS.indexOf(saved) !== -1) {
      state.pageSize = saved;
    }

    $('gallery-page-size').value = String(state.pageSize);
  }

  /* ---------- lightbox ---------- */

  function focusableElements() {
    return Array.from($('lightbox').querySelectorAll('button:not(:disabled), a[href]'));
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;

    const focusable = focusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleKeydown(event) {
    if ($('lightbox').hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeLightbox();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showImage(state.index - 1);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      showImage(state.index + 1);
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1);
      return;
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomBy(-1);
      return;
    }

    if (event.key === '0') {
      event.preventDefault();
      state.zoomStep = 0;
      applyZoom();
      return;
    }

    trapFocus(event);
  }

  function preload(offset) {
    if (state.images.length < 2) return;

    const index = (state.index + offset + state.images.length) % state.images.length;
    const image = state.images[index];
    if (!image) return;

    const url = imageUrl(image, 'large');
    if (state.preloaded.has(url)) return;

    state.preloaded.add(url);
    const preloadImage = new Image();
    preloadImage.src = url;
  }

  /* ---------- zoom ---------- */

  function fitScale(img, canvas) {
    const availableWidth = Math.max(0, canvas.clientWidth - 16);
    const availableHeight = Math.max(0, canvas.clientHeight - 16);

    if (!availableWidth || !availableHeight) return 1;

    return Math.min(availableWidth / img.naturalWidth, availableHeight / img.naturalHeight, 1);
  }

  function centreCanvas() {
    const canvas = $('lightbox-canvas');
    if (!canvas) return;

    canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) / 2;
  }

  function applyZoom() {
    const img = $('lightbox-image');
    const canvas = $('lightbox-canvas');
    const level = $('lightbox-zoom-level');

    if (!img || !canvas || !img.naturalWidth) return;

    const scale = fitScale(img, canvas) * ZOOM_STEPS[state.zoomStep];

    img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
    img.style.height = `${Math.round(img.naturalHeight * scale)}px`;
    canvas.classList.toggle('is-zoomed', state.zoomStep > 0);

    const percent = Math.round(scale * 100);
    level.textContent = state.zoomStep === 0 ? `Fit · ${percent}%` : `${percent}%`;

    $('lightbox-zoom-out').disabled = state.zoomStep === 0;
    $('lightbox-zoom-in').disabled = state.zoomStep >= ZOOM_STEPS.length - 1;

    centreCanvas();
  }

  function resetZoom() {
    state.zoomStep = 0;
    const img = $('lightbox-image');
    if (img) {
      img.style.width = '';
      img.style.height = '';
    }
  }

  function zoomBy(step) {
    const next = Math.min(Math.max(0, state.zoomStep + step), ZOOM_STEPS.length - 1);
    if (next === state.zoomStep) return;

    state.zoomStep = next;
    applyZoom();
  }

  function toggleZoom() {
    state.zoomStep = state.zoomStep === 0 ? 2 : 0;
    applyZoom();
  }

  function showImage(index) {
    if (state.images.length === 0) return;

    const total = state.images.length;
    const normalised = ((index % total) + total) % total;
    state.index = normalised;

    const image = state.images[normalised];
    const img = $('lightbox-image');
    const status = $('lightbox-status');
    const download = $('lightbox-download');

    $('lightbox-counter').textContent = `${normalised + 1} of ${total}`;
    $('lightbox-prev').disabled = total < 2;
    $('lightbox-next').disabled = total < 2;

    download.href = imageUrl(image, 'large');
    download.dataset.key = image.key || '';
    download.textContent = 'Download';

    img.classList.remove('is-loaded');
    img.alt = photoAlt(normalised);

    resetZoom();
    $('lightbox-zoom-level').textContent = 'Fit';
    $('lightbox-zoom-out').disabled = true;
    $('lightbox-zoom-in').disabled = false;

    status.hidden = false;
    status.textContent = 'Loading…';

    img.onload = () => {
      img.classList.add('is-loaded');
      status.hidden = true;
      status.textContent = '';
      applyZoom();
    };

    img.onerror = () => {
      img.classList.remove('is-loaded');
      status.hidden = false;
      status.textContent = 'This photo could not be loaded.';
    };

    img.src = imageUrl(image, 'large');

    preload(1);
    preload(-1);
  }

  function openLightbox(index, trigger) {
    if (state.images.length === 0) return;

    state.previousFocus = trigger || document.activeElement;
    state.zoomStep = 0;

    const lightbox = $('lightbox');
    lightbox.hidden = false;
    document.body.classList.add('gallery-lightbox-open');

    showImage(index);
    document.addEventListener('keydown', handleKeydown);
    $('lightbox-close').focus();
  }

  function closeLightbox() {
    const lightbox = $('lightbox');
    if (lightbox.hidden) return;

    const lastIndex = state.index;
    const targetPage = Math.floor(lastIndex / state.pageSize) + 1;

    lightbox.hidden = true;
    document.body.classList.remove('gallery-lightbox-open');
    document.removeEventListener('keydown', handleKeydown);

    resetZoom();

    const img = $('lightbox-image');
    img.removeAttribute('src');
    img.classList.remove('is-loaded');
    $('lightbox-canvas').classList.remove('is-zoomed');

    if (targetPage !== state.page) {
      state.page = Math.min(targetPage, totalPages());
      renderGrid();
    }

    const focusTarget = lastIndex >= 0
      ? $('gallery-grid').querySelector(`.gallery-tile[data-index="${lastIndex}"]`)
      : null;

    if (focusTarget) {
      focusTarget.focus();
    } else if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus();
    }

    state.previousFocus = null;
  }

  async function downloadCurrent(event) {
    event.preventDefault();
    if (state.isDownloading || state.index < 0) return;

    const image = state.images[state.index];
    const url = imageUrl(image, 'large');
    const button = $('lightbox-download');
    const filename = image.key || url.split('/').pop() || 'brewstock-photo.jpg';

    state.isDownloading = true;
    button.textContent = 'Downloading…';

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (error) {
      // Fall back to opening the image so it can still be saved manually.
      console.warn('Brewstock gallery download failed:', error);
      window.open(url, '_blank', 'noopener');
    } finally {
      state.isDownloading = false;
      button.textContent = 'Download';
    }
  }

  /* ---------- events ---------- */

  function wireEvents() {
    $('gallery-grid').addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('.gallery-tile') : null;
      if (!button) return;
      openLightbox(Number(button.dataset.index), button);
    });

    $('gallery-page-size').addEventListener('change', (event) => {
      applyPageSize(event.target.value);
    });

    $('gallery-sort').addEventListener('change', (event) => {
      setSort(event.target.value);
    });

    $('gallery-prev').addEventListener('click', () => goToPage(state.page - 1, { focusPager: true, direction: 'previous' }));
    $('gallery-next').addEventListener('click', () => goToPage(state.page + 1, { focusPager: true, direction: 'next' }));

    $('lightbox-close').addEventListener('click', closeLightbox);
    $('lightbox-prev').addEventListener('click', () => showImage(state.index - 1));
    $('lightbox-next').addEventListener('click', () => showImage(state.index + 1));
    $('lightbox-download').addEventListener('click', downloadCurrent);
    $('lightbox-zoom-in').addEventListener('click', () => zoomBy(1));
    $('lightbox-zoom-out').addEventListener('click', () => zoomBy(-1));
    $('lightbox-zoom-level').addEventListener('click', () => {
      state.zoomStep = 0;
      applyZoom();
    });

    $('lightbox-image').addEventListener('dblclick', (event) => {
      event.preventDefault();
      toggleZoom();
    });

    $('lightbox').addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;

      if (state.panMoved) {
        state.panMoved = false;
        return;
      }

      const target = event.target;
      if (target === $('lightbox') || target === $('lightbox-canvas')) {
        closeLightbox();
      }
    });

    window.addEventListener('resize', () => {
      if (!$('lightbox').hidden) applyZoom();
    });

    const canvas = $('lightbox-canvas');

    canvas.addEventListener('pointerdown', (event) => {
      if (state.zoomStep === 0 || event.button !== 0 || event.pointerType === 'touch') return;

      state.pan = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: canvas.scrollLeft,
        top: canvas.scrollTop,
        moved: false,
      };

      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      const pan = state.pan;
      if (!pan || event.pointerId !== pan.id) return;

      const deltaX = event.clientX - pan.x;
      const deltaY = event.clientY - pan.y;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) pan.moved = true;

      canvas.scrollLeft = pan.left - deltaX;
      canvas.scrollTop = pan.top - deltaY;
    });

    const endPan = (event) => {
      const pan = state.pan;
      if (!pan || (event && event.pointerId !== pan.id)) return;

      state.panMoved = pan.moved;
      state.pan = null;

      if (event && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);

    canvas.addEventListener('touchstart', (event) => {
      const touch = event.changedTouches[0];
      state.touchStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });

    canvas.addEventListener('touchend', (event) => {
      if (!state.touchStart) return;

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - state.touchStart.x;
      const deltaY = touch.clientY - state.touchStart.y;
      state.touchStart = null;

      // While zoomed in, a drag pans the photo instead of changing it.
      if (state.zoomStep > 0) return;
      if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) < Math.abs(deltaY)) return;

      showImage(state.index + (deltaX < 0 ? 1 : -1));
    }, { passive: true });
  }

  /* ---------- load ---------- */

  async function loadGallery() {
    const status = $('gallery-status');

    restorePageSize();
    restoreSort();
    state.seed = Math.floor(Math.random() * 4294967296);

    try {
      const response = await fetch(GALLERY_JSON_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Gallery request failed: ${response.status} ${response.statusText}`);

      const data = await response.json();

      if (typeof data.baseUrl === 'string' && /^https?:\/\//i.test(data.baseUrl.trim())) {
        state.baseUrl = data.baseUrl.trim().replace(/\/+$/, '') + '/';
      }

      const images = Array.isArray(data.images)
        ? data.images.filter((image) => image && typeof image.thumb === 'string' && typeof image.large === 'string')
        : [];

      if (images.length === 0) {
        status.textContent = 'No photos have been added to the gallery yet. Please check back soon.';
        return;
      }

      state.sourceImages = images;
      applySort();
    } catch (error) {
      console.warn('Brewstock gallery load failed:', error);
      status.textContent = 'Unable to load the gallery at the moment. Please check back soon.';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireEvents();
    loadGallery();
  });
})();
