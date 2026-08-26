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


/* SOURCE-FIRST DRAFTING.
 *
 * Runs 1-5 all failed the same way: the model researched a topic, then cited a
 * page that was *related* rather than one that *stated* the fact - a Museum of
 * Brisbane "What's On" page for an 1891 claim, a Botanic Gardens page where the
 * date sat nowhere near the subject. Corroboration then correctly refused it.
 *
 * So invert it. Give the model a real page, make it read that page, and have it
 * write a question the page plainly establishes. The fact comes OUT of the
 * source instead of being matched to one afterwards, which is why this should
 * pass verification rather than fight it.
 *
 * BCC Heritage Places is ideal: thousands of entries, one stable URL shape, a
 * History section written in prose, and already on the allow-list. Each page
 * usually supports a suburb story AND a landmark oddity AND something about
 * housing, so one fetch can feed several slots.
 */
var SEED_POOL = [];
function seedUrls(n) {
  /* Deterministic spread across the heritage-place id range so successive runs
     do not keep landing on the same entries. Ids are not contiguous, so a miss
     is expected and the model is told to skip rather than invent. */
  var out = [], used = {};
  var day = Math.floor(Date.now() / 86400000);
  for (var i = 0; out.length < n && i < n * 8; i++) {
    var id = 500 + ((day * 137 + i * 61) % 2600);
    if (used[id]) continue;
    used[id] = true;
    out.push("https://heritage.brisbane.qld.gov.au/heritage-places/" + id);
  }
  return out;
}

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

OPTION WORDING - this one matters most:
- NEVER make an option a bare number or year. "1897" vs "1885" cannot be verified
  against a source page, because a page about trams mentions a dozen years.
- Always word the options. Good: "The Story Bridge" / "The Victoria Bridge",
  "The 1960s" / "The 1980s", "Rows of terrace houses" / "Detached Queenslanders".
- Put the dates in the REVEAL, not in the options.

QUALITY: Brisbane-specific; one objectively correct answer; a plausible (not silly)
distractor; no subjective "best"; no live or unstable statistics; no CBD-distance,
business-count, school-count or park-count questions; interesting enough to be worth
playing. Reveal must fit about three mobile lines.

Return ONLY a JSON array of records in this exact shape, no prose, no markdown fence:
${SCHEMA}`;

async function draftSlot(slot) {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: `CATEGORY: ${slot.category}   (every record MUST have "category": "${slot.category}")
predictedDifficulty: ${slot.difficulty}
knowledgeOnly: ${slot.category === "wildcard" ? "true or false, your choice" : "false"}
How many: ${slot.count}

WORK FROM THESE PAGES. Fetch each one and read its History section:
${seedUrls(slot.count * 3).map((u) => "  " + u).join("\n")}

For each page that loads and contains a fact suitable for this category, write ONE
question that the page PLAINLY STATES. Cite that exact page as the source. If a
page 404s, is thin, or has nothing suitable for this category, SKIP IT and move to
the next - do not stretch, and do not cite a page you did not read.

You may use web_search instead ONLY if none of the pages above yield anything for
this category. If you do, the page you cite must still plainly state the fact.
${slot.category === "which_came_first" ? "This compares two Brisbane things. One page must state BOTH dates, or skip.\n" : ""}
Do NOT reuse these topicKeys or anything factually equivalent:
${usedTopics.join(", ")}

Return the JSON array only.`
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
    return JSON.parse(m[0]).filter(Boolean);
  } catch (e) {
    /* A truncated array cost three whole categories across runs 3-5. Salvage the
       complete objects rather than discarding the lot. */
    const objs = [];
    m[0].replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, (o) => {
      try { objs.push(JSON.parse(o)); } catch (e2) { }
      return o;
    });
    console.error(`  JSON was truncated for ${slot.category} - salvaged ${objs.length}`);
    return objs;
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
