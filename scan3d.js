// 3D "A vs B" compare blocks: the same part rendered twice with a screen-space split.
// Left of the handle = model A, right = model B. Each .s3d element on the page is one block,
// configured by data attributes:
//   data-a / data-b   GLB urls            data-preset  "scan-cad" | "zebra"
//   data-rot          "x,y,z" radians     data-view    camera direction "x,y,z"
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const draco = new DRACOLoader().setDecoderPath('vendor/three/draco/');
const loader = new GLTFLoader().setDRACOLoader(draco);
const nums = (s, d) => (s ? s.split(',').map(Number) : d);

// Product-shot studio: dark room + softboxes, baked into an env map (reflections + soft fill)
function studioScene(room = 0x3a3d42) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16),
    new THREE.MeshBasicMaterial({ color: room, side: THREE.BackSide })));
  const box = (w, h, intensity, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m);
  };
  box(6, 4, 3.2, [0, 6, 2]);        // big overhead key
  box(1.2, 7, 5.0, [-6, 1.5, 1]);   // left strip - rim highlights on edges
  box(1.2, 7, 3.5, [6, 1.5, -1]);   // right strip
  box(8, 2, 1.2, [0, 1, 7]);        // soft front fill
  box(10, 10, 0.35, [0, -6, 0]);    // floor bounce
  return s;
}

// Zebra analysis environment: horizontal light/dark bands around the part (like the CAD "zebra" tool).
// On a clean surface the reflected stripes flow evenly; ripples and creases make them wobble and break.
function zebraTexture() {
  // PMREM sizes its cube map from the equirect width (w/4), so the canvas must be wide enough to keep the bands crisp
  const c = document.createElement('canvas'); c.width = 4096; c.height = 2048;
  const g = c.getContext('2d'), bands = 64, bh = c.height / bands;
  for (let i = 0; i < bands; i++) { g.fillStyle = i % 2 ? '#f4f5f6' : '#101113'; g.fillRect(0, Math.round(i * bh), c.width, Math.ceil(bh)); }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PRESETS = {
  'scan-cad': {
    env: (pmrem) => pmrem.fromScene(studioScene(), 0.03).texture, envIntensity: 1.35, hemi: 0.6, exposure: 1.25,
    a: (o) => { // matte scanned surface; the baked normal map carries the scanner detail
      const src = o.material;
      o.material = new THREE.MeshStandardMaterial({ color: 0x56644d, roughness: 0.72, metalness: 0,
        normalMap: src.normalMap, normalScale: new THREE.Vector2(1.5, 1.5) });
    },
    b: (o) => {
      const badge = o.material.color.r > 0.2;
      o.material = badge
        ? new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.9, roughness: 0.25 })
        : new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.55, metalness: 0 }); // dark satin plastic
      // subtle Fusion-like feature edges
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30),
        new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })));
    },
  },
  // identical mirror-like material on both models: only the geometry differs, so only it shows in the stripes
  'zebra': {
    env: (pmrem) => pmrem.fromEquirectangular(zebraTexture()).texture, envIntensity: 1.0, hemi: 0, exposure: 1.0,
    a: (o) => { o.material = new THREE.MeshStandardMaterial({ color: 0xd9dce0, metalness: 1, roughness: 0.04 }); },
    b: (o) => { o.material = new THREE.MeshStandardMaterial({ color: 0xd9dce0, metalness: 1, roughness: 0.04 }); },
  },
  // Fusion's default "Steel - Satin" look, lit by exactly the same studio and settings as the scan-cad block
  // so the two blocks read as one scene. Partly dielectric: a pure metal would only mirror the dark room.
  'steel': {
    env: (pmrem) => pmrem.fromScene(studioScene(), 0.03).texture, envIntensity: 1.35, hemi: 0.6, exposure: 1.25,
    a: (o) => { o.material = new THREE.MeshStandardMaterial({ color: 0x8d8b85, metalness: 0.45, roughness: 0.36 }); },
    b: (o) => { o.material = new THREE.MeshStandardMaterial({ color: 0x8d8b85, metalness: 0.45, roughness: 0.36 }); },
  },
};

function init(stage) {
  const canvas = stage.querySelector('canvas'), handle = stage.querySelector('.s3d-handle'), status = stage.querySelector('.s3d-status');
  let preset = PRESETS[stage.dataset.preset] || PRESETS['scan-cad'];

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = preset.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate = false; // the part never moves (only the camera orbits): bake the shadow once

  let A, B, split = 0.5, ready = false, dirty = true, fitDist = null;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envCache = {};
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 0); scene.add(hemi);
  // key light only for the soft contact shadow (and a bit of modelling on non-mirror materials)
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  // a look = environment + lights + materials; blocks with a mode switch change it on the fly
  const applyLook = name => {
    preset = PRESETS[name];
    scene.environment = envCache[name] ||= preset.env(pmrem);
    scene.environmentIntensity = preset.envIntensity;
    renderer.toneMappingExposure = preset.exposure;
    hemi.intensity = preset.hemi; key.intensity = preset.hemi ? 1.3 : 0.0001;
    if (A) { A.traverse(o => { if (o.isMesh) preset.a(o); }); B.traverse(o => { if (o.isMesh) preset.b(o); }); }
    dirty = true;
  };
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 8; key.shadow.blurSamples = 12;
  key.shadow.bias = -0.0004;
  scene.add(key, key.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.22 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.enablePan = false; controls.rotateSpeed = 0.7;
  controls.autoRotate = false; // no idle spinning: the scene only redraws on interaction

  const pivot = new THREE.Group(); scene.add(pivot);
  applyLook(stage.dataset.preset in PRESETS ? stage.dataset.preset : 'scan-cad');

  const load = url => new Promise((res, rej) => loader.load(url, g => res(g.scene), p => {
    if (p.total) status.textContent = `Загрузка ${Math.round(p.loaded / p.total * 100)}%`;
  }, rej));

  Promise.all([load(stage.dataset.a), load(stage.dataset.b)]).then(([a, b]) => {
    A = a; B = b;
    A.traverse(o => { if (o.isMesh) { preset.a(o); o.castShadow = true; } });
    B.traverse(o => { if (o.isMesh) { preset.b(o); o.castShadow = true; } });
    pivot.add(A, B);
    pivot.rotation.set(...nums(stage.dataset.rot, [0, 0, 0])); pivot.updateMatrixWorld(true);
    // centre the part and frame it
    const box = new THREE.Box3().setFromObject(pivot), size = box.getSize(new THREE.Vector3());
    pivot.position.sub(box.getCenter(new THREE.Vector3()));
    const r = size.length() / 2;
    ground.position.y = -size.y / 2 - 0.002;
    key.position.set(-r * 0.4, r * 2.2, r * 0.9);
    const sc = key.shadow.camera; sc.left = sc.bottom = -r * 1.2; sc.right = sc.top = r * 1.2; sc.near = 0.01; sc.far = r * 6; sc.updateProjectionMatrix();
    fitDist = () => {
      // long, low parts: fit the length to ~80% of the frame width
      const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      return (size.x * 0.62) / Math.tan(hfov / 2);
    };
    resize(true);
    const d = fitDist();
    camera.position.copy(new THREE.Vector3(...nums(stage.dataset.view, [-0.38, 0.42, 1])).normalize().multiplyScalar(d));
    controls.target.set(0, 0, 0);
    controls.minDistance = r * 0.5; controls.maxDistance = d * 1.8;
    controls.update();
    renderer.shadowMap.needsUpdate = true; dirty = true;
    ready = true; stage.classList.add('ready'); status.textContent = '';
  }).catch(e => { status.textContent = 'Не удалось загрузить модель'; console.error(e); });

  // ---- split handle ----
  const setSplit = v => { split = Math.min(0.97, Math.max(0.03, v)); handle.style.left = (split * 100) + '%'; dirty = true; };
  setSplit(0.5);
  let dragging = false;
  // the handle glows (CSS) until the first touch
  const touched = () => stage.classList.add('touched');
  handle.addEventListener('pointerdown', e => { dragging = true; touched(); handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener('pointermove', e => { if (dragging) { const r = stage.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); } });
  handle.addEventListener('pointerup', () => dragging = false);
  handle.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { touched(); setSplit(split - 0.03); }
    if (e.key === 'ArrowRight') { touched(); setSplit(split + 0.03); }
  });
  controls.addEventListener('change', () => { dirty = true; });
  // optional look switch: <button data-look="zebra">
  const looks = [...stage.querySelectorAll('[data-look]')];
  looks.forEach(btn => btn.addEventListener('click', () => {
    looks.forEach(x => x.setAttribute('aria-pressed', x === btn));
    applyLook(btn.dataset.look);
  }));

  // ---- render on demand, only while visible ----
  let visible = false;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) { dirty = true; requestAnimationFrame(frame); } }).observe(stage);
  new ResizeObserver(() => { resize(); dirty = true; }).observe(stage);
  function resize(force) {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    if (force || canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
      // keep the part framed when the layout changes (e.g. phone rotation)
      if (fitDist && ready) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).addScaledVector(dir, fitDist());
        controls.maxDistance = fitDist() * 1.8;
      }
    }
  }
  function frame() {
    if (!visible) return;
    requestAnimationFrame(frame);
    // damping keeps the camera gliding for a moment after a drag: update() reports that
    if (ready && controls.update()) dirty = true;
    if (dirty) draw();
  }
  function draw() {
    if (!ready) return;
    dirty = false;
    const w = stage.clientWidth, h = stage.clientHeight, x = Math.round(w * split);
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, x, h); renderer.setViewport(0, 0, w, h);
    A.visible = true; B.visible = false; renderer.render(scene, camera);
    renderer.setScissor(x, 0, w - x, h);
    A.visible = false; B.visible = true; renderer.render(scene, camera);
    renderer.setScissorTest(false);
  }
  // dev-only: grab a frame of the canvas (enabled with #debug3d)
  if (location.hash === '#debug3d') (window.__s3d ||= {})[stage.id] = {
    snap: () => { draw(); return canvas.toDataURL('image/png'); },
    set: v => { touched(); setSplit(v); }, controls, camera, pivot, THREE
  };
}

// each block starts (and downloads its models) only when it gets close to the viewport
const io = new IntersectionObserver((es, o) => es.forEach(e => { if (e.isIntersecting) { o.unobserve(e.target); init(e.target); } }), { rootMargin: '400px' });
document.querySelectorAll('.s3d').forEach(el => io.observe(el));
