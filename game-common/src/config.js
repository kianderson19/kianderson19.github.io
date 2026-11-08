// Default tuning. Every number here is meant to be overridden per game
// (or from remote config) through mergeConfig().

export const DEFAULT_CONFIG = {
  // How "game length" is measured: 'turns' (moves/placements/hands) or 'ms'.
  lengthUnit: 'turns',
  // Average length assumed until the player has finished a few runs.
  defaultAvgLength: { turns: 40, ms: 180000 },
  // Finished runs kept for the average game length.
  historySize: 20,

  // Difficulty handed to the game for each mode (0 = most helpful, 1 = most hostile).
  difficulty: { boost: 0.06, normal: 0.45, kill: 0.97 },
  // How tightly pick() follows the difficulty (smaller = more deterministic).
  pickSpread: 0.12,

  // "How much you're worth to them in ads."
  value: {
    weights: { country: 0.25, device: 0.15, sound: 0.10, vibration: 0.05, adRevenue: 0.30, adHabit: 0.15 },
    // 3 = highest ad prices. Unlisted countries use defaultCountryTier.
    countryTiers: {
      US: 3, CA: 3, GB: 3, AU: 3, DE: 3, JP: 3, KR: 3, CH: 3, NO: 3, SE: 3, DK: 3, NL: 3,
      FR: 2, IT: 2, ES: 2, NZ: 2, SG: 2, HK: 2, TW: 2, AT: 2, BE: 2, FI: 2, IE: 2, IL: 2, AE: 2, SA: 2,
    },
    defaultCountryTier: 1,
    // First matching pattern wins. Matched against the raw model identifier.
    deviceTiers: [
      { match: '^iPhone(1[6-9]|[2-9]\\d),', tier: 3 },   // iPhone 15 Pro and later
      { match: '^iPhone', tier: 2 },
      { match: '^iPad', tier: 2 },
      { match: '^SM-(S9|F9|F7)', tier: 3 },             // Galaxy S / Fold / Flip
      { match: '^Pixel ([89]|1\\d)', tier: 3 },
      { match: '^SM-(S|N|G9)|^Pixel', tier: 2 },
    ],
    defaultDeviceTier: 1,
    // Revenue of one impression (USD) treated as the top of the scale.
    revenueRef: 0.02,
    // Window for the rolling average ad revenue.
    revenueWindowMs: 7 * 24 * 60 * 60 * 1000,
    // value score thresholds for the tier label.
    tiers: { high: 0.62, mid: 0.36 },
  },

  // Rules vote for a mode; the highest priority vote wins.
  rules: {
    // Keep brand-new players hooked: the first runs are generous.
    newPlayerHoneymoon: { enabled: true, priority: 45, runs: 2, untilProgress: 1.3 },
    // "Boost then kill": best run of your life until your average game length.
    boostThenKill: {
      enabled: true, priority: 10,
      boostFrom: 0.15,   // progress (run length / average) where boost starts
      squeezeFrom: 0.85, // progress where it stops helping
      killFrom: 1.0,     // progress where it turns on you
      valueShift: 0.25,  // high-value players are pushed to the kill sooner (x value score)
    },
    // Secretly help the player get close to their high score so they come back.
    nearHighScoreTease: { enabled: true, priority: 20, from: 0.55, to: 0.9 },
    // "Death algorithm": end the run just before the high score is beaten.
    highScoreGuard: { enabled: true, priority: 40, from: 0.9, beatChance: 0.2, minRunsBetweenBeats: 3 },
    // Roll once on each listed minute; once it hits, the run is killed.
    exactMinuteKill: { enabled: true, priority: 25, curve: { 3: 0.25, 5: 0.5, 8: 0.8, 12: 1 } },
    // "A really expensive ad is ready" + "a history of watching ads" -> it turns on you.
    highValueAdHarvest: {
      enabled: true, priority: 30,
      minAdValue: 0.015, minAdsWatched: 2, minWatchRate: 0.3, minProgress: 0.5,
    },
    // After a revive, help for a moment so the ad felt worth it.
    reviveGrace: { enabled: true, priority: 50, turns: 4, ms: 20000 },
    // Plain skill-based easing (used by the fair preset).
    skillFlow: { enabled: false, priority: 5, easeBelow: 0.6 },
  },

  // "The moment you lose is an offer to revive."
  revive: {
    enabled: true,
    maxPerRun: 1,
    minProgress: 0.3,
    // Offer styles; the director learns which one gets the player to watch.
    variants: ['countdown5', 'countdown10', 'nearBest', 'progress'],
    explore: 0.15,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep merge for config objects. Arrays and scalars in `override` replace.
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : structuredClone(v);
  }
  return out;
}

export const presets = {
  // The system described in the video: difficulty follows ad value.
  harvest: DEFAULT_CONFIG,
  // Same plumbing, but difficulty only follows skill; no value-based kills.
  fair: mergeConfig(DEFAULT_CONFIG, {
    rules: {
      boostThenKill: { enabled: false },
      highScoreGuard: { enabled: false },
      exactMinuteKill: { enabled: false },
      highValueAdHarvest: { enabled: false },
      nearHighScoreTease: { enabled: false },
      skillFlow: { enabled: true },
    },
  }),
};
