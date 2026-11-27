---
title: Ship to Nightly faster
toc: false
---

# Ship to Nightly faster

How long a patch takes from "Land" in Phabricator to a Nightly that people run.

```js
import {candleOf, CANDLE_SEGMENTS, durationsOf, inCohort, journeyOf, matchesQuery, mergesOf, parseRevision, PUBLISH_HORIZON_S, quantile, STAGE_INFO, statusOf, UNMATCHED_AFTER_S, watermarksOf} from "./_journey.js";
import {journeyProfile} from "./_journey-profile.js";
import {openProfile} from "./_profiler.js";
import {createTooltip, timelineLink} from "./_tooltip.js";
import {chartBox, dateAxis, DAY_MS, eventRule, formatTime, MARGINS, syncCharts} from "./_time-charts.js";
import {collapsibleBlock, hiddenKeysState, LEGEND_MARKERS} from "./_legend.js";
import {countOf, metricsRow} from "./_metrics.js";
import {candleChart, segmentLines} from "./_candles.js";
```

```js
const journeyRows = (await FileAttachment("data/nightly-journeys.parquet").parquet()).toArray();
const closureRows = (await FileAttachment("data/nightly-treestatus.parquet").parquet()).toArray();
```

```js
// The sources lag the present by different amounts, so each has its own watermark.
// A tile only counts the landings that had time to finish by the oldest of them.
const marks = watermarksOf(journeyRows);
const publishUntil = Math.min(marks.landoUntil, marks.commitMapsUntil);
const journeys = journeyRows.map((row) => journeyOf(row));
const secondsToDate = (seconds) => new Date(seconds * 1000);

// The charts keep the newest when there are too many to draw, so the order is by request.
const landings = journeys
  .map((journey) => {
    const durations = durationsOf(journey);
    return {
      kind: "landing",
      time: secondsToDate(journey.requested),
      journey,
      durations,
      candle: candleOf(journey, marks),
      status: statusOf(journey, marks),
      publishCohort: inCohort(journey, publishUntil, PUBLISH_HORIZON_S)
    };
  })
  .sort((a, b) => a.time - b.time);
const merges = mergesOf(journeys).map((merge) => ({kind: "merge", time: secondsToDate(merge.merged)}));
const closures = closureRows
  .filter((row) => row.status === "closed" && row.end_s !== null)
  .map((row) => ({kind: "closure", time: secondsToDate(row.start_s), hours: (row.end_s - row.start_s) / 3600}));

const DATA_FIRST_DAY = d3.utcDay.floor(secondsToDate(d3.min(journeys, (journey) => journey.requested)));
const DATA_LAST_DAY = d3.utcDay.floor(secondsToDate(marks.landoUntil));
const dayAfter = (day) => new Date(+day + DAY_MS);
const inDomain = (domain, time) => time >= domain[0] && time < domain[1];

// ?revision=D343744 picks a landing. The days around it are shown, unless the address
// says which days to show.
const urlRevision = parseRevision(new URLSearchParams(window.location.search).get("revision"));
const selectedLandings = landings.filter((landing) => landing.journey.revision === urlRevision);
const focusDay = selectedLandings.length ? d3.utcDay.floor(selectedLandings[0].time) : null;
const clampDay = (day) => new Date(Math.min(+DATA_LAST_DAY, Math.max(+DATA_FIRST_DAY, +day)));
const DEFAULT_FROM = focusDay ? clampDay(new Date(+focusDay - 3 * DAY_MS)) : new Date(Math.max(+DATA_FIRST_DAY, +DATA_LAST_DAY - 6 * DAY_MS));
const DEFAULT_TO = focusDay ? clampDay(new Date(+focusDay + 3 * DAY_MS)) : DATA_LAST_DAY;
```

```js
const formatCount = (n) => Math.round(n).toLocaleString("en-US");
const formatPercent = (share) => `${Math.round(share * 1000) / 10}%`;
const formatRatio = (n) => (Math.round(n * 10) / 10).toLocaleString("en-US");
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
const settled = (items) => landingsOf(items).filter((landing) => landing.publishCohort && (landing.status === "shipped" || landing.status === "backed out"));
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
    title: "Revisions backed out",
    countless: true,
    format: formatPercent,
    series: [{key: "backedout", title: "share", value: (items) => (settled(items).length ? settled(items).filter((landing) => landing.status === "backed out").length / settled(items).length : undefined), color: "#b3202a"}]
  },
  {
    key: "afternightly",
    title: "Backed out after a Nightly had published them",
    countless: true,
    format: formatCount,
    series: [{key: "afternightly", title: "revisions", value: (items) => landingsOf(items).filter(({journey}) => journey.backedOut && journey.published !== null && journey.published < journey.backout).length, color: "#7a1f26"}]
  },
  {
    key: "permerge",
    title: "Revisions per merge to main",
    countless: true,
    format: formatRatio,
    series: [
      {
        key: "permerge",
        title: "revisions",
        value: (items) => {
          const merged = items.filter((item) => item.kind === "merge").length;
          return merged ? landingsOf(items).length / merged : undefined;
        },
        color: "#d99a00"
      }
    ]
  }
];

const CUTOFF_KEY = "cohort";
const publishCutoff = secondsToDate(publishUntil - PUBLISH_HORIZON_S);
const METRICS_TITLE = {chartKey: "chart-metrics", title: "Top line metrics"};
const E2E_TITLE = {chartKey: "chart-endtoend", title: "From Land to a Nightly that people run"};
const CANDLES_HEIGHT = 300;
const MAX_CANDLES = 2000;
const HIT_RADIUS = 8;
```

```js
// The tooltip is defined in the same cell as what uses it to filter by requester, as a
// cell may not depend on one that depends on it.
const tooltip = createTooltip({invalidation});
const TC_URL = "https://firefox-ci-tc.services.mozilla.com";
const TREEHERDER_URL = "https://treeherder.mozilla.org";
const external = (href, text) => htl.html`<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

const BACKOUT_COLOR = "#b3202a";
const STAGE_LINES = STAGE_INFO.map((stage) => ({...stage, applies: (landing) => landing.durations[stage.key] !== null}));
const hoursText = (seconds) => formatWait(seconds / 3600);

// The profile is built when the link is clicked, and the profiler is opened inside the
// click, which is the only time a browser lets a page open a window.
const journeyLink = ({journey}) =>
  timelineLink("→ Journey in the Firefox Profiler", () => openProfile(() => journeyProfile(journey, {marks, closures: closureRows})), `D${journey.revision}-journey.json`);

function landingLinks(landing) {
  const {journey} = landing;
  return htl.html`${journeyLink(landing)}
    ${external(`https://phabricator.services.mozilla.com/D${journey.revision}`, "→ Phabricator")}
    ${external(`https://lando.moz.tools/D${journey.revision}/`, "→ Lando")}
    ${journey.bug ? external(`https://bugzilla.mozilla.org/show_bug.cgi?id=${journey.bug}`, `→ Bug ${journey.bug}`) : ""}
    ${journey.autolandRev ? external(`${TREEHERDER_URL}/jobs?repo=autoland&revision=${journey.autolandRev}`, "→ Treeherder, its push on autoland") : ""}
    ${journey.centralRev ? external(`${TREEHERDER_URL}/jobs?repo=mozilla-central&revision=${journey.centralRev}`, "→ Treeherder, the merge to main") : ""}
    ${journey.centralRev ? external(`https://hg.mozilla.org/mozilla-central/rev/${journey.centralRev}`, "→ hg, the merge to main") : ""}
    ${journey.decisionId ? external(`${TC_URL}/tasks/${journey.decisionId}`, "→ TC Task of its Nightly") : ""}
    <a href="?revision=D${journey.revision}">→ Link to this landing</a>`;
}

function requesterLink(name) {
  const link = htl.html`<a href="#" title="Show only the landings of ${name}">${name}</a>`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    document.dispatchEvent(new CustomEvent("sn-requester", {detail: name}));
    tooltip.hide();
  });
  return link;
}

function backoutLine({journey}) {
  const reached = journey.published !== null && journey.published < journey.backout;
  return htl.html`<span class="bw-tt-blocked"><b>Backed out</b> ${formatTime(secondsToDate(journey.backout))}, ${hoursText(journey.backout - journey.pushed)} after it was on autoland, by ${journey.backoutBy}${reached ? ", after a Nightly had published it" : ""}</span>`;
}

function outcomeLine({durations, status}) {
  if (status === "shipped") return htl.html`<span><b>${hoursText(durations.total)}</b> from Land to published</span>`;
  if (status === "unmatched") return htl.html`<span>No Nightly has taken it, more than ${UNMATCHED_AFTER_S / 86400} days later</span>`;
  return htl.html`<span>Still on its way</span>`;
}

function landingLines(landing, linkRequester = true) {
  const {journey, durations, status} = landing;
  return htl.html`<span><b>D${journey.revision}</b>${journey.bug ? ` · bug ${journey.bug}` : ""}</span>
    <span>land requested ${formatTime(landing.time)}</span>
    <div class="bw-tt-links">by ${linkRequester ? requesterLink(journey.requester) : journey.requester}${journey.stack.size > 1 ? `, revision ${journey.stack.index + 1} of a stack of ${journey.stack.size}` : ""}</div>
    ${status === "backed out" ? backoutLine(landing) : outcomeLine(landing)}
    <div class="bw-tt-sep"></div>
    ${segmentLines(STAGE_LINES, {durations, subject: landing, format: formatWait})}
    ${journey.queueClosed ? htl.html`<span class="bw-tt-pool">autoland was closed for ${hoursText(journey.queueClosed)} of the Lando queue</span>` : ""}
    ${journey.autolandClosed ? htl.html`<span class="bw-tt-pool">and for ${hoursText(journey.autolandClosed)} of the time on autoland</span>` : ""}
    ${journey.failedAttempts ? htl.html`<span class="bw-tt-pool">${countOf(journey.failedAttempts, "attempt")} to land it failed before</span>` : ""}
    <div class="bw-tt-sep"></div>
    <div class="bw-tt-links">${landingLinks(landing)}</div>`;
}
```

```js
const blockCache = new Map();

function itemsIn(domain, requester) {
  return [
    ...landings.filter((landing) => inDomain(domain, landing.time) && (!requester || landing.journey.requester === requester)),
    ...merges.filter((merge) => inDomain(domain, merge.time)),
    ...closures.filter((closure) => inDomain(domain, closure.time))
  ];
}

function metricsBlock(items, width, domain) {
  return metricsRow({
    items,
    metrics: METRICS,
    domain,
    width,
    tooltip,
    noun: "item",
    eventRules: (days) => [eventRule(days, new Set(), {key: CUTOFF_KEY, date: publishCutoff})]
  });
}

// How a candle ends is part of what it says: a Nightly published it, it was backed out,
// or it is still on its way and is drawn up to the last thing recorded.
const END_KINDS = [
  {key: "end-shipped", kind: "shipped", title: "was published in a Nightly", marker: () => LEGEND_MARKERS.dot("currentColor")},
  {key: "end-backed-out", kind: "backed out", title: "was backed out", marker: () => LEGEND_MARKERS.cross(BACKOUT_COLOR)},
  {key: "end-open", kind: "open", title: "still on its way, drawn up to what is recorded", marker: () => LEGEND_MARKERS.ring("currentColor")}
];
const endKeyOf = (kind) => END_KINDS.find((end) => end.kind === kind).key;
const swatch = ({key, title, color}) => ({key, title, marker: () => LEGEND_MARKERS.swatch(color, 0.8)});
const candleGroups = () => [
  {title: "Stage", entries: CANDLE_SEGMENTS.map(swatch)},
  {title: "A candle ends when it", entries: END_KINDS.map(({key, title, marker}) => ({key, title, marker}))}
];

function showCandle(event, point, chartRect) {
  if (!tooltip.open(event, point.item, landingLines(point.item))) return;
  tooltip.showRing(chartRect, point, 12);
}

// A bar for each landing at the moment it was requested, stacked from what happened
// first to what happened last, with a mark at its top that says how it ended. The
// height scale comes from all the landings of the days shown, so that hiding some does
// not rescale it. A bar is a line for each stage, so only the most recent are drawn.
function candlesChart({shown, width, hidden, domain}) {
  const wanted = shown.filter((landing) => !hidden.has(endKeyOf(landing.candle.kind)));
  const items = wanted.slice(-MAX_CANDLES);
  const maxHours = Math.max(1, d3.max(shown, (landing) => landing.candle.total) / 3600);
  const barWidth = Math.min(5, Math.max(1, (width - MARGINS.left - MARGINS.right) / Math.max(1, items.length)));
  const chosen = new Set(selectedLandings);
  const plot = candleChart({
    items,
    segments: CANDLE_SEGMENTS,
    hidden,
    domain,
    width,
    height: CANDLES_HEIGHT,
    maxHours,
    durationsOf: (landing) => landing.candle.segments,
    barWidth,
    hitRadius: HIT_RADIUS,
    tooltip,
    show: showCandle,
    before: [eventRule(domain, new Set(), {key: CUTOFF_KEY, date: publishCutoff})],
    after: ({topHours, ends}) => {
      const ended = (kind) => ends.filter((landing) => landing.candle.kind === kind);
      return [
        Plot.dot(ended("shipped"), {x: "time", y: topHours, r: 3, fill: "currentColor"}),
        Plot.dot(ended("backed out"), {x: "time", y: topHours, r: 5, symbol: "cross", stroke: BACKOUT_COLOR, strokeWidth: 2}),
        Plot.dot(ended("open"), {x: "time", y: topHours, r: 3, fill: "white", stroke: "currentColor"}),
        Plot.dot(ends.filter((landing) => chosen.has(landing)), {x: "time", y: topHours, r: 9, stroke: BACKOUT_COLOR, strokeWidth: 2, fill: "none"})
      ];
    }
  });
  const cut = wanted.length - items.length;
  return htl.html`${chartBox(plot, CANDLES_HEIGHT)}${cut ? htl.html`<p class="bw-note">Only the ${formatCount(MAX_CANDLES)} most recent are drawn, of ${formatCount(wanted.length)}.</p>` : ""}`;
}

function section(width, hidden, requester, domain) {
  const items = itemsIn(domain, requester);
  const shown = landingsOf(items);
  const none = () => htl.html`<p class="bw-note">No revisions in this range.</p>`;
  const bodies = {
    "chart-endtoend": {
      groups: () => (shown.length ? candleGroups() : null),
      draw: (ownHidden) => (shown.length ? candlesChart({shown, width, hidden: ownHidden, domain}) : none())
    },
    "chart-metrics": {groups: () => null, draw: () => metricsBlock(items, width, domain)}
  };
  const block = (item) =>
    collapsibleBlock(item, {
      hidden,
      state: {setHidden, setHiddenKeys},
      width,
      context: [width, +domain[0], +domain[1], requester],
      cache: blockCache,
      body: ({chartKey}, ownHidden) => ({groups: bodies[chartKey].groups(), content: bodies[chartKey].draw(ownHidden)})
    });
  const element = htl.html`<section class="sn-section">${[METRICS_TITLE, E2E_TITLE].map(block)}</section>`;
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
.sn-banner {
  margin: 0.75rem 0;
  padding: 0.6rem 0.9rem;
  border: 1px solid var(--theme-foreground-faintest, #ddd);
  border-radius: 6px;
}
.sn-banner span,
.sn-banner div {
  display: block;
}
.sn-banner .bw-tt-links a {
  display: inline;
  margin-right: 0.6em;
}
.sn-banner .bw-tt-sep {
  margin: 4px 0;
  border-top: 1px solid var(--theme-foreground-faintest, #ddd);
}
.sn-banner .bw-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  border-radius: 2px;
}
.sn-banner .bw-tt-blocked {
  color: #b3202a;
}
.sn-banner .bw-tt-pool {
  color: var(--theme-foreground-muted, #888);
}
</style>

```js
// Limits the page to one requester, chosen here or by clicking a name in a tooltip. It
// lists everyone, most landings first.
const requesterCounts = d3.rollups(landings, (group) => group.length, (landing) => landing.journey.requester).sort((a, b) => b[1] - a[1]);
const urlRequester = new URLSearchParams(window.location.search).get("requester");
const requesterInput = Inputs.select(new Map([["Everyone", ""], ...requesterCounts.map(([name, n]) => [`${name} (${n})`, name])]), {
  label: "Requested by",
  value: requesterCounts.some(([name]) => name === urlRequester) ? urlRequester : ""
});
const requester = Generators.input(requesterInput);
const chooseRequester = ({detail}) => {
  requesterInput.value = detail;
  requesterInput.dispatchEvent(new Event("input", {bubbles: true}));
};
document.addEventListener("sn-requester", chooseRequester);
invalidation.then(() => document.removeEventListener("sn-requester", chooseRequester));
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
const toInput = dateInput("To", dayParam("to") ?? DEFAULT_TO);
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
const resetButton = htl.html`<button type="button" class="bw-clear" title="Show the days of the start again">Reset</button>`;
resetButton.onclick = () => setRange(DEFAULT_FROM, DEFAULT_TO);
```

```js
// [start, end) of the days chosen. Dates in the wrong order are put right.
const domain = (() => {
  const [first, last] = [rangeFrom ?? DEFAULT_FROM, rangeTo ?? DEFAULT_TO].sort((a, b) => a - b);
  return [first, dayAfter(last)];
})();
```

```js
resetButton.disabled = +domain[0] === +DEFAULT_FROM && +domain[1] === +dayAfter(DEFAULT_TO);
```

<div class="bw-filters"><div>${requesterInput}</div><div>${fromInput}${toInput}${presets}${resetButton}</div></div>

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
// The landing that ?revision= picks, with what a tooltip says about it.
{
  if (selectedLandings.length) {
    display(htl.html`<div class="sn-banner">${selectedLandings.map((landing, index) => htl.html`${index ? htl.html`<div class="bw-tt-sep"></div>` : ""}${landingLines(landing, false)}`)}</div>`);
  } else if (urlRevision !== null) {
    display(htl.html`<div class="sn-banner">D${urlRevision} is not among the revisions landed since ${DATA_FIRST_DAY.toISOString().slice(0, 10)}.</div>`);
  }
}
```

```js
// The keys of the collapsed charts and of the hidden dots. Every title and legend
// button writes them to this element, and the charts redraw when it changes.
const hiddenKeys = hiddenKeysState("sn-charts");
const hidden = Generators.input(hiddenKeys.input);
const {setHiddenKeys, setHidden} = hiddenKeys;
```

<div class="card" id="sn-charts">
  ${resize((width) => section(width, hidden, requester, domain))}
</div>

## Revisions

```js
// The revisions of the days and requester shown, in a table that can be searched by D
// number, bug, requester or the start of a revision.
const tableRows = itemsIn(domain, requester)
  .filter((item) => item.kind === "landing")
  .map((landing) => ({
    landing,
    journey: landing.journey,
    revision: landing.journey.revision,
    bug: landing.journey.bug,
    requester: landing.journey.requester,
    status: landing.status,
    requested: landing.time,
    total: landing.durations.total,
    queue: landing.durations.queue,
    autoland: landing.durations.autoland,
    waiting: landing.durations.waiting,
    build: landing.durations.build
  }));
const searchInput = Inputs.search(tableRows, {placeholder: "Search a D number, a bug, a requester or an hg revision", width: 460, filter: (query) => (row) => matchesQuery(row.journey, query)});
const searched = Generators.input(searchInput);
```

```js
searchInput
```

```js
const duration = (seconds) => (seconds === null ? "–" : hoursText(seconds));
display(Inputs.table(searched, {
  columns: ["revision", "bug", "requester", "status", "requested", "total", "queue", "autoland", "waiting", "build"],
  header: {revision: "Revision", bug: "Bug", requester: "Requester", status: "Outcome", requested: "Land requested", total: "Land to published", queue: "Lando queue", autoland: "On autoland", waiting: "Waiting for Nightly", build: "Nightly build"},
  width: {revision: 80, bug: 80, requester: 100, status: 90, requested: 130, total: 130, queue: 100, autoland: 110, waiting: 130, build: 110},
  format: {
    revision: (revision) => htl.html`<a href="?revision=D${revision}">D${revision}</a>`,
    bug: (bug) => (bug ? external(`https://bugzilla.mozilla.org/show_bug.cgi?id=${bug}`, bug) : ""),
    requested: formatTime,
    total: duration,
    queue: duration,
    autoland: duration,
    waiting: duration,
    build: duration
  },
  sort: "requested",
  reverse: true,
  rows: 12,
  maxWidth: 1100
}));
```
