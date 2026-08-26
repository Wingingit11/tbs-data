#!/usr/bin/env node
/* Plans FLIP daily games and writes the published artefacts.
 *
 *   node tools/flip-plan.js                 # plan from tomorrow, 400 days max
 *   node tools/flip-plan.js --from 2026-09-01 --days 30
 *   node tools/flip-plan.js --dry           # report only, write nothing
 *
 * Writes (unless --dry):
 *   flip-schedule.json    what the browser reads
 *   flip-history.json     canonical publication history
 *   flip-diagnostics.json bank health, quarantine, supply runway
 *
 * Already-published days are never re-planned. The planner appends from the day
 * after the last published entry, so running it twice is safe.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var engine = require("./flip-engine");

var ROOT = path.join(__dirname, "..");
var P = function (f) { return path.join(ROOT, f); };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(P(file), "utf8")); }
  catch (e) { return fallback; }
}

var argv = process.argv.slice(2);
function arg(name, def) {
  var i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
var DRY = argv.indexOf("--dry") >= 0;

var config = readJson("flip-engine-config.json", {});
var history = readJson("history.internal.json", { version: 1, published: [] });
var bankDoc = readJson("questions.internal.json", { bank: [] });
var bank = bankDoc.bank || bankDoc.questions || [];

/* The seed bridge, if enabled, admits records that are genuinely sourced and
 * verified but predate the verifierNote field. It does NOT relax the repeat
 * window, so it cannot cause recycling — it only decides who is in the pool. */
var opts = {
  repeatDays: config.repeatWindowDays || engine.REPEAT_DAYS,
  allowMissingVerifierNote: !!(config.seedBridge && config.seedBridge.enabled)
};

var today = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
var lastPublished = history.published.reduce(function (m, h) {
  return !m || h.date > m ? h.date : m;
}, null);
var from = arg("from", lastPublished ? engine.addDays(lastPublished, 1) : today);
var maxDays = parseInt(arg("days", "400"), 10);

var result = engine.plan(bank, history, from, maxDays, opts);
var report = engine.bankReport(bank, history, today, opts);
report.daysOfSupplyRemaining = result.days.length;
report.seedBridgeEnabled = opts.allowMissingVerifierNote;
report.plannedFrom = from;
report.plannedThrough = result.days.length ? result.days[result.days.length - 1].date : null;
report.stoppedAt = result.stoppedAt;
report.generatedAt = new Date().toISOString();

/* ---------------------------------------------------------------- output */
var line = "-".repeat(72);
console.log(line);
console.log("FLIP question engine — planning report");
console.log(line);
console.log("today                       " + today);
console.log("repeat window               " + opts.repeatDays + " days (question id AND topicKey)");
console.log("seed bridge                 " + (opts.allowMissingVerifierNote
  ? "ENABLED — records missing verifierNote are admitted" : "disabled"));
console.log("total records in bank       " + report.totalRecords);
console.log("approved / production-ready " + report.approvedRecords);
console.log("quarantined                 " + report.quarantinedCount);
console.log("  of which placeholders     " + report.placeholderRecordsExcluded);
console.log("eligible today              " + report.eligibleToday);
console.log("");
console.log("eligible by category:");
Object.keys(report.byCategory).forEach(function (c) {
  var v = report.byCategory[c];
  console.log("  " + c.padEnd(20) + " approved " + String(v.approved).padStart(4) +
    "   eligible today " + String(v.eligibleToday).padStart(4));
});
console.log("");
console.log("planning from               " + from);
console.log("days planned                " + result.days.length);
console.log("schedule covers through     " + (report.plannedThrough || "(nothing planned)"));
if (result.stoppedAt) {
  console.log("");
  console.log("STOPPED at " + result.stoppedAt.date + " — cannot fill:");
  result.stoppedAt.shortfalls.forEach(function (s) {
    console.log("  slot " + s.slot + "  " + (s.category || "") +
      " (difficulty " + s.difficulty + ") — " + s.reason);
  });
  console.log("");
  console.log("  The game will show a content-unavailable notice from this date.");
  console.log("  It will NOT recycle questions to keep running.");
}
if (report.quarantinedCount) {
  console.log("");
  console.log("quarantined records (never eligible for production):");
  report.quarantined.forEach(function (q) {
    console.log("  " + q.id.padEnd(26) + q.reasons.join("; "));
  });
}
console.log(line);

if (DRY) { console.log("--dry: nothing written."); process.exit(0); }

/* Merge: keep every previously published day untouched, append the new ones. */
var existing = readJson("schedule.internal.json", { version: 1, days: [] });
var byDate = {};
(existing.days || []).forEach(function (d) { byDate[d.date] = d; });
result.days.forEach(function (d) { byDate[d.date] = d; });
var merged = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });

fs.writeFileSync(P("schedule.internal.json"), JSON.stringify({
  version: 1,
  _note: "Published FLIP daily games. Generated by tools/flip-plan.js — do not hand-edit.",
  generatedAt: report.generatedAt,
  repeatWindowDays: opts.repeatDays,
  days: merged
}, null, 2) + "\n");

fs.writeFileSync(P("history.internal.json"), JSON.stringify({
  version: 1,
  _note: "Canonical publication history. Append-only. Drives 12-month repeat blocking.",
  updatedAt: report.generatedAt,
  published: result.published
}, null, 2) + "\n");

fs.writeFileSync(P("diagnostics.internal.json"), JSON.stringify(report, null, 2) + "\n");

console.log("wrote flip-schedule.json (" + merged.length + " days), " +
  "flip-history.json (" + result.published.length + " occurrences), flip-diagnostics.json");
