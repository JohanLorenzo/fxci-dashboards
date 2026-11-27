// The journey of a landing from "Land" to the Nightly that ships it, and the rules about
// what counts: stage durations, status, cohorts and the freshness of each source. Free of
// imports, so the unit tests can load it.

// Percentiles over the landings that are done would drop the slow ones, so a tile only
// counts landings that had time to finish. 48 hours is more than land to publish takes
// for 99 of 100 landings.
export const PUBLISH_HORIZON_S = 48 * 3600;
export const UNMATCHED_AFTER_S = 7 * 86400;

const STAGES = [
  ["queue", "landoStarted"],
  ["lando", "pushed"],
  ["autoland", "merged"],
  ["waiting", "nightlyStarted"],
  ["build", "published"]
];

export const STAGE_INFO = [
  {key: "queue", title: "Lando queue", color: "#6fbf8e"},
  {key: "lando", title: "Lando landing", color: "#237a4b"},
  {key: "autoland", title: "On autoland until merged to main", color: "#e0902c"},
  {key: "waiting", title: "Merged to main until the Nightly starts", color: "#cf5b82"},
  {key: "build", title: "Nightly build and publish", color: "#5b6abf"}
];

// The Lando queue and the time on autoland are told apart by whether the tree was
// closed, which is what held up most of a long wait.
export const CANDLE_SEGMENTS = [
  {key: "queueOpen", title: "Lando queue", color: "#6fbf8e"},
  {key: "queueClosed", title: "Lando queue, while autoland was closed", color: "#e07b7b"},
  {key: "lando", title: "Lando landing", color: "#237a4b"},
  {key: "autolandOpen", title: "On autoland until merged to main", color: "#e0902c"},
  {key: "autolandClosed", title: "On autoland, while it was closed", color: "#b3202a"},
  {key: "waiting", title: "Merged to main until the Nightly starts", color: "#cf5b82"},
  {key: "build", title: "Nightly build and publish", color: "#5b6abf"}
];

export const MEASURES = [{key: "total", title: "Land to published in a Nightly"}, ...STAGE_INFO.map(({key, title}) => ({key, title}))];

const between = (later, earlier) => (later == null || earlier == null ? null : later - earlier);

export function quantile(values, share) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  return sorted[below] + (at - below) * ((sorted[below + 1] ?? sorted[below]) - sorted[below]);
}

export function journeyOf(row) {
  return {
    revision: row.revision_id,
    bug: row.bug_id,
    job: row.job_id,
    stack: {size: row.stack_size, index: row.stack_index},
    requester: row.requested_by ?? "unknown",
    failedAttempts: row.failed_attempts,
    autolandRev: row.autoland_rev,
    centralRev: row.central_rev,
    mergedBy: row.merged_by,
    phabCreated: row.phab_created_s,
    phabApproved: row.phab_approved_s,
    requested: row.land_requested_s,
    landoStarted: row.lando_started_s,
    pushed: row.autoland_pushed_s,
    merged: row.merged_s,
    nightlyStarted: row.nightly_started_s,
    published: row.nightly_published_s,
    decisionId: row.nightly_decision_id,
    lastTaskId: row.nightly_last_task_id,
    queueClosed: row.queue_closed_s,
    autolandClosed: row.autoland_closed_s,
    backedOut: row.backed_out,
    backoutBy: row.backout_by,
    backout: row.backout_s
  };
}

export function durationsOf(journey) {
  return {
    queue: between(journey.landoStarted, journey.requested),
    lando: between(journey.pushed, journey.landoStarted),
    autoland: between(journey.merged, journey.pushed),
    waiting: between(journey.nightlyStarted, journey.merged),
    build: between(journey.published, journey.nightlyStarted),
    total: between(journey.published, journey.requested)
  };
}

export function statusOf(journey, {landoUntil}) {
  if (journey.backedOut) return "backed out";
  if (journey.published !== null) return "shipped";
  return landoUntil - journey.requested > UNMATCHED_AFTER_S ? "unmatched" : "in flight";
}

export function currentStage(journey) {
  const [stage] = STAGES.find(([, end]) => journey[end] === null) ?? [null];
  return stage;
}

export const inCohort = (journey, untilS, horizonS) => journey.requested <= untilS - horizonS;

export function dominantStage(durations) {
  let longest = null;
  for (const [stage] of STAGES) {
    if (durations[stage] !== null && (longest === null || durations[stage] > durations[longest])) longest = stage;
  }
  return longest;
}

export function parseRevision(text) {
  const match = /^\s*D?(\d{1,9})\s*$/i.exec(text ?? "");
  return match ? Number(match[1]) : null;
}

export function matchesQuery(journey, query) {
  const label = `d${journey.revision}`;
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(
      (term) =>
        label.includes(term) ||
        String(journey.bug ?? "").includes(term) ||
        journey.requester.toLowerCase().includes(term) ||
        (journey.autolandRev ?? "").startsWith(term) ||
        (journey.centralRev ?? "").startsWith(term)
    );
}

export function topNames(names, count) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([name]) => name);
}

const STAGE_ORDER = STAGES.map(([stage]) => stage);
const OPEN_ENDS = {queue: "landoUntil", lando: "commitMapsUntil", autoland: "treeherderUntil", waiting: "treeherderUntil", build: "fxciUntil"};

// The stages a landing went through, each from where it began to where it ended, and where
// the journey ends: when a Nightly publishes it, at its backout, or, for a landing still
// on its way, at what the source of its next event has recorded, which is not the present.
// A stage that began at or after that end is left out, and `open` is a stage that is still
// going on at the end.
export function spansOf(journey, marks) {
  const bounds = [journey.requested, journey.landoStarted, journey.pushed, journey.merged, journey.nightlyStarted, journey.published];
  const openAt = bounds.indexOf(null);
  let end;
  let kind = "open";
  if (journey.backedOut) {
    end = journey.backout;
    kind = "backed out";
  } else if (openAt === -1) {
    end = journey.published;
    kind = "shipped";
  } else {
    const watermark = marks[OPEN_ENDS[STAGE_ORDER[openAt - 1]]];
    end = Math.max(watermark ?? bounds[openAt - 1], bounds[openAt - 1]);
  }
  const spans = STAGE_ORDER.flatMap((key, index) => {
    const start = bounds[index];
    if (start === null || start >= end) return [];
    return [{key, start, end: Math.min(bounds[index + 1] ?? end, end), open: kind === "open" && bounds[index + 1] === null}];
  });
  return {spans, end, kind};
}

// What a landing's bar is made of, in seconds. The Lando queue and the time on autoland
// are each told apart by whether the tree was closed.
export function candleOf(journey, marks) {
  const {spans, end, kind} = spansOf(journey, marks);
  const seconds = (stage) => {
    const span = spans.find(({key}) => key === stage);
    return span ? span.end - span.start : 0;
  };
  const queueClosed = Math.min(journey.queueClosed ?? 0, seconds("queue"));
  const autolandClosed = Math.min(journey.autolandClosed ?? 0, seconds("autoland"));
  return {
    segments: {
      queueOpen: seconds("queue") - queueClosed,
      queueClosed,
      lando: seconds("lando"),
      autolandOpen: seconds("autoland") - autolandClosed,
      autolandClosed,
      waiting: seconds("waiting"),
      build: seconds("build")
    },
    total: end - journey.requested,
    end,
    kind
  };
}

export function formatDuration(seconds) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export const stackBucket = (size) => (size <= 2 ? String(size) : size <= 5 ? "3 to 5" : "6 or more");

export function watermarksOf(rows) {
  const [first] = rows;
  return {
    landoUntil: first?.lando_until_s ?? null,
    treeherderUntil: first?.treeherder_until_s ?? null,
    fxciUntil: first?.fxci_until_s ?? null,
    commitMapsUntil: first?.commit_maps_until_s ?? null
  };
}

export function mergesOf(journeys) {
  const merges = new Map();
  for (const {centralRev, merged, mergedBy} of journeys) {
    if (centralRev !== null && merged !== null && !merges.has(centralRev)) merges.set(centralRev, {rev: centralRev, merged, by: mergedBy});
  }
  return [...merges.values()].sort((a, b) => a.merged - b.merged);
}
