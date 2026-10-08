// test/well-known-claims.test.js — the directory claim files are served exactly,
// and only when a well-formed value has been written.
//
// Run:  node --test test/well-known-claims.test.js        (from the service root)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { mountWellKnownClaims } = require('../lib/well-known-claims');

async function serve(dir) {
  const app = express();
  mountWellKnownClaims(app, dir);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, get: (p) => fetch(base + p) };
}

test('absent value: 404, so the route is inert until a claim is in progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const { srv, get } = await serve(dir);
  try {
    assert.equal((await get('/.well-known/402index-verify.txt')).status, 404);
    assert.equal((await get('/.well-known/nohumans-claim')).status, 404);
  } finally { srv.close(); }
});

test('a written hash is served verbatim as text/plain, uncached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const hash = 'a'.repeat(64);
  fs.writeFileSync(path.join(dir, '402index-verify.txt'), hash + '\n');
  const { srv, get } = await serve(dir);
  try {
    const r = await get('/.well-known/402index-verify.txt');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), hash);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally { srv.close(); }
});

test('a malformed value (whitespace inside, or oversized) is not served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  fs.writeFileSync(path.join(dir, '402index-verify.txt'), 'two words');
  fs.writeFileSync(path.join(dir, 'nohumans-claim'), 'x'.repeat(600));
  const { srv, get } = await serve(dir);
  try {
    assert.equal((await get('/.well-known/402index-verify.txt')).status, 404);
    assert.equal((await get('/.well-known/nohumans-claim')).status, 404);
  } finally { srv.close(); }
});
