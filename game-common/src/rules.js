import { averageLength, watchRate } from './profile.js';

// Each rule looks at the context and either returns null (no opinion)
// or a vote: { mode: 'boost' | 'normal' | 'kill', reason }.
// The director keeps the vote with the highest configured priority.
//
// ctx: {
//   cfg,       // rule config (config.rules[name])
//   config,    // whole config
//   profile,   // persistent player profile
//   run,       // current run state (see director.startRun)
//   progress,  // run length / average game length
//   value,     // estimateValue() result
//   ads,       // { rewardedReady, interstitialReady, readyAdValue }
//   rng,       // () => [0, 1)
//   now,       // ms timestamp
// }

export const RULES = {
  newPlayerHoneymoon({ cfg, profile, progress }) {
    if (profile.runs >= cfg.runs || progress >= cfg.untilProgress) return null;
    return { mode: 'boost', reason: `run ${profile.runs + 1} of the first ${cfg.runs}: keep them hooked` };
  },

  boostThenKill({ cfg, progress, value }) {
    const killAt = Math.max(cfg.squeezeFrom, cfg.killFrom - cfg.valueShift * value.score);
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (progress >= killAt) {
      return { mode: 'kill', reason: `reached ${pct(progress)} of average game length (kill at ${pct(killAt)})` };
    }
    if (progress >= cfg.squeezeFrom) {
      return { mode: 'normal', reason: `approaching average game length (${pct(progress)})` };
    }
    if (progress >= cfg.boostFrom) {
      return { mode: 'boost', reason: `best run of your life until average length (${pct(progress)})` };
    }
    return { mode: 'normal', reason: 'warm-up' };
  },

  nearHighScoreTease({ cfg, profile, run }) {
    if (profile.highScore <= 0) return null;
    const r = run.score / profile.highScore;
    if (r < cfg.from || r >= cfg.to) return null;
    return { mode: 'boost', reason: `pulling toward high score (${Math.round(r * 100)}% of best)` };
  },

  highScoreGuard({ cfg, profile, run }) {
    if (profile.highScore <= 0 || run.beatAllowed) return null;
    const r = run.score / profile.highScore;
    if (r < cfg.from) return null;
    return { mode: 'kill', reason: `about to beat high score (${Math.round(r * 100)}%): death algorithm` };
  },

  exactMinuteKill({ cfg, run, rng, now }) {
    const minute = Math.floor((now - run.startedAt) / 60000);
    for (const [m, chance] of Object.entries(cfg.curve)) {
      const key = Number(m);
      if (minute < key || key in run.minuteRolls) continue;
      run.minuteRolls[key] = rng() < chance;
      if (run.minuteRolls[key]) run.minuteKillAt = key;
    }
    if (run.minuteKillAt == null) return null;
    return { mode: 'kill', reason: `minute ${run.minuteKillAt} roll hit` };
  },

  highValueAdHarvest({ cfg, profile, progress, ads }) {
    if (progress < cfg.minProgress) return null;
    if (!(ads.rewardedReady || ads.interstitialReady)) return null;
    if (ads.readyAdValue < cfg.minAdValue) return null;
    const habit = profile.ads.impressions >= cfg.minAdsWatched || watchRate(profile) >= cfg.minWatchRate;
    if (!habit) return null;
    return { mode: 'kill', reason: `expensive ad ready ($${ads.readyAdValue.toFixed(3)}) and player watches ads` };
  },

  reviveGrace({ cfg, run, config, now }) {
    if (!run.revives || run.reviveAt == null) return null;
    const active = config.lengthUnit === 'ms'
      ? now - run.reviveAt < cfg.ms
      : run.turns - run.reviveTurn < cfg.turns;
    if (!active) return null;
    return { mode: 'boost', reason: 'just revived: make the ad feel worth it' };
  },

  skillFlow({ cfg, profile, progress, config }) {
    const last = profile.lengths[profile.lengths.length - 1];
    if (last != null && last < averageLength(profile, config) * cfg.easeBelow && progress < 1) {
      return { mode: 'boost', reason: 'last run was short: ease off a little' };
    }
    return { mode: 'normal', reason: 'skill only' };
  },
};
