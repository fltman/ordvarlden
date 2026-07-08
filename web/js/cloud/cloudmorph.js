// cloudmorph.js — bygger GPU-färdig instansbuffert för en molnmorph A→B.
//
// Båda molnen har samma antal partiklar (CLOUD_N) och är sorterade efter
// luminans (imagecloud.js). Instans i binder ihop rang-i från A med rang-i från
// B: partikeln bär sin A-position/-färg och sitt B-mål. Vertexshadern (particles.js)
// interpolerar position och färg och lägger på en 3D-explosion mitt i resan.
//
// Instansformat (FRUSET, 24 byte/instans — stepMode 'instance'):
//   posA   : float32x2   (xn, yn scen A)     offset 0
//   posB   : float32x2   (xn, yn scen B)     offset 8
//   colorA : unorm8x4    (RGBA-packad, A)    offset 16
//   colorB : unorm8x4    (RGBA-packad, B)    offset 20

export const INSTANCE_STRIDE = 24; // byte

// A/B är moln från imagecloud.js. Returnerar { instanceData, count, aspect }.
export function buildPair(cloudA, cloudB) {
  const N = Math.min(cloudA.N, cloudB.N); // alltid lika (fast rutnät); säkerhetsmin
  const data = new Float32Array(N * 6);
  const u32 = new Uint32Array(data.buffer);
  const pa = cloudA.pos, ca = cloudA.col;
  const pb = cloudB.pos, cb = cloudB.col;

  for (let i = 0; i < N; i++) {
    const o = i * 6;
    data[o]     = pa[i * 2];
    data[o + 1] = pa[i * 2 + 1];
    data[o + 2] = pb[i * 2];
    data[o + 3] = pb[i * 2 + 1];
    u32[o + 4]  = ca[i];
    u32[o + 5]  = cb[i];
  }

  return { instanceData: data, count: N, aspect: cloudA.aspect };
}
