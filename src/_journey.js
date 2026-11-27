// The journey of a landing from "Land" to the Nightly that ships it, and the rules about
// what counts: stage durations, status, cohorts and the freshness of each source. Free of
// imports, so the unit tests can load it.

// Percentiles over the landings that are done would drop the slow ones, so a tile only
// counts landings that had time to finish. 48 hours is more than land to publish takes
// for 99 of 100 landings. Half of the clients are on a build up to about 54 hours after
// it is published, for 9 builds of 10, so uptake gets 96.
export const PUBLISH_HORIZON_S = 48 * 3600;
export const UPTAKE_HORIZON_S = 96 * 3600;
export const UNMATCHED_AFTER_S = 7 * 86400;

const STAGES = [
  ["queue", "landoStarted"],
  ["lando", "pushed"],
  ["autoland", "merged"],
  ["waiting", "nightlyStarted"],
  ["build", "published"]
];

const between = (later, earlier) => (later == null || earlier == null ? null : later - earlier);

export function quantile(values, share) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  return sorted[below] + (at - below) * ((sorted[below + 1] ?? sorted[below]) - sorted[below]);
}

export function uptakeByBuild(rows) {
  return new Map(
    rows.map((row) => [
      row.build_id,
      {
        firstSeen: row.first_seen_s,
        observedUntil: row.observed_until_s,
        active24: row.active_24h,
        share6: row.share_6h,
        share12: row.share_12h,
        share24: row.share_24h,
        share48: row.share_48h,
        share72: row.share_72h,
        t25: row.t25_s,
        t50: row.t50_s
      }
    ])
  );
}

export function journeyOf(row, uptake) {
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
    buildId: row.nightly_build_id,
    queueClosed: row.queue_closed_s,
    autolandClosed: row.autoland_closed_s,
    backedOut: row.backed_out,
    backoutBy: row.backout_by,
    backout: row.backout_s,
    uptake: uptake.get(row.nightly_build_id) ?? null
  };
}

export function durationsOf(journey) {
  return {
    queue: between(journey.landoStarted, journey.requested),
    lando: between(journey.pushed, journey.landoStarted),
    autoland: between(journey.merged, journey.pushed),
    waiting: between(journey.nightlyStarted, journey.merged),
    build: between(journey.published, journey.nightlyStarted),
    total: between(journey.published, journey.requested),
    uptake: between(journey.uptake?.t50, journey.published),
    toHalf: between(journey.uptake?.t50, journey.requested)
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

export function watermarksOf(rows, uptakeRows) {
  const [first] = rows;
  return {
    landoUntil: first?.lando_until_s ?? null,
    treeherderUntil: first?.treeherder_until_s ?? null,
    fxciUntil: first?.fxci_until_s ?? null,
    commitMapsUntil: first?.commit_maps_until_s ?? null,
    uptakeUntil: uptakeRows[0]?.observed_until_s ?? null
  };
}

export function mergesOf(journeys) {
  const merges = new Map();
  for (const {centralRev, merged, mergedBy} of journeys) {
    if (centralRev !== null && merged !== null && !merges.has(centralRev)) merges.set(centralRev, {rev: centralRev, merged, by: mergedBy});
  }
  return [...merges.values()].sort((a, b) => a.merged - b.merged);
}
