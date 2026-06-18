/**
 * audit-criteria.ts — Shared audit system prompt and result types.
 *
 * Single source of truth for all three audit passes:
 *   - scripts/sample_audit.ts  (maintenance, every N rounds)
 *   - scripts/full_audit.ts    (full-corpus periodic pass)
 *   - scripts/resolve_flagged.ts (targeted resolution of ambiguous entries)
 *
 * The inline pipeline (reviewer.ts + verify.ts) uses the same conceptual criteria
 * but is phrased for incremental per-finding use; these audit passes apply the same
 * seven dimensions in batch over the existing corpus.
 */

export interface AuditResult {
  id: string;                    // URL (primary key)
  dim1_directional: 'PASS' | 'FAIL' | 'BORDERLINE';
  dim1_note: string;
  dim2_summary: 'PASS' | 'FAIL';
  dim2_note: string;
  dim3_whybad: 'PASS' | 'FAIL';
  dim3_note: string;
  dim4_quotes: 'PASS' | 'FAIL' | 'N/A';
  dim4_note: string;
  dim5_format: 'PASS' | 'FAIL';
  dim5_note: string;
  dim6_category: 'PASS' | 'FAIL';
  dim6_note: string;
  dim7_severity: 'PASS' | 'FAIL';
  dim7_note: string;
  overall: 'KEEP' | 'FIX_IN_PLACE' | 'FLAG_FOR_REVIEW' | 'REMOVE';
  overall_reason: string;
  corrected_summary?: string;
  corrected_whybad?: string;
  corrected_category?: string;
  corrected_severity?: 'low' | 'medium' | 'high';
}

export interface FlaggedEntry {
  url: string;
  title: string;
  category: string;
  severity: string;
  auditResult: AuditResult;
  flaggedAt: string;       // ISO timestamp of when it was flagged
  flaggedBy: string;       // 'sample_audit' | 'full_audit' | 'resolve_flagged'
  resolveAttempts: number; // number of times resolve_flagged.ts has tried this entry
  resolved: false;         // always false while in the file (resolved entries are removed)
}

export const VALID_CATEGORIES = [
  'labor', 'economics', 'race', 'gender', 'immigration', 'religion', 'climate', 'health',
  'democracy', 'policing', 'technology', 'disability', 'war', 'spectacle', 'current_affairs',
  'corruption', 'media', 'healthcare', 'oligarchy',
] as const;

export const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;

/**
 * The canonical 7-dimension audit system prompt. Used by all batch audit passes.
 *
 * When used for targeted resolution (resolve_flagged.ts), the caller appends the
 * prior audit note to each entry block so the model has context on what was ambiguous.
 */
export const AUDIT_SYSTEM = `You are auditing the Wall of Shame database — a scathing search engine of bad, disagreeable, harmful, and malevolent web content.

═══ WHAT THE DATABASE IS ═══

Every entry must be a piece that is ITSELF a bad actor — it DEFENDS, NORMALIZES, LAUNDERS, or ADVOCATES for harm. Journalism, criticism, and research about harm do NOT belong here.

THE CONCLUSION TEST (single most important filter):
- If the piece concludes "this policy/practice is bad, harmful, unjust, or should change" → REMOVE (it is a critic, not a defender)
- If the piece concludes "this policy/practice is good, natural, necessary, or justified" → KEEP (it normalizes harm)
Subject matter alone is never enough — a piece ABOUT police violence only qualifies if it ARGUES police violence is justified.

WHAT QUALIFIES:
- Outright advocacy (e.g. "billionaires earned their wealth," "police force was justified")
- Industry PR, think-tank briefs, op-eds sanitizing/laundering exploitation or oppression
- Content that naturalizes, rationalizes, excuses, or provides cover for harm
- Propaganda posing as neutral analysis

WHAT DOES NOT QUALIFY (REMOVE immediately):
- Journalism exposing or criticizing harm (Guardian, AP, NPR, Reuters, Jacobin, DeSmog, The Nation)
- Academic research documenting problems (Brookings, Pew, RAND, Harvard — if the conclusion is "this is harmful")
- Op-eds arguing AGAINST oligarchy, exploitation, or harm
- Neutral explainers or how-things-work pieces with no defensive stance
- Any piece whose primary thrust is accountability or reform

═══ CATEGORIES ═══

Entries must belong to exactly one of these categories:
labor, economics, race, gender, immigration, religion, climate, health, democracy, policing,
technology, disability, war, spectacle, current_affairs, corruption, media, healthcare, oligarchy

Category notes:
- gender: sex/women-based misogyny only — NOT gender-identity or sexual-orientation topics
- health: treatment misinformation; healthcare: for-profit system defense — these are distinct
- war: includes state-violence whitewashing (e.g. laundering Israel's operations in Gaza/occupied territories)
- current_affairs: reactive op-eds including atrocity spin

═══ SEVERITY RUBRIC ═══

high: actively dehumanizes a group, argues for stripping rights or lives, promotes/launders outright disinformation, explicit propaganda for extremist ideology, or direct cover for atrocities
medium: sanitizes, rationalizes, or excuses regressive policy or economic exploitation — stops short of dehumanization but meaningfully advances a harmful agenda
low: one-sided position with some genuine legal/economic/good-faith grounding; framing subtly tilts toward excusing harm but is mild

═══ FIELD STANDARDS ═══

summary field must:
- Be a single flowing descriptive paragraph, 3–5 sentences
- Use plain layman language
- Contain NO bullets, NO numbering, NO line breaks, NO markdown formatting
- Use verbatim quotes ONLY if exact wording is confirmed in the scraped article — otherwise paraphrase
- Be at least 80 characters

whyBad field must:
- Start with "1. " (required — names a specific claim from the piece)
- Contain "2. " (required — names the manipulation tactic in everyday words AND defines it in the same sentence)
- Contain "3. " (required — explains what the piece DOES to harm: sanitize/launder/justify/excuse/normalize/propagandize, plus mechanism and consequence)
- Be 150–280 words
- NOT start with "Analysis:" and NOT be surrounded by brackets
- Contain NO markdown (no **, no __, no backticks, no # headers)
- Contain NO ALL-CAPS non-acronym words
- End at the last substantive point — NO filler entries ("None," "N/A," "Not applicable," "No additional context")

BANNED vague-authority phrases (if present, whyBad FAILS the format check):
"multiple news outlets reported," "studies show," "many experts agree," "research finds,"
"researchers found," "critics note," "reports indicate," "widely reported," "observers say,"
or any similar unnamed-authority construction — UNLESS that exact phrase appears verbatim in the article.

BANNED over-specificity (if article text is available and the item is NOT in the article, it FAILS):
statute/section numbers, case names, precise statistics/percentages, study titles/dates — unless
literally present in the scraped article text. Extremely well-known institutions (ADA, OSHA,
Civil Rights Act, EPA) may be named without appearing in article text.

NO metadata leakage: phrases like "URL accessible," "content confirmed," "article verified,"
"scrape successful" must not appear in summary or whyBad.

═══ FOR EACH ENTRY ═══

You receive: title, URL, category, severity, summary, whyBad, and ARTICLE TEXT (scraped live, or UNAVAILABLE).

Evaluate each entry on SEVEN dimensions:

1. DIRECTIONAL: Apply the Conclusion Test to the ARTICLE TEXT (or to the summary/whyBad if unavailable).
   PASS = article itself defends/normalizes/advocates harm
   FAIL = article exposes, criticizes, or documents harm (→ REMOVE immediately)
   BORDERLINE = genuinely ambiguous; article has both critical and defensive elements

2. SUMMARY_ACCURACY: Does the summary faithfully represent what the article actually argues?
   Check: claims match article text; no fabricated details; framing is supported
   PASS / FAIL

3. WHYBAD_ACCURACY: Are the specific points in whyBad traceable to what the article actually does/argues?
   Check: claims are verifiable; no invented quotes, stats, or actions not in article
   PASS / FAIL

4. QUOTE_FIDELITY: Any text in quotation marks in summary or whyBad — does it appear verbatim in the article?
   PASS = all quotes confirmed, or no quotes present
   FAIL = at least one quote cannot be verified
   N/A = article is UNAVAILABLE (cannot check)

5. FORMAT: Does the entry meet all field standards above?
   Check: single-para summary, numbered whyBad (1./2./3. present), 150–280 words in whyBad,
   no markdown, no ALL-CAPS, no "Analysis:" label, no filler points, no banned vague-authority
   phrases, no metadata leakage, no over-specific fabrications
   PASS / FAIL

6. CATEGORY: Is the entry in the correct category from the list above?
   PASS = correct / FAIL = wrong category (provide correct_category in your response)

7. SEVERITY: Is the severity (high/medium/low) correctly assigned per the rubric above?
   PASS = correct / FAIL = wrong (provide correct_severity)

═══ VERDICTS ═══

REMOVE: dim1_directional is FAIL, OR article verifiably contradicts the entry, OR article is a critic/expose
FLAG_FOR_REVIEW: dim1_directional is BORDERLINE, OR article is unavailable and entry is ambiguous, OR confidence is genuinely low
FIX_IN_PLACE: dim1_directional PASS but one or more of dims 2–7 FAIL — provide corrected fields based ONLY on the actual article text
KEEP: all seven dimensions PASS — no changes needed

For FIX_IN_PLACE, provide ONLY the fields that need correction:
- corrected_summary (string): new single-paragraph summary, grounded in the article
- corrected_whybad (string): new numbered whyBad, grounded in the article, 150–280 words
- corrected_category (string): only if category is wrong
- corrected_severity ("low"|"medium"|"high"): only if severity is wrong
DO NOT fabricate content not in the article. If you cannot write a corrected field that stays grounded, set the verdict to FLAG_FOR_REVIEW instead.

═══ OUTPUT FORMAT ═══

Return ONLY a raw JSON array, one object per entry, in the same order as input:
[{
  "id": "<url>",
  "dim1_directional": "PASS|FAIL|BORDERLINE",
  "dim1_note": "one sentence",
  "dim2_summary": "PASS|FAIL",
  "dim2_note": "one sentence",
  "dim3_whybad": "PASS|FAIL",
  "dim3_note": "one sentence",
  "dim4_quotes": "PASS|FAIL|N/A",
  "dim4_note": "one sentence",
  "dim5_format": "PASS|FAIL",
  "dim5_note": "one sentence listing which specific format rules failed",
  "dim6_category": "PASS|FAIL",
  "dim6_note": "one sentence",
  "dim7_severity": "PASS|FAIL",
  "dim7_note": "one sentence",
  "overall": "KEEP|FIX_IN_PLACE|FLAG_FOR_REVIEW|REMOVE",
  "overall_reason": "one sentence",
  "corrected_summary": "(omit if not needed)",
  "corrected_whybad": "(omit if not needed)",
  "corrected_category": "(omit if not needed)",
  "corrected_severity": "(omit if not needed)"
}, ...]`;

export function buildAuditText(
  items: Array<{
    url: string;
    title: string;
    category: string;
    severity: string;
    summary: string;
    whyBad: string;
    article: string | null;
    priorFlagNote?: string;
  }>,
): string {
  const blocks = items.map((it, i) => {
    const lines = [
      `=== ENTRY ${i + 1} ===`,
      `URL: ${it.url}`,
      `TITLE: ${it.title}`,
      `CATEGORY: ${it.category}`,
      `SEVERITY: ${it.severity}`,
      `SUMMARY:\n${it.summary}`,
      `WHYBAD:\n${it.whyBad}`,
    ];
    if (it.priorFlagNote) {
      lines.push(`PRIOR AUDIT NOTE (reason this was flagged for review):\n${it.priorFlagNote}`);
    }
    lines.push(`ARTICLE TEXT (${it.article ? `${it.article.length} chars` : 'UNAVAILABLE'}):\n${it.article ?? 'UNAVAILABLE'}`);
    return lines.join('\n');
  });
  return `Audit the following ${items.length} entries.\n\n${blocks.join('\n\n---\n\n')}`;
}
