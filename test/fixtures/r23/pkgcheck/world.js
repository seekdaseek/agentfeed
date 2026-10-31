// test/fixtures/r23/pkgcheck/world.js: a fake upstream world for the pkg-check tests. It answers the exact URLs the tool builds from the synthetic fixture files next to it
// (every package here is named example-*; maintainers are handles like maint-one), records every call, and lets a test replace any answer with a status, a body or an error.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeList } = require('../../../../tools/r23/pkg-check-typo');

const dir = __dirname;
const read = (f) => fs.readFileSync(path.join(dir, f));
const json = (f) => JSON.parse(read(f).toString('utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const NOW = Date.parse('2026-10-31T12:00:00Z');

// url -> a document name or an object { status, body (Buffer|object|string), headers }
const GET_TABLE = {
  'https://registry.npmjs.org/example-widget-kit': 'npm-widget.json',
  'https://registry.npmjs.org/example-widget-kit/latest': 'npm-widget-latest.json',
  'https://registry.npmjs.org/example-widget-kit/2.0.0': 'npm-widget-latest.json',
  'https://registry.npmjs.org/example-bad-widget': 'npm-bad-widget.json',
  'https://registry.npmjs.org/example-holder': 'npm-holding.json',
  'https://api.npmjs.org/downloads/point/last-week/example-widget-kit': 'downloads-npm.json',
  'https://pypi.org/pypi/example-pylib/json': 'pypi-pylib.json',
  'https://pypi.org/pypi/example-pylib/1.1.0/json': 'pypi-pylib-1.1.0.json',
  'https://pypistats.org/api/packages/example-pylib/recent': 'pypistats.json',
};
const OSV_TABLE = {
  'npm|example-widget-kit|2.0.0': 'osv-widget-2.0.0.json',
  'npm|example-bad-widget|1.0.0': 'osv-mal-1.0.0.json',
};

function reply(spec) {
  if (spec instanceof Error) throw spec;
  if (typeof spec === 'string') return { status: 200, contentType: 'application/json', headers: {}, body: read(spec) };
  const body = spec.body;
  return { status: spec.status || 200, contentType: 'application/json', headers: spec.headers || {}, body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body)) };
}

/** `getOverrides` maps a url to a spec/Error; `osvOverride(body)` may return a spec/Error for a given OSV request body (or undefined to use the table). */
function makeWorld({ now = NOW, getOverrides = {}, osvOverride = null, extraGet = {} } = {}) {
  const calls = [];
  const table = { ...GET_TABLE, ...extraGet };
  return {
    calls,
    deps: {
      now: () => now,
      async get(url, opts) {
        calls.push({ method: 'GET', url, opts });
        if (Object.prototype.hasOwnProperty.call(getOverrides, url)) return reply(getOverrides[url]);
        if (Object.prototype.hasOwnProperty.call(table, url)) return reply(table[url]);
        return reply({ status: 404, body: { error: 'Not found' } });
      },
      async post(url, body, opts) {
        calls.push({ method: 'POST', url, body, opts });
        if (url !== 'https://api.osv.dev/v1/query') return reply({ status: 404, body: {} });
        const o = osvOverride ? osvOverride(body) : undefined;
        if (o !== undefined) return reply(o);
        const key = `${body.package.ecosystem === 'npm' ? 'npm' : 'pypi'}|${body.package.name}|${body.version}`;
        return Object.prototype.hasOwnProperty.call(OSV_TABLE, key) ? reply(OSV_TABLE[key]) : reply({ status: 200, body: {} });
      },
    },
  };
}

/** small bundled lists for the typosquat rule: rank = position */
const NPM_LIST = ['example-popular', 'example-widget-kits', 'react', 'lodash', 'left-pad', 'abcdefgh-ui', '@example-scope/core-utils', 'date-fns', 'lodash-es', 'python-style'];
const PYPI_LIST = ['requests', 'python-dateutil', 'colorama', 'example-popular-lib', 'jellyfish'];
const lists = () => ({ npm: makeList(NPM_LIST, { ranked: true, ecosystem: 'npm' }), pypi: makeList(PYPI_LIST, { ranked: false, ecosystem: 'pypi' }) });

module.exports = { makeWorld, json, read, clone, lists, NOW, NPM_LIST, PYPI_LIST, GET_TABLE, OSV_TABLE };
