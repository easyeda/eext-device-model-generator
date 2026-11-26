import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import runtimeUrls from './cad-runtime-urls.json' with { type: 'json' };

const cacheDirectory = new URL('../build/cad-runtime-cache/', import.meta.url);
const simpleIndexPrefix = 'https://pypi.org/simple/';
const simpleIndexFormat = 'application/vnd.pypi.simple.v1+json';
const bundledUrls = new Set(runtimeUrls);
const licenseUrls = {
  'third-party/pyodide-LICENSE': 'https://raw.githubusercontent.com/pyodide/pyodide/0.29.5/LICENSE',
  'third-party/cpython-LICENSE': 'https://raw.githubusercontent.com/python/cpython/v3.13.12/LICENSE',
  'third-party/ocp-wasm-LICENSE': 'https://raw.githubusercontent.com/yeicor/OCP.wasm/6be21f668a33c86fd58675d8e551dff8817b0e58/LICENSE',
};

const runtimeAssets = [
  ...runtimeUrls.map((url, index) => [`assets/cad-runtime/${index}`, url]),
  ...Object.entries(licenseUrls),
];

async function cachedFile(url) {
  const cacheKey = createHash('sha256').update(url).digest('hex');
  const file = new URL(cacheKey, cacheDirectory);
  const cached = await stat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (cached?.size) return file;

  const isIndex = url.startsWith(simpleIndexPrefix);
  const temporary = new URL(`${cacheKey}.${randomUUID()}.tmp`, cacheDirectory);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: isIndex ? { Accept: simpleIndexFormat } : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      if (isIndex && !response.headers.get('content-type')?.includes(simpleIndexFormat)) {
        await response.body.cancel();
        throw new Error('PyPI did not return a JSON index');
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if (!(await stat(temporary)).size) throw new Error('Empty download');
      await rename(temporary, file);
      return file;
    } catch (error) {
      if (attempt === 3) throw new Error(`Could not download CAD runtime asset ${url}: ${error.message}`, { cause: error });
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function buildCadRuntime(outputDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  const downloads = runtimeAssets.values();

  async function installAssets() {
    for (const [path, url] of downloads) {
      const file = await cachedFile(url);
      const output = new URL(path, outputDirectory);
      if (url.startsWith(simpleIndexPrefix)) {
        const index = JSON.parse(await readFile(file, 'utf8'));
        index.files = index.files.filter(item => bundledUrls.has(new URL(item.url, url).href));
        if (!index.files.length) throw new Error(`No bundled wheel in ${url}`);
        await writeFile(output, JSON.stringify(index));
      } else {
        await copyFile(file, output);
      }
    }
  }

  await Promise.all(Array.from({ length: 6 }, installAssets));
}
