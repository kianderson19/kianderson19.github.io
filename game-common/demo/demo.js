// Playable demo: an 8x8 block puzzle wired to the difficulty director.
// The puzzle is only a test bed; the director is the reusable part.
import { createDirector, presets, localStorageStorage } from '../src/index.js';

const N = 8;
const $ = (id) => document.getElementById(id);

// Piece shapes as ASCII art: '#' = block.
const SHAPE_ART = [
  '#', '##', '#|#', '###', '#|#|#', '####', '#|#|#|#', '#####', '#|#|#|#|#',
  '##|##', '###|###|###', '###|###', '##|##|##',
  '#.|##', '##|#.', '##|.#', '.#|##',
  '#.|#.|##', '###|#..', '##|.#|.#', '..#|###',
  '.#|.#|##', '#..|###', '##|#.|#.', '###|..#',
  '#..|#..|###', '###|#..|#..', '###|..#|..#', '..#|..#|###',
  '###|.#.', '.#|##|.#', '.#.|###', '#.|##|#.',
  '.##|##.', '##.|.##', '#.|##|.#', '.#|##|#.',
];
const SHAPES = SHAPE_ART.map((art, id) => {
  const rows = art.split('|');
  const cells = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch === '#' && cells.push([r, c])));
  return { id, cells, h: rows.length, w: Math.max(...rows.map((r) => r.length)) };
});
const COLORS = ['#ef6f5e', '#f2a541', '#e8c547', '#4cb36b', '#2fa8a0', '#4f8fe0', '#8a6cf0', '#e266b0'];

const AD_PRICES = { cheap: 0.004, normal: 0.01, expensive: 0.03 };
const MODE_LABEL = { boost: 'BOOST', normal: 'NORMAL', kill: 'KILL' };
const VARIANT_LABEL = {
  countdown5: '5초 카운트다운',
  countdown10: '10초 카운트다운',
  nearBest: '최고 기록까지 남은 점수',
  progress: '진행도 막대',
};

const state = {
  board: Array(N * N).fill(null),
  tray: [null, null, null],
  score: 0,
  combo: 0,
  over: false,
  flash: new Set(),
  preset: 'harvest',
  ad: { rewardedReady: true, price: 'normal' },
};

let director = null;

function readSignals() {
  return {
    country: $('country').value,
    model: $('device').value,
    bgmOn: $('bgm').checked,
    vibrationOn: $('vibration').checked,
  };
}

function makeDirector() {
  const d = createDirector({
    config: presets[state.preset],
    storage: localStorageStorage('game-common-demo'),
    signals: readSignals(),
    ads: {
      isReady: (format) => format === 'rewarded' && state.ad.rewardedReady,
      readyAdValue: () => (state.ad.rewardedReady ? AD_PRICES[state.ad.price] : 0),
    },
  });
  d.on('change', logDecision);
  return d;
}

// ---------- board logic ----------

const at = (board, r, c) => board[r * N + c];

function canPlace(board, shape, r, c) {
  if (r < 0 || c < 0 || r + shape.h > N || c + shape.w > N) return false;
  return shape.cells.every(([dr, dc]) => !at(board, r + dr, c + dc));
}

function placements(board, shape) {
  const out = [];
  for (let r = 0; r <= N - shape.h; r++) {
    for (let c = 0; c <= N - shape.w; c++) if (canPlace(board, shape, r, c)) out.push([r, c]);
  }
  return out;
}

function fullLines(board) {
  const rows = [];
  const cols = [];
  for (let i = 0; i < N; i++) {
    let row = true;
    let col = true;
    for (let j = 0; j < N; j++) {
      if (!at(board, i, j)) row = false;
      if (!at(board, j, i)) col = false;
    }
    if (row) rows.push(i);
    if (col) cols.push(i);
  }
  return { rows, cols };
}

function linesIfPlaced(board, shape, r, c) {
  const b = board.slice();
  for (const [dr, dc] of shape.cells) b[(r + dr) * N + c + dc] = 1;
  const { rows, cols } = fullLines(b);
  return rows.length + cols.length;
}

// How good this shape is for the player right now. This is the only
// game-specific function the director needs.
function helpfulness(board, shape) {
  const spots = placements(board, shape);
  if (!spots.length) return -100 - shape.cells.length;
  let bestLines = 0;
  for (const [r, c] of spots) bestLines = Math.max(bestLines, linesIfPlaced(board, shape, r, c));
  return bestLines * 10 + Math.log2(spots.length + 1) - shape.cells.length * 0.3;
}

function refillTray() {
  const color = () => COLORS[Math.floor(Math.random() * COLORS.length)];
  state.tray = [0, 1, 2].map(() => ({
    shape: director.pick(SHAPES, (s) => helpfulness(state.board, s)),
    color: color(),
  }));
}

function place(slot, r, c) {
  const piece = state.tray[slot];
  for (const [dr, dc] of piece.shape.cells) state.board[(r + dr) * N + c + dc] = piece.color;
  state.tray[slot] = null;
  let gained = piece.shape.cells.length;
  const { rows, cols } = fullLines(state.board);
  const lines = rows.length + cols.length;
  const cleared = new Set();
  if (lines) {
    state.combo += 1;
    gained += lines * 10 * lines * state.combo;
    for (const i of rows) for (let j = 0; j < N; j++) cleared.add(i * N + j);
    for (const i of cols) for (let j = 0; j < N; j++) cleared.add(j * N + i);
    toast(`${lines}줄${state.combo > 1 ? ` · 콤보 ${state.combo}` : ''}  +${gained}`);
  } else {
    state.combo = 0;
  }
  state.score += gained;
  for (const i of cleared) state.board[i] = null;
  if (cleared.size) {
    state.flash = cleared;
    setTimeout(() => {
      state.flash = new Set();
      renderBoard();
    }, 260);
  }
  director.turn({ score: state.score });
  if (state.tray.every((p) => !p)) refillTray();
  render();
  checkGameOver();
}

function checkGameOver() {
  const alive = state.tray.some((p) => p && placements(state.board, p.shape).length);
  if (alive) return;
  state.over = true;
  toast('놓을 자리가 없어요');
  const offer = director.gameOver();
  render();
  setTimeout(() => (offer.offer ? showRevive(offer) : finishRun()), 700);
}

// ---------- revive / game over ----------

let countdown = null;

function showRevive(offer) {
  const dlg = $('revive');
  $('revive-variant').textContent = `제안 방식: ${VARIANT_LABEL[offer.variant] ?? offer.variant}`;
  const body = $('revive-body');
  body.replaceChildren();
  clearInterval(countdown);
  if (offer.variant === 'nearBest' && offer.highScore > 0) {
    body.append(el('p', 'big', `최고 기록까지 ${offer.toBest}점!`));
  } else if (offer.variant === 'progress' && offer.highScore > 0) {
    const pct = Math.min(100, Math.round((offer.score / offer.highScore) * 100));
    body.append(el('p', '', `최고 기록의 ${pct}%까지 왔어요`));
    const bar = el('div', 'bar');
    bar.append(el('i'));
    bar.firstChild.style.width = `${pct}%`;
    body.append(bar);
  } else {
    let left = offer.variant === 'countdown10' ? 10 : 5;
    const p = el('p', 'big', String(left));
    body.append(p);
    countdown = setInterval(() => {
      left -= 1;
      p.textContent = String(left);
      if (left <= 0) {
        clearInterval(countdown);
        reviveAnswer(false);
      }
    }, 1000);
  }
  dlg.showModal();
}

function reviveAnswer(accepted) {
  clearInterval(countdown);
  const dlg = $('revive');
  if (dlg.open) dlg.close();
  if (!accepted) {
    director.reviveResult(false);
    finishRun();
    return;
  }
  // Simulated rewarded ad: report its revenue like an ad SDK callback would.
  director.onAdShown({ format: 'rewarded', revenue: AD_PRICES[state.ad.price] });
  director.reviveResult(true);
  // Clear the three fullest rows, then deal a fresh tray (grace = boost).
  const fill = (r) => state.board.slice(r * N, r * N + N).filter(Boolean).length;
  const rows = [...Array(N).keys()].sort((a, b) => fill(b) - fill(a)).slice(0, 3);
  for (const r of rows) for (let c = 0; c < N; c++) state.board[r * N + c] = null;
  state.over = false;
  refillTray();
  toast('이어하기!');
  render();
  checkGameOver();
}

function finishRun() {
  const result = director.endRun({ score: state.score });
  $('over-score').textContent = String(result.score);
  $('over-msg').textContent = result.newBest
    ? '새 최고 기록!'
    : `최고 기록 ${result.highScore}점까지 ${result.highScore - result.score}점. 다음 판엔 넘을 수 있어요!`;
  render();
  $('over').showModal();
}

function newGame() {
  for (const id of ['over', 'revive']) if ($(id).open) $(id).close();
  clearInterval(countdown);
  state.board.fill(null);
  state.score = 0;
  state.combo = 0;
  state.over = false;
  director.startRun();
  refillTray();
  render();
}

// ---------- drag and drop ----------

let drag = null;

// Cell pitch and origin measured from the rendered cells (includes gaps and padding).
function boardGeometry() {
  const cells = $('board').children;
  const a = cells[0].getBoundingClientRect();
  const b = cells[1].getBoundingClientRect();
  return { x: a.left, y: a.top, pitch: b.left - a.left };
}

function cellSize() {
  return boardGeometry().pitch;
}

function pieceElement(piece, size) {
  const box = el('div', 'piece');
  box.style.setProperty('--s', `${size}px`);
  box.style.width = `${piece.shape.w * size}px`;
  box.style.height = `${piece.shape.h * size}px`;
  for (const [r, c] of piece.shape.cells) {
    const b = el('i');
    b.style.left = `${c * size}px`;
    b.style.top = `${r * size}px`;
    b.style.background = piece.color;
    box.append(b);
  }
  return box;
}

function dragTarget(e) {
  const { x, y, pitch: size } = boardGeometry();
  const { piece } = drag;
  const left = e.clientX - (piece.shape.w * size) / 2;
  const top = e.clientY - piece.shape.h * size - drag.lift;
  drag.el.style.transform = `translate(${left}px, ${top}px)`;
  const r = Math.round((top - y) / size);
  const c = Math.round((left - x) / size);
  return canPlace(state.board, piece.shape, r, c) ? [r, c] : null;
}

function onPointerDown(e) {
  const slotEl = e.target.closest('.slot');
  if (!slotEl || state.over || drag) return;
  const slot = Number(slotEl.dataset.slot);
  const piece = state.tray[slot];
  if (!piece) return;
  e.preventDefault();
  const size = cellSize();
  const pieceEl = pieceElement(piece, size);
  pieceEl.classList.add('dragging');
  document.body.append(pieceEl);
  drag = { slot, piece, el: pieceEl, lift: e.pointerType === 'mouse' ? -(piece.shape.h * size) / 2 : size * 1.2 };
  slotEl.classList.add('lifted');
  slotEl.setPointerCapture(e.pointerId);
  showGhost(dragTarget(e));
}

function onPointerMove(e) {
  if (drag) showGhost(dragTarget(e));
}

function onPointerUp(e) {
  if (!drag) return;
  const target = e.type === 'pointerup' ? dragTarget(e) : null;
  const { slot } = drag;
  drag.el.remove();
  drag = null;
  showGhost(null);
  if (target) place(slot, ...target);
  else renderTray();
}

function showGhost(target) {
  const cells = $('board').children;
  for (const cell of cells) cell.classList.remove('ghost');
  if (!target || !drag) return;
  const [r, c] = target;
  for (const [dr, dc] of drag.piece.shape.cells) {
    const cell = cells[(r + dr) * N + c + dc];
    cell.classList.add('ghost');
    cell.style.setProperty('--ghost', drag.piece.color);
  }
}

// ---------- rendering ----------

function el(tag, cls = '', text = '') {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function renderBoard() {
  const cells = $('board').children;
  state.board.forEach((color, i) => {
    const cell = cells[i];
    cell.classList.toggle('filled', !!color);
    cell.classList.toggle('flash', state.flash.has(i));
    cell.style.background = color || '';
  });
}

function renderTray() {
  const tray = $('tray');
  tray.replaceChildren();
  state.tray.forEach((piece, slot) => {
    const slotEl = el('div', 'slot');
    slotEl.dataset.slot = String(slot);
    if (piece) {
      const size = Math.min(22, Math.floor(tray.getBoundingClientRect().width / 3 / 5.2));
      const fits = placements(state.board, piece.shape).length > 0;
      const p = pieceElement(piece, size);
      if (!fits) slotEl.classList.add('nofit');
      slotEl.append(p);
    }
    tray.append(slotEl);
  });
}

function bar(value, cls = '') {
  const b = el('div', `bar ${cls}`);
  const i = el('i');
  i.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  b.append(i);
  return b;
}

function renderPanel() {
  const dec = director.lastDecision ?? (director.run ? director.decide() : null);
  const p = director.profile;
  const run = director.run;
  const mode = dec?.mode ?? 'normal';
  $('mode').textContent = run ? MODE_LABEL[mode] : '—';
  $('mode').dataset.mode = run ? mode : '';
  $('score').textContent = String(state.score);
  $('best').textContent = String(Math.max(p.highScore, state.score));
  $('rule').textContent = dec ? dec.rule : '—';
  $('reason').textContent = dec ? dec.reason : '판이 끝났어요';

  const avg = director.averageLength();
  $('progress-text').textContent = run
    ? `${run.turns}수 / 평균 ${avg.toFixed(1)}수 (${Math.round((dec?.progress ?? 0) * 100)}%)`
    : `평균 ${avg.toFixed(1)}수`;
  $('progress').replaceChildren(bar((dec?.progress ?? 0) / 1.5, mode));

  const secs = run ? Math.floor((Date.now() - run.startedAt) / 1000) : 0;
  $('elapsed').textContent = run
    ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` +
      (run.minuteKillAt != null ? ` · ${run.minuteKillAt}분 롤 적중` : '')
    : '—';

  const v = dec?.value;
  $('value-text').textContent = v ? `${v.score.toFixed(2)} (${{ high: '높음', mid: '중간', low: '낮음' }[v.tier]})` : '—';
  const parts = $('value-parts');
  parts.replaceChildren();
  const names = { country: '국가', device: '기기', sound: '배경음', vibration: '진동', adRevenue: '광고 수익', adHabit: '광고 시청 습관' };
  if (v) {
    for (const [k, label] of Object.entries(names)) {
      const row = el('div', 'part');
      row.append(el('span', '', label), bar(v.parts[k]));
      parts.append(row);
    }
  }

  $('guard').textContent = p.highScore
    ? `최고 ${p.highScore}점 · 이번 판 경신 ${run?.beatAllowed ? '허용' : '차단'}`
    : '아직 최고 기록 없음';
  $('ads-text').textContent =
    `노출 ${p.ads.impressions}회 · 리바이브 ${p.ads.rewardedWatched}/${p.ads.rewardedOffered} 시청 · 최근 $${p.ads.lastRevenue.toFixed(3)}`;
  $('runs').textContent = `${p.runs}판 완료`;

  const vs = $('variants');
  vs.replaceChildren();
  for (const name of director.config.revive.variants) {
    const s = p.revive.variants[name] ?? { offered: 0, accepted: 0 };
    vs.append(el('li', '', `${VARIANT_LABEL[name] ?? name}: ${s.accepted}/${s.offered}`));
  }
}

function render() {
  renderBoard();
  renderTray();
  renderPanel();
}

function logDecision(dec) {
  const log = $('log');
  const turn = director.run?.turns ?? 0;
  const li = el('li');
  li.append(el('b', `m-${dec.mode}`, MODE_LABEL[dec.mode]), document.createTextNode(` ${turn}수 · ${dec.rule}: ${dec.reason}`));
  log.prepend(li);
  while (log.children.length > 14) log.lastChild.remove();
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1100);
}

// ---------- wiring ----------

function init() {
  const board = $('board');
  for (let i = 0; i < N * N; i++) board.append(el('div', 'cell'));

  const tray = $('tray');
  tray.addEventListener('pointerdown', onPointerDown);
  tray.addEventListener('pointermove', onPointerMove);
  tray.addEventListener('pointerup', onPointerUp);
  tray.addEventListener('pointercancel', onPointerUp);

  for (const id of ['country', 'device', 'bgm', 'vibration']) {
    $(id).addEventListener('change', () => {
      director.setSignals(readSignals());
      if (director.run) director.decide();
      renderPanel();
    });
  }
  $('ad-ready').addEventListener('change', (e) => {
    state.ad.rewardedReady = e.target.checked;
    if (director.run) director.decide();
    renderPanel();
  });
  $('ad-price').addEventListener('change', (e) => {
    state.ad.price = e.target.value;
    if (director.run) director.decide();
    renderPanel();
  });
  $('ad-watch').addEventListener('click', () => {
    director.onAdShown({ format: 'interstitial', revenue: AD_PRICES[state.ad.price] });
    if (director.run) director.decide();
    toast(`광고 시청 기록 +$${AD_PRICES[state.ad.price].toFixed(3)}`);
    renderPanel();
  });
  $('preset').addEventListener('change', (e) => {
    state.preset = e.target.value;
    director = makeDirector();
    newGame();
  });
  $('new-game').addEventListener('click', () => {
    if (director.run) director.endRun({ score: state.score });
    newGame();
  });
  $('reset').addEventListener('click', () => {
    director.reset();
    $('log').replaceChildren();
    newGame();
  });
  $('revive-yes').addEventListener('click', () => reviveAnswer(true));
  $('revive-no').addEventListener('click', () => reviveAnswer(false));
  $('revive').addEventListener('cancel', (e) => e.preventDefault());
  $('again').addEventListener('click', newGame);

  setInterval(() => {
    if (!director.run || state.over) return;
    director.decide(); // lets the exact-minute rule roll on time
    renderPanel();
  }, 1000);
  window.addEventListener('resize', renderTray);

  director = makeDirector();
  newGame();
}

init();
