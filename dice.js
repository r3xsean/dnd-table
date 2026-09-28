import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const PHI = (1 + Math.sqrt(5)) / 2;
const D10_H = 1.15;
const CELL = 256;

// Raw vertex sets; faces are derived from the convex hull so every die is built the same way.
const RAW = {
  4: () => [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  6: () => {
    const v = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
    return v;
  },
  8: () => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
  10: () => {
    // Pentagonal trapezohedron: belt height chosen so each kite face is planar.
    const c = Math.cos(Math.PI / 5);
    const z0 = (D10_H * (1 - c)) / (1 + c);
    const v = [[0, D10_H, 0], [0, -D10_H, 0]];
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5;
      v.push([Math.cos(a), i % 2 ? -z0 : z0, Math.sin(a)]);
    }
    return v;
  },
  12: () => {
    const v = [];
    const p = PHI, q = 1 / PHI;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      v.push([0, a * q, b * p], [a * q, b * p, 0], [a * p, 0, b * q]);
    }
    return v;
  },
  20: () => {
    const v = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      v.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
    }
    return v;
  },
};

// Circumradius per die, in world units.
const SIZE = { 4: 1.5, 6: 1.1, 8: 1.3, 10: 1.25, 12: 1.3, 20: 1.35 };
const LABEL_SIZE = { 6: 0.52, 8: 0.36, 10: 0.36, 12: 0.4, 20: 0.3 };
const LABEL_DY = { 8: -0.03, 10: -0.07, 20: -0.02 };

// Dice finishes. `tens` is the contrasting die that reads the tens digit of a d100.
export const SKINS = {
  classic: {
    label: 'Classic', swatch: '#e0263b', trail: 0xff5a3c,
    normal: { body: '#e0263b', edge: 0x5a0712, ink: '#ffffff' },
    tens: { body: '#17171d', edge: 0x000000, ink: '#ffd23f' },
  },
  ruby: {
    label: 'Ruby', swatch: '#9a0b28', trail: 0xff2d55, gloss: true,
    normal: { body: '#8f0a24', edge: 0x2a0008, ink: '#ffd98a' },
    tens: { body: '#efe4cc', edge: 0x6b4b1a, ink: '#8f0a24' },
  },
  obsidian: {
    label: 'Obsidian', swatch: '#1b1822', trail: 0xffc83d, gloss: true,
    normal: { body: '#0d0b11', edge: 0x000000, ink: '#ffd23f' },
    tens: { body: '#6b1022', edge: 0x1a0005, ink: '#ffffff' },
  },
  steel: {
    label: 'Steel', swatch: '#b9bcc4', trail: 0xbfe3ff, metal: true,
    normal: { body: '#aeb2bb', edge: 0x2b2d33, ink: '#17181c' },
    tens: { body: '#c9a24a', edge: 0x3a2c0c, ink: '#17181c' },
  },
};

function findFaces(V) {
  const faces = [];
  const n = V.length;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const normal = a.subVectors(V[j], V[i]).clone().cross(b.subVectors(V[k], V[i]));
    if (normal.lengthSq() < 1e-8) continue;
    normal.normalize();
    let d = normal.dot(V[i]);
    if (d < 0) { normal.negate(); d = -d; }
    if (faces.some((f) => f.normal.dot(normal) > 1 - 1e-6)) continue;
    const on = [];
    let ok = true;
    for (let m = 0; m < n; m++) {
      const s = normal.dot(V[m]) - d;
      if (s > 1e-5) { ok = false; break; }
      if (s > -1e-5) on.push(m);
    }
    if (!ok) continue;
    const center = new THREE.Vector3();
    on.forEach((m) => center.add(V[m]));
    center.divideScalar(on.length);
    const u = V[on[0]].clone().sub(center).normalize();
    const w = normal.clone().cross(u);
    const ang = (m) => {
      const p = V[m].clone().sub(center);
      return Math.atan2(p.dot(w), p.dot(u));
    };
    on.sort((x, y) => ang(x) - ang(y)); // counter-clockwise seen from outside
    faces.push({ idx: on, normal, center });
  }
  return faces;
}

const defs = {};
function getDef(sides) {
  if (defs[sides]) return defs[sides];
  const raw = RAW[sides]();
  const maxLen = Math.max(...raw.map((v) => Math.hypot(...v)));
  const s = SIZE[sides] / maxLen;
  const verts = raw.map((v) => new THREE.Vector3(v[0] * s, v[1] * s, v[2] * s));
  const faces = findFaces(verts);

  // Opposite faces sum to n+1, like real dice. (d4 is read from its top vertex instead.)
  if (sides !== 4) {
    const n = faces.length, used = new Set();
    let k = 0;
    faces.forEach((f, i) => {
      if (used.has(i)) return;
      const j = faces.findIndex((g, jj) => !used.has(jj) && jj !== i && g.normal.dot(f.normal) < -0.999);
      let lo = k + 1, hi = n - k;
      if (k % 2) [lo, hi] = [hi, lo];
      f.value = lo;
      faces[j].value = hi;
      used.add(i).add(j);
      k++;
    });
  }

  let maxR = 0;
  faces.forEach((f) => f.idx.forEach((i) => (maxR = Math.max(maxR, verts[i].distanceTo(f.center)))));
  faces.forEach((f) => {
    let up;
    if (sides === 6) {
      up = verts[f.idx[0]].clone().add(verts[f.idx[1]]).multiplyScalar(0.5).sub(f.center);
    } else {
      let best = -1;
      f.idx.forEach((i) => {
        const d = verts[i].distanceTo(f.center);
        if (d > best + 1e-6) { best = d; up = verts[i].clone().sub(f.center); }
      });
    }
    up.normalize();
    const right = up.clone().cross(f.normal).normalize();
    f.up = up; // the direction the face's label reads upright
    f.right = right;
    // 2D coords of each vertex relative to the texture cell center (cell units, y up)
    f.local = f.idx.map((i) => {
      const p = verts[i].clone().sub(f.center);
      return [(p.dot(right) / maxR) * 0.47, (p.dot(up) / maxR) * 0.47];
    });
  });

  return (defs[sides] = { sides, verts, faces });
}

function drawLabel(ctx, text, x, y, angle, size, color, underline) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.font = `${size}px Anton, Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  const h = m.actualBoundingBoxAscent;
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.1;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeText(text, 0, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, h / 2);
  if (underline) ctx.fillRect(-m.width / 2, h / 2 + size * 0.07, m.width, size * 0.08);
  ctx.restore();
}

let envMap = null; // reflections for the shiny finishes; built once the renderer exists

// Geometry and texture layout per die shape (shared by every finish).
const shapes = {};
function getShape(sides) {
  if (shapes[sides]) return shapes[sides];
  const def = getDef(sides);
  const n = def.faces.length;
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const toCanvas = (fi, [x, y]) => [((fi % cols) + 0.5 + x) * CELL, (Math.floor(fi / cols) + 0.5 - y) * CELL];

  const pos = [], nor = [], uv = [];
  def.faces.forEach((f, fi) => {
    const uvs = f.local.map((p) => {
      const [cx, cy] = toCanvas(fi, p);
      return [cx / (cols * CELL), 1 - cy / (rows * CELL)];
    });
    const P = f.idx.map((i) => def.verts[i]);
    for (let t = 1; t < P.length - 1; t++) {
      for (const m of [0, t, t + 1]) {
        pos.push(P[m].x, P[m].y, P[m].z);
        nor.push(f.normal.x, f.normal.y, f.normal.z);
        uv.push(...uvs[m]);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const edges = new THREE.EdgesGeometry(geometry, 1);
  return (shapes[sides] = { def, geometry, edges, cols, rows, toCanvas });
}

const kinds = {};
function getKind(sides, variant, skinName) {
  const key = `${sides}-${variant}-${skinName}`;
  if (kinds[key]) return kinds[key];
  const { def, geometry, edges, cols, rows, toCanvas } = getShape(sides);
  const skin = SKINS[skinName];
  const theme = skin[variant];
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = theme.body;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  def.faces.forEach((f, fi) => {
    if (sides === 4) {
      f.idx.forEach((vi, k) => {
        const [x, y] = f.local[k];
        const [cx, cy] = toCanvas(fi, [x * 0.58, y * 0.58]);
        drawLabel(ctx, String(vi + 1), cx, cy, Math.atan2(x, y), CELL * 0.19, theme.ink, false);
      });
      return;
    }
    let label = String(f.value);
    let size = LABEL_SIZE[sides];
    if (sides === 10) {
      label = variant === 'tens' ? String((f.value % 10) * 10).padStart(2, '0') : String(f.value % 10);
      if (variant === 'tens') size = 0.3;
    }
    const [cx, cy] = toCanvas(fi, [0, LABEL_DY[sides] || 0]);
    const underline = sides >= 10 && (label === '6' || label === '9');
    drawLabel(ctx, label, cx, cy, 0, size * CELL, theme.ink, underline);
  });

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  let material;
  if (skin.metal) {
    material = new THREE.MeshStandardMaterial({ map, roughness: 0.25, metalness: 1, envMap, envMapIntensity: 0.75 });
  } else if (skin.gloss) {
    // Keep reflections faint: seen from above, the environment's bright ceiling washes the colour out.
    material = new THREE.MeshPhysicalMaterial({
      map, roughness: 0.35, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.08, envMap, envMapIntensity: 0.18,
    });
  } else {
    material = new THREE.MeshStandardMaterial({ map, roughness: 0.35, metalness: 0.05 });
  }
  const edgeMat = new THREE.LineBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.6 });
  return (kinds[key] = { def, geometry, edges, material, edgeMat });
}

const tmpV = new THREE.Vector3();

/** Which number is up, whether it's lying flat, and how high its lowest corner is off the floor. */
function readDie(die) {
  const q = die.mesh.quaternion;
  const { def } = die;
  let low = Infinity;
  for (const v of def.verts) low = Math.min(low, tmpV.copy(v).applyQuaternion(q).y);
  const bottom = die.mesh.position.y + low;
  if (def.sides === 4) {
    let best = -Infinity, value = 1;
    def.verts.forEach((v, i) => {
      const y = tmpV.copy(v).applyQuaternion(q).y;
      if (y > best) { best = y; value = i + 1; }
    });
    const flat = def.faces.some((f) => tmpV.copy(f.normal).applyQuaternion(q).y < -0.97);
    return { value, flat, bottom, top: flat ? 1 : 0 };
  }
  let best = -Infinity, value = 1;
  def.faces.forEach((f) => {
    const y = tmpV.copy(f.normal).applyQuaternion(q).y;
    if (y > best) { best = y; value = f.value; }
  });
  return { value, flat: best > 0.97, bottom, top: best };
}

const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

const HAND_Y = 4.5;
const SLOT = 2.6; // spacing of dice in the holder
const HAND_GAP = 2.6;
// Held dice sit in hex clusters of 7, stacked in layers.
const HEX = [[0, 0], [1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]];
const handOffset = (i) => {
  const [x, z] = HEX[i % 7];
  return new THREE.Vector3(x * HAND_GAP, Math.floor(i / 7) * HAND_GAP, z * HAND_GAP);
};

const SLOW_MO = 0.25; // physics speed during the hype cam
const RISE = 0.55, HOVER = 1.5, FALL = 0.6; // nat-20 ascension timing (seconds)

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return new THREE.CanvasTexture(c);
}

let sparkTex, emberTex, sigilTex;
const getSparkTex = () =>
  (sparkTex ??= canvasTex(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }));

// A chunky diamond with a soft halo, so embers read as fragments rather than fuzz.
const getEmberTex = () =>
  (emberTex ??= canvasTex(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(32, 12);
    ctx.lineTo(46, 32);
    ctx.lineTo(32, 52);
    ctx.lineTo(18, 32);
    ctx.closePath();
    ctx.fill();
  }));

// The magic circle under an ascending nat 20.
const getSigilTex = () =>
  (sigilTex ??= canvasTex(512, (ctx) => {
    ctx.translate(256, 256);
    ctx.strokeStyle = ctx.fillStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 16;
    const ring = (r, w) => {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    ring(232, 12);
    ring(200, 4);
    ring(118, 5);
    for (let i = 0; i < 20; i++) {
      ctx.save();
      ctx.rotate((i / 20) * Math.PI * 2);
      ctx.fillRect(-4, -226, 8, i % 5 ? 16 : 26);
      ctx.restore();
    }
    ctx.lineWidth = 6;
    for (const off of [0, Math.PI]) {
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = off + (k / 3) * Math.PI * 2 - Math.PI / 2;
        ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * 200, Math.sin(a) * 200);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }));

/** Dark planks with broad grain (fine detail turns to mush on a compressed stream). Tiles seamlessly. */
function woodTexture(renderer) {
  const TAU = Math.PI * 2;
  const tex = canvasTex(1024, (ctx, S) => {
    const planks = 6, ph = S / planks;
    for (let i = 0; i < planks; i++) {
      const y0 = i * ph;
      const seam = Math.round(rand(0.2, 0.8) * S);
      for (const [x0, x1] of [[0, seam], [seam, S]]) {
        ctx.fillStyle = `hsl(${rand(16, 24)} ${rand(30, 42)}% ${rand(9, 14)}%)`;
        ctx.fillRect(x0, y0, x1 - x0, ph);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, S, ph);
      ctx.clip();
      for (let k = 0; k < 26; k++) {
        const yb = y0 + rand(-10, ph + 10);
        const a1 = rand(2, 8), f1 = (TAU * Math.ceil(rand(0.01, 3))) / S, p1 = rand(0, TAU);
        const a2 = rand(0.5, 2), f2 = (TAU * Math.ceil(rand(4, 11))) / S, p2 = rand(0, TAU);
        ctx.beginPath();
        for (let x = 0; x <= S; x += 8) {
          const y = yb + a1 * Math.sin(x * f1 + p1) + a2 * Math.sin(x * f2 + p2);
          x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        const dark = Math.random() < 0.7;
        ctx.strokeStyle = dark ? `rgba(0,0,0,${rand(0.12, 0.3)})` : `rgba(255,205,160,${rand(0.03, 0.07)})`;
        ctx.lineWidth = rand(1, 4);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, y0, S, 3);
      ctx.fillRect(0, y0, 3, ph);
      ctx.fillRect(seam - 1, y0, 3, ph);
      ctx.fillStyle = 'rgba(255,210,170,0.05)';
      ctx.fillRect(0, y0 + 3, S, 1);
    }
    // Broad light/dark patches, drawn wrapped so the tile stays seamless.
    for (let k = 0; k < 10; k++) {
      const x = rand(0, S), y = rand(0, S), r = rand(120, 320);
      const light = Math.random() < 0.5;
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
        const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        g.addColorStop(0, light ? 'rgba(255,190,140,0.05)' : 'rgba(0,0,0,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
      }
    }
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(19, 19);
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

class Burst {
  constructor(origin, { count = 10, color = 0xffd9a0, speed = 6, up = 0.5, life = 0.4, size = 0.25, gravity = -30 }) {
    this.age = 0;
    this.life = life;
    this.gravity = gravity;
    this.pos = new Float32Array(count * 3);
    this.vel = [];
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      v.y = Math.abs(v.y) * (1 - up) + up * rand(0.6, 1);
      this.vel.push(v.normalize().multiplyScalar(speed * rand(0.35, 1)));
      this.pos.set([origin.x, origin.y, origin.z], i * 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color, size, map: getSparkTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.obj = new THREE.Points(this.geo, this.mat);
  }
  update(dt) {
    this.age += dt;
    this.vel.forEach((v, i) => {
      v.y += this.gravity * dt;
      const p = this.pos;
      p[i * 3] += v.x * dt;
      p[i * 3 + 1] += v.y * dt;
      p[i * 3 + 2] += v.z * dt;
      if (p[i * 3 + 1] < 0.05) { p[i * 3 + 1] = 0.05; v.y *= -0.3; v.x *= 0.7; v.z *= 0.7; }
    });
    this.geo.attributes.position.needsUpdate = true;
    this.mat.opacity = Math.max(0, 1 - (this.age / this.life) ** 2);
    return this.age < this.life;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/** Gold fragments that shower up, bounce, and smoulder on the table for a few seconds. */
class Embers {
  constructor(origin, { count = 80, color = 0xffc23d } = {}) {
    this.age = 0;
    this.color = new THREE.Color(color);
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.parts = [];
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2), h = rand(1.5, 9);
      this.parts.push({
        v: new THREE.Vector3(Math.cos(a) * h, rand(10, 26), Math.sin(a) * h),
        life: rand(2.4, 4.6),
        phase: rand(0, 6.3),
        rate: rand(5, 13),
        grounded: false,
      });
      this.pos.set([origin.x + rand(-0.4, 0.4), origin.y + 0.4, origin.z + rand(-0.4, 0.4)], i * 3);
    }
    this.maxLife = Math.max(...this.parts.map((p) => p.life));
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.6, map: getEmberTex(), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.obj = new THREE.Points(this.geo, this.mat);
  }
  update(dt) {
    this.age += dt;
    const P = this.pos, C = this.col;
    this.parts.forEach((q, i) => {
      const k = i * 3, v = q.v;
      if (q.grounded) {
        v.multiplyScalar(Math.exp(-dt * 8));
      } else {
        v.y -= 28 * dt;
        v.x *= Math.exp(-dt * 0.8);
        v.z *= Math.exp(-dt * 0.8);
      }
      P[k] += v.x * dt;
      P[k + 1] += v.y * dt;
      P[k + 2] += v.z * dt;
      if (!q.grounded && P[k + 1] < 0.08) {
        P[k + 1] = 0.08;
        v.y *= -0.35;
        v.x *= 0.5;
        v.z *= 0.5;
        if (v.y < 1.5) { v.y = 0; q.grounded = true; }
      }
      const t = this.age / q.life;
      const fade = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
      const b = fade * (0.65 + 0.35 * Math.sin(this.age * q.rate + q.phase));
      C[k] = this.color.r * b;
      C[k + 1] = this.color.g * b;
      C[k + 2] = this.color.b * b;
    });
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    return this.age < this.maxLife;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

class Shockwave {
  constructor(origin, color, life = 0.8) {
    this.age = 0;
    this.life = life;
    this.geo = new THREE.RingGeometry(0.85, 1, 64).rotateX(-Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({
      color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.obj = new THREE.Mesh(this.geo, this.mat);
    this.obj.position.set(origin.x, 0.06, origin.z);
  }
  update(dt) {
    this.age += dt;
    const t = this.age / this.life;
    this.obj.scale.setScalar(1 + (1 - (1 - t) ** 3) * 11);
    this.mat.opacity = Math.max(0, 1 - t);
    return t < 1;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

const TRAIL_N = 24;
const TRAIL_LIFE = 0.22; // seconds of (simulation) time a streak lingers

/** A short tapered ribbon behind a flying die, always turned to face the camera. */
class Trail {
  constructor(color, width) {
    this.pts = [];
    this.width = width;
    this.color = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.3); // a hot core reads better
    this.pos = new Float32Array(TRAIL_N * 6);
    this.col = new Float32Array(TRAIL_N * 8);
    const idx = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    this.geo.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.obj = new THREE.Mesh(this.geo, this.mat);
    this.obj.frustumCulled = false;
  }
  /** Returns false once the streak has fully faded. */
  update(now, head, emitting, camPos) {
    const pts = this.pts;
    if (emitting && (!pts.length || pts[0].p.distanceToSquared(head) > 0.03)) pts.unshift({ p: head.clone(), t: now });
    while (pts.length && (pts.length > TRAIL_N - 1 || now - pts[pts.length - 1].t > TRAIL_LIFE)) pts.pop();
    const list = emitting && pts[0].p.distanceToSquared(head) > 1e-6 ? [{ p: head, t: now }, ...pts] : pts;
    const n = Math.min(list.length, TRAIL_N);
    this.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    if (n < 2) return pts.length > 0;
    const dir = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = list[i].p;
      dir.subVectors(list[Math.max(0, i - 1)].p, list[Math.min(n - 1, i + 1)].p);
      view.subVectors(camPos, p);
      side.crossVectors(dir, view).normalize();
      const f = clamp01(1 - (now - list[i].t) / TRAIL_LIFE) * (1 - i / n) ** 0.6;
      side.multiplyScalar((this.width / 2) * f);
      this.pos.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
      const a = 0.7 * f;
      const { r, g, b } = this.color;
      this.col.set([r, g, b, a, r, g, b, a], i * 8);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    return true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

export class DiceTray {
  /**
   * hooks: { onImpact(speed, 'dice'|'floor'|'wall'), onThrow(strength 0-1), onSettle(die), onHype(on) }
   * onSettle fires as each thrown die comes to rest, with die.value set.
   */
  constructor(el, hooks = {}) {
    this.el = el;
    this.hooks = hooks;
    this.dice = []; // every die on the table: state 'staged' | 'held' | 'rolling' | 'done'
    this.throws = []; // in-flight throws waiting to settle
    this.fx = [];
    this.glows = [];
    this.trails = new Map(); // die → Trail
    this.hand = null;
    this.ascent = null; // a nat 20 floating up to show itself off
    this.hype = null; // slow-mo push-in on the deciding d20
    this.hypeUsed = false; // at most once per roll
    this.timeScale = 1;
    this.camAmt = 0; // 0 = normal view, 1 = pushed in on camFocus
    this.camFocus = new THREE.Vector3();
    this.camSpread = 0;
    this.simTime = 0;
    this.skin = 'classic';
    this.dirty = true;

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    if (!envMap) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
    this.camBase = new THREE.Vector3(0, 22, 6);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x302040, 1.2));
    const key = (this.key = new THREE.DirectionalLight(0xffffff, 2.6));
    key.position.set(-8, 24, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffc2a0, 0.8);
    rim.position.set(10, 8, -12);
    scene.add(rim);
    // Two candles just off the far corners of the table (placed in resize()).
    this.candles = [0, 1].map(() => {
      const l = new THREE.PointLight(0xff8a3a, 0, 0, 1.4);
      l.userData = { base: 0, f: 1 };
      scene.add(l);
      return l;
    });
    this.flickT = 0;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: woodTexture(renderer), roughness: 0.82, metalness: 0 })
    );
    floor.receiveShadow = true;
    scene.add(floor);

    const world = (this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -70, 0) }));
    world.allowSleep = true;
    this.diceMat = new CANNON.Material('dice');
    const floorMat = new CANNON.Material('floor');
    const wallMat = (this.wallMat = new CANNON.Material('wall'));
    world.addContactMaterial(new CANNON.ContactMaterial(floorMat, this.diceMat, { friction: 0.3, restitution: 0.4 }));
    world.addContactMaterial(new CANNON.ContactMaterial(wallMat, this.diceMat, { friction: 0.05, restitution: 0.7 }));
    world.addContactMaterial(new CANNON.ContactMaterial(this.diceMat, this.diceMat, { friction: 0.15, restitution: 0.5 }));

    const floorBody = (this.floorBody = new CANNON.Body({ mass: 0, material: floorMat, shape: new CANNON.Plane() }));
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(floorBody);
    this.walls = [Math.PI / 2, -Math.PI / 2, 0, Math.PI].map((ry) => {
      const b = new CANNON.Body({ mass: 0, material: wallMat, shape: new CANNON.Plane() });
      b.quaternion.setFromEuler(0, ry, 0);
      world.addBody(b);
      return b;
    });

    this.holder = this.makeHolder();
    scene.add(this.holder.group);

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();

    let last;
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - (last ?? t)) / 1000);
      last = t;
      this.updateHype(dt);
      const sdt = dt * this.timeScale; // simulation time: slows down during the hype cam
      this.simTime += sdt;
      if (this.hand) {
        this.updateHand(dt, t / 1000);
        this.dirty = true;
      }
      if (this.fx.length) {
        this.fx = this.fx.filter((f) => {
          if (f.update(dt)) return true;
          scene.remove(f.obj);
          f.dispose();
          return false;
        });
        this.dirty = true;
      }
      for (const g of this.glows) {
        if (g.t > 6) continue;
        g.t += dt;
        const pulse = Math.sin(g.t * 7);
        g.mat.emissiveIntensity = 0.3 + 0.15 * pulse;
        g.light.intensity = g.base * (0.85 + 0.15 * pulse);
        this.dirty = true;
      }
      this.updateCandles(dt);
      this.updateHolder(dt);
      if (this.dice.length) {
        // Shrink the step with the time scale so slow motion stays smooth instead of stuttering.
        world.step((1 / 120) * this.timeScale, sdt, 12);
        for (const d of this.dice) {
          if (!d.inWorld || d.state === 'staged' || d.posed) continue; // posed by the hand / holder / ascension
          d.mesh.position.copy(d.body.position);
          d.mesh.quaternion.copy(d.body.quaternion);
          if (d.body.type === CANNON.Body.DYNAMIC && d.body.sleepState !== CANNON.Body.SLEEPING) this.dirty = true;
        }
        this.throws = this.throws.filter((th) => !this.checkThrow(th, sdt));
      }
      if (this.ascent) this.updateAscent(dt);
      this.updateTrails();
      if (this.dirty) {
        renderer.render(scene, this.camera);
        this.dirty = false;
      }
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const cam = this.camera;
    cam.aspect = w / h;
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dist = Math.max(22, 8 / (t * Math.min(1, cam.aspect)));
    this.camBase.set(0, dist, dist * 0.28);
    cam.position.copy(this.camBase);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pts = [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([x, y]) => {
      ray.setFromCamera(new THREE.Vector2(x, y), cam);
      return ray.ray.intersectPlane(plane, new THREE.Vector3());
    });
    const inset = 0.4;
    const xHalf = Math.min(...pts.map((p) => Math.abs(p.x))) - inset;
    const zMin = Math.max(pts[0].z, pts[1].z) + inset;
    const zMax = Math.min(pts[2].z, pts[3].z) - inset;
    this.bounds = { xHalf, zMin, zMax };
    const [l, r, far, near] = this.walls;
    l.position.set(-xHalf, 0, 0);
    r.position.set(xHalf, 0, 0);
    far.position.set(0, 0, zMin);
    near.position.set(0, 0, zMax);

    const sc = this.key.shadow.camera;
    const ext = Math.max(xHalf, -zMin, zMax) + 4;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.updateProjectionMatrix();

    const [c1, c2] = this.candles;
    c1.position.set(-xHalf - 2, 5, zMin + 2);
    c2.position.set(xHalf + 2, 5, zMin * 0.1);
    for (const c of this.candles) c.userData.base = 4.5 * ext;

    this.layoutHolder();
    this.applyCamera();
    this.dirty = true;
  }

  /** Flicker the candles ~15 times a second (cheap, and doesn't force a render every frame). */
  updateCandles(dt) {
    this.flickT += dt;
    if (this.flickT < 0.066) return;
    this.flickT = 0;
    for (const c of this.candles) {
      const u = c.userData;
      u.f = u.f * 0.55 + rand(0.82, 1.12) * 0.45;
      c.intensity = u.base * u.f;
    }
    this.dirty = true;
  }

  /* ----- Hype cam: when the deciding d20 is slowing down with a 20 or a 1 showing, slow time and push in ----- */

  updateHype(dt) {
    if (!this.hype && !this.hypeUsed) this.checkHype();
    const h = this.hype;
    if (h) {
      h.t += dt;
      if (!h.doneAt && h.dice.every((d) => d.state === 'done')) h.doneAt = h.t;
      const interrupted = this.dice.some((d) => d.state !== 'done' && !h.dice.includes(d));
      const lingered = h.doneAt && !this.ascent && h.t - h.doneAt > 0.7;
      if (interrupted || lingered || h.t > 7) this.endHype();
      else {
        const goal = new THREE.Vector3();
        h.dice.forEach((d) => goal.add(d.mesh.position));
        goal.divideScalar(h.dice.length);
        this.camFocus.lerp(goal, 1 - Math.exp(-dt * 6));
        // Keep a spread-out pair both in shot.
        const spread = h.dice.length > 1 ? h.dice[0].mesh.position.distanceTo(h.dice[1].mesh.position) : 0;
        this.camSpread += (spread - this.camSpread) * (1 - Math.exp(-dt * 6));
      }
    }
    // Slow motion is brief: it eases back to full speed after ~2s even if the die is still going.
    const slow = this.hype && !this.hype.doneAt && this.hype.t < 2;
    const ts = slow ? SLOW_MO : 1;
    this.timeScale += (ts - this.timeScale) * (1 - Math.exp(-dt * (slow ? 12 : 5)));
    if (Math.abs(ts - this.timeScale) < 0.002) this.timeScale = ts;

    const want = this.hype ? 1 : 0;
    if (this.camAmt !== want || this.hype) {
      this.camAmt += (want - this.camAmt) * (1 - Math.exp(-dt * (want ? 3.5 : 3.2)));
      if (Math.abs(want - this.camAmt) < 0.004) this.camAmt = want; // imperceptible after smoothstep
      this.applyCamera();
      this.dirty = true;
    }
  }

  checkHype() {
    const live = this.dice.filter((d) => d.state !== 'done');
    if (!live.length || live.length > 2) return;
    if (live.some((d) => d.state !== 'rolling' || d.def.sides !== 20 || d.rollT < 0.3)) return;
    if (live.some((d) => d.body.velocity.length() > 8 || d.body.angularVelocity.length() > 14 || d.body.position.y > 2.4)) return;
    if (live.length === 2 && live[0].body.position.distanceTo(live[1].body.position) > 7) return; // too far apart to frame
    const teasing = live.some((d) => {
      const r = readDie(d);
      return r.top > 0.9 && (r.value === 20 || r.value === 1);
    });
    if (!teasing) return;
    this.hypeUsed = true;
    this.hype = { dice: live, t: 0, doneAt: 0 };
    this.camFocus.copy(live[0].mesh.position);
    this.camSpread = 0;
    this.hooks.onHype?.(true);
  }

  endHype() {
    if (!this.hype) return;
    this.hype = null;
    this.hooks.onHype?.(false);
  }

  /** Blend the camera between its normal view and a close-up on camFocus. */
  applyCamera() {
    const cam = this.camera;
    const a = smooth(this.camAmt);
    const base = this.camBase;
    if (a < 1e-4) {
      cam.position.copy(base);
      cam.lookAt(0, 0, 0);
    } else {
      // Push in to 40% of the normal distance, or less far if that would crop a spread-out pair
      // (0.8: the letterbox bars cover the top and bottom of the view).
      const halfView = 0.8 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * Math.min(1, cam.aspect) * base.length();
      const frac = THREE.MathUtils.clamp((this.camSpread / 2 + 2) / halfView, 0.4, 1);
      const close = this.camFocus.clone().addScaledVector(base.clone().normalize(), base.length() * frac);
      cam.position.lerpVectors(base, close, a);
      cam.lookAt(new THREE.Vector3().lerpVectors(new THREE.Vector3(), this.camFocus, a));
      cam.rotateZ(-0.06 * a); // a slight dutch tilt
    }
    cam.updateMatrixWorld();
  }

  /* ----- The dice holder: a little tray at the bottom of the table where added dice wait ----- */

  makeHolder() {
    const group = new THREE.Group();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const wood = new THREE.MeshStandardMaterial({ color: 0x1c1b22, roughness: 0.55, metalness: 0.1 });
    const felt = new THREE.MeshStandardMaterial({ color: 0x8a1222, roughness: 1 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.4 });
    const mk = (mat) => {
      const m = new THREE.Mesh(box, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };
    const parts = {
      base: mk(wood),
      felt: mk(felt),
      rims: [mk(wood), mk(wood), mk(wood), mk(wood)],
      caps: [mk(trim), mk(trim), mk(trim), mk(trim)],
    };
    group.visible = false;
    // w/d/z animate toward tw/td/tz; slide goes 0 (in view) → 1 (slid off the bottom edge).
    return { group, parts, w: 4, d: 4, z: 0, tw: 4, td: 4, tz: 0, slide: 1, target: 1, body: null };
  }

  sizeHolder() {
    const { parts, w, d } = this.holder;
    const t = 0.28, rimH = 1;
    parts.base.scale.set(w, 0.4, d);
    parts.base.position.set(0, 0.2, 0);
    parts.felt.scale.set(w - 2 * t, 0.04, d - 2 * t);
    parts.felt.position.set(0, 0.41, 0);
    const rims = [
      [w, t, 0, d / 2 - t / 2],
      [w, t, 0, -(d / 2 - t / 2)],
      [t, d - 2 * t, w / 2 - t / 2, 0],
      [t, d - 2 * t, -(w / 2 - t / 2), 0],
    ];
    rims.forEach(([sx, sz, x, z], i) => {
      parts.rims[i].scale.set(sx, rimH, sz);
      parts.rims[i].position.set(x, rimH / 2, z);
      parts.caps[i].scale.set(sx, 0.08, sz);
      parts.caps[i].position.set(x, rimH + 0.04, z);
    });
  }

  /** Re-slot the waiting dice and size the holder to fit them (slides it out when empty). */
  layoutHolder() {
    const h = this.holder;
    if (!h || !this.bounds) return;
    const staged = this.dice.filter((d) => d.state === 'staged');
    const n = staged.length;
    const { xHalf, zMax } = this.bounds;
    const maxCols = Math.max(1, Math.floor((2 * xHalf - 2) / SLOT));
    const cols = Math.max(1, Math.min(n, maxCols));
    const rows = Math.max(1, Math.ceil(n / cols));
    h.tw = cols * SLOT + 0.9;
    h.td = rows * SLOT + 0.9;
    h.tz = zMax - h.td / 2 - 0.2;
    staged.forEach((d, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      d.slot = new THREE.Vector3((c - (cols - 1) / 2) * SLOT, 0, (r - (rows - 1) / 2) * SLOT);
    });
    h.target = n ? 0 : 1;

    // Static collider so thrown dice bounce off the holder (and the dice waiting in it).
    if (h.body) this.world.removeBody(h.body);
    h.body = null;
    if (n) {
      const b = new CANNON.Body({ mass: 0, material: this.wallMat });
      const t = 0.28, rimH = 1, W = h.tw, D = h.td;
      b.addShape(new CANNON.Box(new CANNON.Vec3(W / 2, 0.2, D / 2)), new CANNON.Vec3(0, 0.2, 0));
      b.addShape(new CANNON.Box(new CANNON.Vec3(W / 2, rimH / 2, t / 2)), new CANNON.Vec3(0, rimH / 2, D / 2 - t / 2));
      b.addShape(new CANNON.Box(new CANNON.Vec3(W / 2, rimH / 2, t / 2)), new CANNON.Vec3(0, rimH / 2, -(D / 2 - t / 2)));
      b.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, rimH / 2, D / 2)), new CANNON.Vec3(W / 2 - t / 2, rimH / 2, 0));
      b.addShape(new CANNON.Box(new CANNON.Vec3(t / 2, rimH / 2, D / 2)), new CANNON.Vec3(-(W / 2 - t / 2), rimH / 2, 0));
      b.position.set(0, 0, h.tz);
      this.world.addBody(b);
      h.body = b;
    }
    this.dirty = true;
  }

  inHolder(d) {
    const h = this.holder;
    if (!h.body) return false;
    const p = d.body.position;
    return Math.abs(p.x) < h.tw / 2 && Math.abs(p.z - h.tz) < h.td / 2;
  }

  updateHolder(dt) {
    const h = this.holder;
    const k = 1 - Math.exp(-dt * 9);
    const before = h.slide + h.w + h.d + h.z;
    const ease = (key, target) => {
      h[key] += (target - h[key]) * k;
      if (Math.abs(target - h[key]) < 0.002) h[key] = target;
    };
    ease('slide', h.target);
    ease('w', h.tw);
    ease('d', h.td);
    ease('z', h.tz);
    let moving = Math.abs(before - (h.slide + h.w + h.d + h.z)) > 1e-6;
    h.group.visible = h.slide < 0.999;
    if (moving) this.sizeHolder();
    h.group.position.set(0, 0, h.z + h.slide * (h.td + 6));

    const goal = new THREE.Vector3();
    for (const d of this.dice) {
      if (d.state !== 'staged') continue;
      goal.copy(h.group.position).add(d.slot);
      goal.y = 0.42 + d.restY;
      const dist = d.mesh.position.distanceTo(goal);
      d.mesh.position.lerp(goal, 1 - Math.exp(-dt * 14));
      d.mesh.quaternion.slerp(d.restQ, 1 - Math.exp(-dt * 10));
      if (!d.landed && dist < 0.25) {
        d.landed = true;
        this.hooks.onImpact?.(6, 'floor');
      }
      d.body.position.copy(d.mesh.position);
      d.body.quaternion.copy(d.mesh.quaternion);
      if (dist > 0.002) moving = true;
    }
    if (moving) this.dirty = true;
  }

  setStatic(d) {
    const b = d.body;
    b.type = CANNON.Body.STATIC;
    b.mass = 0;
    b.updateMassProperties();
    b.velocity.setZero();
    b.angularVelocity.setZero();
  }

  setDynamic(d) {
    const b = d.body;
    b.type = CANNON.Body.DYNAMIC;
    b.mass = 1;
    b.updateMassProperties();
    b.position.copy(d.mesh.position);
    b.quaternion.copy(d.mesh.quaternion);
    b.wakeUp();
  }

  /* ----- Dice finishes ----- */

  kindFor(spec) {
    return getKind(spec.sides, spec.tens ? 'tens' : 'normal', this.skin);
  }

  /** Switch the dice finish; re-skins every die already on the table (except highlighted ones). */
  setSkin(name) {
    this.skin = SKINS[name] ? name : 'classic';
    for (const d of this.dice) {
      d.kind = this.kindFor(d.spec);
      if (!d.ownMat) d.mesh.material = d.kind.material;
      d.mesh.children[0].material = d.kind.edgeMat;
    }
    this.dirty = true;
  }

  /* ----- Dice lifecycle: stage() puts a die on the table, then it is grabbed/tossed, then read ----- */

  clear() {
    for (const d of this.dice) this.discard(d);
    for (const g of this.glows) this.scene.remove(g.light);
    for (const f of this.fx) { this.scene.remove(f.obj); f.dispose(); }
    if (this.ascent) this.endAscent();
    this.dice = [];
    this.throws = [];
    this.glows = [];
    this.fx = [];
    this.hand = null;
    this.ascent = null;
    this.endHype();
    this.hypeUsed = false;
    // Hide the holder instantly so the next roll's holder slides in fresh.
    this.layoutHolder();
    this.holder.slide = 1;
    this.dirty = true;
  }

  discard(d) {
    this.scene.remove(d.mesh);
    this.removeBody(d);
    if (d.ownMat) d.mesh.material.dispose();
    const tr = this.trails.get(d);
    if (tr) {
      this.scene.remove(tr.obj);
      tr.dispose();
      this.trails.delete(d);
    }
  }

  addBody(d) {
    if (d.inWorld) return;
    this.world.addBody(d.body);
    d.inWorld = true;
  }

  removeBody(d) {
    if (!d.inWorld) return;
    this.world.removeBody(d.body);
    d.inWorld = false;
  }

  makeDie(spec) {
    const kind = this.kindFor(spec);
    const mesh = new THREE.Mesh(kind.geometry, kind.material);
    mesh.castShadow = true;
    mesh.add(new THREE.LineSegments(kind.edges, kind.edgeMat));
    const def = kind.def;
    const body = new CANNON.Body({
      mass: 1,
      material: this.diceMat,
      shape: new CANNON.ConvexPolyhedron({
        vertices: def.verts.map((v) => new CANNON.Vec3(v.x, v.y, v.z)),
        faces: def.faces.map((f) => f.idx),
      }),
      linearDamping: 0.1,
      angularDamping: 0.12,
      sleepSpeedLimit: 0.15,
      sleepTimeLimit: 0.2,
    });
    body.isDie = true;
    const die = { spec, def, kind, mesh, body, state: 'new', inWorld: false, value: null, lastHit: 0 };
    body.addEventListener('collide', (e) => this.onCollide(die, e));
    return die;
  }

  /** Put a new die in the holder (it drops into its slot). Returns the die handle. */
  stage(spec) {
    const d = this.makeDie(spec);
    // Rest flat on a random face with a random twist.
    const face = d.def.faces[Math.floor(Math.random() * d.def.faces.length)];
    d.restY = face.normal.dot(d.def.verts[face.idx[0]]);
    d.restQ = new THREE.Quaternion()
      .setFromUnitVectors(face.normal, new THREE.Vector3(0, -1, 0))
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand(0, Math.PI * 2)));
    d.state = 'staged';
    this.setStatic(d);
    this.addBody(d);
    this.dice.push(d);
    this.layoutHolder();
    d.mesh.position.copy(this.holder.group.position).add(d.slot);
    d.mesh.position.y = 5;
    d.mesh.quaternion.setFromEuler(new THREE.Euler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)));
    this.scene.add(d.mesh);
    this.dirty = true;
    return d;
  }

  remove(d) {
    this.discard(d);
    this.dice = this.dice.filter((x) => x !== d);
    this.layoutHolder();
  }

  onCollide(die, e) {
    const other = e.body;
    if (other.isDie && other.id < die.body.id) return; // dice-on-dice fires on both bodies
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    const now = performance.now();
    if (v < 1 || now - die.lastHit < 30) return;
    die.lastHit = now;
    const kind = other.isDie ? 'dice' : other === this.floorBody ? 'floor' : 'wall';
    this.hooks.onImpact?.(v, kind);
    if (v > (kind === 'dice' ? 9 : 18)) {
      const c = e.contact;
      const p = c.bi.position.vadd(c.ri);
      this.addFx(new Burst(p, { count: Math.round(6 + v * 0.4), speed: 3 + v * 0.25, life: 0.35 }));
    }
  }

  addFx(f) {
    this.fx.push(f);
    this.scene.add(f.obj);
  }

  updateTrails() {
    for (const d of this.dice) {
      if (d.state !== 'rolling' || this.trails.has(d)) continue;
      const tr = new Trail(SKINS[this.skin].trail, SIZE[d.def.sides] * 1.05);
      this.trails.set(d, tr);
      this.scene.add(tr.obj);
    }
    for (const [d, tr] of this.trails) {
      const emitting = d.state === 'rolling' && d.body.velocity.length() > 6;
      if (tr.update(this.simTime, d.mesh.position, emitting, this.camera.position)) this.dirty = true;
      else if (d.state !== 'rolling') {
        this.scene.remove(tr.obj);
        tr.dispose();
        this.trails.delete(d);
        this.dirty = true;
      }
    }
  }

  rayAt(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray;
  }

  /** The staged (not yet rolled) die under the pointer, or null. */
  pick(cx, cy) {
    const staged = this.dice.filter((d) => d.state === 'staged');
    const hit = this.rayAt(cx, cy).intersectObjects(staged.map((d) => d.mesh), false)[0];
    return hit ? staged.find((d) => d.mesh === hit.object) : null;
  }

  /** Scoop staged dice off the table and toss them into the middle (the Roll button). */
  toss(dice) {
    const { xHalf, zMin, zMax } = this.bounds;
    const zc = (zMin + zMax) / 2 - 1;
    for (const d of dice) {
      const b = d.body;
      d.state = 'rolling';
      this.setDynamic(d);
      this.addBody(d);
      const dir = new CANNON.Vec3(rand(-xHalf * 0.5, xHalf * 0.5) - b.position.x, 0, zc + rand(-2, 2) - b.position.z);
      const speed = THREE.MathUtils.clamp(dir.length() * 2.2 + rand(3, 8), 6, 34);
      dir.normalize();
      b.velocity.set(dir.x * speed, rand(12, 17), dir.z * speed);
      b.angularVelocity.set(rand(-25, 25), rand(-25, 25), rand(-25, 25));
    }
    this.layoutHolder();
    this.hooks.onThrow?.(0.7);
    this.startThrow(dice);
  }

  startThrow(dice) {
    for (const d of dice) Object.assign(d, { rollT: 0, still: 0, nudges: 0 });
    this.throws.push({ dice, elapsed: 0 });
  }

  /* ----- Throwing by hand: grab() on pointer down, moveHand() while dragging, release() to throw ----- */

  pointerToHand(cx, cy) {
    const p = this.rayAt(cx, cy).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -HAND_Y), new THREE.Vector3());
    if (!p) return this.hand?.target ?? new THREE.Vector3(0, HAND_Y, 0);
    const { xHalf, zMin, zMax } = this.bounds;
    const m = HAND_GAP + 0.4;
    p.x = THREE.MathUtils.clamp(p.x, -Math.max(0, xHalf - m), Math.max(0, xHalf - m));
    p.z = THREE.MathUtils.clamp(p.z, Math.min(0, zMin + m), Math.max(0, zMax - m));
    return p;
  }

  /** Pick staged dice up off the table into the "hand" under the pointer. */
  grab(dice, cx, cy) {
    const target = this.pointerToHand(cx, cy);
    for (const d of dice) {
      this.removeBody(d);
      d.state = 'held';
      d.spinAxis = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      d.spin = rand(3, 7);
    }
    this.hand = { dice, target, cx, cy, pos: target.clone(), samples: [{ t: performance.now(), p: target.clone() }] };
    this.layoutHolder(); // an emptied holder slides away
  }

  moveHand(cx, cy) {
    if (!this.hand) return;
    const now = performance.now();
    Object.assign(this.hand, { cx, cy });
    this.hand.target = this.pointerToHand(cx, cy);
    this.hand.samples.push({ t: now, p: this.hand.target.clone() });
    this.hand.samples = this.hand.samples.filter((s) => now - s.t < 150);
  }

  updateHand(dt, time) {
    const h = this.hand;
    if (this.camAmt > 0) h.target = this.pointerToHand(h.cx, h.cy); // the camera is still easing back
    h.pos.lerp(h.target, 1 - Math.exp(-dt * 30));
    const q = new THREE.Quaternion();
    const goal = new THREE.Vector3();
    h.dice.forEach((d, i) => {
      goal.copy(h.pos).add(handOffset(i));
      goal.y += Math.sin(time * 18 + i * 1.7) * 0.12; // rattle in the hand
      d.mesh.position.lerp(goal, 1 - Math.exp(-dt * 22)); // glide up from the table
      d.mesh.quaternion.premultiply(q.setFromAxisAngle(d.spinAxis, d.spin * dt));
    });
  }

  /** Throw the held dice with the pointer's recent velocity. */
  release() {
    const h = this.hand;
    if (!h) return;
    this.hand = null;
    const now = performance.now();
    const recent = h.samples.filter((s) => now - s.t < 100);
    const vel = new THREE.Vector3();
    if (recent.length > 1) {
      const a = recent[0], b = recent[recent.length - 1];
      const secs = (b.t - a.t) / 1000;
      if (secs > 0.01) vel.subVectors(b.p, a.p).divideScalar(secs).multiplyScalar(1.15);
    }
    vel.y = 0;
    if (vel.length() > 45) vel.setLength(45);
    const speed = vel.length();
    const flung = speed > 3;

    for (const d of h.dice) {
      const { body } = d;
      this.setDynamic(d);
      if (flung) body.velocity.set(vel.x * rand(0.9, 1.1), rand(-2, 2), vel.z * rand(0.9, 1.1));
      else body.velocity.set(rand(-4, 4), 0, rand(-4, 4)); // just a click: let it drop
      const s = 10 + speed * 0.8;
      body.angularVelocity.set(rand(-s, s), rand(-s, s), rand(-s, s));
      d.state = 'rolling';
      this.addBody(d);
    }
    this.hooks.onThrow?.(flung ? Math.min(1, speed / 35) : 0.2);
    this.startThrow(h.dice);
  }

  /**
   * Read each die as soon as it has come to rest flat on the table, and freeze it there.
   * Returns true once every die in the throw has been read.
   */
  checkThrow(th, dt) {
    th.elapsed += dt;
    const timeout = th.elapsed > 9;
    for (const d of th.dice) {
      if (d.state !== 'rolling') continue;
      d.rollT += dt;
      const b = d.body;
      const moving = b.velocity.length() > 0.12 || b.angularVelocity.length() > 0.25;
      d.still = moving ? 0 : d.still + dt;
      if (!timeout && !(d.still > 0.3 && d.rollT > 0.6)) continue;
      const r = readDie(d);
      const propped = r.bottom > (this.inHolder(d) ? 0.6 : 0.15); // resting on another die
      if ((!r.flat || propped) && !timeout && d.nudges < 4) {
        // Leaning on another die or a wall: give it a little hop.
        d.nudges++;
        d.still = 0;
        b.wakeUp();
        b.velocity.set(rand(-2, 2), rand(5, 8), rand(-2, 2));
        b.angularVelocity.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
        continue;
      }
      this.settle(d, r.value);
    }
    return th.dice.every((d) => d.state !== 'rolling');
  }

  settle(d, value) {
    d.value = value;
    d.state = 'done';
    // Freeze it so later dice can't knock it onto a different face.
    this.setStatic(d);
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
    this.dirty = true;
    this.hooks.onSettle?.(d);
  }

  /** Highlight a settled die: 'dropped' (advantage loser), 'crit', or 'fumble'. */
  mark(d, state) {
    if (!d) return;
    const mat = (d.mesh.material = d.kind.material.clone());
    d.ownMat = true;
    const at = d.mesh.position;
    if (state === 'dropped') {
      mat.transparent = true;
      mat.opacity = 0.3;
      d.mesh.castShadow = false;
      d.mesh.children[0].visible = false;
    } else if (state === 'crit') {
      mat.emissive = new THREE.Color(0xffa31a);
      mat.emissiveIntensity = 0.3;
      const light = new THREE.PointLight(0xffc040, 16, 14, 2);
      light.position.set(at.x, at.y + 3, at.z);
      this.scene.add(light);
      d.glow = { mat, light, t: 0, base: 16 };
      this.glows.push(d.glow);
      this.addFx(new Embers(at));
      this.addFx(new Burst(at, { count: 70, color: 0xffffff, speed: 11, up: 0.6, life: 1.1, size: 0.3, gravity: -18 }));
      this.addFx(new Shockwave(at, 0xffc83d, 0.9));
      if (!this.ascent && d.def.sides === 20) this.startAscent(d);
    } else if (state === 'fumble') {
      mat.color.setRGB(0.4, 0.3, 0.3);
      mat.emissive = new THREE.Color(0x550000);
      this.addFx(new Burst(at, { count: 90, color: 0xff2a2a, speed: 7, up: 0.35, life: 1.3, size: 0.34, gravity: -30 }));
      this.addFx(new Shockwave(at, 0xff2a2a, 0.7));
    }
    this.dirty = true;
  }

  /* ----- Nat-20 ascension: the die floats up over a magic circle, turns its 20 to the camera, and settles back ----- */

  startAscent(d) {
    const sigil = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: getSigilTex(), color: 0xffc23d, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    sigil.position.set(d.mesh.position.x, 0.07, d.mesh.position.z);
    sigil.scale.setScalar(0.001);
    this.scene.add(sigil);
    d.posed = true;
    this.ascent = {
      d,
      t: 0,
      face: d.def.faces.find((f) => f.value === 20),
      fromPos: d.mesh.position.clone(),
      fromQuat: d.mesh.quaternion.clone(),
      sigil,
    };
  }

  /** Orientation that shows `face` to the camera, upright on screen. */
  faceToCamera(face, at) {
    const n = new THREE.Vector3().subVectors(this.camera.position, at).normalize();
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const u = camUp.addScaledVector(n, -camUp.dot(n)).normalize();
    const r = u.clone().cross(n);
    const world = new THREE.Matrix4().makeBasis(r, u, n);
    const local = new THREE.Matrix4().makeBasis(face.right, face.up, face.normal);
    return new THREE.Quaternion().setFromRotationMatrix(world.multiply(local.transpose()));
  }

  updateAscent(dt) {
    const a = this.ascent;
    a.t += dt;
    const { d, t, sigil } = a;
    const end = RISE + HOVER + FALL;
    const k = t < RISE ? smooth(t / RISE) : t < RISE + HOVER ? 1 : 1 - smooth(clamp01((t - RISE - HOVER) / FALL));
    const hover = a.fromPos.clone();
    hover.y = 5 + Math.sin(t * 3) * 0.15;
    d.mesh.position.lerpVectors(a.fromPos, hover, k);
    const show = this.faceToCamera(a.face, d.mesh.position);
    show.premultiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3().subVectors(this.camera.position, d.mesh.position).normalize(),
      Math.sin(t * 2.4) * 0.12
    ));
    d.mesh.quaternion.slerpQuaternions(a.fromQuat, show, k);
    d.mesh.scale.setScalar(1 + 0.3 * k);
    d.glow?.light.position.set(d.mesh.position.x, d.mesh.position.y + 2.5, d.mesh.position.z);

    const grow = clamp01(t / 0.45);
    const s = 5 * (1 + 2.2 * (grow - 1) ** 3 + 1.2 * (grow - 1) ** 2); // ease out with a little overshoot
    sigil.scale.setScalar(Math.max(0.001, s));
    sigil.rotation.y += dt * 0.9;
    sigil.material.opacity = t < end - 0.5 ? 0.9 : 0.9 * clamp01((end - t) / 0.5);
    this.dirty = true;

    if (t >= end) this.endAscent();
  }

  endAscent() {
    const { d, sigil, fromPos, fromQuat } = this.ascent;
    d.mesh.position.copy(fromPos);
    d.mesh.quaternion.copy(fromQuat);
    d.mesh.scale.setScalar(1);
    d.posed = false;
    this.scene.remove(sigil);
    sigil.geometry.dispose();
    sigil.material.dispose();
    this.ascent = null;
  }
}
