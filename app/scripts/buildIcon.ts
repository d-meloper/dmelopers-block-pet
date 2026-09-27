import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const temporaryParent = resolve(tmpdir())
const temporary = mkdtempSync(join(temporaryParent, 'pet-windows-icons-'))

try {
  execFileSync(execPath, [
    require.resolve('@tauri-apps/cli/tauri.js'),
    'icon',
    join(root, '../public/logo.png'),
    '--output',
    temporary,
  ], { stdio: 'inherit' })
  mkdirSync(join(root, 'icons'), { recursive: true })
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico']) {
    copyFileSync(join(temporary, name), join(root, 'icons', name))
  }
  copyFileSync(join(temporary, '32x32.png'), join(root, 'assets/tray.png'))
} finally {
  if (dirname(resolve(temporary)) === temporaryParent && basename(temporary).startsWith('pet-windows-icons-')) {
    rmSync(temporary, { recursive: true, force: true })
  }
}
