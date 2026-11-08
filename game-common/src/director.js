import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { averageLength, normalizeProfile, emptyProfile } from './profile.js';
import { estimateValue, pruneRevenue } from './value.js';
import { RULES } from './rules.js';
import { memoryStorage } from './storage.js';

const MAX_REVENUE_ENTRIES = 500;

// Small seeded RNG for reproducible tests and replays.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates the difficulty director for one player.
 *
 * options:
 *   config   partial config merged over DEFAULT_CONFIG (or a preset)
 *   storage  { load(), save(obj) }  (default: in memory)
 *   ads      { isReady(format) -> bool, readyAdValue() -> USD of the loaded ad }
 *   signals  { country, model, bgmOn, vibrationOn }
 *   rules    extra rule functions by name; enable them under config.rules[name]
 *   now      () => ms timestamp
 *   rng      () => [0, 1)
 */
export function createDirector(options = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, options.config);
  const storage = options.storage ?? memoryStorage();
  const now = options.now ?? (() => Date.now());
  const rng = options.rng ?? Math.random;
  const ads = { isReady: () => false, readyAdValue: () => 0, ...options.ads };
  const rules = { ...RULES, ...options.rules };
  let signals = { country: '', model: '', bgmOn: true, vibrationOn: true, ...options.signals };
  let profile = normalizeProfile(storage.load());
  let run = null;
  let last = null;
  const listeners = { change: new Set(), end: new Set() };

  const emit = (type, payload) => listeners[type].forEach((fn) => fn(payload));
  const save = () => storage.save(profile);
  const runLength = () => (!run ? 0 : config.lengthUnit === 'ms' ? now() - run.startedAt : run.turns);
  const progress = () => runLength() / averageLength(profile, config);

  function adState() {
    return {
      rewardedReady: !!ads.isReady('rewarded'),
      interstitialReady: !!ads.isReady('interstitial'),
      readyAdValue: Number(ads.readyAdValue()) || 0,
    };
  }

  function ensureRun() {
    if (!run) startRun();
  }

  function startRun() {
    const guard = config.rules.highScoreGuard;
    const sinceBeat = profile.runs - profile.lastBeatRun;
    run = {
      id: profile.runs + 1,
      startedAt: now(),
      turns: 0,
      score: 0,
      revives: 0,
      reviveAt: null,
      reviveTurn: 0,
      pendingVariant: null,
      minuteRolls: {},
      minuteKillAt: null,
      // Decided once per run so the guard is consistent within a run.
      beatAllowed: profile.highScore <= 0 || (sinceBeat >= guard.minRunsBetweenBeats && rng() < guard.beatChance),
    };
    last = null;
    return decide();
  }

  // Runs every enabled rule and returns the winning decision.
  function decide() {
    ensureRun();
    const t = now();
    pruneRevenue(profile, config.value, t);
    const value = estimateValue(signals, profile, config.value, t);
    const base = { config, profile, run, progress: progress(), value, ads: adState(), rng, now: t };
    const votes = [];
    for (const [name, cfg] of Object.entries(config.rules)) {
      if (!cfg?.enabled || typeof rules[name] !== 'function') continue;
      const vote = rules[name]({ ...base, cfg });
      if (vote) votes.push({ rule: name, priority: cfg.priority ?? 0, ...vote });
    }
    votes.sort((a, b) => b.priority - a.priority);
    const top = votes[0] ?? { rule: 'none', mode: 'normal', reason: 'no rule matched' };
    const decision = {
      mode: top.mode,
      difficulty: config.difficulty[top.mode],
      rule: top.rule,
      reason: top.reason,
      votes,
      progress: base.progress,
      value,
      ads: base.ads,
    };
    const changed = !last || last.mode !== decision.mode || last.rule !== decision.rule;
    last = decision;
    if (changed) emit('change', decision);
    return decision;
  }

  // Call once per move/placement/hand. Returns the new decision.
  function turn({ score } = {}) {
    ensureRun();
    run.turns += 1;
    if (Number.isFinite(score)) run.score = score;
    return decide();
  }

  function setScore(score) {
    ensureRun();
    if (Number.isFinite(score)) run.score = score;
  }

  /**
   * Picks one candidate according to the current difficulty.
   * helpfulness(c) -> number: higher means better for the player
   * (a piece that clears lines, a strong card, a weak enemy...).
   * Boost picks from the helpful end, kill from the hostile end.
   */
  function pick(candidates, helpfulness, { difficulty } = {}) {
    const list = Array.from(candidates);
    if (!list.length) return undefined;
    const d = difficulty ?? (last ?? decide()).difficulty;
    const scored = list.map((c) => ({ c, h: Number(helpfulness(c)) || 0 })).sort((a, b) => b.h - a.h);
    const n = scored.length;
    const s = config.pickSpread;
    const weights = scored.map((_, i) => {
      const pos = n === 1 ? 0 : i / (n - 1);
      return Math.exp(-((pos - d) ** 2) / (2 * s * s));
    });
    let r = rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) {
      r -= weights[i];
      if (r <= 0) return scored[i].c;
    }
    return scored[n - 1].c;
  }

  // Impression-level ad revenue from the ad SDK (USD).
  function onAdShown({ revenue = 0 } = {}) {
    const t = now();
    const v = Number(revenue) || 0;
    profile.ads.impressions += 1;
    if (v > 0) {
      profile.ads.revenue.push({ t, v });
      if (profile.ads.revenue.length > MAX_REVENUE_ENTRIES) profile.ads.revenue.shift();
      profile.ads.lastRevenue = v;
      profile.ads.maxRevenue = Math.max(profile.ads.maxRevenue, v);
    }
    pruneRevenue(profile, config.value, t);
    save();
  }

  function variantStats(name) {
    profile.revive.variants[name] ??= { offered: 0, accepted: 0 };
    return profile.revive.variants[name];
  }

  // Learns which revive offer gets this player to watch: every variant is
  // tried once, then the best accept rate wins (with some exploration).
  function chooseVariant() {
    const vs = config.revive.variants;
    const untried = vs.find((v) => !profile.revive.variants[v]?.offered);
    if (untried) return untried;
    if (rng() < config.revive.explore) return vs[Math.floor(rng() * vs.length)];
    let best = vs[0];
    let bestRate = -1;
    for (const v of vs) {
      const s = profile.revive.variants[v];
      const rate = (s.accepted + 1) / (s.offered + 2);
      if (rate > bestRate) {
        best = v;
        bestRate = rate;
      }
    }
    return best;
  }

  // Call when the player can no longer move. Decides whether to offer a revive.
  function gameOver() {
    ensureRun();
    const rc = config.revive;
    const a = adState();
    if (!rc.enabled || !a.rewardedReady || run.revives >= rc.maxPerRun || progress() < rc.minProgress) {
      return { offer: false };
    }
    const variant = chooseVariant();
    run.pendingVariant = variant;
    variantStats(variant).offered += 1;
    profile.ads.rewardedOffered += 1;
    save();
    return {
      offer: true,
      variant,
      score: run.score,
      highScore: profile.highScore,
      toBest: Math.max(0, profile.highScore - run.score),
    };
  }

  // Call after the revive offer: accepted = the player watched the ad.
  function reviveResult(accepted) {
    ensureRun();
    const variant = run.pendingVariant;
    run.pendingVariant = null;
    if (accepted) {
      if (variant) variantStats(variant).accepted += 1;
      profile.ads.rewardedWatched += 1;
      run.revives += 1;
      run.reviveAt = now();
      run.reviveTurn = run.turns;
    }
    save();
    return decide();
  }

  function endRun({ score } = {}) {
    ensureRun();
    if (Number.isFinite(score)) run.score = score;
    const length = runLength();
    profile.lengths.push(length);
    while (profile.lengths.length > config.historySize) profile.lengths.shift();
    const newBest = run.score > profile.highScore;
    if (newBest) {
      profile.highScore = run.score;
      profile.lastBeatRun = profile.runs;
    }
    profile.runs += 1;
    const result = { score: run.score, length, newBest, highScore: profile.highScore, revives: run.revives };
    run = null;
    last = null;
    save();
    emit('end', result);
    return result;
  }

  return {
    config,
    startRun,
    decide,
    turn,
    setScore,
    pick,
    onAdShown,
    gameOver,
    reviveResult,
    endRun,
    setSignals(partial) {
      signals = { ...signals, ...partial };
    },
    getSignals: () => ({ ...signals }),
    get profile() {
      return profile;
    },
    get run() {
      return run;
    },
    get lastDecision() {
      return last;
    },
    averageLength: () => averageLength(profile, config),
    reset() {
      profile = emptyProfile();
      run = null;
      last = null;
      save();
    },
    on(type, fn) {
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
  };
}
