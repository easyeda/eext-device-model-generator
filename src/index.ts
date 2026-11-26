export async function openPanel() {
  try {
    const opened = await eda.sys_IFrame.openIFrame(
      '/iframe/index.html', 840, 610, 'datasheet-3d-model',
      { title: eda.sys_I18n?.text('数据手册 3D 模型') ?? '数据手册 3D 模型',
        maximizeButton: true, minimizeButton: true, grayscaleMask: false },
    );
    if (!opened) throw new Error(eda.sys_I18n?.text('面板未打开') ?? '面板未打开');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await eda.sys_Dialog.showInformationMessage(
      eda.sys_I18n?.text('打开建模面板失败：${1}', undefined, undefined, reason) ?? '打开建模面板失败：' + reason,
    );
  }
}
