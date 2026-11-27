export function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const text = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const list = items => ({ type: 'array', items });
const choice = (...values) => ({ type: 'string', enum: values });
const vector = list(number);

const shapeSchema = object({
  kind: choice('box', 'cylinder', 'sphere', 'prism', 'loft'),
  at: vector,
  size: vector,
  plane: choice('XY', 'XZ', 'YZ'),
  profile: list(vector),
  sections: list(object({ offset: number, profile: list(vector) })),
});

const partSchema = object({
  id: text,
  role: choice('body', 'metal', 'mark', 'plastic', 'ceramic', 'terminal', 'enclosure', 'contact'),
  shape: shapeSchema,
  cuts: list(shapeSchema),
  repeats: list(object({ count: integer, step: vector })),
});

const measurementSchema = object({ label: text, mm: number, source: text });
const appearanceEditSchema = object({
  id: text,
  color: { type: ['string', 'null'] },
  material: { type: ['string', 'null'], enum: ['matte', 'plastic', 'metal', 'rubber', 'default', null] },
});
const boundsSchema = object({
  x: { type: ['number', 'null'] },
  y: { type: ['number', 'null'] },
  z: { type: ['number', 'null'] },
});

export const planResponseSchema = object({
  status: choice('ready', 'question', 'information'),
  action: choice('replace', 'edit', 'none'),
  page: integer,
  name: text,
  reply: text,
  parts: list(partSchema),
  appearanceEdits: list(appearanceEditSchema),
  remove: list(text),
  measurements: list(measurementSchema),
  assumptions: list(text),
  bounds: boundsSchema,
});

const sizeCounts = new Map([['box', 3], ['cylinder', 2], ['sphere', 1], ['prism', 1], ['loft', 0]]);
const roles = new Set(['body', 'metal', 'mark', 'plastic', 'ceramic', 'terminal', 'enclosure', 'contact']);
const planes = new Set(['XY', 'XZ', 'YZ']);
const positionLimit = 600;
const instanceLimit = 400;
const appearanceMaterials = new Set(['matte', 'plastic', 'metal', 'rubber']);
const profileTolerance = 1e-7;

function acceptedVector(values, count, test) {
  return Array.isArray(values) && values.length === count && values.every(test);
}

function nearOrigin(value) {
  return Number.isFinite(value) && Math.abs(value) <= positionLimit;
}

function isLength(value) {
  return Number.isFinite(value) && value >= 0.0001 && value <= positionLimit;
}

function string(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function openProfile(points) {
  const distinct = points.filter(([x, y], index) => index === 0
    || Math.hypot(x - points[index - 1][0], y - points[index - 1][1]) >= profileTolerance);
  const [first] = distinct;
  const last = distinct.at(-1);
  if (distinct.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < profileTolerance) distinct.pop();
  return distinct;
}

function sideOfEdge([ax, ay], [bx, by], [x, y]) {
  const dx = bx - ax;
  const dy = by - ay;
  const cross = dx * (y - ay) - dy * (x - ax);
  return Math.abs(cross) <= profileTolerance * Math.hypot(dx, dy) ? 0 : Math.sign(cross);
}

function withinEdgeBounds(point, start, end) {
  return point.every((value, axis) => value >= Math.min(start[axis], end[axis]) - profileTolerance
    && value <= Math.max(start[axis], end[axis]) + profileTolerance);
}

function edgesIntersect(a, b, c, d) {
  const cSide = sideOfEdge(a, b, c);
  const dSide = sideOfEdge(a, b, d);
  const aSide = sideOfEdge(c, d, a);
  const bSide = sideOfEdge(c, d, b);
  return (cSide * dSide < 0 && aSide * bSide < 0)
    || (cSide === 0 && withinEdgeBounds(c, a, b)) || (dSide === 0 && withinEdgeBounds(d, a, b))
    || (aSide === 0 && withinEdgeBounds(a, c, d)) || (bSide === 0 && withinEdgeBounds(b, c, d));
}

function checkProfile(profile, label) {
  if (!Array.isArray(profile)) throw new Error('缺少有效轮廓：' + label);
  if (profile.length < 3 || profile.length > 72 || !profile.every(point => acceptedVector(point, 2, nearOrigin))) {
    throw new Error('截面轮廓无效：' + label);
  }
  const outline = openProfile(profile);
  for (let i = 0; i < outline.length; i += 1) {
    for (let j = i + 2; j < outline.length; j += 1) {
      if (i === 0 && j === outline.length - 1) continue;
      const next = (j + 1) % outline.length;
      if (edgesIntersect(outline[i], outline[i + 1], outline[j], outline[next])) {
        const error = new Error(`${label}的轮廓自相交或自接触（顶点 ${i + 1}–${i + 2} 与 ${j + 1}–${next + 1} 的边）。`);
        error.profile = outline;
        throw error;
      }
    }
  }
  let area = 0;
  for (const [index, [x, y]] of outline.entries()) {
    const [nextX, nextY] = outline[(index + 1) % outline.length];
    area += x * nextY - y * nextX;
  }
  if (Math.abs(area) < 1e-7) throw new Error('截面轮廓没有有效面积：' + label);
  return outline.length;
}

function checkShape(shape, label) {
  const sizeCount = sizeCounts.get(shape?.kind);
  if (sizeCount === undefined || !acceptedVector(shape.at, 3, nearOrigin) || !acceptedVector(shape.size, sizeCount, isLength)
    || !planes.has(shape.plane) || !Array.isArray(shape.profile)) {
    throw new Error('几何定义无效：' + label);
  }
  const sections = shape.sections ?? [];
  if (!Array.isArray(sections) || (shape.kind !== 'loft' && sections.length)) {
    throw new Error('只有放样件可提供多层截面：' + label);
  }
  if (shape.kind === 'prism') {
    checkProfile(shape.profile, label);
    return;
  }
  if (shape.profile.length) throw new Error('只有拉伸件允许提供单个轮廓：' + label);
  if (shape.kind !== 'loft') return;
  if (sections.length < 2 || sections.length > 12) throw new Error('放样件需提供 2–12 层截面：' + label);
  let previous = -Infinity;
  let vertexCount;
  for (const [index, section] of sections.entries()) {
    if (!nearOrigin(section?.offset) || section.offset - previous < 0.0001) {
      throw new Error('放样截面偏移必须沿平面法向递增：' + label);
    }
    const count = checkProfile(section.profile, label + '第 ' + (index + 1) + ' 层截面');
    if (vertexCount !== undefined && count !== vertexCount) {
      throw new Error('放样截面须使用相互对应、数量一致的顶点：' + label);
    }
    vertexCount = count;
    previous = section.offset;
  }
}

export function repeatOffsets(repeats) {
  let offsets = [[0, 0, 0]];
  for (const { count, step } of repeats) {
    offsets = offsets.flatMap(offset => Array.from({ length: count }, (_, index) =>
      offset.map((coordinate, axis) => coordinate + step[axis] * index)));
  }
  return offsets;
}

export function validatePlan(plan) {
  if (!string(plan?.name, 120) || !Array.isArray(plan.parts) || !plan.parts.length || plan.parts.length > 90) {
    throw new Error('模型需要名称和至少一个实体。复杂模型请先简化后再生成。');
  }
  const ids = new Set();
  let instances = 0;
  for (const part of plan.parts) {
    if (!string(part?.id, 72) || ids.has(part.id) || !roles.has(part.role)) throw new Error('模型的零件名称或材质无效。');
    ids.add(part.id);
    if (part.appearance && ((part.appearance.color !== undefined && !/^#[0-9a-f]{6}$/i.test(part.appearance.color))
      || (part.appearance.material !== undefined && !appearanceMaterials.has(part.appearance.material)))) {
      throw new Error('外观设置无效：' + part.id);
    }
    checkShape(part.shape, part.id);
    if (!Array.isArray(part.cuts) || part.cuts.length > 14) throw new Error('开孔定义过多或无效：' + part.id);
    for (const [index, cut] of part.cuts.entries()) checkShape(cut, part.id + ' 第 ' + (index + 1) + ' 个切削体');
    if (!Array.isArray(part.repeats) || part.repeats.length > 2) throw new Error('阵列定义无效：' + part.id);
    let count = 1;
    for (const repeat of part.repeats) {
      if (!Number.isInteger(repeat?.count) || repeat.count < 2 || repeat.count > 100
        || !acceptedVector(repeat.step, 3, nearOrigin) || !repeat.step.some(Boolean)) {
        throw new Error('阵列步进或数量无效：' + part.id);
      }
      count *= repeat.count;
    }
    instances += count;
    if (instances > instanceLimit) throw new Error('展开后的模型超过 ' + instanceLimit + ' 个零件，请在对话中要求简化。');
    for (const offset of repeatOffsets(part.repeats)) {
      if (!offset.every((coordinate, axis) => nearOrigin(coordinate + part.shape.at[axis]))) {
        throw new Error('阵列超出建模范围：' + part.id);
      }
    }
  }
  if (!Array.isArray(plan.measurements) || plan.measurements.length > 45
    || !plan.measurements.every(item => string(item?.label, 90) && nearOrigin(item.mm) && string(item.source, 220))) {
    throw new Error('模型尺寸或图纸依据无效。');
  }
  if (!Array.isArray(plan.assumptions) || plan.assumptions.length > 15
    || !plan.assumptions.every(item => string(item, 240))) throw new Error('建模简化说明无效。');
  if (!plan.bounds || !['x', 'y', 'z'].every(axis => plan.bounds[axis] === null || isLength(plan.bounds[axis]))) {
    throw new Error('模型外形尺寸无效。');
  }
}

export function resolveProposal(response, pages, current) {
  if (response.status !== 'ready') return null;
  if (!Number.isInteger(response.page) || (response.page !== 0 && !pages.includes(response.page))) {
    throw new Error('AI 返回的图纸页码无效。请在对话中指定 PDF 页。');
  }
  const { action, parts, remove, name, measurements, assumptions, bounds, appearanceEdits = [] } = response;
  const page = response.page || current?.page;
  if (!page || !Array.isArray(parts) || !Array.isArray(remove) || !Array.isArray(measurements) || !Array.isArray(appearanceEdits)
    || !Array.isArray(assumptions) || !bounds || typeof bounds !== 'object') {
    throw new Error('AI 没有返回完整的建模描述或图纸页码。');
  }
  let proposal;
  if (action === 'replace') {
    proposal = { name, parts, page, measurements, assumptions, bounds };
  } else if (action === 'edit' && current) {
    if (!parts.length && !remove.length && !appearanceEdits.length) return null;
    const byId = new Map(current.parts.map(part => [part.id, part]));
    for (const id of remove) {
      if (!byId.delete(id)) throw new Error('AI 试图删除不存在的零件。');
    }
    const changed = new Set();
    for (const part of parts) {
      if (!part?.id || changed.has(part.id)) throw new Error('AI 返回了重复或无效的零件名称。');
      changed.add(part.id);
      const appearance = byId.get(part.id)?.appearance;
      byId.set(part.id, appearance ? { ...part, appearance } : part);
    }
    const measured = new Map(current.measurements.map(item => [item.label, item]));
    for (const item of measurements) measured.set(item.label, item);
    proposal = {
      name: name.trim() || current.name, page, parts: [...byId.values()],
      measurements: [...measured.values()], assumptions: assumptions.length ? assumptions : current.assumptions,
      bounds,
    };
  } else {
    throw new Error('AI 没有返回可应用的建模操作。');
  }
  if (appearanceEdits.length) {
    const changes = new Map();
    for (const edit of appearanceEdits) {
      const { id, color, material } = edit ?? {};
      if (!proposal.parts.some(part => part?.id === id) || changes.has(id)
        || (color != null && color !== 'default' && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)))
        || (material != null && material !== 'default' && !appearanceMaterials.has(material))) {
        throw new Error('外观修改无效，请检查零件名称、颜色或材质。');
      }
      changes.set(id, { color, material });
    }
    proposal.parts = proposal.parts.map(part => {
      const edit = changes.get(part.id);
      if (!edit) return part;
      const appearance = { ...part.appearance };
      for (const property of ['color', 'material']) {
        if (edit[property] === 'default') delete appearance[property];
        else if (edit[property] != null) appearance[property] = edit[property];
      }
      return { ...part, appearance };
    });
  }
  validatePlan(proposal);
  return proposal;
}

export function reviewTerminals(inspection, proposal) {
  const warnings = [];
  if (Number.isInteger(inspection.terminalCount) && inspection.terminalCount > 0) {
    const terminals = proposal.parts.filter(part => part.role === 'terminal');
    const actual = terminals
      .reduce((count, part) => count + part.repeats.reduce((copies, repeat) => copies * repeat.count, 1), 0);
    if (actual !== inspection.terminalCount) warnings.push('图纸识别到 ' + inspection.terminalCount
      + ' 个 PCB 电气端子，建模描述包含 ' + actual + ' 个端子。');
    const axis = ['X', 'Y'].indexOf(inspection.terminalRowAxis);
    if (axis !== -1 && terminals.some(part => part.repeats.some(repeat => repeat.count >= 4
      && Math.abs(repeat.step[1 - axis]) > Math.abs(repeat.step[axis])))) {
      warnings.push('图纸中的端子长排沿 ' + inspection.terminalRowAxis + '，建模阵列的长排在另一轴。');
    }
  }
  return warnings;
}
