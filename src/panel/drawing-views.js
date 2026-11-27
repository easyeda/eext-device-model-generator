const axes = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

export const viewDirections = {
  ...axes,
  '+X+Y+Z': [1, 1, 1], '+X-Y+Z': [1, -1, 1],
  '-X+Y+Z': [-1, 1, 1], '-X-Y+Z': [-1, -1, 1],
  '+X+Y-Z': [1, 1, -1], '+X-Y-Z': [1, -1, -1],
  '-X+Y-Z': [-1, 1, -1], '-X-Y-Z': [-1, -1, -1],
};

export const viewUpAxes = Object.keys(axes);

export function normalizeDrawingViews(views, pages) {
  if (!Array.isArray(views)) return [];
  const confirmed = [];
  for (const view of views) {
    if (!pages.has(view?.page) || view.kind !== 'whole_part' || typeof view.label !== 'string' || !view.label.trim()
      || !Object.hasOwn(viewDirections, view.direction)) continue;
    const { page, direction, up } = view;
    if (!viewUpAxes.includes(up) || (direction.length === 2 && up[1] === direction[1])) continue;
    confirmed.push({ page, label: view.label.trim().slice(0, 38), direction, up,
      position: typeof view.position === 'string' ? view.position.trim().slice(0, 50) : '' });
  }
  return confirmed;
}
