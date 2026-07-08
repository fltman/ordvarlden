// particles.js — WebGPU-renderare för morphande 3D-partikelmoln.
//
// Ett draw-call: 6 vertex (en quad) × N instanser (en per partikel). Varje
// instans bär posA/posB och colorA/colorB (cloudmorph.js). Vertexshadern:
//   • interpolerar position (ease) och färg A→B med morph-t,
//   • lyfter partikeln ur bildplanet med en relief ur luminans (statiskt djup),
//   • båglyfter molnet i 3D mitt i resan (burst = sin(pi·t), 0 vid båda ändar
//     ⇒ sömlös överlämning): lyftet är DJUP-tungt (mot kameran) och viktat mot
//     hur långt partikeln reser, så tysta ytor står still och stora förflyttningar
//     bågnar upp — formen anas hela vägen i stället för att bli en snöglob,
//   • vrider molnet lätt (swirl) och billboardar en mjuk rund sprite i vy-rymden.
// Runda kanter via MSAA alpha-to-coverage (ingen blandningsordning att bråka om).
// Efterbehandling: radiell fartoskärpa mot kanterna (∝ fart), som i vektorversionen.

const UNIFORM_SIZE = 192; // 2×mat4x4f (128) + 4×vec4f (64)

const SHADER = /* wgsl */ `
struct Uniforms {
  proj    : mat4x4f,
  view    : mat4x4f,
  params0 : vec4f,   // t, time, speed, (spare)
  params1 : vec4f,   // particleSize, relief, dist, push
  params2 : vec4f,   // explodeXY, explodeZ, swirl, sizeBurst
  params3 : vec4f,   // sway, (spare×3)
};
@group(0) @binding(0) var<uniform> u : Uniforms;

const PI : f32 = 3.14159265359;
const TAN_HALF_FOV : f32 = 0.5205670505517462; // tan(55°/2), = planet.js FOV_Y
const LW : vec3f = vec3f(0.2126, 0.7152, 0.0722);

const QUAD = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f( 1.0, 1.0),
);

// Billig hash instans → [0,1)^3 (deterministisk per partikelindex ⇒ inget popp).
fn hash3(i : u32) -> vec3f {
  var n = i * 747796405u + 2891336453u;
  n = (n ^ (n >> 16u)) * 2246822519u;
  let a = f32(n & 1023u) / 1023.0;
  n = n * 277803737u;
  let b = f32((n >> 10u) & 1023u) / 1023.0;
  n = n * 668265263u;
  let c = f32((n >> 20u) & 1023u) / 1023.0;
  return vec3f(a, b, c);
}

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
  @location(1) color : vec3f,
};

@vertex
fn vs(
  @builtin(vertex_index)   vi : u32,
  @builtin(instance_index) ii : u32,
  @location(0) posA   : vec2f,
  @location(1) posB   : vec2f,
  @location(2) colorA : vec4f,   // unorm8x4
  @location(3) colorB : vec4f,   // unorm8x4
) -> VSOut {
  var out : VSOut;

  let t         = u.params0.x;
  let time      = u.params0.y;
  let pSize     = u.params1.x;
  let relief    = u.params1.y;
  let dist      = u.params1.z;
  let push      = u.params1.w;
  let explodeXY = u.params2.x;
  let explodeZ  = u.params2.y;
  let swirl     = u.params2.z;
  let sizeBurst = u.params2.w;
  let swayAmp   = u.params3.x;

  let te = t * t * (3.0 - 2.0 * t);           // mjuk morph-ease (position & färg)

  // Statiskt djup ur luminans ⇒ molnet är ett relief, inte ett platt kort.
  let lA = dot(colorA.rgb, LW);
  let lB = dot(colorB.rgb, LW);
  let z0 = mix(lA - 0.5, lB - 0.5, te) * relief;
  var p = vec3f(mix(posA, posB, te), z0);

  // Resan mitt i morphen (0 vid t=0/1, max vid t=0.5).
  let burst = sin(PI * t);
  let travel = length(posB - posA);
  let h = hash3(ii) * 2.0 - 1.0;              // [-1,1]^3

  // Symmetriskt djup-svall (vissa närmare, vissa längre bort → ett pösande
  // 3D-skal, aldrig förbi kameran), magnitud viktad mot förflyttning + en
  // liten nettobula mot kameran så resan känns som en dykning.
  p.z += burst * (explodeZ * h.z * (0.5 + travel) + 0.15 * explodeZ);
  // Liten shimmer i bildplanet (håller formen, ger liv).
  p.x += h.x * burst * explodeXY;
  p.y += h.y * burst * explodeXY;

  // Vrid molnet lätt i bildplanet mitt i resan.
  let tw = burst * swirl;
  let cw = cos(tw);
  let sw = sin(tw);
  p = vec3f(cw * p.x - sw * p.y, sw * p.x + cw * p.y, p.z);

  // Mjuk gungning kring Y för liv/parallax (aldrig kant-på).
  let ang = sin(time * 0.5) * swayAmp + sin(time * 0.17) * swayAmp * 0.5;
  let ca = cos(ang);
  let sa = sin(ang);
  p = vec3f(ca * p.x + sa * p.z, p.y, -sa * p.x + ca * p.z);

  // Andas in mot mitten (0 vid ändarna). s = D·tan(fov/2) ⇒ molnet fyller vyns höjd.
  let D = dist - push * burst;
  let s = D * TAN_HALF_FOV;
  let world = vec3f(p.x * s, p.y * s, -D + p.z * s);

  // Billboard i vy-rymd: transformera centrum, lägg quad-hörnet i x/y.
  var vc = (u.view * vec4f(world, 1.0)).xyz;
  let sz = pSize * (1.0 + sizeBurst * burst);
  let corner = QUAD[vi];
  vc = vc + vec3f(corner * sz, 0.0);

  out.pos = u.proj * vec4f(vc, 1.0);
  out.local = corner;
  out.color = mix(colorA.rgb, colorB.rgb, te);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  let a = 1.0 - smoothstep(0.6, 1.0, d);       // mjuk rund kant (→ MSAA-täckning)
  if (a <= 0.003) { discard; }
  return vec4f(in.color, a);
}
`;

// Efterbehandling: radiell fartoskärpa (zoom blur) mot kanterna, ∝ fart.
const POST_SHADER = /* wgsl */ `
struct Uniforms {
  proj    : mat4x4f,
  view    : mat4x4f,
  params0 : vec4f,
  params1 : vec4f,
  params2 : vec4f,
  params3 : vec4f,
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var scene : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var out : VSOut;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

const TAPS : i32 = 8;

@fragment
fn fs(v : VSOut) -> @location(0) vec4f {
  let center = vec2f(0.5, 0.5);
  let dir = v.uv - center;
  let r = length(dir * vec2f(1.78, 1.0)) / 1.02;
  let edge = smoothstep(0.18, 0.85, r);
  let speed = u.params0.z;
  let amount = 0.12 * clamp(speed, 0.0, 1.2) * edge;
  var acc = vec3f(0.0);
  for (var i = 0; i < TAPS; i++) {
    let k = amount * (f32(i) / f32(TAPS));
    acc += textureSampleLevel(scene, samp, v.uv - dir * k, 0.0).rgb;
  }
  return vec4f(acc / f32(TAPS), 1.0);
}
`;

const CLEAR = { r: 8 / 255, g: 8 / 255, b: 14 / 255, a: 1 }; // #08080e

export class ParticleRenderer {
  static async create(canvas) {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU stöds inte i den här webbläsaren. Prova senaste Chrome, Edge eller Safari.'
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        'Ingen WebGPU-adapter hittades. Kontrollera grafikdrivrutiner och att WebGPU är aktiverat.'
      );
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Kunde inte skapa WebGPU-kontext för canvasen.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new ParticleRenderer(canvas, device, context, format);
  }

  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;

    this.instanceBuffer = null;
    this.instanceCount = 0;

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformArray = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformF32 = new Float32Array(this.uniformArray);
    // Standardvärden (main.js skriver över de fartberoende under resan).
    this.params = {
      particleSize: 0.028, relief: 0.18, dist: 8.0, push: 1.1,
      explodeXY: 0.14, explodeZ: 0.50, swirl: 0.35, sizeBurst: -0.15,
      sway: 0.10,
    };

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // posA
            { shaderLocation: 1, offset: 8,  format: 'float32x2' }, // posB
            { shaderLocation: 2, offset: 16, format: 'unorm8x4' },  // colorA
            { shaderLocation: 3, offset: 20, format: 'unorm8x4' },  // colorB
          ],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      multisample: { count: 4, alphaToCoverageEnabled: true },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const postModule = device.createShaderModule({ code: POST_SHADER });
    this.postPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vs' },
      fragment: { module: postModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.postSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.postBindGroup = null;

    this.depthTexture = null;
    this.msaaTexture = null;
    this.sceneTexture = null;
    this._targetW = 0;
    this._targetH = 0;
    this._createTargets(canvas.width || 1, canvas.height || 1);
  }

  _createTargets(w, h) {
    if (w <= 0 || h <= 0) return;
    if (this.depthTexture) this.depthTexture.destroy();
    if (this.msaaTexture) this.msaaTexture.destroy();
    if (this.sceneTexture) this.sceneTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h], format: 'depth24plus', sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaTexture = this.device.createTexture({
      size: [w, h], format: this.format, sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sceneTexture = this.device.createTexture({
      size: [w, h], format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.postBindGroup = this.device.createBindGroup({
      layout: this.postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: this.sceneTexture.createView() },
      ],
    });
    this._targetW = w;
    this._targetH = h;
  }

  setInstances({ instanceData, count }) {
    if (this.instanceBuffer) this.instanceBuffer.destroy();
    this.instanceBuffer = this.device.createBuffer({
      size: instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.instanceBuffer, 0, instanceData);
    this.instanceCount = count;
  }

  setParams(p) { Object.assign(this.params, p); }

  setUniforms({ proj, view, t, time, speed }) {
    const f = this.uniformF32;
    f.set(proj, 0);   // byte 0..63
    f.set(view, 16);  // byte 64..127
    f[32] = t;
    f[33] = time;
    f[34] = speed;
    f[35] = 0;
    const p = this.params;
    f[36] = p.particleSize; f[37] = p.relief; f[38] = p.dist; f[39] = p.push;
    f[40] = p.explodeXY; f[41] = p.explodeZ; f[42] = p.swirl; f[43] = p.sizeBurst;
    f[44] = p.sway; f[45] = 0; f[46] = 0; f[47] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformArray);
  }

  resize(w, h) {
    w = Math.floor(w); h = Math.floor(h);
    if (w <= 0 || h <= 0) return;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._createTargets(w, h);
  }

  render() {
    if (!this.instanceCount) return;
    const w = this.canvas.width, h = this.canvas.height;
    if (w <= 0 || h <= 0) return;
    if (w !== this._targetW || h !== this._targetH) this._createTargets(w, h);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTexture.createView(),
        resolveTarget: this.sceneTexture.createView(),
        clearValue: CLEAR,
        loadOp: 'clear',
        storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(6, this.instanceCount);
    pass.end();

    const post = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    post.setPipeline(this.postPipeline);
    post.setBindGroup(0, this.postBindGroup);
    post.draw(3);
    post.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
