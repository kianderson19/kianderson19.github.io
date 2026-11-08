import { watchRate } from './profile.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function countryTier(country, cfg) {
  const code = String(country || '').toUpperCase();
  return cfg.countryTiers[code] ?? cfg.defaultCountryTier;
}

export function deviceTier(model, cfg) {
  const m = String(model || '');
  for (const { match, tier } of cfg.deviceTiers) {
    if (new RegExp(match).test(m)) return tier;
  }
  return cfg.defaultDeviceTier;
}

// Drops revenue entries older than the window. Mutates the profile.
export function pruneRevenue(profile, cfg, now) {
  const from = now - cfg.revenueWindowMs;
  profile.ads.revenue = profile.ads.revenue.filter((e) => e.t >= from);
}

// Estimates how much this player is worth in ads, as a 0..1 score.
// signals: { country, model, bgmOn, vibrationOn }
export function estimateValue(signals, profile, cfg, now) {
  const rev = profile.ads.revenue.filter((e) => e.t >= now - cfg.revenueWindowMs);
  const avg = rev.length ? rev.reduce((s, e) => s + e.v, 0) / rev.length : 0;
  const norm = (v) => clamp01(v / cfg.revenueRef);

  const parts = {
    country: (countryTier(signals.country, cfg) - 1) / 2,
    device: (deviceTier(signals.model, cfg) - 1) / 2,
    sound: signals.bgmOn ? 1 : 0,
    vibration: signals.vibrationOn ? 1 : 0,
    adRevenue: clamp01(0.6 * norm(avg) + 0.25 * norm(profile.ads.lastRevenue) + 0.15 * norm(profile.ads.maxRevenue)),
    adHabit: clamp01(0.7 * watchRate(profile) + 0.3 * Math.min(profile.ads.impressions / 20, 1)),
  };

  let total = 0;
  let weightSum = 0;
  for (const [k, w] of Object.entries(cfg.weights)) {
    total += w * (parts[k] ?? 0);
    weightSum += w;
  }
  const score = weightSum ? total / weightSum : 0;
  const tier = score >= cfg.tiers.high ? 'high' : score >= cfg.tiers.mid ? 'mid' : 'low';
  return { score, tier, parts };
}
