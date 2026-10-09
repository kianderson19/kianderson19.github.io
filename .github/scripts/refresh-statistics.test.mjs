import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import {
  HERO_IDS, MAP_IDS, TIERS, FAQ, EXPECTED_SCOPES, requestPlan, makeRequest, COMPETITIVE_RQ, validateQueueContract, fetchOfficial,
  sourceRequest, sourcePercent, decodeResponse, validateSnapshot, collectResponses,
  mergeResponses, atomicWriteSnapshot, HttpFailure, TransportTimeout,
} from "./refresh-statistics.mjs";

const OLD = "2026-10-08T06:00:00.000Z", NEW = "2026-10-08T12:00:00.000Z";
const plan = requestPlan(), key = request => `${["1", "2"].includes(request.rq) ? "competitive" : "quickplay"}/${request.map}/${request.tier}`;
const route = makeRequest("route-66", "Gold", "1");
function payload(request, rates = new Map()) {
  return { rates: { selected: { ...request.selected }, rates: HERO_IDS.map(id => ({
    id, cells: { name: id, winrate: rates.get(id)?.[0] ?? 50, pickrate: 3, banrate: 0 },
  })) } };
}
function fixture() {
  // Two real observations plus explicit transport gaps for the remaining plan.
  // This is a synthetic schema fixture, not current Blizzard observations.
  const observed = [makeRequest("all-maps", "All", "1"), route];
  const scopes = observed.map(request => ({
    mapId: request.map === "all-maps" ? null : request.map, tier: request.tier.toLowerCase(),
    tierLabel: TIERS[request.tier], tierGrouping: [], queue: "competitive", queueMode: "role-queue",
    region: "asia", platform: "pc", sourceKind: "blizzard", sampleSize: null, dataDate: null,
    collectedAt: OLD, sourceUrl: request.sourceUrl, evidenceUrl: request.sourceUrl.replace("/rates/data/", "/rates/"),
    mode: request.map === "all-maps" ? null : "호위", patch: null, season: null,
    winRateMetric: "publisher-winrate", mirrorHandling: "not-disclosed", pickRateUnit: "hero-playtime-usage", definitionSourceUrl: FAQ,
  }));
  return { version: 1, generatedAt: OLD, heroes: [...HERO_IDS], scopes,
    values: observed.flatMap((_, scope) => HERO_IDS.map((_, hero) => [hero, scope, 50, 3, 0])),
    coverage: { expectedScopes: EXPECTED_SCOPES, observedScopes: scopes.length, unavailable: plan.filter(request => !observed.some(row => key(row) === key(request))).map(request => ({
      sourceUrl: request.sourceUrl, mapId: request.map === "all-maps" ? null : request.map,
      tier: request.tier.toLowerCase(), queue: request.rq === "1" ? "competitive" : "quickplay",
      reason: "Synthetic transport timeout; not measured zero wins", observedAt: OLD,
    })) } };
}
function timeoutResults() {
  return plan.map(request => ({ kind: "timeout", request, observedAt: NEW, reason: "Transport timeout; not an empty or zero-win dataset" }));
}
function legacyFixture() {
  const base = fixture();
  for (const scope of base.scopes) {
    scope.sourceUrl = scope.sourceUrl.replace("rq=1", "rq=2");
    scope.evidenceUrl = scope.evidenceUrl.replace("rq=1", "rq=2");
  }
  base.coverage.unavailable.forEach(gap => { gap.sourceUrl = gap.sourceUrl.replace("rq=1", "rq=2"); });
  return base;
}
function replaceResult(results, request, value) { results[plan.findIndex(row => key(row) === key(request))] = value; }
function observed(request, source = payload(request)) { return decodeResponse(source, request, NEW); }
function clock() {
  let milliseconds = Date.parse(NEW);
  return { now: () => milliseconds, wait: async delay => { milliseconds += delay; } };
}

test("plan covers 31 maps by every published tier plus globals using competitive rq=1 and Quick Play rq=0", () => {
  assert.equal(COMPETITIVE_RQ, "1");
  assert.equal(HERO_IDS.length, 54); assert.equal(MAP_IDS.length, 31); assert.equal(plan.length, 289);
  assert.equal(new Set(plan.map(key)).size, 289);
  assert.equal(plan.filter(request => request.rq === "1").length, 288);
  assert.deepEqual(plan.filter(request => request.rq !== "1").map(request => request.selected), [{ input: "PC", map: "all-maps", region: "Asia", role: "All", rq: "0", tier: "All" }]);
  for (const map of MAP_IDS) assert.equal(plan.filter(request => request.map === map).length, 9);
  assert.throws(() => makeRequest("route-66", "Champion", "1"), /Unreviewed tier/);
  assert.throws(() => makeRequest("route-66", "All", "3"), /Unreviewed queue/);
});

test("official dropdown confirms queue semantics before collection and refuses a changed enum", () => {
  const html = `<select data-label='rq' id='filter-rq-select'><option value='0' data-title='빠른 대전 - 역할 고정'>빠른 대전 - 역할 고정</option><option value='1' data-title='경쟁전 - 역할 고정'>경쟁전 - 역할 고정</option></select>`;
  assert.deepEqual(validateQueueContract(html), { competitive: "1", quickplay: "0" });
  assert.throws(() => validateQueueContract(html.replace("value='1'", "value='2'")), /Official queue contract changed: competitive=2/);
  assert.throws(() => validateQueueContract(html.replace("value='0'", "value='1'")), /Official queue contract changed/);
  assert.throws(() => validateQueueContract(html.replace("filter-rq-select", "other-select")), /dropdown is missing/);
  assert.throws(() => validateQueueContract(html.replace("</select>", "<option value='1' data-title='경쟁전 - 역할 고정'>duplicate</option></select>")), /Ambiguous/);
});

test("historical rq=2 cached scopes remain valid but may not make live requests", async () => {
  const legacy = legacyFixture();
  assert.deepEqual(validateSnapshot(legacy), validateSnapshot(fixture()));
  assert.equal(sourceRequest(legacy.scopes[0].sourceUrl).rq, "2");
  await assert.rejects(fetchOfficial(makeRequest("all-maps", "All", "2")), /Historical rq=2 is read-only/);
  const duplicate = structuredClone(legacy);
  duplicate.scopes.push({ ...duplicate.scopes[0], sourceUrl: duplicate.scopes[0].sourceUrl.replace("rq=2", "rq=1"), evidenceUrl: duplicate.scopes[0].evidenceUrl.replace("rq=2", "rq=1") });
  assert.throws(() => validateSnapshot(duplicate), /Duplicate or unexpected stored scope/);
});

test("current rq=1 observations replace historical competitive scopes without relabeling retained rows", () => {
  const previous = legacyFixture(), original = JSON.stringify(previous), results = timeoutResults();
  replaceResult(results, route, observed(route));
  const merged = mergeResponses(previous, results, NEW);
  assert.equal(merged.updatedScopes, 1); assert.equal(merged.retainedScopes, 1);
  assert.equal(merged.snapshot.scopes.length, 2); assert.equal(merged.snapshot.coverage.unavailable.length, 287);
  const current = merged.snapshot.scopes.find(scope => scope.mapId === "route-66");
  assert.equal(current.sourceUrl, route.sourceUrl); assert.equal(current.queue, "competitive"); assert.equal(current.collectedAt, NEW);
  const retained = merged.snapshot.scopes.find(scope => scope.mapId === null);
  assert.deepEqual(retained, previous.scopes[0]); assert.match(retained.sourceUrl, /rq=2/);
  assert.equal(merged.snapshot.refresh.failedAttempts.find(row => row.preservedPrevious).collectedAt, OLD);
  assert.equal(JSON.stringify(previous), original);
});

test("source URL cannot change origin, queue, scope, filter names or duplicate parameters", () => {
  assert.equal(sourceRequest(route.sourceUrl).sourceUrl, route.sourceUrl);
  for (const url of [
    route.sourceUrl.replace("https:", "http:"), route.sourceUrl.replace("overwatch.blizzard.com", "example.test"),
    route.sourceUrl.replace("/rates/data/", "/rates/"), route.sourceUrl.replace("Asia", "Europe"),
    `${route.sourceUrl}&tier=All`, `${route.sourceUrl}&season=5`, `${route.sourceUrl}#extra`,
    route.sourceUrl.replace("Gold", "Champion"), route.sourceUrl.replace("rq=1", "rq=3"),
    route.sourceUrl.replace("https://", "https://name:password@"),
  ]) assert.throws(() => sourceRequest(url));
});

test("actual 0/100 survive while explicit missing markers become null, not old or invented values", () => {
  assert.equal(sourcePercent(0), 0); assert.equal(sourcePercent(100), 100);
  for (const missing of [null, -1, "--"]) assert.equal(sourcePercent(missing), null);
  for (const invalid of [-2, 100.01, NaN, Infinity, "0", undefined, {}, true]) assert.throws(() => sourcePercent(invalid));
  const raw = payload(route);
  raw.rates.rates[0].cells.winrate = 0;
  raw.rates.rates[1].cells.winrate = 100;
  raw.rates.rates[2].cells.winrate = -1;
  raw.rates.rates[3].cells.pickrate = null;
  const original = JSON.stringify(raw), result = observed(route, raw);
  assert.deepEqual(result.values.slice(0, 3).map(row => row.rates[0]), [0, 100, null]);
  assert.equal(result.values[3].rates[1], null);
  assert.equal(JSON.stringify(raw), original, "the source payload is never rewritten");
});

test("all six selected echo keys must match exactly", () => {
  for (const field of ["input", "map", "region", "role", "rq", "tier"]) {
    const raw = payload(route); raw.rates.selected[field] = "different";
    assert.throws(() => observed(route, raw), /Selected scope mismatch/);
  }
  for (const mutate of [s => { delete s.tier; }, s => { s.extra = "All"; }, s => { s.rq = 2; }]) {
    const raw = payload(route); mutate(raw.rates.selected); assert.throws(() => observed(route, raw));
  }
  const fallback = payload(route); fallback.rates.selected.rq = "0"; fallback.rates.selected.map = "all-maps";
  assert.throws(() => observed(route, fallback), /Selected scope mismatch.*requested route-66, received all-maps.*requested 1, received 0.*snapshot preserved/);
});

test("reordered heroes are accepted by ID; duplicates, omissions or a new roster stop publication", () => {
  const raw = payload(route); raw.rates.rates.reverse();
  assert.equal(observed(route, raw).values[0].heroId, HERO_IDS.at(-1));
  for (const mutate of [
    rows => rows.pop(), rows => rows.push(structuredClone(rows[0])),
    rows => { rows[1].id = rows[0].id; }, rows => { rows[0].id = "unreviewed-new-hero"; },
    rows => { delete rows[0].cells.winrate; }, rows => { rows[0].cells.banrate = 101; },
  ]) { const changed = payload(route); mutate(changed.rates.rates); assert.throws(() => observed(route, changed)); }
});

test("snapshot validation rejects invented metadata, missing hero rows and dishonest coverage", () => {
  const base = fixture(); assert.deepEqual(validateSnapshot(base), { heroes: 54, observedScopes: 2, expectedScopes: 289, values: 108, gaps: 287 });
  const mutations = [
    data => { data.scopes[0].winRateMetric = "unmirrored-winrate"; },
    data => { data.scopes[0].mirrorHandling = "included"; },
    data => { data.scopes[0].sampleSize = 1000; },
    data => { data.scopes[0].collectedAt = NEW; },
    data => { data.scopes[0].tier = "gold"; },
    data => { data.scopes[0].evidenceUrl = "https://example.test"; },
    data => { data.values[0][2] = -1; }, data => { data.values[1][0] = data.values[0][0]; },
    data => { data.values.pop(); }, data => { data.values[0][1] = 300; },
    data => { data.coverage.unavailable.pop(); },
    data => { data.coverage.observedScopes = 3; },
    data => { data.coverage.unavailable[1] = structuredClone(data.coverage.unavailable[0]); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(base); mutate(changed); assert.throws(() => validateSnapshot(changed)); }
});

test("a fresh missing value replaces the old number; only a transport timeout preserves old timestamps", () => {
  const base = fixture(), original = JSON.stringify(base), results = timeoutResults();
  const raw = payload(route); raw.rates.rates[0].cells.winrate = -1; raw.rates.rates[1].cells.winrate = 0; raw.rates.rates[2].cells.winrate = 100;
  replaceResult(results, route, observed(route, raw));
  const merged = mergeResponses(base, results, NEW), result = merged.snapshot;
  assert.equal(merged.updatedScopes, 1); assert.equal(merged.retainedScopes, 1);
  const current = result.scopes.findIndex(scope => scope.sourceUrl === route.sourceUrl);
  assert.equal(result.scopes[current].collectedAt, NEW);
  assert.deepEqual(result.values.filter(row => row[1] === current).slice(0, 3).map(row => row[2]), [null, 0, 100]);
  const prior = result.scopes.find(scope => scope.sourceUrl === base.scopes[0].sourceUrl);
  assert.deepEqual(prior, base.scopes[0], "retained metadata stays byte-for-byte equivalent");
  assert.equal(result.refresh.failedAttempts.find(row => row.preservedPrevious).collectedAt, OLD);
  assert.equal(result.coverage.unavailable.length, 287);
  assert.equal(JSON.stringify(base), original, "previous observations are not mutated");
});

test("new observations fill a gap without fabricating rows for remaining failures", () => {
  const base = fixture(), results = timeoutResults(), request = makeRequest("grimsvotn", "Grandmaster", "1");
  replaceResult(results, request, observed(request));
  const merged = mergeResponses(base, results, NEW);
  assert.equal(merged.updatedScopes, 1); assert.equal(merged.retainedScopes, 2);
  assert.equal(merged.snapshot.scopes.length, 3); assert.equal(merged.snapshot.values.length, 162);
  assert.equal(merged.snapshot.coverage.unavailable.length, 286);
  const group = merged.snapshot.scopes.find(scope => scope.mapId === "grimsvotn");
  assert.deepEqual(group.tierGrouping, ["grandmaster", "champion"]);
  assert.equal(group.sampleSize, null); assert.equal(group.dataDate, null);
});

test("no fresh response never makes the previous snapshot look newly collected", () => {
  const base = fixture(), merged = mergeResponses(base, timeoutResults(), NEW);
  assert.equal(merged.updatedScopes, 0); assert.strictEqual(merged.snapshot, base); assert.equal(merged.snapshot.generatedAt, OLD);
  const altered = timeoutResults(); altered[0].kind = "empty";
  assert.throws(() => mergeResponses(base, altered, NEW), /Only observed transport/);
});

test("HTTP 403 and 429 stop before a later request and never retry the denied scope", async () => {
  for (const status of [403, 429]) {
    const calls = [];
    await assert.rejects(collectResponses(plan.slice(0, 3), async request => { calls.push(request.sourceUrl); throw new HttpFailure(status, request.sourceUrl); }, { concurrency: 1, ...clock() }), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1);
  }
});

test("one invalid scope aborts the staged collection even after an earlier valid observation", async () => {
  let calls = 0;
  await assert.rejects(collectResponses(plan.slice(0, 3), async request => {
    const raw = payload(request); if (++calls === 2) raw.rates.selected.map = "route-66";
    return { payload: raw, collectedAt: NEW };
  }, { concurrency: 1, ...clock() }), /Selected scope mismatch/);
  assert.equal(calls, 2, "the invalid response is not retried and no third request starts");
});

test("timeout is an observed gap and is requested once rather than retried", async () => {
  const calls = new Map();
  const results = await collectResponses(plan.slice(0, 3), async request => {
    calls.set(key(request), (calls.get(key(request)) ?? 0) + 1);
    if (request.tier === "Bronze") throw new TransportTimeout("timed out");
    return { payload: payload(request), collectedAt: NEW };
  }, { concurrency: 2, ...clock() });
  assert.deepEqual(results.map(row => row.kind), ["observed", "timeout", "observed"]);
  assert.ok([...calls.values()].every(count => count === 1));
});

test("scheduler never exceeds three active requests or one request start per second", async () => {
  const virtual = clock(), starts = []; let active = 0, maximum = 0;
  const results = await collectResponses(plan.slice(0, 9), async request => {
    starts.push(virtual.now()); active++; maximum = Math.max(maximum, active);
    await immediate(); active--;
    return { payload: payload(request), collectedAt: NEW };
  }, virtual);
  assert.equal(results.length, 9); assert.equal(maximum, 3);
  assert.ok(starts.every((time, index) => !index || time - starts[index - 1] >= 1000));
  await assert.rejects(collectResponses([], undefined, { concurrency: 4 }), /Concurrency/);
  await assert.rejects(collectResponses([], undefined, { intervalMs: 999 }), /one request/);
});

test("atomic replacement validates the complete file and refuses to overwrite another writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "johap-statistics-test-")), path = join(directory, "statistics.json");
  try {
    const base = fixture(), original = `${JSON.stringify(base)}\n`; await writeFile(path, original);
    const results = timeoutResults(); replaceResult(results, route, observed(route));
    const next = mergeResponses(base, results, NEW).snapshot;
    await atomicWriteSnapshot(path, next, original);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
    assert.deepEqual(await readdir(directory), ["statistics.json"]);
    const concurrent = `${JSON.stringify(base, null, 2)}\n`; await writeFile(path, concurrent);
    await assert.rejects(atomicWriteSnapshot(path, next, original), /changed during collection/);
    assert.equal(await readFile(path, "utf8"), concurrent);
    assert.deepEqual(await readdir(directory), ["statistics.json"], "failed staging leaves no temp file or partial target");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
