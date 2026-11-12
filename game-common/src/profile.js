// Everything the director remembers about a player between sessions.

export const PROFILE_VERSION = 1;

export function emptyProfile() {
  return {
    version: PROFILE_VERSION,
    runs: 0,             // finished runs
    lengths: [],         // recent run lengths (config.lengthUnit)
    highScore: 0,
    lastBeatRun: -1,     // run index on which the high score was last beaten
    ads: {
      impressions: 0,
      revenue: [],       // [{ t, v }] impression-level revenue inside the window
      lastRevenue: 0,
      maxRevenue: 0,
      rewardedOffered: 0,
      rewardedWatched: 0,
    },
    revive: { variants: {} }, // name -> { offered, accepted }
  };
}

// Accepts anything (old saves, corrupted JSON) and returns a valid profile.
export function normalizeProfile(raw) {
  const p = emptyProfile();
  if (!raw || typeof raw !== 'object') return p;
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
  p.runs = Math.max(0, num(raw.runs));
  p.lengths = Array.isArray(raw.lengths) ? raw.lengths.filter(Number.isFinite) : [];
  p.highScore = Math.max(0, num(raw.highScore));
  p.lastBeatRun = num(raw.lastBeatRun, -1);
  const a = raw.ads || {};
  p.ads.impressions = Math.max(0, num(a.impressions));
  p.ads.revenue = Array.isArray(a.revenue)
    ? a.revenue.filter((e) => e && Number.isFinite(e.t) && Number.isFinite(e.v))
    : [];
  p.ads.lastRevenue = num(a.lastRevenue);
  p.ads.maxRevenue = num(a.maxRevenue);
  p.ads.rewardedOffered = Math.max(0, num(a.rewardedOffered));
  p.ads.rewardedWatched = Math.max(0, num(a.rewardedWatched));
  const v = raw.revive && raw.revive.variants;
  if (v && typeof v === 'object') {
    for (const [name, s] of Object.entries(v)) {
      p.revive.variants[name] = { offered: Math.max(0, num(s && s.offered)), accepted: Math.max(0, num(s && s.accepted)) };
    }
  }
  return p;
}

export function averageLength(profile, config) {
  const xs = profile.lengths;
  if (!xs.length) return config.defaultAvgLength[config.lengthUnit];
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function watchRate(profile) {
  const { rewardedOffered, rewardedWatched } = profile.ads;
  return rewardedOffered ? rewardedWatched / rewardedOffered : 0;
}
