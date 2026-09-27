import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'src-tauri/broadcast-dist')
// One standalone script: no Tauri runtime, public directory, or external CDN.
const bundle = await build({
  configFile: false,
  root,
  envDir: false,
  envPrefix: [],
  publicDir: false,
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    write: false,
    lib: { entry: resolve(root, 'src/broadcast/main.ts'), name: 'PetBroadcast', formats: ['iife'] },
    rollupOptions: { output: { inlineDynamicImports: true } },
    sourcemap: false,
  },
})
const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => 'output' in result ? result.output : [])
const script = outputs.find(item => item.type === 'chunk')
if (!script || script.type !== 'chunk' || outputs.length !== 1) throw new Error('Broadcast must build as one standalone script.')
if (Object.keys(script.modules).some(path => /@tauri|tauri-store|\/stores\/|\/node_modules\/.*(?:vue|pinia)/.test(path.replaceAll('\\', '/')))) {
  throw new Error('Broadcast imported an application-only dependency.')
}
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'broadcast.js'), script.code, 'utf8')
await writeFile(resolve(output, 'index.html'), await readFile(resolve(root, 'src/broadcast/index.html')))
