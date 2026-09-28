// "Скан -> CAD": the same part rendered twice with a screen-space split.
// Left of the handle = raw scan (low-poly + baked normal map), right = CAD model.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const stage = document.getElementById('scan3d');
const canvas = stage.querySelector('canvas');
const handle = stage.querySelector('.s3d-handle');
const status = stage.querySelector('.s3d-status');
const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.shadowMap.autoUpdate = false; // the part never moves (only the camera orbits): bake the shadow once

const scene = new THREE.Scene();

// Product-shot studio: dark room + softboxes, baked into an env map (reflections + soft fill)
function studio() {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x3a3d42, side: THREE.BackSide }));
  s.add(room);
  const box = (w, h, intensity, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); s.add(m);
  };
  box(6, 4, 3.2, [0, 6, 2], [0, 0, 0]);        // big overhead key
  box(1.2, 7, 5.0, [-6, 1.5, 1], [0, 0, 0]);   // left strip - rim highlights on edges
  box(1.2, 7, 3.5, [6, 1.5, -1], [0, 0, 0]);   // right strip
  box(8, 2, 1.2, [0, 1, 7], [0, 0, 0]);        // soft front fill
  box(10, 10, 0.35, [0, -6, 0], [0, 0, 0]);    // floor bounce
  return s;
}
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(studio(), 0.03).texture;
scene.environmentIntensity = 1.35;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 0.6));

// key light only for the soft contact shadow + a bit of modelling
const key = new THREE.DirectionalLight(0xffffff, 1.3);
key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 8; key.shadow.blurSamples = 12;
key.shadow.bias = -0.0004;
scene.add(key, key.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.22 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.enablePan = false;
controls.autoRotate = false; // no idle spinning: the scene only redraws on interaction
controls.rotateSpeed = 0.7;

const draco = new DRACOLoader().setDecoderPath('vendor/three/draco/');
const loader = new GLTFLoader().setDRACOLoader(draco);
const pivot = new THREE.Group(); scene.add(pivot);
let scan, cad, split = 0.5, ready = false, dirty = true, fitDist = null;

const load = url => new Promise((res, rej) => loader.load(url, g => res(g.scene), p => {
  if (p.total) status.textContent = `Загрузка ${Math.round(p.loaded / p.total * 100)}%`;
}, rej));

Promise.all([load('models/scan.glb'), load('models/cad.glb')]).then(([s, c]) => {
  scan = s; cad = c;
  scan.traverse(o => { if (o.isMesh) {
    // matte scanned surface; the baked normal map carries the scanner detail
    const src = o.material;
    o.material = new THREE.MeshStandardMaterial({ color: 0x56644d, roughness: 0.72, metalness: 0,
      normalMap: src.normalMap, normalScale: new THREE.Vector2(1.5, 1.5) });
    o.castShadow = true;
  }});
  cad.traverse(o => { if (o.isMesh) {
    const badge = o.material.color.r > 0.2;
    o.material = badge
      ? new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.9, roughness: 0.25 })
      : new THREE.MeshStandardMaterial({ color: 0x232427, roughness: 0.55, metalness: 0 }); // dark satin plastic
    o.castShadow = true;
    // subtle Fusion-like feature edges
    o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })));
  }});
  pivot.add(scan, cad);
  // turn the part so the lattice and badge face the viewer, mounting tabs go up and back
  pivot.rotation.set(0, Math.PI, 0); pivot.updateMatrixWorld(true);
  // centre the part and frame it
  const box = new THREE.Box3().setFromObject(pivot), size = box.getSize(new THREE.Vector3());
  pivot.position.sub(box.getCenter(new THREE.Vector3()));
  const r = size.length() / 2;
  // floor + shadow light sized to the part
  ground.position.y = -size.y / 2 - 0.002;
  key.position.set(-r * 0.4, r * 2.2, r * 0.9);
  const sc = key.shadow.camera; sc.left = sc.bottom = -r * 1.2; sc.right = sc.top = r * 1.2; sc.near = 0.01; sc.far = r * 6; sc.updateProjectionMatrix();
  fitDist = () => {
    // the part is long and low: fit its length to ~80% of the frame width
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    return (size.x * 0.62) / Math.tan(hfov / 2);
  };
  resize(true);
  const d = fitDist();
  camera.position.copy(new THREE.Vector3(-0.38, 0.42, 1).normalize().multiplyScalar(d));
  controls.target.set(0, 0, 0);
  controls.minDistance = r * 0.7; controls.maxDistance = d * 1.8;
  controls.update();
  renderer.shadowMap.needsUpdate = true; dirty = true;
  ready = true; stage.classList.add('ready'); status.textContent = '';
}).catch(e => { status.textContent = 'Не удалось загрузить модель'; console.error(e); });

// ---- split handle ----
const setSplit = v => { split = Math.min(0.97, Math.max(0.03, v)); handle.style.left = (split * 100) + '%'; dirty = true; };
setSplit(0.5);
let dragging = false;
const fromEvent = e => { const r = stage.getBoundingClientRect(); setSplit((e.clientX - r.left) / r.width); };
// the handle glows (CSS) until the first touch
const touched = () => stage.classList.add('touched');
handle.addEventListener('pointerdown', e => { dragging = true; touched(); handle.setPointerCapture(e.pointerId); e.preventDefault(); });
handle.addEventListener('pointermove', e => { if (dragging) fromEvent(e); });
handle.addEventListener('pointerup', () => dragging = false);
handle.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { touched(); setSplit(split - 0.03); }
  if (e.key === 'ArrowRight') { touched(); setSplit(split + 0.03); }
});
controls.addEventListener('change', () => { dirty = true; });

// ---- render loop (only while visible) ----
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
// dev-only: grab a frame of the canvas (enabled with #debug3d)
if (location.hash === '#debug3d') window.__s3d = {
  snap: () => { draw(performance.now()); return canvas.toDataURL('image/png'); },
  set: v => { touched(); setSplit(v); }, controls, camera, pivot, THREE
};
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
  scan.visible = true; cad.visible = false; renderer.render(scene, camera);
  renderer.setScissor(x, 0, w - x, h);
  scan.visible = false; cad.visible = true; renderer.render(scene, camera);
  renderer.setScissorTest(false);
}
