import { DiceTray } from './dice.js';

const KEY = 'the-table-v1';
const ORDER = [4, 6, 8, 10, 12, 20, 100];
const MAX_DICE = 30;

const ICONS = {
  4: '<polygon points="24,5 44,40 4,40"/>',
  6: '<rect x="7" y="7" width="34" height="34" rx="4"/>',
  8: '<polygon points="24,3 44,24 24,45 4,24"/><line x1="4" y1="24" x2="44" y2="24"/>',
  10: '<polygon points="24,3 44,20 24,45 4,20"/><polyline points="4,20 24,28 44,20"/><line x1="24" y1="28" x2="24" y2="45"/>',
  12: '<polygon points="24,3 45,18 37,43 11,43 3,18"/><polygon points="24,13 34,21 30,33 18,33 14,21"/>',
  20: '<polygon points="24,2 44,13 44,35 24,46 4,35 4,13"/><polygon points="24,12 36,32 12,32"/>',
  100: '<polygon points="15,6 27,16 15,40 3,16"/><polygon points="33,8 45,18 33,42 21,18"/>',
};

const $ = (s, el = document) => el.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);

const defaults = () => ({
  title: 'The Table',
  players: [1, 2, 3].map((n) => ({ id: uid(), name: `Player ${n}`, hp: 10, max: 10, notes: '' })),
  history: [],
});

function load() {
  try {
    return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY)) };
  } catch {
    return defaults();
  }
}

const state = load();
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 150);
}

/* ---------- Header ---------- */

const titleEl = $('#title');
titleEl.value = state.title;
titleEl.addEventListener('input', () => {
  state.title = titleEl.value;
  document.title = `${state.title || 'The Table'} — D&D`;
  save();
});
document.title = `${state.title || 'The Table'} — D&D`;

$('#long-rest').addEventListener('click', () => {
  if (!confirm('Long rest: restore everyone to full HP?')) return;
  state.players.forEach((p) => (p.hp = p.max));
  save();
  renderParty();
});

/* ---------- Party ---------- */

const partyEl = $('#party-list');
const tpl = $('#player-tpl');

function renderParty() {
  partyEl.replaceChildren(...state.players.map(playerCard));
}

function playerCard(p) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const name = $('.p-name', el), cur = $('.hp-cur', el), max = $('.hp-max', el);
  const amt = $('.amt', el), notes = $('.notes', el);

  name.value = p.name;
  notes.value = p.notes;

  const refresh = () => {
    cur.value = p.hp;
    max.value = p.max;
    const pct = Math.max(0, Math.min(1, p.hp / p.max));
    const bar = $('.bar i', el);
    bar.style.width = `${pct * 100}%`;
    el.dataset.level = p.hp <= 0 ? 'down' : pct <= 0.25 ? 'crit' : pct <= 0.5 ? 'hurt' : 'ok';
  };
  refresh();

  const float = (text, cls) => {
    const f = document.createElement('span');
    f.className = `float ${cls}`;
    f.textContent = text;
    $('.hp', el).appendChild(f);
    f.addEventListener('animationend', () => f.remove());
    el.classList.remove('flash-hit', 'flash-heal');
    void el.offsetWidth;
    el.classList.add(cls === 'dmg' ? 'flash-hit' : 'flash-heal');
  };

  const change = (sign) => {
    const n = Math.abs(parseInt(amt.value, 10)) || 1;
    const before = p.hp;
    p.hp = sign < 0 ? Math.max(0, p.hp - n) : Math.min(p.max, Math.max(0, p.hp) + n);
    amt.value = '';
    const diff = p.hp - before;
    if (diff) float(`${diff > 0 ? '+' : '−'}${Math.abs(diff)}`, diff > 0 ? 'heal' : 'dmg');
    refresh();
    save();
  };

  name.addEventListener('input', () => { p.name = name.value; save(); });
  cur.addEventListener('change', () => { p.hp = parseInt(cur.value, 10) || 0; refresh(); save(); });
  max.addEventListener('change', () => { p.max = Math.max(1, parseInt(max.value, 10) || 1); refresh(); save(); });
  $('.hit', el).addEventListener('click', () => change(-1));
  $('.heal', el).addEventListener('click', () => change(1));
  amt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') change(e.shiftKey ? 1 : -1);
  });

  const grow = () => {
    notes.style.height = 'auto';
    notes.style.height = `${notes.scrollHeight + 2}px`;
  };
  notes.addEventListener('input', () => { p.notes = notes.value; grow(); save(); });
  requestAnimationFrame(grow);

  $('.p-del', el).addEventListener('click', () => {
    if (!confirm(`Remove ${p.name || 'this player'}?`)) return;
    state.players = state.players.filter((x) => x !== p);
    save();
    renderParty();
  });
  return el;
}

$('#add-player').addEventListener('click', () => {
  const p = { id: uid(), name: `Player ${state.players.length + 1}`, hp: 10, max: 10, notes: '' };
  state.players.push(p);
  save();
  renderParty();
  const input = partyEl.lastElementChild?.querySelector('.p-name');
  input?.focus();
  input?.select();
});

renderParty();

/* ---------- Dice ---------- */

const tray = new DiceTray($('#tray'));
const fontsReady = document.fonts.load('100px Anton').catch(() => {});

let pool = {};
let adv = null;
let rolling = false;
const modEl = $('#mod');
const buttonsEl = $('#dice-buttons');

for (const s of ORDER) {
  const b = document.createElement('button');
  b.className = 'die-btn';
  b.dataset.sides = s;
  b.title = `d${s} — click to add, right-click to remove`;
  b.innerHTML = `<svg viewBox="0 0 48 48">${ICONS[s]}</svg><span>d${s}</span><b class="count"></b>`;
  b.addEventListener('click', () => addDie(s, 1));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); addDie(s, -1); });
  buttonsEl.appendChild(b);
}

const diceCount = (p) => Object.entries(p).reduce((n, [s, c]) => n + c * (s === '100' ? 2 : 1), 0);

function addDie(s, d) {
  const next = Math.max(0, (pool[s] || 0) + d);
  if (d > 0 && diceCount(pool) + (s === 100 ? 2 : 1) > MAX_DICE) return;
  pool[s] = next;
  if (!next) delete pool[s];
  // Removing the last d20 from a mixed pool leaves nothing for ADV/DIS to act on.
  if (s === 20 && !next && Object.keys(pool).length) adv = null;
  renderPool();
}

function toggleAdv(mode) {
  adv = adv === mode ? null : mode;
  if (adv && Object.keys(pool).length && !pool[20]) addDie(20, 1);
  else renderPool();
}

const getMod = () => parseInt(modEl.value, 10) || 0;

function exprOf(p, mod, advMode) {
  const parts = ORDER.filter((s) => p[s]).map((s) => `${p[s]}d${s}`);
  let e = parts.join(' + ') || '1d20';
  if (mod) e += ` ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}`;
  if (advMode) e += advMode === 'adv' ? ' · ADV' : ' · DIS';
  return e;
}

// ADV/DIS doubles every d20 in the roll (an empty pool means a plain d20).
function advApplies(p) {
  return adv && (!Object.keys(p).length || p[20]) ? adv : null;
}

function renderPool() {
  for (const b of buttonsEl.children) {
    const c = pool[b.dataset.sides] || 0;
    b.querySelector('.count').textContent = c ? `×${c}` : '';
    b.classList.toggle('active', c > 0);
  }
  const empty = !Object.keys(pool).length;
  const el = $('#pool-expr');
  el.textContent = exprOf(pool, getMod(), advApplies(pool));
  el.classList.toggle('placeholder', empty);
  $('#adv').classList.toggle('on', adv === 'adv');
  $('#dis').classList.toggle('on', adv === 'dis');
}

$('#clear-pool').addEventListener('click', () => {
  pool = {};
  adv = null;
  modEl.value = 0;
  renderPool();
});
document.querySelectorAll('[data-mod]').forEach((b) =>
  b.addEventListener('click', () => {
    modEl.value = getMod() + Number(b.dataset.mod);
    renderPool();
  })
);
modEl.addEventListener('input', renderPool);
$('#adv').addEventListener('click', () => toggleAdv('adv'));
$('#dis').addEventListener('click', () => toggleAdv('dis'));
$('#roll').addEventListener('click', roll);

// Keep buttons from holding focus, so Space/Enter always means "roll" rather than re-clicking ADV etc.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.repeat) return;
  if (e.code === 'Space' || e.key === 'Enter') {
    e.preventDefault();
    roll();
  }
});

const resultEl = $('#result');

async function roll() {
  if (rolling) return;
  rolling = true;
  document.body.classList.add('rolling');
  resultEl.classList.remove('show');

  const p = Object.keys(pool).length ? { ...pool } : { 20: 1 };
  const mod = getMod();
  const advMode = advApplies(pool);
  const expr = exprOf(p, mod, advMode);

  // Clear the selection now, so the next roll can be set up while these dice are still tumbling.
  pool = {};
  adv = null;
  modEl.value = 0;
  renderPool();

  const specs = [];
  const groups = [];
  for (const s of ORDER) {
    for (let i = 0; i < (p[s] || 0); i++) {
      const g = { sides: s, idx: [] };
      if (s === 100) g.idx.push(specs.push({ sides: 10, tens: true }) - 1, specs.push({ sides: 10 }) - 1);
      else if (s === 20 && advMode) g.idx.push(specs.push({ sides: 20 }) - 1, specs.push({ sides: 20 }) - 1);
      else g.idx.push(specs.push({ sides: s }) - 1);
      groups.push(g);
    }
  }

  await fontsReady;
  const vals = await tray.roll(specs);

  let sum = 0;
  for (const g of groups) {
    const [a, b] = g.idx.map((i) => vals[i]);
    if (g.sides === 100) g.value = (a % 10) * 10 + (b % 10) || 100;
    else if (b !== undefined) {
      g.value = advMode === 'adv' ? Math.max(a, b) : Math.min(a, b);
      g.pair = [a, b];
    } else g.value = a;
    sum += g.value;
  }
  const total = sum + mod;

  let tag = '';
  if (groups.length === 1 && groups[0].sides === 20) {
    if (groups[0].value === 20) tag = 'crit';
    if (groups[0].value === 1) tag = 'fumble';
  }

  const bySides = ORDER.map((s) => groups.filter((g) => g.sides === s)).filter((a) => a.length);
  const breakdown = bySides
    .map((gs) => {
      const vs = gs.map((g) =>
        g.pair ? `${g.value} <s>${g.pair[0] === g.value ? g.pair[1] : g.pair[0]}</s>` : String(g.value)
      );
      return `<span class="part"><em>${gs.length}d${gs[0].sides}</em> ${vs.join(', ')}</span>`;
    })
    .join('<span class="dot">·</span>');
  const modHtml = mod ? `<span class="dot">·</span><em>mod</em> ${mod > 0 ? '+' : '−'}${Math.abs(mod)}` : '';

  showResult(total, breakdown + modHtml, tag, advMode);

  state.history.unshift({ expr, total, tag, t: Date.now() });
  state.history.length = Math.min(state.history.length, 40);
  save();
  renderHistory();

  rolling = false;
  document.body.classList.remove('rolling');
}

function showResult(total, breakdown, tag, advMode) {
  $('.result-total', resultEl).textContent = total;
  $('.result-break', resultEl).innerHTML = breakdown;
  const label = tag === 'crit' ? 'Natural 20!' : tag === 'fumble' ? 'Natural 1' : advMode === 'adv' ? 'Advantage' : advMode === 'dis' ? 'Disadvantage' : 'Total';
  $('.result-tag', resultEl).textContent = label;
  resultEl.dataset.tag = tag;
  void resultEl.offsetWidth;
  resultEl.classList.add('show');
}

function renderHistory() {
  const ol = $('#history');
  ol.replaceChildren(
    ...state.history.slice(0, 12).map((h) => {
      const li = document.createElement('li');
      li.dataset.tag = h.tag || '';
      const e = document.createElement('span');
      e.textContent = h.expr;
      const t = document.createElement('b');
      t.textContent = h.total;
      li.append(e, t);
      return li;
    })
  );
}

renderPool();
renderHistory();
