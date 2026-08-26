#!/usr/bin/env node
/* Preflight for the autonomous pipeline. Run this BEFORE the first workflow
 * trigger. It checks every prerequisite and prints exactly what is missing,
 * so the first live run fails for real reasons rather than setup ones.
 *
 *   node tools/flip-preflight.js
 */
"use strict";
var fs = require("fs"), path = require("path"), https = require("https");
var ROOT = path.join(__dirname, "..");
var P = function (f) { return path.join(ROOT, f); };
var problems = [], warnings = [], ok = [];

function has(f) { return fs.existsSync(P(f)); }
["questions.internal.json", "history.internal.json",
 "flip-engine-config.json", "tools/flip-engine.js", "tools/flip-runway.js",
 "tools/flip-verify-sources.js", "tools/flip-ingest.js",
 "tools/flip-publish.js", "tools/generate-questions.mjs"].forEach(function (f) {
  has(f) ? ok.push("present: " + f) : problems.push("MISSING FILE: " + f);
});

var maj = parseInt(process.versions.node.split(".")[0], 10);
maj >= 18 ? ok.push("node " + process.versions.node)
  : problems.push("node " + process.versions.node + " - generate-questions.mjs needs 18+ for fetch()");

process.env.ANTHROPIC_API_KEY
  ? ok.push("ANTHROPIC_API_KEY is set (value never printed)")
  : problems.push("ANTHROPIC_API_KEY not set - the generator will refuse to run");

ok.push("no Netlify credential needed - publication is via jsDelivr");

function head(url, label) {
  return new Promise(function (res) {
    var r = https.get(url, { headers: { "User-Agent": "flip-preflight/1.0" } }, function (x) {
      x.resume();
      x.statusCode === 200 ? ok.push(label + " reachable (200)")
        : warnings.push(label + " returned HTTP " + x.statusCode +
            (x.statusCode === 403 ? " - blocked user-agent or egress restriction" : ""));
      res();
    });
    r.on("error", function (e) { problems.push(label + " unreachable: " + e.message); res(); });
    r.setTimeout(12000, function () { r.destroy(); problems.push(label + " timed out"); res(); });
  });
}

(async function () {
  await head("https://heritage.brisbane.qld.gov.au/heritage-places/2253", "BCC Heritage Places");
  await head("https://www.slq.qld.gov.au/", "State Library of Queensland");
  await head("https://api.anthropic.com/v1/messages", "Anthropic API host");

  var L = "-".repeat(70);
  console.log(L); console.log("FLIP pipeline preflight"); console.log(L);
  ok.forEach(function (m) { console.log("  ok    " + m); });
  warnings.forEach(function (m) { console.log("  WARN  " + m); });
  problems.forEach(function (m) { console.log("  FAIL  " + m); });
  console.log(L);
  console.log(problems.length ? "NOT READY - fix the FAIL items above."
    : warnings.length ? "READY, with warnings." : "READY.");
  process.exit(problems.length ? 1 : 0);
})();
