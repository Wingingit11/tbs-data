#!/usr/bin/env node
/* Emit the PUBLIC runtime files into flip/.
 *
 * Everything the pipeline knows stays internal. Only what the player-facing
 * client actually reads at runtime is published, because flip/ is served by
 * jsDelivr and is world-readable.
 *
 * Kept: the fields hcfgv2ValidateRecord() checks plus what the reveal needs.
 * Dropped: verifierNote, verifiedBy, tags, observed stats, and anything else
 * that is editorial rather than runtime.
 */
"use strict";
var fs = require("fs"), path = require("path");
var ROOT = path.join(__dirname, "..");
var P = function (f) { return path.join(ROOT, f); };
var rj = function (f, d) { try { return JSON.parse(fs.readFileSync(P(f), "utf8")); } catch (e) { return d; } };

var bank = (rj("questions.internal.json", { bank: [] }).bank) || [];
var schedule = rj("schedule.internal.json", { version: 1, days: [] });

/* Only questions that actually appear in the published schedule need to be
   public. A record researched for a day six months out is not runtime data
   until that day is scheduled. */
var scheduled = {};
(schedule.days || []).forEach(function (d) {
  (d.questions || []).forEach(function (q) { scheduled[q.questionId] = true; });
});

function trim(q) {
  var src = q.source || {};
  return {
    id: q.id,
    status: q.status,
    category: q.category,
    topicKey: q.topicKey,
    predictedDifficulty: q.predictedDifficulty,
    knowledgeOnly: q.knowledgeOnly,
    prompt: q.prompt,
    options: q.options,
    correctOptionId: q.correctOptionId != null ? q.correctOptionId : q.answer,
    reveal: q.reveal,
    /* Retained: the client carries these as data attributes on the reveal so
       the record behind a claim stays recoverable. verifierNote does not go
       public - that is editorial. */
    source: { title: src.title, url: src.url, publisher: src.publisher },
    verifiedOn: q.verifiedOn
  };
}

var pub = bank.filter(function (q) { return scheduled[q.id]; }).map(trim);
fs.mkdirSync(P("flip"), { recursive: true });
fs.writeFileSync(P("flip/questions.json"), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(), bank: pub
}) + "\n");

/* The schedule is published as-is minus the planner's audit fields. */
var days = (schedule.days || []).map(function (d) {
  return { date: d.date, questions: (d.questions || []).map(function (q) {
    return { slot: q.slot, questionId: q.questionId, topicKey: q.topicKey,
      category: q.category, difficulty: q.difficulty,
      knowledgeOnly: q.knowledgeOnly, optionOrder: q.optionOrder };
  }) };
});
fs.writeFileSync(P("flip/schedule.json"), JSON.stringify({
  version: 1, generatedAt: new Date().toISOString(),
  repeatWindowDays: schedule.repeatWindowDays, days: days
}) + "\n");

console.log("published flip/questions.json  " + pub.length + " records (of " + bank.length + " internal)");
console.log("published flip/schedule.json   " + days.length + " days");
var dropped = ["verifierNote", "verifiedBy", "tags", "observedCorrect", "provenance"];
console.log("withheld from public output: " + dropped.join(", ") + ", plus history/diagnostics/audit");
