import { t } from './i18n.js';
export async function composeLabeledImages(images) {
  if (!images.length) throw new Error(t('没有可用于拼接的参考图。'));
  const tiles = await Promise.all(images.map(async ({ url, label }) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { image, label };
  }));
  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const gap = 12;
  const header = 32;
  const maxSize = 3600;
  const cellWidth = Math.min(columns === 1 ? 2200 : 1200, Math.floor((maxSize - gap) / columns) - gap);
  const cellHeight = Math.floor((maxSize - gap) / rows) - header - gap;
  for (const tile of tiles) {
    const { naturalWidth, naturalHeight } = tile.image;
    const scale = Math.min(1, cellWidth / naturalWidth, cellHeight / naturalHeight);
    tile.width = Math.max(1, Math.floor(naturalWidth * scale));
    tile.height = Math.max(1, Math.floor(naturalHeight * scale));
  }
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(...tiles.slice(row * columns, (row + 1) * columns).map(tile => tile.height)));
  const columnWidth = Math.max(...tiles.map(tile => tile.width), Math.min(270, cellWidth));
  const canvas = document.createElement('canvas');
  canvas.width = (columnWidth + gap) * columns + gap;
  canvas.height = rowHeights.reduce((sum, height) => sum + height + header + gap, gap);
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('无法拼接视觉参考图。'));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = 'bold 20px sans-serif';
    context.textBaseline = 'middle';
    let y = gap;
    for (const [index, tile] of tiles.entries()) {
      const column = index % columns;
      const x = gap + column * (columnWidth + gap);
      context.fillStyle = '#243c60';
      context.fillRect(x, y, columnWidth, header);
      context.fillStyle = '#fff';
      context.fillText(tile.label, x + 10, y + header / 2, columnWidth - 20);
      context.drawImage(tile.image, x, y + header, tile.width, tile.height);
      if (column === columns - 1) y += rowHeights[Math.floor(index / columns)] + header + gap;
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
