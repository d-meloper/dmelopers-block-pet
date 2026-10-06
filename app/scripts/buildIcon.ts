import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { argv, execPath } from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildCacheMatches, buildFingerprint, listBuildInputs, saveBuildCache, writeFileIfChanged } from './devBuildCache'

const require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(project, 'src-tauri')
const cachePath = resolve(project, 'node_modules/.cache/block-pet-dev/icons.json')
const names = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico']
const outputs = [...names.map(name => join(root, 'icons', name)), join(root, 'assets/tray.png')]
const cached = argv.includes('--cached')

async function inputs() {
  const cliPackage = require.resolve('@tauri-apps/cli/package.json')
  const cliRequire = createRequire(cliPackage)
  return [
    ...await listBuildInputs(dirname(cliPackage)),
    cliRequire.resolve('@tauri-apps/cli-win32-x64-msvc'),
    ...['public/logo.png', 'package.json', 'pnpm-lock.yaml', 'scripts/buildIcon.ts', 'scripts/devBuildCache.ts']
      .map(path => resolve(project, path)),
  ]
}

async function main() {
  const fingerprint = cached ? await buildFingerprint(await inputs()) : undefined
  if (fingerprint && await buildCacheMatches(cachePath, fingerprint, outputs)) return
  const temporaryParent = resolve(tmpdir())
  const temporary = mkdtempSync(join(temporaryParent, 'pet-windows-icons-'))
  try {
    execFileSync(execPath, [
      require.resolve('@tauri-apps/cli/tauri.js'),
      'icon',
      join(project, 'public/logo.png'),
      '--output',
      temporary,
    ], { stdio: 'inherit' })
    mkdirSync(join(root, 'icons'), { recursive: true })
    for (const name of names) {
      await writeFileIfChanged(join(root, 'icons', name), await readFile(join(temporary, name)))
    }
    await writeFileIfChanged(join(root, 'assets/tray.png'), await readFile(join(temporary, '32x32.png')))
  } finally {
    if (dirname(resolve(temporary)) === temporaryParent && basename(temporary).startsWith('pet-windows-icons-')) {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  if (fingerprint && fingerprint === await buildFingerprint(await inputs())) {
    await saveBuildCache(cachePath, fingerprint, outputs)
  }
}

await main()
