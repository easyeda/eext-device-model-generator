import { t } from './i18n.js';
const configKey = 'vision-settings-v1';
const browserKey = 'datasheet-3d-model:' + configKey;

export function restoreOpenAiSettings(saved) {
  const text = value => typeof value === 'string' ? value : '';
  const custom = { apiBase: text(saved.apiBase), customModel: text(saved.customModel), customKey: text(saved.customKey) };
  if (custom.apiBase.trim()) return custom;
  const previousProvider = text(saved.provider);
  if (previousProvider === 'openrouter' || previousProvider.includes('/')) {
    return {
      apiBase: 'https://openrouter.ai/api/v1',
      customModel: previousProvider === 'openrouter' ? text(saved.openRouterModel) : previousProvider,
      customKey: text(saved.apiKey),
    };
  }
  return custom;
}

export function createVisionSettingsStore(eda, report) {
  const storage = eda?.sys_Storage;
  const useEditor = typeof storage?.getExtensionUserConfig === 'function'
    && typeof storage?.setExtensionUserConfig === 'function';
  let pending;
  let saved;
  let saving = false;

  async function flush() {
    if (saving) return;
    saving = true;
    try {
      while (pending !== undefined) {
        const next = pending;
        pending = undefined;
        if (next === saved) continue;
        try {
          if (useEditor) {
            if (!await storage.setExtensionUserConfig(configKey, next)) throw new Error();
          } else {
            globalThis.localStorage.setItem(browserKey, next);
          }
          saved = next;
          report('');
        } catch {
          if (pending === undefined) {
            pending = next;
            report(t('配置未能保存，下次打开可能需要重新填写。'));
            break;
          }
        }
      }
    } finally {
      saving = false;
    }
  }

  return {
    async load() {
      try {
        saved = useEditor ? await storage.getExtensionUserConfig(configKey) : globalThis.localStorage.getItem(browserKey);
        return JSON.parse(saved ?? '{}') ?? {};
      } catch {
        report(t('已保存的配置未能读取。'));
        return {};
      }
    },
    save(settings) {
      pending = JSON.stringify(settings);
      void flush();
    },
    flush,
  };
}
