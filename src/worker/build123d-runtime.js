import runtimeUrls from '../../config/cad-runtime-urls.json';

const runtimeRoot = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';
const bootstrapUrl = 'https://raw.githubusercontent.com/yeicor/OCP.wasm/6be21f668a33c86fd58675d8e551dff8817b0e58/build123d/bootstrap.py';
const runtimePaths = new Map(runtimeUrls.map((url, index) => [url, `/assets/cad-runtime/${index}`]));

function contentType(url) {
  if (url.endsWith('.wasm')) return 'application/wasm';
  if (url.startsWith('https://pypi.org/simple/')) return 'application/vnd.pypi.simple.v1+json';
  if (url.endsWith('/json') || url.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

export async function loadBuild123d(progress, readAsset) {
  progress('正在从扩展包加载 Pyodide…');
  const originalFetch = globalThis.fetch;
  const originalImport = globalThis.importScripts;
  const readRuntime = url => {
    const path = runtimePaths.get(url);
    if (!path) throw new Error('Local CAD runtime asset missing: ' + url);
    return readAsset(path);
  };
  const scripts = new Map();
  try {
    for (const name of ['pyodide.js', 'pyodide.asm.js']) {
      const url = runtimeRoot + name;
      const file = await readRuntime(url);
      scripts.set(url, URL.createObjectURL(new Blob([file], { type: 'text/javascript' })));
    }
    globalThis.importScripts = (...urls) => originalImport.apply(globalThis, urls.map(url => {
      const local = scripts.get(String(url));
      if (!local) throw new Error('Local CAD runtime script missing: ' + url);
      return local;
    }));
    globalThis.fetch = async input => {
      const url = typeof input === 'string' ? input : input.url ?? input.href;
      const file = await readRuntime(url);
      const response = new Response(file, { headers: { 'Content-Type': contentType(url) } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    importScripts(runtimeRoot + 'pyodide.js');
    const python = await globalThis.loadPyodide({ indexURL: runtimeRoot });
    progress('正在从扩展包加载 build123d 和 Open CASCADE…');
    await python.loadPackage('micropip');
    const bootstrap = await readRuntime(bootstrapUrl);
    await python.runPythonAsync(await bootstrap.text() + '\nawait bootstrap(build123d_ref="0.11.0")');
    return python;
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.importScripts = originalImport;
    for (const url of scripts.values()) URL.revokeObjectURL(url);
  }
}
