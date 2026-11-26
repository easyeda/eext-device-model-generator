import { t } from './i18n.js';
import { getDocument, PDFWorker } from 'pdfjs-dist';

const outline = /(?:package|component)\s+(outline|dimensions|drawing|information)|mechanical\s+(data|drawing|dimensions)|outline\s+dimensions|dimensional\s+drawing|封装[外尺机]|机械尺寸|外形尺寸|安装尺寸/i;
const other = /example board layout|land pattern example|example stencil design|recommended (land pattern|pcb layout)|推荐焊盘/i;
const appearance = /seating plane|terminal pitch|mounting hole|pin\s*1\s*(id|index)|bottom view|side view|安装孔|底视图/gi;
const details = /drawing|detail\s+[a-z]|dimension|standoff|引脚|尺寸/i;
const dimensionToken = /^(?:[a-z]\d?\s*=\s*)?(?:\d+\s*[×x]\s*)?(?:[Ø⌀ΦφR]\s*)?[+−-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*(?:±|[~～–—]|to)\s*\d+(?:[.,]\d+)?)*(?:\s*(?:°|mm|in|″))?$/i;

export async function openPdf(file, port) {
  const worker = new PDFWorker({ port });
  let task;
  async function close() {
    try {
      if (task) await task.destroy();
    } finally {
      worker.destroy();
      port.terminate();
    }
  }
  try {
    task = getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      worker,
      useWasm: false,
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    return { pdf, close, name: file.name, images: new Map(), candidates: undefined };
  } catch (error) {
    await close();
    throw error;
  }
}

function readText(items) {
  return items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
}

export function requestedDrawingPages(instruction, total) {
  const pages = new Set();
  const patterns = [
    /(?:第\s*)?(\d+(?:\s*(?:[、,，/＋+\-–—]|到|至|和|与|及)\s*(?:第\s*)?\d+)*)\s*(?:两\s*)?页/g,
    /\bpages?\s+(\d+(?:\s*(?:[,/\-–—]|\band\b|\bto\b)\s*\d+)*)/gi,
  ];
  for (const pattern of patterns) {
    for (const [, group] of instruction.matchAll(pattern)) {
      const groups = group.split(/\s*(?:[、,，/＋+]|和|与|及|\band\b)\s*/i);
      for (const group of groups) {
        const values = Array.from(group.matchAll(/\d+/g), match => Number(match[0]));
        if (values.some(page => page < 1 || page > total)) throw new Error(t('页码超出 PDF 范围（1–${1}）。', total));
        if (values.length > 2 || (values.length === 2 && values[0] > values[1])) throw new Error(t('请按从小到大的顺序指定页码范围。'));
        for (let page = values[0]; page <= values.at(-1); page += 1) pages.add(page);
      }
    }
  }
  return [...pages];
}

function includeNeighbors(pages, total) {
  return [...new Set([...pages, ...pages.flatMap(page => [page - 1, page + 1])])]
    .filter(page => page >= 1 && page <= total);
}

export async function candidatePages(document, preferredPages = []) {
  const { pdf } = document;
  if (preferredPages.length > 1) return preferredPages;
  if (preferredPages.length) return includeNeighbors(preferredPages, pdf.numPages);
  if (document.candidates) return document.candidates;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = readText((await page.getTextContent()).items);
    const hasOutline = outline.test(text);
    const score = (hasOutline ? 10 : 0)
      + Math.min((text.match(appearance) ?? []).length, 4)
      + (details.test(text) ? 2 : 0) - (!hasOutline && other.test(text) ? 6 : 0);
    pages.push({ pageNumber, score });
    page.cleanup();
  }
  const ranked = pages.filter(({ score }) => score >= 4).sort((a, b) => b.score - a.score || b.pageNumber - a.pageNumber);
  // Most scanned datasheets put the mechanical drawing at the back. Include
  // the first page as well, so the model has a chance to see the part identity.
  const tail = pages.slice(-3).map(({ pageNumber }) => pageNumber);
  document.candidates = ranked.length
    ? includeNeighbors(ranked.slice(0, 4).map(({ pageNumber }) => pageNumber), pdf.numPages)
    : [...new Set([1, ...tail])];
  return document.candidates;
}

export async function drawingCandidates(document, pages) {
  const images = [];
  const pixels = pages.length > 4 ? 900 : 1200;
  for (const page of pages) images.push(await pageImage(document, page, pixels));
  return images;
}

export async function drawingPageImages(document, { pages }) {
  const images = [];
  for (const page of pages) images.push(await pageImage(document, page, 2250));
  return images;
}

export async function drawingDimensionHints(document, { pages }) {
  const hints = [];
  for (const pageNumber of pages) {
    const page = await document.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    try {
      for (const item of (await page.getTextContent()).items) {
        const raw = item.str?.normalize('NFKC').trim();
        if (!raw || !dimensionToken.test(raw)) continue;
        const [viewX, viewY] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const x = viewX / viewport.width;
        const y = viewY / viewport.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
          hints.push({ page: pageNumber, raw, x: Math.round(x * 100), y: Math.round(y * 100) });
        }
      }
    } finally {
      page.cleanup();
    }
  }
  return hints;
}

async function pageImage(document, pageNumber, pixels) {
  const cacheKey = [pageNumber, pixels].join(':');
  const previous = document.images.get(cacheKey);
  if (previous) return previous;
  const page = await document.pdf.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(pixels / Math.max(original.width, original.height), 4);
  const viewport = page.getViewport({ scale });
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvas, viewport, background: '#fff' }).promise;
    const image = { page: pageNumber, url: canvas.toDataURL('image/jpeg', 0.9) };
    if (document.images.size >= 12) document.images.delete(document.images.keys().next().value);
    document.images.set(cacheKey, image);
    return image;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}
