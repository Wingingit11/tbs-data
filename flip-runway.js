#!/usr/bin/env node
/* Runway monitor. The number that matters is COMPLETE PLAYABLE DAYS, which is
 * set by the scarcest slot — 400 spare Suburb Story records buy nothing if
 * Wildcard has three days left.
 *
 * Exit codes are for automation:
 *   0  healthy      (>= TARGET)
 *   1  replenish    (< TRIGGER)
 *   2  critical     (< MINIMUM)
 */
"use strict";
var fs = require("fs"), path = require("path"), engine = require("./flip-engine");
var ROOT = path.join(__dirname, "..");
var P = function (f) { return path.join(ROOT, f); };
function rj(f, d) { try { return JSON.parse(fs.readFileSync(P(f), "utf8")); } catch (e) { return d; } }

/* Sized to the 90-day repeat window. Beyond ~90 records per slot the bank is
   self-sustaining: the oldest question frees up as fast as the game uses new
   ones, so chasing a bigger buffer buys nothing. */
var POLICY = { TARGET: 100, TRIGGER: 70, MINIMUM: 40 };

var cfg = rj("flip-engine-config.json", {});
var bank = (rj("questions.internal.json", { bank: [] }).bank) || [];
var history = rj("history.internal.json", { published: [] });
var opts = {
  repeatDays: cfg.repeatWindowDays || engine.REPEAT_DAYS,
  allowMissingVerifierNote: !!(cfg.seedBridge && cfg.seedBridge.enabled)
};

var today = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
var lastPub = history.published.reduce(function (m, h) { return !m || h.date > m ? h.date : m; }, null);
var from = lastPub ? engine.addDays(lastPub, 1) : today;

/* Actual runway = how many consecutive days the planner can fill from here. */
var result = engine.plan(bank, history, from, POLICY.TARGET + 60, opts);
var runway = result.days.length;

/* Per-slot depth: plan each slot in isolation to see which runs out first. */
var part = engine.partition(bank, opts);
var idx = engine.indexHistory(history);
var perSlot = engine.SLOTS.map(function (s) {
  var pool = part.approved.filter(function (r) {
    return r.category === s.category && r.predictedDifficulty === s.difficulty;
  });
  var fresh = pool.filter(function (r) {
    return engine.eligibility(r, from, idx, opts.repeatDays).eligible;
  });
  return {
    slot: s.slot, category: s.category, difficulty: s.difficulty,
    approved: pool.length, eligible: fresh.length, daysOfSupply: fresh.length
  };
});
var bottleneck = perSlot.slice().sort(function (a, b) { return a.daysOfSupply - b.daysOfSupply; })[0];
var shortfall = engine.SLOTS.map(function (s, i) {
  return { slot: s.slot, category: s.category, difficulty: s.difficulty,
    need: Math.max(0, POLICY.TARGET - perSlot[i].daysOfSupply) };
}).filter(function (x) { return x.need > 0; });

var blockedId = 0, blockedTopic = 0;
part.approved.forEach(function (r) {
  var e = engine.eligibility(r, from, idx, opts.repeatDays);
  if (!e.eligible) { e.blockedBy === "questionId" ? blockedId++ : blockedTopic++; }
});

var state = runway >= POLICY.TARGET ? "HEALTHY"
  : runway < POLICY.MINIMUM ? "CRITICAL"
  : runway < POLICY.TRIGGER ? "REPLENISH" : "WATCH";

var out = {
  checkedAt: new Date().toISOString(), today: today, planningFrom: from,
  policy: POLICY, state: state,
  runwayDays: runway,
  firstInsufficientDate: result.stoppedAt ? result.stoppedAt.date : null,
  totalRecords: bank.length, approvedRecords: part.approved.length,
  quarantinedRecords: part.quarantined.length,
  blockedByQuestionIdWindow: blockedId, blockedByTopicKeyWindow: blockedTopic,
  perSlot: perSlot, bottleneck: bottleneck, shortfallBySlot: shortfall,
  recordsNeeded: shortfall.reduce(function (t, x) { return t + x.need; }, 0)
};
fs.writeFileSync(P("runway.internal.json"), JSON.stringify(out, null, 2) + "\n");

var L = "-".repeat(72);
console.log(L);
console.log("FLIP runway monitor — " + state);
console.log(L);
console.log("complete playable days   " + runway +
  "   (target " + POLICY.TARGET + " / trigger " + POLICY.TRIGGER + " / min " + POLICY.MINIMUM + ")");
console.log("first insufficient date  " + (out.firstInsufficientDate || "n/a"));
console.log("approved records         " + part.approved.length + " of " + bank.length);
console.log("blocked by id window     " + blockedId + "   by topicKey window " + blockedTopic);
console.log("");
console.log("slot                     approved  eligible  days");
perSlot.forEach(function (s) {
  console.log("  " + (s.slot + ". " + s.category).padEnd(24) +
    String(s.approved).padStart(6) + String(s.eligible).padStart(10) +
    String(s.daysOfSupply).padStart(6) +
    (s === bottleneck ? "   <-- bottleneck" : ""));
});
if (shortfall.length) {
  console.log("");
  console.log("to reach " + POLICY.TARGET + " days, research is needed for:");
  shortfall.forEach(function (x) {
    console.log("  slot " + x.slot + "  " + x.category.padEnd(18) +
      " difficulty " + x.difficulty + "   " + x.need + " more records");
  });
  console.log("  total records needed: " + out.recordsNeeded);
}
console.log(L);
console.log("wrote flip-runway.json");
process.exit(state === "CRITICAL" ? 2 : (state === "HEALTHY" || state === "WATCH") ? 0 : 1);
