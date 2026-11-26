import { t } from './i18n.js';
export const axes = ['x', 'y', 'z'];

export function readCustomDimensions(instruction) {
  const command = /^(?:自定义整件(?:外形|尺寸)?|custom dimensions\b)\s*/i.exec(instruction);
  if (!command) return null;
  const values = {};
  const example = t('请按「自定义整件 X=3.5 mm，Y=2.8 mm」填写，轴可省略，尺寸单位为毫米。');
  let rest = instruction.slice(command[0].length);
  while (rest) {
    const match = /^([xyz])\s*[=:：＝]\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*(?:mm|毫米))?/i.exec(rest);
    if (!match) throw new Error(example);
    const axis = match[1].toLowerCase();
    const value = Number(match[2]);
    if (axis in values || value < 0.0001 || value > 600) throw new Error(example);
    values[axis] = value;
    rest = rest.slice(match[0].length);
    if (rest && !/^[\s,，、;；]+(?=[xyz])/i.test(rest)) throw new Error(example);
    rest = rest.replace(/^[\s,，、;；]+/, '');
  }
  if (!Object.keys(values).length) throw new Error(example);
  return values;
}

function exceedsTolerance(expected, actual, exact = false) {
  return Number.isFinite(expected) && Number.isFinite(actual)
    && Math.abs(expected - actual) > (exact ? 0.01 : Math.max(0.025, expected * 0.005));
}

export function reviewBodyDimensions(drawing, geometry, custom = {}) {
  if (!drawing?.bodyBounds || !geometry?.bodySize) return [];
  return axes.flatMap((axis, index) => {
    const expected = drawing.bodyBounds[axis];
    const actual = geometry.bodySize[index];
    if (Number.isFinite(custom[axis]) || !exceedsTolerance(expected, actual)) return [];
    return [t('本体 ${1} 轴图纸读数 ${2} mm，CAD 实测 ${3} mm。', axis.toUpperCase(), expected, Number(actual.toFixed(4)))];
  });
}

export function compareDimensions(drawing, target, geometry, custom, earlierDrawing) {
  return axes.map((axis, index) => {
    const reading = drawing?.bounds?.[axis];
    const planned = target?.[axis];
    const measured = geometry?.size[index];
    const previous = earlierDrawing?.bounds?.[axis];
    const userTarget = Number.isFinite(custom[axis]);
    return {
      axis, reading, planned, measured, previous, userTarget,
      evidence: drawing?.boundsEvidence?.[axis],
      extremes: geometry?.extremes[index],
      readingsDisagree: exceedsTolerance(previous, reading),
      targetDiffers: exceedsTolerance(reading, planned),
      geometryDiffers: exceedsTolerance(planned, measured, userTarget),
    };
  });
}
