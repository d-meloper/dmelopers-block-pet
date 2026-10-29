import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkContentLock } from './locales/contentLock'
import { addLocale, checkProject, flattenCatalog, readCatalog, readRegistry, reviewKeys, syncCatalogs } from './locales/core'

export function runLocaleCommand(root: string, args: string[], output: (value: string) => void = console.log): number {
  const [command, code] = args
  const option = (name: string) => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value: ${name}`)
    return args[index + 1]
  }
  if (command === 'add') {
    if (!code || code.startsWith('--')) throw new Error('Usage: pnpm locale add <BCP47 code> [--name <native name>] [--direction ltr|rtl] [--antd en_US]')
    const direction = option('--direction')
    if (direction && direction !== 'ltr' && direction !== 'rtl') throw new Error('Direction must be ltr or rtl')
    addLocale(root, code, { nativeName: option('--name'), direction: direction === 'rtl' ? 'rtl' : 'ltr', antdLocale: option('--antd') })
    output(`Created draft ${code}. Translate it, review its keys, and obtain language approval before setting status to ready.`)
    return 0
  }
  if (command === 'review') {
    if (!code || code.startsWith('--')) throw new Error('Usage: pnpm locale review <code> --keys key1,key2 (or explicit --all)')
    const registry = readRegistry(root)
    const selected = option('--keys')
    const keys = args.includes('--all') ? Object.keys(flattenCatalog(readCatalog(root, registry.sourceLocale))) : selected?.split(',').filter(Boolean)
    if (!keys?.length) throw new Error('Select reviewed keys with --keys or explicit --all; review never runs automatically')
    reviewKeys(root, code, keys)
    output(`Recorded explicit review for ${keys.length} messages in ${code}.`)
    return 0
  }
  if (command === 'preview') {
    const registry = readRegistry(root)
    const selected = code && !code.startsWith('--') ? code : 'en-XA'
    if (!registry.locales[selected] && !['en-XA', 'ar-XB'].includes(selected)) throw new Error(`Unregistered preview locale: ${selected}`)
    output(`Run pnpm dev:vite, then open http://localhost:1420/__locale_preview?locale=${encodeURIComponent(selected)}`)
    output('The preview is development-only and accesses no native commands or user settings.')
    return 0
  }
  if (!['sync', 'report', 'check'].includes(command)) throw new Error('Usage: pnpm locale <add|sync|report|review|check|preview>')
  const report = command === 'sync' ? syncCatalogs(root) : checkProject(root, { release: args.includes('--release') })
  if (command === 'check' && args.includes('--release') && report.ok) {
    try {
      checkContentLock(root, { committed: args.includes('--committed') })
    } catch (error) {
      report.ok = false
      report.errors.push((error as Error).message)
    }
  }
  if (args.includes('--json')) {
    output(JSON.stringify(report, null, 2))
  } else {
    for (const locale of report.locales) output(`${locale.code} [${locale.status}]: ${locale.translated}/${locale.total}; missing ${locale.missing.length}, empty ${locale.empty.length}, invalid ${locale.invalid.length}, review ${locale.stale.length}, obsolete ${locale.obsolete.length}`)
    for (const error of report.errors) output(error)
    if (command === 'check' && report.ok) output('Locale check passed.')
  }
  return command === 'check' && !report.ok ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = runLocaleCommand(fileURLToPath(new URL('..', import.meta.url)), process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
