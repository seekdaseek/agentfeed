// solwatch-mcp — read-only MCP server for the solwatch VPS. Streamable HTTP, stateless.
// Auth: Authorization: Bearer <MCP_TOKEN>. No writes, no shell passthrough, no .env access.
import express from "express";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3025);
const TOKEN = process.env.MCP_TOKEN || "";
if (TOKEN.length < 24) { console.error("MCP_TOKEN missing or <24 chars; refusing to start"); process.exit(1); }
const HEALTH_URLS = (process.env.HEALTH_URLS ||
  "https://x402.ochinimus.app,https://alibi.ochinimus.app,https://ochinimus.app/inspector,https://nomen.ochinimus.app/health"
).split(",").map(s => s.trim()).filter(Boolean);
const DB_ALLOW = (process.env.DB_ALLOW || "").split(",").map(s => s.trim()).filter(Boolean);

const sha = s => createHash("sha256").update(s).digest();
const okAuth = h => typeof h === "string" && h.startsWith("Bearer ") && timingSafeEqual(sha(h.slice(7)), sha(TOKEN));
const run = (cmd, args, timeout = 8000) => new Promise(res =>
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (e, so, se) => res({ e, so: String(so), se: String(se) })));
const text = s => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 1) }] });
const fail = s => ({ content: [{ type: "text", text: "ERROR: " + s }], isError: true });
async function pm2list() {
  const { e, so, se } = await run("pm2", ["jlist"]);
  if (e) throw new Error("pm2 jlist failed: " + (se || e.message).slice(0, 200));
  return JSON.parse(so.slice(so.indexOf("[")));
}

function build() {
  const srv = new McpServer({ name: "solwatch-mcp", version: "1.1.0" });
  srv.registerTool("pm2_status", { description: "All PM2 processes on the solwatch VPS: status, uptime, restarts, cpu, memory, cwd. Read-only." }, async () => {
    try {
      const l = await pm2list();
      return text(l.map(p => ({ name: p.name, status: p.pm2_env?.status, restarts: p.pm2_env?.restart_time,
        up_min: p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) : null,
        mem_mb: p.monit ? Math.round(p.monit.memory / 1048576) : null, cpu: p.monit?.cpu, cwd: p.pm2_env?.pm_cwd })));
    } catch (err) { return fail(err.message); }
  });
  srv.registerTool("health_check", { description: "HTTP status of the judged/production URLs (x402, alibi, inspector, nomen). Read-only GETs with 6s timeout." }, async () => {
    const out = await Promise.all(HEALTH_URLS.map(async u => {
      try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
        const r = await fetch(u, { redirect: "follow", signal: ac.signal }); clearTimeout(t);
        return { url: u, code: r.status, ok: r.ok }; }
      catch (e) { return { url: u, code: 0, ok: false, err: String(e && e.cause ? (e.cause.code || e.cause) : e).slice(0, 80) }; }
    }));
    return text(out);
  });
  srv.registerTool("log_tail", {
    description: "Tail a PM2 process log (out or err). Only processes pm2 knows; only their own log files.",
    inputSchema: { service: z.string(), which: z.enum(["out", "err"]).optional(), lines: z.number().int().min(1).max(200).optional() },
  }, async ({ service, which = "out", lines = 40 }) => {
    try {
      const l = await pm2list();
      const p = l.find(x => x.name === service);
      if (!p) return fail("unknown service: " + service + " (known: " + l.map(x => x.name).join(", ") + ")");
      const f = which === "err" ? p.pm2_env?.pm_err_log_path : p.pm2_env?.pm_out_log_path;
      if (!f) return fail("no " + which + " log path for " + service);
      const { e, so } = await run("tail", ["-n", String(lines), f]);
      if (e) return fail("tail failed: " + e.message);
      return text(so || "(empty)");
    } catch (err) { return fail(err.message); }
  });
  srv.registerTool("sql_query", {
    description: "Read-only SELECT against an allowlisted sqlite DB on the VPS. Single statement, 200-row cap. Allowed DBs: " + DB_ALLOW.join(", "),
    inputSchema: { db: z.string(), query: z.string().max(2000) },
  }, async ({ db, query }) => {
    if (!DB_ALLOW.includes(db)) return fail("db not on allowlist: " + db);
    const q = query.trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(q)) return fail("only SELECT/WITH");
    if (q.includes(";")) return fail("single statement only");
    if (/\b(attach|pragma|insert|update|delete|drop|alter|create|replace|vacuum|load_extension|writefile|readfile|edit|fts3_tokenizer)\b/i.test(q)) return fail("read-only");
    try { await stat(db); } catch { return fail("db file not found: " + db); }
    const { e, so, se } = await run("sqlite3", ["-readonly", "-json", db, q + " LIMIT 200"], 10000);
    if (e) return fail("sqlite3: " + (se || e.message).slice(0, 300));
    return text(so.trim() || "[]");
  });
  srv.registerTool("host_stats", { description: "Disk, memory, load and uptime of the VPS. Read-only." }, async () => {
    const [d, m, u] = await Promise.all([run("df", ["-h", "/"]), run("free", ["-m"]), run("uptime", [])]);
    return text({ df: d.so.trim(), free: m.so.trim(), uptime: u.so.trim() });
  });
  srv.registerTool("cron_list", { description: "root crontab, verbatim. Read-only." }, async () => {
    const { e, so, se } = await run("crontab", ["-l"]);
    return e ? fail((se || e.message).slice(0, 200)) : text(so);
  });
  const CODE_EXT = /\.(js|mjs|cjs|ts|sh|sql|md|yml|yaml)$/i;
  const PATH_DENY = /(^|\/)(\.env|\.git|node_modules|credentials|wallet|keypair|secrets?)(\/|$|\.)|\.(pem|key|p12|jks|keystore)$|id_(rsa|ed25519)/i;
  const redact = s => String(s)
    .replace(/\b0x[0-9a-fA-F]{32,}\b/g, "0x<REDACTED>")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{40,}\b/g, "<REDACTED-B58>")
    .replace(/\b[0-9a-fA-F]{40,}\b/g, "<REDACTED-HEX>")
    .replace(/((?:api[_-]?key|secret|token|password|passphrase|private[_-]?key|mnemonic|seed)\s*[:=]\s*)(["'`]?)([^\s"'`,;)]{8,})\2/gi, "$1$2<REDACTED>$2");
  const okPath = p => p.startsWith("/opt/") && !PATH_DENY.test(p) && CODE_EXT.test(p);
  srv.registerTool("source_search", {
    description: "Search source files under /opt for a fixed string (grep -rnF). Code/text files only (js,mjs,cjs,ts,sh,sql,md,yml,yaml); .env, keys, credentials, node_modules and .git are excluded. Secret-looking values are redacted. Read-only.",
    inputSchema: { dir: z.string(), pattern: z.string().min(2).max(200), max: z.number().int().min(1).max(100).optional() },
  }, async ({ dir, pattern, max = 40 }) => {
    if (!dir.startsWith("/opt/") || dir.includes("..")) return fail("dir must be under /opt and contain no ..");
    const { so } = await run("grep", ["-rnF", "--binary-files=without-match",
      "--include=*.js", "--include=*.mjs", "--include=*.cjs", "--include=*.ts", "--include=*.sh", "--include=*.sql", "--include=*.md", "--include=*.yml", "--include=*.yaml",
      "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude=.env*", pattern, dir], 15000);
    const lines = so.split("\n").filter(Boolean).filter(l => okPath(l.split(":")[0])).slice(0, max);
    return text(lines.length ? redact(lines.join("\n")) : "(no matches)");
  });
  srv.registerTool("source_read", {
    description: "Read one source file under /opt. Code/text files only; .env, keys, credentials and node_modules refused. Secret-looking values are redacted. 400-line cap. Read-only.",
    inputSchema: { path: z.string(), start: z.number().int().min(1).optional(), lines: z.number().int().min(1).max(400).optional() },
  }, async ({ path, start = 1, lines = 200 }) => {
    if (path.includes("..")) return fail("no .. in path");
    if (!okPath(path)) return fail("path refused: must be under /opt, an allowed code extension, and not a secret/credential path");
    try { await stat(path); } catch { return fail("file not found: " + path); }
    const { e, so } = await run("sed", ["-n", start + "," + (start + lines - 1) + "p", path], 10000);
    if (e) return fail("read failed: " + e.message);
    return text(so ? redact(so) : "(empty range)");
  });
  srv.registerTool("db_schema", {
    description: "Table names, row counts and CREATE statements for an allowlisted sqlite DB. Read this before writing any query against a DB you have not seen. Read-only.",
    inputSchema: { db: z.string() },
  }, async ({ db }) => {
    if (!DB_ALLOW.includes(db)) return fail("db not on allowlist: " + db + " | allowed: " + DB_ALLOW.join(", "));
    try { await stat(db); } catch { return fail("db file not found: " + db); }
    const q = "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    const { e, so, se } = await run("sqlite3", ["-readonly", "-json", db, q], 10000);
    if (e) return fail("sqlite3: " + (se || e.message).slice(0, 300));
    let rows = []; try { rows = JSON.parse(so || "[]"); } catch { return fail("could not parse schema"); }
    const out = [];
    for (const r of rows) {
      const c = await run("sqlite3", ["-readonly", db, "SELECT COUNT(*) FROM \"" + r.name + "\""], 10000);
      out.push({ table: r.name, rows: c.e ? null : Number(c.so.trim()), ddl: r.sql });
    }
    return text(out);
  });
  srv.registerTool("git_status", {
    description: "For each service under /opt with a git repo: current branch, short HEAD, whether the working tree is dirty, and the list of changed files. Proves deployed code matches the repo. Read-only, never fetches or writes.",
    inputSchema: { service: z.string().optional() },
  }, async ({ service }) => {
    const { so } = await run("bash", ["-lc", "ls -1d /opt/*/ 2>/dev/null"], 8000);
    let dirs = so.split("\n").filter(Boolean).map(d => d.replace(/\/$/, ""));
    if (service) dirs = dirs.filter(d => d.endsWith("/" + service));
    if (!dirs.length) return fail("no such service under /opt: " + service);
    const out = [];
    for (const d of dirs.slice(0, 60)) {
      const head = await run("git", ["-C", d, "rev-parse", "--short", "HEAD"], 8000);
      if (head.e) { if (!service) continue; out.push({ service: d.split("/").pop(), git: false }); continue; }
      const br = await run("git", ["-C", d, "rev-parse", "--abbrev-ref", "HEAD"], 8000);
      const st = await run("git", ["-C", d, "status", "--porcelain"], 8000);
      const rem = await run("git", ["-C", d, "config", "--get", "remote.origin.url"], 8000);
      const files = st.so.split("\n").filter(Boolean).map(l => l.trim()).slice(0, 20);
      out.push({ service: d.split("/").pop(), branch: br.so.trim(), head: head.so.trim(),
        remote: rem.so.trim().replace(/\/\/[^@]*@/, "//"), dirty: files.length > 0, changed: files });
    }
    return text(out.length ? out : "(no git repos found under /opt)");
  });
  srv.registerTool("brief", {
    description: "One-call situation report: PM2 anomalies, health of the judged URLs, disk and memory, and every cron whose log file has not been written in over 24h. Use this at the start of a session instead of calling four tools. Read-only.",
  }, async () => {
    const rep = {};
    try {
      const l = await pm2list();
      rep.pm2 = { total: l.length,
        not_online: l.filter(p => p.pm2_env?.status !== "online").map(p => p.name + ":" + p.pm2_env?.status),
        restarted: l.filter(p => (p.pm2_env?.restart_time || 0) > 0).map(p => p.name + ":" + p.pm2_env.restart_time) };
    } catch (err) { rep.pm2 = "ERROR: " + err.message; }
    rep.health = await Promise.all(HEALTH_URLS.map(async u => {
      try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
        const r = await fetch(u, { redirect: "follow", signal: ac.signal }); clearTimeout(t);
        return u + " " + r.status; }
      catch { return u + " DOWN"; }
    }));
    const [d, m] = await Promise.all([run("df", ["-h", "/"]), run("free", ["-m"])]);
    rep.disk = (d.so.split("\n")[1] || "").trim();
    rep.mem = (m.so.split("\n")[1] || "").trim();
    const stale = await run("bash", ["-lc",
      "for f in $(crontab -l 2>/dev/null | grep -oE '>>? *[^ ]+\\.log' | tr -d '>' ); do " +
      "[ -f \"$f\" ] || { echo \"MISSING $f\"; continue; }; " +
      "find \"$f\" -mmin +1440 -printf 'STALE %p (%TY-%Tm-%Td %TH:%TM)\\n' 2>/dev/null; done | sort -u | head -20"], 12000);
    rep.stale_cron_logs = stale.so.split("\n").filter(Boolean);
    return text(rep);
  });
  srv.registerTool("submission_verify", {
    description: "Check a hackathon/grant submission against the polish bar: repo public, LICENSE present, README present, commit count inside the judging window, and every live URL returning 2xx. Every line is a fetched fact, never an assumption. Read-only.",
    inputSchema: { repo: z.string(), urls: z.array(z.string()).max(8).optional(), since: z.string().optional() },
  }, async ({ repo, urls = [], since }) => {
    const slug = repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return fail("repo must be owner/name or a github.com URL, got: " + repo);
    const API = process.env.GITHUB_API || "https://api.github.com";
    const gh = async (p) => {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
        const h = { "user-agent": "solwatch-mcp", accept: "application/vnd.github+json" };
        if (process.env.GITHUB_TOKEN) h.authorization = "Bearer " + process.env.GITHUB_TOKEN;
        const r = await fetch(API + "/repos/" + slug + p, { signal: ac.signal, headers: h });
        clearTimeout(t);
        const rl = r.headers.get("x-ratelimit-remaining");
        return { code: r.status, rl, body: r.status === 200 ? await r.json() : null };
      } catch (e) { return { code: 0, body: null, err: String(e).slice(0, 60) }; }
    };
    const out = {};
    const meta = await gh("");
    if (meta.code === 404) { out.repo = "FAIL: not found or private (404) — " + slug; return text(out); }
    if (meta.code === 403 && meta.rl === "0") { out.repo = "UNKNOWN: GitHub API rate limit exhausted for this IP (60/hr unauthenticated). Nothing was checked. Set GITHUB_TOKEN in .env to raise it to 5000/hr."; return text(out); }
    if (meta.code !== 200) { out.repo = "UNKNOWN: github api returned " + meta.code + (meta.err ? " " + meta.err : ""); return text(out); }
    out.repo = (meta.body.private ? "FAIL: repo is PRIVATE" : "PASS: public") + " — " + slug +
      " | default branch " + meta.body.default_branch + " | last push " + meta.body.pushed_at;
    const lic = await gh("/license");
    out.license = lic.code === 200 ? "PASS: " + (lic.body.license?.spdx_id || "present") : "FAIL: no LICENSE file (" + lic.code + ")";
    const rd = await gh("/readme");
    out.readme = rd.code === 200 ? "PASS: " + (rd.body.name || "present") + " " + (rd.body.size || 0) + "b" : "FAIL: no README (" + rd.code + ")";
    const q = since ? "/commits?per_page=100&since=" + encodeURIComponent(since) : "/commits?per_page=100";
    const cm = await gh(q);
    if (cm.code === 200 && Array.isArray(cm.body)) {
      const n = cm.body.length;
      out.commits = (since ? "since " + since + ": " : "recent: ") + n + (n === 100 ? "+ (page cap)" : "") +
        (n ? " | newest " + cm.body[0].commit?.author?.date + " | oldest on page " + cm.body[n - 1].commit?.author?.date : "");
      if (since && n === 0) out.commits = "FAIL: zero commits since " + since;
    } else out.commits = "UNKNOWN: commits api " + cm.code;
    if (urls.length) {
      out.urls = await Promise.all(urls.map(async u => {
        try {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
          const r = await fetch(u, { redirect: "follow", signal: ac.signal }); clearTimeout(t);
          return (r.ok ? "PASS " : "FAIL ") + r.status + " " + u;
        } catch (e) { return "FAIL DOWN " + u + " (" + String(e && e.cause ? (e.cause.code || e.cause) : e).slice(0, 40) + ")"; }
      }));
    }
    return text(out);
  });
  const revenueInput = { db: z.string().optional(), days: z.number().int().min(1).max(3650).optional() };
  const revenueHandler = async ({ db = "/opt/agentfeed/agentfeed.db", days = 30 }) => {
    if (!DB_ALLOW.includes(db)) return fail("db not on allowlist: " + db + " | allowed: " + DB_ALLOW.join(", "));
    try { await stat(db); } catch { return fail("db file not found: " + db); }
    const q = async (sql) => {
      const { e, so, se } = await run("sqlite3", ["-readonly", "-json", db, sql], 10000);
      if (e) throw new Error((se || e.message).slice(0, 200));
      try { return JSON.parse(so || "[]"); } catch { return []; }
    };
    try {
      const tables = (await q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map(r => r.name);
      // Discover by COLUMN SHAPE, not just table name. AgentFeed records payments as rows in
      // `calls` with status='paid' — a name-only search is blind to that. Sep 5 2026.
      const cand = [];
      for (const t of tables) {
        if (/pay|invoice|settle|revenue|charge|receipt|call|request|usage|log/i.test(t)) { cand.push(t); continue; }
        const cn = (await q("SELECT name FROM pragma_table_info('" + t + "')")).map(r => String(r.name).toLowerCase());
        const hasAmt = cn.some(n => /^(usd|amount|amount_usd|price|value|usd_amount)$/.test(n));
        const hasPay = cn.some(n => /^(payer|payer_address|from_address|wallet|tx|tx_sig|tx_hash|signature|status)$/.test(n));
        if (hasAmt && hasPay) cand.push(t);
      }
      if (!cand.length) return text({ db, tables, result: "NO PAYMENT-SHAPED TABLE FOUND. Nothing was counted. Searched table names for pay/invoice/settle/revenue/charge/receipt/call/request/usage/log, and every table for an amount column beside a payer/tx/status column." });
      const out = { db, window_days: days, tables_examined: cand };
      const since = Date.now() - days * 86400000;
      for (const t of cand) {
        const info = await q("SELECT name FROM pragma_table_info('" + t + "')");
        const names = info.map(r => r.name);
        const tsCol = names.find(n => /^ts$|timestamp|created_at|paid_at|settled_at|^time$/i.test(n));
        const amtCol = names.find(n => /amount|usd|price|^value$|^fee$/i.test(n) && !/latency|count|status/i.test(n));
        const toolCol = names.find(n => /^tool|route|endpoint|resource|^method$/i.test(n));
        const payerCol = names.find(n => /payer|wallet|^from|account|sender/i.test(n));
        const statusCol = names.find(n => /^status$|^state$|^result$/i.test(n));
        const total = (await q("SELECT COUNT(*) AS n FROM \"" + t + "\""))[0]?.n ?? 0;
        const rec = { table: t, columns: names, rows_all_time: total };
        if (!tsCol) { rec.note = "no timestamp column found; only all-time count is reported"; out[t] = rec; continue; }
        const mx = (await q("SELECT MAX(\"" + tsCol + "\") AS m FROM \"" + t + "\""))[0]?.m ?? 0;
        const scale = Number(mx) > 1e11 ? 1 : 1000;
        const bound = Math.floor(since / scale);
        rec.ts_column = tsCol + (scale === 1 ? " (milliseconds)" : " (seconds)");
        rec.rows_in_window = (await q("SELECT COUNT(*) AS n FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound))[0]?.n ?? 0;
        rec.NOTE = "rows_in_window counts ALL rows; sums, by_tool and payer counts below are scoped to the paid status once identified.";
        let paidVal = null;
        if (statusCol) {
          rec.by_status = await q("SELECT \"" + statusCol + "\" AS status, COUNT(*) AS n FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound + " GROUP BY 1 ORDER BY n DESC");
          rec.by_status_all_time = await q("SELECT \"" + statusCol + "\" AS status, COUNT(*) AS n FROM \"" + t + "\" GROUP BY 1 ORDER BY n DESC");
          const vals = rec.by_status_all_time.map(r => String(r.status));
          paidVal = vals.find(v => /^(paid|settled|success|ok|complete[d]?)$/i.test(v)) || null;
          rec.paid_status_value = paidVal || "NONE MATCHED — revenue figures below cover ALL rows, not just successful payments";
          // R31 (14 Nov 2026): the dead-tool test had two faults. (1) An erroring tool counted 'payment_refused' rows, which are 402 refusals of a buyer's payment
          // (the tool never ran), so a tool whose only trouble was a legacy client's refused payments was listed. (2) A success was only status 'paid', so a tool served
          // by prepaid keys ('key', 15k rows in agentfeed.db) or free calls ('free') showed 0 successes: all six tools listed on 14 Nov had 1 to 19 'key' successes in the window.
          // Revenue sums still use the paid status alone; only the dead-tool test counts every status that means the tool served a response.
          const errVals = vals.filter(v => /error|fail|denied|refus/i.test(v) && !/^payment_refused$/i.test(v));
          const servedVals = vals.filter(v => /^(paid|settled|success|ok|complete[d]?|key|free)$/i.test(v));
          if (toolCol && errVals.length && paidVal) {
            const inList = errVals.map(v => "'" + v.replace(/'/g, "''") + "'").join(",");
            rec.erroring_tools = await q("SELECT \"" + toolCol + "\" AS tool, COUNT(*) AS errors FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound + " AND \"" + statusCol + "\" IN (" + inList + ") GROUP BY 1 ORDER BY errors DESC LIMIT 15");
            const dead = [];
            for (const r of rec.erroring_tools) {
              const servedIn = servedVals.map(v => "'" + v.replace(/'/g, "''") + "'").join(",");
              const ok = (await q("SELECT COUNT(*) AS n FROM \"" + t + "\" WHERE \"" + toolCol + "\" = '" + String(r.tool).replace(/'/g, "''") + "' AND \"" + statusCol + "\" IN (" + servedIn + ") AND \"" + tsCol + "\" >= " + bound))[0]?.n ?? 0;
              if (ok === 0) dead.push(r.tool + " (" + r.errors + " errors, 0 successes in window: no " + servedVals.join("/") + " row)");
            }
            if (dead.length) rec.DEAD_TOOLS = dead;
          }
        }
        const paidWhere = paidVal ? " AND \"" + statusCol + "\" = '" + paidVal.replace(/'/g, "''") + "'" : "";
        if (amtCol) {
          const s = (await q("SELECT ROUND(SUM(\"" + amtCol + "\"),6) AS s FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound + paidWhere))[0]?.s;
          rec.sum_in_window = s ?? 0;
          rec.sum_all_time = (await q("SELECT ROUND(SUM(\"" + amtCol + "\"),6) AS s FROM \"" + t + "\" WHERE 1=1" + paidWhere))[0]?.s ?? 0;
        }
        if (toolCol) rec.by_tool = await q("SELECT \"" + toolCol + "\" AS tool, COUNT(*) AS calls" + (amtCol ? ", ROUND(SUM(\"" + amtCol + "\"),6) AS usd" : "") + " FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound + paidWhere + " GROUP BY 1 ORDER BY calls DESC LIMIT 25");
        if (payerCol) {
          rec.distinct_payers_in_window = (await q("SELECT COUNT(DISTINCT \"" + payerCol + "\") AS n FROM \"" + t + "\" WHERE \"" + tsCol + "\" >= " + bound + paidWhere))[0]?.n ?? 0;
          rec.distinct_payers_all_time = (await q("SELECT COUNT(DISTINCT \"" + payerCol + "\") AS n FROM \"" + t + "\" WHERE 1=1" + paidWhere))[0]?.n ?? 0;
        }
        // Rail split. mpp_claim is written ONLY by the MPP gate (mpp/store.js claimSignature /
        // settleClaim / releaseClaim), so a paid row whose tx_sig appears there settled over MPP
        // and any other paid row settled over x402. A paid row with a NULL tx_sig cannot be
        // attributed to either rail and is reported on its own line, never folded into x402.
        // Both the joined table and its key column are DISCOVERED, never assumed, and any failure
        // here degrades to a note instead of failing the whole tool.
        if (amtCol && statusCol && paidVal && names.includes("tx_sig") && tables.includes("mpp_claim")) {
          try {
            const mppCols = (await q("SELECT name FROM pragma_table_info('mpp_claim')")).map(r => String(r.name));
            if (!mppCols.includes("signature")) {
              rec.by_rail_note = "SKIPPED: an mpp_claim table exists but has no signature column (" + mppCols.join(", ") + "), so no rail split was attempted.";
            } else {
              const pv = paidVal.replace(/'/g, "''");
              const a = "c.\"" + amtCol + "\"";
              const railSql = (scope) =>
                "SELECT COUNT(*) AS all_calls, ROUND(COALESCE(SUM(" + a + "),0),6) AS all_usd," +
                " COALESCE(SUM(CASE WHEN m.signature IS NOT NULL THEN 1 ELSE 0 END),0) AS mpp_calls," +
                " ROUND(COALESCE(SUM(CASE WHEN m.signature IS NOT NULL THEN " + a + " END),0),6) AS mpp_usd," +
                " COALESCE(SUM(CASE WHEN m.signature IS NULL AND c.tx_sig IS NOT NULL THEN 1 ELSE 0 END),0) AS x402_calls," +
                " ROUND(COALESCE(SUM(CASE WHEN m.signature IS NULL AND c.tx_sig IS NOT NULL THEN " + a + " END),0),6) AS x402_usd," +
                " COALESCE(SUM(CASE WHEN c.tx_sig IS NULL THEN 1 ELSE 0 END),0) AS unattr_calls," +
                " ROUND(COALESCE(SUM(CASE WHEN c.tx_sig IS NULL THEN " + a + " END),0),6) AS unattr_usd" +
                " FROM \"" + t + "\" c LEFT JOIN \"mpp_claim\" m ON c.tx_sig = m.signature" +
                " WHERE c.\"" + statusCol + "\" = '" + pv + "'" + scope;
              const shape = (r) => ({
                all: { calls: r?.all_calls ?? 0, usd: r?.all_usd ?? 0 },
                mpp: { calls: r?.mpp_calls ?? 0, usd: r?.mpp_usd ?? 0 },
                x402: { calls: r?.x402_calls ?? 0, usd: r?.x402_usd ?? 0 },
                unattributed_null_tx_sig: { calls: r?.unattr_calls ?? 0, usd: r?.unattr_usd ?? 0 },
              });
              rec.by_rail_in_window = shape((await q(railSql(" AND c.\"" + tsCol + "\" >= " + bound)))[0]);
              rec.by_rail_all_time = shape((await q(railSql("")))[0]);
              rec.by_rail_note = "mpp = settled through the MPP gate (tx_sig present in mpp_claim, a table only mpp/store.js writes); x402 = paid row whose tx_sig is not an MPP claim; unattributed_null_tx_sig = paid row with no signature recorded, which cannot be attributed to a rail. mpp + x402 + unattributed = all, by construction.";
            }
          } catch (e) {
            rec.by_rail_note = "RAIL SPLIT FAILED (the rest of this report is unaffected): " + String(e && e.message ? e.message : e).slice(0, 200);
          }
        }
        if (rec.rows_in_window === 0) rec.verdict = "ZERO payments in the last " + days + " days" + (total ? " (all-time rows: " + total + ")" : " and none all time");
        out[t] = rec;
      }
      return text(out);
    } catch (err) { return fail(String(err.message || err).slice(0, 300)); }
  };
  const revenueDesc = "Inbound PAID API revenue on AgentFeed across BOTH settlement rails — x402 and MPP — not x402 alone: totals, per-rail split (by_rail_in_window / by_rail_all_time), per-tool and per-payer breakdown over a window. All money and payer figures are scoped to the paid status. DISCOVERS the payment table and columns from the schema rather than assuming names, and says plainly when no payment table exists or when the count is zero. Read-only.";
  srv.registerTool("paid_revenue", { description: revenueDesc, inputSchema: revenueInput }, revenueHandler);
  srv.registerTool("x402_revenue", { description: "DEPRECATED ALIAS of paid_revenue, identical output. The old name is wrong: this reports BOTH the x402 and MPP rails, not x402 alone. Kept so existing callers do not break; call paid_revenue instead. Read-only.", inputSchema: revenueInput }, revenueHandler);
  return srv;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
let stamps = [];
app.post("/mcp", async (req, res) => {
  if (!okAuth(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });
  const now = Date.now(); stamps = stamps.filter(t => now - t < 60000);
  if (stamps.length >= 120) return res.status(429).json({ error: "rate limited" });
  stamps.push(now);
  try {
    const srv = build();
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { tr.close(); srv.close(); });
    await srv.connect(tr);
    await tr.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
  }
});
app.get("/mcp", (_q, r) => r.status(405).set("Allow", "POST").json({ error: "POST only (stateless)" }));
app.delete("/mcp", (_q, r) => r.status(405).json({ error: "stateless" }));
app.get("/", (_q, r) => r.status(200).json({ ok: true, name: "solwatch-mcp" }));
app.listen(PORT, "127.0.0.1", () => console.log("solwatch-mcp listening on 127.0.0.1:" + PORT));
