import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildCacheMatches, buildFingerprint, listBuildInputs, saveBuildCache, writeFileIfChanged } from './devBuildCache'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, 'src-tauri/broadcast-dist')
const cachePath = resolve(root, 'node_modules/.cache/block-pet-dev/broadcast.json')
const outputsToCheck = [resolve(output, 'broadcast.js'), resolve(output, 'index.html')]
const require = createRequire(import.meta.url)
const cached = argv.includes('--cached')
async function inputs() {
  return [
    ...await listBuildInputs(resolve(root, 'src')),
    require.resolve('vite/package.json'),
    ...['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/buildBroadcast.ts', 'scripts/devBuildCache.ts']
      .map(path => resolve(root, path)),
  ]
}
const fingerprint = cached ? await buildFingerprint(await inputs()) : undefined
if (!fingerprint || !await buildCacheMatches(cachePath, fingerprint, outputsToCheck)) {
  const { build } = await import('vite')
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
  await writeFileIfChanged(resolve(output, 'broadcast.js'), script.code)
  await writeFileIfChanged(resolve(output, 'index.html'), await readFile(resolve(root, 'src/broadcast/index.html')))
  if (fingerprint && fingerprint === await buildFingerprint(await inputs())) {
    const dependencies = [...new Set(Object.keys(script.modules)
      .filter(path => isAbsolute(path) && !path.includes('\0') && path.replaceAll('\\', '/').includes('/node_modules/'))
      .map(path => path.split('?')[0]))]
    await saveBuildCache(cachePath, fingerprint, outputsToCheck, dependencies)
  }
}
