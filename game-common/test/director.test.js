import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDirector, mulberry32, presets, memoryStorage, estimateValue, emptyProfile, DEFAULT_CONFIG,
} from '../src/index.js';

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

// Turns on just the named rules, so each test looks at one behaviour at a time.
function only(...names) {
  const rules = {};
  for (const name of Object.keys(DEFAULT_CONFIG.rules)) rules[name] = { enabled: names.includes(name) };
  return { rules };
}

function finishRuns(d, lengths, score = 10) {
  for (const len of lengths) {
    d.startRun();
    for (let i = 0; i < len; i++) d.turn({ score });
    d.endRun();
  }
}

test('player value: high-tier country/device/sound/ads outrank low tier', () => {
  const cfg = DEFAULT_CONFIG.value;
  const now = 1e12;
  const rich = emptyProfile();
  rich.ads.revenue = [{ t: now - 1000, v: 0.03 }];
  rich.ads.lastRevenue = 0.03;
  rich.ads.maxRevenue = 0.04;
  rich.ads.impressions = 30;
  rich.ads.rewardedOffered = 10;
  rich.ads.rewardedWatched = 8;
  const hi = estimateValue({ country: 'US', model: 'iPhone17,2', bgmOn: true, vibrationOn: true }, rich, cfg, now);
  const lo = estimateValue({ country: 'XX', model: 'SM-A055F', bgmOn: false, vibrationOn: false }, emptyProfile(), cfg, now);
  assert.equal(hi.tier, 'high');
  assert.equal(lo.tier, 'low');
  assert.ok(hi.score > 0.9 && lo.score < 0.05, `${hi.score} ${lo.score}`);
  assert.equal(hi.parts.device, 1);
  assert.equal(lo.parts.country, 0);
});

test('boost then kill follows the average game length', () => {
  const d = createDirector({ config: { ...only('boostThenKill') }, rng: mulberry32(1) });
  finishRuns(d, [20, 20, 20]);
  assert.equal(d.averageLength(), 20);
  d.startRun();
  const modes = [];
  for (let i = 0; i < 24; i++) modes.push(d.turn({ score: i }).mode);
  assert.equal(modes[0], 'normal');          // 5%: warm-up
  assert.equal(modes[5], 'boost');           // 30%
  assert.equal(modes[14], 'boost');          // 75%
  assert.equal(modes[23], 'kill');           // 120%
  const firstKill = modes.indexOf('kill') + 1;
  // Low-value player (no signals): kill lands near the average (minus valueShift x small score).
  assert.ok(firstKill >= 17 && firstKill <= 20, `first kill at turn ${firstKill}`);
});

test('high-value players are pushed to the kill sooner', () => {
  const firstKill = (signals) => {
    const d = createDirector({ config: only('boostThenKill'), signals, rng: mulberry32(2) });
    finishRuns(d, [40, 40]);
    d.startRun();
    for (let i = 1; i <= 80; i++) if (d.turn().mode === 'kill') return i;
    return Infinity;
  };
  const rich = firstKill({ country: 'US', model: 'iPhone17,2', bgmOn: true, vibrationOn: true });
  const poor = firstKill({ country: 'XX', model: 'generic', bgmOn: false, vibrationOn: false });
  assert.ok(rich < poor, `rich ${rich} poor ${poor}`);
});

test('high value ad harvest needs an expensive ad and an ad-watching history', () => {
  let adValue = 0.03;
  const d = createDirector({
    config: only('highValueAdHarvest'),
    ads: { isReady: (f) => f === 'rewarded', readyAdValue: () => adValue },
  });
  finishRuns(d, [10]);
  d.startRun();
  for (let i = 0; i < 8; i++) d.turn();
  assert.equal(d.decide().rule, 'none');      // no history of watching ads yet
  d.onAdShown({ revenue: 0.02 });
  d.onAdShown({ revenue: 0.01 });
  assert.equal(d.decide().mode, 'kill');
  adValue = 0.004;                            // cheap ad loaded: leave them alone
  assert.equal(d.decide().mode, 'normal');
});

test('high score guard kills just before the record unless the run may beat it', () => {
  const d = createDirector({ config: only('highScoreGuard', 'nearHighScoreTease'), rng: () => 0.99 });
  d.startRun();
  d.endRun({ score: 1000 });
  d.startRun();
  assert.equal(d.run.beatAllowed, false);
  d.setScore(700);
  assert.equal(d.decide().rule, 'nearHighScoreTease');
  assert.equal(d.decide().mode, 'boost');
  d.setScore(950);
  assert.equal(d.decide().rule, 'highScoreGuard');
  assert.equal(d.decide().mode, 'kill');
  d.endRun();

  // With a lucky roll and enough runs since the last record, the guard steps aside.
  const lucky = createDirector({ config: only('highScoreGuard'), rng: () => 0 });
  finishRuns(lucky, [1], 1000);
  finishRuns(lucky, [1, 1, 1], 0);
  lucky.startRun();
  assert.equal(lucky.run.beatAllowed, true);
  lucky.setScore(990);
  assert.equal(lucky.decide().mode, 'normal');
});

test('exact minute kill rolls once per listed minute', () => {
  const now = clock();
  const d = createDirector({ config: only('exactMinuteKill'), now, rng: () => 0.4 });
  d.startRun();
  now.advance(2 * 60000);
  assert.equal(d.decide().mode, 'normal');
  now.advance(60000);                         // minute 3: 0.4 >= 0.25, survives
  assert.equal(d.decide().mode, 'normal');
  assert.deepEqual(d.run.minuteRolls, { 3: false });
  now.advance(2 * 60000);                     // minute 5: 0.4 < 0.5, hit
  const dec = d.decide();
  assert.equal(dec.mode, 'kill');
  assert.match(dec.reason, /minute 5/);
});

test('revive offer, grace boost, then back to the kill', () => {
  const d = createDirector({
    config: only('boostThenKill', 'reviveGrace'),
    ads: { isReady: () => true, readyAdValue: () => 0.01 },
    rng: mulberry32(3),
  });
  finishRuns(d, [10, 10]);
  d.startRun();
  for (let i = 0; i < 12; i++) d.turn();
  assert.equal(d.decide().mode, 'kill');
  const offer = d.gameOver();
  assert.equal(offer.offer, true);
  assert.ok(DEFAULT_CONFIG.revive.variants.includes(offer.variant));
  assert.equal(d.reviveResult(true).mode, 'boost');
  for (let i = 0; i < 4; i++) d.turn();
  assert.equal(d.decide().mode, 'kill');
  assert.equal(d.gameOver().offer, false);   // one revive per run
  assert.equal(d.profile.ads.rewardedWatched, 1);
});

test('revive variants: learns the one this player watches', () => {
  const d = createDirector({
    config: { ...only(), revive: { explore: 0, minProgress: 0 } },
    ads: { isReady: () => true, readyAdValue: () => 0 },
  });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    d.startRun();
    const { variant } = d.gameOver();
    seen.add(variant);
    d.reviveResult(variant === 'nearBest');
    d.endRun();
  }
  assert.equal(seen.size, 4);                 // every variant was tried
  d.startRun();
  assert.equal(d.gameOver().variant, 'nearBest');
});

test('pick follows the difficulty', () => {
  const d = createDirector({ rng: mulberry32(4) });
  const xs = Array.from({ length: 10 }, (_, i) => i);
  const avg = (difficulty) => {
    let s = 0;
    for (let i = 0; i < 400; i++) s += d.pick(xs, (x) => x, { difficulty });
    return s / 400;
  };
  assert.ok(avg(0.05) > 7.5, 'boost picks from the helpful end');
  assert.ok(avg(0.97) < 1.5, 'kill picks from the hostile end');
  assert.ok(Math.abs(avg(0.45) - 5) < 1.5, 'normal stays in the middle');
  assert.equal(d.pick([], (x) => x), undefined);
});

test('profile survives a reload through storage', () => {
  const storage = memoryStorage();
  const a = createDirector({ storage });
  finishRuns(a, [12], 340);
  a.onAdShown({ revenue: 0.02 });
  const b = createDirector({ storage });
  assert.equal(b.profile.runs, 1);
  assert.equal(b.profile.highScore, 340);
  assert.equal(b.profile.ads.impressions, 1);
  assert.deepEqual(b.profile.lengths, [12]);
});

test('corrupted saves fall back to an empty profile', () => {
  const d = createDirector({ storage: { load: () => ({ runs: 'x', ads: null, lengths: [1, 'a'] }), save() {} } });
  assert.equal(d.profile.runs, 0);
  assert.deepEqual(d.profile.lengths, [1]);
});

test('fair preset never kills on value, ads or high score', () => {
  const d = createDirector({
    config: presets.fair,
    signals: { country: 'US', model: 'iPhone17,2' },
    ads: { isReady: () => true, readyAdValue: () => 0.05 },
    rng: mulberry32(5),
  });
  for (let i = 0; i < 5; i++) d.onAdShown({ revenue: 0.03 });
  finishRuns(d, [10, 10, 10], 100);
  d.startRun();
  for (let i = 0; i < 40; i++) {
    const dec = d.turn({ score: 95 + i });
    assert.notEqual(dec.mode, 'kill', `${dec.rule}: ${dec.reason}`);
  }
});

test('custom game rules plug in through options.rules + config', () => {
  const d = createDirector({
    rules: { bossFloor: ({ run }) => (run.turns % 10 === 0 ? { mode: 'kill', reason: 'boss floor' } : null) },
    config: { ...only(), rules: { ...only().rules, bossFloor: { enabled: true, priority: 35 } } },
  });
  d.startRun();
  for (let i = 0; i < 9; i++) assert.equal(d.turn().mode, 'normal');
  const dec = d.turn();
  assert.equal(dec.rule, 'bossFloor');
  assert.equal(dec.mode, 'kill');
});

test('time-based game length (lengthUnit: ms)', () => {
  const now = clock();
  const d = createDirector({ config: { ...only('boostThenKill', 'reviveGrace'), lengthUnit: 'ms' }, now, ads: { isReady: () => true } });
  for (let i = 0; i < 2; i++) {
    d.startRun();
    now.advance(60000);
    d.endRun();
  }
  assert.equal(d.averageLength(), 60000);
  d.startRun();
  now.advance(30000);
  assert.equal(d.decide().mode, 'boost');
  now.advance(35000);
  assert.equal(d.decide().mode, 'kill');
  d.gameOver();
  assert.equal(d.reviveResult(true).mode, 'boost');   // 20 s grace
  now.advance(21000);
  assert.equal(d.decide().mode, 'kill');
});

test('change events fire when the mode or rule changes', () => {
  const d = createDirector({ config: only('boostThenKill'), rng: mulberry32(6) });
  finishRuns(d, [10]);
  const seen = [];
  d.on('change', (dec) => seen.push(dec.mode));
  d.startRun();
  for (let i = 0; i < 12; i++) d.turn();
  assert.deepEqual(seen, ['normal', 'boost', 'normal', 'kill']);
});
