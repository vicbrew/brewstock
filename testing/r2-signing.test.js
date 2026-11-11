/**
 * SigV4 self-test for photo-desk/js/r2.js.
 *
 * Uses the published AWS Signature Version 4 examples so the hand-rolled
 * signer can be checked without touching a real bucket. The key pair is the
 * public example credential from the AWS documentation, not a real credential.
 *
 * Run with: node testing/r2-signing.test.js
 */
'use strict';

const assert = require('node:assert');
const { internals } = require('../photo-desk/js/r2.js');

const { signRequest, buildCanonicalQuery, toAmzDate, EMPTY_SHA256 } = internals;

const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AMZ_DATE = '20130524T000000Z';
const DATE_STAMP = '20130524';

async function run() {
  // AWS docs — "Example: GET Object" (range request on /test.txt)
  const getObject = await signRequest({
    method: 'GET',
    canonicalUri: '/test.txt',
    canonicalQuery: '',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    payloadHash: EMPTY_SHA256,
    amzDate: AMZ_DATE,
    dateStamp: DATE_STAMP,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  assert.strictEqual(
    getObject.signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    'GET object signature'
  );

  // AWS docs — "Example: GET Bucket Lifecycle"
  const getLifecycle = await signRequest({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: 'lifecycle=',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    payloadHash: EMPTY_SHA256,
    amzDate: AMZ_DATE,
    dateStamp: DATE_STAMP,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  assert.strictEqual(
    getLifecycle.signature,
    'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    'GET lifecycle signature'
  );

  // AWS docs — "Example: List Objects"
  const listObjects = await signRequest({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: 'max-keys=2&prefix=J',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    payloadHash: EMPTY_SHA256,
    amzDate: AMZ_DATE,
    dateStamp: DATE_STAMP,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  assert.strictEqual(
    listObjects.signature,
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    'list objects signature'
  );

  // AWS docs — "Example: Query string authentication" (presigned URL)
  const presigned = await signRequest({
    method: 'GET',
    canonicalUri: '/test.txt',
    canonicalQuery: [
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
      'X-Amz-Date=20130524T000000Z',
      'X-Amz-Expires=86400',
      'X-Amz-SignedHeaders=host',
    ].join('&'),
    headers: { host: 'examplebucket.s3.amazonaws.com' },
    payloadHash: 'UNSIGNED-PAYLOAD',
    amzDate: AMZ_DATE,
    dateStamp: DATE_STAMP,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });

  assert.strictEqual(
    presigned.signature,
    'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    'presigned URL signature'
  );

  // Query canonicalisation: sorted by name, RFC 3986 encoded.
  assert.strictEqual(
    buildCanonicalQuery({ prefix: 'a b', 'list-type': '2', 'continuation-token': 'x+y/z=' }),
    'continuation-token=x%2By%2Fz%3D&list-type=2&prefix=a%20b'
  );

  // Timestamp formatting.
  assert.strictEqual(toAmzDate(new Date('2026-11-11T07:50:57.568Z')), '20261111T075057Z');

  console.log('SigV4 signing self-test passed (4 AWS vectors + helpers).');
}

run().catch((error) => {
  console.error('SigV4 signing self-test FAILED:', error.message);
  process.exitCode = 1;
});
