import * as THREE from 'three';
import * as CANNON from 'cannon-es';

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

const THEMES = {
  normal: { body: '#e0263b', edge: 0x5a0712, ink: '#ffffff' },
  tens: { body: '#17171d', edge: 0x000000, ink: '#ffd23f' },
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

const kinds = {};
function getKind(sides, variant) {
  const key = sides + variant;
  if (kinds[key]) return kinds[key];
  const def = getDef(sides);
  const theme = THEMES[variant];
  const n = def.faces.length;
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = theme.body;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pos = [], nor = [], uv = [];
  def.faces.forEach((f, fi) => {
    const col = fi % cols, row = Math.floor(fi / cols);
    const toCanvas = ([x, y]) => [(col + 0.5 + x) * CELL, (row + 0.5 - y) * CELL];

    if (sides === 4) {
      f.idx.forEach((vi, k) => {
        const [x, y] = f.local[k];
        const [cx, cy] = toCanvas([x * 0.58, y * 0.58]);
        drawLabel(ctx, String(vi + 1), cx, cy, Math.atan2(x, y), CELL * 0.19, theme.ink, false);
      });
    } else {
      let label = String(f.value);
      let size = LABEL_SIZE[sides];
      if (sides === 10) {
        label = variant === 'tens' ? String((f.value % 10) * 10).padStart(2, '0') : String(f.value % 10);
        if (variant === 'tens') size = 0.3;
      }
      const [cx, cy] = toCanvas([0, LABEL_DY[sides] || 0]);
      const underline = sides >= 10 && (label === '6' || label === '9');
      drawLabel(ctx, label, cx, cy, 0, size * CELL, theme.ink, underline);
    }

    const uvs = f.local.map((p) => {
      const [cx, cy] = toCanvas(p);
      return [cx / canvas.width, 1 - cy / canvas.height];
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
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.05 });
  const edges = new THREE.EdgesGeometry(geometry, 1);
  const edgeMat = new THREE.LineBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.6 });
  return (kinds[key] = { def, geometry, material, edges, edgeMat });
}

function readDie(die) {
  const q = die.mesh.quaternion;
  const { def } = die;
  if (def.sides === 4) {
    let best = -Infinity, value = 1;
    def.verts.forEach((v, i) => {
      const y = v.clone().applyQuaternion(q).y;
      if (y > best) { best = y; value = i + 1; }
    });
    const flat = def.faces.some((f) => f.normal.clone().applyQuaternion(q).y < -0.97);
    return { value, flat };
  }
  let best = -Infinity, value = 1;
  def.faces.forEach((f) => {
    const y = f.normal.clone().applyQuaternion(q).y;
    if (y > best) { best = y; value = f.value; }
  });
  return { value, flat: best > 0.97 };
}

const rand = (a, b) => a + Math.random() * (b - a);

const HAND_Y = 4.5;
const HAND_GAP = 2.6;
// Held dice sit in hex clusters of 7, stacked in layers.
const HEX = [[0, 0], [1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]];
const handOffset = (i) => {
  const [x, z] = HEX[i % 7];
  return new THREE.Vector3(x * HAND_GAP, Math.floor(i / 7) * HAND_GAP, z * HAND_GAP);
};

let sparkTex;
function getSparkTex() {
  if (sparkTex) return sparkTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return (sparkTex = new THREE.CanvasTexture(c));
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

export class DiceTray {
  /** hooks: { onImpact(speed, 'dice'|'floor'|'wall'), onThrow(strength 0-1) } */
  constructor(el, hooks = {}) {
    this.el = el;
    this.hooks = hooks;
    this.dice = []; // every die on the table: state 'staged' | 'held' | 'rolling' | 'done'
    this.throws = []; // in-flight throws waiting to settle
    this.fx = [];
    this.glows = [];
    this.hand = null;
    this.slot = 0; // next free spot in the staging row
    this.dirty = true;

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x302040, 1.4));
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

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.5 })
    );
    floor.receiveShadow = true;
    scene.add(floor);

    const world = (this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -70, 0) }));
    world.allowSleep = true;
    this.diceMat = new CANNON.Material('dice');
    const floorMat = new CANNON.Material('floor');
    const wallMat = new CANNON.Material('wall');
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

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();

    let last;
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - (last ?? t)) / 1000);
      last = t;
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
      if (this.dice.length) {
        world.step(1 / 120, dt, 12);
        for (const d of this.dice) {
          if (!d.inWorld) continue; // held dice are posed by the hand
          d.mesh.position.copy(d.body.position);
          d.mesh.quaternion.copy(d.body.quaternion);
          if (d.body.type === CANNON.Body.DYNAMIC && d.body.sleepState !== CANNON.Body.SLEEPING) this.dirty = true;
        }
        this.throws = this.throws.filter((th) => !this.checkThrow(th, dt));
      }
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
    cam.position.set(0, dist, dist * 0.28);
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
    this.dirty = true;
  }

  /* ----- Dice lifecycle: stage() puts a die on the table, then it is grabbed/tossed, then read ----- */

  clear() {
    for (const d of this.dice) this.discard(d);
    for (const g of this.glows) this.scene.remove(g.light);
    for (const f of this.fx) { this.scene.remove(f.obj); f.dispose(); }
    this.dice = [];
    this.throws = [];
    this.glows = [];
    this.fx = [];
    this.hand = null;
    this.slot = 0;
    this.dirty = true;
  }

  discard(d) {
    this.scene.remove(d.mesh);
    this.removeBody(d);
    if (d.ownMat) d.mesh.material.dispose();
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
    const kind = getKind(spec.sides, spec.tens ? 'tens' : 'normal');
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

  /** Drop a new die onto the table's staging row. Returns the die handle. */
  stage(spec) {
    const d = this.makeDie(spec);
    const { xHalf, zMax } = this.bounds;
    const gap = 2.7;
    const perRow = Math.max(1, Math.floor((2 * xHalf - 2) / gap));
    const i = this.slot++;
    d.body.position.set(
      -xHalf + 1.9 + (i % perRow) * gap + rand(-0.2, 0.2),
      2.2,
      zMax - 1.9 - Math.floor(i / perRow) * gap + rand(-0.2, 0.2)
    );
    d.body.quaternion.setFromEuler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
    d.body.angularVelocity.set(rand(-6, 6), rand(-6, 6), rand(-6, 6));
    d.state = 'staged';
    this.addBody(d);
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
    this.scene.add(d.mesh);
    this.dice.push(d);
    this.dirty = true;
    return d;
  }

  remove(d) {
    this.discard(d);
    this.dice = this.dice.filter((x) => x !== d);
    this.dirty = true;
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

  /** Scoop staged dice off the table and toss them into the middle (the Roll button). → Promise<number[]> */
  toss(dice) {
    const { xHalf, zMin, zMax } = this.bounds;
    const zc = (zMin + zMax) / 2 - 1;
    for (const d of dice) {
      const b = d.body;
      d.state = 'rolling';
      this.addBody(d);
      b.wakeUp();
      const dir = new CANNON.Vec3(rand(-xHalf * 0.5, xHalf * 0.5) - b.position.x, 0, zc + rand(-2, 2) - b.position.z);
      const speed = THREE.MathUtils.clamp(dir.length() * 2.2 + rand(3, 8), 6, 34);
      dir.normalize();
      b.velocity.set(dir.x * speed, rand(12, 17), dir.z * speed);
      b.angularVelocity.set(rand(-25, 25), rand(-25, 25), rand(-25, 25));
    }
    this.hooks.onThrow?.(0.7);
    return this.startThrow(dice);
  }

  startThrow(dice) {
    return new Promise((resolve) => {
      this.throws.push({ dice, resolve, elapsed: 0, still: 0, nudges: 0 });
    });
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
    this.hand = { dice, target, pos: target.clone(), samples: [{ t: performance.now(), p: target.clone() }] };
    this.dirty = true;
  }

  moveHand(cx, cy) {
    if (!this.hand) return;
    const now = performance.now();
    this.hand.target = this.pointerToHand(cx, cy);
    this.hand.samples.push({ t: now, p: this.hand.target.clone() });
    this.hand.samples = this.hand.samples.filter((s) => now - s.t < 150);
  }

  updateHand(dt, time) {
    const h = this.hand;
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

  /** Throw the held dice with the pointer's recent velocity. → Promise<number[]> */
  release() {
    const h = this.hand;
    if (!h) return Promise.resolve([]);
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
      const { body, mesh } = d;
      body.position.copy(mesh.position);
      body.quaternion.copy(mesh.quaternion);
      if (flung) body.velocity.set(vel.x * rand(0.9, 1.1), rand(-2, 2), vel.z * rand(0.9, 1.1));
      else body.velocity.set(rand(-4, 4), 0, rand(-4, 4)); // just a click: let it drop
      const s = 10 + speed * 0.8;
      body.angularVelocity.set(rand(-s, s), rand(-s, s), rand(-s, s));
      d.state = 'rolling';
      this.addBody(d);
      body.wakeUp();
    }
    this.hooks.onThrow?.(flung ? Math.min(1, speed / 35) : 0.2);
    return this.startThrow(h.dice);
  }

  /** Returns true once the throw has settled and its dice have been read. */
  checkThrow(th, dt) {
    th.elapsed += dt;
    const moving = th.dice.some((d) => d.body.velocity.length() > 0.12 || d.body.angularVelocity.length() > 0.25);
    th.still = moving ? 0 : th.still + dt;
    const timeout = th.elapsed > 9;
    if (!(timeout || (th.still > 0.3 && th.elapsed > 0.6))) return false;

    const reads = th.dice.map(readDie);
    const cocked = th.dice.filter((d, i) => !reads[i].flat);
    if (cocked.length && !timeout && th.nudges < 4) {
      // A die is leaning on another or a wall: give it a little hop.
      th.nudges++;
      th.still = 0;
      for (const d of cocked) {
        d.body.wakeUp();
        d.body.velocity.set(rand(-2, 2), rand(5, 8), rand(-2, 2));
        d.body.angularVelocity.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      }
      return false;
    }
    th.dice.forEach((d, i) => {
      d.value = reads[i].value;
      d.state = 'done';
      // Freeze rolled dice so later throws can't knock them onto a different face.
      const b = d.body;
      b.type = CANNON.Body.STATIC;
      b.mass = 0;
      b.updateMassProperties();
      b.velocity.setZero();
      b.angularVelocity.setZero();
    });
    th.resolve(reads.map((r) => r.value));
    return true;
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
      this.glows.push({ mat, light, t: 0, base: 16 });
      this.addFx(new Burst(at, { count: 180, color: 0xffc83d, speed: 20, up: 0.75, life: 1.7, size: 0.42, gravity: -24 }));
      this.addFx(new Burst(at, { count: 70, color: 0xffffff, speed: 11, up: 0.6, life: 1.1, size: 0.3, gravity: -18 }));
      this.addFx(new Shockwave(at, 0xffc83d, 0.9));
    } else if (state === 'fumble') {
      mat.color.setRGB(0.4, 0.3, 0.3);
      mat.emissive = new THREE.Color(0x550000);
      this.addFx(new Burst(at, { count: 90, color: 0xff2a2a, speed: 7, up: 0.35, life: 1.3, size: 0.34, gravity: -30 }));
      this.addFx(new Shockwave(at, 0xff2a2a, 0.7));
    }
    this.dirty = true;
  }
}
