import { t } from './i18n.js';
import { composeLabeledImages } from './image-sheet.js';
import { normalizeDrawingViews, viewDirections, viewUpAxes } from './drawing-views.js';

import { object, planResponseSchema } from '../model/model-plan.js';

const openRouterEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
const openRouterModelLimits = new Map();
const outputTokenParameters = new Map();
const kimiPro = 'moonshotai/kimi-k3.1-pro';
const routerSchemaModels = new Set([kimiPro, 'moonshotai/kimi-k3', 'qwen/qwen4-max', 'deepseek/deepseek-v4.1-flash-1017']);
const statuses = ['ready', 'question', 'information'];

export function readCustomKey(value) {
  const key = value.trim().replace(/^Bearer\s+/i, '');
  return /^[\x21-\x7e]*$/.test(key) ? key : null;
}

export function customConnection(base, modelId, secret, outputLimit = '') {
  let url;
  try { url = new URL(base.trim()); } catch { /* Report the invalid address below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(t('请输入 HTTP 或 HTTPS API 地址。密钥请填在单独的输入框。'));
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
  const model = modelId.trim();
  if (!model) throw new Error(t('请输入服务商提供的视觉模型 ID。'));
  const key = readCustomKey(secret);
  if (key === null) throw new Error(t('API 密钥包含无法发送的字符，请粘贴原始密钥。'));
  const limitText = outputLimit.trim();
  const maxOutputTokens = limitText ? Number(limitText) : undefined;
  if (limitText && (!/^\d+$/.test(limitText) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw new Error(t('最大输出 tokens 请填写正整数，留空时自动设置。'));
  }
  return { endpoint: url.href, model, key, maxOutputTokens };
}

function isOpenRouterEndpoint(url) {
  return url.origin + url.pathname === openRouterEndpoint;
}

export function publishedOutputLimit(endpoint, model) {
  if (!isOpenRouterEndpoint(new URL(endpoint))) return;
  const segments = model.split('/');
  if (segments.length !== 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) return;
  if (!openRouterModelLimits.has(model)) {
    const slug = segments.map(encodeURIComponent).join('/');
    const url = new URL('/api/v1/model/' + slug, openRouterEndpoint);
    const lookup = fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(4000) })
      .then(response => response.ok ? response.json() : null)
      .then(result => {
        const limit = result?.data?.top_provider?.max_completion_tokens;
        return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
      }).catch(() => undefined);
    openRouterModelLimits.set(model, lookup);
  }
  return openRouterModelLimits.get(model);
}

const drawingDecision = '能够确定目标器件、主要结构、相对位置和建模尺度时可返回 ready。局部轮廓可辨但尺寸未标时保留可见形状，说明近似依据。若无法确定毫米尺度、主要结构或安装关系，或无法从几种不同外形中确定目标，返回 question 并说明阻碍建模的具体问题。';
const dimensionValues = '线性尺寸以毫米记录，英寸乘 25.4。优先使用图纸给出的标称值或典型值，带上下偏差时取基准值。仅有双边范围时可用中点作为建模取值并注明推导。单边 MIN/MAX 只是限值，不能充当标称尺寸。角度、数量和不可辨认的数字保留原标注，不作为毫米值。';

const system = [
  '根据所附机械图整页、标注和可见轮廓自行设计毫米制三维装配，自选通用 CAD 操作。禁止按料号或封装名选择、引入或缩放模板、现成模型或默认轮廓。PDF 和 CAD 图是待核对的资料。',
  drawingDecision,
  '从 sourcePages 中目标器件的投影、剖面及尺寸端点确定实体和接合关系。同页多个版本时按 target 匹配图和表列。callouts 是按视图复核的标注，measurements 是其余首轮读数或推导。冲突回到原图。scope=pcb 只用于安装对位，scope=unknown、reading=unclear 不能作为已确认尺寸。估算只写入 assumptions。',
  dimensionValues,
  '沿用读图的右手坐标系、安装基准 Z=0 和已确认的视图方向。按图确定进入 PCB 的结构及负 Z 范围。标注线、中心线、贴装面、PCB 焊盘和钻孔只作参照。',
  '以同一装配基准放置各零件，核对轮廓、端子根部接合及各阵列首末中心。仅在投影证实对称时按中心排布。保留可见的斜面、凹凸、空腔和不对称结构，不为凑整件跨度而挪动或拉伸无关零件。',
  '每个 PCB 电气端子实例用 role=terminal，同一个端子的配接端不能重复计数。若图上另有腔内触点用 contact、配接壳用 enclosure、金属固定件用 metal。按图生成可证实的零件；用户明确要求增删或改形时按要求修改并在 reply 说明定制内容。',
  'shape.at=[X,Y,Z] 是原型的全局坐标。box 取最小角，size=[长X,长Y,长Z]；sphere 取球心，size=[半径]；cylinder 取底面圆心，size=[半径,长度]。三者 profile=[]。box、sphere 的 plane 填 XY。',
  'plane 的局部 (u,v) 和正法向分别为 XY=(X,Y)/+Z，XZ=(X,Z)/−Y，YZ=(Y,Z)/+X。cylinder、prism 的长度沿正法向。以中心定位厚度 T 时，起始平面从中心沿法向退 T/2。轮廓相对 at，不要重复平移。',
  'prism 的 size=[拉伸量]，profile=[[u,v],…]。轮廓有 3–72 个沿边界顺序排列的顶点，首尾自动闭合，非相邻边不能交叉、接触或重叠。loft 的 size=[]、profile=[]，采用 2–12 层 sections=[{offset,profile}]，offset 相对 at 沿法向递增，各层从对应角点同向绕行且点数一致。其他形状 sections=[]。',
  'cuts 的刀具与所属原型共用全局坐标，必须与待去除材料有体积相交，并保留剩余实体。每个原型最多 14 个切削、两组 repeats。count 为包含原型的总数（2–100），step 是全局增量，单件用 []。相同阵列用原型和步进表示。内核支持最多 90 个原型、400 个展开实例，超出能力时说明所需简化，不能悄悄少做端子。',
  'bounds 是含端子的整件目标跨度，bodyBounds 仅是主体读数。优先满足用户明确指定的改动，其余沿用已确认目标。没有依据的轴填 null。按目标改变实际几何。measurements 只返回对本次建模有用的新增或修订线性取值和依据，不重抄已有尺寸卡片。',
  'status=ready 时 page 固定为输入的主图页码，其他页只在证据中引用。edit 时每个改动的原型都要给出完整定义并沿用 id，删除用 remove。bounds 给出改动后的三个轴值，包括沿用值。assumptions 写关键近似；编辑时留空沿用原说明。',
  '外观修改用 appearanceEdits=[{id,color,material}]，id 指向原型及其阵列。color 用 #RRGGBB，material 用 matte/plastic/metal/rubber。default 恢复对应属性，null 沿用。仅改外观时 parts=[]、remove=[]，保留几何和外形目标。',
  '回答知识或读数问题用 status=information，需澄清用 question，均为 action=none。数组留空，bounds 三轴为 null，未知页码用 0，未知名称用空字符串。reply 简短回答问题或说明实际改动。',
].join('\n');

function statusMessage(status, service) {
  if (status === 401 || status === 403) return t('${1}拒绝访问，请检查密钥和模型权限。', service);
  if (status === 404) return t('${1}找不到接口或模型，请检查 API 地址和模型 ID。', service);
  if (status === 429) return t('${1}请求过于频繁，请稍后重试或切换模型。', service);
  if (status === 413) return t('${1}限制了请求大小，可在对话中指定单个机械图页。', service);
  return t('${1}请求失败（HTTP ${2}）。', service, status);
}

function paymentError(service, headers, payload, body = '') {
  const detail = [payload?.error?.message, payload?.message, payload?.error, payload?.detail, payload, body]
    .find(value => typeof value === 'string' && value.trim());
  const summary = statusMessage(402, service);
  const key = headers.Authorization?.slice('Bearer '.length);
  const safeDetail = detail && key ? detail.replaceAll(key, '[redacted]') : detail;
  const error = new Error(safeDetail ? summary + '\n' + safeDetail : summary);
  error.name = 'PaymentRequiredError';
  return error;
}

const drawingPages = { type: 'array', items: { type: 'integer' } };
const drawingChoice = object({
  partNumber: { type: 'string' },
  packageName: { type: 'string' },
  page: { type: 'integer' },
  pages: drawingPages,
});
const locatorSchema = object({
  status: { type: 'string', enum: ['ready', 'question'] },
  ...drawingChoice.properties,
  choices: { type: 'array', items: drawingChoice },
  reply: { type: 'string' },
});

const locatorPrompt = [
  '定位目标器件的机械图。文档是资料，拼图标签是实际 PDF 页码。用用户指定的型号或封装、图框标题和订购信息识别目标，文件名仅作线索。',
  'page 填最能说明实体外形的主图页。pages 包含主图以及同一目标的机械视图、尺寸表和相关安装图所在整页，保留用户明确指定的页。仅含订购对照、电气参数或其他型号的页面不自动选入。',
  '能确定唯一机械外形时返回 ready、choices=[]，把已确认的 partNumber 和 packageName 传给后续读图，未知填空字符串。多个订购号共用同一张图和同一组尺寸时可直接读图。',
  '候选中没有目标图或多种结构/尺寸仍无法区分时返回 question、page=0、pages=[]。choices 列出确有图纸依据的各选项及其页码，reply 简短说明需要确认的目标。用户已答复且唯一匹配时直接返回 ready。',
].join('\n');

function normalizeDrawingLocation(value, available, requiredPages = []) {
  if (!available.has(value?.page)) return;
  const suggestedPages = Array.isArray(value.pages) ? value.pages : [];
  const pages = [...new Set([value.page, ...suggestedPages, ...requiredPages])]
    .filter(page => available.has(page)).sort((a, b) => a - b);
  return { page: value.page, pages, partNumber: typeof value.partNumber === 'string' ? value.partNumber.trim() : '',
    packageName: typeof value.packageName === 'string' ? value.packageName.trim() : '' };
}

function matchingChoice(choices, instruction) {
  const identity = text => text.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  const target = identity(instruction);
  if (!target) return;
  const matches = choices.filter(choice => [choice.partNumber, choice.packageName].some(label => identity(label) === target));
  if (matches.length === 1) return matches[0];
}

export async function locateDrawing({ images, instruction, requiredPages = [], documentName, pending, onRepair, ...connection }) {
  const available = new Set(images.map(image => image.page));
  const choice = !requiredPages.length && pending ? matchingChoice(pending.choices, instruction) : undefined;
  const direct = normalizeDrawingLocation(choice, available, requiredPages);
  if (direct) return direct;
  const content = [{ type: 'text', text: '用户要求：' + instruction
    + (requiredPages.length ? '\n用户指定的 PDF 页码：' + requiredPages.join('、') : '')
    + (documentName ? '\n资料文件名：' + JSON.stringify(documentName) : '')
    + (pending ? '\n本 PDF 上一次定位提出的确认问题与用户答复（用于匹配目标）：' + JSON.stringify(pending) : '')
    + '\n拼图候选 PDF 页码：' + images.map(image => image.page).join('、') }];
  content.push(await labeledImageMessage(images.map(({ page, url }) => ({ url, label: t('PDF 第 ${1} 页', page) }))));
  const messages = [{ role: 'system', content: locatorPrompt }, { role: 'user', content }];
  for (const repair of [false, true]) {
    const result = await requestJson({ ...connection, messages, name: 'drawing_location', schema: locatorSchema });
    if (result?.status === 'question' && typeof result.reply === 'string' && result.reply.trim()) {
      const choices = (Array.isArray(result.choices) ? result.choices : []).filter(item => available.has(item?.page)
        && typeof item.partNumber === 'string' && typeof item.packageName === 'string')
        .map(item => normalizeDrawingLocation(item, available));
      return { status: 'question', reply: result.reply, choices };
    }
    if (result?.status === 'ready') {
      const location = normalizeDrawingLocation(result, available, requiredPages);
      if (location) return location;
    }
    if (repair) break;
    onRepair?.();
    messages.push({ role: 'user', content: '上一次返回的主图页码不在候选页中。请核对目标器件，并从拼图标签中选择主图和相关图纸的实际 PDF 页码。' });
  }
  throw new Error(t('自动定位复核后仍未确定机械图。可以回复目标料号或封装，也可以指定 PDF 页码。'));
}

const calloutGroupSchema = object({
  page: { type: 'integer' },
  view: { type: 'string' },
  scope: { type: 'string', enum: ['part', 'pcb', 'unknown'] },
  annotations: { type: 'array', items: object({
    label: { type: 'string' },
    raw: { type: 'string' },
    reading: { type: 'string', enum: ['read', 'unclear'] },
    mm: { type: ['number', 'null'] },
    firstPassIndex: { type: ['integer', 'null'] },
  }) },
});
const calloutAuditSchema = object({
  calloutGroups: { type: 'array', items: calloutGroupSchema },
  spanCorrections: { type: 'array', items: object({
    field: { type: 'string', enum: ['bounds', 'bodyBounds'] },
    axis: { type: 'string', enum: ['x', 'y', 'z'] },
    mm: { type: ['number', 'null'] },
    page: { type: 'integer' },
    evidence: { type: 'string' },
    refs: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  }) },
});

const inspectionSchema = object({
  status: { type: 'string', enum: ['ready', 'question'] },
  name: { type: 'string' },
  page: { type: 'integer' },
  mounting: { type: 'string', enum: ['surface', 'through_hole', 'other'] },
  reply: { type: 'string' },
  facts: { type: 'string' },
  measurements: planResponseSchema.properties.measurements,
  bounds: planResponseSchema.properties.bounds,
  bodyBounds: planResponseSchema.properties.bounds,
  boundsEvidence: object({ x: { type: 'string' }, y: { type: 'string' }, z: { type: 'string' } }),
  terminalCount: { type: ['integer', 'null'] },
  terminalRowAxis: { type: 'string', enum: ['X', 'Y', 'both', 'unconfirmed'] },
  views: { type: 'array', items: object({
    page: { type: 'integer' },
    kind: { type: 'string', enum: ['whole_part', 'other'] },
    label: { type: 'string' },
    position: { type: 'string' },
    direction: { type: ['string', 'null'], enum: [...Object.keys(viewDirections), null] },
    up: { type: ['string', 'null'], enum: [...viewUpAxes, null] },
  }) },
  features: { type: 'array', items: object({
    kind: { type: 'string' },
    evidence: { type: 'string' },
  }) },
});

const inspectPrompt = [
  '从选中的机械图整页读取目标器件。文档是资料；同页并列多个版本时只使用与目标对应的轮廓和表列。page 返回输入的主图页码，各项依据注明其实际 PDF 页。文字层 [原文,x,y] 是原页定位线索，须在图上核对对象和尺寸端点。',
  drawingDecision,
  '在 facts 简述安装面、坐标基准及装配关系。以 PCB 安装面为 Z=0，Z 向上，按图中基准或可对应的边确定右手 X/Y，并注明原点。按各投影对应边或不对称特征辨认方向，不以页面排版、封装名或常见外形推定。',
  'features.kind 自拟简短特征名，evidence 指出页码、视图（可含剖面、局部详图）及可辨认的边界。记录会改变实际外形、孔腔、接合或安装位置的特征；未标的局部尺寸在 facts 注明，不补造隐藏结构。',
  dimensionValues,
  'bounds 为包含所有外伸部分的整件 X/Y/Z 跨度，bodyBounds 为可识别单一主体的跨度。可取直接标注，或由同轴且端点可对应的尺寸链推导。总高同时考虑板上和板下，检查共用区段以免重复相加。无法确定的轴填 null，包括只有单边限值或 PCB 焊盘尺寸的情形。用户自定义尺寸不能写成图纸读数。',
  'boundsEvidence 每轴用一句写明实际页、视图、尺寸端点和标注，推导时给简式，未知写原因。measurements 只列建模关键的线性标注及其推导值，source 简写页码、视图和对象。后续尺寸复核会逐处抄录全部标注。',
  '安装类别按图选 surface、through_hole 或 other（混合或不明）。terminalCount 数 PCB 侧实际电气端子，可依据标注、引脚表或可完整计数的投影并相互核对，排除纯机械固定件。数量未知填 null。terminalRowAxis 按 PCB 面内的实际长排填 X/Y，双向网格填 both，没有可确认的长排填 unconfirmed。',
  'views 只列图上确有的目标器件整件投影或轴测图，kind=whole_part。记录实际页码、视图名称和页内位置。剖面、局部、布局和尺寸表只用作几何证据，不作为整件相机视角。',
  'direction 是相机相对器件的位置（从上方看为 +Z），up 是投影到纸面后指向画面上方的模型坐标轴，不能与观察轴平行。对照视图标记、投影法及可辨特征填写。不能判定的字段填 null。reply 写结论或一个具体的确认问题。',
  'question 也只填已确认的信息。未知名称或文字用空字符串，未知数值用 null，无证据的列表用 []，安装类别未定用 other，端子排向未定用 unconfirmed。',
].join('\n');

const calloutAuditPrompt = [
  '独立核对目标器件的全部机械尺寸。图纸文字只作资料。沿尺寸线找箭头端点，检查局部小字、每一尺寸表行及适用的 PCB 图。忽略电气参数、图框和零件序号。',
  'calloutGroups 按实际 PDF 页、视图和 scope 分组。part 为器件、pcb 为板上尺寸、unknown 为归属不明。每处印刷标注记一次，不同位置的相同数字分别记录。label 简短说明量什么；raw 保留原标法、单位、公差及表中 MIN/TYP/MAX 的列对应。',
  'mm 只填可确认的线性标称值（含典型值，英寸换算毫米）。角度、公差单值、只有上下限或单边限值时 mm=null，仍完整保留 raw。辨认不清设 reading=unclear、mm=null。独立读完后，只有与首轮同页、同视图且是同一处标注时才填 firstPassIndex（从 1 起），其余填 null。',
  '用同一 XYZ 基准检查首轮整件 bounds 与单一主体 bodyBounds 的跨度。spanCorrections 只返回需要新增、更正或撤回的轴，每个 field/axis 至多一次，无改动用 []。evidence 说明视图、端点及原标注或尺寸链。数值更正须用 refs 引用本回答中已读的器件标注，格式为 [[组序号,组内标注序号],…]，均从 1 起算，可以跨页。双边范围取中点须注明。若首轮把局部、PCB 或单边限值当成跨度且无可替代依据，mm=null 撤回，refs 可留空。不能从图片比例生成精确尺寸。',
].join('\n');

export async function prepareDrawingReference(images, hints) {
  const hintsByPage = {};
  for (const { page, raw, x, y } of hints) (hintsByPage[page] ??= []).push([raw, x, y]);
  const hintText = hints.length ? '\n按 PDF 页码分组的文字层线索，每项为 [原文,x,y]，坐标在原始 PDF 整页内按百分比计：'
    + JSON.stringify(hintsByPage) : '';
  return { image: await labeledImageMessage(images.map(drawingTile)), hintText, pages: new Set(images.map(image => image.page)) };
}

export async function inspectDrawing({ reference, instruction, primaryPage, target, ...connection }) {
  const content = [{ type: 'text', text: '用户要求：' + instruction + '\n主图为 PDF 第 ' + primaryPage + ' 页'
    + (target ? '\n已定位的目标：' + target : '')
    + reference.hintText }, reference.image];
  const messages = [{ role: 'system', content: inspectPrompt }, { role: 'user', content }];
  const result = await requestJson({ ...connection, messages, name: 'drawing_inspection', schema: inspectionSchema,
    truncatedRetry: {
      messages: [{ role: 'system', content: inspectPrompt
        + '\n只读可启动建模的结构和关键尺寸。measurements 至多 14 条，优先主体外形、局部高度、端子间距、孔位和开口。' }, messages[1]],
    },
    onRetry: stage => connection.onRetry?.(stage, t('正在用同一拼图优先读取结构和关键尺寸…')),
  });
  if (!['ready', 'question'].includes(result?.status) || typeof result.reply !== 'string'
    || (result.status === 'ready' && result.page !== primaryPage)) {
    throw new Error(t('模型未返回可核对的机械图。请在对话中指定 PDF 页码。'));
  }
  return { ...result, views: normalizeDrawingViews(result.views, reference.pages) };
}

export async function auditDrawingCallouts({ reference, inspection, target, firstPass, ...connection }) {
  const { name, facts, views, bounds, bodyBounds, boundsEvidence } = inspection;
  const content = [{ type: 'text', text: '目标器件：' + [target, name].filter(Boolean).join(' · ')
    + '\n首轮坐标和跨度（待复核）：' + JSON.stringify({ facts, views, bounds, bodyBounds, boundsEvidence })
    + '\n首轮读数列表（从 1 起算）：'
    + JSON.stringify(firstPass) + reference.hintText }, reference.image];
  const messages = [{ role: 'system', content: calloutAuditPrompt }, { role: 'user', content }];
  const { calloutGroups, spanCorrections } = await requestJson({ ...connection, messages, name: 'drawing_callouts', schema: calloutAuditSchema }) ?? {};
  if (!Array.isArray(calloutGroups)) throw new Error(t('模型未返回可核对的尺寸标注。'));
  const callouts = [];
  const partReferences = new Set();
  for (const [groupIndex, group] of calloutGroups.entries()) {
    if (!reference.pages.has(group?.page) || typeof group.view !== 'string' || !group.view.trim()
      || !['part', 'pcb', 'unknown'].includes(group.scope) || !Array.isArray(group.annotations)) continue;
    for (const [itemIndex, item] of group.annotations.entries()) {
      if (typeof item?.label !== 'string' || !item.label.trim() || typeof item.raw !== 'string'
        || !['read', 'unclear'].includes(item.reading) || (item.reading === 'read' && !item.raw.trim())) continue;
      const index = item.firstPassIndex;
      if (group.scope === 'part' && item.reading === 'read') partReferences.add([groupIndex + 1, itemIndex + 1].join('/'));
      callouts.push({ ...item, page: group.page, view: group.view, scope: group.scope,
        mm: item.reading === 'read' && Number.isFinite(item.mm) ? item.mm : null,
        firstPassIndex: Number.isInteger(index) && index >= 1 && index <= firstPass.length ? index : null });
    }
  }
  if (calloutGroups.length && !callouts.length) throw new Error(t('模型未返回可核对的尺寸标注。'));
  const audited = { callouts, bounds: { ...bounds }, bodyBounds: { ...bodyBounds }, boundsEvidence: { ...boundsEvidence } };
  const corrections = (Array.isArray(spanCorrections) ? spanCorrections : []).filter(item => {
    if (!reference.pages.has(item?.page) || typeof item.evidence !== 'string' || !item.evidence.trim()) return false;
    if (item.mm === null) return true;
    return Number.isFinite(item.mm) && item.mm > 0 && Array.isArray(item.refs) && item.refs.length > 0
      && item.refs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isInteger)
        && partReferences.has(pair.join('/')));
  });
  for (const field of ['bounds', 'bodyBounds']) {
    for (const axis of ['x', 'y', 'z']) {
      const matching = corrections.filter(item => item.field === field && item.axis === axis);
      if (matching.length !== 1) continue;
      const { mm, page, evidence } = matching[0];
      audited[field][axis] = mm;
      const source = t('PDF 第 ${1} 页', page) + ' · ' + evidence.trim();
      if (field === 'bounds') audited.boundsEvidence[axis] = source;
      else (audited.bodyBoundsEvidence ??= {})[axis] = source;
    }
  }
  return audited;
}

function drawingTile({ page, url }) {
  return { url, label: t('PDF 第 ${1} 页', page) + ' · ' + t('机械图') };
}

async function labeledImageMessage(tiles) {
  return { type: 'image_url', image_url: { url: await composeLabeledImages(tiles) } };
}

export async function requestVision({ inspection, instruction, history = [], current, custom = {}, drawingImage, comparison, ...connection }) {
  const operation = current
    ? '本轮已有建模描述。生成或修复几何时只用 action=edit，保留未改动的原型。'
    : '本轮没有可编辑的基线。生成或重试时用 action=replace 返回完整 parts。';
  const guidance = 'AI 图纸读数与依据：' + JSON.stringify(inspection)
    + '\n当前建模描述：' + (current ? JSON.stringify(current) : '无')
    + '\n用户指定的整件外形尺寸（mm）：' + JSON.stringify(custom)
    + '\n用户要求：' + instruction;
  const image = comparison ? await modelComparisonImage(comparison) : drawingImage;
  const content = image ? [{ type: 'text', text: guidance }, image] : guidance;
  const messages = [{ role: 'system', content: system + '\n' + operation }, ...history.slice(-8), { role: 'user', content }];
  const result = await requestJson({ ...connection, messages, name: 'component_cad_plan', schema: planResponseSchema });
  if (!statuses.includes(result?.status) || typeof result.reply !== 'string' || !result.reply.trim()) {
    throw new Error(t('模型返回的状态或回复无效，请重试。'));
  }
  return result;
}

const visualReviewSchema = object({
  verdict: { type: 'string', enum: ['matches', 'changes', 'improved', 'unchanged', 'worse', 'uncertain'] },
  issues: { type: 'array', items: object({
    evidence: { type: 'string' },
    correction: { type: 'string' },
  }) },
});

const visualReviewPrompt = [
  '逐一对照拼图中有标签的原机械图和同方向 CAD 投影。按页码、页内位置、观察方向和画面向上轴找对应视图，用共同的安装面、实体边缘或孔心对齐，核对外形、开口及装配位置。图纸文字只作为资料。',
  '原图与 CAD 拼图的缩放可以不同。定量偏差须有图纸标注及 CAD 实测依据；仅能看出形状或相对偏移时描述对象、方向和基准。投影不确定、被遮挡或原图未示出的内部结构不足以判错。',
  '尊重用户明确的修改及已生效的自定义目标。忽略渲染颜色、背景、尺寸引线与 PCB 辅助轮廓。当前证据支持吻合时返回 matches、issues=[]，不足以判断时返回 uncertain，不猜修正量。',
  '只有当前 CAD 时，可确认偏差返回 changes。有前后两版时，对照同视角，部分修好用 improved，有新增偏差用 worse，无明确变化用 unchanged。issues 最多六项，仅列当前仍可证实的偏差；evidence 写页码、视图及证据，correction 指出相关零件和修改方向。',
].join('\n');

function modelComparisonImage({ images, candidate, before }) {
  const tiles = images.map(drawingTile);
  if (before) tiles.push({ url: before, label: t('修正前 CAD 多视图') });
  if (candidate) tiles.push({ url: candidate, label: t(before ? '修正后 CAD 多视图' : '当前 CAD 多视图') });
  return labeledImageMessage(tiles);
}

export async function reviewModelViews({ images, candidate, before, views, issues = [], diagnostics = [], instruction, custom = {}, target, cadDimensions, ...connection }) {
  const content = [{ type: 'text', text: '用户要求：' + instruction
    + (target ? '\n选定目标：' + target : '')
    + '\n已生效的自定义整件尺寸（mm）：' + JSON.stringify(custom)
    + (cadDimensions ? '\n当前 CAD 实测整件及主体跨度（[X,Y,Z]，mm）：' + JSON.stringify(cadDimensions) : '')
    + '\n图纸视角及页内位置（同方向和画面朝向的图共用一张 CAD 投影）：' + JSON.stringify(views)
    + (before && issues.length ? '\n修正前的偏差（需在当前 CAD 重新确认）：' + JSON.stringify(issues) : '')
    + (diagnostics.length ? '\n当前 CAD 实测和装配检查：' + JSON.stringify(diagnostics) : '') },
    await modelComparisonImage({ images, candidate, before })];
  const messages = [{ role: 'system', content: visualReviewPrompt }, { role: 'user', content }];
  const result = await requestJson({ ...connection, messages, name: 'model_visual_review', schema: visualReviewSchema });
  if (!visualReviewSchema.properties.verdict.enum.includes(result?.verdict) || !Array.isArray(result?.issues)) {
    throw new Error(t('模型未返回可核对的外观校正结果。'));
  }
  return { verdict: result.verdict, issues: result.issues.filter(item => typeof item?.evidence === 'string'
    && item.evidence.trim() && typeof item.correction === 'string' && item.correction.trim()).slice(0, 6) };
}

async function requestJson({ endpoint, key, model, messages, signal, onRetry, name, schema, maxOutputTokens, truncatedRetry, language }) {
  const url = new URL(endpoint);
  const useOpenRouter = isOpenRouterEndpoint(url);
  const maxTokens = maxOutputTokens ?? await publishedOutputLimit(endpoint, model);
  const tokenParameterKey = JSON.stringify([endpoint, model]);
  const defaultTokenParameter = useOpenRouter || url.origin === 'https://api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  const useJsonSchema = useOpenRouter && routerSchemaModels.has(model);
  const service = useOpenRouter ? 'OpenRouter' : t('自定义 API（${1}）', url.host);
  const stage = t({ drawing_location: '图纸定位', drawing_inspection: '读图', drawing_callouts: '尺寸复核',
    component_cad_plan: '建模', model_visual_review: '多视图校正' }[name]);
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) };
  const canRetry = useOpenRouter || Boolean(truncatedRetry);
  for (const retry of canRetry ? [false, true] : [false]) {
    signal?.throwIfAborted();
    const fallback = retry ? truncatedRetry : undefined;
    const originalMessages = fallback?.messages ?? messages;
    const responseLanguage = language === 'en'
      ? 'Write replies, dimension labels and evidence in English. Cite sources as “PDF page N”.'
      : '回复、尺寸名称和依据用简体中文，引用页码用“PDF 第 N 页”。';
    const requestMessages = [{ ...originalMessages[0], content: originalMessages[0].content + '\n' + responseLanguage
      + ' 保留原标注 raw、器件型号、JSON 字段名和枚举值。' }, ...originalMessages.slice(1)];
    const requestSchema = fallback?.schema ?? schema;
    const format = useJsonSchema ? {
      messages: requestMessages,
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: requestSchema } },
      provider: { require_parameters: true },
    } : {
      messages: [{ ...requestMessages[0], content: requestMessages[0].content
        + '\n只返回一个 JSON 对象，符合以下 JSON Schema。必须包含所有 required 字段。\n' + JSON.stringify(requestSchema) },
      ...requestMessages.slice(1)],
      stream: false,
    };
    const tokenParameter = outputTokenParameters.get(tokenParameterKey) ?? defaultTokenParameter;
    const body = { model, ...format, ...(maxTokens === undefined ? {} : { [tokenParameter]: maxTokens }) };
    if (useJsonSchema) body.reasoning = { enabled: false };
    const timeout = AbortSignal.timeout(useOpenRouter ? (retry ? 480000 : 240000) : 110000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let payload;
    try {
      payload = await fetchCompletion(endpoint, body, headers, requestSignal, service, maxTokens === undefined ? undefined : tokenParameter);
    } catch (error) {
      if (error.name !== 'UnsupportedTokenParameterError') throw error;
      delete body[tokenParameter];
      const alternative = tokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      body[alternative] = maxTokens;
      payload = await fetchCompletion(endpoint, body, headers, requestSignal, service);
      outputTokenParameters.set(tokenParameterKey, alternative);
    }
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    const output = Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : content;
    if (typeof output === 'string') {
      try {
        return JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''));
      } catch {
        // A length-limited response can contain only the first part of the JSON object.
      }
    }
    if (choice?.finish_reason !== 'length') throw new Error(t('模型未返回可解析的${1}结果，请重试。', stage));
    if (!retry && canRetry) {
      onRetry?.(stage);
      continue;
    }
    const limit = maxTokens === undefined ? '' : t('（请求输出上限 ${1} tokens）', maxTokens);
    throw new Error(t(retry ? '${1}重试后仍截断${2}结果${3}，没有收到完整 JSON。'
      : '${1}截断了${2}结果${3}，没有收到完整 JSON。', service, stage, limit));
  }
}

function rejectsTokenParameter(payload, parameter) {
  if (Array.isArray(payload?.detail) && payload.detail.some(item => item?.type === 'extra_forbidden'
    && item.loc?.at(-1) === parameter)) return true;
  const error = payload?.error ?? payload;
  const message = typeof error?.message === 'string' ? error.message : '';
  return (error?.param === parameter || new RegExp('\\b' + parameter + '\\b').test(message))
    && (error?.code === 'unsupported_parameter'
     || /unknown|unrecognized|unsupported|not supported|not allowed|unexpected|does not support/i.test(message));
}

async function fetchCompletion(url, body, headers, signal, service, tokenParameter) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', credentials: 'omit', cache: 'no-store', signal,
      headers, body: JSON.stringify(body),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(t('无法连接${1}。请检查地址、网络和服务端是否允许浏览器跨域请求。', service));
  }
  if (!response.ok) {
    if (response.status === 402) {
      const raw = await response.text().catch(() => '');
      signal.throwIfAborted();
      let payload;
      try { payload = JSON.parse(raw); } catch { /* Display a plain text response as received. */ }
      throw paymentError(service, headers, payload, raw);
    }
    if (tokenParameter && [400, 422].includes(response.status)) {
      const payload = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (rejectsTokenParameter(payload, tokenParameter)) {
        const error = new Error(statusMessage(response.status, service));
        error.name = 'UnsupportedTokenParameterError';
        throw error;
      }
    }
    throw new Error(statusMessage(response.status, service));
  }
  const payload = await response.json().catch(error => {
    if (signal.aborted) throw signal.reason;
    throw new Error(t('${1}未返回 Chat Completions JSON 响应。', service), { cause: error });
  });
  if (payload.error) {
    if (Number(payload.error.code) === 402) throw paymentError(service, headers, payload, JSON.stringify(payload));
    throw new Error(t('所选模型未能完成请求，请重试或切换模型。'));
  }
  return payload;
}
