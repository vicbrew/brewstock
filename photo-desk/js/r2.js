/**
 * Minimal Cloudflare R2 (S3-compatible) client for the browser.
 *
 * Implements AWS Signature Version 4 directly so the gallery admin needs no
 * build step and no third-party SDK. Credentials are held in memory only —
 * nothing is written to disk or localStorage.
 *
 * Loaded as a classic script in the admin page (window.BrewstockR2) and via
 * require() by testing/r2-signing.test.js.
 */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BrewstockR2 = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALGORITHM = 'AWS4-HMAC-SHA256';
  const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const encoder = new TextEncoder();

  /* ---------- encoding helpers ---------- */

  function encodeRfc3986(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  }

  function encodeKeyPath(key) {
    if (!key) return '';
    return String(key).split('/').map(encodeRfc3986).join('/');
  }

  function buildCanonicalQuery(params) {
    return Object.keys(params || {})
      .filter((name) => params[name] !== undefined && params[name] !== null)
      .map((name) => [String(name), String(params[name])])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
      .join('&');
  }

  function toHex(bytes) {
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function toAmzDate(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  /* ---------- crypto helpers ---------- */

  function toBytes(body) {
    if (typeof body === 'string') return encoder.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return encoder.encode(String(body));
  }

  async function sha256Hex(data) {
    let bytes;

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      bytes = toBytes(data);
    }

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
  }

  async function hmacSha256(keyBytes, message) {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
    return new Uint8Array(signature);
  }

  async function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
    let key = await hmacSha256(encoder.encode('AWS4' + secretAccessKey), dateStamp);
    key = await hmacSha256(key, region);
    key = await hmacSha256(key, service);
    return hmacSha256(key, 'aws4_request');
  }

  /**
   * Build the SigV4 signature for an already-canonicalised request.
   * Exposed for the signing self-test in testing/r2-signing.test.js.
   */
  async function signRequest(options) {
    const method = options.method || 'GET';
    const normalized = {};

    Object.keys(options.headers || {}).forEach((name) => {
      normalized[name.toLowerCase()] = String(options.headers[name]).trim().replace(/\s+/g, ' ');
    });

    const signedHeaderNames = Object.keys(normalized).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${normalized[name]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      options.canonicalUri,
      options.canonicalQuery || '',
      canonicalHeaders,
      signedHeaders,
      options.payloadHash,
    ].join('\n');

    const credentialScope = `${options.dateStamp}/${options.region}/${options.service}/aws4_request`;
    const stringToSign = [
      ALGORITHM,
      options.amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = await deriveSigningKey(options.secretAccessKey, options.dateStamp, options.region, options.service);
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    return {
      signature,
      canonicalRequest,
      stringToSign,
      credentialScope,
      signedHeaders,
      authorization: `${ALGORITHM} Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  /* ---------- XML helpers ---------- */

  function parseXml(text) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('DOMParser is not available in this environment.');
    }
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('R2 returned a response that could not be parsed.');
    }
    return doc;
  }

  function xmlText(parent, tagName) {
    const node = parent.getElementsByTagName(tagName)[0];
    return node ? node.textContent : '';
  }

  function createR2Error(response, body) {
    let code = '';
    let message = '';

    try {
      const doc = parseXml(body);
      code = xmlText(doc, 'Code');
      message = xmlText(doc, 'Message');
    } catch (_error) {
      // Non-XML error body; fall through to the generic message.
    }

    const error = new Error(message || `R2 request failed (${response.status} ${response.statusText})`);
    error.name = 'R2Error';
    error.status = response.status;
    error.code = code;
    return error;
  }

  /* ---------- client ---------- */

  function createClient(config) {
    const accountId = (config.accountId || '').trim();
    const endpoint = (config.endpoint || `https://${accountId}.r2.cloudflarestorage.com`).trim().replace(/\/+$/, '');
    const bucket = (config.bucket || '').trim();
    const accessKeyId = (config.accessKeyId || '').trim();
    const secretAccessKey = (config.secretAccessKey || '').trim();
    const region = (config.region || 'auto').trim();
    const service = 's3';

    if (!endpoint) throw new Error('An R2 endpoint or account ID is required.');
    if (!bucket) throw new Error('A bucket name is required.');
    if (!accessKeyId || !secretAccessKey) throw new Error('An access key ID and secret access key are required.');

    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:') throw new Error('The R2 endpoint must use https.');
    const host = endpointUrl.host;

    async function request(options) {
      const method = options.method || 'GET';
      const key = options.key || '';
      const body = options.body === undefined ? null : options.body;
      const amzDate = toAmzDate(options.date || new Date());
      const dateStamp = amzDate.slice(0, 8);
      const payloadHash = body === null ? EMPTY_SHA256 : await sha256Hex(body);

      const headers = Object.assign({}, options.headers || {});
      headers.host = host;
      headers['x-amz-date'] = amzDate;
      headers['x-amz-content-sha256'] = payloadHash;

      const canonicalUri = `/${encodeRfc3986(bucket)}${key ? '/' + encodeKeyPath(key) : ''}`;
      const canonicalQuery = buildCanonicalQuery(options.query || {});
      const auth = await signRequest({
        method,
        canonicalUri,
        canonicalQuery,
        headers,
        payloadHash,
        amzDate,
        dateStamp,
        region,
        service,
        accessKeyId,
        secretAccessKey,
      });

      const fetchHeaders = Object.assign({}, headers, { Authorization: auth.authorization });
      delete fetchHeaders.host;

      const url = `${endpoint}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
      let response;

      try {
        response = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: body === null ? undefined : body,
          cache: options.cache || 'default',
        });
      } catch (cause) {
        const error = new Error(
          'Could not reach R2. Check the account ID and the bucket CORS policy (this page calls R2 directly from your browser).'
        );
        error.name = 'R2NetworkError';
        error.cause = cause;
        throw error;
      }

      if (options.allow404 && response.status === 404) {
        return null;
      }

      if (options.allow204 && response.status === 204) {
        return null;
      }

      if (!response.ok) {
        throw createR2Error(response, await response.text());
      }

      if (options.responseType === 'blob') return response.blob();
      if (options.responseType === 'none') return null;
      return response.text();
    }

    async function listObjects(options) {
      const settings = options || {};
      const objects = [];
      const prefixes = [];
      let continuationToken = null;

      do {
        const query = {
          'list-type': '2',
          'max-keys': String(settings.maxKeys || 1000),
        };
        if (settings.prefix) query.prefix = settings.prefix;
        if (settings.delimiter) query.delimiter = settings.delimiter;
        if (continuationToken) query['continuation-token'] = continuationToken;

        const xml = await request({ method: 'GET', query, responseType: 'text' });
        const doc = parseXml(xml);

        Array.from(doc.getElementsByTagName('Contents')).forEach((node) => {
          objects.push({
            key: xmlText(node, 'Key'),
            size: Number(xmlText(node, 'Size')) || 0,
            lastModified: xmlText(node, 'LastModified'),
            etag: xmlText(node, 'ETag'),
          });
        });

        Array.from(doc.getElementsByTagName('CommonPrefixes')).forEach((node) => {
          const prefix = xmlText(node, 'Prefix');
          if (prefix) prefixes.push(prefix);
        });

        continuationToken = xmlText(doc.documentElement, 'IsTruncated') === 'true'
          ? xmlText(doc.documentElement, 'NextContinuationToken')
          : null;
      } while (continuationToken);

      return { objects, prefixes };
    }

    async function getText(key, options) {
      return request(Object.assign({
        method: 'GET',
        key,
        responseType: 'text',
        allow404: true,
        cache: 'no-store',
      }, options || {}));
    }

    async function getBlob(key) {
      return request({ method: 'GET', key, responseType: 'blob' });
    }

    async function putObject(key, body, options) {
      const settings = options || {};
      const headers = { 'content-type': settings.contentType || 'application/octet-stream' };
      if (settings.cacheControl) headers['cache-control'] = settings.cacheControl;

      await request({ method: 'PUT', key, headers, body, responseType: 'none' });
    }

    async function copyObject(sourceKey, destinationKey) {
      const source = `/${bucket}/${encodeKeyPath(sourceKey)}`;
      await request({
        method: 'PUT',
        key: destinationKey,
        headers: { 'x-amz-copy-source': source },
        responseType: 'text',
      });
    }

    async function deleteObject(key) {
      await request({ method: 'DELETE', key, responseType: 'none', allow204: true });
    }

    /**
     * Create a time-limited GET URL so <img> tags can load objects directly.
     */
    async function presignGet(key, expiresIn) {
      const now = new Date();
      const amzDate = toAmzDate(now);
      const dateStamp = amzDate.slice(0, 8);
      const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
      const canonicalUri = `/${encodeRfc3986(bucket)}/${encodeKeyPath(key)}`;
      const params = {
        'X-Amz-Algorithm': ALGORITHM,
        'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expiresIn || 3600),
        'X-Amz-SignedHeaders': 'host',
      };
      const canonicalQuery = buildCanonicalQuery(params);
      const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
      const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
      const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
      const signature = toHex(await hmacSha256(signingKey, stringToSign));

      return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    }

    return {
      config: {
        accountId,
        endpoint,
        bucket,
        region,
        accessKeyId,
        publicBaseUrl: (config.publicBaseUrl || '').replace(/\/+$/, ''),
      },
      host,
      listObjects,
      getText,
      getBlob,
      putObject,
      copyObject,
      deleteObject,
      presignGet,
    };
  }

  return {
    createClient,
    internals: {
      ALGORITHM,
      EMPTY_SHA256,
      encodeRfc3986,
      encodeKeyPath,
      buildCanonicalQuery,
      deriveSigningKey,
      signRequest,
      toAmzDate,
    },
  };
});
