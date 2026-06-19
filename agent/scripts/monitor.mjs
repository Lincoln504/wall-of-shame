#!/usr/bin/env node
/**
 * monitor.mjs — single-pane observability for the Wall of Shame scale-loop and the
 * pi-research engine underneath it. Reads only on-disk artifacts (the loop log + data
 * files), so it is safe to run at any time against a live loop without touching its state.
 *
 * It answers, at a glance: is the loop alive, how fast is it populating, when will it
 * hit target, and — critically — what is pi-research actually erroring on right now.
 * The error taxonomy mirrors the failure modes surfaced by sustained runs so an operator
 * can trust the system to report its own health instead of tailing a 9k-line log.
 *
 * Usage:
 *   node scripts/monitor.mjs            one-shot snapshot
 *   node scripts/monitor.mjs --watch    refresh every 30s (Ctrl-C to stop)
 *   node scripts/monitor.mjs --watch=15 refresh every 15s
 *   node scripts/monitor.mjs --errors   include the recent raw error lines
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(__dirname, '..');
const LOG = path.join(AGENT, 'scale-loop.log');
const FINDINGS = path.join(AGENT, 'data', 'findings.json');
const FLAGGED = path.join(AGENT, 'data', 'flagged-review.json');
// pi-research writes a structured JSON-lines engine log (WARN/ERROR always; INFO/DEBUG
// only when PI_RESEARCH_DEBUG=true). Default sink is $TMPDIR/pi-research.log, redirectable
// via PI_RESEARCH_LOG_PATH. We read it directly so engine-level faults surface here too.
const PI_LOG = process.env.PI_RESEARCH_LOG_PATH || process.env.PI_RESEARCH_LOG_FILE ||
  path.join(process.env.TMPDIR || '/tmp', 'pi-research.log');

const watchArg = process.argv.find(a => a.startsWith('--watch'));
const WATCH = watchArg ? (parseInt(watchArg.split('=')[1]) || 30) : 0;
const SHOW_ERRORS = process.argv.includes('--errors');

// Error taxonomy: label -> matcher. Order matters (first match wins per line).
const SIGNATURES = [
  ['healthcheck timeout (pool busy → ABORTED category)', /Browser healthcheck failed: Health check timed out/],
  ['healthcheck busy → PROCEEDED (fix active)',          /healthcheck probe queued out under load, but the pool is operational/],
  ['provider/upstream error',                            /Provider error - Upstream error|EngineCore encountered/],
  ['SDK per-run error summary',                          /\[SDK\] run (success|error) with \d+ tracked error/],
  ['extraction JSON validation failed',                  /extraction JSON validation failed/],
  ['verify: no valid JSON (truncation)',                 /\[verify\] batch error .*No valid JSON structure/],
  ['SDK-not-initialized race',                           /SDK not initialized\. Call initResearchSDK/],
  ['category skipped after retries',                     /\[skip\] \w+: failed after retries/],
  ['round hit timeout guard',                            /hit the 3600s timeout guard/],
  ['audit batch skipped',                                /batch \d+ error:.*skipping/],
];

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function readJson(p) { try { return JSON.parse(read(p)); } catch { return null; } }
function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h${m}m` : `${m}m`; }

function loopProc() {
  try {
    const out = execSync("ps -eo pid,etime,args 2>/dev/null | grep 'scale-loop.sh' | grep -v grep", { encoding: 'utf8' });
    const line = out.trim().split('\n')[0] || '';
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+.*scale-loop\.sh\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!m) return { alive: false };
    return { alive: true, pid: m[1], etime: m[2], target: +m[3], maxRounds: +m[4], conc: +m[5] };
  } catch { return { alive: false }; }
}

function memAvailMb() {
  try { return Math.round(+execSync("awk '/MemAvailable/{print $2}' /proc/meminfo", { encoding: 'utf8' }).trim() / 1024); }
  catch { return null; }
}

// Parse pi-research's JSON-lines engine log: group WARN/ERROR at or after `sinceIso`
// by a normalized message (URLs/numbers stripped) so recurring faults aggregate.
function engineLogStats(sinceIso) {
  const raw = read(PI_LOG);
  if (!raw) return { present: false, warn: 0, error: 0, top: [] };
  const groups = new Map();
  let warn = 0, error = 0;
  for (const line of raw.split('\n')) {
    if (!line || (line[0] !== '{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.level !== 'WARN' && e.level !== 'ERROR') continue;
    if (sinceIso && e.timestamp && e.timestamp < sinceIso) continue;
    if (e.level === 'WARN') warn++; else error++;
    const msg = String(e.errorMessage || e.message || '')
      .replace(/https?:\/\/\S+/g, '<url>').replace(/\b\d[\d.,]*\b/g, 'N').slice(0, 70).trim();
    const key = `${e.level} ${msg}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { present: true, warn, error, top };
}

function snapshot() {
  const log = read(LOG);
  const lines = log ? log.split('\n') : [];
  const findings = readJson(FINDINGS);
  const flagged = readJson(FLAGGED);
  const corpus = findings?.totalFindings ?? 0;
  const proc = loopProc();

  // Round telemetry: parse "round N exit=R dur=Ds added=A findings=F" from the CURRENT loop session
  // (after the last "[loop] start" line) so a restart doesn't skew rates.
  const lastStart = lines.map((l, i) => l.includes('[loop] start ') ? i : -1).filter(i => i >= 0).pop() ?? 0;
  const session = lines.slice(lastStart);
  const rounds = [];
  for (const l of session) {
    const m = l.match(/round (\d+) exit=(\d+) dur=(\d+)s added=(-?\d+) findings=(\d+)/);
    if (m) rounds.push({ n: +m[1], exit: +m[2], dur: +m[3], added: +m[4], findings: +m[5] });
  }
  const done = rounds.length;
  const totalAdded = rounds.reduce((a, r) => a + Math.max(0, r.added), 0);
  const totalDur = rounds.reduce((a, r) => a + r.dur, 0);
  const avgAdded = done ? (totalAdded / done) : 0;
  const perHour = totalDur ? (totalAdded / (totalDur / 3600)) : 0;
  const target = proc.target || findings?.target || 1500;
  const remaining = Math.max(0, target - corpus);
  const etaHours = perHour > 0 ? remaining / perHour : null;

  // Error tally over the current session
  const tally = new Map(SIGNATURES.map(([label]) => [label, 0]));
  const recentErr = [];
  for (const l of session) {
    for (const [label, re] of SIGNATURES) {
      if (re.test(l)) { tally.set(label, tally.get(label) + 1); if (SHOW_ERRORS) recentErr.push(l.trim()); break; }
    }
  }
  // Categories failing repeatedly
  const catFail = new Map();
  for (const l of session) {
    const m = l.match(/\[skip\] (\w+): failed after retries/);
    if (m) catFail.set(m[1], (catFail.get(m[1]) || 0) + 1);
  }

  // Last audit result block
  const auditLine = session.filter(l => /AUDIT RESULTS:|maintenance audit exit=/.test(l)).pop() || '(no audit this session yet)';

  // pi-research structured engine log, scoped to this loop session's start timestamp.
  const startIso = (session.find(l => /\[loop\] start /.test(l))?.match(/start (\S+Z)/) || [])[1] || null;
  const engine = engineLogStats(startIso);

  return { corpus, target, remaining, flaggedN: flagged?.flagged?.length ?? 0, proc, done, avgAdded,
           perHour, etaHours, totalAdded, totalDur, tally, catFail, auditLine, recentErr, engine, mem: memAvailMb() };
}

function render(s) {
  const L = [];
  const bar = (() => { const pct = s.target ? Math.min(1, s.corpus / s.target) : 0; const n = Math.round(pct * 24); return '[' + '='.repeat(n) + '-'.repeat(24 - n) + `] ${(pct * 100).toFixed(1)}%`; })();
  L.push('═'.repeat(70));
  L.push(`  WALL OF SHAME — LIVE MONITOR        ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  L.push('═'.repeat(70));
  L.push(`  Corpus:   ${s.corpus} / ${s.target}   ${bar}`);
  L.push(`  Loop:     ${s.proc.alive ? `RUNNING (pid ${s.proc.pid}, up ${s.proc.etime}, concurrency ${s.proc.conc})` : 'NOT RUNNING'}`);
  L.push(`  Memory:   ${s.mem != null ? s.mem + ' MB available' : 'n/a'}`);
  L.push('');
  L.push(`  Throughput (this session): ${s.done} rounds, ${s.totalAdded} added in ${fmtDur(s.totalDur)}`);
  L.push(`             ${s.avgAdded.toFixed(1)} entries/round · ${s.perHour.toFixed(1)} entries/hour`);
  L.push(`  ETA to ${s.target}: ${s.etaHours != null ? fmtDur(s.etaHours * 3600) + ` (~${s.remaining} to go)` : 'n/a (need ≥1 completed round)'}`);
  L.push(`  Flagged pending: ${s.flaggedN}`);
  L.push('');
  L.push('  pi-research / pipeline errors (this session):');
  const anyErr = [...s.tally.values()].some(v => v > 0);
  if (!anyErr) L.push('    (none observed — clean)');
  for (const [label, n] of s.tally) if (n > 0) L.push(`    ${String(n).padStart(4)}  ${label}`);
  if (s.catFail.size) L.push(`  Categories failing repeatedly: ${[...s.catFail.entries()].map(([c, n]) => `${c}×${n}`).join(', ')}`);
  L.push('');
  L.push(`  pi-research engine log (${path.basename(PI_LOG)}):`);
  if (!s.engine.present) L.push('    (engine log not found — set PI_RESEARCH_LOG_PATH to capture it)');
  else {
    L.push(`    ${s.engine.error} ERROR · ${s.engine.warn} WARN (this session)`);
    for (const [k, n] of s.engine.top) L.push(`    ${String(n).padStart(4)}  ${k}`);
  }
  L.push('');
  L.push(`  Last audit: ${s.auditLine.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').slice(0, 64)}`);
  if (s.recentErr.length) { L.push('  --- recent error lines ---'); for (const e of s.recentErr.slice(-12)) L.push('  ' + e.slice(0, 100)); }
  L.push('═'.repeat(70));
  return L.join('\n');
}

function tick() { console.log(render(snapshot())); }

if (WATCH) {
  const loop = () => { console.clear(); tick(); };
  loop();
  setInterval(loop, WATCH * 1000);
} else {
  tick();
}
