import { DiceTray, SKINS } from './dice.js?v=10';
import { sfx } from './sfx.js?v=10';

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
const clampHp = (hp, max) => Math.min(max, Math.max(0, hp));

const defaults = () => ({
  title: 'The Table',
  players: [1, 2, 3].map((n) => ({ id: uid(), name: `Player ${n}`, hp: 10, max: 10, notes: '' })),
  history: [],
  skin: 'classic',
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
  sfx.unlock();
  sfx.heal();
});

const soundBtn = $('#sound');
const renderSound = () => {
  soundBtn.textContent = sfx.enabled ? 'Sound on' : 'Sound off';
  soundBtn.classList.toggle('off', !sfx.enabled);
};
soundBtn.addEventListener('click', () => {
  sfx.enabled = !sfx.enabled;
  sfx.unlock();
  renderSound();
});
renderSound();

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

  /** Add delta to HP (clamped to 0…max), with effects. */
  const change = (delta) => {
    const before = p.hp;
    p.hp = clampHp(p.hp + delta, p.max);
    const diff = p.hp - before;
    if (diff) float(`${diff > 0 ? '+' : '−'}${Math.abs(diff)}`, diff > 0 ? 'heal' : 'dmg');
    sfx.unlock();
    if (diff < 0) {
      if (p.hp === 0) {
        splash('down', p.name);
        sfx.down();
      } else if (-diff >= Math.max(5, Math.ceil(p.max * 0.2))) {
        splash('dmg', p.name, -diff);
        sfx.hit(1);
      } else sfx.hit(0.45);
    } else if (diff > 0) sfx.heal();
    refresh();
    save();
  };

  // An empty box means 1; an explicit 0 means nothing.
  const typed = () => (amt.value.trim() === '' ? 1 : Math.abs(parseInt(amt.value, 10)) || 0);
  const fromBox = (sign) => {
    change(sign * typed());
    amt.value = '';
  };

  name.addEventListener('input', () => { p.name = name.value; save(); });
  cur.addEventListener('change', () => { p.hp = clampHp(parseInt(cur.value, 10) || 0, p.max); refresh(); save(); });
  max.addEventListener('change', () => {
    p.max = Math.max(1, parseInt(max.value, 10) || 1);
    p.hp = clampHp(p.hp, p.max);
    refresh();
    save();
  });
  $('.hit', el).addEventListener('click', () => fromBox(-1));
  $('.heal', el).addEventListener('click', () => fromBox(1));
  amt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fromBox(e.shiftKey ? 1 : -1);
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

/* ---------- Tray effects ---------- */

const trayEl = $('#tray');

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function flash(kind) {
  const f = $('#flash');
  f.dataset.kind = kind;
  restartAnim(f, 'go');
}

function splash(kind, name, amount) {
  trayEl.querySelector('.splash')?.remove();
  const el = document.createElement('div');
  el.className = `splash ${kind}`;
  el.innerHTML = '<div class="splash-num"></div><div class="splash-name"></div>';
  $('.splash-num', el).textContent = kind === 'down' ? 'Down!' : `−${amount}`;
  $('.splash-name', el).textContent = name || 'Player';
  el.addEventListener('animationend', (e) => {
    if (e.animationName === 'splash-out') el.remove();
  });
  trayEl.appendChild(el);
  restartAnim(trayEl, 'shake');
  flash('dmg');
}

/* ---------- Dice ---------- */

const tray = new DiceTray(trayEl, {
  onImpact: (speed, kind) => sfx.clack(speed, kind),
  onThrow: (strength) => sfx.whoosh(strength),
  // Each die is scored the moment it lands; a pair (d100, advantage) once both have.
  onSettle: (d) => {
    if (d.group.dice.every((x) => x.state === 'done')) groupRolled(d.group);
  },
  onHype: (on) => {
    trayEl.classList.toggle('hype', on);
    if (on) sfx.slowmo();
  },
});
tray.setSkin(state.skin);

const skinBtn = $('#skin');
const renderSkin = () => {
  const s = SKINS[tray.skin];
  skinBtn.querySelector('span').textContent = s.label;
  skinBtn.style.setProperty('--swatch', s.swatch);
};
skinBtn.addEventListener('click', () => {
  const names = Object.keys(SKINS);
  state.skin = names[(names.indexOf(tray.skin) + 1) % names.length];
  tray.setSkin(state.skin);
  save();
  renderSkin();
  sfx.unlock();
  sfx.clack(8, 'dice');
});
renderSkin();

let fontsLoaded = false;
const fontsReady = document.fonts
  .load('100px Anton')
  .catch(() => {})
  .then(() => (fontsLoaded = true));

let adv = null;
let clearGen = 0; // bumped by Clear
// The current roll: dice groups sitting on / thrown across the table. A group is one die, or the two
// dice that make one roll (d100 tens+ones, or a d20 with advantage). state: staged → held → rolling → done.
let set = null;
let lastBang = 0;
const modEl = $('#mod');
const buttonsEl = $('#dice-buttons');
const resultEl = $('#result');

for (const s of ORDER) {
  const b = document.createElement('button');
  b.className = 'die-btn';
  b.dataset.sides = s;
  b.title = `d${s} — click to put one on the table, right-click to take one back`;
  b.innerHTML = `<svg viewBox="0 0 48 48">${ICONS[s]}</svg><span>d${s}</span><b class="count"></b>`;
  b.addEventListener('click', () => addDie(s));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); removeDie(s); });
  buttonsEl.appendChild(b);
}

const getMod = () => parseInt(modEl.value, 10) || 0;
const liveSet = () => (set && !set.done ? set : null);
const started = (s) => s.groups.some((g) => g.state !== 'staged');

function newSet() {
  tray.clear();
  resultEl.classList.remove('show');
  return (set = { groups: [], adv, done: false });
}

function specsFor(sides) {
  if (sides === 100) return [{ sides: 10, tens: true }, { sides: 10 }];
  if (sides === 20 && adv) return [{ sides: 20 }, { sides: 20 }];
  return [{ sides }];
}

function addDie(sides) {
  if (!fontsLoaded) {
    // Still loading the dice font: add it once that's done, unless the table was cleared meanwhile.
    const gen = clearGen;
    return void fontsReady.then(() => gen === clearGen && addDie(sides));
  }
  sfx.unlock();
  const s = liveSet() ?? newSet();
  const specs = specsFor(sides);
  if (s.groups.reduce((n, g) => n + g.dice.length, 0) + specs.length > MAX_DICE) return;
  const g = { sides, state: 'staged', dice: [] };
  g.dice = specs.map((spec) => Object.assign(tray.stage(spec), { group: g }));
  s.groups.push(g);
  renderPool();
}

function removeGroup(g) {
  g.dice.forEach((d) => tray.remove(d));
  set.groups = set.groups.filter((x) => x !== g);
  if (!set.groups.length) {
    set = null;
    resultEl.classList.remove('show');
  } else if (set.groups.every((x) => x.state === 'done')) finishSet();
  renderPool();
}

function removeDie(sides) {
  const g = liveSet()?.groups.findLast((x) => x.sides === sides && x.state === 'staged');
  if (g) removeGroup(g);
}

function toggleAdv(mode) {
  const s = liveSet();
  if (s && started(s)) return; // locked once this roll has begun
  adv = adv === mode ? null : mode;
  if (s) {
    s.adv = adv;
    // Give every d20 on the table a partner die (or take it away).
    for (const g of s.groups.filter((x) => x.sides === 20)) {
      const want = adv ? 2 : 1;
      while (g.dice.length > want) tray.remove(g.dice.pop());
      while (g.dice.length < want) g.dice.push(Object.assign(tray.stage({ sides: 20 }), { group: g }));
    }
  }
  if (adv && fontsLoaded && !s?.groups.some((x) => x.sides === 20)) addDie(20);
  else renderPool();
}

function exprOf(counts, mod, advMode) {
  const parts = ORDER.filter((s) => counts[s]).map((s) => `${counts[s]}d${s}`);
  let e = parts.join(' + ') || '1d20';
  if (mod) e += ` ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}`;
  if (advMode) e += advMode === 'adv' ? ' · ADV' : ' · DIS';
  return e;
}

function countsOf(s) {
  const c = {};
  s?.groups.forEach((g) => (c[g.sides] = (c[g.sides] || 0) + 1));
  return c;
}

function renderPool() {
  const s = liveSet();
  const counts = countsOf(s);
  for (const b of buttonsEl.children) {
    const c = counts[b.dataset.sides] || 0;
    b.querySelector('.count').textContent = c ? `×${c}` : '';
    b.classList.toggle('active', c > 0);
  }
  const el = $('#pool-expr');
  const hasD20 = !s || counts[20];
  el.textContent = exprOf(counts, getMod(), hasD20 ? adv : null);
  el.classList.toggle('placeholder', !s);
  $('#adv').classList.toggle('on', adv === 'adv');
  $('#dis').classList.toggle('on', adv === 'dis');
  const locked = !!s && started(s);
  $('#adv').classList.toggle('locked', locked);
  $('#dis').classList.toggle('locked', locked);
  const staged = s ? s.groups.filter((g) => g.state === 'staged').length : 0;
  $('#roll').textContent = s && started(s) && staged ? 'Roll rest' : 'Roll';
  $('.hint', trayEl).classList.toggle('gone', !!set);
}

$('#clear-pool').addEventListener('click', () => {
  clearGen++;
  tray.clear();
  set = null;
  held = null;
  adv = null;
  modEl.value = 0;
  resultEl.classList.remove('show');
  document.body.classList.remove('holding');
  renderPool();
});
document.querySelectorAll('[data-mod]').forEach((b) =>
  b.addEventListener('click', () => {
    modEl.value = getMod() + Number(b.dataset.mod);
    onModChange();
  })
);
function onModChange() {
  renderPool();
  if (liveSet() && started(set)) showProgress();
}
modEl.addEventListener('input', onModChange);
$('#adv').addEventListener('click', () => toggleAdv('adv'));
$('#dis').addEventListener('click', () => toggleAdv('dis'));
$('#roll').addEventListener('click', roll);

// Keep buttons from holding focus, so Space/Enter always means "roll" rather than re-clicking ADV etc.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  // A keyboard-focused button keeps its own Enter/Space.
  if (e.target.closest('input, textarea, button') || e.repeat) return;
  if (e.code === 'Space' || e.key === 'Enter') {
    e.preventDefault();
    roll();
  }
});

/** Roll everything still waiting on the table (or a d20 if the table is empty). */
function roll() {
  if (!fontsLoaded) return;
  sfx.unlock();
  if (!liveSet()) {
    newSet();
    addDie(20);
  }
  const groups = set.groups.filter((g) => g.state === 'staged');
  if (!groups.length) return;
  groups.forEach((g) => (g.state = 'rolling'));
  renderPool();
  tray.toss(groups.flatMap((g) => g.dice));
}

// Throw by hand: press on any waiting die to scoop up all of them (Shift: just that one), drag, let go.
let held = null; // groups in the hand
trayEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || held) return;
  const d = tray.pick(e.clientX, e.clientY);
  if (!d) return;
  sfx.unlock();
  held = e.shiftKey ? [d.group] : set.groups.filter((g) => g.state === 'staged');
  held.forEach((g) => (g.state = 'held'));
  try {
    trayEl.setPointerCapture(e.pointerId);
  } catch {}
  document.body.classList.add('holding');
  tray.grab(held.flatMap((g) => g.dice), e.clientX, e.clientY);
  renderPool();
});
trayEl.addEventListener('pointermove', (e) => {
  if (held) tray.moveHand(e.clientX, e.clientY);
  else trayEl.classList.toggle('can-grab', !!tray.pick(e.clientX, e.clientY));
});
const letGo = () => {
  if (!held) return;
  held.forEach((g) => (g.state = 'rolling'));
  held = null;
  document.body.classList.remove('holding');
  renderPool();
  tray.release();
};
trayEl.addEventListener('pointerup', letGo);
trayEl.addEventListener('pointercancel', letGo);
trayEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const d = tray.pick(e.clientX, e.clientY);
  if (d && d.group.state === 'staged') removeGroup(d.group);
});

/** A group's dice have landed: score it, fire crit/fumble effects, and update the running total. */
function groupRolled(g) {
  if (!set || set.done || !set.groups.includes(g) || g.state === 'done') return; // table was cleared meanwhile
  const [a, b] = g.dice.map((d) => d.value);
  let kept = g.dice[0];
  if (g.sides === 100) g.value = (a % 10) * 10 + (b % 10) || 100;
  else if (b !== undefined) {
    g.value = set.adv === 'adv' ? Math.max(a, b) : Math.min(a, b);
    g.pair = [a, b];
    if (a !== g.value) kept = g.dice[1];
    tray.mark(kept === g.dice[0] ? g.dice[1] : g.dice[0], 'dropped');
  } else g.value = a;
  g.state = 'done';

  if (g.sides === 20 && (g.value === 20 || g.value === 1)) {
    g.tag = g.value === 20 ? 'crit' : 'fumble';
    tray.mark(kept, g.tag);
    // Several crits landing together get one fanfare, not a pile-up.
    if (performance.now() - lastBang > 300) {
      lastBang = performance.now();
      g.tag === 'crit' ? sfx.crit() : sfx.fumble();
      flash(g.tag);
      restartAnim(trayEl, 'shake');
    }
  }

  if (set.groups.every((x) => x.state === 'done')) finishSet();
  else showProgress();
  renderPool();
}

function breakdownHtml(s, mod) {
  const bySides = ORDER.map((x) => s.groups.filter((g) => g.sides === x)).filter((a) => a.length);
  const html = bySides
    .map((gs) => {
      const vs = gs.map((g) => {
        if (g.state !== 'done') return '<i class="pending">?</i>';
        if (g.pair) return `${g.value} <s>${g.pair[0] === g.value ? g.pair[1] : g.pair[0]}</s>`;
        return String(g.value);
      });
      return `<span class="part"><em>${gs.length}d${gs[0].sides}</em> ${vs.join(', ')}</span>`;
    })
    .join('<span class="dot">·</span>');
  return html + (mod ? `<span class="dot">·</span><em>mod</em> ${mod > 0 ? '+' : '−'}${Math.abs(mod)}` : '');
}

const doneSum = (s) => s.groups.filter((g) => g.state === 'done').reduce((n, g) => n + g.value, 0);

function showProgress() {
  const done = set.groups.filter((g) => g.state === 'done').length;
  const mod = getMod();
  showResult(doneSum(set) + mod, breakdownHtml(set, mod), `Rolling · ${done} of ${set.groups.length}`, 'partial');
}

function finishSet() {
  const s = set;
  s.done = true;
  const mod = getMod();
  const total = doneSum(s) + mod;
  const tag = s.groups.some((g) => g.tag === 'crit') ? 'crit' : s.groups.some((g) => g.tag === 'fumble') ? 'fumble' : '';
  const advMode = s.groups.some((g) => g.pair) ? s.adv : null;
  const label =
    tag === 'crit' ? 'Natural 20!' : tag === 'fumble' ? 'Natural 1' : advMode === 'adv' ? 'Advantage' : advMode === 'dis' ? 'Disadvantage' : 'Total';
  showResult(total, breakdownHtml(s, mod), label, tag);

  state.history.unshift({ expr: exprOf(countsOf(s), mod, advMode), total, tag, t: Date.now() });
  state.history.length = Math.min(state.history.length, 40);
  save();
  renderHistory();

  adv = null;
  modEl.value = 0;
  renderPool();
}

let shownTotal = 0;
let countToken = 0;
function countUp(el, from, to) {
  const start = performance.now(), dur = 350;
  const token = ++countToken; // a newer count takes over from this one
  const step = (now) => {
    if (token !== countToken) return;
    const t = Math.min(1, (now - start) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showResult(total, breakdown, label, tag) {
  const totalEl = $('.result-total', resultEl);
  const fresh = !resultEl.classList.contains('show');
  countUp(totalEl, fresh ? 0 : shownTotal, total);
  shownTotal = total;
  $('.result-break', resultEl).innerHTML = breakdown;
  $('.result-tag', resultEl).textContent = label;
  resultEl.dataset.tag = tag;
  if (fresh) {
    void resultEl.offsetWidth;
    resultEl.classList.add('show');
  } else restartAnim(totalEl, 'bump');
}

function renderHistory() {
  const ol = $('#history');
  ol.replaceChildren(
    ...state.history.slice(0, 6).map((h) => {
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
