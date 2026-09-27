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

export class DiceTray {
  constructor(el) {
    this.el = el;
    this.dice = [];
    this.rolling = false;
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

    const floorBody = new CANNON.Body({ mass: 0, material: floorMat, shape: new CANNON.Plane() });
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
      if (this.rolling) {
        world.step(1 / 120, dt, 12);
        for (const d of this.dice) {
          d.mesh.position.copy(d.body.position);
          d.mesh.quaternion.copy(d.body.quaternion);
        }
        this.check(dt);
        this.dirty = true;
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

  clear() {
    for (const d of this.dice) {
      this.scene.remove(d.mesh);
      this.world.removeBody(d.body);
    }
    this.dice = [];
    this.dirty = true;
  }

  /** specs: [{ sides, tens? }] → Promise<number[]> (face values, d10 gives 1-10) */
  roll(specs) {
    this.clear();
    const { xHalf, zMin, zMax } = this.bounds;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const gap = 2.8;
    const perCol = Math.max(1, Math.floor((zMax - zMin - 2) / gap));
    const maxCols = Math.max(1, Math.floor((2 * xHalf - 3) / gap));
    const zc = (zMin + zMax) / 2;

    specs.forEach((s, i) => {
      const kind = getKind(s.sides, s.tens ? 'tens' : 'normal');
      const mesh = new THREE.Mesh(kind.geometry, kind.material);
      mesh.castShadow = true;
      mesh.add(new THREE.LineSegments(kind.edges, kind.edgeMat));
      const def = kind.def;
      const shape = new CANNON.ConvexPolyhedron({
        vertices: def.verts.map((v) => new CANNON.Vec3(v.x, v.y, v.z)),
        faces: def.faces.map((f) => f.idx),
      });
      const body = new CANNON.Body({
        mass: 1,
        material: this.diceMat,
        shape,
        linearDamping: 0.1,
        angularDamping: 0.12,
        sleepSpeedLimit: 0.15,
        sleepTimeLimit: 0.2,
      });
      const col = Math.floor(i / perCol), row = i % perCol;
      const inCol = Math.min(specs.length - col * perCol, perCol);
      body.position.set(
        -dir * (xHalf - 1.5 - (col % maxCols) * gap),
        rand(2, 4) + Math.floor(col / maxCols) * gap,
        zc + (row - (inCol - 1) / 2) * gap + rand(-0.3, 0.3)
      );
      body.quaternion.setFromEuler(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
      body.velocity.set(dir * rand(18, 30), rand(2, 6), rand(-7, 7));
      body.angularVelocity.set(rand(-25, 25), rand(-25, 25), rand(-25, 25));
      this.world.addBody(body);
      mesh.position.copy(body.position);
      mesh.quaternion.copy(body.quaternion);
      this.scene.add(mesh);
      this.dice.push({ def, mesh, body });
    });

    this.elapsed = 0;
    this.still = 0;
    this.nudges = 0;
    this.rolling = true;
    return new Promise((res) => (this.resolve = res));
  }

  check(dt) {
    this.elapsed += dt;
    const moving = this.dice.some(
      (d) => d.body.velocity.length() > 0.12 || d.body.angularVelocity.length() > 0.25
    );
    this.still = moving ? 0 : this.still + dt;
    const timeout = this.elapsed > 9;
    if (!(timeout || (this.still > 0.3 && this.elapsed > 0.6))) return;

    const reads = this.dice.map(readDie);
    const cocked = this.dice.filter((d, i) => !reads[i].flat);
    if (cocked.length && !timeout && this.nudges < 4) {
      // A die is leaning on another or a wall: give it a little hop.
      this.nudges++;
      this.still = 0;
      for (const d of cocked) {
        d.body.wakeUp();
        d.body.velocity.set(rand(-2, 2), rand(5, 8), rand(-2, 2));
        d.body.angularVelocity.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      }
      return;
    }
    this.rolling = false;
    this.resolve(reads.map((r) => r.value));
  }
}
