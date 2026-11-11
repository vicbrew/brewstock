/**
 * Request-building tests for photo-desk/js/r2.js.
 *
 * Stubs fetch so the URLs, headers and bodies sent to R2 can be checked
 * without a real bucket. Run with: node testing/r2-client.test.js
 *
 * The key pair below is the public example credential published in the AWS
 * Signature Version 4 documentation — it is not a real credential.
 */
'use strict';

const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { createClient, internals } = require('../photo-desk/js/r2.js');

const { EMPTY_SHA256 } = internals;

const client = createClient({
  accountId: '0123456789abcdef0123456789abcdef',
  bucket: 'brewstock-images',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  publicBaseUrl: 'https://img.brewstock.org/',
});

const calls = [];
const originalFetch = globalThis.fetch;

function headerValue(headers, name) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return new Response(null, { status: 200 });
};

function lastCall() {
  return calls[calls.length - 1];
}

async function run() {
  // putObject: encoded key, signed content headers, hashed payload.
  const body = '{"hello":"world"}';
  await client.putObject('photos/Été 2026 #1.jpg', body, {
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=60',
  });

  let call = lastCall();
  assert.strictEqual(call.init.method, 'PUT');
  assert.strictEqual(
    call.url,
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/brewstock-images/photos/%C3%89t%C3%A9%202026%20%231.jpg'
  );
  assert.strictEqual(headerValue(call.init.headers, 'content-type'), 'application/json; charset=utf-8');
  assert.strictEqual(headerValue(call.init.headers, 'cache-control'), 'public, max-age=60');
  assert.strictEqual(headerValue(call.init.headers, 'host'), undefined, 'Host must be left to fetch');
  assert.match(headerValue(call.init.headers, 'authorization'), /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
  assert.match(headerValue(call.init.headers, 'x-amz-content-sha256'), /^[0-9a-f]{64}$/);
  assert.strictEqual(
    headerValue(call.init.headers, 'x-amz-content-sha256'),
    createHash('sha256').update(body).digest('hex'),
    'string payload hash must match the UTF-8 bytes'
  );

  // Blob payloads must be hashed from their bytes, not their string form.
  const thumbBytes = Buffer.from('pretend this is a jpeg thumbnail');
  await client.putObject('thumbs/photo.jpg', new Blob([thumbBytes], { type: 'image/jpeg' }), {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=86400',
  });
  call = lastCall();
  assert.strictEqual(
    headerValue(call.init.headers, 'x-amz-content-sha256'),
    createHash('sha256').update(thumbBytes).digest('hex'),
    'blob payload hash must match the blob bytes'
  );

  const signedHeaders = /SignedHeaders=([a-z0-9;-]+)/.exec(headerValue(call.init.headers, 'authorization'))[1].split(';');
  assert.ok(signedHeaders.includes('host'), 'host must be signed');
  assert.ok(signedHeaders.includes('content-type'), 'content-type must be signed');
  assert.ok(signedHeaders.includes('cache-control'), 'cache-control must be signed');
  assert.ok(signedHeaders.includes('x-amz-content-sha256'), 'payload hash header must be signed');

  // copyObject: path-style copy source with the key encoded once.
  await client.copyObject('photos/Été 2026 #1.jpg', 'large/photos/Été 2026 #1.jpg');
  call = lastCall();
  assert.strictEqual(call.init.method, 'PUT');
  assert.strictEqual(
    call.url,
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/brewstock-images/large/photos/%C3%89t%C3%A9%202026%20%231.jpg'
  );
  assert.strictEqual(
    headerValue(call.init.headers, 'x-amz-copy-source'),
    '/brewstock-images/photos/%C3%89t%C3%A9%202026%20%231.jpg'
  );
  const copySigned = /SignedHeaders=([a-z0-9;-]+)/.exec(headerValue(call.init.headers, 'authorization'))[1].split(';');
  assert.ok(copySigned.includes('x-amz-copy-source'), 'copy source header must be signed');

  // deleteObject: empty payload hash, DELETE verb.
  await client.deleteObject('large/photos/Été 2026 #1.jpg');
  call = lastCall();
  assert.strictEqual(call.init.method, 'DELETE');
  assert.strictEqual(headerValue(call.init.headers, 'x-amz-content-sha256'), EMPTY_SHA256);

  // Presigned URL: query auth with host as the only signed header.
  const presigned = await client.presignGet('thumbs/Été 2026 #1.jpg', 600);
  assert.match(presigned, /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/brewstock-images\/thumbs\/%C3%89t%C3%A9%202026%20%231\.jpg\?/);
  assert.match(presigned, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(presigned, /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F\d{8}%2Fauto%2Fs3%2Faws4_request/);
  assert.match(presigned, /X-Amz-Expires=600/);
  assert.match(presigned, /X-Amz-SignedHeaders=host/);
  assert.match(presigned, /X-Amz-Signature=[0-9a-f]{64}$/);
  assert.ok(presigned.indexOf('X-Amz-Algorithm') < presigned.indexOf('X-Amz-Credential'), 'query params sorted');

  // Public base URL is normalised.
  assert.strictEqual(client.config.publicBaseUrl, 'https://img.brewstock.org');

  console.log('R2 request-building tests passed (6 checks).');
}

run()
  .catch((error) => {
    console.error('R2 request-building tests FAILED:', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
