import { loadBuild123d } from './build123d-runtime.js';
import { openProfile, repeatOffsets, validatePlan } from '../model/model-plan.js';
import pythonSource from './build123d_model.py';

const stepPath = '/tmp/datasheet-model.step';
let python;
let nextAssetId = 0;
const pendingAssets = new Map();

function readAsset(path) {
  return new Promise((resolve, reject) => {
    const id = ++nextAssetId;
    pendingAssets.set(id, { resolve, reject });
    self.postMessage({ asset: { id, path } });
  });
}

const progress = (text, phase = 'runtime') => self.postMessage({ progress: text, phase });
function normalizeShape(shape) {
  if (shape.kind === 'prism') return { ...shape, profile: openProfile(shape.profile) };
  if (shape.kind === 'loft') return { ...shape,
    sections: shape.sections.map(section => ({ ...section, profile: openProfile(section.profile) })) };
  return shape;
}

function preparePlan(plan) {
  validatePlan(plan);
  return {
    name: plan.name,
    parts: plan.parts.map(part => ({
      id: part.id, role: part.role, shape: normalizeShape(part.shape), appearance: part.appearance,
      cuts: part.cuts.map(normalizeShape), offsets: repeatOffsets(part.repeats),
    })),
  };
}

function errorText(error) {
  return error.message.trim().split('\n').at(-1).replace(/^(?:ValueError|RuntimeError):\s*/, '');
}

self.onmessage = async ({ data }) => {
  if (data.assetReply) {
    const { id, file, error } = data.assetReply;
    const pending = pendingAssets.get(id);
    pendingAssets.delete(id);
    if (error) pending?.reject(new Error(error));
    else pending?.resolve(file);
    return;
  }
  let initializing = false;
  try {
    const plan = preparePlan(data.plan);
    if (!python) {
      initializing = true;
      const runtime = await loadBuild123d(progress, readAsset);
      runtime.runPython('import json\n' + pythonSource);
      python = runtime;
      initializing = false;
    }
    progress('正在用 build123d 生成模型及 STEP…', 'geometry');
    python.globals.set('part_plan', JSON.stringify(plan));
    python.globals.set('step_path', stepPath);
    const output = JSON.parse(python.runPython('json.dumps(create_model(json.loads(part_plan), step_path))'));
    const step = python.FS.readFile(stepPath);
    python.FS.unlink(stepPath);
    const { meshes, ...geometry } = output;
    const buffers = [];
    const parts = meshes.flatMap(({ color, material, vertices, triangles, offsets }) => {
      const indices = Uint32Array.from(triangles);
      buffers.push(indices.buffer);
      return offsets.map(offset => {
        const coordinates = Float32Array.from(vertices, (coordinate, index) => coordinate + offset[index % 3]);
        buffers.push(coordinates.buffer);
        return { color, material, vertices: coordinates, triangles: indices };
      });
    });
    self.postMessage({ ...geometry, step: new Blob([step], { type: 'application/step' }), parts }, buffers);
  } catch (error) {
    self.postMessage({
      error: errorText(error),
      runtime: initializing,
    });
  }
};
