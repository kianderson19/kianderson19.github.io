// Node 22, built-in modules only. The default/--validate path is read-only.
import { readFile, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const ORIGIN = "https://overwatch.blizzard.com";
export const API_PATH = "/ko-kr/rates/data/";
export const FAQ = `${ORIGIN}/en-us/rates/`;
export const COMPETITIVE_RQ = "1";
const HISTORICAL_COMPETITIVE_RQ = "2";
export const HERO_IDS = Object.freeze([
  "dmon", "dva", "genji", "domina", "doctrine", "doomfist", "ramattra", "lifeweaver",
  "reinhardt", "wrecking-ball", "roadhog", "lucio", "reaper", "mauga", "mercy", "mei",
  "moira", "mizuki", "bastion", "baptiste", "vendetta", "venture", "brigitte", "sojourn",
  "soldier-76", "sombra", "sigma", "symmetra", "sierra", "shion", "ana", "anran", "ashe",
  "echo", "emre", "orisa", "wuyang", "widowmaker", "winston", "illari", "zarya",
  "junker-queen", "junkrat", "jetpack-cat", "zenyatta", "juno", "cassidy", "kiriko",
  "torbjorn", "tracer", "pharah", "freja", "hanzo", "hazard",
]);
export const MAP_IDS = Object.freeze([
  "aatlis", "antarctic-peninsula", "blizzard-world", "busan", "circuit-royal", "colosseo",
  "dorado", "eichenwalde", "esperanca", "grimsvotn", "havana", "hollywood", "ilios",
  "junkertown", "kings-row", "lijiang-tower", "midtown", "neon-junction", "nepal",
  "new-junk-city", "new-queen-street", "numbani", "oasis", "paraiso", "rialto", "route-66",
  "runasapi", "samoa", "shambali-monastery", "suravasa", "watchpoint-gibraltar",
]);
export const TIERS = Object.freeze({
  All: "전체 티어", Bronze: "브론즈", Silver: "실버", Gold: "골드", Platinum: "플래티넘",
  Emerald: "에메랄드", Diamond: "다이아몬드", Master: "마스터",
  Grandmaster: "그랜드마스터 및 챔피언",
});
export const EXPECTED_SCOPES = (MAP_IDS.length + 1) * Object.keys(TIERS).length + 1;
const FILTER_KEYS = ["input", "map", "region", "role", "rq", "tier"];
const knownHeroes = new Set(HERO_IDS);
const tierById = new Map(Object.keys(TIERS).map(tier => [tier.toLowerCase(), tier]));
const isCompetitive = rq => rq === COMPETITIVE_RQ || rq === HISTORICAL_COMPETITIVE_RQ;
// Historical rq=2 observations remain identified by their original URL/time,
// but new rq=1 observations replace that same competitive/map/tier scope.
const id = request => `${isCompetitive(request.rq) ? "competitive" : "quickplay"}/${request.map}/${request.tier}`;
const assert = (condition, message) => { if (!condition) throw new ValidationError(message); };

export class ValidationError extends Error { name = "ValidationError"; }
export class TransportTimeout extends Error { name = "TransportTimeout"; }
export class HttpFailure extends Error {
  constructor(status, url) { super(`HTTP ${status}: ${url}; stopped without retry`); this.status = status; this.name = "HttpFailure"; }
}

export function requestPlan(competitiveRq = COMPETITIVE_RQ) {
  const tiers = Object.keys(TIERS);
  return [
    ...tiers.map(tier => makeRequest("all-maps", tier, competitiveRq)),
    ...MAP_IDS.flatMap(map => tiers.map(tier => makeRequest(map, tier, competitiveRq))),
    makeRequest("all-maps", "All", "0"),
  ];
}
export function makeRequest(map, tier, rq) {
  assert(map === "all-maps" || MAP_IDS.includes(map), "Unreviewed map inventory");
  assert(Object.hasOwn(TIERS, tier), "Unreviewed tier");
  assert(isCompetitive(rq) || (rq === "0" && map === "all-maps" && tier === "All"), "Unreviewed queue scope");
  const selected = { input: "PC", map, region: "Asia", role: "All", rq, tier };
  const url = new URL(API_PATH, ORIGIN);
  url.search = new URLSearchParams(selected).toString();
  return { map, tier, rq, selected, sourceUrl: url.href };
}

export function sourceRequest(value) {
  assert(typeof value === "string", "Missing source URL");
  const url = new URL(value);
  assert(url.origin === ORIGIN && url.pathname === API_PATH && !url.hash && !url.username && !url.password, "Source must be the reviewed HTTPS Blizzard endpoint");
  assert([...url.searchParams.keys()].sort().join() === [...FILTER_KEYS].sort().join(), "Source filter keys or duplicate parameters changed");
  const values = Object.fromEntries(url.searchParams);
  assert(values.input === "PC" && values.region === "Asia" && values.role === "All", "Unreviewed input/region/role");
  return makeRequest(values.map, values.tier, values.rq);
}

function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function sourcePercent(value) {
  // Explicit publisher missing markers replace old observations with null.
  // Actual 0 and 100 are valid, never normalized, clipped, smoothed or reconstructed.
  if (value === null || value === -1 || value === "--") return null;
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100, "Invalid source percentage");
  return value;
}
function storedPercent(value) {
  assert(value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100), "Stored percentage must be null or 0..100");
}
export function decodeResponse(payload, request, collectedAt) {
  assert(validDate(collectedAt), "Invalid retrieval timestamp");
  const selected = payload?.rates?.selected;
  assert(selected && typeof selected === "object" && !Array.isArray(selected), "Missing selected scope echo");
  assert(Object.keys(selected).sort().join() === [...FILTER_KEYS].sort().join(), "Selected filter keys changed");
  const mismatched = FILTER_KEYS.filter(key => selected[key] !== request.selected[key]);
  assert(!mismatched.length, `Selected scope mismatch (${mismatched.map(key => `${key}: requested ${request.selected[key]}, received ${String(selected[key])}`).join("; ")}); publisher filter contract changed; snapshot preserved`);
  const rows = payload?.rates?.rates;
  assert(Array.isArray(rows) && rows.length === HERO_IDS.length, "Hero inventory changed; manual roster review required");
  const seen = new Set();
  const values = rows.map(row => {
    assert(row && knownHeroes.has(row.id) && !seen.has(row.id), "Unknown, duplicate or absent hero");
    seen.add(row.id);
    assert(row.cells && typeof row.cells === "object" && ["winrate", "pickrate", "banrate"].every(key => Object.hasOwn(row.cells, key)), "Missing rate cells");
    return { heroId: row.id, rates: [sourcePercent(row.cells.winrate), sourcePercent(row.cells.pickrate), sourcePercent(row.cells.banrate)] };
  });
  assert(seen.size === HERO_IDS.length, "Incomplete hero inventory");
  return { kind: "observed", request, collectedAt, values };
}

export function validQueueContract(contract) {
  return contract && contract.sourceUrl === `${ORIGIN}/ko-kr/rates/` && validDate(contract.checkedAt)
    && ["1", "2"].includes(contract.competitive) && contract.quickplay === "0";
}

export function validateSnapshot(snapshot) {
  assert(snapshot?.version === 1 && validDate(snapshot.generatedAt), "Unsupported snapshot version or generation time");
  assert(Array.isArray(snapshot.heroes) && snapshot.heroes.length === HERO_IDS.length && new Set(snapshot.heroes).size === HERO_IDS.length && snapshot.heroes.every(hero => knownHeroes.has(hero)), "Snapshot hero set differs from reviewed roster");
  assert(Array.isArray(snapshot.scopes) && Array.isArray(snapshot.values), "Missing scope/value tables");
  const planned = new Set(requestPlan().map(id)), observed = new Set(), rowsByScope = new Map();
  snapshot.scopes.forEach((scope, index) => {
    const request = sourceRequest(scope.sourceUrl);
    const key = id(request);
    assert(!observed.has(key) && planned.has(key), "Duplicate or unexpected stored scope");
    observed.add(key);
    assert(scope.mapId === (request.map === "all-maps" ? null : request.map) && scope.tier === request.tier.toLowerCase(), "Stored map/tier disagrees with its source URL");
    assert(scope.queue === (isCompetitive(request.rq) ? "competitive" : "quickplay") && scope.queueMode === "role-queue" && scope.region === "asia" && scope.platform === "pc", "Stored filters disagree with source request");
    assert(scope.sourceKind === "blizzard" && scope.sampleSize === null && scope.dataDate === null && scope.patch === null && scope.season === null, "Undisclosed metadata must stay undisclosed");
    assert(scope.winRateMetric === "publisher-winrate" && scope.mirrorHandling === "not-disclosed" && scope.pickRateUnit === "hero-playtime-usage" && scope.definitionSourceUrl === FAQ, "Unsupported rate definition or invented mirror/sample semantics");
    assert(validDate(scope.collectedAt) && Date.parse(scope.collectedAt) <= Date.parse(snapshot.generatedAt), "Invalid scope retrieval time");
    if (scope.queueContract) assert(validQueueContract(scope.queueContract) && (isCompetitive(request.rq) ? scope.queueContract.competitive : scope.queueContract.quickplay) === request.rq && Date.parse(scope.queueContract.checkedAt) <= Date.parse(scope.collectedAt), "Stored queue contract mismatch");
    if (request.rq === "2" && Date.parse(scope.collectedAt) > Date.parse("2026-10-09T15:59:38Z")) assert(validQueueContract(scope.queueContract), "Current rq=2 observation requires official semantic queue evidence");
    assert(scope.evidenceUrl === request.sourceUrl.replace("/rates/data/", "/rates/"), "Evidence URL does not describe the same scope");
    assert(scope.tierLabel === TIERS[request.tier] && JSON.stringify(scope.tierGrouping) === JSON.stringify(request.tier === "Grandmaster" ? ["grandmaster", "champion"] : []), "Tier grouping changed");
    rowsByScope.set(index, new Set());
  });
  snapshot.values.forEach(row => {
    assert(Array.isArray(row) && row.length === 5 && Number.isInteger(row[0]) && Number.isInteger(row[1]) && row[0] >= 0 && row[0] < snapshot.heroes.length && rowsByScope.has(row[1]), "Invalid value indexes");
    const seen = rowsByScope.get(row[1]);
    assert(!seen.has(row[0]), "Duplicate hero/scope value");
    seen.add(row[0]); row.slice(2).forEach(storedPercent);
  });
  assert(snapshot.values.length === snapshot.scopes.length * HERO_IDS.length && [...rowsByScope.values()].every(rows => rows.size === HERO_IDS.length), "Each observed scope needs every reviewed hero, including null cells");
  const coverage = snapshot.coverage;
  assert(coverage?.expectedScopes === EXPECTED_SCOPES && coverage.observedScopes === snapshot.scopes.length && Array.isArray(coverage.unavailable), "Invalid retrieval coverage counts");
  assert(coverage.unavailable.length + observed.size === planned.size, "Retrieval gaps must cover the unobserved plan exactly");
  const gaps = new Set();
  coverage.unavailable.forEach(gap => {
    const request = sourceRequest(gap.sourceUrl), key = id(request);
    assert(planned.has(key) && !observed.has(key) && !gaps.has(key), "Overlapping or duplicate retrieval gap");
    assert(gap.mapId === (request.map === "all-maps" ? null : request.map) && gap.tier === request.tier.toLowerCase() && gap.queue === (isCompetitive(request.rq) ? "competitive" : "quickplay"), "Gap filters disagree with URL");
    assert(typeof gap.reason === "string" && gap.reason.length > 0 && validDate(gap.observedAt), "Gap requires a transport observation, not fabricated hero values");
    gaps.add(key);
  });
  return { heroes: snapshot.heroes.length, observedScopes: observed.size, expectedScopes: planned.size, values: snapshot.values.length, gaps: gaps.size };
}

async function limitedBody(response) {
  const limit = 2_000_000;
  const declared = Number(response.headers.get("content-length"));
  assert(!Number.isFinite(declared) || declared <= limit, "Response exceeds size limit");
  const reader = response.body?.getReader();
  assert(reader, "Missing response body");
  const chunks = []; let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new ValidationError("Response exceeds size limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function limitedJSON(response) {
  assert(/json/i.test(response.headers.get("content-type") ?? ""), "Response is not JSON");
  const body = await limitedBody(response);
  try { return JSON.parse(body); }
  catch { throw new ValidationError("Invalid source JSON"); }
}

export function validateQueueContract(html) {
  assert(typeof html === "string", "Official queue contract is not HTML");
  const select = html.match(/<select\b(?=[^>]*\bid=["']filter-rq-select["'])[^>]*>([\s\S]*?)<\/select>/i);
  assert(select, "Official queue dropdown is missing; publisher filter contract review required");
  const modes = new Map();
  for (const option of select[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const value = option[1].match(/\bvalue=["']([^"']+)["']/i)?.[1];
    const title = option[1].match(/\bdata-title=["']([^"']+)["']/i)?.[1] ?? option[2].replace(/<[^>]*>/g, "").trim();
    if (title === "경쟁전 - 역할 고정" || title === "빠른 대전 - 역할 고정") {
      assert(value && !modes.has(title), "Ambiguous official queue labels; publisher filter contract review required");
      modes.set(title, value);
    }
  }
  const competitive = modes.get("경쟁전 - 역할 고정");
  assert(["1", "2"].includes(competitive) && modes.get("빠른 대전 - 역할 고정") === "0",
    `Official queue labels/values require review: competitive=${String(competitive)}, quickplay=${String(modes.get("빠른 대전 - 역할 고정"))}; snapshot preserved`);
  return { competitive, quickplay: "0" };
}

export async function verifyOfficialQueueContract() {
  const sourceUrl = `${ORIGIN}/ko-kr/rates/`;
  const response = await fetch(sourceUrl, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "text/html", "User-Agent": "JohapStatisticsRefresh/0.1 (+https://github.com/kianderson19/kianderson19.github.io)" },
  });
  if (!response.ok) throw new HttpFailure(response.status, sourceUrl);
  assert(response.url === sourceUrl && /html/i.test(response.headers.get("content-type") ?? ""), "Official queue contract source changed; snapshot preserved");
  return { ...validateQueueContract(await limitedBody(response)), sourceUrl, checkedAt: new Date().toISOString() };
}

export async function fetchOfficial(request, { signal, timeoutMs = 45_000, queueContract } = {}) {
  const verifiedRequest = sourceRequest(request.sourceUrl);
  assert(!isCompetitive(verifiedRequest.rq) || (validQueueContract(queueContract) && queueContract.competitive === verifiedRequest.rq), "Historical rq=2 is read-only without verified current queue contract; competitive requests require the official dropdown observation");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(request.sourceUrl, {
      redirect: "manual", signal: combined,
      headers: { Accept: "application/json", "User-Agent": "JohapStatisticsRefresh/0.1 (+https://github.com/kianderson19/kianderson19.github.io)" },
    });
    if (!response.ok) throw new HttpFailure(response.status, request.sourceUrl);
    assert(response.url === request.sourceUrl, "Response URL changed; no redirect/source substitution allowed");
    return { payload: await limitedJSON(response), collectedAt: new Date().toISOString(), queueContract };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.signal.aborted) throw new TransportTimeout(`Transport timeout for ${request.sourceUrl}; not an empty or zero-win dataset`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function collectResponses(plan, fetchScope = fetchOfficial, options = {}) {
  const concurrency = options.concurrency ?? 3, intervalMs = options.intervalMs ?? 1_000;
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 3, "Concurrency must be 1..3");
  assert(Number.isFinite(intervalMs) && intervalMs >= 1_000, "At most one request may start per second");
  const now = options.now ?? Date.now, wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const stop = new AbortController(), results = Array(plan.length);
  let cursor = 0, lastStart = -Infinity, gate = Promise.resolve(), failure = null;
  async function networkSlot(startRequest) {
    let response;
    const slot = gate.then(async () => {
      if (stop.signal.aborted) throw stop.signal.reason;
      const delay = Math.max(0, lastStart + intervalMs - now());
      if (delay > 0) await wait(delay, stop.signal);
      if (stop.signal.aborted) throw stop.signal.reason;
      lastStart = now();
      // Invoke fetch inside the gate. Reserving a slot and starting fetch after
      // an extra await can bunch actual starts when continuations are delayed.
      response = Promise.resolve(startRequest());
      response.catch(() => {}); // The worker below still awaits and handles it.
    });
    gate = slot.catch(() => {}); await slot;
    return { response }; // Do not hold the rate gate until the network finishes.
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!stop.signal.aborted && cursor < plan.length) {
      const index = cursor++, request = plan[index];
      try {
        const started = await networkSlot(() => fetchScope(request, { signal: stop.signal }));
        const response = await started.response;
        results[index] = { ...decodeResponse(response.payload, request, response.collectedAt), ...(response.queueContract ? { queueContract: response.queueContract } : {}) };
      } catch (error) {
        if (stop.signal.aborted) break;
        if (error instanceof TransportTimeout || error?.name === "TimeoutError") {
          results[index] = { kind: "timeout", request, observedAt: new Date(now()).toISOString(), reason: "Transport timeout; not an empty or zero-win dataset" };
        } else {
          failure = error; stop.abort(error); break;
        }
      }
    }
  }));
  if (failure) throw failure;
  assert(results.every(Boolean), "Incomplete collection; snapshot preserved");
  return results;
}

function freshScope(request, collectedAt, mode, queueContract) {
  return {
    mapId: request.map === "all-maps" ? null : request.map, tier: request.tier.toLowerCase(),
    tierLabel: TIERS[request.tier], tierGrouping: request.tier === "Grandmaster" ? ["grandmaster", "champion"] : [],
    queue: isCompetitive(request.rq) ? "competitive" : "quickplay", queueMode: "role-queue", region: "asia", platform: "pc",
    sourceKind: "blizzard", sampleSize: null, dataDate: null, collectedAt,
    sourceUrl: request.sourceUrl, evidenceUrl: request.sourceUrl.replace("/rates/data/", "/rates/"),
    mode, patch: null, season: null, winRateMetric: "publisher-winrate", mirrorHandling: "not-disclosed",
    pickRateUnit: "hero-playtime-usage", definitionSourceUrl: FAQ, ...(queueContract ? { queueContract } : {}),
  };
}

export function mergeResponses(previous, results, generatedAt, plan = requestPlan()) {
  validateSnapshot(previous); assert(validDate(generatedAt), "Invalid output timestamp");
  assert(Array.isArray(results) && results.length === plan.length, "Collection must account for all planned scopes");
  const old = new Map(previous.scopes.map((scope, index) => [id(sourceRequest(scope.sourceUrl)), { scope, rows: previous.values.filter(row => row[1] === index) }]));
  const modes = new Map(previous.scopes.filter(scope => scope.mapId).map(scope => [scope.mapId, scope.mode]));
  const heroes = [...previous.heroes], heroIndex = new Map(heroes.map((hero, index) => [hero, index]));
  const scopes = [], values = [], unavailable = [], failedAttempts = [];
  let updatedScopes = 0, retainedScopes = 0;
  results.forEach((result, index) => {
    const request = plan[index];
    assert(result && id(result.request) === id(request) && result.request.sourceUrl === request.sourceUrl, "Collection result order/scope mismatch");
    if (result.kind === "observed") {
      assert(result.values.length === HERO_IDS.length && new Set(result.values.map(row => row.heroId)).size === HERO_IDS.length, "Invalid normalized hero inventory");
      assert(validDate(result.collectedAt) && Date.parse(result.collectedAt) <= Date.parse(generatedAt), "Retrieval time exceeds output time");
      const nextIndex = scopes.length;
      scopes.push(freshScope(request, result.collectedAt, modes.get(request.map) ?? null, result.queueContract));
      for (const row of result.values) {
        assert(heroIndex.has(row.heroId) && row.rates.length === 3, "Invalid normalized hero values");
        row.rates.forEach(storedPercent); values.push([heroIndex.get(row.heroId), nextIndex, ...row.rates]);
      }
      updatedScopes++;
    } else {
      assert(result.kind === "timeout" && validDate(result.observedAt) && typeof result.reason === "string", "Only observed transport timeouts may retain old data");
      const prior = old.get(id(request));
      const gap = { sourceUrl: request.sourceUrl, mapId: request.map === "all-maps" ? null : request.map, tier: request.tier.toLowerCase(), queue: isCompetitive(request.rq) ? "competitive" : "quickplay", reason: result.reason, observedAt: result.observedAt };
      failedAttempts.push({ ...gap, preservedPrevious: Boolean(prior), ...(prior ? { collectedAt: prior.scope.collectedAt } : {}) });
      if (prior) {
        // Keep values AND per-scope timestamps/URLs exactly as last observed.
        const nextIndex = scopes.length; scopes.push(structuredClone(prior.scope));
        prior.rows.forEach(row => values.push([row[0], nextIndex, ...row.slice(2)])); retainedScopes++;
      } else unavailable.push(gap);
    }
  });
  if (!updatedScopes) return { snapshot: previous, updatedScopes, retainedScopes, gaps: unavailable.length };
  const snapshot = {
    ...previous, generatedAt, heroes, scopes, values,
    coverage: { expectedScopes: plan.length, observedScopes: scopes.length, unavailable },
    refresh: { completedAt: generatedAt, requestedScopes: plan.length, updatedScopes, retainedScopes, failedAttempts },
  };
  validateSnapshot(snapshot);
  return { snapshot, updatedScopes, retainedScopes, gaps: unavailable.length };
}

export async function atomicWriteSnapshot(path, snapshot, expectedOriginal) {
  validateSnapshot(snapshot);
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = null;
    validateSnapshot(JSON.parse(await readFile(temporary, "utf8")));
    assert(await readFile(path, "utf8") === expectedOriginal, "Snapshot changed during collection; refusing to overwrite another writer");
    await rename(temporary, path);
  } finally { if (handle) await handle.close(); await rm(temporary, { force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  assert(args.length <= 1 && (!args.length || ["--validate", "--refresh"].includes(args[0])), "Usage: node refresh-statistics.mjs [--validate|--refresh]");
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/statistics-snapshot.json");
  const original = await readFile(path, "utf8"), previous = JSON.parse(original);
  const summary = validateSnapshot(previous);
  if (args[0] !== "--refresh") { console.log(JSON.stringify({ mode: "read-only-validation", ...summary })); return; }
  // Review the semantic mode labels before requesting any percentages. A new
  // enum value must be reviewed, never probed or silently treated as a fallback.
  const queueContract = await verifyOfficialQueueContract();
  const plan = requestPlan(queueContract.competitive);
  await sleep(1_000);
  const results = await collectResponses(plan, (request, options) => fetchOfficial(request, { ...options, queueContract }));
  const merged = mergeResponses(previous, results, new Date().toISOString(), plan);
  assert(merged.updatedScopes > 0, "No validated fresh scope; previous snapshot preserved");
  await atomicWriteSnapshot(path, merged.snapshot, original);
  console.log(JSON.stringify({ mode: "refresh", ...validateSnapshot(merged.snapshot), updatedScopes: merged.updatedScopes, retainedScopes: merged.retainedScopes }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; }
}
