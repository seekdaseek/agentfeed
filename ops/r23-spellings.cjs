// ops/r23-spellings.cjs: the 24 spellings of a priced path the R19 sweep sends unpaid (copied from test/briefs-real-server.test.js so the live sweep and the real-server tests agree).
// Indexes 0, 1, 3 and 4 (plain, trailing slash, upper case, /API/) are the spellings the paywall answers with a 402; any other may 404 or 400, but none may be served.
'use strict';
const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir = parts.join('/');
  return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir + '/' + encodeURIComponent(last).replace(/-/g, '%2D'),
    dir + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
const CHALLENGE_INDEXES = [0, 1, 3, 4];
module.exports = { variants, CHALLENGE_INDEXES };
