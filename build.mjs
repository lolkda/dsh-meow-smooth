/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *
 * Everything is bundled (esbuild) so the plugin is self-contained:
 * Runtime dependencies are declared in package.json; react stays external on
 * the client side (shell singleton, ModuleLoader resolves it).
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const { name: packageName } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const watch = process.argv.includes('--watch');

// Resolve dependencies from this package's own locked installation.
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  // web-push 是 CJS（内部 require('crypto')）：bundle 进 ESM 会产出动态
  // require 崩溃（实测）。保持 external，运行时由 Node 的 ESM-CJS
  // interop 从插件 node_modules 加载（package.json dependencies 声明）。
  external: ['web-push'],
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
};

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  // run-send.tsx 含 JSX；显式给 .tsx 指定 JSX loader。
  loader: { '.tsx': 'tsx' },
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(packageName)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await (await context(hostOptions)).watch();
  await (await context(clientOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  await Promise.all([build(hostOptions), build(clientOptions)]);
}
