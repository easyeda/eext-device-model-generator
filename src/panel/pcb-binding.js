import { t } from './i18n.js';
// Current PCB documents use EDMT_EditorDocumentType.PCB = 3.
const pcbDocumentType = 3;
// 3D Model Transform dimensions and offsets are expressed in mil.
const millimetersPerMil = 0.0254;

async function currentPcb(eda) {
  const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (document?.documentType !== pcbDocumentType || !document.uuid || !document.tabId) {
    throw new Error(t('请切换到需要绑定模型的 PCB 文档。'));
  }
  return document;
}

async function checkDocument(eda, expected) {
  const actual = await currentPcb(eda);
  if (actual.tabId !== expected.tabId || actual.uuid !== expected.uuid) {
    throw new Error(t('PCB 文档已切换，请刷新器件列表后重新选择。'));
  }
}

export async function readPcbTargets(eda) {
  const document = await currentPcb(eda);
  const [components, selected] = await Promise.all([
    eda.pcb_PrimitiveComponent.getAll(), eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId(),
  ]);
  await checkDocument(eda, document);
  const targets = components.map(component => {
    const id = component.getState_PrimitiveId();
    const designator = component.getState_Designator()?.trim() || id;
    return { id, designator, name: component.getState_Name()?.trim() || '',
      footprint: component.getState_Footprint()?.uuid, model: component.getState_Model3D() };
  }).filter(target => target.id).sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
  const selectedTargets = targets.filter(target => selected.includes(target.id));
  return { document, targets, selectedId: selectedTargets.length === 1 ? selectedTargets[0].id : undefined };
}

export async function readBindingTarget(eda, document, target) {
  await checkDocument(eda, document);
  const component = await eda.pcb_PrimitiveComponent.get(target.id);
  if (!component || component.getState_Footprint()?.uuid !== target.footprint) {
    throw new Error(t('目标器件已删除或更换封装，请刷新 PCB 器件列表。'));
  }
  await checkDocument(eda, document);
  return component;
}

export async function createLibraryModel(eda, file) {
  const libraryUuid = await eda.lib_LibrariesList.getPersonalLibraryUuid();
  if (!libraryUuid) throw new Error(t('未获取到个人库，可先保存 STEP 并手动导入。'));
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = [...crypto.getRandomValues(new Uint8Array(3))].map(byte => alphabet[byte % alphabet.length]).join('');
  const name = file.name.replace(/\.(?:step|stp)$/i, '') + '-' + suffix;
  const upload = new File([file], name + '.step', { type: file.type });
  const created = await eda.lib_3DModel.create(libraryUuid, upload, [], 'mm');
  if (!created || Array.isArray(created) && !created.length) {
    throw new Error(t('嘉立创EDA没有返回 3D 模型编号（${1}）。可保存 STEP 后在 3D 模型管理器中检查导入结果。', upload.name));
  }
  if (!Array.isArray(created) || created.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(t('嘉立创EDA返回了无法识别的 3D 模型编号（${1}）。', upload.name));
  }
  const ids = [...new Set(created)];
  if (ids.length !== 1) {
    throw new Error(t('嘉立创EDA从 ${1} 导入了 ${2} 个模型，请在 3D 模型管理器中选择要绑定的模型。', upload.name, ids.length));
  }
  const [uuid, qualifier] = ids[0].split('|');
  if (!uuid || (qualifier && qualifier !== libraryUuid)) throw new Error(t('无法确认新模型所属的个人库。'));
  return { uuid, libraryUuid, name };
}

export function pcbModelTransform({ min, max }) {
  const size = max.map((value, axis) => value - min[axis]);
  const offset = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  if (size.some(value => !Number.isFinite(value) || value <= 0) || !offset.every(Number.isFinite)) {
    throw new Error(t('模型外形尺寸无效，无法绑定。'));
  }
  const mil = value => Number((value / millimetersPerMil).toFixed(6));
  // The editor centers the model in XY and moves its minimum Z to zero.
  // Restore its original CAD origin, including through-hole leads below Z=0.
  return [...size.map(mil), 0, 0, 0, ...offset.map(mil)].join(',');
}

export async function bindPcbModel(eda, document, target, model, transform) {
  const component = await readBindingTarget(eda, document, target);
  const otherProperty = {
    ...component.getState_OtherProperty(),
    '3D Model': model.uuid + '|' + model.libraryUuid,
    '3D Model Title': model.name,
    '3D Model Transform': transform,
  };
  const modified = await eda.pcb_PrimitiveComponent.modify(target.id, { otherProperty });
  await checkDocument(eda, document);
  const verified = (await eda.pcb_PrimitiveComponent.get(target.id))?.getState_Model3D();
  if (!modified || verified?.uuid?.split('|')[0] !== model.uuid || verified.libraryUuid !== model.libraryUuid) {
    throw new Error(t('模型已入库，但 PCB 模型关联回读失败。可在 PCB 的 3D 模型管理器中确认。'));
  }
  return verified;
}
