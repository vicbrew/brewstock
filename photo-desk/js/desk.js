/**
 * Brewstock gallery admin.
 *
 * Runs entirely in the browser against the R2 S3 API (see js/r2.js).
 * Credentials are kept in memory for the current tab and are never persisted.
 */
(function () {
  'use strict';

  const R2 = window.BrewstockR2;
  const JSON_KEY = 'gallery.json';
  const THUMB_MAX_EDGE = 500;
  const THUMB_QUALITY = 0.82;
  const THUMB_CACHE_CONTROL = 'public, max-age=86400';
  const JSON_CACHE_CONTROL = 'public, max-age=60';
  const PREVIEW_EXPIRY_SECONDS = 3600;
  const CONFIG_STORAGE_KEY = 'brewstock.galleryAdmin.config';
  const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];
  const DEFAULT_PAGE_SIZE = 24;
  const VIEWER_ZOOM_STEPS = [1, 1.5, 2, 3, 4];
  const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif'];

  const CORS_POLICY = [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
      MaxAgeSeconds: 3600,
    },
  ];

  const state = {
    client: null,
    config: null,
    gallery: { version: 1, baseUrl: '', updatedAt: '', images: [] },
    jsonExists: false,
    jsonError: null,
    newFiles: [],
    otherRootFiles: [],
    archiveFiles: [],
    selection: new Set(),
    archiveSelection: new Set(),
    listings: { root: new Set(), large: new Set(), thumbs: new Set(), archive: new Set() },
    usedThumbs: new Set(),
    activeTab: 'new',
    filter: '',
    pageSize: DEFAULT_PAGE_SIZE,
    newPage: 1,
    processedPage: 1,
    archivePage: 1,
    viewer: null,
    busy: false,
    progress: { done: 0, total: 0 },
    lastSaveFailed: false,
    orderSaving: false,
    connectionTest: null,
    connectionTestRunning: false,
    dateScan: null,
    dragIndex: null,
  };

  /* ---------- small helpers ---------- */

  function $(id) {
    return document.getElementById(id);
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function extensionOf(key) {
    const match = /\.([a-z0-9]+)$/i.exec(key);
    return match ? match[1].toLowerCase() : '';
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, power);
    const rounded = value >= 10 || power === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[power]}`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm || singular + 's'}`;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function describeError(error) {
    if (!error) return 'Unknown error.';
    if (error.status === 403) {
      return 'Access denied (403). Check the access key has Object Read & Write permission for this bucket, and that the account ID and bucket name are correct.';
    }
    if (error.status === 404) {
      return 'Not found (404). Check the bucket name and account ID.';
    }
    if (error.status === 400 && error.code === 'InvalidArgument') {
      return `Invalid request: ${error.message}`;
    }
    return error.message || String(error);
  }

  /* ---------- setup panel ---------- */

  function readSetupForm() {
    return {
      accountId: $('input-account').value.trim(),
      bucket: $('input-bucket').value.trim(),
      accessKeyId: $('input-access-key').value.trim(),
      secretAccessKey: $('input-secret-key').value.trim(),
      publicBaseUrl: $('input-public-base').value.trim().replace(/\/+$/, ''),
      endpoint: $('input-endpoint').value.trim(),
      remember: $('input-remember').checked,
    };
  }

  function restoreSetupForm() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
    } catch (_error) {
      saved = null;
    }

    if (!saved || typeof saved !== 'object') return;

    if (saved.accountId) $('input-account').value = saved.accountId;
    if (saved.bucket) $('input-bucket').value = saved.bucket;
    if (saved.publicBaseUrl) $('input-public-base').value = saved.publicBaseUrl;
    if (saved.endpoint) $('input-endpoint').value = saved.endpoint;
  }

  function persistSetupConfig(config) {
    try {
      if (!config.remember) {
        localStorage.removeItem(CONFIG_STORAGE_KEY);
        return;
      }
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({
        accountId: config.accountId,
        bucket: config.bucket,
        publicBaseUrl: config.publicBaseUrl,
        endpoint: config.endpoint,
      }));
    } catch (_error) {
      // localStorage may be unavailable; the admin still works for this session.
    }
  }

  function setSetupError(message) {
    const box = $('setup-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function setConnectBusy(busy) {
    const button = $('btn-connect');
    button.disabled = busy;
    button.textContent = busy ? 'Connecting…' : 'Connect';
    $('connect-status').textContent = busy ? 'Checking credentials…' : '';
  }

  async function handleConnect(event) {
    event.preventDefault();
    setSetupError('');

    const config = readSetupForm();

    if (!config.accountId) return setSetupError('Enter the R2 account ID.');
    if (!config.bucket) return setSetupError('Enter the bucket name.');
    if (!config.accessKeyId) return setSetupError('Enter the access key ID.');
    if (!config.secretAccessKey) return setSetupError('Enter the secret access key.');

    try {
      const base = new URL(config.publicBaseUrl);
      if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error();
    } catch (_error) {
      return setSetupError('Enter a valid public image base URL, for example https://img.brewstock.org');
    }

    setConnectBusy(true);
    try {
      const client = R2.createClient(config);
      await client.listObjects({ maxKeys: 1 });

      state.client = client;
      state.config = config;
      persistSetupConfig(config);

      await loadData({ refreshPreviews: true });

      $('setup-panel').hidden = true;
      $('app-panel').hidden = false;
      $('admin-connection').hidden = false;
      $('input-secret-key').value = '';

      renderAll();
      showToast(`Connected to ${config.bucket}.`);
    } catch (error) {
      state.client = null;
      state.config = null;
      setSetupError(describeError(error));
    } finally {
      setConnectBusy(false);
    }
  }

  function handleDisconnect() {
    if (state.busy) return;
    state.client = null;
    state.config = null;
    state.gallery = { version: 1, baseUrl: '', updatedAt: '', images: [] };
    state.newFiles = [];
    state.otherRootFiles = [];
    state.selection.clear();
    state.jsonError = null;
    state.lastSaveFailed = false;

    $('input-secret-key').value = '';
    $('setup-panel').hidden = false;
    $('app-panel').hidden = true;
    $('admin-connection').hidden = true;
    clearBanner();
    setSetupError('');
    showToast('Disconnected. Credentials were cleared from this tab.');
  }

  /* ---------- loading ---------- */

  function normalizeGallery(parsed, fallbackBaseUrl) {
    const images = [];

    parsed.images.forEach((item) => {
      if (!item || typeof item !== 'object') return;

      const large = typeof item.large === 'string' ? item.large.replace(/^\/+/, '') : '';
      if (!large) return;

      const thumb = typeof item.thumb === 'string' && item.thumb
        ? item.thumb.replace(/^\/+/, '')
        : `thumbs/${large.replace(/^large\//, '').replace(/\.[^./]+$/, '')}.jpg`;

      images.push({
        key: typeof item.key === 'string' && item.key ? item.key : large.replace(/^large\//, ''),
        large,
        thumb,
        takenAt: typeof item.takenAt === 'string' ? item.takenAt : '',
        uploadedAt: typeof item.uploadedAt === 'string' ? item.uploadedAt : '',
        thumbUrl: '',
      });
    });

    return {
      version: 1,
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl.replace(/\/+$/, '') : fallbackBaseUrl,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      images,
    };
  }

  function extensionIsImage(key) {
    return IMAGE_EXTENSIONS.indexOf(extensionOf(key)) !== -1;
  }

  async function applyListings(listings, options) {
    const settings = options || {};

    state.listings = {
      root: new Set(listings.root.objects.map((object) => object.key)),
      large: new Set(listings.large.objects.map((object) => object.key)),
      thumbs: new Set(listings.thumbs.objects.map((object) => object.key)),
      archive: new Set(listings.archive.objects.map((object) => object.key)),
    };

    const existing = new Map(state.newFiles.map((file) => [file.key, file]));
    const imagesInJson = new Set(state.gallery.images.map((image) => image.key));
    const nextFiles = [];
    const otherFiles = [];

    listings.root.objects.forEach((object) => {
      const key = object.key;
      if (!key || key.endsWith('/') || key === JSON_KEY) return;

      if (!extensionIsImage(key)) {
        otherFiles.push(key);
        return;
      }

      let file = existing.get(key);
      if (!file) {
        file = {
          key,
          size: 0,
          lastModified: '',
          duplicate: false,
          previewUrl: '',
          status: '',
          statusKind: '',
        };
      }

      file.size = object.size;
      file.lastModified = object.lastModified;
      file.duplicate = imagesInJson.has(key);
      if (settings.refreshPreviews) file.previewUrl = '';

      nextFiles.push(file);
    });

    nextFiles.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true, sensitivity: 'base' }));

    state.newFiles = nextFiles;
    state.otherRootFiles = otherFiles;

    const existingArchive = new Map(state.archiveFiles.map((file) => [file.key, file]));
    const archiveFiles = [];

    listings.archive.objects.forEach((object) => {
      const key = object.key;
      if (!key || key.endsWith('/') || key === 'archive/') return;
      if (!extensionIsImage(key)) return;

      let file = existingArchive.get(key);
      if (!file) {
        file = {
          key,
          name: key.replace(/^archive\//, ''),
          size: 0,
          lastModified: '',
          previewUrl: '',
          inGallery: false,
        };
      }

      file.name = key.replace(/^archive\//, '');
      file.size = object.size;
      file.lastModified = object.lastModified;
      file.inGallery = imagesInJson.has(file.name);
      if (settings.refreshPreviews) file.previewUrl = '';

      archiveFiles.push(file);
    });

    archiveFiles.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true, sensitivity: 'base' }));

    state.archiveFiles = archiveFiles;
    state.listings.archive = new Set(archiveFiles.map((file) => file.key));

    Array.from(state.archiveSelection).forEach((key) => {
      if (!archiveFiles.some((file) => file.key === key)) state.archiveSelection.delete(key);
    });

    const archivePreviewJobs = archiveFiles
      .filter((file) => !file.previewUrl)
      .map(async (file) => {
        try {
          file.previewUrl = await state.client.presignGet(file.key, PREVIEW_EXPIRY_SECONDS);
        } catch (_error) {
          file.previewUrl = '';
        }
      });

    Array.from(state.selection).forEach((key) => {
      if (!nextFiles.some((file) => file.key === key)) state.selection.delete(key);
    });

    const previewJobs = nextFiles
      .filter((file) => !file.previewUrl)
      .map(async (file) => {
        try {
          file.previewUrl = await state.client.presignGet(file.key, PREVIEW_EXPIRY_SECONDS);
        } catch (_error) {
          file.previewUrl = '';
        }
      });

    if (settings.refreshPreviews) {
      state.gallery.images.forEach((image) => {
        image.thumbUrl = '';
      });
    }

    const thumbJobs = state.gallery.images
      .filter((image) => !image.thumbUrl)
      .map(async (image) => {
        try {
          image.thumbUrl = await state.client.presignGet(image.thumb, PREVIEW_EXPIRY_SECONDS);
        } catch (_error) {
          image.thumbUrl = '';
        }
      });

    await Promise.all(previewJobs.concat(thumbJobs, archivePreviewJobs));
  }

  async function loadData(options) {
    const settings = options || {};
    setAppBusy(true);

    try {
      const [jsonText, root, large, thumbs, archive] = await Promise.all([
        state.client.getText(JSON_KEY),
        state.client.listObjects({ prefix: '', delimiter: '/', maxKeys: 1000 }),
        state.client.listObjects({ prefix: 'large/' }),
        state.client.listObjects({ prefix: 'thumbs/' }),
        state.client.listObjects({ prefix: 'archive/' }),
      ]);

      state.jsonError = null;

      if (jsonText === null) {
        state.jsonExists = false;
        state.gallery = {
          version: 1,
          baseUrl: state.config.publicBaseUrl,
          updatedAt: '',
          images: [],
        };
      } else {
        state.jsonExists = true;
        let parsed = null;
        let parseMessage = '';

        try {
          parsed = JSON.parse(jsonText);
        } catch (_error) {
          parseMessage = 'gallery.json is not valid JSON. Fix or delete it in the Cloudflare dashboard before continuing.';
        }

        if (!parseMessage && (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images))) {
          parseMessage = 'gallery.json does not contain an "images" array. Fix or delete it in the Cloudflare dashboard before continuing.';
        }

        if (parseMessage) {
          state.jsonError = { message: parseMessage, raw: jsonText };
          state.gallery = { version: 1, baseUrl: state.config.publicBaseUrl, updatedAt: '', images: [] };
        } else {
          state.gallery = normalizeGallery(parsed, state.config.publicBaseUrl);
        }
      }

      state.usedThumbs = new Set(state.gallery.images.map((image) => image.thumb));

      await applyListings({ root, large, thumbs, archive }, settings);
    } finally {
      setAppBusy(false);
    }
  }

  async function refreshListings() {
    if (!state.client) return;

    const [root, large, thumbs, archive] = await Promise.all([
      state.client.listObjects({ prefix: '', delimiter: '/', maxKeys: 1000 }),
      state.client.listObjects({ prefix: 'large/' }),
      state.client.listObjects({ prefix: 'thumbs/' }),
      state.client.listObjects({ prefix: 'archive/' }),
    ]);

    await applyListings({ root, large, thumbs, archive }, { refreshPreviews: true });
  }

  /* ---------- busy / banner / toast ---------- */

  function setAppBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle('is-busy', busy);
    syncToolbar();
  }

  function showBanner(options) {
    const banner = $('app-banner');
    banner.replaceChildren();

    const heading = createElement('p', 'alert__title', options.title);
    banner.append(heading);

    if (options.message) {
      banner.append(createElement('p', null, options.message));
    }

    if (options.items && options.items.length) {
      const list = createElement('ul', 'alert__list');
      options.items.forEach((item) => list.append(createElement('li', null, item)));
      banner.append(list);
    }

    if (options.raw) {
      const details = document.createElement('details');
      details.className = 'alert__raw';
      details.append(createElement('summary', null, 'Show the current file contents'));
      details.append(createElement('pre', 'raw-json', options.raw));
      banner.append(details);
    }

    if (options.retry) {
      const retry = createElement('button', 'btn btn--secondary btn--sm', 'Retry saving gallery.json');
      retry.type = 'button';
      retry.dataset.action = 'retry-save';
      banner.append(retry);
    }

    const dismiss = createElement('button', 'btn btn--ghost btn--sm', 'Dismiss');
    dismiss.type = 'button';
    dismiss.dataset.action = 'dismiss-banner';
    banner.append(dismiss);

    banner.hidden = false;
  }

  function clearBanner() {
    const banner = $('app-banner');
    banner.hidden = true;
    banner.replaceChildren();
  }

  let toastTimer = null;

  function showToast(message, tone) {
    const toast = $('toast');
    toast.textContent = message;
    toast.className = tone === 'error' ? 'toast toast--error' : 'toast';
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 5000);
  }

  /* ---------- preview viewer ---------- */

  function viewerItems(kind) {
    if (kind === 'new') {
      return visibleNewFiles().map((file) => ({
        kind: 'new',
        key: file.key,
        thumbUrl: file.previewUrl,
        file,
      }));
    }

    if (kind === 'archive') {
      return state.archiveFiles.map((file) => ({
        kind: 'archive',
        key: file.key,
        thumbUrl: file.previewUrl,
        file,
      }));
    }

    return state.gallery.images.map((image) => ({
      kind: 'processed',
      key: image.key,
      thumbUrl: image.thumbUrl,
      image,
    }));
  }

  function openViewer(kind, key, trigger) {
    const items = viewerItems(kind);
    const index = items.findIndex((item) => item.key === key);
    if (index === -1) return;

    state.viewer = {
      kind,
      items,
      index,
      zoomStep: 0,
      pan: null,
      panMoved: false,
      previousFocus: trigger || document.activeElement,
    };

    $('viewer').hidden = false;
    document.body.classList.add('is-viewing');

    showViewerImage();
    document.addEventListener('keydown', handleViewerKeydown);
    $('viewer-close').focus();
  }

  function closeViewer() {
    const viewer = state.viewer;
    if (!viewer) return;

    const lastKey = viewer.items[viewer.index] ? viewer.items[viewer.index].key : '';

    $('viewer').hidden = true;
    document.body.classList.remove('is-viewing');
    document.removeEventListener('keydown', handleViewerKeydown);

    const img = $('viewer-image');
    img.removeAttribute('src');
    img.classList.remove('is-loaded');
    img.style.width = '';
    img.style.height = '';
    $('viewer-canvas').classList.remove('is-zoomed');

    syncGridToViewerItem(viewer);
    state.viewer = null;

    // The grid may have been re-rendered to another page while browsing.
    const grid = viewer.kind === 'new'
      ? $('new-grid')
      : viewer.kind === 'archive'
        ? $('archive-grid')
        : $('processed-grid');
    const currentCard = viewer.kind === 'processed'
      ? grid.querySelector(`.admin-card--processed[data-index="${viewer.index}"]`)
      : Array.from(grid.querySelectorAll('.admin-card')).find((card) => card.dataset.key === lastKey);
    const focusTarget = currentCard ? currentCard.querySelector('.admin-card__open') : null;

    if (focusTarget) {
      focusTarget.focus();
    } else if (viewer.previousFocus && typeof viewer.previousFocus.focus === 'function' && viewer.previousFocus.isConnected) {
      viewer.previousFocus.focus();
    }
  }

  function syncGridToViewerItem(viewer) {
    if (!viewer) return;

    if (viewer.kind === 'new') {
      const page = Math.floor(viewer.index / state.pageSize) + 1;
      if (page !== state.newPage) {
        state.newPage = page;
        renderNewTab(true);
      }
    } else if (viewer.kind === 'archive') {
      const page = Math.floor(viewer.index / state.pageSize) + 1;
      if (page !== state.archivePage) {
        state.archivePage = page;
        renderArchiveTab();
      }
    } else {
      const page = Math.floor(viewer.index / state.pageSize) + 1;
      if (page !== state.processedPage) {
        state.processedPage = page;
        renderProcessedTab();
      }
    }
  }

  async function showViewerImage() {
    const viewer = state.viewer;
    if (!viewer) return;

    const total = viewer.items.length;
    const item = viewer.items[viewer.index];
    const img = $('viewer-image');
    const status = $('viewer-status');

    const label = item.kind === 'archive' ? item.file.name : item.key;
    $('viewer-counter').textContent = `${viewer.index + 1} of ${total} · ${label}`;
    $('viewer-prev').disabled = total < 2;
    $('viewer-next').disabled = total < 2;

    const selectButton = $('viewer-select');
    if (item.kind === 'new' || item.kind === 'archive') {
      const selection = item.kind === 'new' ? state.selection : state.archiveSelection;
      const selected = selection.has(item.key);
      selectButton.hidden = false;
      selectButton.setAttribute('aria-pressed', String(selected));
      selectButton.textContent = selected ? 'Selected' : 'Select';
      selectButton.classList.toggle('is-active', selected);
    } else {
      selectButton.hidden = true;
    }

    viewer.zoomStep = 0;
    img.classList.remove('is-loaded');
    img.style.width = '';
    img.style.height = '';
    $('viewer-canvas').classList.remove('is-zoomed');
    $('viewer-zoom-level').textContent = 'Fit';
    $('viewer-zoom-out').disabled = true;
    $('viewer-zoom-in').disabled = false;

    status.hidden = false;
    status.textContent = 'Loading full-size image…';

    let url = '';

    try {
      if (item.kind === 'new') {
        if (!item.file.largeUrl) {
          item.file.largeUrl = await state.client.presignGet(item.file.key, PREVIEW_EXPIRY_SECONDS);
        }
        url = item.file.largeUrl;
      } else if (item.kind === 'archive') {
        if (!item.file.previewUrl) {
          item.file.previewUrl = await state.client.presignGet(item.file.key, PREVIEW_EXPIRY_SECONDS);
        }
        url = item.file.previewUrl;
      } else {
        if (!item.image.largeUrl) {
          item.image.largeUrl = await state.client.presignGet(item.image.large, PREVIEW_EXPIRY_SECONDS);
        }
        url = item.image.largeUrl;
      }
    } catch (error) {
      status.textContent = `Could not load the full-size image: ${describeError(error)}`;
      return;
    }

    if (!state.viewer || state.viewer !== viewer) return;

    img.onload = () => {
      img.classList.add('is-loaded');
      status.hidden = true;
      applyViewerZoom();
    };

    img.onerror = () => {
      img.classList.remove('is-loaded');
      status.hidden = false;
      status.textContent = 'This image could not be decoded by this browser.';
    };

    img.src = url;

    syncGridToViewerItem(viewer);
  }

  function viewerFitScale(img) {
    const canvas = $('viewer-canvas');
    const availableWidth = Math.max(0, canvas.clientWidth - 16);
    const availableHeight = Math.max(0, canvas.clientHeight - 16);

    if (!availableWidth || !availableHeight) return 1;
    return Math.min(availableWidth / img.naturalWidth, availableHeight / img.naturalHeight, 1);
  }

  function centreViewerCanvas() {
    const canvas = $('viewer-canvas');
    canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) / 2;
  }

  function applyViewerZoom() {
    const viewer = state.viewer;
    const img = $('viewer-image');
    if (!viewer || !img.naturalWidth) return;

    const scale = viewerFitScale(img) * VIEWER_ZOOM_STEPS[viewer.zoomStep];

    img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
    img.style.height = `${Math.round(img.naturalHeight * scale)}px`;
    $('viewer-canvas').classList.toggle('is-zoomed', viewer.zoomStep > 0);

    const percent = Math.round(scale * 100);
    $('viewer-zoom-level').textContent = viewer.zoomStep === 0 ? `Fit · ${percent}%` : `${percent}%`;

    $('viewer-zoom-out').disabled = viewer.zoomStep === 0;
    $('viewer-zoom-in').disabled = viewer.zoomStep >= VIEWER_ZOOM_STEPS.length - 1;

    centreViewerCanvas();
  }

  function zoomViewer(step) {
    const viewer = state.viewer;
    if (!viewer) return;

    const next = Math.min(Math.max(0, viewer.zoomStep + step), VIEWER_ZOOM_STEPS.length - 1);
    if (next === viewer.zoomStep) return;

    viewer.zoomStep = next;
    applyViewerZoom();
  }

  function toggleViewerZoom() {
    const viewer = state.viewer;
    if (!viewer) return;

    viewer.zoomStep = viewer.zoomStep === 0 ? 2 : 0;
    applyViewerZoom();
  }

  function stepViewer(delta) {
    const viewer = state.viewer;
    if (!viewer || viewer.items.length < 2) return;

    const total = viewer.items.length;
    viewer.index = ((viewer.index + delta) % total + total) % total;
    showViewerImage();
  }

  function toggleViewerSelection() {
    const viewer = state.viewer;
    if (!viewer) return;

    const item = viewer.items[viewer.index];
    if (item.kind === 'processed') return;

    const selection = item.kind === 'new' ? state.selection : state.archiveSelection;

    if (selection.has(item.key)) {
      selection.delete(item.key);
    } else {
      selection.add(item.key);
    }

    const selected = selection.has(item.key);
    const button = $('viewer-select');
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = selected ? 'Selected' : 'Select';
    button.classList.toggle('is-active', selected);

    if (item.kind === 'new') {
      const card = findNewCard(item.key);
      if (card) {
        card.classList.toggle('is-selected', selected);
        const checkbox = card.querySelector('.admin-card__select input[type="checkbox"]');
        if (checkbox) checkbox.checked = selected;
      }
      syncToolbar();
    } else {
      const card = Array.from($('archive-grid').querySelectorAll('.admin-card'))
        .find((element) => element.dataset.key === item.key);
      if (card) {
        card.classList.toggle('is-selected', selected);
        const checkbox = card.querySelector('.admin-card__select input[type="checkbox"]');
        if (checkbox) checkbox.checked = selected;
      }
      syncArchiveToolbar();
    }
  }

  function handleViewerKeydown(event) {
    if (!state.viewer) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeViewer();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepViewer(-1);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepViewer(1);
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomViewer(1);
      return;
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomViewer(-1);
      return;
    }

    if (event.key === '0') {
      event.preventDefault();
      if (state.viewer) {
        state.viewer.zoomStep = 0;
        applyViewerZoom();
      }
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = Array.from($('viewer').querySelectorAll('button:not(:disabled):not([hidden])'));
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

  function wireViewerEvents() {
    $('viewer-close').addEventListener('click', closeViewer);
    $('viewer-prev').addEventListener('click', () => stepViewer(-1));
    $('viewer-next').addEventListener('click', () => stepViewer(1));
    $('viewer-select').addEventListener('click', toggleViewerSelection);
    $('viewer-zoom-in').addEventListener('click', () => zoomViewer(1));
    $('viewer-zoom-out').addEventListener('click', () => zoomViewer(-1));
    $('viewer-zoom-level').addEventListener('click', () => {
      if (!state.viewer) return;
      state.viewer.zoomStep = 0;
      applyViewerZoom();
    });

    $('viewer-image').addEventListener('dblclick', (event) => {
      event.preventDefault();
      toggleViewerZoom();
    });

    $('viewer').addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;

      if (state.viewer && state.viewer.panMoved) {
        state.viewer.panMoved = false;
        return;
      }

      if (event.target === $('viewer') || event.target === $('viewer-canvas')) {
        closeViewer();
      }
    });

    const canvas = $('viewer-canvas');

    canvas.addEventListener('pointerdown', (event) => {
      const viewer = state.viewer;
      if (!viewer || viewer.zoomStep === 0 || event.button !== 0 || event.pointerType === 'touch') return;

      viewer.pan = {
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
      const viewer = state.viewer;
      if (!viewer || !viewer.pan || event.pointerId !== viewer.pan.id) return;

      const deltaX = event.clientX - viewer.pan.x;
      const deltaY = event.clientY - viewer.pan.y;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) viewer.pan.moved = true;

      canvas.scrollLeft = viewer.pan.left - deltaX;
      canvas.scrollTop = viewer.pan.top - deltaY;
    });

    const endPan = (event) => {
      const viewer = state.viewer;
      if (!viewer || !viewer.pan || (event && event.pointerId !== viewer.pan.id)) return;

      viewer.panMoved = viewer.pan.moved;
      viewer.pan = null;

      if (event && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);

    let touchStart = null;

    canvas.addEventListener('touchstart', (event) => {
      const touch = event.changedTouches[0];
      touchStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });

    canvas.addEventListener('touchend', (event) => {
      if (!touchStart) return;

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      touchStart = null;

      if (state.viewer && state.viewer.zoomStep > 0) return;
      if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY)) return;

      stepViewer(deltaX < 0 ? 1 : -1);
    }, { passive: true });

    window.addEventListener('resize', () => {
      if (state.viewer) applyViewerZoom();
    });
  }

  /* ---------- tabs ---------- */
  function setActiveTab(tab) {
    state.activeTab = tab;

    document.querySelectorAll('.admin-tab').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    });

    ['new', 'processed', 'archive', 'health'].forEach((name) => {
      $('tab-' + name).hidden = name !== tab;
    });
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    renderConnection();
    renderStats();
    setActiveTab(state.activeTab);

    if (state.jsonError) {
      showBanner({
        title: 'gallery.json needs attention',
        message: state.jsonError.message,
        raw: state.jsonError.raw,
      });
    } else if (!state.lastSaveFailed) {
      clearBanner();
    }

    renderNewTab(true);
    renderProcessedTab();
    renderArchiveTab();
    renderHealthTab();
  }

  function renderConnection() {
    if (!state.config) return;
    const label = $('admin-connection-label');
    label.textContent = `${state.config.bucket} · ${state.client.host}`;
  }

  function renderStats() {
    const container = $('admin-stats');
    container.replaceChildren();

    const stats = [
      { value: state.newFiles.length, label: 'new images' },
      { value: state.gallery.images.length, label: 'in gallery' },
      { value: state.listings.archive.size, label: 'archived' },
    ];

    stats.forEach((stat) => {
      const item = createElement('span', 'admin-stat');
      item.append(createElement('strong', null, String(stat.value)));
      item.append(document.createTextNode(' ' + stat.label));
      container.append(item);
    });

    const jsonState = state.jsonError
      ? 'gallery.json needs attention'
      : state.jsonExists
        ? `gallery.json updated ${formatDateTime(state.gallery.updatedAt) || 'unknown'}`
        : 'gallery.json will be created on first accept';

    container.append(createElement('span', 'admin-stat admin-stat--muted', jsonState));
  }

  function syncToolbar() {
    const selectedCount = state.selection.size;
    const visible = visibleNewFiles();
    const pageItems = pageSlice(visible, state.newPage);
    const pageSelected = pageItems.filter((file) => state.selection.has(file.key)).length;
    const selectAll = $('select-all');

    selectAll.checked = pageItems.length > 0 && pageSelected === pageItems.length;
    selectAll.indeterminate = pageSelected > 0 && pageSelected < pageItems.length;
    selectAll.disabled = pageItems.length === 0 || state.busy;

    $('selection-summary').textContent = selectedCount === 0
      ? 'Nothing selected'
      : `${selectedCount} selected of ${state.newFiles.length}`;

    const duplicateCount = state.newFiles.filter((file) => file.duplicate && state.selection.has(file.key)).length;

    $('btn-accept').disabled = state.busy || Boolean(state.jsonError) || selectedCount === 0;
    $('btn-archive').disabled = state.busy || selectedCount === 0;
    $('btn-clear-selection').disabled = state.busy || selectedCount === 0;
    $('new-filter').disabled = state.busy;

    $('new-grid').querySelectorAll('.admin-card__select input[type="checkbox"]').forEach((checkbox) => {
      checkbox.disabled = state.busy;
    });

    $('btn-accept').textContent = selectedCount > 0 && duplicateCount > 0
      ? `Accept & process (${duplicateCount} already in gallery)`
      : 'Accept & process';

    $('count-new').textContent = String(state.newFiles.length);
    $('count-processed').textContent = String(state.gallery.images.length);
  }

  function visibleNewFiles() {
    const filter = state.filter.trim().toLowerCase();
    if (!filter) return state.newFiles;
    return state.newFiles.filter((file) => file.key.toLowerCase().includes(filter));
  }

  /* ---------- pagination ---------- */

  function pageCount(total) {
    return Math.max(1, Math.ceil(total / state.pageSize));
  }

  function pageSlice(list, page) {
    const clamped = Math.min(Math.max(1, page), pageCount(list.length));
    const start = (clamped - 1) * state.pageSize;
    return list.slice(start, start + state.pageSize);
  }

  function renderPager(container, page, total, which) {
    const pages = pageCount(total);
    container.replaceChildren();

    if (pages <= 1) {
      container.hidden = true;
      return;
    }

    container.hidden = false;

    const start = (page - 1) * state.pageSize + 1;
    const end = Math.min(page * state.pageSize, total);

    const previous = createElement('button', 'admin-pager__button', 'Previous');
    previous.type = 'button';
    previous.dataset.pagerStep = '-1';
    previous.dataset.pagerFor = which;
    previous.disabled = page <= 1 || state.busy;

    const label = createElement('p', 'admin-pager__label', `Page ${page} of ${pages} · ${start}–${end} of ${total}`);

    const next = createElement('button', 'admin-pager__button', 'Next');
    next.type = 'button';
    next.dataset.pagerStep = '1';
    next.dataset.pagerFor = which;
    next.disabled = page >= pages || state.busy;

    container.append(previous, label, next);
  }

  function goToPage(which, delta) {
    if (state.busy) return;

    if (which === 'new') {
      const total = visibleNewFiles().length;
      const target = Math.min(Math.max(1, state.newPage + delta), pageCount(total));
      if (target === state.newPage) return;
      state.newPage = target;
      renderNewTab(true);
    } else if (which === 'archive') {
      const total = state.archiveFiles.length;
      const target = Math.min(Math.max(1, state.archivePage + delta), pageCount(total));
      if (target === state.archivePage) return;
      state.archivePage = target;
      renderArchiveTab();
    } else {
      const total = state.gallery.images.length;
      const target = Math.min(Math.max(1, state.processedPage + delta), pageCount(total));
      if (target === state.processedPage) return;
      state.processedPage = target;
      renderProcessedTab();
    }

    const container = which === 'new'
      ? $('new-grid')
      : which === 'archive'
        ? $('archive-grid')
        : $('processed-grid');
    if (container && typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function setPageSize(value) {
    const size = Number(value);
    if (PAGE_SIZE_OPTIONS.indexOf(size) === -1 || size === state.pageSize) return;

    state.pageSize = size;
    state.newPage = 1;
    state.processedPage = 1;
    state.archivePage = 1;
    renderAll();
  }

  function createNewCard(file) {
    const card = createElement('article', 'admin-card');
    card.dataset.key = file.key;
    if (file.duplicate) card.classList.add('is-duplicate');

    const select = createElement('label', 'admin-card__select');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = file.key;
    checkbox.checked = state.selection.has(file.key);
    checkbox.setAttribute('aria-label', `Select ${file.key}`);
    select.append(checkbox);
    card.append(select);

    const media = createElement('button', 'admin-card__media admin-card__open');
    media.type = 'button';
    media.dataset.action = 'preview';
    media.setAttribute('aria-label', `Preview ${file.key}`);

    if (file.previewUrl) {
      const image = document.createElement('img');
      image.src = file.previewUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.draggable = false;
      image.addEventListener('error', () => {
        media.classList.add('is-broken');
        media.replaceChildren(createElement('span', 'admin-card__media-note', 'No preview'));
      });
      media.append(image);
    } else {
      media.classList.add('is-broken');
      media.append(createElement('span', 'admin-card__media-note', 'No preview'));
    }
    card.append(media);

    const body = createElement('div', 'admin-card__body');
    const name = createElement('p', 'admin-card__name', file.key);
    name.title = file.key;
    body.append(name);
    body.append(createElement('p', 'admin-card__meta', `${formatBytes(file.size)} · ${formatDateTime(file.lastModified)}`));

    if (file.duplicate) {
      body.append(createElement('p', 'admin-card__badge', 'Already in gallery'));
    }

    const status = createElement('p', 'admin-card__status', file.status || '');
    status.dataset.role = 'status';
    body.append(status);
    card.append(body);

    if (file.statusKind) card.dataset.statusKind = file.statusKind;

    return card;
  }

  function renderNewTab(rebuild) {
    const grid = $('new-grid');
    const empty = $('new-empty');
    const visible = visibleNewFiles();
    const pages = pageCount(visible.length);

    state.newPage = Math.min(Math.max(1, state.newPage), pages);

    const pageItems = pageSlice(visible, state.newPage);

    if (rebuild) {
      const fragment = document.createDocumentFragment();
      pageItems.forEach((file) => fragment.append(createNewCard(file)));
      grid.replaceChildren(fragment);
    }

    grid.querySelectorAll('.admin-card').forEach((card) => {
      const selected = state.selection.has(card.dataset.key);
      card.classList.toggle('is-selected', selected);

      const checkbox = card.querySelector('.admin-card__select input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
    });

    if (visible.length === 0) {
      empty.hidden = false;
      if (state.newFiles.length === 0) {
        empty.textContent = 'No new images in the bucket root. Upload photos to the root of the R2 bucket, then press Refresh.';
      } else {
        empty.textContent = 'No images match that filter.';
      }
    } else {
      empty.hidden = true;
    }

    renderPager($('new-pager'), state.newPage, visible.length, 'new');
    syncToolbar();
  }

  function findNewCard(key) {
    return Array.from($('new-grid').children).find((card) => card.dataset.key === key);
  }

  function setCardStatus(key, message, kind) {
    const file = state.newFiles.find((item) => item.key === key);
    if (file) {
      file.status = message;
      file.statusKind = kind || '';
    }

    const card = findNewCard(key);
    if (!card) return;

    card.dataset.statusKind = kind || '';
    const status = card.querySelector('[data-role="status"]');
    if (status) status.textContent = message || '';
  }

  function toggleSelection(key) {
    if (state.selection.has(key)) {
      state.selection.delete(key);
    } else {
      state.selection.add(key);
    }
    renderNewTab(false);
  }

  function createProcessedCard(image, index) {
    const card = createElement('article', 'admin-card admin-card--processed');
    card.dataset.index = String(index);
    card.draggable = !state.busy;

    const media = createElement('button', 'admin-card__media admin-card__open');
    media.type = 'button';
    media.dataset.action = 'preview';
    media.setAttribute('aria-label', `Preview ${image.key}`);

    if (image.thumbUrl) {
      const img = document.createElement('img');
      img.src = image.thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => {
        media.classList.add('is-broken');
        media.replaceChildren(createElement('span', 'admin-card__media-note', 'Missing thumbnail'));
      });
      media.append(img);
    } else {
      media.classList.add('is-broken');
      media.append(createElement('span', 'admin-card__media-note', 'Missing thumbnail'));
    }

    const order = createElement('span', 'admin-card__order', String(index + 1));
    media.append(order);
    card.append(media);

    const body = createElement('div', 'admin-card__body');
    const name = createElement('p', 'admin-card__name', image.key);
    name.title = image.key;
    body.append(name);

    const added = image.uploadedAt ? `Added ${formatDateTime(image.uploadedAt)}` : 'Added date unknown';
    body.append(createElement('p', 'admin-card__meta', added));

    body.append(createElement(
      'p',
      'admin-card__meta',
      image.takenAt ? `Taken ${formatDateTime(image.takenAt)}` : 'No capture date'
    ));

    if (!state.listings.large.has(image.large)) {
      body.append(createElement('p', 'admin-card__badge admin-card__badge--warning', 'Large file missing'));
    }
    if (!state.listings.thumbs.has(image.thumb)) {
      body.append(createElement('p', 'admin-card__badge admin-card__badge--warning', 'Thumbnail missing'));
    }

    if (!state.listings.large.has(image.large)) card.classList.add('is-missing');

    card.append(body);

    const actions = createElement('div', 'admin-card__actions');

    const earlier = createElement('button', 'icon-button', '←');
    earlier.type = 'button';
    earlier.dataset.action = 'earlier';
    earlier.title = 'Show earlier';
    earlier.setAttribute('aria-label', `Move ${image.key} earlier`);
    earlier.disabled = index === 0 || state.busy;

    const later = createElement('button', 'icon-button', '→');
    later.type = 'button';
    later.dataset.action = 'later';
    later.title = 'Show later';
    later.setAttribute('aria-label', `Move ${image.key} later`);
    later.disabled = index === state.gallery.images.length - 1 || state.busy;

    const remove = createElement('button', 'btn btn--ghost btn--sm', 'Remove');
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.disabled = state.busy;

    actions.append(earlier, later, remove);
    card.append(actions);

    return card;
  }

  function renderProcessedTab() {
    const grid = $('processed-grid');
    const empty = $('processed-empty');
    const fragment = document.createDocumentFragment();

    const total = state.gallery.images.length;
    state.processedPage = Math.min(Math.max(1, state.processedPage), pageCount(total));

    const start = (state.processedPage - 1) * state.pageSize;
    pageSlice(state.gallery.images, state.processedPage).forEach((image, offset) => {
      fragment.append(createProcessedCard(image, start + offset));
    });

    grid.replaceChildren(fragment);
    empty.hidden = total > 0;
    empty.textContent = state.jsonError
      ? 'Fix gallery.json before managing gallery order.'
      : 'No images in the gallery yet. Accept some new images first.';

    renderPager($('processed-pager'), state.processedPage, total, 'processed');
  }

  function createArchiveCard(file, index) {
    const card = createElement('article', 'admin-card admin-card--archive');
    card.dataset.key = file.key;

    const select = createElement('label', 'admin-card__select');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = file.key;
    checkbox.checked = state.archiveSelection.has(file.key);
    checkbox.setAttribute('aria-label', `Select archived ${file.name}`);
    select.append(checkbox);
    card.append(select);

    const media = createElement('button', 'admin-card__media admin-card__open');
    media.type = 'button';
    media.dataset.action = 'preview';
    media.setAttribute('aria-label', `Preview archived ${file.name}`);

    if (file.previewUrl) {
      const img = document.createElement('img');
      img.src = file.previewUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => {
        media.classList.add('is-broken');
        media.replaceChildren(createElement('span', 'admin-card__media-note', 'No preview'));
      });
      media.append(img);
    } else {
      media.classList.add('is-broken');
      media.append(createElement('span', 'admin-card__media-note', 'No preview'));
    }

    card.append(media);

    const body = createElement('div', 'admin-card__body');
    const name = createElement('p', 'admin-card__name', file.name);
    name.title = file.key;
    body.append(name);
    body.append(createElement('p', 'admin-card__meta', `${formatBytes(file.size)} · ${formatDateTime(file.lastModified)}`));

    if (file.inGallery) {
      body.append(createElement('p', 'admin-card__badge', 'Already in gallery'));
    }

    card.append(body);

    const actions = createElement('div', 'admin-card__actions');

    const restore = createElement('button', 'btn btn--primary btn--sm', 'Restore');
    restore.type = 'button';
    restore.dataset.action = 'restore';
    restore.disabled = state.busy || file.inGallery;
    restore.setAttribute('aria-label', `Restore ${file.name} to the gallery`);

    actions.append(restore);
    card.append(actions);

    card.classList.toggle('is-selected', state.archiveSelection.has(file.key));

    return card;
  }

  function renderArchiveTab() {
    const grid = $('archive-grid');
    const empty = $('archive-empty');
    const total = state.archiveFiles.length;

    state.archivePage = Math.min(Math.max(1, state.archivePage), pageCount(total));

    const fragment = document.createDocumentFragment();
    const start = (state.archivePage - 1) * state.pageSize;

    pageSlice(state.archiveFiles, state.archivePage).forEach((file, offset) => {
      fragment.append(createArchiveCard(file, start + offset));
    });

    grid.replaceChildren(fragment);
    empty.hidden = total > 0;
    empty.textContent = 'Nothing archived yet. Images you archive during review appear here.';

    renderPager($('archive-pager'), state.archivePage, total, 'archive');
    syncArchiveToolbar();
  }

  function syncArchiveToolbar() {
    const pageItems = pageSlice(state.archiveFiles, state.archivePage);
    const pageSelected = pageItems.filter((file) => state.archiveSelection.has(file.key)).length;
    const selectedCount = state.archiveSelection.size;
    const selectAll = $('archive-select-all');

    selectAll.checked = pageItems.length > 0 && pageSelected === pageItems.length;
    selectAll.indeterminate = pageSelected > 0 && pageSelected < pageItems.length;
    selectAll.disabled = pageItems.length === 0 || state.busy;

    $('archive-selection-summary').textContent = selectedCount === 0
      ? 'Nothing selected'
      : `${selectedCount} selected of ${state.archiveFiles.length}`;

    $('btn-archive-restore').disabled = state.busy || Boolean(state.jsonError) || selectedCount === 0;
    $('btn-archive-delete').disabled = state.busy || selectedCount === 0;
    $('btn-archive-clear').disabled = state.busy || selectedCount === 0;

    $('archive-grid').querySelectorAll('.admin-card__select input[type="checkbox"]').forEach((checkbox) => {
      checkbox.disabled = state.busy;
    });

    $('archive-grid').querySelectorAll('.admin-card').forEach((card) => {
      const file = state.archiveFiles.find((item) => item.key === card.dataset.key);
      const restore = card.querySelector('button[data-action="restore"]');
      if (restore) restore.disabled = state.busy || !file || file.inGallery;
    });

    $('count-archive').textContent = String(state.archiveFiles.length);
  }

  function toggleArchiveSelection(key) {
    if (state.archiveSelection.has(key)) {
      state.archiveSelection.delete(key);
    } else {
      state.archiveSelection.add(key);
    }
    renderArchiveTab();
  }

  /* ---------- archive actions ---------- */

  function thumbnailKeyFor(name) {
    return allocateThumbKey(name);
  }

  async function promoteFile(sourceKey, destinationKey) {
    await state.client.copyObject(sourceKey, destinationKey);
    await state.client.deleteObject(sourceKey);
  }

  async function restoreArchived(files) {
    if (state.busy || files.length === 0) return;

    if (state.jsonError) {
      showBanner({
        title: 'gallery.json needs attention',
        message: 'Restoring needs a valid gallery.json so the new entries can be saved.',
      });
      return;
    }

    const candidates = files.filter((file) => !file.inGallery);
    const skipped = files.filter((file) => file.inGallery);

    if (candidates.length === 0) {
      showToast('Those images are already in the gallery.', 'error');
      return;
    }

    const choice = await askChoice({
      title: `Restore ${plural(candidates.length, 'image')} to the gallery?`,
      message: 'The original moves from archive/ to large/, a 500px thumbnail is written to thumbs/, and the entry is added to gallery.json.',
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Restore', value: 'go', variant: 'primary' },
      ],
    });
    if (choice !== 'go') return;

    setAppBusy(true);
    state.progress = { done: 0, total: candidates.length };
    showProgress();

    const failures = [];
    let restored = 0;

    for (const file of candidates) {
      let uploadedThumbKey = null;
      let entryRecorded = false;

      try {
        const blob = await state.client.getBlob(file.key);
        const takenAt = await readTakenAt(blob);

        const thumbnail = await createThumbnail(blob);
        const thumbKey = thumbnailKeyFor(file.name);
        uploadedThumbKey = thumbKey;

        await state.client.putObject(thumbKey, thumbnail, {
          contentType: 'image/jpeg',
          cacheControl: THUMB_CACHE_CONTROL,
        });

        await promoteFile(file.key, `large/${file.name}`);

        state.gallery.images.push({
          key: file.name,
          large: `large/${file.name}`,
          thumb: thumbKey,
          takenAt,
          uploadedAt: new Date().toISOString(),
          thumbUrl: '',
        });
        entryRecorded = true;

        try {
          await saveGallery();
        } catch (saveError) {
          state.lastSaveFailed = true;
          throw new Error(`gallery.json could not be saved: ${describeError(saveError)}`);
        }

        state.archiveSelection.delete(file.key);
        restored += 1;
        state.progress.done = restored;
        updateProgress();
      } catch (error) {
        failures.push(`${file.name}: ${describeError(error)}`);

        if (uploadedThumbKey && !entryRecorded) {
          try {
            await state.client.deleteObject(uploadedThumbKey);
          } catch (_cleanupError) {
            // The health tab will report the orphaned thumbnail.
          }
          state.usedThumbs.delete(uploadedThumbKey);
        }

        if (state.lastSaveFailed) break;
      }
    }

    hideProgress();

    try {
      await refreshListings();
    } catch (refreshError) {
      failures.push(`Could not refresh the bucket listing: ${describeError(refreshError)}`);
    }

    setAppBusy(false);
    renderAll();

    if (failures.length) {
      showBanner({
        title: state.lastSaveFailed ? 'gallery.json could not be saved' : 'Some images could not be restored',
        message: state.lastSaveFailed
          ? 'The files already moved are safe, but the gallery file is out of date. Retry before reloading the page.'
          : 'The rest of the batch completed.',
        items: failures,
        retry: state.lastSaveFailed,
      });
    } else {
      const note = skipped.length ? ` (${plural(skipped.length, 'image')} already in the gallery were skipped)` : '';
      showToast(`Restored ${plural(restored, 'image')} to the gallery.${note}`);
    }
  }

  async function deleteArchived(files) {
    if (state.busy || files.length === 0) return;

    const choice = await askChoice({
      title: `Delete ${plural(files.length, 'archived image')}?`,
      message: 'These files will be permanently deleted from archive/. They cannot be restored afterwards.',
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Delete permanently', value: 'go', variant: 'danger' },
      ],
    });
    if (choice !== 'go') return;

    setAppBusy(true);
    const failures = [];

    try {
      for (const file of files) {
        try {
          await state.client.deleteObject(file.key);
          state.archiveSelection.delete(file.key);
        } catch (error) {
          failures.push(`${file.name}: ${describeError(error)}`);
        }
      }

      try {
        await refreshListings();
      } catch (error) {
        failures.push(`Could not refresh the bucket listing: ${describeError(error)}`);
      }
    } finally {
      setAppBusy(false);
    }

    renderAll();

    if (failures.length) {
      showBanner({ title: 'Some archived images could not be deleted', items: failures });
    } else {
      showToast(`Deleted ${plural(files.length, 'archived image')}.`);
    }
  }

  async function extractCaptureDates(rescanAll) {
    if (state.busy || !state.client) return;

    const targets = state.gallery.images.filter((image) => rescanAll || !image.takenAt);

    if (targets.length === 0) {
      showToast('Every gallery image already has a capture date.');
      return;
    }

    if (state.jsonError) {
      showBanner({
        title: 'gallery.json needs attention',
        message: 'Capture dates are saved into gallery.json, so it must be valid first.',
      });
      return;
    }

    const choice = await askChoice({
      title: rescanAll ? 'Re-read every capture date?' : 'Extract missing capture dates?',
      message: `The first ${Math.round(EXIF_HEAD_BYTES / 1024)} KB of ${plural(targets.length, 'image')} will be read from large/. Dates are read from the photo's EXIF metadata. Images without EXIF keep their current date (or none).`,
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Extract', value: 'go', variant: 'primary' },
      ],
    });
    if (choice !== 'go') return;

    setAppBusy(true);
    state.dateScan = { done: 0, total: targets.length, found: 0 };
    renderHealthTab();

    const failures = [];
    let changed = false;

    for (const image of targets) {
      try {
        const head = await state.client.getBlob(image.large, { range: `bytes=0-${EXIF_HEAD_BYTES - 1}` });
        const Exif = window.BrewstockExif;
        const result = Exif ? Exif.read(await head.arrayBuffer()) : null;

        if (result && result.takenAt) {
          image.takenAt = result.takenAt;
          state.dateScan.found += 1;
          changed = true;
        } else if (rescanAll && image.takenAt) {
          image.takenAt = '';
          changed = true;
        }
      } catch (error) {
        failures.push(`${image.key}: ${describeError(error)}`);
      }

      state.dateScan.done += 1;
      renderHealthTab();
    }

    if (changed) {
      try {
        await saveGallery();
      } catch (error) {
        state.lastSaveFailed = true;
        failures.push(`gallery.json could not be saved: ${describeError(error)}`);
      }
    }

    const found = state.dateScan ? state.dateScan.found : 0;
    state.dateScan = null;
    setAppBusy(false);
    renderAll();

    if (failures.length) {
      showBanner({
        title: state.lastSaveFailed ? 'gallery.json could not be saved' : 'Some capture dates could not be read',
        items: failures,
        retry: state.lastSaveFailed,
      });
    } else {
      showToast(`Read ${plural(targets.length, 'image')} · ${found} capture ${found === 1 ? 'date' : 'dates'} found.`);
    }
  }

  function createCaptureDateSection() {
    const withDates = state.gallery.images.filter((image) => image.takenAt).length;
    const missing = state.gallery.images.length - withDates;
    const scanning = state.dateScan;

    const section = createElement('section', 'health-section');
    section.append(createElement('h3', null, 'Capture dates'));
    section.append(createElement(
      'p',
      'health-section__description',
      'The gallery can sort by the date a photo was taken, which comes from the EXIF metadata inside the original file. Images added before this existed have no stored date; extract them here. Only the first 256 KB of each file is downloaded.'
    ));

    const facts = createElement('dl', 'health-facts');
    facts.append(createElement('dt', null, 'With a capture date'));
    facts.append(createElement('dd', null, String(withDates)));
    facts.append(createElement('dt', null, 'Without a capture date'));
    facts.append(createElement('dd', null, String(missing)));
    section.append(facts);

    if (scanning) {
      section.append(createElement('p', 'health-section__description', `Reading ${Math.min(scanning.done + 1, scanning.total)} of ${scanning.total} · ${scanning.found} found…`));
      return section;
    }

    const actions = createElement('div', 'health-section__actions');

    const extract = createElement('button', 'btn btn--secondary btn--sm', missing > 0 ? 'Extract missing capture dates' : 'Nothing missing');
    extract.type = 'button';
    extract.dataset.healthAction = 'extract-dates';
    extract.disabled = state.busy || missing === 0;
    actions.append(extract);

    const rescan = createElement('button', 'btn btn--ghost btn--sm', 'Re-read all dates');
    rescan.type = 'button';
    rescan.dataset.healthAction = 'rescan-dates';
    rescan.disabled = state.busy || state.gallery.images.length === 0;
    actions.append(rescan);

    section.append(actions);
    return section;
  }

  function healthSummary() {
    const largeRefs = new Set(state.gallery.images.map((image) => image.large));
    const thumbRefs = new Set(state.gallery.images.map((image) => image.thumb));

    return {
      missingLarge: state.gallery.images.filter((image) => !state.listings.large.has(image.large)),
      missingThumb: state.gallery.images.filter((image) => !state.listings.thumbs.has(image.thumb)),
      orphanLarge: Array.from(state.listings.large).filter((key) => !largeRefs.has(key)).sort(),
      orphanThumb: Array.from(state.listings.thumbs).filter((key) => !thumbRefs.has(key)).sort(),
      duplicatesInRoot: state.newFiles.filter((file) => file.duplicate),
    };
  }

  function healthSection(title, description, actionLabel, actionName, items) {
    const section = createElement('section', 'health-section');

    const heading = createElement('div', 'health-section__heading');
    heading.append(createElement('h3', null, title));
    heading.append(createElement('span', 'health-section__count', String(items.length)));
    section.append(heading);

    section.append(createElement('p', 'health-section__description', description));

    if (items.length) {
      const list = createElement('ul', 'health-list');
      items.slice(0, 12).forEach((item) => list.append(createElement('li', null, item)));
      if (items.length > 12) {
        list.append(createElement('li', 'health-list__more', `…and ${items.length - 12} more`));
      }
      section.append(list);

      const action = createElement('button', 'btn btn--secondary btn--sm', actionLabel);
      action.type = 'button';
      action.dataset.healthAction = actionName;
      section.append(action);
    } else {
      section.append(createElement('p', 'health-section__ok', 'Nothing to fix.'));
    }

    return section;
  }

  function createConnectionTestSection() {
    const section = createElement('section', 'health-section');

    section.append(createElement('h3', null, 'Connection test'));
    section.append(createElement(
      'p',
      'health-section__description',
      'Checks the credentials without touching any photos: lists the bucket, writes and deletes a small test object under connection-check/, reads gallery.json, and loads one public thumbnail if the gallery has one.'
    ));

    const actions = createElement('div', 'health-section__actions');
    const button = createElement('button', 'btn btn--secondary btn--sm', 'Run connection test');
    button.type = 'button';
    button.dataset.healthAction = 'run-connection-test';
    button.disabled = state.busy || state.connectionTestRunning;
    actions.append(button);
    section.append(actions);

    if (state.connectionTestRunning) {
      section.append(createElement('p', 'health-section__description', 'Running connection tests…'));
    } else if (state.connectionTest) {
      const list = createElement('ul', 'health-list health-list--checks');

      state.connectionTest.forEach((result) => {
        const item = createElement('li', result.ok ? 'health-check health-check--ok' : 'health-check health-check--fail');
        item.append(createElement('strong', null, result.ok ? '✓ ' : '✗ '));
        item.append(document.createTextNode(result.label));
        if (result.detail) item.append(document.createTextNode(` — ${result.detail}`));
        list.append(item);
      });

      section.append(list);
    }

    return section;
  }

  function renderHealthTab() {
    const container = $('health-content');
    container.replaceChildren();

    if (state.jsonError) {
      container.append(createElement('p', 'health-section__description', 'Bucket health checks need a valid gallery.json.'));
      return;
    }

    const health = healthSummary();

    container.append(createConnectionTestSection());
    container.append(createCaptureDateSection());

    const layout = createElement('section', 'health-section');
    layout.append(createElement('h3', null, 'Bucket layout'));
    const facts = createElement('dl', 'health-facts');

    const addFact = (term, value) => {
      facts.append(createElement('dt', null, term));
      facts.append(createElement('dd', null, value));
    };

    addFact('gallery.json', state.jsonExists
      ? `${plural(state.gallery.images.length, 'image')} · updated ${formatDateTime(state.gallery.updatedAt) || 'unknown'}`
      : 'Not created yet');
    addFact('Root (new uploads)', `${plural(state.newFiles.length, 'image')}${state.otherRootFiles.length ? ` · ${plural(state.otherRootFiles.length, 'other file')} ignored` : ''}`);
    addFact('large/', plural(state.listings.large.size, 'object'));
    addFact('thumbs/', plural(state.listings.thumbs.size, 'object'));
    addFact('archive/', plural(state.listings.archive.size, 'object'));

    layout.append(facts);
    container.append(layout);

    container.append(healthSection(
      'Gallery entries with a missing large file',
      'These entries point at a large/ object that is not in the bucket. The gallery will show a broken image for them.',
      'Remove broken entries',
      'remove-missing-large',
      health.missingLarge.map((image) => image.key)
    ));

    container.append(healthSection(
      'Gallery entries with a missing thumbnail',
      'The full-size image exists, so the thumbnail can be rebuilt from it.',
      'Rebuild thumbnails',
      'rebuild-thumbs',
      health.missingThumb.map((image) => image.key)
    ));

    container.append(healthSection(
      'Orphaned thumbnails',
      'Thumbnails in thumbs/ that no gallery entry references. Safe to delete.',
      'Delete orphaned thumbnails',
      'delete-orphan-thumbs',
      health.orphanThumb
    ));

    container.append(healthSection(
      'Unreferenced large files',
      'Files in large/ that no gallery entry references. They are not shown in the gallery. Check these before deleting them.',
      'Delete unreferenced large files',
      'delete-orphan-large',
      health.orphanLarge
    ));

    container.append(healthSection(
      'Root files already in the gallery',
      'These images still exist in the bucket root even though they are already listed. Archive them to tidy the root.',
      'Archive duplicates from root',
      'archive-duplicates',
      health.duplicatesInRoot.map((file) => file.key)
    ));

    const cors = createElement('section', 'health-section');
    cors.append(createElement('h3', null, 'CORS policy'));
    cors.append(createElement(
      'p',
      'health-section__description',
      'The bucket needs this CORS policy before this tool or the gallery can call it from a browser. Set it once in the Cloudflare dashboard: R2 → your bucket → Settings → CORS Policy. It cannot be applied from here, because that request needs CORS to already be in place.'
    ));
    cors.append(createElement('pre', 'raw-json', JSON.stringify(CORS_POLICY, null, 2)));

    const corsActions = createElement('div', 'health-section__actions');

    const copyCors = createElement('button', 'btn btn--ghost btn--sm', 'Copy policy');
    copyCors.type = 'button';
    copyCors.dataset.healthAction = 'copy-cors';
    corsActions.append(copyCors);

    cors.append(corsActions);
    container.append(cors);
  }

  /* ---------- progress ---------- */

  function showProgress() {
    $('progress').hidden = false;
    updateProgress();
  }

  function updateProgress() {
    const { done, total } = state.progress;
    const percent = total ? Math.round((done / total) * 100) : 0;
    $('progress-fill').style.width = `${percent}%`;
    $('progress-label').textContent = total
      ? `Processing ${Math.min(done + 1, total)} of ${total}…`
      : '';
  }

  function hideProgress() {
    $('progress').hidden = true;
    $('progress-fill').style.width = '0%';
    $('progress-label').textContent = '';
  }

  /* ---------- capture dates ---------- */

  const EXIF_HEAD_BYTES = 256 * 1024;

  async function readTakenAt(blob) {
    const Exif = window.BrewstockExif;
    if (!Exif || !blob || typeof blob.slice !== 'function') return '';

    try {
      const head = blob.slice(0, EXIF_HEAD_BYTES);
      const result = Exif.read(await head.arrayBuffer());
      return result ? result.takenAt : '';
    } catch (_error) {
      return '';
    }
  }

  /* ---------- thumbnails ---------- */

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('this browser cannot decode the image. HEIC files only decode in Safari — convert the file to JPEG and upload it again'));
      image.src = url;
    });
  }

  function canvasToJpegBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the thumbnail'))),
        'image/jpeg',
        THUMB_QUALITY
      );
    });
  }

  async function createThumbnail(blob) {
    const objectUrl = URL.createObjectURL(blob);

    try {
      const image = await loadImage(objectUrl);
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) throw new Error('the image reported no dimensions');

      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('the browser could not create a canvas');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, targetWidth, targetHeight);

      if (scale === 1) {
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
      } else {
        // Halve repeatedly so the final downscale stays sharp.
        let source = image;
        let sourceWidth = width;
        let sourceHeight = height;

        while (sourceWidth / 2 >= targetWidth && sourceHeight / 2 >= targetHeight) {
          const step = document.createElement('canvas');
          step.width = Math.max(1, Math.round(sourceWidth / 2));
          step.height = Math.max(1, Math.round(sourceHeight / 2));

          const stepContext = step.getContext('2d');
          if (!stepContext) throw new Error('the browser could not create a canvas');

          stepContext.imageSmoothingEnabled = true;
          stepContext.imageSmoothingQuality = 'high';
          stepContext.drawImage(source, 0, 0, step.width, step.height);

          source = step;
          sourceWidth = step.width;
          sourceHeight = step.height;
        }

        context.drawImage(source, 0, 0, targetWidth, targetHeight);
      }

      return canvasToJpegBlob(canvas);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function allocateThumbKey(key) {
    const base = key.replace(/\.[^./]+$/, '') || key;
    let candidate = `thumbs/${base}.jpg`;
    let counter = 2;

    while (state.usedThumbs.has(candidate)) {
      candidate = `thumbs/${base}-${counter}.jpg`;
      counter += 1;
    }

    state.usedThumbs.add(candidate);
    return candidate;
  }

  /* ---------- gallery json ---------- */

  function serialiseGallery() {
    return JSON.stringify({
      version: 1,
      baseUrl: (state.config.publicBaseUrl || state.gallery.baseUrl || '').replace(/\/+$/, ''),
      updatedAt: new Date().toISOString(),
      images: state.gallery.images.map((image) => {
        const entry = {
          key: image.key,
          large: image.large,
          thumb: image.thumb,
        };

        if (image.takenAt) entry.takenAt = image.takenAt;
        if (image.uploadedAt) entry.uploadedAt = image.uploadedAt;

        return entry;
      }),
    }, null, 2);
  }

  async function saveGallery() {
    const payload = serialiseGallery();

    await state.client.putObject(JSON_KEY, payload, {
      contentType: 'application/json; charset=utf-8',
      cacheControl: JSON_CACHE_CONTROL,
    });

    const parsed = JSON.parse(payload);
    state.gallery.updatedAt = parsed.updatedAt;
    state.gallery.baseUrl = parsed.baseUrl;
    state.jsonExists = true;
    state.lastSaveFailed = false;
    renderStats();
  }

  function handleSaveError(error) {
    state.lastSaveFailed = true;
    showBanner({
      title: 'gallery.json could not be saved',
      message: `${describeError(error)} The files already in the bucket are safe, but the gallery file is out of date. Retry — do not reload the page first, or the unsaved changes in this tab are lost.`,
      retry: true,
    });
  }

  /* ---------- processing ---------- */

  async function processSelected(mode) {
    if (state.busy) return;

    const keys = state.newFiles
      .filter((file) => state.selection.has(file.key))
      .map((file) => file.key);

    if (keys.length === 0) return;
    if (mode === 'accept' && state.jsonError) return;

    const duplicates = state.newFiles.filter((file) => file.duplicate && state.selection.has(file.key));

    if (mode === 'archive') {
      const choice = await askChoice({
        title: `Archive ${plural(keys.length, 'image')}?`,
        message: 'Archived images move to archive/, are removed from the bucket root, and are never added to the gallery or given a thumbnail.',
        options: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Archive', value: 'go', variant: 'primary' },
        ],
      });
      if (choice !== 'go') return;
    } else if (duplicates.length) {
      const choice = await askChoice({
        title: `Accept ${plural(keys.length, 'image')}?`,
        message: `${plural(duplicates.length, 'selected image is', 'selected images are')} already in the gallery. Accepting again creates duplicate entries with a second thumbnail.`,
        options: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Accept anyway', value: 'go', variant: 'primary' },
        ],
      });
      if (choice !== 'go') return;
    }

    setAppBusy(true);
    state.progress = { done: 0, total: keys.length };
    showProgress();
    renderNewTab(false);

    const failures = [];
    let stopBatch = false;

    for (const key of keys) {
      if (stopBatch) break;

      const file = state.newFiles.find((item) => item.key === key);
      if (!file) continue;

      let uploadedThumbKey = null;
      let entryRecorded = false;

      try {
        if (mode === 'accept') {
          setCardStatus(key, 'Downloading…', 'busy');
          const blob = await state.client.getBlob(key);
          const takenAt = await readTakenAt(blob);

          setCardStatus(key, 'Creating thumbnail…', 'busy');
          const thumbnail = await createThumbnail(blob);
          const thumbKey = allocateThumbKey(key);
          uploadedThumbKey = thumbKey;

          setCardStatus(key, 'Uploading thumbnail…', 'busy');
          await state.client.putObject(thumbKey, thumbnail, {
            contentType: 'image/jpeg',
            cacheControl: THUMB_CACHE_CONTROL,
          });

          setCardStatus(key, 'Moving to large/…', 'busy');
          try {
            await state.client.copyObject(key, `large/${key}`);
          } catch (copyError) {
            // Fall back to writing the bytes we already downloaded.
            await state.client.putObject(`large/${key}`, blob, {
              contentType: blob.type || 'application/octet-stream',
            });
          }

          try {
            await state.client.deleteObject(key);
          } catch (deleteError) {
            failures.push(`${key}: copied to large/ but the original could not be deleted (${describeError(deleteError)}). Remove it manually.`);
          }

          state.gallery.images.push({
            key,
            large: `large/${key}`,
            thumb: thumbKey,
            takenAt,
            uploadedAt: new Date().toISOString(),
            thumbUrl: '',
          });
          entryRecorded = true;

          setCardStatus(key, 'Saving gallery.json…', 'busy');
          try {
            await saveGallery();
          } catch (saveError) {
            state.lastSaveFailed = true;
            throw new Error(`gallery.json could not be saved: ${describeError(saveError)}`);
          }
        } else {
          setCardStatus(key, 'Archiving…', 'busy');
          await state.client.copyObject(key, `archive/${key}`);
          try {
            await state.client.deleteObject(key);
          } catch (deleteError) {
            failures.push(`${key}: archived but the original could not be deleted (${describeError(deleteError)}). Remove it manually.`);
          }
        }

        setCardStatus(key, 'Done', 'done');
        state.newFiles = state.newFiles.filter((item) => item.key !== key);
        state.selection.delete(key);
        state.progress.done += 1;
        updateProgress();
      } catch (error) {
        failures.push(`${key}: ${describeError(error)}`);

        if (uploadedThumbKey && !entryRecorded) {
          try {
            await state.client.deleteObject(uploadedThumbKey);
          } catch (_cleanupError) {
            // The health tab will report the orphaned thumbnail.
          }
          state.usedThumbs.delete(uploadedThumbKey);
        }

        setCardStatus(key, error.message, 'error');

        if (state.lastSaveFailed) {
          stopBatch = true;
        }
      }
    }

    hideProgress();

    try {
      await refreshListings();
    } catch (refreshError) {
      failures.push(`Could not refresh the bucket listing: ${describeError(refreshError)}`);
    }

    setAppBusy(false);
    renderAll();

    if (failures.length) {
      showBanner({
        title: state.lastSaveFailed
          ? 'gallery.json could not be saved'
          : failures.length === 1
            ? 'One image needs attention'
            : `${failures.length} images need attention`,
        message: state.lastSaveFailed
          ? 'The files already in the bucket are safe, but the gallery file is out of date. Retry — do not reload the page first, or the unsaved changes in this tab are lost.'
          : 'The rest of the batch completed.',
        items: failures,
        retry: state.lastSaveFailed,
      });
    } else {
      const verb = mode === 'accept' ? 'Processed' : 'Archived';
      showToast(`${verb} ${plural(state.progress.done, 'image')}.`);
    }
  }

  /* ---------- processed image actions ---------- */

  async function removeImage(index) {
    const image = state.gallery.images[index];
    if (!image || state.busy) return;

    const choice = await askChoice({
      title: `Remove ${image.key}?`,
      message: 'Archive keeps the full-size file in archive/. Delete removes the large file and its thumbnail permanently. In both cases the entry is removed from gallery.json.',
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Archive file', value: 'archive', variant: 'primary' },
        { label: 'Delete permanently', value: 'delete', variant: 'danger' },
      ],
    });

    if (choice !== 'archive' && choice !== 'delete') return;

    setAppBusy(true);
    try {
      if (choice === 'archive') {
        await state.client.copyObject(image.large, `archive/${image.key}`);
        await state.client.deleteObject(image.large);
      } else {
        await state.client.deleteObject(image.large);
      }

      await state.client.deleteObject(image.thumb);
      state.gallery.images.splice(index, 1);
      state.usedThumbs.delete(image.thumb);

      try {
        await saveGallery();
      } catch (saveError) {
        handleSaveError(saveError);
        renderAll();
        return;
      }

      await refreshListings();
      renderAll();
      showToast(choice === 'archive' ? 'Image archived.' : 'Image deleted.');
    } catch (error) {
      showBanner({
        title: 'Could not remove the image',
        message: describeError(error),
        retry: state.lastSaveFailed,
      });
    } finally {
      setAppBusy(false);
      renderProcessedTab();
    }
  }

  async function moveImage(from, to) {
    const images = state.gallery.images;
    if (state.orderSaving) return;
    if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) return;

    const [item] = images.splice(from, 1);
    images.splice(to, 0, item);

    renderProcessedTab();

    state.orderSaving = true;
    try {
      await saveGallery();
      showToast('Gallery order saved.');
    } catch (error) {
      handleSaveError(error);
    } finally {
      state.orderSaving = false;
    }
  }

  /* ---------- health actions ---------- */

  async function deleteObjects(keys, title) {
    if (keys.length === 0 || state.busy) return;

    const choice = await askChoice({
      title,
      message: `${plural(keys.length, 'object')} will be permanently deleted from the bucket. This cannot be undone.`,
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Delete', value: 'go', variant: 'danger' },
      ],
    });
    if (choice !== 'go') return;

    setAppBusy(true);
    const failures = [];

    try {
      for (const key of keys) {
        try {
          await state.client.deleteObject(key);
        } catch (error) {
          failures.push(`${key}: ${describeError(error)}`);
        }
      }

      try {
        await refreshListings();
      } catch (error) {
        failures.push(`Could not refresh the bucket listing: ${describeError(error)}`);
      }
    } finally {
      setAppBusy(false);
    }

    renderAll();

    if (failures.length) {
      showBanner({ title: 'Some objects could not be deleted', items: failures });
    } else {
      showToast(`Deleted ${plural(keys.length, 'object')}.`);
    }
  }

  async function rebuildThumbnails(images) {
    if (images.length === 0 || state.busy) return;

    setAppBusy(true);
    const failures = [];

    try {
      for (const image of images) {
        try {
          const blob = await state.client.getBlob(image.large);
          const thumbnail = await createThumbnail(blob);
          await state.client.putObject(image.thumb, thumbnail, {
            contentType: 'image/jpeg',
            cacheControl: THUMB_CACHE_CONTROL,
          });
          image.thumbUrl = '';
        } catch (error) {
          failures.push(`${image.key}: ${describeError(error)}`);
        }
      }

      try {
        await refreshListings();
      } catch (error) {
        failures.push(`Could not refresh the bucket listing: ${describeError(error)}`);
      }
    } finally {
      setAppBusy(false);
    }

    renderAll();

    if (failures.length) {
      showBanner({ title: 'Some thumbnails could not be rebuilt', items: failures });
    } else {
      showToast(`Rebuilt ${plural(images.length, 'thumbnail')}.`);
    }
  }

  async function removeBrokenEntries(images) {
    if (images.length === 0 || state.busy) return;

    const choice = await askChoice({
      title: `Remove ${plural(images.length, 'broken entry', 'broken entries')}?`,
      message: 'Their gallery entries will be deleted. Thumbnails are left in the bucket and shown as orphaned afterwards.',
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Remove entries', value: 'go', variant: 'danger' },
      ],
    });
    if (choice !== 'go') return;

    const removeKeys = new Set(images.map((image) => image.key));
    state.gallery.images = state.gallery.images.filter((image) => !removeKeys.has(image.key));

    setAppBusy(true);
    try {
      await saveGallery();
      showToast('Broken entries removed.');
    } catch (error) {
      handleSaveError(error);
    } finally {
      setAppBusy(false);
    }

    renderAll();
  }

  async function archiveDuplicates(files) {
    if (files.length === 0 || state.busy) return;

    setAppBusy(true);
    const failures = [];

    try {
      for (const file of files) {
        try {
          await state.client.copyObject(file.key, `archive/${file.key}`);
          await state.client.deleteObject(file.key);
          state.selection.delete(file.key);
        } catch (error) {
          failures.push(`${file.key}: ${describeError(error)}`);
        }
      }

      try {
        await refreshListings();
      } catch (error) {
        failures.push(`Could not refresh the bucket listing: ${describeError(error)}`);
      }
    } finally {
      setAppBusy(false);
    }

    renderAll();

    if (failures.length) {
      showBanner({ title: 'Some duplicates could not be archived', items: failures });
    } else {
      showToast(`Archived ${plural(files.length, 'duplicate')}.`);
    }
  }

  async function copyCorsPolicy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(CORS_POLICY, null, 2));
      showToast('CORS policy copied.');
    } catch (_error) {
      showToast('Could not copy — select the policy text and copy it manually.', 'error');
    }
  }

  function testPublicImage(url) {
    return new Promise((resolve) => {
      const image = new Image();
      const timer = window.setTimeout(() => resolve(false), 10000);
      const settle = (ok) => {
        window.clearTimeout(timer);
        resolve(ok);
      };

      image.onload = () => settle(true);
      image.onerror = () => settle(false);
      image.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    });
  }

  async function runConnectionTest() {
    if (state.busy || state.connectionTestRunning || !state.client) return;

    state.connectionTest = null;
    state.connectionTestRunning = true;
    setAppBusy(true);
    renderHealthTab();

    const results = [];
    const testKey = `connection-check/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const token = `brewstock photo desk connection test ${Date.now()}`;

    try {
      try {
        await state.client.listObjects({ maxKeys: 1 });
        results.push({ ok: true, label: 'List bucket (read)', detail: 'permission confirmed' });
      } catch (error) {
        results.push({ ok: false, label: 'List bucket (read)', detail: describeError(error) });
      }

      let written = false;
      try {
        await state.client.putObject(testKey, token, {
          contentType: 'text/plain; charset=utf-8',
          cacheControl: 'no-store',
        });
        written = true;
        results.push({ ok: true, label: 'Write object', detail: 'permission confirmed' });
      } catch (error) {
        results.push({ ok: false, label: 'Write object', detail: describeError(error) });
      }

      if (written) {
        try {
          const text = await state.client.getText(testKey);
          const matched = text === token;
          results.push({
            ok: matched,
            label: 'Read object back',
            detail: matched ? 'contents matched' : 'the object was written but its contents did not match',
          });
        } catch (error) {
          results.push({ ok: false, label: 'Read object back', detail: describeError(error) });
        }

        try {
          await state.client.deleteObject(testKey);
          results.push({ ok: true, label: 'Delete object', detail: 'permission confirmed' });
        } catch (error) {
          results.push({ ok: false, label: 'Delete object', detail: describeError(error) });
        }
      }

      results.push({
        ok: true,
        label: 'gallery.json',
        detail: state.jsonExists ? `found (${plural(state.gallery.images.length, 'image')})` : 'not created yet — created on the first accepted image',
      });

      if (state.config.publicBaseUrl && state.gallery.images.length > 0) {
        const url = `${state.config.publicBaseUrl}/${state.gallery.images[0].thumb}`;
        const loaded = await testPublicImage(url);
        results.push({
          ok: loaded,
          label: 'Public thumbnail URL',
          detail: loaded ? url : `${url} did not load — check that the bucket has public access on this domain`,
        });
      } else {
        results.push({ ok: true, label: 'Public thumbnail URL', detail: 'skipped — no processed images yet' });
      }
    } finally {
      state.connectionTestRunning = false;
      state.connectionTest = results;
      setAppBusy(false);
      renderHealthTab();
    }
  }

  /* ---------- dialog ---------- */

  function askChoice(options) {
    const dialog = $('confirm-dialog');
    if (dialog.open) return Promise.resolve(null);

    $('confirm-title').textContent = options.title;
    $('confirm-message').textContent = options.message;

    const actions = dialog.querySelector('.confirm-dialog__actions');
    actions.replaceChildren();

    return new Promise((resolve) => {
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener('cancel', handleCancel);
        dialog.removeEventListener('keydown', handleKeydown);
        dialog.returnValue = value;
        if (dialog.open) dialog.close(value);
        resolve(value);
      };

      const handleCancel = (event) => {
        event.preventDefault();
        finish('cancel');
      };

      const handleKeydown = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        finish('cancel');
      };

      options.options.forEach((option) => {
        const variant = option.variant === 'primary' ? 'btn--primary' : option.variant === 'danger' ? 'btn--danger' : 'btn--ghost';
        const button = createElement('button', `btn ${variant}`, option.label);
        button.type = 'button';
        button.value = option.value;
        button.addEventListener('click', () => finish(option.value));
        actions.append(button);
      });

      dialog.addEventListener('cancel', handleCancel);
      dialog.addEventListener('keydown', handleKeydown);
      dialog.returnValue = 'cancel';
      dialog.showModal();
    });
  }

  /* ---------- events ---------- */

  function handleGridClick(event) {
    if (!isElement(event.target)) return;
    if (state.busy) return;

    const card = event.target.closest('.admin-card');
    if (!card || !$('new-grid').contains(card)) return;

    if (event.target.closest('.admin-card__select')) return;

    if (event.target.closest('.admin-card__open')) {
      openViewer('new', card.dataset.key, event.target.closest('.admin-card__open'));
      return;
    }

    toggleSelection(card.dataset.key);
  }

  function handleGridChange(event) {
    if (!isElement(event.target)) return;
    const checkbox = event.target.closest('.admin-card__select input[type="checkbox"]');
    if (!checkbox) return;

    const card = checkbox.closest('.admin-card');
    if (!card) return;

    if (checkbox.checked) {
      state.selection.add(card.dataset.key);
    } else {
      state.selection.delete(card.dataset.key);
    }
    renderNewTab(false);
  }

  function handleProcessedClick(event) {
    if (!isElement(event.target)) return;
    if (state.busy) return;

    const preview = event.target.closest('.admin-card__open');
    if (preview) {
      const previewCard = preview.closest('.admin-card--processed');
      if (!previewCard) return;
      openViewer('processed', state.gallery.images[Number(previewCard.dataset.index)].key, preview);
      return;
    }

    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const card = button.closest('.admin-card--processed');
    if (!card) return;

    const index = Number(card.dataset.index);
    const action = button.dataset.action;

    if (action === 'earlier') moveImage(index, index - 1);
    if (action === 'later') moveImage(index, index + 1);
    if (action === 'remove') removeImage(index);
  }

  function handleProcessedDragStart(event) {
    if (!isElement(event.target)) return;
    const card = event.target.closest('.admin-card--processed');
    if (!card) return;

    state.dragIndex = Number(card.dataset.index);
    card.classList.add('is-dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', card.dataset.index);
      } catch (_error) {
        // Some browsers block setData during dragstart; dragIndex is the fallback.
      }
    }
  }

  function handleProcessedDragOver(event) {
    if (!isElement(event.target)) return;
    const card = event.target.closest('.admin-card--processed');
    if (!card) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    $('processed-grid').querySelectorAll('.is-drop-target').forEach((element) => {
      if (element !== card) element.classList.remove('is-drop-target');
    });
    card.classList.add('is-drop-target');
  }

  function handleProcessedDrop(event) {
    if (!isElement(event.target)) return;
    const card = event.target.closest('.admin-card--processed');
    if (!card) return;

    event.preventDefault();

    let from = state.dragIndex;
    if (event.dataTransfer) {
      const value = event.dataTransfer.getData('text/plain');
      if (value !== '') from = Number(value);
    }

    const to = Number(card.dataset.index);
    clearDragStyles();

    if (Number.isFinite(from) && Number.isFinite(to)) moveImage(from, to);
  }

  function clearDragStyles() {
    state.dragIndex = null;
    $('processed-grid').querySelectorAll('.is-dragging, .is-drop-target').forEach((element) => {
      element.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  function handleArchiveClick(event) {
    if (!isElement(event.target) || state.busy) return;

    const card = event.target.closest('.admin-card');
    if (!card || !$('archive-grid').contains(card)) return;

    if (event.target.closest('.admin-card__select')) return;

    if (event.target.closest('.admin-card__open')) {
      openViewer('archive', card.dataset.key, event.target.closest('.admin-card__open'));
      return;
    }

    const restore = event.target.closest('button[data-action="restore"]');
    if (restore) {
      const file = state.archiveFiles.find((item) => item.key === card.dataset.key);
      if (file && !file.inGallery) restoreArchived([file]);
      return;
    }

    toggleArchiveSelection(card.dataset.key);
  }

  function handleArchiveChange(event) {
    if (!isElement(event.target)) return;
    const checkbox = event.target.closest('.admin-card__select input[type="checkbox"]');
    if (!checkbox) return;

    const card = checkbox.closest('.admin-card');
    if (!card) return;

    if (checkbox.checked) {
      state.archiveSelection.add(card.dataset.key);
    } else {
      state.archiveSelection.delete(card.dataset.key);
    }
    renderArchiveTab();
  }

  async function runHealthAction(name) {
    const health = healthSummary();

    if (name === 'delete-orphan-thumbs') {
      await deleteObjects(health.orphanThumb, 'Delete orphaned thumbnails?');
    } else if (name === 'delete-orphan-large') {
      await deleteObjects(health.orphanLarge, 'Delete unreferenced large files?');
    } else if (name === 'rebuild-thumbs') {
      await rebuildThumbnails(health.missingThumb);
    } else if (name === 'remove-missing-large') {
      await removeBrokenEntries(health.missingLarge);
    } else if (name === 'archive-duplicates') {
      await archiveDuplicates(health.duplicatesInRoot);
    } else if (name === 'run-connection-test') {
      await runConnectionTest();
    } else if (name === 'extract-dates') {
      await extractCaptureDates(false);
    } else if (name === 'rescan-dates') {
      await extractCaptureDates(true);
    } else if (name === 'copy-cors') {
      await copyCorsPolicy();
    }
  }

  function wireEvents() {
    $('setup-form').addEventListener('submit', handleConnect);
    $('btn-disconnect').addEventListener('click', handleDisconnect);

    $('btn-refresh').addEventListener('click', async () => {
      if (state.busy) return;
      setAppBusy(true);
      try {
        await loadData({ refreshPreviews: true });
        renderAll();
        showToast('Bucket refreshed.');
      } catch (error) {
        showBanner({ title: 'Could not refresh the bucket', message: describeError(error) });
      } finally {
        setAppBusy(false);
        renderAll();
      }
    });

    $('select-all').addEventListener('change', (event) => {
      const pageItems = pageSlice(visibleNewFiles(), state.newPage);
      if (event.target.checked) {
        pageItems.forEach((file) => state.selection.add(file.key));
      } else {
        pageItems.forEach((file) => state.selection.delete(file.key));
      }
      renderNewTab(false);
    });

    $('btn-clear-selection').addEventListener('click', () => {
      state.selection.clear();
      renderNewTab(false);
    });

    $('new-filter').addEventListener('input', (event) => {
      state.filter = event.target.value;
      state.newPage = 1;
      renderNewTab(true);
    });

    $('new-pager').addEventListener('click', (event) => {
      if (!isElement(event.target)) return;
      const button = event.target.closest('[data-pager-step]');
      if (!button) return;
      goToPage('new', Number(button.dataset.pagerStep));
    });

    $('processed-pager').addEventListener('click', (event) => {
      if (!isElement(event.target)) return;
      const button = event.target.closest('[data-pager-step]');
      if (!button) return;
      goToPage('processed', Number(button.dataset.pagerStep));
    });

    $('archive-pager').addEventListener('click', (event) => {
      if (!isElement(event.target)) return;
      const button = event.target.closest('[data-pager-step]');
      if (!button) return;
      goToPage('archive', Number(button.dataset.pagerStep));
    });

    $('admin-page-size').addEventListener('change', (event) => {
      setPageSize(event.target.value);
    });

    $('new-grid').addEventListener('click', handleGridClick);
    $('new-grid').addEventListener('change', handleGridChange);

    $('btn-accept').addEventListener('click', () => processSelected('accept'));
    $('btn-archive').addEventListener('click', () => processSelected('archive'));

    $('processed-grid').addEventListener('click', handleProcessedClick);
    $('processed-grid').addEventListener('dragstart', handleProcessedDragStart);
    $('processed-grid').addEventListener('dragover', handleProcessedDragOver);
    $('processed-grid').addEventListener('dragleave', (event) => {
      if (!isElement(event.target)) return;
      const card = event.target.closest('.admin-card--processed');
      if (card) card.classList.remove('is-drop-target');
    });
    $('processed-grid').addEventListener('drop', handleProcessedDrop);
    $('processed-grid').addEventListener('dragend', clearDragStyles);

    $('archive-grid').addEventListener('click', handleArchiveClick);
    $('archive-grid').addEventListener('change', handleArchiveChange);

    $('archive-select-all').addEventListener('change', (event) => {
      const pageItems = pageSlice(state.archiveFiles, state.archivePage);
      if (event.target.checked) {
        pageItems.forEach((file) => state.archiveSelection.add(file.key));
      } else {
        pageItems.forEach((file) => state.archiveSelection.delete(file.key));
      }
      renderArchiveTab();
    });

    $('btn-archive-clear').addEventListener('click', () => {
      state.archiveSelection.clear();
      renderArchiveTab();
    });

    $('btn-archive-restore').addEventListener('click', () => {
      const files = state.archiveFiles.filter((file) => state.archiveSelection.has(file.key));
      restoreArchived(files);
    });

    $('btn-archive-delete').addEventListener('click', () => {
      const files = state.archiveFiles.filter((file) => state.archiveSelection.has(file.key));
      deleteArchived(files);
    });

    $('btn-run-health').addEventListener('click', async () => {
      if (state.busy) return;
      setAppBusy(true);
      try {
        await refreshListings();
        renderAll();
        showToast('Bucket health re-scanned.');
      } catch (error) {
        showBanner({ title: 'Could not scan the bucket', message: describeError(error) });
      } finally {
        setAppBusy(false);
      }
    });

    $('health-content').addEventListener('click', (event) => {
      if (!isElement(event.target)) return;
      const button = event.target.closest('[data-health-action]');
      if (!button) return;
      runHealthAction(button.dataset.healthAction);
    });

    $('app-banner').addEventListener('click', async (event) => {
      if (!isElement(event.target)) return;
      const button = event.target.closest('button[data-action]');
      if (!button) return;

      if (button.dataset.action === 'dismiss-banner') {
        clearBanner();
      }

      if (button.dataset.action === 'retry-save') {
        try {
          await saveGallery();
          clearBanner();
          renderAll();
          showToast('gallery.json saved.');
        } catch (error) {
          handleSaveError(error);
        }
      }
    });

    document.querySelectorAll('.admin-tab').forEach((button) => {
      button.addEventListener('click', () => setActiveTab(button.dataset.tab));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const tabs = Array.from(document.querySelectorAll('.admin-tab'));
        const index = tabs.indexOf(button);
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        setActiveTab(next.dataset.tab);
      });
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.busy) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function init() {
    if (!R2) {
      setSetupError('The R2 client failed to load. Check that js/r2.js exists.');
      return;
    }

    restoreSetupForm();
    wireEvents();
    wireViewerEvents();
    setActiveTab('new');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
