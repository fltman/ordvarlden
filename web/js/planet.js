// planet.js — kamera-/världsmatematik för Ordvärlden. Ren matematik, inga GPU-anrop.
// Körbar även i Node (tools/test_planet.mjs).

export const BANDS = { D0: 6.0, F: 1.9, COUNT: 5 };
export const FOV_Y = 55 * Math.PI / 180;
export const STATION_L = 60; // världsenheter mellan två ordstationer (= WGSL STATION_L)

export function bandDistance(b) {
  return BANDS.D0 * Math.pow(BANDS.F, b);
}

// Perspektivprojektion för WebGPU-clipspace: djup 0..1, right-handed,
// kameran tittar mot -Z. Kolumn-major Float32Array(16) (som WGSL mat4x4f).
export function makeProjection(aspectCanvas, near = 0.1, far = 400) {
  const f = 1 / Math.tan(FOV_Y / 2);
  const rangeInv = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspectCanvas;
  m[5] = f;
  m[10] = far * rangeInv;
  m[11] = -1;
  m[14] = near * far * rangeInv;
  return m;
}

// Vy-matris = inversen av kameratransformen.
// Kameran: position (swayX, bobY+swayY, posZ), roterad yaw kring Y, sedan pitch
// kring X, sist roll kring blickaxeln (Z).
// C = T(p) * Ry(yaw) * Rx(pitch) * Rz(roll)  =>  V = Rz(-roll) * Rx(-pitch) * Ry(-yaw) * T(-p).
export function makeView(cam) {
  const { yaw = 0, pitch = 0, swayX = 0, swayY = 0, bobY = 0, posZ = 0, roll = 0 } = cam || {};
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const px = swayX, py = bobY + swayY, pz = posZ;

  // Rotationsdelen (radvis): [cy 0 -sy; sp*sy cp sp*cy; cp*sy -sp cp*cy]
  const m = new Float32Array(16);
  m[0] = cy;       m[4] = 0;   m[8] = -sy;
  m[1] = sp * sy;  m[5] = cp;  m[9] = sp * cy;
  m[2] = cp * sy;  m[6] = -sp; m[10] = cp * cy;
  // Translation: -R * p
  m[12] = -(m[0] * px + m[4] * py + m[8] * pz);
  m[13] = -(m[1] * px + m[5] * py + m[9] * pz);
  m[14] = -(m[2] * px + m[6] * py + m[10] * pz);
  m[15] = 1;

  if (roll !== 0) {
    // V' = Rz(-roll) * V — rullar vyrymden kring blickaxeln (barrel roll).
    const cr = Math.cos(roll), sr = Math.sin(roll);
    for (let c = 0; c < 4; c++) {
      const a = m[c * 4], b = m[c * 4 + 1];
      m[c * 4] = cr * a + sr * b;
      m[c * 4 + 1] = -sr * a + cr * b;
    }
  }
  return m;
}

const ACCEL = 0.6;       // stationer/s² vid full gas
const MAX_SPEED = 0.45;  // stationer/s
const FRICTION = 0.9;    // exponentiell dämpning per sekund
const STOP_EPS = 0.002;  // under detta (utan gas) snäpper farten till 0

export class Journey {
  constructor() {
    this.stations = 1;
    this.pos = 0;
    this.speed = 0;
  }

  setStations(n) {
    this.stations = Math.max(1, Math.floor(n) || 1);
    this.pos = ((this.pos % this.stations) + this.stations) % this.stations;
  }

  // throttle -1..1. Farten integreras med tröghet och glider av friktion.
  update(dt, throttle) {
    const th = Math.max(-1, Math.min(1, throttle || 0));
    this.speed += th * ACCEL * dt;
    this.speed *= Math.exp(-FRICTION * dt);
    this.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, this.speed));
    if (th === 0 && Math.abs(this.speed) < STOP_EPS) this.speed = 0;
    this.pos = (this.pos + this.speed * dt) % this.stations;
    if (this.pos < 0) this.pos += this.stations;
    return { pos: this.pos, speed: this.speed };
  }

  get segment() {
    const n = this.stations;
    if (n === 1) return { a: 0, b: 0, t: 0 };
    const a = Math.floor(this.pos) % n;
    return { a, b: (a + 1) % n, t: this.pos - Math.floor(this.pos) };
  }
}
