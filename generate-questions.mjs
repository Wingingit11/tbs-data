#!/usr/bin/env node
/* FLIP candidate generator.
 *
 * Reads flip-runway.json, works out which slots are shortest, asks a
 * web-enabled model to research and draft candidates for those slots only, and
 * writes batches/auto-latest.json.
 *
 * It has NO authority to publish. Its output is a candidate file that must then
 * survive, in order:
 *   flip-verify-sources.js   URL resolves, approved host, page identity,
 *                            proximity, discrimination, reveal support
 *   flip-ingest.js           strict schema, id/topicKey audit, near-duplicate
 *                            audit, auto-approve vs quarantine
 * Nothing here can weaken either step.
 *
 * The API key comes from the environment (repository secret). It is never
 * written to a file, a log line or a committed artefact.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const P = (f) => path.join(ROOT, f);
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(P(f), "utf8")); } catch { return d; } };

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("ANTHROPIC_API_KEY is not set - refusing to run."); process.exit(2); }
const MAX = Math.max(1, parseInt(process.env.MAX_PER_RUN || "10", 10));
const MODEL = process.env.FLIP_MODEL || "claude-sonnet-4-6";

const runway = rj("runway.internal.json", null);
if (!runway) { console.error("flip-runway.json missing - run tools/flip-runway.js first."); process.exit(2); }

const bank = rj("questions.internal.json", { bank: [] }).bank || [];
/* Every topic already used, so the model is told what NOT to write about
   rather than discovering the collision downstream. */
const usedTopics = bank.map((q) => q.topicKey).sort();
const usedPrompts = bank.map((q) => q.prompt);

/* Weakest slots first, and never overfill a healthy one. */
const shortfalls = (runway.shortfallBySlot || []).slice().sort((a, b) => b.need - a.need);
if (!shortfalls.length) { console.log("No slot shortfall - nothing to generate."); process.exit(0); }

/* Spread MAX across the short slots, weighted by need, at least one each. */
const totalNeed = shortfalls.reduce((t, s) => t + s.need, 0);
let remaining = MAX;
const quota = shortfalls.map((s, i) => {
  const want = i === shortfalls.length - 1 ? remaining
    : Math.max(1, Math.round((s.need / totalNeed) * MAX));
  const n = Math.min(want, remaining);
  remaining -= n;
  return { ...s, count: n };
}).filter((s) => s.count > 0);

console.log(`Generating ${MAX} candidates across ${quota.length} slot(s):`);
quota.forEach((s) => console.log(`  ${s.category} (difficulty ${s.difficulty}) x${s.count}`));

const SCHEMA = `{
  "id": "flip-auto-YYYYMMDD-NNN",
  "status": "approved",
  "category": "<one of suburb_story|landmark_oddity|which_came_first|homes_lifestyle|wildcard>",
  "topicKey": "short-kebab-case-key-for-the-underlying-fact",
  "prompt": "...",
  "options": [{"id":"a","label":"..."},{"id":"b","label":"..."}],
  "correctOptionId": "a",
  "reveal": "One or two sentences explaining WHY, not repeating the answer. Max ~200 chars.",
  "source": {
    "title": "exact page title",
    "url": "https://...",
    "publisher": "e.g. Brisbane City Council Heritage Places",
    "verifierNote": "what this page actually states that establishes the answer"
  },
  "verifiedOn": "YYYY-MM-DD",
  "predictedDifficulty": 1,
  "knowledgeOnly": false,
  "tags": ["...", "..."]
}`;

const SYSTEM = `You research and draft questions for FLIP, a daily Brisbane trivia game.

ABSOLUTE RULES - a violation is worse than returning fewer questions:
- Use the web_search tool to find a real authoritative page, then quote from it.
- NEVER invent a URL, page title, publisher, date or verifier note.
- If you cannot find an authoritative page that plainly states the fact, SKIP that
  candidate and return fewer. Returning 3 solid records beats 10 shaky ones.
- The cited page must state the answer explicitly. Do not cite a page that merely
  mentions the subject.
- Every year in your reveal must appear on the cited page, near the answer.
- The two options must be genuinely discriminable from that one page: the page must
  clearly support one and not the other. Avoid distractors the page also supports.

Preferred sources, in order: Brisbane City Council Heritage Places
(heritage.brisbane.qld.gov.au), Queensland Heritage Register, Queensland Government,
State Library of Queensland, Trove, Queensland Museum, official venue or institution
history pages, Visit Brisbane.

QUALITY: Brisbane-specific; one objectively correct answer; a plausible (not silly)
distractor; no subjective "best"; no live or unstable statistics; no CBD-distance,
business-count, school-count or park-count questions; interesting enough to be worth
playing. Reveal must fit about three mobile lines.

Return ONLY a JSON array of records in this exact shape, no prose, no markdown fence:
${SCHEMA}`;

async function draftSlot(slot) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: `CATEGORY: ${slot.category}   (every record you return MUST have "category": "${slot.category}")
Research and draft ${slot.count} question(s) for the "${slot.category}" slot at predictedDifficulty ${slot.difficulty}.
knowledgeOnly must be ${slot.category === "wildcard" ? "true or false (your choice)" : "false"}.
${slot.category === "which_came_first" ? "This compares two Brisbane events. Verify BOTH dates, citing the stronger source; mention the second date in the reveal only if the cited page states it.\n" : ""}
Do NOT reuse any of these existing topicKeys or anything factually equivalent:
${usedTopics.join(", ")}

Search first. Draft only what you can actually source. Return the JSON array.`
    }]
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`  API error ${res.status} for ${slot.category}`);   // never log the key
    return [];
  }
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) { console.error(`  no JSON array returned for ${slot.category}`); return []; }
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error(`  unparseable JSON for ${slot.category}`);
    return [];
  }
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const out = [];
for (const slot of quota) {
  const drafted = await draftSlot(slot);
  let kept = 0, wrongSlot = 0;
  drafted.forEach((r) => {
    /* Run one produced ten suburb_story records because the override below
       stamped the requested slot onto whatever came back, hiding the fact that
       the model had ignored the category. Now a record that comes back for the
       wrong category is DISCARDED rather than relabelled - a mislabelled
       question is worse than a missing one. */
    if (r.category && r.category !== slot.category) { wrongSlot++; return; }
    r.id = r.id && !out.some((o) => o.id === r.id) ? r.id
      : `flip-auto-${stamp}-${String(out.length + 1).padStart(3, "0")}`;
    r.category = slot.category;
    r.predictedDifficulty = slot.difficulty;
    if (slot.category !== "wildcard") r.knowledgeOnly = false;
    r.status = "approved";
    if (r.source && !r.source.verifierNote) r.source.verifierNote = "";
    out.push(r);
    kept++;
  });
  console.log(`  ${slot.category}: ${kept} drafted` +
    (wrongSlot ? `  (${wrongSlot} discarded - returned for the wrong category)` : ""));
}

/* Cheap pre-filter so obviously duplicated prompts never reach the verifier. */
const fresh = out.filter((r) => !usedPrompts.includes(r.prompt));
fs.mkdirSync(P("batches"), { recursive: true });
fs.writeFileSync(P("batches/auto-latest.json"),
  JSON.stringify({ _note: "CANDIDATES - unverified. Must pass flip-verify-sources.js then flip-ingest.js.",
    generatedAt: new Date().toISOString(), bank: fresh }, null, 2) + "\n");
console.log(`\nwrote batches/auto-latest.json with ${fresh.length} candidate(s)`);
console.log("Next: flip-verify-sources.js, then flip-ingest.js. Neither can be skipped.");
