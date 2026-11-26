import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCadRuntime } from './cad-runtime-assets.mjs';

const projectRoot = new URL('../', import.meta.url);
const projectFile = path => new URL(path, projectRoot);
const browserBuild = {
  absWorkingDir: fileURLToPath(projectRoot),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome124',
  tsconfigRaw: { compilerOptions: { alwaysStrict: false } },
  write: false,
};

const [panel, worker, html] = await Promise.all([
  build({
    ...browserBuild,
    entryPoints: ['src/panel/index.js'],
    define: { 'import.meta.url': 'globalThis.location.href' },
    minify: true,
  }),
  build({
    ...browserBuild,
    entryPoints: ['src/worker/index.js'],
    loader: { '.py': 'text' },
    minify: true,
  }),
  readFile(projectFile('iframe/index.html'), 'utf8'),
]);

const placeholder = '/* PANEL_CODE */';
if (!html.includes(placeholder)) throw new Error('iframe/index.html 缺少面板脚本占位符。');
const panelScript = panel.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

await Promise.all(['dist/iframe/', 'dist/assets/cad-runtime/', 'dist/third-party/'].map(
  path => mkdir(projectFile(path), { recursive: true }),
));
await Promise.all([
  writeFile(projectFile('dist/iframe/index.html'), html.replace(placeholder, () => panelScript)),
  writeFile(projectFile('dist/assets/model-worker.js'), worker.outputFiles[0].contents),
  copyFile(projectFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), projectFile('dist/assets/pdf.worker.min.mjs')),
  copyFile(projectFile('node_modules/three/LICENSE'), projectFile('dist/third-party/three-LICENSE')),
  copyFile(projectFile('node_modules/pdfjs-dist/LICENSE'), projectFile('dist/third-party/pdfjs-LICENSE')),
  buildCadRuntime(projectFile('dist/')),
]);
