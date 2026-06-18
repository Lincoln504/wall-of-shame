/**
 * backfill_directional_basis.ts — batch-generate directionalBasis for all entries
 * that are missing it (i.e., the entire pre-June-18 corpus).
 *
 * For each finding, sends its summary + whyBad to Qwen3.6 and asks it to produce
 * one sentence: "what does this piece CONCLUDE that makes it a bad actor?"
 *
 * Processes in parallel batches of 20 (cheap inference, no scraping needed).
 * Writes atomically back to findings.json.
 *
 * Usage:
 *   cd agent && npx tsx scripts/backfill_directional_basis.ts [--dry-run]
 */
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOpenRouterModel, completeText, WORKHORSE_MODEL_ID } from '../src/models.js';
import { safeParseJson, mapWithConcurrency } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FINDINGS_PATH = join(DATA_DIR, 'findings.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 10;

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

function writeAtomic(path: string, data: any) {
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

const BACKFILL_SYSTEM = `You generate a single directionalBasis sentence for Wall of Shame database entries.

The directionalBasis field answers: "What does this piece CONCLUDE that makes it a bad actor?"

Rules:
- One sentence only (< 25 words)
- Describes what the PIECE ITSELF argues or concludes, not just the topic
- Uses "Concludes that..." or "Argues that..." structure
- Specific, not vague (not "Argues that this policy is good")
- Examples:
  - "Concludes that minimum wage increases hurt workers and small businesses more than they help."
  - "Argues that police use of force is a necessary and effective crime-control tool, not a human rights issue."
  - "Concludes that immigration is a net threat to public safety and wages."
  - "Argues that fossil fuel companies are responsible stewards of energy rather than obstacles to climate action."

Return ONLY a raw JSON object: {"directionalBasis": "one sentence here"}`;

async function getDirectionalBasis(
  model: any,
  title: string,
  summary: string,
  whyBad: string,
): Promise<string | null> {
  try {
    const text = await completeText(
      model,
      BACKFILL_SYSTEM,
      `TITLE: ${title}\nSUMMARY: ${summary.slice(0, 400)}\nANALYSIS: ${whyBad.slice(0, 600)}`,
      { reasoning: false, temperature: 0.3, topP: 0.8, json: true, timeoutMs: 30000 },
    );
    const parsed = safeParseJson<{ directionalBasis?: string }>(text);
    const basis = parsed?.directionalBasis?.trim();
    if (!basis || basis.length < 10 || basis.length > 200) return null;
    return basis;
  } catch {
    return null;
  }
}

const raw = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
const findings: any[] = raw.findings;

const missing = findings.filter(f => !f.directionalBasis);
log(`Found ${missing.length} entries missing directionalBasis (out of ${findings.length})`);
if (DRY_RUN) log('DRY RUN — no writes');

if (missing.length === 0) { log('Nothing to backfill. Exiting.'); process.exit(0); }

const model = await getOpenRouterModel(WORKHORSE_MODEL_ID, { reasoning: false });
log(`Using model: ${WORKHORSE_MODEL_ID}, concurrency: ${CONCURRENCY}`);

let filled = 0, failed = 0;
const results = await mapWithConcurrency(missing, CONCURRENCY, async (f) => {
  const basis = await getDirectionalBasis(model, f.title, f.summary, f.whyBad);
  return { id: f.id, basis };
});

const basisMap = new Map<string, string>();
for (const r of results) {
  if (r.ok && r.value.basis) {
    basisMap.set(r.value.id, r.value.basis);
    filled++;
  } else {
    failed++;
  }
}

log(`Backfilled ${filled}, failed ${failed}`);

if (DRY_RUN || filled === 0) { log('DRY RUN / nothing filled. Exiting.'); process.exit(0); }

const updated = findings.map(f => {
  const basis = basisMap.get(f.id);
  return basis ? { ...f, directionalBasis: basis } : f;
});

raw.findings = updated;
raw.lastUpdated = new Date().toISOString();
writeAtomic(FINDINGS_PATH, raw);
log(`Written ${filled} directionalBasis values to findings.json`);
