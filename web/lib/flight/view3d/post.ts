/**
 * STEP 3 — the flight view's post stack. Built only from official three.js passes (three@0.187, already a dependency):
 *
 *   WebGL 2, full preset (desktop):
 *     SSRPass (examples/jsm/postprocessing) — renders the scene itself (beauty + depth + normals + metalness) and
 *       traces screen-space reflections on the ship's chrome only (`selects` = hull/chrome/dark meshes), so the fins
 *       show in the body and the body in the fins. Nothing else in the flight is a 3D surface: the floor, city and
 *       plate lights live in the environment map, so SSR cannot sharpen those (see the PR notes).
 *     GTAOPass — ground-truth AO, sharing SSRPass's depth + normals (no extra scene render), low intensity: contact
 *       shadow at fin roots, the skirt and the bell.
 *     ShaderPass "punch" — a filmic contrast curve (log-space, around 18% grey) on the SHIP LAYER ONLY (weighted by
 *       the layer's alpha), before tone mapping. The sky is a different canvas (canvas.f3d-bg) and never passes here.
 *     UnrealBloomPass — tight: strength ~0.01, radius 0, threshold 2.5, input capped at 3 (same values and same
 *       high-pass patch as the accepted look-dev page) so only real highlights (moon glints, city streaks, flame) glow.
 *     OutputPass — ACES filmic tone mapping (renderer.toneMapping, per-world exposure) + sRGB, alpha preserved.
 *   WebGL 2, lite preset (phones, ?gfx=lite): RenderPass → punch → light bloom → OutputPass (no SSR / AO).
 *   WebGPU: RenderPipeline (three/webgpu) + TSL: pass() → punch → bloom() (same cap) → ACES at output; on the full
 *     preset also the TSL ssr() node (examples/jsm/tsl/display/SSRNode) on the chrome.
 *
 * Not used, on purpose: motion blur (the camera never moves; the ship's own motion is already sold by the flame,
 * contrail and streaks), SSGI (an all-metal ship has no diffuse to bounce), path tracing (out of scope), and
 * 0beqz/realism-effects (built on pmndrs/postprocessing for three ≤ r15x; it is not in the repo or its history, and
 * the official passes above cover SSR / AO / bloom / tone mapping without a second effect framework). Reference for
 * the stack and the quality bar: abhayexe/three.js-unreal (UnrealBloom + SSR + AO + ACES on official passes).
 *
 * LAUNCH PAD 3D world (launchpad.ts): rendered as its own scene into a render target and composited UNDER this stack's
 *   final output (after OutputPass / renderOutput): out = ship + world·k·(1 − ship.a). So the world never passes through
 *   the ship's punch, bloom or ACES (it is authored in display range), and the ship's look is exactly as signed off.
 *
 * Cost control: the heavy passes (SSR, AO) are the first thing the frame governor drops when a frame is over budget,
 * before it lowers resolution or skips frames. Nothing here ever waits on, or delays, the engine or a trade.
 */
import type { Object3D, PerspectiveCamera, Scene, Texture } from "three";
import type { View3DBackend, View3DQuality } from "./detect";

export type PostKind = "full" | "lite" | "off";
export type FlightPost = {
  kind: PostKind;
  /** SSR + AO on (full only); the governor flips this */
  heavy: boolean;
  setHeavy: (on: boolean) => void;
  render: () => void;
  setSize: (w: number, h: number) => void;
  setPixelRatio: (r: number) => void;
  /** filmic contrast on the ship layer for this world (1 = none) */
  setPunch: (k: number) => void;
  /** the Launch Pad 3D world under the ship (WebGL: its render target's texture; WebGPU: the pass is built in), k = 0..1 */
  setWorld: (tex: Texture | null, k: number) => void;
  dispose: () => void;
};

export const POST = {
  bloom: { full: 0.012, lite: 0.008 }, threshold: 2.5, cap: 3.0, radius: 0.0,
  /** bloom INPUT gain for the exhaust off the hull. The flame, nozzle glow and sparks are additive and leave the layer's
   *  alpha at 0 over the sky, so they're weighted down here; the hull (alpha 1) keeps the full gain, so its bloom stays as tight
   *  as before. This keeps the flame's glow from spreading a wide soft disc over the lower hull and the sky. */
  flameBloom: 0.2,
  /** filmic "punch": out = pivot·(in/pivot)^k on the ship layer, before ACES */
  pivot: 0.18,
  ao: 0.55,
  ssr: { opacity: 0.5, maxDistance: 140, thickness: 0.7 },
};

/** `?f3dpost=off|lite|full` — A/B for review stills; otherwise the preset decides. */
export function pickPost(search: string, quality: View3DQuality): PostKind {
  const q = new URLSearchParams(search).get("f3dpost");
  if (q === "off" || q === "lite" || q === "full") return q;
  return quality === "lite" ? "lite" : "full";
}

const PUNCH_FRAG = `
uniform sampler2D tDiffuse; uniform float k; uniform float pivot; varying vec2 vUv;
void main() {
  vec4 t = texture2D( tDiffuse, vUv );
  // the ship's pixels are opaque (a ≈ 1); additive glow (flame, sparks) and edges keep their colour untouched
  float w = smoothstep( 0.6, 1.0, t.a );
  vec3 c = max( t.rgb, vec3( 0.0 ) );
  vec3 g = pivot * pow( c / pivot + 1e-6, vec3( k ) );
  gl_FragColor = vec4( mix( t.rgb, g, w ), t.a );
}`;

/** world under the ship, after the ship's output transform: world is linear (render target) → sRGB, premultiplied by k */
const UNDER_FRAG = `
uniform sampler2D tDiffuse; uniform sampler2D tWorld; uniform float k; varying vec2 vUv;
vec3 oetf( vec3 c ) { c = max( c, vec3( 0.0 ) ); return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) ); }
void main() {
  vec4 s = texture2D( tDiffuse, vUv ); float a = clamp( s.a, 0.0, 1.0 );
  vec3 w = oetf( texture2D( tWorld, vUv ).rgb );
  gl_FragColor = vec4( s.rgb + w * k * ( 1.0 - a ), a + k * ( 1.0 - a ) );
}`;

export async function makePost(o: {
  renderer: unknown; backend: View3DBackend; kind: PostKind; scene: Scene; camera: PerspectiveCamera;
  ship: Object3D[]; width: number; height: number; ratio: number;
  /** the Launch Pad 3D world (WebGPU builds its pass into the pipeline; WebGL gets its texture per frame) */
  world?: { scene: Scene; camera: PerspectiveCamera } | null;
}): Promise<FlightPost | null> {
  if (o.kind === "off") return null;
  return o.backend === "webgpu" ? makeGPU(o) : makeGL(o);
}

async function makeGL(o: Parameters<typeof makePost>[0]): Promise<FlightPost> {
  const THREE = await import("three");
  const { EffectComposer } = await import("three/examples/jsm/postprocessing/EffectComposer.js");
  const { RenderPass } = await import("three/examples/jsm/postprocessing/RenderPass.js");
  const { ShaderPass } = await import("three/examples/jsm/postprocessing/ShaderPass.js");
  const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
  const { OutputPass } = await import("three/examples/jsm/postprocessing/OutputPass.js");
  const renderer = o.renderer as import("three").WebGLRenderer;
  const full = o.kind === "full";
  // half-float, MSAA on the full preset (the composer's targets replace the canvas' own antialiasing)
  const rt = new THREE.WebGLRenderTarget(o.width, o.height, { type: THREE.HalfFloatType, samples: full ? 4 : 0 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(o.ratio); composer.setSize(o.width, o.height);

  const rp = new RenderPass(o.scene, o.camera);
  rp.clearAlpha = 0;
  composer.addPass(rp);
  type SSR = InstanceType<typeof import("three/examples/jsm/postprocessing/SSRPass.js").SSRPass>;
  type GTAO = InstanceType<typeof import("three/examples/jsm/postprocessing/GTAOPass.js").GTAOPass>;
  let ssr: SSR | null = null, gtao: GTAO | null = null;
  if (full) {
    const { SSRPass } = await import("three/examples/jsm/postprocessing/SSRPass.js");
    const { GTAOPass } = await import("three/examples/jsm/postprocessing/GTAOPass.js");
    const meshes: import("three").Mesh[] = [];
    // only the metal (chrome + dark metal), not the decal or anything matte
    for (const r of o.ship) r.traverse((x) => {
      const m = x as import("three").Mesh, mat = m.material as import("three").MeshStandardMaterial | undefined;
      if (m.isMesh && mat && !Array.isArray(mat) && (mat.metalness ?? 0) > 0.5) meshes.push(m);
    });
    ssr = new SSRPass({ renderer, scene: o.scene, camera: o.camera, width: o.width, height: o.height, selects: meshes, groundReflector: null });
    ssr.beautyRenderTarget.samples = 4;   // the beauty is the frame: keep it antialiased
    ssr.opacity = POST.ssr.opacity; ssr.maxDistance = POST.ssr.maxDistance; ssr.thickness = POST.ssr.thickness;
    ssr.infiniteThick = false; ssr.fresnel = true; ssr.distanceAttenuation = true; ssr.blur = true; ssr.bouncing = false;
    composer.addPass(ssr);
    gtao = new GTAOPass(o.scene, o.camera, o.width, o.height, { depthTexture: ssr.beautyRenderTarget.depthTexture ?? undefined, normalTexture: ssr.normalRenderTarget.texture });
    gtao.blendIntensity = POST.ao;
    gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1, thickness: 2, scale: 1, samples: 12 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 12 });
    composer.addPass(gtao);
    rp.enabled = false;   // SSRPass draws the beauty itself
  }
  const punch = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, k: { value: 1 }, pivot: { value: POST.pivot } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: PUNCH_FRAG,
  });
  composer.addPass(punch);
  const bp = new UnrealBloomPass(new THREE.Vector2(o.width, o.height), full ? POST.bloom.full : POST.bloom.lite, POST.radius, POST.threshold);
  // same input cap as the look-dev page: a mirror catching a ~5000-nit highlight must not flood the frame
  bp.materialHighPassFilter.fragmentShader = bp.materialHighPassFilter.fragmentShader.replace(
    "gl_FragColor = mix( outputColor, texel, alpha );",
    `gl_FragColor = min( mix( outputColor, texel, alpha ) * mix( ${POST.flameBloom.toFixed(3)}, 1.0, smoothstep( 0.6, 1.0, texel.a ) ), vec4( vec3( ${POST.cap.toFixed(3)} ), 1.0 ) );`);
  bp.materialHighPassFilter.needsUpdate = true;
  composer.addPass(bp);
  composer.addPass(new OutputPass());
  const VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }";
  const under = new ShaderPass({ uniforms: { tDiffuse: { value: null }, tWorld: { value: null }, k: { value: 0 } }, vertexShader: VS, fragmentShader: UNDER_FRAG });
  under.enabled = false;   // off = OutputPass is the last pass, exactly as before
  composer.addPass(under);

  const post: FlightPost = {
    kind: o.kind, heavy: full,
    setHeavy: (on) => {
      if (!ssr || !gtao) return;
      post.heavy = on; ssr.enabled = on; gtao.enabled = on; rp.enabled = !on;
    },
    render: () => composer.render(),
    setSize: (w, h) => composer.setSize(w, h),
    setPixelRatio: (r) => composer.setPixelRatio(r),
    setPunch: (k) => { punch.uniforms.k.value = k; },
    setWorld: (tex, k) => { const on = !!tex && k > 0; under.enabled = on; under.uniforms.tWorld.value = on ? tex : null; under.uniforms.k.value = on ? k : 0; },
    dispose: () => { composer.dispose(); ssr?.dispose(); gtao?.dispose(); bp.dispose(); },
  };
  return post;
}

async function makeGPU(o: Parameters<typeof makePost>[0]): Promise<FlightPost> {
  const WGPU = await import("three/webgpu");
  const TSL = await import("three/tsl");
  const { bloom } = await import("three/examples/jsm/tsl/display/BloomNode.js");
  const renderer = o.renderer as InstanceType<typeof WGPU.WebGPURenderer>;
  const full = o.kind === "full";
  const pipeline = new WGPU.RenderPipeline(renderer);
  const scenePass = TSL.pass(o.scene, o.camera);
  const kU = TSL.uniform(1), pivot = TSL.float(POST.pivot);
  let color = scenePass.getTextureNode("output") as unknown as ReturnType<typeof TSL.vec4>;
  let ssrNode: { dispose?: () => void } | null = null;
  const ssrU = TSL.uniform(full ? 1 : 0);
  if (full) {
    try {
      const { ssr } = await import("three/examples/jsm/tsl/display/SSRNode.js");
      scenePass.setMRT(TSL.mrt({ output: TSL.output, normal: TSL.directionToColor(TSL.normalView), metalrough: TSL.vec2(TSL.metalness, TSL.roughness) }));
      const nTex = scenePass.getTextureNode("normal"), mr = scenePass.getTextureNode("metalrough");
      const n = TSL.sample((uv) => TSL.colorToDirection(nTex.sample(uv)));
      const s = ssr(color, scenePass.getTextureNode("depth"), n, { metalnessNode: mr.r, roughnessNode: mr.g, camera: o.camera } as never) as unknown as ReturnType<typeof TSL.vec4> & { dispose?: () => void };
      ssrNode = s;
      const base = color;
      // reflection over the beauty, by the SSR alpha, scaled like the WebGL path; off when the governor drops it
      color = TSL.vec4(TSL.mix(base.rgb, s.rgb, s.a.mul(POST.ssr.opacity).mul(ssrU)), base.a) as never;
    } catch (e) { console.warn("[flight 3d] TSL SSR unavailable, bloom + ACES only:", e); ssrNode = null; }
  }
  const w = TSL.smoothstep(0.6, 1.0, color.a);
  const graded = TSL.pow(TSL.max(color.rgb, TSL.vec3(0)).div(pivot).add(1e-6), TSL.vec3(kU)).mul(pivot);
  const punched = TSL.vec4(TSL.mix(color.rgb, graded, w), color.a);
  const cap = POST.cap;
  const bIn = TSL.vec4(punched.rgb.mul(TSL.mix(TSL.float(POST.flameBloom), TSL.float(1), w)), punched.a);
  const b = bloom(bIn.min(TSL.vec4(cap, cap, cap, 1)), full ? POST.bloom.full : POST.bloom.lite, POST.radius, POST.threshold);
  const shipOut = punched.add(TSL.vec4(b.rgb, 0));
  pipeline.outputNode = shipOut;
  // Launch Pad 3D world under the ship (built only when asked for; the pipeline switches between the two outputs)
  const worldK = TSL.uniform(0);
  let withWorld: unknown = null, worldOn = false;
  if (o.world) {
    try {
      const THREE = await import("three");
      const wp = TSL.pass(o.world.scene, o.world.camera);
      const ws = TSL.renderOutput(wp.getTextureNode("output"), THREE.NoToneMapping, THREE.SRGBColorSpace);
      const so = TSL.renderOutput(shipOut);
      const ia = TSL.float(1).sub(so.a.clamp(0, 1));
      withWorld = TSL.vec4(so.rgb.add(ws.rgb.mul(worldK).mul(ia)), so.a.clamp(0, 1).add(worldK.mul(ia)));
    } catch (e) { console.warn("[flight 3d] Launch Pad world unavailable on WebGPU:", e); withWorld = null; }
  }
  const post: FlightPost = {
    kind: o.kind, heavy: full && !!ssrNode,
    setHeavy: (on) => { if (!ssrNode) return; post.heavy = on; ssrU.value = on ? 1 : 0; },
    render: () => pipeline.render(),
    setSize: () => {}, setPixelRatio: () => {},
    setPunch: (k) => { kU.value = k; },
    setWorld: (_tex, k) => {
      const on = !!withWorld && k > 0; worldK.value = on ? k : 0;
      if (on === worldOn) return;
      worldOn = on;
      pipeline.outputNode = (on ? withWorld : shipOut) as typeof pipeline.outputNode;
      pipeline.outputColorTransform = !on;   // the world variant applies the ship's ACES + sRGB itself (renderOutput)
      pipeline.needsUpdate = true;
    },
    dispose: () => { try { ssrNode?.dispose?.(); pipeline.dispose(); } catch { /* ignore */ } },
  };
  return post;
}
