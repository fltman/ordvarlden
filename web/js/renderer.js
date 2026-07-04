// renderer.js — WebGPU: device, pipeline, WGSL, draw. Se CONTRACT.md.
// Resemodell: två världsförankrade dioramor (A vid z=0, B vid z=-STATION_L) som
// kameran dollyar mellan, plus ett kameraförankrat fjärrfält (band ≥ FAR_CUT)
// som morphar A→B under resan. Ritas som ETT draw-call med 2 instanser:
// instans 0 = A-sidan + fjärrfältsmorph, instans 1 = B-sidan.
// Depth är strikt ordnad via per-form bias i bandflottalen (morph.js).

const UNIFORM_SIZE = 160; // 2×mat4x4f (128) + 4×f32 (16) + vec3f camPos + pad (16)

const SHADER = /* wgsl */ `
struct Uniforms {
  proj      : mat4x4f,
  view      : mat4x4f,
  t         : f32,
  time      : f32,
  speed     : f32,
  aspectRef : f32,
  camPos    : vec3f,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

// tan(FOV_Y/2) med FOV_Y = 55°
const TAN_HALF_FOV : f32 = 0.5205670505517462;
const STATION_L : f32 = 60.0;  // = planet.js STATION_L
const FAR_CUT   : f32 = 3.5;   // max(bandA,bandB) ≥ detta ⇒ kameraförankrad morph
const DROP      : f32 = 1.35;  // A-planen dyker under kameran när den hinner ikapp
                               // (>1.0 så att planets ovankant hinner under horisonten)
const RISE      : f32 = 0.9;   // B-sidan börjar sänkt och stiger över horisonten

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
};

@vertex
fn vs(
  @location(0) posA   : vec2f,
  @location(1) posB   : vec2f,
  @location(2) colorA : vec4f,   // unorm8x4 — flat färg, scen A
  @location(3) colorB : vec4f,   // unorm8x4 — flat färg, scen B
  @location(4) bandA  : f32,
  @location(5) bandB  : f32,
  @builtin(instance_index) inst : u32,
) -> VSOut {
  var out : VSOut;

  if (max(bandA, bandB) >= FAR_CUT) {
    // Fjärrfält (himmel/galaxer): följer kameran, morphar A→B under resan.
    if (inst == 1u) {
      out.pos = vec4f(0.0, 0.0, 2.0, 1.0); // utanför clip — ingen dubblett
      out.color = vec3f(0.0);
      return out;
    }
    let p = mix(posA, posB, u.t);
    let b = mix(bandA, bandB, u.t);
    let d = 6.0 * pow(1.9, b);
    let s = d * TAN_HALF_FOV * 1.12; // lätt överskala döljer scenkanterna vid look-around
    let world = u.camPos + vec3f(p.x * s, p.y * s, -d);
    out.pos = u.proj * u.view * vec4f(world, 1.0);
    out.color = mix(colorA.rgb, colorB.rgb, u.t);
    return out;
  }

  if (inst == 0u) {
    // A:s diorama, förankrad vid station 0. Varje plan dyker under kameran
    // lagom när dollyn når det — vi rusar ÖVER världen, aldrig igenom den.
    let d = 6.0 * pow(1.9, bandA);
    let s = d * TAN_HALF_FOV;
    let duck = DROP * s * pow(clamp(STATION_L * u.t / d, 0.0, 2.0), 0.7);
    let world = vec3f(posA.x * s, posA.y * s - duck, -d);
    out.pos = u.proj * u.view * vec4f(world, 1.0);
    out.color = colorA.rgb;
  } else {
    // B:s diorama, förankrad vid station STATION_L; stiger upp över horisonten.
    let d = 6.0 * pow(1.9, bandB);
    let s = d * TAN_HALF_FOV;
    let world = vec3f(posB.x * s, posB.y * s - RISE * s * (1.0 - u.t), -(STATION_L + d));
    out.pos = u.proj * u.view * vec4f(world, 1.0);
    out.color = colorB.rgb;
  }
  return out;
}

@fragment
fn fs(v : VSOut) -> @location(0) vec4f {
  // Flat färg rakt av; duotone-mappningen för gråscener görs i morph.js.
  return vec4f(v.color, 1.0);
}
`;

// Efterbehandling: radiell fartoskärpa (zoom blur) mot kanterna, styrka ∝ u.speed.
// Skarpt centrum, streck utåt i kanterna — förstärker rusningskänslan.
const POST_SHADER = /* wgsl */ `
struct Uniforms {
  proj      : mat4x4f,
  view      : mat4x4f,
  t         : f32,
  time      : f32,
  speed     : f32,
  aspectRef : f32,
  camPos    : vec3f,
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
  // Fullskärmstriangel utan vertexbuffert.
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
  // kantvikt: 0 i mitten, 1 i hörnen (aspektkorrigerad radie)
  let r = length(dir * vec2f(1.78, 1.0)) / 1.02;
  let edge = smoothstep(0.18, 0.85, r);
  let amount = 0.10 * clamp(u.speed, 0.0, 1.2) * edge;
  // textureSampleLevel: samplingsbar i icke-uniform kontrollflöde (ingen derivata)
  var acc = vec3f(0.0);
  for (var i = 0; i < TAPS; i++) {
    let k = amount * (f32(i) / f32(TAPS));
    acc += textureSampleLevel(scene, samp, v.uv - dir * k, 0.0).rgb;
  }
  return vec4f(acc / f32(TAPS), 1.0);
}
`;

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU stöds inte i den här webbläsaren. ' +
        'Prova senaste Chrome, Edge eller Safari.'
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        'Ingen WebGPU-adapter hittades. Kontrollera att grafikdrivrutiner ' +
        'är uppdaterade och att WebGPU är aktiverat.'
      );
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Kunde inte skapa WebGPU-kontext för canvasen.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new Renderer(canvas, device, context, format);
  }

  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;

    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.indexCount = 0;

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformArray = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformF32 = new Float32Array(this.uniformArray);

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // posA
            { shaderLocation: 1, offset: 8,  format: 'float32x2' }, // posB
            { shaderLocation: 2, offset: 16, format: 'unorm8x4' },  // colorA
            { shaderLocation: 3, offset: 20, format: 'unorm8x4' },  // colorB
            { shaderLocation: 4, offset: 24, format: 'float32' },   // bandA
            { shaderLocation: 5, offset: 28, format: 'float32' },   // bandB
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      multisample: { count: 4 },
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
    this.postBindGroup = null; // skapas i _createTargets (behöver sceneTexture)

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
      size: [w, h],
      format: 'depth24plus',
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaaTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // MSAA-resolve landar här; efterbehandlingen läser den som textur.
    this.sceneTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
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

  setMesh({ vertexData, indexData }) {
    if (this.vertexBuffer) this.vertexBuffer.destroy();
    if (this.indexBuffer) this.indexBuffer.destroy();

    this.vertexBuffer = this.device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);

    this.indexBuffer = this.device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, indexData);

    this.indexCount = indexData.length;
  }

  setUniforms({ proj, view, t, time, speed, aspectRef, camPos }) {
    const f = this.uniformF32;
    f.set(proj, 0);      // byte 0..63
    f.set(view, 16);     // byte 64..127
    f[32] = t;
    f[33] = time;
    f[34] = speed;
    f[35] = aspectRef;
    if (camPos) { f[36] = camPos[0]; f[37] = camPos[1]; f[38] = camPos[2]; }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformArray);
  }

  resize(w, h) {
    w = Math.floor(w);
    h = Math.floor(h);
    if (w <= 0 || h <= 0) return;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._createTargets(w, h);
  }

  render() {
    if (!this.indexCount) return;
    // Skyddsnät: om canvasen ändrats utan resize()-anrop måste targets matcha.
    const w = this.canvas.width, h = this.canvas.height;
    if (w <= 0 || h <= 0) return;
    if (w !== this._targetW || h !== this._targetH) this._createTargets(w, h);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTexture.createView(),
        resolveTarget: this.sceneTexture.createView(),
        clearValue: { r: 10 / 255, g: 10 / 255, b: 18 / 255, a: 1 }, // #0a0a12
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
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount, 2); // instans 0 = A + fjärrfält, 1 = B
    pass.end();

    // Efterbehandling: radiell fartoskärpa mot kanterna -> swapchain.
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
