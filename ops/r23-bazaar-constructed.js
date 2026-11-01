// ops/r23-bazaar-constructed.js [tools...]: add or refresh the CONSTRUCTED Bazaar entries of the R23 tools in bazaar-examples.json, on the Mac, with no network and no box data.
// Runs gen-bazaar-meta.js --recapture=<tools> --constructed behind the preload the real-server tests use (test/helpers/af-test-preload.js: every outbound connection refused,
// /opt/agentfeed paths redirected to a scratch folder). With no argument it takes every tool of tools/r23/index.js that carries an `example`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { writeFiles } = require(path.join(ROOT, 'test', 'helpers', 'brief-files'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-bazaar-'));
try {
  process.env.AGENTFEED_DB = ':memory:';
  const tools = process.argv.length > 2 ? process.argv.slice(2) : [...require(path.join(ROOT, 'tools', 'r23')).entries, ...require(path.join(ROOT, 'tools', 'r24')).entries].filter((e) => e.example != null).map((e) => e.name);
  if (!tools.length) throw new Error('no tool to build');
  const env = { ...process.env, ...writeFiles(dir), AF_ROOT: ROOT, AF_NET_LOG: path.join(dir, 'net.log'), NODE_ENV: 'test' };
  execFileSync(process.execPath, ['--require', path.join(ROOT, 'test', 'helpers', 'af-test-preload.js'), path.join(ROOT, 'gen-bazaar-meta.js'), `--recapture=${tools.join(',')}`, '--constructed'], { env, cwd: ROOT, stdio: 'inherit' });
  console.log(`constructed entries written for: ${tools.join(', ')}`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
