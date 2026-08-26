/* FLIP production question engine.
 *
 * This runs OFFLINE, not in the browser. It reads the approved bank plus the
 * canonical publication history, plans daily games forward, and writes
 * flip-schedule.json + flip-history.json to the origin.
 *
 * Why offline: publication history has to be canonical and identical for every
 * player. The previous implementation kept "history" in each visitor's
 * localStorage, so repeat prevention was per-device — a new phone saw the
 * rotation restart from nothing. A published schedule on the origin is the only
 * way the same question reaches every player on the same day AND the same
 * question is genuinely retired for twelve months.
 *
 * The browser does no selection at all. It looks up today's entry and renders
 * it, or fails safely.
 */
"use strict";

var REPEAT_DAYS = 365;

/* The five slots, in fixed order. Position 5 is the only one that may be
 * knowledgeOnly. */
var SLOTS = [
  { slot: 1, category: "suburb_story",     difficulty: 1 },
  { slot: 2, category: "landmark_oddity",  difficulty: 2 },
  { slot: 3, category: "which_came_first", difficulty: 1 },
  { slot: 4, category: "homes_lifestyle",  difficulty: 2 },
  { slot: 5, category: "wildcard",         difficulty: 3 }
];

var CATEGORIES = SLOTS.map(function (s) { return s.category; });

/* Hosts that can never reach production, whatever a record claims. */
var BANNED_HOST = /(^|\.)(example\.(com|org|net|invalid)|test\.invalid|localhost)$/i;

var DAY_MS = 86400000;
function dayNum(iso) { return Math.floor(Date.parse(iso + "T00:00:00Z") / DAY_MS); }
function daysBetween(a, b) { return Math.abs(dayNum(a) - dayNum(b)); }
function addDays(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}
function isDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)); }

/* Records may carry `answer` (seed schema) or `correctOptionId` (production
 * schema), and source fields flat or nested. Normalise once so everything
 * downstream sees one shape. */
function normalise(raw) {
  if (!raw || typeof raw !== "object") return null;
  var src = raw.source || {};
  return {
    id: raw.id,
    prompt: raw.prompt,
    options: raw.options,
    correctOptionId: raw.correctOptionId != null ? raw.correctOptionId : raw.answer,
    reveal: raw.reveal,
    sourceTitle: raw.sourceTitle || src.title,
    sourceUrl: raw.sourceUrl || src.url,
    sourcePublisher: raw.sourcePublisher || src.publisher,
    verifiedOn: raw.verifiedOn,
    verifierNote: raw.verifierNote || src.verifierNote,
    category: raw.category,
    topicKey: raw.topicKey,
    predictedDifficulty: raw.predictedDifficulty != null ? raw.predictedDifficulty : raw.difficulty,
    knowledgeOnly: raw.knowledgeOnly,
    tags: raw.tags,
    status: raw.status,
    provenance: raw.provenance || "production",
    active: raw.active !== false,
    _raw: raw
  };
}

/* Full production validation. Returns a list of failure reasons; empty means
 * the record is production-ready. `allowMissingVerifierNote` exists only for
 * the seed bridge described in flip-engine-config.json. */
function validate(rec, opts) {
  opts = opts || {};
  var q = normalise(rec);
  var bad = [];
  if (!q) return ["record is not an object"];

  if (!q.id || typeof q.id !== "string") bad.push("id missing");
  if (!q.prompt || typeof q.prompt !== "string") bad.push("prompt missing");
  if (!q.reveal || typeof q.reveal !== "string") bad.push("reveal missing");
  if (q.reveal && q.prompt && q.reveal.trim() === q.prompt.trim()) bad.push("reveal repeats the prompt");

  if (!Array.isArray(q.options) || q.options.length !== 2) bad.push("must have exactly 2 options");
  else {
    if (!q.options[0] || !q.options[1]) bad.push("option entry empty");
    else {
      if (!q.options[0].id || !q.options[1].id) bad.push("option id missing");
      if (!q.options[0].label || !q.options[1].label) bad.push("option label missing");
      if (q.options[0].id === q.options[1].id) bad.push("duplicate option ids");
      var ids = q.options.map(function (o) { return o && o.id; });
      if (ids.indexOf(q.correctOptionId) === -1) bad.push("correctOptionId does not match an option");
    }
  }

  if (!q.sourceTitle) bad.push("sourceTitle missing");
  if (!q.sourcePublisher) bad.push("sourcePublisher missing");
  if (!q.sourceUrl) bad.push("sourceUrl missing");
  else {
    var host = null;
    try { host = new URL(q.sourceUrl).hostname; } catch (e) { bad.push("sourceUrl is not a URL"); }
    if (host) {
      if (!/^https:$/i.test(new URL(q.sourceUrl).protocol)) bad.push("sourceUrl is not https");
      if (BANNED_HOST.test(host)) bad.push("placeholder source host (" + host + ")");
    }
  }

  if (!isDate(q.verifiedOn)) bad.push("verifiedOn missing or malformed");
  if (!q.verifierNote && !opts.allowMissingVerifierNote) bad.push("verifierNote missing");

  if (CATEGORIES.indexOf(q.category) === -1) bad.push("category not one of the five");
  if (!q.topicKey || typeof q.topicKey !== "string") bad.push("topicKey missing");
  if ([1, 2, 3].indexOf(q.predictedDifficulty) === -1) bad.push("predictedDifficulty must be 1, 2 or 3");
  if (typeof q.knowledgeOnly !== "boolean") bad.push("knowledgeOnly must be boolean");
  if (!Array.isArray(q.tags) || !q.tags.length) bad.push("tags missing");
  if (q.status !== "approved" && q.status !== "verified") bad.push("status is not approved/verified");
  if (!q.active) bad.push("record marked inactive");

  return bad;
}

/* Splits a bank into production-ready records and a quarantine with reasons. */
function partition(bank, opts) {
  var ok = [], quarantined = [];
  (bank || []).forEach(function (raw) {
    var reasons = validate(raw, opts);
    if (reasons.length) quarantined.push({ id: (raw && raw.id) || "(no id)", reasons: reasons });
    else ok.push(normalise(raw));
  });
  return { approved: ok, quarantined: quarantined };
}

/* Publication history: a flat list of occurrences. Indexed here for lookup. */
function indexHistory(history) {
  var byId = {}, byTopic = {};
  (history && history.published ? history.published : []).forEach(function (h) {
    if (!byId[h.questionId] || h.date > byId[h.questionId]) byId[h.questionId] = h.date;
    if (!byTopic[h.topicKey] || h.date > byTopic[h.topicKey]) byTopic[h.topicKey] = h.date;
  });
  return { byId: byId, byTopic: byTopic };
}

/* Eligibility for one date. Returns the record plus the reason it qualified,
 * or the reason it was blocked — diagnostics need both sides. */
function eligibility(rec, isoDate, idx, repeatDays) {
  var lastId = idx.byId[rec.id] || null;
  var lastTopic = idx.byTopic[rec.topicKey] || null;
  if (lastId && daysBetween(isoDate, lastId) < repeatDays) {
    return { eligible: false, blockedBy: "questionId", lastUsedId: lastId, lastUsedTopic: lastTopic };
  }
  if (lastTopic && daysBetween(isoDate, lastTopic) < repeatDays) {
    return { eligible: false, blockedBy: "topicKey", lastUsedId: lastId, lastUsedTopic: lastTopic };
  }
  return {
    eligible: true,
    blockedBy: null,
    lastUsedId: lastId,
    lastUsedTopic: lastTopic,
    reason: lastId || lastTopic
      ? "outside the " + repeatDays + "-day repeat window"
      : "never published"
  };
}

/* Deterministic A/B order. Same input, same order, forever — so the published
 * schedule fully determines what a player sees. */
function hash(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function optionOrder(questionId, isoDate, slot, options) {
  var ids = options.map(function (o) { return o.id; });
  return hash(questionId + "|" + isoDate + "|" + slot) % 2 === 1 ? ids.slice().reverse() : ids;
}

/* Builds ONE day. Never recycles: if a slot has no eligible record the day
 * fails and says which slot and why. */
function planDay(approved, isoDate, idx, repeatDays) {
  var chosen = [], usedIds = {}, usedTopics = {}, koCount = 0, shortfalls = [];

  SLOTS.forEach(function (spec) {
    var pool = approved.filter(function (r) {
      if (r.category !== spec.category) return false;
      if (r.predictedDifficulty !== spec.difficulty) return false;
      if (usedIds[r.id] || usedTopics[r.topicKey]) return false;
      if (r.knowledgeOnly && spec.slot !== 5) return false;   // only slot 5 may be knowledge-only
      return eligibility(r, isoDate, idx, repeatDays).eligible;
    });
    if (!pool.length) {
      shortfalls.push({
        slot: spec.slot, category: spec.category, difficulty: spec.difficulty,
        reason: "no eligible approved record for this category and difficulty"
      });
      return;
    }
    /* Oldest-used first, then a stable hash, so planning is reproducible. */
    pool.sort(function (a, b) {
      var la = idx.byId[a.id] || "0000-00-00", lb = idx.byId[b.id] || "0000-00-00";
      if (la !== lb) return la < lb ? -1 : 1;
      return hash(isoDate + "|" + a.id) - hash(isoDate + "|" + b.id);
    });
    var pick = pool[0];
    usedIds[pick.id] = true;
    usedTopics[pick.topicKey] = true;
    if (pick.knowledgeOnly) koCount++;
    var el = eligibility(pick, isoDate, idx, repeatDays);
    chosen.push({
      slot: spec.slot,
      questionId: pick.id,
      topicKey: pick.topicKey,
      category: pick.category,
      difficulty: pick.predictedDifficulty,
      knowledgeOnly: pick.knowledgeOnly,
      optionOrder: optionOrder(pick.id, isoDate, spec.slot, pick.options),
      provenance: pick.provenance,
      sourcePublisher: pick.sourcePublisher,
      sourceUrl: pick.sourceUrl,
      status: pick.status,
      lastUsedQuestionId: el.lastUsedId,
      lastUsedTopicKey: el.lastUsedTopic,
      eligibleBecause: el.reason
    });
  });

  if (shortfalls.length || chosen.length !== 5 || koCount > 1) {
    return {
      date: isoDate, ok: false, questions: [],
      shortfalls: shortfalls.length ? shortfalls
        : [{ reason: koCount > 1 ? "more than one knowledgeOnly record" : "incomplete day" }]
    };
  }
  return { date: isoDate, ok: true, questions: chosen, shortfalls: [] };
}

/* Plans forward from `fromDate` until the bank runs dry or `maxDays` is hit.
 * Stops at the first day it cannot fill — it does not skip ahead, because a
 * gap in the schedule is a gap in the game. */
function plan(bank, history, fromDate, maxDays, opts) {
  opts = opts || {};
  var repeatDays = opts.repeatDays || REPEAT_DAYS;
  var part = partition(bank, opts);
  var idx = indexHistory(history);
  var published = (history && history.published ? history.published.slice() : []);
  var days = [], stoppedAt = null;

  for (var i = 0; i < maxDays; i++) {
    var iso = addDays(fromDate, i);
    var day = planDay(part.approved, iso, idx, repeatDays);
    if (!day.ok) { stoppedAt = day; break; }
    days.push(day);
    day.questions.forEach(function (q) {
      idx.byId[q.questionId] = iso;
      idx.byTopic[q.topicKey] = iso;
      published.push({
        questionId: q.questionId, topicKey: q.topicKey,
        date: iso, slot: q.slot, provenance: q.provenance
      });
    });
  }

  return {
    days: days,
    stoppedAt: stoppedAt,
    published: published,
    approved: part.approved,
    quarantined: part.quarantined,
    repeatDays: repeatDays
  };
}

/* Bank-wide counters for the diagnostics report. */
function bankReport(bank, history, isoDate, opts) {
  opts = opts || {};
  var repeatDays = opts.repeatDays || REPEAT_DAYS;
  var part = partition(bank, opts);
  var idx = indexHistory(history);
  var byCategory = {}, blockedById = 0, blockedByTopic = 0, eligibleToday = 0;
  CATEGORIES.forEach(function (c) { byCategory[c] = { approved: 0, eligibleToday: 0 }; });

  part.approved.forEach(function (r) {
    if (byCategory[r.category]) byCategory[r.category].approved++;
    var el = eligibility(r, isoDate, idx, repeatDays);
    if (el.eligible) {
      eligibleToday++;
      if (byCategory[r.category]) byCategory[r.category].eligibleToday++;
    } else if (el.blockedBy === "questionId") blockedById++;
    else blockedByTopic++;
  });

  var placeholders = part.quarantined.filter(function (q) {
    return q.reasons.some(function (r) { return /placeholder source host/.test(r); });
  });

  return {
    date: isoDate,
    repeatWindowDays: repeatDays,
    totalRecords: (bank || []).length,
    approvedRecords: part.approved.length,
    eligibleToday: eligibleToday,
    byCategory: byCategory,
    blockedByQuestionIdWindow: blockedById,
    blockedByTopicKeyWindow: blockedByTopic,
    quarantined: part.quarantined,
    quarantinedCount: part.quarantined.length,
    placeholderRecordsExcluded: placeholders.length,
    daysOfSupplyRemaining: null   // filled in by the planner
  };
}

module.exports = {
  REPEAT_DAYS: REPEAT_DAYS,
  SLOTS: SLOTS,
  CATEGORIES: CATEGORIES,
  normalise: normalise,
  validate: validate,
  partition: partition,
  indexHistory: indexHistory,
  eligibility: eligibility,
  optionOrder: optionOrder,
  planDay: planDay,
  plan: plan,
  bankReport: bankReport,
  addDays: addDays,
  daysBetween: daysBetween,
  hash: hash
};
