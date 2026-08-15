// Build the browser half into the client-module envelope dsh serves at
// /plugins/<id>/client.js.
//
// esbuild rather than plain tsc because this half is several modules and shares
// the wire types with the host half: the envelope's `require` shim resolves only
// EXTERNAL packages the host provides, so anything of ours must be inlined.
// dsh's own client packages ship bundled for the same reason. Types are checked
// separately by `tsc --emitDeclarationOnly`.
//
// `id` MUST equal the package name — the graph row id comes from the mounted
// plugin row's name, and the module table matches on it (docs/spike-findings.md §1).
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const { name: id } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outputPath = join(root, 'lib', 'client.js')

// React and every dsh client package come from the host's module table.
const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  write: false,
  logLevel: 'warning',
})

const [output] = result.outputFiles
if (output === undefined) throw new Error('build-client: esbuild produced no output')

const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  output.text,
  'return module.exports; } });',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped)
