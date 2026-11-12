/**
 * Rocket look-dev studio (STEP 1 of the 3D flight work): the authored chrome rocket (public/lookdev/disciple-rocket.glb,
 * built in Blender with baked normal / roughness / metalness maps) large on screen, lit ONLY by a real photographed HDRI
 * (Poly Haven, CC0) → PMREMGenerator → scene.environment, with bloom and ACES filmic tone mapping.
 *
 * Not part of the game: no engine, no trades, no flight. WebGPU (three/webgpu + RenderPipeline/TSL bloom) when the
 * browser has it, else WebGL 2 (EffectComposer + UnrealBloomPass + OutputPass). ?renderer=webgl forces WebGL.
 *
 * Query params: hdri=<id> · exposure=<n> · sat=<n> · bloom=<strength> · bthresh=<n> · bcap=<n> · bradius=<n> · bg=studio|hdri|blur|plate
 *               view=front|three-quarter|low|underside|orbit · elev=<deg> · spin=0|1 · rot=<deg> · env=<intensity> · envrot=<deg>
 */
import type { Texture, Object3D, Scene, PerspectiveCamera } from "three";

const CC0 = { name: "CC0 1.0 (Poly Haven)", url: "https://polyhaven.com/license" } as const;
type Hdri = {
  file: string; title: string; kind: string; author: string; url: string; license: { name: string; url: string };
  exposure: number; envrot: number;
  /** saturation applied to the HDR pixels at load (1 = as shot); used only to neutralise a warm studio */
  sat?: number;
  /** extra thin vertical strip lights painted into the HDR (u = equirect x 0..1, w = width in degrees, i = radiance) */
  strips?: { u: number; w: number; i: number }[];
  bg: "studio" | "hdri" | "blur" | "plate"; bgrot?: number;
  /** the approved 16:9 backdrop, shown unchanged (cover-fit) when bg=plate */
  plate?: string;
  /** a real light matching the plate's brightest region (direction in the file's equirectUv frame, before envrot) */
  key?: { dir: [number, number, number]; color: string; intensity: number };
};
/** Lighting order per the brief: a real photographed studio HDRI to judge the metal first, then a real outdoor night sky
 *  (both Poly Haven, CC0), then DISCIPLE's own Launch Pad plate (BRAND env r1 — an LDR plate wrapped + highlight-boosted,
 *  not a true 360° HDRI; see /workspace/disciple-brand/mockups/flight-3d-lookdev-r1/env/README.md). */
export const HDRIS: Record<"ferndale_studio_07" | "ferndale_studio_01" | "rooftop_night" | "launch_pad", Hdri> = {
  // hero look-dev light (r2/r3): a dark studio with several structured sources (strip tubes, a big round softbox, practicals),
  // so the chrome shows a mix of thin and wide bands instead of two wide lobes. Its warm tungsten cast is neutralised
  // (sat 0.35) to judge the metal against the cool-neutral official sprite; the light's shape and intensity are as shot.
  // r3 adds 7 thin vertical strips of uneven width/spacing (see `strips`) for the match; ?strips=0 shows the bare photo.
  ferndale_studio_07: {
    file: "/lookdev/hdri/ferndale_studio_07_2k.hdr", title: "Ferndale Studio 07", kind: "studio, hero",
    author: "Dimitrios Savva (photography), Greg Zaal (processing)", url: "https://polyhaven.com/a/ferndale_studio_07", license: CC0,
    exposure: 0.9, envrot: 120, bg: "studio", sat: 0.35,
    strips: [
      { u: 0.03, w: 1.2, i: 18 }, { u: 0.11, w: 3.5, i: 12 }, { u: 0.31, w: 2.2, i: 15 }, { u: 0.44, w: 0.9, i: 21 },
      { u: 0.53, w: 4.0, i: 10.5 }, { u: 0.71, w: 1.6, i: 15 }, { u: 0.86, w: 2.8, i: 12 },
    ],
  },
  ferndale_studio_01: {
    file: "/lookdev/hdri/ferndale_studio_01_2k.hdr", title: "Ferndale Studio 01", kind: "studio, r1 single softbox",
    author: "Dimitrios Savva (photography), Jarod Guest (processing)", url: "https://polyhaven.com/a/ferndale_studio_01", license: CC0,
    exposure: 2.0, envrot: 200, bg: "studio",
  },
  rooftop_night: {
    file: "/lookdev/hdri/rooftop_night_2k.hdr", title: "Rooftop Night", kind: "outdoor night",
    author: "Greg Zaal", url: "https://polyhaven.com/a/rooftop_night", license: CC0,
    exposure: 0.6, envrot: 120, bg: "studio",
  },
  launch_pad: {
    file: "/lookdev/hdri/launch-pad.boost.hdr", title: "Launch Pad", kind: "DISCIPLE sky, BRAND plate r1",
    author: "DISCIPLE BRAND (from the approved t01 sky plate)", url: "/lookdev/hdri/launch-pad.boost.hdr",
    license: { name: "DISCIPLE brand asset", url: "/lookdev/hdri/launch-pad.boost.hdr" },
    // map centre faces +X: bgrot 90 puts the plate behind the ship; envrot -90 puts it behind the camera for the chrome
    exposure: 1.2, envrot: -90, bg: "plate", bgrot: 90, plate: "/lookdev/env/launch-pad.backdrop.jpg",
    key: { dir: [0.9006, 0.4345, 0.0119], color: "#fff3e6", intensity: 3 },
  },
};
export type HdriId = keyof typeof HDRIS;
export const DEFAULT_HDRI: HdriId = "ferndale_studio_07";

export type LookdevHandle = {
  ready: boolean; backend: "webgpu" | "webgl" | null; hdri: HdriId; error?: string;
  setRotation: (deg: number) => void; render: () => Promise<void>; frames: number;
};
declare global { interface Window { __lookdev?: LookdevHandle } }

const num = (q: URLSearchParams, k: string, d: number) => { const v = q.get(k); const n = v == null ? NaN : +v; return Number.isFinite(n) ? n : d; };

export async function startLookdev(canvas: HTMLCanvasElement, search: string): Promise<() => void> {
  const q = new URLSearchParams(search);
  const hdri = (q.get("hdri") as HdriId) in HDRIS ? (q.get("hdri") as HdriId) : DEFAULT_HDRI;
  const H0 = HDRIS[hdri];
  const exposure = num(q, "exposure", H0.exposure), bloomStrength = num(q, "bloom", 0.01), bloomThreshold = num(q, "bthresh", 2.5), bloomCap = num(q, "bcap", 3), bloomRadius = num(q, "bradius", 0.0), envI = num(q, "env", 1.0);
  const bgMode = q.get("bg") || H0.bg, view = q.get("view") || "front", spin = q.get("spin") === "1";
  const handle: LookdevHandle = { ready: false, backend: null, hdri, frames: 0, setRotation: () => {}, render: async () => {} };
  window.__lookdev = handle;

  const THREE = await import("three");
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { HDRLoader } = await import("three/examples/jsm/loaders/HDRLoader.js");

  // ---- renderer: WebGPU first, WebGL 2 fallback
  let backend: "webgpu" | "webgl" = "webgl";
  type R = { setSize: (w: number, h: number, s?: boolean) => void; setPixelRatio: (r: number) => void; toneMapping: number; toneMappingExposure: number; dispose: () => void; render: (s: Scene, c: PerspectiveCamera) => unknown };
  let renderer: R | null = null;
  let WGPU: typeof import("three/webgpu") | null = null;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (q.get("renderer") !== "webgl" && gpu) {
    try {
      const ad = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (ad) {
        WGPU = await import("three/webgpu");
        const r = new WGPU.WebGPURenderer({ canvas, antialias: true });
        await r.init();
        if ((r as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend) { renderer = r as unknown as R; backend = "webgpu"; }
        else r.dispose();
      }
    } catch (e) { console.warn("[lookdev] WebGPU failed, using WebGL 2", e); renderer = null; }
  }
  if (!renderer) renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }) as unknown as R;
  handle.backend = backend;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = exposure;
  const dpr = Math.min(2, devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 100);

  // ---- HDRI → PMREM → scene.environment (and the photo itself as the backdrop)
  const sat = num(q, "sat", H0.sat ?? 1);
  const hdr = (await new HDRLoader().setDataType(THREE.FloatType).loadAsync(H0.file)) as Texture & { image: { data: Float32Array } };
  if (sat !== 1) {   // neutralise colour casts (e.g. tungsten tubes) without touching the light's shape or intensity
    const d = hdr.image.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = l + sat * (d[i] - l); d[i + 1] = l + sat * (d[i + 1] - l); d[i + 2] = l + sat * (d[i + 2] - l);
    }
    hdr.needsUpdate = true;
  }
  const stripGain = num(q, "strips", 1);
  if (H0.strips && stripGain > 0) {
    // A few thin vertical softbox strips added to the real studio (look-dev only; not a dense grid). Uneven widths and
    // spacing so the chrome shows the official's mix of thin and wide bands. Soft top/bottom ends, ±50° elevation.
    const img = hdr.image as unknown as { data: Float32Array; width: number; height: number };
    const { data: d, width: W, height: Hh } = img;
    for (const st of H0.strips) {
      const half = (st.w / 360) * W * 0.5, cx = st.u * W;
      for (let y = 0; y < Hh; y++) {
        const el = 90 - (y / Hh) * 180; const ve = Math.max(0, 1 - Math.max(0, Math.abs(el) - 40) / 10);
        if (ve <= 0) continue;
        for (let x = Math.floor(cx - half - 2); x <= Math.ceil(cx + half + 2); x++) {
          const xx = ((x % W) + W) % W, dx = Math.abs(x + 0.5 - cx);
          const he = Math.max(0, Math.min(1, half + 0.75 - dx));   // ~1.5 px soft edge
          if (he <= 0) continue;
          const k = (xx + y * W) * 4, v = st.i * stripGain * ve * he;
          d[k] = Math.max(d[k], v); d[k + 1] = Math.max(d[k + 1], v); d[k + 2] = Math.max(d[k + 2], v);
        }
      }
    }
    hdr.needsUpdate = true;
  }
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  let pm: { fromEquirectangular: (t: Texture) => { texture: Texture }; dispose: () => void };
  if (backend === "webgpu" && WGPU) pm = new WGPU.PMREMGenerator(renderer as never) as never;
  else pm = new THREE.PMREMGenerator(renderer as never) as never;
  const envRT = pm.fromEquirectangular(hdr);
  scene.environment = envRT.texture; scene.environmentIntensity = envI;
  const envRotY = num(q, "envrot", H0.envrot) * Math.PI / 180; scene.environmentRotation.y = envRotY;
  scene.backgroundRotation.y = num(q, "bgrot", H0.bgrot ?? H0.envrot) * Math.PI / 180;
  if (H0.key) {   // the plate's moon/sun as a real light too (crisp nose + fin-edge highlights), rotated with the environment
    const k = H0.key, d = new THREE.Vector3(...k.dir).applyAxisAngle(new THREE.Vector3(0, 1, 0), envRotY);
    const light = new THREE.DirectionalLight(k.color, num(q, "key", k.intensity)); light.position.copy(d.multiplyScalar(10)); scene.add(light);
  }
  let plateTex: Texture | null = null;
  if (bgMode === "plate" && H0.plate) {
    plateTex = await new THREE.TextureLoader().loadAsync(H0.plate);
    plateTex.colorSpace = THREE.SRGBColorSpace; scene.background = plateTex;
  } else if (bgMode === "studio") scene.background = new THREE.Color(0x0b0b14);
  else { scene.background = hdr; scene.backgroundBlurriness = bgMode === "blur" ? 0.08 : 0; scene.backgroundIntensity = 0.85; }
  pm.dispose();

  // ---- the authored rocket
  const gltf = await new GLTFLoader().loadAsync("/lookdev/disciple-rocket.glb");
  const rocket: Object3D = gltf.scene;
  rocket.traverse((o) => {
    const m = (o as unknown as { material?: { side: number; envMapIntensity?: number; needsUpdate: boolean } }).material;
    if (m) { m.side = THREE.FrontSide; m.needsUpdate = true; }
  });
  const pivot = new THREE.Group(); pivot.add(rocket); scene.add(pivot);
  const box = new THREE.Box3().setFromObject(rocket), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  rocket.position.sub(new THREE.Vector3(mid.x, mid.y, mid.z));      // centre the model on the pivot
  const H = size.y;

  // ---- camera framing (a product shot: long lens, rocket fills ~80% of the height)
  const fit = (w: number, h: number) => {
    camera.aspect = w / h;
    if (plateTex) {   // cover-fit the 16:9 plate into the panel without stretching
      const ia = 16 / 9, ca = w / h;
      if (ca < ia) { plateTex.repeat.set(ca / ia, 1); plateTex.offset.set((1 - ca / ia) / 2, 0); }
      else { plateTex.repeat.set(1, ia / ca); plateTex.offset.set(0, (1 - ia / ca) / 2); }
    }
    const dist = (H * 0.62) / Math.tan((camera.fov * Math.PI) / 360);
    // elevation ~8° (looking slightly down) so the hull mirrors the lit studio floor/softboxes instead of a flat horizon line
    const views: Record<string, [number, number]> = { front: [0, 8], "three-quarter": [35, 12], low: [20, -24], underside: [15, -38], orbit: [0, 8] };
    const [az, el0] = views[view] || views.front;
    const el = q.has("elev") ? num(q, "elev", 0) : el0;
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    camera.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, Math.cos(a) * Math.cos(e) * dist);
    camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
  };

  // ---- post: bloom + ACES (tone mapping applied once at the output)
  let draw: () => void;
  let resizePost: (w: number, h: number) => void = () => {};
  if (backend === "webgpu" && WGPU) {
    const TSL = await import("three/tsl");
    const { bloom } = await import("three/examples/jsm/tsl/display/BloomNode.js");
    const pipeline = new WGPU.RenderPipeline(renderer as never);
    const scenePass = TSL.pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    // Clamp the bloom INPUT only: a mirror reflecting a ~5000-nit softbox would otherwise flood the frame.
    const b = bloom(color.min(TSL.vec4(bloomCap, bloomCap, bloomCap, 1)), bloomStrength, bloomRadius, bloomThreshold);
    pipeline.outputNode = color.add(b);
    draw = () => pipeline.render();
  } else {
    const { EffectComposer } = await import("three/examples/jsm/postprocessing/EffectComposer.js");
    const { RenderPass } = await import("three/examples/jsm/postprocessing/RenderPass.js");
    const { UnrealBloomPass } = await import("three/examples/jsm/postprocessing/UnrealBloomPass.js");
    const { OutputPass } = await import("three/examples/jsm/postprocessing/OutputPass.js");
    const composer = new EffectComposer(renderer as never);
    composer.addPass(new RenderPass(scene, camera));
    const bp = new UnrealBloomPass(new THREE.Vector2(256, 256), bloomStrength, bloomRadius, bloomThreshold);
    // Same input clamp as the WebGPU path (patch the high-pass shader's output).
    bp.materialHighPassFilter.fragmentShader = bp.materialHighPassFilter.fragmentShader.replace(
      "gl_FragColor = mix( outputColor, texel, alpha );",
      `gl_FragColor = min( mix( outputColor, texel, alpha ), vec4( vec3( ${bloomCap.toFixed(3)} ), 1.0 ) );`);
    bp.materialHighPassFilter.needsUpdate = true;
    composer.addPass(bp);
    composer.addPass(new OutputPass());
    draw = () => composer.render();
    resizePost = (w, h) => { composer.setPixelRatio(dpr); composer.setSize(w, h); };
  }

  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer!.setSize(w, h, false); resizePost(w, h); fit(w, h);
  };
  resize();
  addEventListener("resize", resize);

  let rot = num(q, "rot", 0) * Math.PI / 180;
  pivot.rotation.y = rot;
  handle.setRotation = (deg) => { rot = (deg * Math.PI) / 180; pivot.rotation.y = rot; };
  handle.render = async () => { draw(); handle.frames++; };

  let raf = 0, last = performance.now(), stopped = false;
  const loop = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (spin) { rot += dt * 0.35; pivot.rotation.y = rot; }
    draw(); handle.frames++;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  handle.ready = true;

  return () => {
    stopped = true; cancelAnimationFrame(raf); removeEventListener("resize", resize);
    envRT.texture.dispose(); hdr.dispose(); plateTex?.dispose(); renderer!.dispose();
    if (window.__lookdev === handle) delete window.__lookdev;
  };
}
