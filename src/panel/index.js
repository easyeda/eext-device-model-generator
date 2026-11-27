import { openPdf, candidatePages, drawingCandidates, drawingDimensionHints, drawingPageImages, requestedDrawingPages } from './pdf.js';
import { createPreview, renderReviewViews } from './preview.js';
import { auditDrawingCallouts, customConnection, inspectDrawing, locateDrawing, prepareDrawingReference, publishedOutputLimit, readCustomKey, requestVision, reviewModelViews } from './vision.js';
import { createVisionSettingsStore, restoreOpenAiSettings } from './vision-settings.js';
import { resolveProposal, reviewTerminals } from '../model/model-plan.js';
import { axes, compareDimensions, readCustomDimensions, reviewBodyDimensions } from './dimensions.js';
import { bindPcbModel, createLibraryModel, pcbModelTransform, readBindingTarget, readPcbTargets } from './pcb-binding.js';
import { language, localizePanel, t } from './i18n.js';

const host = globalThis.eda;
const pdfInput = document.querySelector('#pdf');
const apiBase = document.querySelector('#api-base');
const customKey = document.querySelector('#custom-api-key');
const customModel = document.querySelector('#custom-model');
const maxOutputTokens = document.querySelector('#max-output-tokens');
const connectionError = document.querySelector('#api-connection-error');
const settingsStatus = document.querySelector('#settings-status');
const visualReview = document.querySelector('#visual-review');
const analyze = document.querySelector('#analyze');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const chatSend = document.querySelector('#chat-send');
const chatLog = document.querySelector('#chat-log');
const dimensions = document.querySelector('#dimensions');
const calloutStatus = document.querySelector('#callout-status');
const dimensionsMore = document.querySelector('#dimensions-more');
const dimensionsToggle = document.querySelector('#dimensions-toggle');
const rereadButton = document.querySelector('#reread');
const drawingDetails = document.querySelector('#drawing-details');
const drawingFrame = document.querySelector('#drawing-frame');
const drawingImages = document.querySelector('#drawing-images');
const drawingPagination = document.querySelector('#drawing-pagination');
const drawingPrevious = document.querySelector('#drawing-previous');
const drawingNext = document.querySelector('#drawing-next');
const drawingPageCount = document.querySelector('#drawing-page-count');
const featureNotes = document.querySelector('#feature-notes');
const packageLabel = document.querySelector('#package-label');
const source = document.querySelector('#source');
const status = document.querySelector('#status');
const operationFeedback = document.querySelector('#operation-feedback');
const workflowProgress = document.querySelector('#workflow-progress');
const stopVisualReview = document.querySelector('#stop-visual-review');
const save = document.querySelector('#save');
const importButton = document.querySelector('#import');
const pcbBinding = document.querySelector('#pcb-binding');
const pcbSelect = document.querySelector('#pcb-target');
const pcbRefresh = document.querySelector('#pcb-target-refresh');
const pcbBind = document.querySelector('#pcb-bind');
const pcbStatus = document.querySelector('#pcb-target-status');
const viewport = document.querySelector('#viewport');
const placeholder = document.querySelector('#preview-message');
const fitPreview = document.querySelector('#fit-preview');
const previewView = document.querySelector('#preview-view');
const showDimensions = document.querySelector('#show-dimensions');
const previewDimensions = document.querySelector('#preview-dimensions');
const lifetime = new AbortController();
const history = [];
const importedModels = new WeakMap();
const readingStages = ['locate', 'read', 'audit'];

let preview;
let exported;
let measuredGeometry;
let current;
let draft;
let buildFailure;
let inspection;
let drawingLocation;
let drawingImage;
let drawingQuestion;
let drawingPage = 0;
let dimensionsExpanded = false;
let drawingSwipeStart;
let earlierInspection;
let pdfDocument;
let worker;
let busy = false;
let workflowStages;
let reviewController;
let pcbTargets;
let loadingTargets = false;

const settingsStore = createVisionSettingsStore(host, message => {
  settingsStatus.textContent = message;
  settingsStatus.hidden = !message;
});
const settingsFields = { apiBase, customModel, customKey, maxOutputTokens };
let loadingSettings = true;
let retainedCustomKey = '';
let manualOutputTokens = '';
let automaticOutputTokens;
let outputLookupTimer;
let outputLookupVersion = 0;
importButton.hidden = !host?.lib_3DModel?.create || !host?.lib_LibrariesList?.getPersonalLibraryUuid;

async function restoreVisionSettings() {
  const saved = await settingsStore.load();
  if (lifetime.signal.aborted) return;
  manualOutputTokens = typeof saved.maxOutputTokens === 'string' ? saved.maxOutputTokens : '';
  const settings = { ...restoreOpenAiSettings(saved), maxOutputTokens: manualOutputTokens };
  for (const [name, field] of Object.entries(settingsFields)) field.value = settings[name];
  visualReview.checked = saved.visualReview === true;
  retainedCustomKey = readCustomKey(customKey.value) ?? '';
  loadingSettings = false;
  refreshAutomaticOutputLimit();
  refreshControls();
}

function renderOutputLimit() {
  const automatic = !manualOutputTokens && automaticOutputTokens !== undefined;
  if (document.activeElement !== maxOutputTokens) {
    maxOutputTokens.value = automatic ? String(automaticOutputTokens) : manualOutputTokens;
  }
  maxOutputTokens.placeholder = automatic ? t('${1}（自动）', automaticOutputTokens) : t('自动');
  maxOutputTokens.toggleAttribute('data-automatic', automatic);
  maxOutputTokens.title = automatic ? t('OpenRouter 自动读取。输入数值可手动覆盖，清空恢复自动。') : t('填写数值或留空使用自动设置。');
}

function refreshAutomaticOutputLimit() {
  clearTimeout(outputLookupTimer);
  const version = ++outputLookupVersion;
  automaticOutputTokens = undefined;
  renderOutputLimit();
  if (manualOutputTokens) return;
  let connection;
  try {
    connection = customConnection(apiBase.value, customModel.value, '');
  } catch {
    return;
  }
  outputLookupTimer = setTimeout(async () => {
    const limit = await publishedOutputLimit(connection.endpoint, connection.model);
    if (lifetime.signal.aborted || version !== outputLookupVersion || manualOutputTokens) return;
    automaticOutputTokens = limit;
    renderOutputLimit();
  }, 300);
}

function saveVisionSettings(event) {
  if (event.target === maxOutputTokens) manualOutputTokens = maxOutputTokens.value.trim();
  retainedCustomKey = readCustomKey(customKey.value) ?? retainedCustomKey;
  settingsStore.save({
    apiBase: apiBase.value.trim(),
    customModel: customModel.value.trim(),
    customKey: retainedCustomKey,
    maxOutputTokens: manualOutputTokens,
    visualReview: visualReview.checked,
  });
  if ([apiBase, customModel, maxOutputTokens].includes(event.target)) refreshAutomaticOutputLimit();
  refreshControls();
}

async function libraryModel(file) {
  if (!importedModels.has(file)) importedModels.set(file, await createLibraryModel(host, file));
  return importedModels.get(file);
}

function chosenPcbTarget() {
  return pcbTargets?.targets.find(target => target.id === pcbSelect.value);
}

function renderPcbTarget() {
  const target = chosenPcbTarget();
  pcbStatus.textContent = target?.model?.uuid
    ? t('当前模型 · ${1}', target.model.name || t('已绑定'))
    : target ? t('已选中 ${1}', target.designator)
      : pcbTargets?.targets.length ? t('请选择一个器件，或在 PCB 画布单选后刷新。') : t('当前 PCB 没有可选器件。');
  refreshControls();
}

async function refreshPcbTargets() {
  if (loadingTargets || busy) return;
  loadingTargets = true;
  const oldSelection = pcbSelect.value;
  const previousDocument = pcbTargets?.document;
  pcbStatus.textContent = t('正在读取 PCB 器件…');
  refreshControls();
  try {
    pcbTargets = await readPcbTargets(host);
    pcbSelect.replaceChildren(new Option(t('请选择一个器件'), ''), ...pcbTargets.targets.map(
      target => new Option([target.designator, target.name].filter(Boolean).join(' · '), target.id)));
    const restored = pcbTargets.document.tabId === previousDocument?.tabId
      && pcbTargets.targets.some(target => target.id === oldSelection);
    pcbSelect.value = pcbTargets.selectedId ?? (restored ? oldSelection : '');
    renderPcbTarget();
  } catch (error) {
    pcbTargets = undefined;
    pcbSelect.replaceChildren(new Option(t('请选择一个器件'), ''));
    pcbStatus.textContent = error.message;
  } finally {
    loadingTargets = false;
    refreshControls();
  }
}

async function initPcbBinding() {
  if (importButton.hidden || !host?.dmt_SelectControl?.getCurrentDocumentInfo
    || !host?.pcb_PrimitiveComponent?.modify || !host?.pcb_PrimitiveComponent?.getAll
    || !host?.pcb_SelectControl?.getAllSelectedPrimitives_PrimitiveId) return;
  try {
    const document = await host.dmt_SelectControl.getCurrentDocumentInfo();
    if (document?.documentType !== 3) return;
    pcbBinding.hidden = false;
    await refreshPcbTargets();
  } catch {
    // Library import and STEP export remain available independently.
  }
}

function tell(message, error = false) {
  operationFeedback.hidden = false;
  operationFeedback.dataset.error = String(error);
  if (!workflowStages) workflowProgress.hidden = true;
  status.textContent = message;
  status.dataset.error = String(error);
}

function beginWorkflow(stages) {
  workflowStages = stages;
  workflowProgress.max = stages.length + 1;
  workflowProgress.value = 0;
  workflowProgress.removeAttribute('aria-valuetext');
  workflowProgress.hidden = false;
}

function showStage(stage, message) {
  const position = workflowStages?.indexOf(stage) ?? -1;
  if (position >= 0) {
    if (stage === 'review') workflowProgress.removeAttribute('value');
    else workflowProgress.value = Math.max(workflowProgress.value, position + 1);
    workflowProgress.setAttribute('aria-valuetext', message);
  }
  tell(message);
}

function refreshControls() {
  let connectionProblem = '';
  try {
    customConnection(apiBase.value, customModel.value, customKey.value, manualOutputTokens);
  } catch (error) {
    connectionProblem = error.message;
  }
  connectionError.textContent = connectionProblem;
  connectionError.hidden = loadingSettings || !connectionProblem || !Object.values(settingsFields).some(field => field.value.trim());
  const configDisabled = busy || loadingSettings;
  const canAsk = !configDisabled && !!pdfDocument && !connectionProblem;
  pdfInput.disabled = busy;
  for (const field of Object.values(settingsFields)) field.disabled = configDisabled;
  visualReview.disabled = configDisabled;
  analyze.disabled = !canAsk;
  rereadButton.disabled = !canAsk || !inspection;
  chatInput.disabled = !canAsk;
  chatSend.disabled = !canAsk || !chatInput.value.trim();
  save.disabled = busy || !exported;
  importButton.disabled = busy || !exported;
  const target = chosenPcbTarget();
  pcbRefresh.disabled = busy || loadingTargets;
  pcbSelect.disabled = busy || loadingTargets || !pcbTargets?.targets.length;
  pcbBind.disabled = busy || loadingTargets || !exported || !target;
  pcbBind.textContent = target?.model?.uuid ? t('替换 3D 模型') : t('绑定到器件');
}

function formatDimension(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(4))) : '—';
}

function renderPreviewDimensions() {
  showDimensions.disabled = !measuredGeometry;
  previewDimensions.hidden = !measuredGeometry || !showDimensions.checked;
  const labels = measuredGeometry ? axes.map((axis, index) => {
    const label = document.createElement('span');
    label.dataset.axis = axis;
    label.textContent = axis.toUpperCase() + ' ' + formatDimension(measuredGeometry.size[index]) + ' mm';
    return label;
  }) : [];
  previewDimensions.replaceChildren(...labels);
  preview?.setDimensionsVisible(showDimensions.checked);
}

function renderValidationNotes() {
  const matchingPage = !current || inspection?.page === current.page;
  const rows = compareDimensions(matchingPage ? inspection : undefined, current?.bounds, measuredGeometry,
    current?.custom ?? {}, matchingPage ? earlierInspection : undefined);
  const warnings = [...(measuredGeometry?.alignmentWarnings ?? []), ...(measuredGeometry?.mechanicalWarnings ?? []),
    ...(matchingPage && inspection && current ? [
      ...reviewTerminals(inspection, current), ...reviewBodyDimensions(inspection, measuredGeometry, current.custom),
    ] : [])];
  for (const row of rows) {
    const axis = row.axis.toUpperCase();
    if (row.geometryDiffers) warnings.push(t('${1} 轴 CAD 实测 ${2} mm，目标 ${3} mm。', axis, formatDimension(row.measured), formatDimension(row.planned)));
    if (row.targetDiffers && !row.userTarget) warnings.push(t('${1} 轴 建模目标 ${2} mm，图纸读数 ${3} mm。', axis, formatDimension(row.planned), formatDimension(row.reading)));
    if (row.readingsDisagree && !row.userTarget) warnings.push(t('${1} 轴 本次读数 ${2} mm，前次读数 ${3} mm。', axis, formatDimension(row.reading), formatDimension(row.previous)));
  }
  featureNotes.hidden = !warnings.length;
  featureNotes.textContent = warnings.join(' ');
  const isDraft = warnings.length > 0;
  save.textContent = isDraft ? t('保存草稿 STEP') : t('保存 STEP');
  importButton.textContent = isDraft ? t('导入草稿到个人库') : t('导入个人库');
  return isDraft;
}

function fitDimensionCards() {
  const cards = Array.from(dimensions.children);
  for (const card of cards) card.hidden = false;
  dimensionsMore.hidden = true;
  if (drawingDetails.hidden || !cards.length) return;

  const frame = drawingFrame.getBoundingClientRect();
  const grid = dimensions.getBoundingClientRect();
  const available = grid.top < frame.bottom ? frame.bottom - grid.top : frame.height;
  if (grid.height <= available + 0.5) return;

  dimensionsMore.hidden = false;
  dimensionsToggle.setAttribute('aria-expanded', String(dimensionsExpanded));
  if (dimensionsExpanded) {
    dimensionsToggle.textContent = t('收起');
    return;
  }
  const limit = grid.top + available - dimensionsMore.offsetHeight;
  const visibleCount = cards.findIndex(card => card.getBoundingClientRect().bottom > limit + 0.5);
  const hiddenCards = cards.slice(Math.max(visibleCount, 0));
  for (const card of hiddenCards) card.hidden = true;
  dimensionsToggle.textContent = t('展开剩余 ${1} 项', hiddenCards.length);
}

function renderDimensions() {
  const activePage = drawingPage || inspection?.page;
  const callouts = inspection?.callouts?.filter(item => item.page === activePage);
  const unread = callouts?.filter(item => item.reading === 'unclear' || item.scope === 'unknown').length ?? 0;
  const measurements = (inspection?.measurements ?? []).filter(item => {
    const pageNumber = /第\s*(\d+)\s*页|\bpage\s*(\d+)\b|页\s*(\d+)/i.exec(item.source);
    const page = pageNumber ? Number(pageNumber[1] ?? pageNumber[2] ?? pageNumber[3]) : inspection?.page;
    return page === activePage;
  });
  const rows = [
    ...(callouts ?? []).map(item => ({
      label: (item.scope === 'pcb' ? 'PCB · ' : '') + item.label,
      value: item.reading === 'unclear' ? [item.raw, t('待辨认')].filter(Boolean).join(' · ') : item.raw,
      source: [t('PDF 第 ${1} 页', item.page), item.view, item.scope === 'unknown' ? t('归属待核对') : ''].filter(Boolean).join(' · '),
    })),
    ...measurements.map(({ label, mm, source }) => ({ label, value: formatDimension(mm) + ' mm',
      source: callouts ? [source, t('首轮读数待复核')].filter(Boolean).join(' · ') : source })),
  ].map(({ label, value, source }) => {
    const cell = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const valueElement = document.createElement('dd');
    valueElement.textContent = value;
    cell.append(term, valueElement);
    const note = document.createElement('small');
    note.textContent = source;
    cell.append(note);
    return cell;
  });
  calloutStatus.hidden = !inspection;
  const pending = unread + measurements.length;
  calloutStatus.textContent = callouts
    ? t('图纸尺寸标注 · ${1} 项', rows.length) + (pending ? ' · ' + t('${1} 项待核对', pending) : '')
    : t('首轮读数 · ${1} 项 · 复核未完成', rows.length);
  dimensions.replaceChildren(...rows);
  fitDimensionCards();
  const sourceModel = current ?? inspection;
  packageLabel.textContent = sourceModel ? sourceModel.name + ' · ' + t('PDF 第 ${1} 页', sourceModel.page) : '';
  return renderValidationNotes();
}

function clearSource() {
  current = undefined;
  draft = undefined;
  buildFailure = undefined;
  inspection = undefined;
  drawingLocation = undefined;
  drawingImage = undefined;
  drawingQuestion = undefined;
  earlierInspection = undefined;
  exported = undefined;
  measuredGeometry = undefined;
  history.length = 0;
  chatLog.replaceChildren();
  chatInput.value = '';
  drawingDetails.hidden = true;
  dimensionsExpanded = false;
  drawingImages.replaceChildren();
  showDrawingPage(0);
  preview?.clear();
  renderPreviewDimensions();
  placeholder.textContent = t('识别成功后显示模型');
  placeholder.hidden = false;
  fitPreview.disabled = true;
  previewView.disabled = true;
  renderDimensions();
}

function addChat(role, message) {
  const entry = document.createElement('p');
  entry.className = 'message';
  entry.dataset.role = role;
  entry.textContent = (role === 'user' ? t('你') : 'AI') + ' · ' + message;
  chatLog.append(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
  history.push({ role, content: message });
  if (history.length > 8) history.shift();
}

async function run(message, action) {
  if (busy) return;
  busy = true;
  refreshControls();
  tell(message);
  let completed;
  try {
    completed = await action();
  } catch (error) {
    if (!lifetime.signal.aborted) {
      if (reviewController?.signal.aborted) {
        const note = exported ? t('已停止多轮校正，保留最近生成的模型和 STEP。') : t('已停止多轮校正，尚未生成模型。');
        tell(note);
        addChat('assistant', note);
      } else {
        const message = error?.name === 'TimeoutError'
          ? t('模型 API 请求超时。请重试或切换模型。')
          : error?.message ?? String(error);
        tell(message, true);
      }
    }
  } finally {
    if (workflowStages) {
      if (completed === true) {
        workflowProgress.value = workflowProgress.max;
        workflowProgress.setAttribute('aria-valuetext', t('已完成'));
      } else {
        workflowProgress.hidden = status.dataset.error !== 'true';
        workflowProgress.setAttribute('aria-valuetext', status.textContent);
      }
      workflowStages = undefined;
    }
    reviewController = undefined;
    stopVisualReview.hidden = true;
    busy = false;
    refreshControls();
  }
}

async function asset(path) {
  if (host) {
    const file = await host.sys_FileSystem.getExtensionFile(path);
    if (!file) throw new Error(t('扩展中的资源无法读取：${1}', path));
    return file;
  }
  const response = await fetch('..' + path);
  if (!response.ok) throw new Error(t('资源无法读取：${1}', path));
  return response.blob();
}

async function loadWorker(path, type) {
  const code = await asset(path);
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return new Worker(url, { type });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function generateModel(plan, signal = lifetime.signal) {
  signal.throwIfAborted();
  try {
    worker ??= await loadWorker('/assets/model-worker.js', 'classic');
    signal.throwIfAborted();
    const modelWorker = worker;
    return await new Promise((resolve, reject) => {
      const finish = (handler, value) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        modelWorker.onmessage = modelWorker.onerror = modelWorker.onmessageerror = null;
        handler(value);
      };
      const cancel = () => finish(reject, signal.reason);
      const failedWorker = message => finish(reject, new Error(message));
      let timeout = setTimeout(() => failedWorker(t('build123d 本地运行时启动超时，请重试。')), 180000);
      signal.addEventListener('abort', cancel, { once: true });
      modelWorker.onmessage = ({ data }) => {
        if (data.asset) {
          const { id, path } = data.asset;
          void asset(path).then(file => ({ id, file }), error => ({ id, error: error.message }))
            .then(assetReply => { if (worker === modelWorker && !signal.aborted) modelWorker.postMessage({ assetReply }); });
        } else if (data.progress) {
          tell(t(data.progress));
          if (data.phase === 'geometry') {
            clearTimeout(timeout);
            timeout = setTimeout(() => failedWorker(t('build123d 计算模型超时，可在对话中要求简化几何后重试。')), 240000);
          }
        } else if (data.error) {
          const error = new Error(data.runtime ? t('build123d 本地运行时加载失败。${1}', data.error) : t(data.error));
          if (!data.runtime) error.name = 'CADGeometryError';
          finish(reject, error);
        } else finish(resolve, data);
      };
      modelWorker.onerror = event => failedWorker(event.message || t('建模 Worker 加载失败。'));
      modelWorker.onmessageerror = () => failedWorker(t('无法读取建模结果。'));
      modelWorker.postMessage({ plan });
    });
  } catch (error) {
    if (error.name === 'CADGeometryError') throw error;
    worker?.terminate();
    worker = undefined;
    signal.throwIfAborted();
    const failure = new Error(error.message, { cause: error });
    failure.name = 'CADRuntimeError';
    throw failure;
  }
}

function applyProposal(proposal, { step, parts, size, extremes, min, max, mechanicalWarnings, alignmentWarnings, bodySize, terminalLayout },
  custom, announce = true) {
  current = { ...proposal, custom, sourcePages: inspection.sourcePages };
  measuredGeometry = { parts, size, extremes, min, max, mechanicalWarnings, alignmentWarnings, bodySize, terminalLayout };
  draft = undefined;
  buildFailure = undefined;
  const fileName = (proposal.name.trim().replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]+/g, '-').slice(0, 75) || 'component') + '.step';
  exported = new File([step], fileName, { type: 'application/step' });
  const isDraft = renderDimensions();
  try {
    preview ??= createPreview(viewport);
    preview.show(parts, { min, max });
    placeholder.hidden = true;
    fitPreview.disabled = false;
    previewView.disabled = false;
  } catch {
    placeholder.textContent = t('当前环境无法显示 3D 预览，可保存 STEP。');
    placeholder.hidden = false;
    fitPreview.disabled = true;
    previewView.disabled = true;
  }
  renderPreviewDimensions();
  if (announce) tell((isDraft ? t('已生成草稿 · 请查看尺寸对照') : t('STEP 已生成')) + ' · ' + t('外形') + ' '
    + size.map(formatDimension).join(' × ') + ' mm');
}

function visionCredentials(signal = lifetime.signal) {
  const connection = customConnection(apiBase.value, customModel.value, customKey.value, manualOutputTokens);
  return { ...connection, signal, language,
    onRetry: (stage, message) => tell(t('${1}结果被截断，${2}', stage, message ?? t('正在重试…'))) };
}

function samePages(first, second) {
  return first.length === second.length && first.every(page => second.includes(page));
}

function showDrawingPage(page) {
  drawingPage = page;
  const pages = inspection?.sourcePages ?? [];
  const index = pages.indexOf(page);
  for (const figure of drawingImages.children) {
    figure.hidden = Number(figure.dataset.page) !== page;
  }
  const paginated = index >= 0 && pages.length > 1;
  drawingPagination.hidden = !paginated;
  drawingFrame.tabIndex = paginated ? 0 : -1;
  drawingPrevious.disabled = index <= 0;
  drawingNext.disabled = index < 0 || index === pages.length - 1;
  drawingPageCount.textContent = index >= 0 ? t('PDF 第 ${1} 页', page)
    + (paginated ? ' · ' + (index + 1) + ' / ' + pages.length : '') : '';
}

function turnDrawingPage(delta) {
  const pages = inspection?.sourcePages ?? [];
  const index = pages.indexOf(drawingPage);
  const next = pages[index + delta];
  if (index < 0 || next === undefined) return;
  dimensionsExpanded = false;
  showDrawingPage(next);
  renderDimensions();
}

function drawingFigure({ page, url }) {
  const figure = document.createElement('figure');
  figure.dataset.page = String(page);
  const image = document.createElement('img');
  image.alt = t('PDF 第 ${1} 页', page);
  image.draggable = false;
  image.src = url;
  figure.append(image);
  return figure;
}

function showDrawingImages(images, primaryPage) {
  const figures = images.map(drawingFigure);
  drawingImages.replaceChildren(...figures);
  showDrawingPage(images.some(image => image.page === drawingPage) ? drawingPage : primaryPage);
}

async function readDrawing(preferredPages, instruction, { review, followUp }) {
  const credentials = visionCredentials();
  const pending = followUp ? drawingQuestion : undefined;
  const answers = pending ? [...new Set([...pending.answers, instruction])].slice(-4) : [];
  if (pending) drawingQuestion = { ...pending, answers };
  let location = review && !pending && drawingLocation && (!preferredPages.length
    || (preferredPages.length === 1 && preferredPages[0] === drawingLocation.page)
    || samePages(preferredPages, inspection.sourcePages)) ? drawingLocation : undefined;
  if (!location) {
    showStage('locate', t('正在寻找 PDF 的机械图…'));
    const numbers = await candidatePages(pdfDocument, preferredPages);
    tell(t('正在定位 PDF 第 ${1} 页的机械图…', numbers.join(language === 'en' ? ', ' : '、')));
    const candidates = await drawingCandidates(pdfDocument, numbers);
    location = await locateDrawing({ ...credentials, images: candidates, instruction,
      requiredPages: preferredPages, documentName: pdfDocument.name, pending,
      onRepair: () => tell(t('正在自动复核机械图的位置…')) });
    if (location.status === 'question') {
      drawingQuestion = { reply: location.reply, choices: location.choices.length ? location.choices : pending?.choices ?? [], answers };
      return location;
    }
  }
  const sourcePages = location.pages;
  const pageList = sourcePages.join(language === 'en' ? ', ' : '、');
  showStage('read', t(review ? '正在复核 PDF 第 ${1} 页的机械图' : '正在读取 PDF 第 ${1} 页的机械图', pageList) + '…');
  const images = await drawingPageImages(pdfDocument, location);
  const hints = await drawingDimensionHints(pdfDocument, location).catch(() => []);
  const reference = await prepareDrawingReference(images, hints);
  const target = [location.partNumber, location.packageName].filter(Boolean).join(' · ');
  const result = await inspectDrawing({ ...credentials, reference, instruction, primaryPage: location.page, target });
  if (result.status === 'ready') {
    const firstPass = (Array.isArray(result.measurements) ? result.measurements : []).filter(item => typeof item?.label === 'string'
      && Number.isFinite(item.mm) && typeof item.source === 'string');
    let audit;
    let paymentFailure;
    showStage('audit', t('正在逐视图复核尺寸标注…'));
    try {
      audit = await auditDrawingCallouts({ ...credentials, reference, inspection: result, target, firstPass });
    } catch (error) {
      credentials.signal.throwIfAborted();
      if (error.name === 'PaymentRequiredError') paymentFailure = error;
      // The first reading remains available when the dimension audit fails.
    }
    const audited = new Set(audit?.callouts.map(item => item.firstPassIndex));
    const measurements = firstPass.filter((item, index) => !audited.has(index + 1));
    drawingQuestion = undefined;
    drawingLocation = location;
    drawingImage = reference.image;
    earlierInspection = review && inspection?.page === result.page && samePages(inspection.sourcePages, sourcePages)
      ? inspection : undefined;
    inspection = { ...result, ...audit, target, sourcePages, measurements, reader: credentials.model };
    showDrawingImages(images, location.page);
    drawingDetails.hidden = false;
    renderDimensions();
    if (paymentFailure) throw paymentFailure;
    return inspection;
  }
  if (followUp || !review) {
    drawingQuestion = { reply: result.reply, choices: pending?.choices ?? [], answers };
  }
  return result;
}

async function rereadDrawing() {
  beginWorkflow(drawingLocation ? ['read', 'audit'] : readingStages);
  const result = await readDrawing([], '独立复核所选机械图：确认标注视图、箭头起止、单位和包括端子的整件跨度。仅引用所选页的图纸依据。',
    { review: true });
  if (result.status === 'question') addChat('assistant', result.reply);
  tell(result.status === 'ready'
    ? t('已更新 PDF 第 ${1} 页的读数与依据。', inspection.sourcePages.join(language === 'en' ? ', ' : '、'))
    : t('复核需要更多图纸信息。'));
  return result.status === 'ready';
}

function checkGeneratedModel(drawing, proposal, output, custom, checkBody) {
  return {
    mismatches: compareDimensions(drawing, proposal.bounds, output, custom).filter(row => row.geometryDiffers),
    alignmentWarnings: output.alignmentWarnings ?? [],
    featureWarnings: [...reviewTerminals(drawing, proposal), ...output.mechanicalWarnings,
      ...(checkBody ? reviewBodyDimensions(drawing, output, custom) : [])],
  };
}

function waitForReviewRetry(seconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function beginReview() {
  if (!reviewController) {
    reviewController = new AbortController();
    stopVisualReview.hidden = false;
    stopVisualReview.disabled = false;
    if (workflowStages && !workflowStages.includes('review')) {
      workflowStages.push('review');
      workflowProgress.max = workflowStages.length + 1;
    }
  }
  return AbortSignal.any([reviewController.signal, lifetime.signal]);
}

async function retryReview(message, failures, signal) {
  signal.throwIfAborted();
  const seconds = 2 ** Math.min(failures, 4);
  showStage('review', message + ' · ' + t('${1} 秒后继续校正。', seconds));
  await waitForReviewRetry(seconds, signal);
  signal.throwIfAborted();
}

async function refineWithModelViews(proposal, output, drawing, custom, instruction, checkBody) {
  if (!drawing.views.length) return { proposal, output, note: ' ' + t('图纸视角未确认，保留当前模型。') };
  const signal = beginReview();
  let latest = { proposal, output };
  let round = 0;
  let revisions = 0;
  let failures = 0;
  let retryFeedback = '';
  let images;
  let comparison;
  let previousOutput;
  let assessment;
  let previousIssues = [];
  applyProposal(proposal, output, custom, false);
  for (;;) {
    signal.throwIfAborted();
    try {
      const checks = checkGeneratedModel(drawing, latest.proposal, latest.output, custom, checkBody);
      const diagnostics = [
        ...checks.alignmentWarnings,
        ...checks.mismatches.map(({ axis, measured, planned, extremes }) => {
          const index = axes.indexOf(axis);
          return axis.toUpperCase() + ' 轴实测 ' + formatDimension(measured) + ' mm，目标 ' + formatDimension(planned)
            + ' mm，实测端点 ' + extremes.from + '@' + formatDimension(latest.output.min[index])
            + ' 和 ' + extremes.to + '@' + formatDimension(latest.output.max[index]) + ' mm';
        }),
        ...checks.featureWarnings,
      ];
      if (!assessment) {
        showStage('review', previousOutput ? t('正在比较第 ${1} 轮修正前后的多视图…', round) : t('正在对照 CAD 多视图与原图…'));
        images ??= await drawingPageImages(pdfDocument, drawingLocation);
        signal.throwIfAborted();
        if (!comparison) {
          const { min, max } = latest.output;
          // Frame both meshes together so newly displaced parts stay visible at the same scale.
          const frame = previousOutput ? {
            min: min.map((value, index) => Math.min(value, previousOutput.min[index])),
            max: max.map((value, index) => Math.max(value, previousOutput.max[index])),
          } : { min, max };
          comparison = { images, candidate: renderReviewViews(latest.output.parts, frame, drawing.views),
            before: previousOutput ? renderReviewViews(previousOutput.parts, frame, drawing.views) : undefined };
        }
        assessment = await reviewModelViews({ ...visionCredentials(signal), ...comparison, diagnostics,
          views: drawing.views, issues: previousIssues, instruction, custom, target: drawing.target || drawing.name,
          cadDimensions: { size: latest.output.size, bodySize: latest.output.bodySize } });
        signal.throwIfAborted();
      }
      if (assessment.verdict === 'matches' && !assessment.issues.length && !diagnostics.length) {
        return { ...latest, note: revisions ? t('经过 ${1} 轮修正，多视图复核通过。', revisions) : t('多视图复核通过。') };
      }
      const issues = assessment.issues;
      if (!issues.length && !diagnostics.length) {
        assessment = undefined;
        previousOutput = undefined;
        comparison = undefined;
        throw new Error(t('尚未确认模型吻合，正在准备重新核对'));
      }
      round += 1;
      showStage('review', t('正在进行第 ${1} 轮多视图校正…', round));
      const guidance = instruction + '\n根据附图和 CAD 检查结果修正当前模型：'
        + JSON.stringify({ verdict: assessment.verdict, issues, diagnostics })
        + (latest.output.terminalLayout?.length ? '\nCAD 端子组实测包围盒和首末实例包围盒中心（全局 XYZ，mm）：'
          + JSON.stringify(latest.output.terminalLayout) : '')
        + (retryFeedback ? '\n上一轮反馈：' + retryFeedback : '')
        + '\n只处理当前有依据的几何偏差。用图上的安装面或实体边定位，保留用户目标和其余已确认结构与外观。';
      const response = await requestVision({ ...visionCredentials(signal), inspection: drawing, instruction: guidance,
        current: latest.proposal, custom, comparison: { images, candidate: comparison.candidate } });
      signal.throwIfAborted();
      const candidate = response.action === 'edit' && !response.appearanceEdits?.length
        ? resolveProposal(response, [drawing.page], latest.proposal) : null;
      if (!candidate || JSON.stringify(candidate.parts) === JSON.stringify(latest.proposal.parts)) {
        throw new Error(t('这轮没有得到新的几何，下一轮将换一种修正方式'));
      }
      candidate.bounds = { ...candidate.bounds, ...Object.fromEntries(Object.entries(proposal.bounds)
        .filter(([, value]) => Number.isFinite(value))), ...custom };
      const generated = await generateModel(candidate, signal);
      signal.throwIfAborted();
      previousOutput = latest.output;
      latest = { proposal: candidate, output: generated };
      applyProposal(candidate, generated, custom, false);
      revisions += 1;
      previousIssues = issues;
      comparison = undefined;
      assessment = undefined;
      retryFeedback = '';
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (error.name === 'PaymentRequiredError' || error.name === 'CADRuntimeError') throw error;
      retryFeedback = (error?.message ?? String(error)).slice(0, 320);
      await retryReview(retryFeedback, failures++, signal);
    }
  }
}

async function ask(instruction, initial, historyToSend = []) {
  if (initial) drawingQuestion = undefined;
  const confirmingDrawing = Boolean(drawingQuestion);
  const specifiedPages = requestedDrawingPages(instruction, pdfDocument.pdf.numPages);
  const priorModel = draft ?? current;
  const customUpdate = readCustomDimensions(instruction);
  const restoreDrawing = /^(?:恢复图纸尺寸|restore drawing dimensions)[。.]?$/i.test(instruction);
  const review = /重新(?:识别|读图|核对)|复核.*(?:图纸|标注)|\b(?:reread|review|recheck)\b.*\b(?:drawing|annotations)\b/i.test(instruction);
  const rebuild = /重建|重新生成|重新建模|\b(?:rebuild|regenerate)\b/i.test(instruction);
  const needsReading = !inspection || initial || confirmingDrawing || specifiedPages.length || review || rebuild;
  const continuous = visualReview.checked;
  beginWorkflow([...(needsReading ? readingStages : []), 'plan', 'build', ...(continuous ? ['review'] : [])]);
  if (needsReading) {
    const result = await readDrawing(specifiedPages,
      !initial && !customUpdate ? instruction : '识别器件机械外形、端子布局、可见结构与原始图纸尺寸。',
      { review, followUp: !initial });
    if (result.status === 'question') {
      addChat('assistant', result.reply);
      tell(t('请在对话中回复 AI 的确认问题。'));
      return;
    }
  }

  const drawing = inspection;
  const changedDrawing = priorModel && (priorModel.page !== drawing.page
    || !samePages(priorModel.sourcePages ?? [priorModel.page], drawing.sourcePages));
  const prior = initial || rebuild || changedDrawing || confirmingDrawing ? undefined : priorModel;
  const custom = restoreDrawing ? {} : { ...prior?.custom, ...customUpdate };
  const modelingHistory = prior ? historyToSend : [];
  const alignmentEdit = prior && /偏移|错位|不对位|对不齐|对齐|悬空|脱离|\b(?:align|alignment|misalign|misaligned|misalignment|offset)\b/i.test(instruction);
  const sourceTargets = !prior || restoreDrawing || alignmentEdit
    ? Object.fromEntries(Object.entries(drawing.bounds ?? {}).filter(([, value]) => Number.isFinite(value))) : {};
  const intent = instruction + (restoreDrawing ? '\n将整件外形恢复为当前图纸可核对的尺寸，重算对应实体。' : '')
    + (alignmentEdit ? '\n按图纸基准修正接合位置，核对端子中心、节距及整件跨度。' : '');
  let request = prior && buildFailure ? intent + '\n上次 CAD 校验反馈：' + buildFailure : intent;
  let working = prior;
  let priorFeedback;
  let signal = lifetime.signal;
  let failures = 0;
  let generatedFirst = false;
  let alignmentOutput = alignmentEdit && current?.page === drawing.page
    && samePages(current.sourcePages, drawing.sourcePages) ? measuredGeometry : undefined;
  let comparison;
  const lastAttempt = 2;
  for (let attempt = 0; reviewController || attempt <= lastAttempt; attempt += 1) {
    showStage(reviewController ? 'review' : 'plan', attempt ? t('正在按 CAD 校验结果修正几何…') : t('AI 正在计算实体几何…'));
    let result;
    try {
      if (!comparison && alignmentOutput) {
        comparison = { images: await drawingPageImages(pdfDocument, drawingLocation) };
        signal.throwIfAborted();
        if (alignmentOutput?.parts?.length) {
          try {
            comparison.candidate = renderReviewViews(alignmentOutput.parts, alignmentOutput, drawing.views);
          } catch {
            // The drawing and CAD diagnostics still provide evidence if WebGL is unavailable.
          }
        }
      }
      const coordinateEvidence = alignmentOutput?.terminalLayout?.length
        ? '\nCAD 端子组实测包围盒和首末实例包围盒中心（全局 XYZ，mm）：' + JSON.stringify(alignmentOutput.terminalLayout) : '';
      const previewNote = alignmentOutput && alignmentOutput === measuredGeometry && working !== current
        ? '\nCAD 实测来自最近成功生成的预览。当前建模描述可能包含后续未通过的尝试。' : '';
      result = await requestVision({ ...visionCredentials(signal), inspection: drawing, instruction: request + previewNote + coordinateEvidence,
        history: modelingHistory, current: working, custom, drawingImage, comparison });
      signal.throwIfAborted();
    } catch (error) {
      if (!reviewController || error.name === 'PaymentRequiredError') throw error;
      await retryReview(error.message, failures++, signal);
      continue;
    }
    let proposal;
    const appearanceOnly = result.action === 'edit' && result.appearanceEdits?.length && !result.parts?.length && !result.remove?.length;
    try {
      proposal = resolveProposal(result, [drawing.page], working);
    } catch (error) {
      const detail = error.profile ? '\n出错轮廓的有序顶点（mm）：' + JSON.stringify(error.profile) : '';
      const feedback = error.message + detail;
      if (!appearanceOnly && (continuous || !generatedFirst)) {
        signal = beginReview();
        await retryReview(error.message, failures++, signal);
      } else if (attempt >= lastAttempt || priorFeedback === feedback) throw error;
      priorFeedback = feedback;
      request = intent + '\n上次提交未能应用。建模描述校验反馈：' + feedback
        + (working ? '\n以当前描述为基线，重新提交本次调整需要的全部改动。' : '\n核对出错位置，返回修正后的完整模型。');
      continue;
    }
    if (!proposal) {
      if (reviewController && result.status === 'information') {
        await retryReview(t('这轮未返回可应用的几何修改'), failures++, signal);
        continue;
      }
      addChat('assistant', result.reply);
      tell(result.status === 'question' ? t('请在对话中补充图纸信息。') : t('AI 已回复。'));
      return;
    }
    proposal.bounds = appearanceOnly ? { ...working.bounds } : { ...proposal.bounds, ...sourceTargets, ...custom };
    showStage(reviewController ? 'review' : 'build', t('正在校验并生成 3D 模型…'));
    let output;
    try {
      output = await generateModel(proposal, signal);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (error.name === 'CADRuntimeError') throw error;
      draft = { ...proposal, custom, sourcePages: drawing.sourcePages };
      buildFailure = error?.message ?? String(error);
      const repeatedFailure = priorFeedback === buildFailure && JSON.stringify(working?.parts) === JSON.stringify(proposal.parts);
      if (!appearanceOnly && (continuous || !generatedFirst)) {
        signal = beginReview();
        await retryReview(buildFailure, failures++, signal);
      } else if (attempt >= lastAttempt || repeatedFailure) {
        throw new Error(buildFailure + (current ? ' ' + t('已保留上一份可用预览。') : ''));
      }
      priorFeedback = buildFailure;
      working = proposal;
      request = intent + '\nCAD 几何生成失败：' + buildFailure
        + (repeatedFailure ? '\n上一轮仍未修好，请调整做法。' : '')
        + '\n核对失败零件的图纸轮廓。切削失败时，按实际外壁位置检查刀具方向和穿入深度，保留图纸要求的开口。';
      continue;
    }
    generatedFirst = true;
    const checkBody = !prior || restoreDrawing;
    const { mismatches, alignmentWarnings, featureWarnings } = checkGeneratedModel(drawing, proposal, output, custom, checkBody);
    const feedback = mismatches.map(({ axis, measured, planned, extremes }) => {
      const index = axes.indexOf(axis);
      return axis.toUpperCase() + ' 目标 ' + planned + '，实测 ' + formatDimension(measured)
        + '，跨度端点零件 ' + extremes.from + ' / ' + extremes.to
        + '，实测端点 ' + formatDimension(output.min[index]) + ' 和 ' + formatDimension(output.max[index]);
    }).join('；');
    const guidance = (alignmentWarnings.length ? '\n装配对位未通过：' + alignmentWarnings.join(' ')
      + '\n请按图纸基准重算这些零件的接合位置。保留已确认的引脚节距、阵列数量及配合间隙。' : '')
      + (feedback ? '\nCAD 实测与建模目标不符（mm）：' + feedback : '')
      + (featureWarnings.length ? '\n机械特征待核对：' + featureWarnings.join(' ') : '');
    const useVisualReview = continuous && !appearanceOnly;
    if (!useVisualReview && !reviewController && !appearanceOnly && guidance && guidance !== priorFeedback && attempt < lastAttempt) {
      if (!alignmentWarnings.length && !prior) applyProposal(proposal, output, custom, false);
      priorFeedback = guidance;
      working = proposal;
      if (alignmentWarnings.length) {
        alignmentOutput = output;
        comparison = undefined;
      }
      request = intent + guidance
        + '\n保持有图纸标注或用户指定的尺寸，修正相应零件的坐标、形状和阵列。';
      continue;
    }
    if (!useVisualReview && !reviewController && alignmentWarnings.length && current?.page === proposal.page && samePages(current.sourcePages, drawing.sourcePages)
      && !measuredGeometry?.alignmentWarnings?.length) {
      draft = { ...proposal, custom, sourcePages: drawing.sourcePages };
      buildFailure = alignmentWarnings.join(' ');
      const message = t('几何修正后仍有零件未对位，预览和导出保留上一版。');
      addChat('assistant', message + ' ' + buildFailure);
      tell(message);
      return;
    }
    let reviewNote = '';
    if (useVisualReview) {
      const refined = await refineWithModelViews(proposal, output, drawing, custom, instruction, checkBody);
      proposal = refined.proposal;
      output = refined.output;
      reviewNote = refined.note;
    }
    applyProposal(proposal, output, custom);
    addChat('assistant', guidance && !appearanceOnly && !useVisualReview
      ? t('仍有尺寸或机械特征待核对，当前预览保留为草稿。') : result.reply + reviewNote);
    return true;
  }
}

for (const field of Object.values(settingsFields)) field.addEventListener('input', saveVisionSettings);
maxOutputTokens.addEventListener('blur', renderOutputLimit);
visualReview.addEventListener('change', saveVisionSettings);
stopVisualReview.addEventListener('click', () => {
  stopVisualReview.disabled = true;
  reviewController?.abort();
  tell(t('正在停止校正…'));
});
chatInput.addEventListener('input', refreshControls);
fitPreview.addEventListener('click', () => preview?.fit());
previewView.addEventListener('change', () => {
  const directions = { iso: [-0.84, -0.66, 0.89], front: [0, -1, 0], side: [-1, 0, 0], top: [0, -0.00001, 1] };
  preview?.setView(directions[previewView.value]);
});
showDimensions.addEventListener('change', renderPreviewDimensions);
drawingPrevious.addEventListener('click', () => turnDrawingPage(-1));
drawingNext.addEventListener('click', () => turnDrawingPage(1));
drawingFrame.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  turnDrawingPage(event.key === 'ArrowLeft' ? -1 : 1);
});
drawingFrame.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' && event.isPrimary && !event.target.closest('button')) {
    drawingSwipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }
});
drawingFrame.addEventListener('pointerup', event => {
  if (drawingSwipeStart?.pointerId !== event.pointerId) return;
  const dx = event.clientX - drawingSwipeStart.x;
  const dy = event.clientY - drawingSwipeStart.y;
  drawingSwipeStart = undefined;
  if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) turnDrawingPage(dx < 0 ? 1 : -1);
});
drawingFrame.addEventListener('pointercancel', () => { drawingSwipeStart = undefined; });
dimensionsToggle.addEventListener('click', () => {
  dimensionsExpanded = !dimensionsExpanded;
  fitDimensionCards();
});
const drawingResizeObserver = new ResizeObserver(fitDimensionCards);
drawingResizeObserver.observe(drawingFrame);
rereadButton.addEventListener('click', () => void run(t('正在复核机械图…'), rereadDrawing));

pdfInput.addEventListener('change', () => {
  const [file] = pdfInput.files;
  pdfInput.value = '';
  if (!file) return;
  void run(t('正在打开 PDF…'), async () => {
    const previous = pdfDocument;
    pdfDocument = undefined;
    clearSource();
    source.hidden = false;
    source.textContent = t('正在读取 ${1}', file.name);
    try {
      await previous?.close();
      pdfDocument = await openPdf(file, await loadWorker('/assets/pdf.worker.min.mjs', 'module'));
      source.textContent = pdfDocument.name + ' · ' + t('${1} 页', pdfDocument.pdf.numPages);
      tell(t('PDF 已打开。配置模型服务后可开始识别。'));
    } catch (error) {
      source.textContent = t('PDF 未能打开，请重新选择。');
      throw error;
    }
  });
});

analyze.addEventListener('click', () => void run(t('正在查找机械尺寸图…'), () => ask(
  '根据目标器件的机械图生成 3D 模型。',
  true,
)));

chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const instruction = chatInput.value.trim();
  if (!chatSend.disabled && instruction) {
    const priorMessages = history.slice();
    addChat('user', instruction);
    chatInput.value = '';
    void run(t('正在处理调整要求…'), async () => {
      try {
        if (inspection && /^(?:重新读图|read drawing again|reread drawing)[。.]?$/i.test(instruction)) {
          return await rereadDrawing();
        } else {
          return await ask(instruction, false, priorMessages);
        }
      } catch (error) {
        chatInput.value = instruction;
        throw error;
      }
    });
  }
});

save.addEventListener('click', () => {
  if (busy || !exported) return;
  const link = document.createElement('a');
  const url = URL.createObjectURL(exported);
  link.href = url;
  link.download = exported.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  tell(t('已发起 STEP 下载。'));
});

importButton.addEventListener('click', () => void run(t('正在导入个人 3D 库…'), async () => {
  const model = await libraryModel(exported);
  tell(t('已导入个人库 · ${1}', model.name));
}));

pcbRefresh.addEventListener('click', () => void refreshPcbTargets());
pcbSelect.addEventListener('change', renderPcbTarget);
pcbBind.addEventListener('click', () => {
  if (pcbBind.disabled) return;
  const target = chosenPcbTarget();
  const { document } = pcbTargets;
  void run(t('正在绑定 PCB 器件…'), async () => {
    const transform = pcbModelTransform(measuredGeometry);
    await readBindingTarget(host, document, target);
    const model = await libraryModel(exported);
    target.model = await bindPcbModel(host, document, target, model, transform);
    renderPcbTarget();
    tell(t('已将 3D 模型绑定到 ${1}。', target.designator));
  });
});

window.addEventListener('pagehide', () => {
  clearTimeout(outputLookupTimer);
  drawingResizeObserver.disconnect();
  void settingsStore.flush();
  lifetime.abort();
  customKey.value = '';
  void pdfDocument?.close().catch(() => undefined);
  worker?.terminate();
  preview?.dispose();
});

refreshControls();
void localizePanel(host).then(() => {
  if (lifetime.signal.aborted) return;
  renderDimensions();
  void restoreVisionSettings();
  void initPcbBinding();
});
