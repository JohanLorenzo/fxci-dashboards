---
title: Ship to Nightly faster
toc: false
---

# Ship to Nightly faster

How long a patch takes from "Land" in Phabricator to a Nightly that people run. Each
landing is followed through Lando, autoland, the merge to main, the Nightly build
and, last, how soon the Nightly population runs the build.

```js
import {durationsOf, inCohort, journeyOf, mergesOf, PUBLISH_HORIZON_S, quantile, statusOf, UPTAKE_HORIZON_S, uptakeByBuild, watermarksOf} from "./_journey.js";
import {createTooltip} from "./_tooltip.js";
import {DAY_MS, eventRule, formatTime, syncCharts} from "./_time-charts.js";
import {collapsibleBlock, hiddenKeysState} from "./_legend.js";
import {metricsRow} from "./_metrics.js";
```

```js
const journeyRows = (await FileAttachment("data/nightly-journeys.parquet").parquet()).toArray();
const uptakeRows = (await FileAttachment("data/nightly-uptake.parquet").parquet()).toArray();
const closureRows = (await FileAttachment("data/nightly-treestatus.parquet").parquet()).toArray();
```

```js
// The sources lag the present by different amounts, so each has its own watermark.
// A tile only counts the landings that had time to finish by the oldest of them.
const marks = watermarksOf(journeyRows, uptakeRows);
const publishUntil = Math.min(marks.landoUntil, marks.commitMapsUntil);
const uptakeUntil = Math.min(publishUntil, marks.uptakeUntil ?? publishUntil);
const uptake = uptakeByBuild(uptakeRows);
const journeys = journeyRows.map((row) => journeyOf(row, uptake));
const secondsToDate = (seconds) => new Date(seconds * 1000);

const landings = journeys.map((journey) => ({
  kind: "landing",
  time: secondsToDate(journey.requested),
  journey,
  durations: durationsOf(journey),
  status: statusOf(journey, marks),
  publishCohort: inCohort(journey, publishUntil, PUBLISH_HORIZON_S),
  uptakeCohort: inCohort(journey, uptakeUntil, UPTAKE_HORIZON_S)
}));
const merges = mergesOf(journeys).map((merge) => ({kind: "merge", time: secondsToDate(merge.merged)}));
const closures = closureRows
  .filter((row) => row.status === "closed" && row.end_s !== null)
  .map((row) => ({kind: "closure", time: secondsToDate(row.start_s), hours: (row.end_s - row.start_s) / 3600}));

const DATA_FIRST_DAY = d3.utcDay.floor(secondsToDate(d3.min(journeys, (journey) => journey.requested)));
const DATA_LAST_DAY = d3.utcDay.floor(secondsToDate(marks.landoUntil));
const DEFAULT_FROM = new Date(Math.max(+DATA_FIRST_DAY, +DATA_LAST_DAY - 6 * DAY_MS));
const dayAfter = (day) => new Date(+day + DAY_MS);
const inDomain = (domain, time) => time >= domain[0] && time < domain[1];
```

```js
const formatCount = (n) => Math.round(n).toLocaleString("en-US");
const formatPercent = (share) => `${Math.round(share * 1000) / 10}%`;
function formatWait(hours) {
  const seconds = Math.round(hours * 3600);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const landingsOf = (items) => items.filter((item) => item.kind === "landing");
const shippedIn = (cohort) => (items) => landingsOf(items).filter((landing) => landing[cohort] && landing.status === "shipped");
const hoursOf = (seconds) => (seconds === undefined ? undefined : seconds / 3600);
const percentile = (cohort, key, share) => (items) => hoursOf(quantile(shippedIn(cohort)(items).map((landing) => landing.durations[key]), share));
const shareOf = (isIt) => (items) => {
  const done = shippedIn("publishCohort")(items);
  return done.length ? done.filter(isIt).length / done.length : undefined;
};
const settled = (items) => landingsOf(items).filter((landing) => landing.publishCohort && (landing.status === "shipped" || landing.status === "backed out"));
const countOfStatus = (status) => (items) => landingsOf(items).filter((landing) => landing.status === status).length;
const stagePair = (key, color) => [
  {key: "p50", title: "p50", value: percentile("publishCohort", key, 0.5), color: color[0]},
  {key: "p95", title: "p95", value: percentile("publishCohort", key, 0.95), color: color[1]}
];
const BLUES = ["#86b4ea", "#2f74d0", "#163f7a"];

// Every tile counts its items by day: a landing by the day it was requested, a merge by
// the day it happened, a closure by the day it began.
const METRICS = [
  {
    key: "endtoend",
    title: "Land to published in a Nightly",
    span: 3,
    countless: true,
    format: formatWait,
    series: [
      {key: "p50", title: "p50", value: percentile("publishCohort", "total", 0.5), color: BLUES[0]},
      {key: "p90", title: "p90", value: percentile("publishCohort", "total", 0.9), color: BLUES[1]},
      {key: "p99", title: "p99", value: percentile("publishCohort", "total", 0.99), color: BLUES[2]}
    ]
  },
  {
    key: "tohalf",
    title: "Land to half of the Nightly clients on the fix",
    span: 2,
    countless: true,
    format: formatWait,
    series: [
      {key: "p50", title: "p50", value: percentile("uptakeCohort", "toHalf", 0.5), color: "#b49be6"},
      {key: "p95", title: "p95", value: percentile("uptakeCohort", "toHalf", 0.95), color: "#6b3fbf"}
    ]
  },
  {
    key: "share24",
    title: "Nightly clients on the fix 24 h after it is published",
    countless: true,
    format: formatPercent,
    series: [
      {
        key: "share24",
        title: "median",
        value: (items) => quantile(shippedIn("uptakeCohort")(items).map((landing) => landing.journey.uptake?.share24), 0.5),
        color: "#6b3fbf"
      }
    ]
  },
  {
    key: "over24",
    title: "Landings that took over 24 h to publish",
    countless: true,
    format: formatPercent,
    series: [{key: "over24", title: "share", value: shareOf((landing) => landing.durations.total > 24 * 3600), color: "#c2476f"}]
  },
  {key: "landed", title: "Revisions landed", countless: true, format: formatCount, series: [{key: "landed", title: "revisions", value: (items) => landingsOf(items).length, color: "#8a4fb5"}]},
  {key: "queue", title: "Waiting in the Lando queue", span: 2, countless: true, format: formatWait, series: stagePair("queue", ["#9bd0b0", "#237a4b"])},
  {key: "autoland", title: "On autoland until merged to main", span: 2, countless: true, format: formatWait, series: stagePair("autoland", ["#f1c27d", "#d98324"])},
  {key: "waiting", title: "Merged to main until its Nightly starts", span: 2, countless: true, format: formatWait, series: stagePair("waiting", ["#f0a8bd", "#c2476f"])},
  {key: "build", title: "Nightly build and publish", span: 2, countless: true, format: formatWait, series: stagePair("build", ["#9fb6e8", "#5b6abf"])},
  {key: "merges", title: "Merges to main", countless: true, format: formatCount, series: [{key: "merges", title: "merges", value: (items) => items.filter((item) => item.kind === "merge").length, color: "#5b6abf"}]},
  {
    key: "closed",
    title: "Autoland tree closed",
    countless: true,
    format: formatWait,
    series: [{key: "closed", title: "closed", value: (items) => d3.sum(items.filter((item) => item.kind === "closure"), (item) => item.hours), color: "#b3202a"}]
  },
  {
    key: "backedout",
    title: "Landings backed out",
    countless: true,
    format: formatPercent,
    series: [{key: "backedout", title: "share", value: (items) => (settled(items).length ? settled(items).filter((landing) => landing.status === "backed out").length / settled(items).length : undefined), color: "#b3202a"}]
  },
  {
    key: "afternightly",
    title: "Backed out after a Nightly had published them",
    countless: true,
    format: formatCount,
    series: [{key: "afternightly", title: "landings", value: (items) => landingsOf(items).filter(({journey}) => journey.backedOut && journey.published !== null && journey.published < journey.backout).length, color: "#7a1f26"}]
  },
  {key: "inflight", title: "In flight", countless: true, format: formatCount, series: [{key: "inflight", title: "landings", value: countOfStatus("in flight"), color: "#d99a00"}]},
  {
    key: "oldest",
    title: "Oldest in flight",
    countless: true,
    format: formatWait,
    series: [
      {
        key: "oldest",
        title: "age",
        value: (items) => {
          const ages = landingsOf(items).filter((landing) => landing.status === "in flight").map((landing) => (marks.landoUntil - landing.journey.requested) / 3600);
          return ages.length ? d3.max(ages) : undefined;
        },
        color: "#d99a00"
      }
    ]
  },
  {key: "unmatched", title: "Unmatched after 7 days", countless: true, format: formatCount, series: [{key: "unmatched", title: "landings", value: countOfStatus("unmatched"), color: "#888"}]}
];

const CUTOFF_KEY = "cohort";
const publishCutoff = secondsToDate(publishUntil - PUBLISH_HORIZON_S);
const METRICS_TITLE = {chartKey: "chart-metrics", title: "Top line metrics"};
```

```js
const tooltip = createTooltip({invalidation});
const blockCache = new Map();

function itemsIn(domain, requester) {
  return [
    ...landings.filter((landing) => inDomain(domain, landing.time) && (!requester || landing.journey.requester === requester)),
    ...merges.filter((merge) => inDomain(domain, merge.time)),
    ...closures.filter((closure) => inDomain(domain, closure.time))
  ];
}

function metricsBlock(items, width, domain) {
  const cohort = landingsOf(items).filter((landing) => landing.publishCohort).length;
  const neverHalf = landingsOf(items).filter((landing) => landing.uptakeCohort && landing.status === "shipped" && landing.journey.uptake?.t50 === null).length;
  return htl.html`${metricsRow({
    items,
    metrics: METRICS,
    domain,
    width,
    tooltip,
    noun: "item",
    eventRules: (days) => [eventRule(days, new Set(), {key: CUTOFF_KEY, date: publishCutoff})]
  })}<p class="bw-note">Times to publish count the ${formatCount(cohort)} of ${formatCount(landingsOf(items).length)} landings that had 48 h to finish, which is every one requested before ${formatTime(publishCutoff)}. Times to uptake wait for 96 h. The dashed line marks the first: to its right, a day is not complete.</p>`;
}

function section(width, hidden, requester, domain) {
  const items = itemsIn(domain, requester);
  const block = (item) =>
    collapsibleBlock(item, {
      hidden,
      state: {setHidden, setHiddenKeys},
      width,
      context: [width, +domain[0], +domain[1], requester],
      cache: blockCache,
      body: () => ({groups: null, content: metricsBlock(items, width, domain)})
    });
  const element = htl.html`<section class="sn-section">${[METRICS_TITLE].map(block)}</section>`;
  syncCharts(element, domain, (from, to) => setRange(d3.utcDay.floor(from), d3.utcDay.floor(new Date(Math.max(+from, +to - 1)))), tooltip);
  return element;
}
```

<style>
.bw-note {
  margin: 1rem 0 0;
  color: var(--theme-foreground-muted, #888);
}
.bw-filters > div {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0 2rem;
  margin: 0.25rem 0;
}
.bw-clear {
  margin-bottom: 0.4rem;
}
.sn-presets {
  display: inline-flex;
  gap: 0.4rem;
}
</style>

```js
// Limits the page to one requester. It lists everyone, most landings first.
const requesterCounts = d3.rollups(landings, (group) => group.length, (landing) => landing.journey.requester).sort((a, b) => b[1] - a[1]);
const urlRequester = new URLSearchParams(window.location.search).get("requester");
const requesterInput = Inputs.select(new Map([["Everyone", ""], ...requesterCounts.map(([name, n]) => [`${name} (${n})`, name])]), {
  label: "Requested by",
  value: requesterCounts.some(([name]) => name === urlRequester) ? urlRequester : ""
});
const requester = Generators.input(requesterInput);
```

```js
// The days the charts show, from the date inputs, the presets or by dragging across a
// chart, and kept in the address as ?from= and ?to=. Both are days, so the last one
// is shown whole. The default is the last 7 days of data.
const dayParam = (name) => {
  const text = new URLSearchParams(window.location.search).get(name);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text ?? "") ? new Date(`${text}T00:00:00Z`) : null;
  return day >= DATA_FIRST_DAY && day <= DATA_LAST_DAY ? day : null;
};
const dateInput = (label, value) => Inputs.date({label, value, min: DATA_FIRST_DAY, max: DATA_LAST_DAY});
const fromInput = dateInput("From", dayParam("from") ?? DEFAULT_FROM);
const toInput = dateInput("To", dayParam("to") ?? DATA_LAST_DAY);
const rangeFrom = Generators.input(fromInput);
const rangeTo = Generators.input(toInput);

const setRange = (from, to) => {
  for (const [input, day] of [[fromInput, from], [toInput, to]]) {
    input.value = day;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }
};
const presetButton = (days) => {
  const button = htl.html`<button type="button" class="bw-clear" title="The last ${days} day${days === 1 ? "" : "s"} of data">${days}d</button>`;
  button.onclick = () => setRange(new Date(Math.max(+DATA_FIRST_DAY, +DATA_LAST_DAY - (days - 1) * DAY_MS)), DATA_LAST_DAY);
  return button;
};
const presets = htl.html`<span class="sn-presets">${[1, 3, 7, 30, 90].map(presetButton)}</span>`;
const resetButton = htl.html`<button type="button" class="bw-clear" title="Show the last 7 days again">Reset</button>`;
resetButton.onclick = () => setRange(DEFAULT_FROM, DATA_LAST_DAY);
```

```js
// [start, end) of the days chosen. Dates in the wrong order are put right.
const domain = (() => {
  const [first, last] = [rangeFrom ?? DEFAULT_FROM, rangeTo ?? DATA_LAST_DAY].sort((a, b) => a - b);
  return [first, dayAfter(last)];
})();
```

```js
resetButton.disabled = +domain[0] === +DEFAULT_FROM && +domain[1] === +dayAfter(DATA_LAST_DAY);
```

<div class="bw-filters"><div>${requesterInput}</div><div>${fromInput}${toInput}${presets}${resetButton}</div></div>

```js
display(htl.html`<p class="bw-note">Data complete until ${marks.landoUntil ? formatTime(secondsToDate(marks.landoUntil)) : "?"} (Lando) · ${formatTime(secondsToDate(marks.treeherderUntil))} (Treeherder pushes) · ${formatTime(secondsToDate(marks.fxciUntil))} (Nightly build tasks) · ${marks.uptakeUntil ? formatTime(secondsToDate(marks.uptakeUntil)) : "?"} (uptake). The newest landings are still on their way.</p>`);
```

```js
{
  // Every parameter is always there, with its default when nobody chose, so that the
  // address says what the page shows.
  const params = new URLSearchParams(window.location.search);
  const isoDay = (day) => day.toISOString().slice(0, 10);
  params.set("requester", requester);
  params.set("from", isoDay(domain[0]));
  params.set("to", isoDay(new Date(+domain[1] - DAY_MS)));
  history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
}
```

```js
// The keys of the collapsed charts. Every title writes them to this element, and the
// charts redraw when it changes.
const hiddenKeys = hiddenKeysState("sn-charts");
const hidden = Generators.input(hiddenKeys.input);
const {setHiddenKeys, setHidden} = hiddenKeys;
```

<div class="card" id="sn-charts">
  ${resize((width) => section(width, hidden, requester, domain))}
</div>
