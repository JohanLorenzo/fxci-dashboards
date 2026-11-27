import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {
  currentStage,
  durationsOf,
  inCohort,
  journeyOf,
  mergesOf,
  PUBLISH_HORIZON_S,
  quantile,
  statusOf,
  UNMATCHED_AFTER_S,
  uptakeByBuild,
  UPTAKE_HORIZON_S,
  watermarksOf
} from "../../src/_journey.js";

const HOUR = 3600;
const T0 = 1_795_000_000;

const row = (overrides = {}) => ({
  revision_id: 345001,
  bug_id: 2022026,
  job_id: 85061,
  stack_size: 2,
  stack_index: 1,
  requested_by: "alice",
  failed_attempts: 0,
  autoland_rev: "a".repeat(40),
  central_rev: "c".repeat(40),
  merged_by: "sheriff-a",
  phab_created_s: T0 - 2 * 86400,
  phab_approved_s: T0 - HOUR,
  land_requested_s: T0,
  lando_started_s: T0 + 300,
  autoland_pushed_s: T0 + 420,
  merged_s: T0 + 6 * HOUR,
  nightly_started_s: T0 + 8 * HOUR,
  nightly_published_s: T0 + 10 * HOUR,
  nightly_decision_id: "d".repeat(22),
  nightly_last_task_id: "t".repeat(22),
  nightly_build_id: "20261126095627",
  queue_closed_s: 0,
  autoland_closed_s: 1800,
  backed_out: false,
  backout_by: null,
  backout_s: null,
  lando_until_s: T0 + 30 * 86400,
  treeherder_until_s: T0 + 30 * 86400 + 4 * HOUR,
  fxci_until_s: T0 + 30 * 86400 + 11 * HOUR,
  commit_maps_until_s: T0 + 30 * 86400 - HOUR,
  ...overrides
});

const uptakeRow = (overrides = {}) => ({
  build_id: "20261126095627",
  first_seen_s: T0 + 10 * HOUR + 600,
  observed_until_s: T0 + 30 * 86400,
  active_24h: 8000,
  share_6h: 0.25,
  share_12h: 0.3,
  share_24h: 0.55,
  share_48h: 0.65,
  share_72h: 0.7,
  t25_s: T0 + 16 * HOUR,
  t50_s: T0 + 34 * HOUR,
  ...overrides
});

describe("quantile", () => {
  test("is nothing for no value", () => {
    assert.equal(quantile([], 0.5), undefined);
  });

  test("is the value itself for one value", () => {
    assert.equal(quantile([7], 0.95), 7);
  });

  test("interpolates between the values, like d3.quantile", () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.ok(Math.abs(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) - 9.1) < 1e-9);
    assert.equal(quantile([1, 2, 3, 4], 0), 1);
    assert.equal(quantile([1, 2, 3, 4], 1), 4);
  });

  test("does not need the values sorted, and leaves them as they were", () => {
    const values = [4, 1, 3, 2];
    assert.equal(quantile(values, 0.5), 2.5);
    assert.deepEqual(values, [4, 1, 3, 2]);
  });

  test("ignores a value that is not there", () => {
    assert.equal(quantile([1, null, 3, undefined, NaN], 0.5), 2);
  });
});

describe("journeyOf", () => {
  test("names what the row holds", () => {
    const journey = journeyOf(row(), new Map());
    assert.equal(journey.revision, 345001);
    assert.equal(journey.bug, 2022026);
    assert.equal(journey.job, 85061);
    assert.equal(journey.requester, "alice");
    assert.equal(journey.requested, T0);
    assert.equal(journey.published, T0 + 10 * HOUR);
    assert.equal(journey.buildId, "20261126095627");
    assert.equal(journey.stack.size, 2);
    assert.equal(journey.stack.index, 1);
    assert.equal(journey.backedOut, false);
  });

  test("keeps a stage that has not happened as null", () => {
    const journey = journeyOf(row({merged_s: null, nightly_started_s: null, nightly_published_s: null, nightly_build_id: null, central_rev: null}), new Map());
    assert.equal(journey.merged, null);
    assert.equal(journey.published, null);
    assert.equal(journey.uptake, null);
  });

  test("takes the uptake of its build", () => {
    const journey = journeyOf(row(), uptakeByBuild([uptakeRow()]));
    assert.equal(journey.uptake.share24, 0.55);
    assert.equal(journey.uptake.t50, T0 + 34 * HOUR);
  });

  test("has no uptake when its build is not among them", () => {
    assert.equal(journeyOf(row(), uptakeByBuild([uptakeRow({build_id: "20260101000000"})])).uptake, null);
  });

  test("calls a requester that is not known by a name, so a search can still read it", () => {
    assert.equal(journeyOf(row({requested_by: null}), new Map()).requester, "unknown");
  });
});

describe("durationsOf", () => {
  test("measures each stage between its two moments", () => {
    const durations = durationsOf(journeyOf(row(), uptakeByBuild([uptakeRow()])));
    assert.equal(durations.queue, 300);
    assert.equal(durations.lando, 120);
    assert.equal(durations.autoland, 6 * HOUR - 420);
    assert.equal(durations.waiting, 2 * HOUR);
    assert.equal(durations.build, 2 * HOUR);
    assert.equal(durations.total, 10 * HOUR);
    assert.equal(durations.uptake, 24 * HOUR);
    assert.equal(durations.toHalf, 34 * HOUR);
  });

  test("has no duration for a stage that did not end, nor for one that did not begin", () => {
    const durations = durationsOf(journeyOf(row({merged_s: null, nightly_started_s: null, nightly_published_s: null}), new Map()));
    assert.equal(durations.queue, 300);
    assert.equal(durations.autoland, null);
    assert.equal(durations.waiting, null);
    assert.equal(durations.build, null);
    assert.equal(durations.total, null);
    assert.equal(durations.uptake, null);
  });

  test("has no uptake duration until half the clients are on the build", () => {
    const durations = durationsOf(journeyOf(row(), uptakeByBuild([uptakeRow({t50_s: null})])));
    assert.equal(durations.uptake, null);
    assert.equal(durations.toHalf, null);
  });
});

describe("statusOf", () => {
  const marks = {landoUntil: T0 + 30 * 86400};

  test("is shipped once a Nightly has published it", () => {
    assert.equal(statusOf(journeyOf(row(), new Map()), marks), "shipped");
  });

  test("is backed out whatever else happened, because the backout ends its journey", () => {
    assert.equal(statusOf(journeyOf(row({backed_out: true, backout_by: "sheriff-b", backout_s: T0 + HOUR}), new Map()), marks), "backed out");
  });

  test("is in flight while a stage is yet to come", () => {
    const journey = journeyOf(row({land_requested_s: marks.landoUntil - 2 * 86400, nightly_published_s: null}), new Map());
    assert.equal(statusOf(journey, marks), "in flight");
  });

  test("is unmatched when nothing came of it for more than 7 days", () => {
    const old = (seconds) => journeyOf(row({land_requested_s: marks.landoUntil - seconds, merged_s: null, nightly_started_s: null, nightly_published_s: null}), new Map());
    assert.equal(statusOf(old(UNMATCHED_AFTER_S), marks), "in flight");
    assert.equal(statusOf(old(UNMATCHED_AFTER_S + 1), marks), "unmatched");
  });
});

describe("currentStage", () => {
  const at = (overrides) => currentStage(journeyOf(row(overrides), new Map()));

  test("is the first stage that has not ended", () => {
    assert.equal(at({lando_started_s: null, autoland_pushed_s: null, merged_s: null, nightly_started_s: null, nightly_published_s: null}), "queue");
    assert.equal(at({autoland_pushed_s: null, merged_s: null, nightly_started_s: null, nightly_published_s: null}), "lando");
    assert.equal(at({merged_s: null, nightly_started_s: null, nightly_published_s: null}), "autoland");
    assert.equal(at({nightly_started_s: null, nightly_published_s: null}), "waiting");
    assert.equal(at({nightly_published_s: null}), "build");
  });

  test("is nothing once it has published", () => {
    assert.equal(at({}), null);
  });
});

describe("inCohort", () => {
  test("keeps the landings that had the whole horizon to finish", () => {
    const until = T0;
    assert.equal(inCohort({requested: until - PUBLISH_HORIZON_S}, until, PUBLISH_HORIZON_S), true);
    assert.equal(inCohort({requested: until - PUBLISH_HORIZON_S + 1}, until, PUBLISH_HORIZON_S), false);
  });

  test("gives uptake a longer horizon than publication", () => {
    assert.ok(UPTAKE_HORIZON_S > PUBLISH_HORIZON_S);
  });
});

describe("watermarksOf", () => {
  test("reads the newest row of each source", () => {
    const marks = watermarksOf([row()], [uptakeRow()]);
    assert.equal(marks.landoUntil, T0 + 30 * 86400);
    assert.equal(marks.treeherderUntil, T0 + 30 * 86400 + 4 * HOUR);
    assert.equal(marks.fxciUntil, T0 + 30 * 86400 + 11 * HOUR);
    assert.equal(marks.commitMapsUntil, T0 + 30 * 86400 - HOUR);
    assert.equal(marks.uptakeUntil, T0 + 30 * 86400);
  });

  test("has no uptake watermark without uptake rows", () => {
    assert.equal(watermarksOf([row()], []).uptakeUntil, null);
  });
});

describe("mergesOf", () => {
  test("lists each merge to main once, whatever number of revisions it carried", () => {
    const journeys = [
      journeyOf(row({revision_id: 1, central_rev: "x"}), new Map()),
      journeyOf(row({revision_id: 2, central_rev: "x"}), new Map()),
      journeyOf(row({revision_id: 3, central_rev: "y", merged_s: T0 + 9 * HOUR}), new Map())
    ];
    assert.deepEqual(mergesOf(journeys).map(({rev, merged}) => [rev, merged]), [["x", T0 + 6 * HOUR], ["y", T0 + 9 * HOUR]]);
  });

  test("leaves out the landings that are not merged yet", () => {
    assert.deepEqual(mergesOf([journeyOf(row({central_rev: null, merged_s: null}), new Map())]), []);
  });
});

describe("uptakeByBuild", () => {
  test("finds a build by its id", () => {
    const builds = uptakeByBuild([uptakeRow(), uptakeRow({build_id: "20261127000000", share_24h: null, t50_s: null})]);
    assert.equal(builds.size, 2);
    assert.equal(builds.get("20261127000000").share24, null);
    assert.equal(builds.get("20261127000000").t50, null);
  });
});
