#!/usr/bin/env node
/* Machine source verification.
 *
 * This is the safeguard that makes autonomous drafting safe. A model asked to
 * research and draft offline can produce a fluent question with a plausible but
 * wrong or non-existent URL, and schema validation cannot tell the difference.
 * So every candidate's source is FETCHED and corroborated before approval:
 *
 *   1. the URL must resolve (HTTP 200)
 *   2. the host must be on the allow-list of authoritative domains
 *   3. the page text must corroborate the claim - the distinctive terms of the
 *      answer and reveal must actually appear on the page
 *
 * A record that fails any of these is REJECTED, never downgraded. This turns
 * "the model says it checked" into "the artifact was checked".
 *
 *   node tools/flip-verify-sources.js batches/batch-002.json
 */
"use strict";
var fs = require("fs"), path = require("path"), https = require("https");
var engine = require("./flip-engine");

/* Authoritative hosts. Run one rejected QAGOMA, Government House, the
 * Queensland Museum blog and the RNA - all exactly the institutional sources the
 * brief asks for - because this was a hand-typed guess at ~20 hostnames. It is
 * now a pattern list, so any Queensland government or council domain qualifies,
 * plus named cultural institutions. Anything else is still rejected outright:
 * this widens what counts as authoritative, it does not lower the bar. */
var ALLOW_PATTERNS = [
  /(^|\.)qld\.gov\.au$/i,          // all QLD government, incl. councils and agencies
  /(^|\.)gov\.au$/i,               // other Australian government
  /(^|\.)nla\.gov\.au$/i,          // National Library / Trove
  /(^|\.)edu\.au$/i                // Australian universities
];
var ALLOW_HOSTS = [
  "queenslandplaces.com.au",          // Centre for the Government of Qld, UQ
  "visitbrisbane.com.au", "www.visitbrisbane.com.au",
  "visit.brisbane.qld.au",
  "brisbanepowerhouse.org", "www.brisbanepowerhouse.org",
  "qagoma.qld.gov.au", "www.qagoma.qld.gov.au",
  "www.rna.org.au", "rna.org.au",     // Royal National Association (the Ekka)
  "www.qm.qld.gov.au", "blog.qm.qld.gov.au",
  "translink.com.au", "www.translink.com.au",
  "trove.nla.gov.au",
  "www.nationaltrust.org.au", "nationaltrust.org.au",
  "adb.anu.edu.au",                   // Australian Dictionary of Biography
  "www.abc.net.au",                   // ABC news/history, secondary but reliable
  "www.museumofbrisbane.com.au", "museumofbrisbane.com.au",
  "www.seqwater.com.au", "seqwater.com.au",       // operates Enoggera Dam etc.
  "lonepinekoalasanctuary.com", "www.lonepinekoalasanctuary.com",
  "www.govhouse.qld.gov.au", "govhouse.qld.gov.au",
  "blogs.archives.qld.gov.au"
];
function hostAllowed(h) {
  h = (h || "").toLowerCase();
  if (ALLOW_HOSTS.indexOf(h) >= 0) return true;
  return ALLOW_PATTERNS.some(function (re) { return re.test(h); });
}

function fetchText(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve) {
    if (redirects > 4) return resolve({ status: 0, text: "", note: "too many redirects" });
    var req = https.get(url, { headers: { "User-Agent": "flip-source-verifier/1.0" } }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, redirects + 1));
      }
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { if (body.length < 400000) body += c; });
      res.on("end", function () { resolve({ status: res.statusCode, text: body, finalUrl: url }); });
    });
    req.on("error", function (e) { resolve({ status: 0, text: "", note: e.message }); });
    req.setTimeout(15000, function () { req.destroy(); resolve({ status: 0, text: "", note: "timeout" }); });
  });
}

function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").toLowerCase();
}
var STOP = /^(the|a|an|of|in|on|at|to|for|and|or|was|were|is|are|by|with|from|its|it|that|this|which|what|who|when|brisbane|queensland)$/;
function keyTerms(s) {
  return Array.from(new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(function (w) { return w.length > 3 && !STOP.test(w); })));
}

/* Corroboration, v2.
 *
 * v1 asked "do the answer's terms and years appear on this page". That is weak
 * evidence: a heritage page about a suburb mentions many buildings and many
 * years, so a question about the WRONG building can pass merely because both
 * names and both dates happen to occur somewhere on it.
 *
 * v2 asks three harder questions:
 *
 *   PROXIMITY   - the answer and its year must co-occur inside one window of
 *                 text, not merely both exist on a 40kb page.
 *   DISCRIMINATION - the page must support the CORRECT option distinctly better
 *                 than the distractor. If it supports both about equally, the
 *                 source does not establish the answer and the question is
 *                 ambiguous. Reject either way.
 *   IDENTITY    - the page must actually be the cited document, checked against
 *                 <title>, not just some page on an approved domain.
 *
 * This still cannot judge truth. It judges whether the cited page demonstrably
 * establishes this specific proposition, which is the part a drafting model
 * can most easily get wrong or invent.
 */
var WINDOW = 600;

function windowsContaining(text, term) {
  var out = [], i = text.indexOf(term);
  while (i >= 0 && out.length < 40) {
    out.push(text.slice(Math.max(0, i - WINDOW / 2), i + term.length + WINDOW / 2));
    i = text.indexOf(term, i + term.length);
  }
  return out;
}
/* Anchors must be WORDS. keyTerms keeps any token over 3 chars, so "1885" was
 * being chosen as the anchor for its own question - and then we asked whether
 * another year appeared near it, which is meaningless. Real example: a Tram Pole
 * heritage page states both 1885 (first horse tram) and 1897 (first electric
 * tram) plainly, and the question was rejected anyway. */
function isYearish(t) { return /^\d+$/.test(t); }
function wordTerms(s) { return keyTerms(s).filter(function (t) { return !isYearish(t); }); }
function bestAnchor(s) {
  return wordTerms(s).sort(function (a, b) { return b.length - a.length; })[0] || "";
}

function supportScore(text, label) {
  var terms = keyTerms(label);
  if (!terms.length) return 0;
  return terms.filter(function (t) { return text.indexOf(t) >= 0; }).length / terms.length;
}

function corroborate(pageText, pageTitle, rec) {
  var q = engine.normalise(rec);
  var opts = q.options || [];
  var right = opts.filter(function (o) { return o && o.id === q.correctOptionId; })[0];
  var wrong = opts.filter(function (o) { return o && o.id !== q.correctOptionId; })[0];
  var notes = [];
  if (!right || !wrong) return { ok: false, notes: ["options malformed"] };

  // IDENTITY
  var titleTerms = keyTerms(q.sourceTitle);
  var titleHits = titleTerms.filter(function (t) { return (pageTitle || "").indexOf(t) >= 0; }).length;
  var identityOk = !titleTerms.length || titleHits / titleTerms.length >= 0.4 ||
    supportScore(pageText.slice(0, 4000), q.sourceTitle) >= 0.6;
  if (!identityOk) notes.push("page does not appear to be the cited document (title mismatch)");

  // PROXIMITY - every year in the reveal must sit near the answer, not just on the page
  var years = (q.reveal.match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || []);
  /* If the answer is a bare year ("1897"), anchor on the PROMPT instead - what
     the question is actually about - rather than on the number itself. */
  var anchor = bestAnchor(right.label) || bestAnchor(q.prompt);
  var proximityOk = true;
  if (q.category === "which_came_first") {
    /* handled by the discrimination branch below, which checks each date
       against its own subject rather than against a single anchor */
  } else if (years.length && anchor) {
    /* The KEY date must sit near the answer's subject; any further dates in the
       reveal are context (a contrast year sits near a different subject by
       definition) and need only appear on the page at all. */
    var wins = windowsContaining(pageText, anchor);
    var keyYear = years[0];
    if (!wins.some(function (w) { return w.indexOf(keyYear) >= 0; })) {
      proximityOk = false;
      notes.push("the key date " + keyYear + " never appears near \"" + anchor + "\" on the page");
    }
    years.slice(1).forEach(function (y) {
      if (pageText.indexOf(y) < 0) {
        proximityOk = false;
        notes.push("date " + y + " in the reveal is not on the page at all");
      }
    });
  } else if (years.length) {
    proximityOk = years.every(function (y) { return pageText.indexOf(y) >= 0; });
    if (!proximityOk) notes.push("a year in the reveal is absent from the page");
  }

  /* DISCRIMINATION.
   * For most categories the page must support one option and not the other.
   * But a "which came first" question NAMES BOTH subjects, so a page covering
   * the comparison legitimately supports both - run one rejected two good
   * candidates at 1.00 vs 1.00 for exactly this reason. For that category the
   * correct test is stricter, not looser: BOTH subjects must appear AND each
   * date must sit near its own subject, which is what actually establishes the
   * ordering. */
  var sRight = supportScore(pageText, right.label);
  var sWrong = supportScore(pageText, wrong.label);
  var discriminates;
  if (q.category === "which_came_first") {
    var bothPresent = sRight >= 0.5 && sWrong >= 0.5;
    if (!bothPresent) {
      discriminates = false;
      notes.push("comparison page does not cover both subjects (correct " +
        sRight.toFixed(2) + ", other " + sWrong.toFixed(2) + ")");
    } else {
      /* Each year in the reveal must sit near one of the two subjects. */
      var anchors = [right.label, wrong.label].map(bestAnchor)
        .filter(Boolean);
      if (!anchors.length) anchors = wordTerms(q.prompt).slice(0, 3);
      var datedOk = years.length >= 2 && years.every(function (y) {
        return anchors.some(function (an) {
          return windowsContaining(pageText, an).some(function (w) { return w.indexOf(y) >= 0; });
        });
      });
      discriminates = datedOk;
      if (!datedOk) {
        notes.push(years.length < 2
          ? "a comparison needs both dates stated in the reveal"
          : "a date in the reveal is not stated near either subject on the page");
      }
    }
  } else if (!wordTerms(right.label).length || !wordTerms(wrong.label).length) {
    /* Tested against the real Tram Pole heritage page: a genuinely correct
       bare-year question and a deliberately WRONG one failed identically. The
       check could not tell them apart, because the page states many years. So
       do not pretend to verify this shape - reject it and let the generator
       word the options instead. */
    discriminates = false;
    notes.push("options are bare numbers/dates - word the options and put the " +
      "date in the reveal, so the source can actually settle which is correct");
  } else if (false) {
    /* Both options are bare dates/numbers. Term overlap cannot separate them, so
       test what actually matters: the correct value sits near the thing the
       PROMPT is about, and the wrong value does not. */
    var subj = wordTerms(q.prompt).slice(0, 3);
    var wins = [];
    subj.forEach(function (t) { wins = wins.concat(windowsContaining(pageText, t)); });
    var rightNear = wins.some(function (w) { return w.indexOf(right.label.trim()) >= 0; });
    var wrongNear = wins.some(function (w) { return w.indexOf(wrong.label.trim()) >= 0; });
    discriminates = rightNear && !wrongNear;
    if (!discriminates) {
      notes.push(rightNear
        ? "both values appear near the subject - the page does not settle which is correct"
        : "the correct value does not appear near the subject on the page");
    }
  } else {
    discriminates = sRight >= 0.5 && sRight - sWrong >= 0.34;
    if (!discriminates) {
      notes.push("source does not distinguish the options (correct " + sRight.toFixed(2) +
        " vs distractor " + sWrong.toFixed(2) + ") - ambiguous or unsupported");
    }
  }

  var revealTerms = keyTerms(q.reveal);
  var revealHits = revealTerms.filter(function (t) { return pageText.indexOf(t) >= 0; }).length;
  var revealRatio = revealTerms.length ? revealHits / revealTerms.length : 0;
  if (revealRatio < 0.5) notes.push("reveal is largely unsupported by the page (" +
    revealHits + "/" + revealTerms.length + " terms)");

  return {
    ok: identityOk && proximityOk && discriminates && revealRatio >= 0.5,
    identityOk: identityOk, proximityOk: proximityOk, discriminates: discriminates,
    supportCorrect: +sRight.toFixed(2), supportDistractor: +sWrong.toFixed(2),
    revealSupport: +revealRatio.toFixed(2), notes: notes
  };
}

(async function () {
  var batchPath = process.argv[2];
  if (!batchPath) { console.error("usage: flip-verify-sources.js <batch.json>"); process.exit(2); }
  var doc = JSON.parse(fs.readFileSync(path.resolve(batchPath), "utf8"));
  var recs = doc.bank || doc.questions || doc;
  var verified = [], rejected = [];

  for (var i = 0; i < recs.length; i++) {
    var rec = recs[i], q = engine.normalise(rec), reasons = [], detail = null;
    var host = "";
    try { host = new URL(q.sourceUrl).hostname; } catch (e) { reasons.push("source url malformed"); }
    if (host && !hostAllowed(host)) reasons.push("host not on the authoritative allow-list: " + host);

    if (!reasons.length) {
      var res = await fetchText(q.sourceUrl);
      if (res.status !== 200) reasons.push("source did not resolve (HTTP " + res.status +
        (res.note ? ", " + res.note : "") + ")");
      else {
        var title = (res.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].toLowerCase();
        var c = corroborate(strip(res.text), title, rec);
        detail = c;
        if (!c.ok) c.notes.forEach(function (n) { reasons.push(n); });
      }
    }
    if (reasons.length) rejected.push({ id: q.id, url: q.sourceUrl, reasons: reasons, detail: detail });
    else verified.push(rec);
    console.log((reasons.length ? "REJECT  " : "VERIFY  ") + (q.id || "?").padEnd(24) +
      (q.sourceUrl || "").slice(0, 60));
    if (detail) console.log("        support correct " + detail.supportCorrect +
      " / distractor " + detail.supportDistractor + "   reveal " + detail.revealSupport);
    reasons.forEach(function (r) { console.log("        ! " + r); });
  }

  var outPath = batchPath.replace(/\.json$/, ".verified.json");
  fs.writeFileSync(outPath, JSON.stringify({ bank: verified }, null, 2) + "\n");
  fs.writeFileSync(batchPath.replace(/\.json$/, ".rejected.json"),
    JSON.stringify({ rejected: rejected }, null, 2) + "\n");
  console.log("-".repeat(72));
  console.log("verified " + verified.length + " / " + recs.length +
    "   rejected " + rejected.length);
  console.log("wrote " + path.basename(outPath) + " for the ingest step");
  process.exit(rejected.length && !verified.length ? 1 : 0);
})();
