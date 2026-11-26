import { t } from './i18n.js';
import { viewDirections } from './drawing-views.js';
import {
  Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, GridHelper,
  Group, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, Scene,
  Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const axisColors = ['#a33139', '#197747', '#2359aa'];
const surfaceFinishes = {
  matte: { roughness: 0.9 }, plastic: { roughness: 0.36 },
  metal: { roughness: 0.27, metalness: 0.55 }, rubber: { roughness: 0.98 },
};

function addLighting(scene) {
  const light = new DirectionalLight('#fff8ed', 2.8);
  light.position.set(-4, 4, 7);
  const fill = new DirectionalLight('#dbe7ff', 1.6);
  fill.position.set(4, -2, 5);
  scene.add(light, fill, new HemisphereLight('#e7efff', '#8e9bab', 1.7));
}

function addModel(group, parts) {
  for (const { color, material, vertices, normals, triangles } of parts) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(vertices, 3));
    geometry.setIndex(new BufferAttribute(triangles, 1));
    if (normals) geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    else geometry.computeVertexNormals();
    group.add(new Mesh(geometry, new MeshStandardMaterial({ color, roughness: 0.62, ...surfaceFinishes[material] })));
  }
}

function clearGroup(group) {
  for (const object of [...group.children]) {
    group.remove(object);
    object.geometry.dispose();
    object.material.dispose();
  }
}

export function renderReviewViews(parts, { min, max }, drawingViews) {
  if (!drawingViews.length) return undefined;
  const distinct = new Map();
  for (const view of drawingViews) {
    const key = `${view.direction}/${view.up}`;
    if (!distinct.has(key)) distinct.set(key, view);
  }
  const views = [...distinct.values()];
  const center = new Vector3().fromArray(min).lerp(new Vector3().fromArray(max), 0.5);
  const span = new Vector3().fromArray(max).distanceTo(new Vector3().fromArray(min));
  if (!parts.length || !Number.isFinite(span) || span <= 0) throw new Error(t('当前 CAD 没有可供校正的渲染图。'));
  const tile = 320;
  const caption = 42;
  const columns = Math.min(4, views.length);
  const sheet = document.createElement('canvas');
  sheet.width = columns * tile;
  sheet.height = Math.ceil(views.length / columns) * (tile + caption);
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error(t('无法生成校正用视图。'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = '#18233a';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  const renderer = new WebGLRenderer({ antialias: true });
  const scene = new Scene();
  const model = new Group();
  try {
    renderer.setSize(tile, tile, false);
    scene.background = new Color('#edf2f7');
    scene.add(model);
    addLighting(scene);
    addModel(model, parts);
    const half = span * 0.57;
    const camera = new OrthographicCamera(-half, half, half, -half, span * 0.01, span * 6);
    for (const [index, { label, page, direction, up }] of views.entries()) {
      const x = (index % columns) * tile;
      const y = Math.floor(index / columns) * (tile + caption);
      camera.up.fromArray(viewDirections[up]);
      camera.position.copy(center).addScaledVector(new Vector3().fromArray(viewDirections[direction]).normalize(), span * 3);
      camera.lookAt(center);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, x, y + caption, tile, tile);
      ctx.fillText(t('PDF 第 ${1} 页 · ${2}', page, label), x + tile / 2, y + 16, tile - 12);
      ctx.fillText(t('观察 ${1} · 向上 ${2}', direction, up), x + tile / 2, y + 34, tile - 12);
    }
    return sheet.toDataURL('image/jpeg', 0.88);
  } finally {
    clearGroup(model);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function dimensionLines({ min, max }) {
  const pad = Math.max(...max.map((value, axis) => value - min[axis])) * 0.09;
  const corner = new Vector3(min[0], min[1], min[2]);
  const offsets = [new Vector3(0, -pad, 0), new Vector3(-pad, 0, 0), new Vector3(-pad, -pad, 0)];
  return offsets.map((offset, axis) => {
    const start = corner.clone().setComponent(axis, min[axis]);
    const end = corner.clone().setComponent(axis, max[axis]);
    const from = start.clone().add(offset);
    const to = end.clone().add(offset);
    const tick = offset.clone().normalize().multiplyScalar(pad * 0.16);
    tick.setComponent(axis, pad * 0.13);
    const points = [start, from.clone().addScaledVector(offset, 0.16), end, to.clone().addScaledVector(offset, 0.16), from, to,
      from.clone().sub(tick), from.clone().add(tick), to.clone().sub(tick), to.clone().add(tick)];
    const geometry = new BufferGeometry().setFromPoints(points);
    return new LineSegments(geometry, new LineBasicMaterial({ color: axisColors[axis] }));
  });
}

export function createPreview(container) {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-label', '生成的器件三维模型');
  renderer.domElement.setAttribute('role', 'img');

  const scene = new Scene();
  scene.background = new Color('#e9eef5');
  const camera = new PerspectiveCamera(35, 1, 0.01, 500);
  camera.up.set(0, 0, 1);
  const direction = new Vector3(-0.84, -0.66, 0.89).normalize();
  container.prepend(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  const model = new Group();
  const dimensions = new Group();
  const grid = new GridHelper(1, 12, '#9eafc8', '#c2cfdf');
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.02;
  scene.add(model, dimensions, grid);
  addLighting(scene);

  function render() {
    renderer.render(scene, camera);
  }
  controls.addEventListener('change', render);
  const observer = new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  });
  observer.observe(container);

  function clear() {
    clearGroup(model);
    clearGroup(dimensions);
    grid.visible = false;
    render();
  }

  function fit() {
    const box = new Box3().setFromObject(model);
    if (box.isEmpty()) return;
    if (dimensions.visible) box.union(new Box3().setFromObject(dimensions));
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const extent = size.length();
    const distance = extent * 1.7 / Math.min(1, camera.aspect);
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.minDistance = extent * 0.18;
    controls.maxDistance = extent * 9;
    controls.update();
    render();
  }

  return {
    show(parts, bounds) {
      clear();
      addModel(model, parts);
      const size = new Box3().setFromObject(model).getSize(new Vector3());
      dimensions.add(...dimensionLines(bounds));
      grid.scale.setScalar(Math.max(size.x, size.y) * 1.65);
      grid.visible = true;
      fit();
    },
    setDimensionsVisible(visible) {
      dimensions.visible = visible;
      render();
    },
    setView(axis) {
      direction.fromArray(axis).normalize();
      fit();
    },
    clear,
    fit,
    dispose() {
      observer.disconnect();
      controls.dispose();
      clear();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
    },
  };
}
