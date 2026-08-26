#!/usr/bin/env node
/* FLIP question-bank batch ingest.
 *
 *   node tools/flip-ingest.js batches/batch-001.json            # dry run
 *   node tools/flip-ingest.js batches/batch-001.json --merge    # merge + re-plan
 *
 * Takes a drafted batch, runs it through the SAME strict validator the planner
 * uses (tools/flip-engine.js), audits it against the entire existing bank for
 * id / topicKey / near-duplicate collisions, writes a reviewable report, and
 * — only with --merge — appends the passing records and regenerates the
 * schedule.
 *
 * Nothing here relaxes validation or the repeat windows. A record that fails is
 * quarantined with reasons; it is never downgraded into the bank.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");
var engine = require("./flip-engine");

var ROOT = path.join(__dirname, "..");
var P = function (f) { return path.join(ROOT, f); };
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(P(f), "utf8")); } catch (e) { return d; } }

var argv = process.argv.slice(2);
var batchPath = argv.find(function (a) { return !a.startsWith("--"); });
var MERGE = argv.indexOf("--merge") >= 0;
if (!batchPath) { console.error("usage: flip-ingest.js <batch.json> [--merge]"); process.exit(2); }

var batchDoc = JSON.parse(fs.readFileSync(path.resolve(batchPath), "utf8"));
var incoming = batchDoc.bank || batchDoc.questions || batchDoc;
var bankDoc = readJson("questions.internal.json", { bank: [] });
var bank = bankDoc.bank || [];
var history = readJson("history.internal.json", { published: [] });
var config = readJson("flip-engine-config.json", {});
var opts = {
  repeatDays: config.repeatWindowDays || engine.REPEAT_DAYS,
  allowMissingVerifierNote: !!(config.seedBridge && config.seedBridge.enabled)
};

/* The five production slots, so the batch's shape can be checked. */
var SLOT_OF = {};
engine.SLOTS.forEach(function (s) { SLOT_OF[s.category] = s; });

/* ---------------------------------------------------------- near-duplicates
 * topicKey equality catches the deliberate case. This catches the accidental
 * one: two records about the same underlying fact with different keys. It is a
 * FLAG for human review, never an automatic rejection — a false positive must
 * not silently drop a good question. */
var STOP = new RegExp("^(the|a|an|of|in|on|at|to|for|and|or|was|were|is|are|what|which|" +
  "who|when|where|why|how|did|does|do|by|with|from|its|it|that|this|first|" +
  "brisbane|queensland|city|suburb)$", "i");
function terms(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(function (w) { return w.length > 2 && !STOP.test(w); });
}
function jaccard(a, b) {
  var A = new Set(a), B = new Set(b), inter = 0;
  A.forEach(function (t) { if (B.has(t)) inter++; });
  var union = A.size + B.size - inter;
  return union ? inter / union : 0;
}
function subjectOf(rec) {
  var q = engine.normalise(rec);
  return terms(q.prompt + " " + q.reveal + " " + (q.topicKey || "").replace(/-/g, " "));
}
var NEAR = 0.34;

/* ------------------------------------------------------------------ audit */
var seenId = {}, seenTopic = {};
bank.forEach(function (r) { seenId[r.id] = "existing bank"; seenTopic[r.topicKey] = r.id; });

var existingSubjects = bank.map(function (r) { return { id: r.id, terms: subjectOf(r) }; });
var rows = [], approved = [], quarantined = [], flags = [];

incoming.forEach(function (raw) {
  var q = engine.normalise(raw);
  var reasons = engine.validate(raw, opts);

  if (q.id && seenId[q.id]) reasons.push("duplicate question id (" + seenId[q.id] + ")");
  if (q.topicKey && seenTopic[q.topicKey]) {
    reasons.push("duplicate topicKey — already used by " + seenTopic[q.topicKey]);
  }
  var spec = SLOT_OF[q.category];
  if (spec && q.predictedDifficulty !== spec.difficulty) {
    reasons.push("difficulty " + q.predictedDifficulty + " does not match the " +
      q.category + " slot (expects " + spec.difficulty + ")");
  }
  if (q.knowledgeOnly && q.category !== "wildcard") {
    reasons.push("knowledgeOnly is only permitted on wildcard");
  }

  /* exact-duplicate prompt */
  var exact = bank.concat(approved).find(function (o) {
    return (o.prompt || "").trim().toLowerCase() === (q.prompt || "").trim().toLowerCase();
  });
  if (exact) reasons.push("identical prompt to " + exact.id);

  /* near-duplicate flag, against the bank and against earlier batch records */
  var mine = subjectOf(raw);
  existingSubjects.concat(approved.map(function (a) { return { id: a.id, terms: subjectOf(a) }; }))
    .forEach(function (o) {
      var score = jaccard(mine, o.terms);
      if (score >= NEAR) {
        flags.push({ id: q.id, against: o.id, overlap: score.toFixed(2) });
      }
    });

  var passed = reasons.length === 0;
  if (passed) {
    seenId[q.id] = "this batch";
    seenTopic[q.topicKey] = q.id;
    approved.push(raw);
  } else {
    quarantined.push({ id: q.id || "(no id)", reasons: reasons });
  }
  rows.push({
    id: q.id, category: q.category, difficulty: q.predictedDifficulty,
    knowledgeOnly: q.knowledgeOnly, prompt: q.prompt,
    correctAnswer: (q.options || []).filter(function (o) { return o && o.id === q.correctOptionId; })
      .map(function (o) { return o.label; })[0] || "(none)",
    topicKey: q.topicKey, sourcePublisher: q.sourcePublisher, sourceUrl: q.sourceUrl,
    verifiedOn: q.verifiedOn, status: passed ? "APPROVED" : "QUARANTINED",
    reasons: reasons
  });
});

/* ----------------------------------------------------------------- report */
var byCat = {};
engine.CATEGORIES.forEach(function (c) { byCat[c] = 0; });
approved.forEach(function (r) { byCat[engine.normalise(r).category]++; });

var L = "-".repeat(78);
console.log(L);
console.log("FLIP batch ingest — " + path.basename(batchPath));
console.log(L);
console.log("drafted   " + incoming.length);
console.log("approved  " + approved.length);
console.log("quarantined " + quarantined.length);
console.log("");
console.log("approved by slot:");
engine.SLOTS.forEach(function (s) {
  console.log("  slot " + s.slot + "  " + s.category.padEnd(18) +
    " difficulty " + s.difficulty + "   " + byCat[s.category]);
});
console.log("");
console.log("record detail:");
rows.forEach(function (r) {
  console.log("  [" + r.status + "] " + (r.id || "").padEnd(22) + r.category);
  console.log("      " + (r.prompt || "").slice(0, 68));
  console.log("      answer: " + r.correctAnswer);
  console.log("      topicKey: " + r.topicKey + "   verified: " + r.verifiedOn);
  console.log("      " + r.sourcePublisher + " — " + r.sourceUrl);
  r.reasons.forEach(function (x) { console.log("      ! " + x); });
});
if (flags.length) {
  console.log("");
  console.log("near-duplicate FLAGS (human review, not automatic rejection):");
  flags.forEach(function (f) {
    console.log("  " + f.id + " vs " + f.against + "  subject overlap " + f.overlap);
  });
} else {
  console.log("");
  console.log("near-duplicate flags: none");
}
console.log(L);

fs.writeFileSync(P("batch-report.internal.json"), JSON.stringify({
  batch: path.basename(batchPath), generatedAt: new Date().toISOString(),
  drafted: incoming.length, approved: approved.length,
  quarantined: quarantined, nearDuplicateFlags: flags, records: rows
}, null, 2) + "\n");
console.log("wrote flip-batch-report.json");

if (!MERGE) { console.log("dry run — bank not modified. Re-run with --merge to apply."); process.exit(quarantined.length ? 1 : 0); }
if (!approved.length) { console.log("nothing approved; bank not modified."); process.exit(1); }

/* ------------------------------------------------------------------ merge */
bankDoc.bank = bank.concat(approved);
bankDoc.updatedAt = new Date().toISOString();
fs.writeFileSync(P("questions.internal.json"), JSON.stringify(bankDoc, null, 2) + "\n");
console.log("merged " + approved.length + " records — bank is now " + bankDoc.bank.length);

console.log("");
console.log("re-planning...");
console.log(cp.execFileSync(process.execPath, [path.join(__dirname, "flip-plan.js")],
  { encoding: "utf8" }));
