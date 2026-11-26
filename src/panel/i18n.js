import en from '../../locales/en.json' with { type: 'json' };
import zh from '../../locales/zh-Hans.json' with { type: 'json' };

export let language = 'zh-Hans';

export function t(key, ...args) {
  const translations = language === 'en' ? en : zh;
  return (Object.hasOwn(translations, key) ? translations[key] : key)
    .replace(/\$\{(\d+)\}/g, (placeholder, index) => args[Number(index) - 1] ?? placeholder);
}

export async function localizePanel(host) {
  try {
    const current = await host?.sys_I18n?.getCurrentLanguage?.();
    if (current && !/^zh(?:-|$)/i.test(current)) language = 'en';
  } catch {
    // The embedded panel can also run without the host API.
  }
  document.documentElement.lang = language;
  document.title = t(document.title);
  const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue.trim();
    if (text) node.nodeValue = node.nodeValue.replace(text, () => t(text));
  }
  for (const element of document.querySelectorAll('main [aria-label], main [placeholder], main [title]')) {
    for (const attribute of ['aria-label', 'placeholder', 'title']) {
      const text = element.getAttribute(attribute);
      if (text) element.setAttribute(attribute, t(text));
    }
  }
}
