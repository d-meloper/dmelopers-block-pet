import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'

import { assertInclusionPolicy, INCLUSION_POLICY_PATH, INCLUSION_SOURCE_PATHS, inclusionSourceProjection } from './inclusionPolicy'

export interface LocaleDefinition {
  nativeName: string
  direction: 'ltr' | 'rtl'
  status: 'draft' | 'ready'
  matches: string[]
  antdLocale: string
  pluralCategories: string[]
}
export interface LocaleRegistry {
  version: 1
  sourceLocale: string
  fallbackLocale: string
  locales: Record<string, LocaleDefinition>
}
export interface Catalog { [key: string]: string | Catalog }
export interface Review {
  sourceHash: string
  targetHash: string
  kind: 'imported' | 'reviewed'
}
export interface Reviews {
  version: 1
  sourceLocale: string
  locales: Record<string, Record<string, Review>>
}
export interface LocaleReport {
  code: string
  status: LocaleDefinition['status']
  total: number
  translated: number
  missing: string[]
  empty: string[]
  obsolete: string[]
  stale: string[]
  invalid: string[]
}
export interface ProjectReport {
  ok: boolean
  sourceLocale: string
  fallbackLocale: string
  errors: string[]
  locales: LocaleReport[]
}

interface MessageNode {
  type: number
  start?: number
  end?: number
  key?: string | MessageNode
  index?: number
  value?: string
  body?: MessageNode
  items?: MessageNode[]
  cases?: MessageNode[]
}
const require = createRequire(import.meta.url)
const vueRequire = createRequire(require.resolve('vue-i18n'))
const { baseCompile } = vueRequire('@intlify/message-compiler') as {
  baseCompile: (message: string, options: { onError: (error: Error) => void }) => { ast: MessageNode }
}
const categoryOrder = ['zero', 'one', 'two', 'few', 'many', 'other']
const categories = new Set(categoryOrder)
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype'])

export function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function readInclusionPolicy(root: string) {
  const path = projectPath(root, INCLUSION_POLICY_PATH, true)
  if (!existsSync(path)) return undefined
  const policy = readJson(root, INCLUSION_POLICY_PATH)
  assertInclusionPolicy(policy)
  return policy
}

export function inclusionSourceHash(root: string): string {
  return hashText(inclusionSourceProjection(INCLUSION_SOURCE_PATHS.map(path => ({ path, sha256: hashText(readFileSync(projectPath(root, path), 'utf8')) }))))
}

/** Canonicalize the root once, then reject symlink/reparse intermediates and leaves. */
export function projectPath(root: string, name: string, allowMissing = false): string {
  const canonicalRoot = realpathSync.native(root)
  const target = resolve(canonicalRoot, name)
  const rel = relative(canonicalRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe project path: ${name}`)
  let current = canonicalRoot
  const parts = rel.split(/[\\/]/)
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index])
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return target
      throw error
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Expected ordinary project ${index < parts.length - 1 ? 'directory' : 'file'}: ${name}`)
    }
  }
  return target
}

export function readJson(root: string, name: string): unknown {
  const path = projectPath(root, name)
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error(`JSON file too large: ${name}`)
  const ast = ts.parseJsonText(name, raw)
  const diagnostics = (ast as typeof ast & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(`Invalid JSON syntax: ${name}`)
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>()
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error(`Invalid JSON property: ${name}`)
        const key = property.name.text
        if (seen.has(key)) throw new Error(`Duplicate JSON key in ${name}: ${key}`)
        seen.add(key)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return JSON.parse(raw)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validLocaleCode(code: string): boolean {
  if (!/^[A-Z]{2,8}(?:-[A-Z0-9]{1,8})*$/i.test(code)) return false
  try {
    return Intl.getCanonicalLocales(code)[0] === code
  } catch {
    return false
  }
}

export function readRegistry(root: string): LocaleRegistry {
  const value = readJson(root, 'src/locales/registry.json')
  if (!object(value) || value.version !== 1 || !object(value.locales)
    || typeof value.sourceLocale !== 'string' || typeof value.fallbackLocale !== 'string') {
    throw new Error('Invalid locale registry')
  }
  for (const [code, metadata] of Object.entries(value.locales)) {
    if (!validLocaleCode(code) || ['en-XA', 'ar-XB'].includes(code) || !object(metadata) || typeof metadata.nativeName !== 'string' || !metadata.nativeName.trim()
      || !['ltr', 'rtl'].includes(String(metadata.direction)) || !['draft', 'ready'].includes(String(metadata.status))
      || !Array.isArray(metadata.matches) || !metadata.matches.every(pattern => typeof pattern === 'string' && /^[A-Z]{2,8}(?:-[A-Z0-9]{1,8})*(?:-\*)?$/i.test(pattern))
      || typeof metadata.antdLocale !== 'string' || !/^[a-z]{2,3}_[A-Z]{2}$/.test(metadata.antdLocale)
      || !Array.isArray(metadata.pluralCategories) || !metadata.pluralCategories.length
      || !metadata.pluralCategories.includes('other') || new Set(metadata.pluralCategories).size !== metadata.pluralCategories.length
      || !metadata.pluralCategories.every(category => typeof category === 'string' && categories.has(category))) {
      throw new Error(`Invalid locale metadata: ${code}`)
    }
    try {
      require.resolve(`ant-design-vue/locale/${metadata.antdLocale}`)
    } catch {
      throw new Error(`Ant Design locale is not installed: ${metadata.antdLocale}`)
    }
  }
  const registry = value as unknown as LocaleRegistry
  if (registry.locales[registry.sourceLocale]?.status !== 'ready' || registry.locales[registry.fallbackLocale]?.status !== 'ready') throw new Error('Source and fallback locales must be ready')
  // Intersecting aliases are rejected; explicit registered codes still take priority at runtime.
  const aliases: Array<{ code: string, pattern: string }> = []
  for (const [code, locale] of Object.entries(registry.locales)) {
    if (locale.status !== 'ready') continue
    for (const raw of locale.matches) {
      const pattern = raw.toLowerCase()
      for (const previous of aliases) {
        const prefix = pattern.endsWith('-*') ? pattern.slice(0, -1) : undefined
        const previousPrefix = previous.pattern.endsWith('-*') ? previous.pattern.slice(0, -1) : undefined
        if (previous.code !== code && (pattern === previous.pattern || (prefix && previous.pattern.startsWith(prefix)) || (previousPrefix && pattern.startsWith(previousPrefix)))) {
          throw new Error(`Ambiguous locale match: ${previous.code}/${code}: ${raw}`)
        }
      }
      aliases.push({ code, pattern })
    }
  }
  return registry
}

export function flattenCatalog(catalog: unknown, prefix = ''): Record<string, string> {
  if (!object(catalog)) throw new Error(`Expected catalog object: ${prefix || '<root>'}`)
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(catalog)) {
    if (!key || dangerousKeys.has(key)) throw new Error(`Unsafe catalog key: ${prefix}.${key}`)
    const path = prefix ? `${prefix}.${key}` : key
    const entries = typeof value === 'string' ? { [path]: value } : flattenCatalog(value, path)
    for (const [entry, text] of Object.entries(entries)) {
      if (Object.hasOwn(result, entry)) throw new Error(`Ambiguous catalog key: ${entry}`)
      result[entry] = text
    }
  }
  if (Object.keys(result).length > 20000) throw new Error('Catalog has too many messages')
  return result
}

export function readCatalog(root: string, code: string): Catalog {
  if (!validLocaleCode(code)) throw new Error(`Invalid locale code: ${code}`)
  const catalog = readJson(root, `src/locales/${code}.json`)
  flattenCatalog(catalog)
  return catalog as Catalog
}

export function readReviews(root: string, sourceLocale: string): Reviews {
  try {
    const reviews = readJson(root, 'src/locales/reviews.json')
    if (!object(reviews) || reviews.version !== 1 || reviews.sourceLocale !== sourceLocale || !object(reviews.locales)) throw new Error('Invalid review metadata')
    for (const [code, keys] of Object.entries(reviews.locales)) {
      if (!validLocaleCode(code) || !object(keys)) throw new Error('Invalid review locale')
      for (const [key, review] of Object.entries(keys)) {
        if (dangerousKeys.has(key) || !object(review) || !['imported', 'reviewed'].includes(String(review.kind))
          || !/^[a-f0-9]{64}$/.test(String(review.sourceHash)) || !/^[a-f0-9]{64}$/.test(String(review.targetHash))) {
          throw new Error(`Invalid review entry: ${code}/${key}`)
        }
      }
    }
    return reviews as unknown as Reviews
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, sourceLocale, locales: {} }
  }
}

export function messageSignature(message: string) {
  const errors: string[] = []
  let ast: MessageNode
  try {
    ast = baseCompile(message, { onError: error => errors.push(error.message) }).ast
  } catch (error) {
    throw new Error(`Message syntax: ${(error as Error).message}`)
  }
  if (errors.length) throw new Error(`Message syntax: ${errors.join('; ')}`)
  const parameters = new Set<string>()
  const links = new Set<string>()
  const walk = (node: MessageNode) => {
    if (node.type === 4 && typeof node.key === 'string') parameters.add(`named:${node.key}`)
    if (node.type === 5) parameters.add(`list:${node.index}`)
    if (node.type === 6 && object(node.key) && typeof node.key.value === 'string') links.add(node.key.value)
    for (const item of node.items ?? []) walk(item)
    for (const item of node.cases ?? []) walk(item)
    if (node.body) walk(node.body)
  }
  walk(ast)
  return { ast, parameters: [...parameters].sort(), links: [...links].sort(), forms: ast.body?.cases?.length ?? 1 }
}

export function checkProject(root: string, options: { release?: boolean } = {}): ProjectReport {
  const registry = readRegistry(root)
  const source = flattenCatalog(readCatalog(root, registry.sourceLocale))
  const reviews = readReviews(root, registry.sourceLocale)
  const errors: string[] = []
  const locales: LocaleReport[] = []
  const inclusions = options.release ? readInclusionPolicy(root) : undefined
  const sourceInputsSha256 = inclusions ? inclusionSourceHash(root) : undefined
  const signatures: Record<string, ReturnType<typeof messageSignature>> = Object.create(null)
  for (const [key, text] of Object.entries(source)) {
    try {
      signatures[key] = messageSignature(text)
    } catch (error) {
      errors.push(`${registry.sourceLocale}/${key}: ${(error as Error).message}`)
    }
  }
  for (const [code, metadata] of Object.entries(registry.locales)) {
    const report: LocaleReport = { code, status: metadata.status, total: Object.keys(source).length, translated: 0, missing: [], empty: [], obsolete: [], stale: [], invalid: [] }
    let target: Record<string, string> = Object.create(null)
    try {
      target = flattenCatalog(readCatalog(root, code))
    } catch (error) {
      report.invalid.push((error as Error).message)
    }
    for (const [key, original] of Object.entries(source)) {
      const text = target[key]
      if (text === undefined) {
        report.missing.push(key)
        continue
      }
      if (!text.trim()) {
        report.empty.push(key)
        continue
      }
      report.translated++
      try {
        const signature = messageSignature(text)
        if (signatures[key] && JSON.stringify(signature.parameters) !== JSON.stringify(signatures[key].parameters)) throw new Error('Incompatible interpolation parameters')
        if (signature.forms > 1 && signature.forms !== metadata.pluralCategories.length) throw new Error(`Expected ${metadata.pluralCategories.length} plural forms, got ${signature.forms}`)
        for (const link of signature.links) {
          if (!(link in target) && !(link in source)) throw new Error(`Unknown linked message: ${link}`)
        }
      } catch (error) {
        report.invalid.push(`${key}: ${(error as Error).message}`)
      }
      const review = reviews.locales[code]?.[key]
      if (!review || review.sourceHash !== hashText(original) || review.targetHash !== hashText(text)) report.stale.push(key)
    }
    report.obsolete = Object.keys(target).filter(key => !(key in source))
    if (metadata.status === 'ready') {
      for (const key of report.missing) errors.push(`${code}/${key}: missing`)
      for (const key of report.empty) errors.push(`${code}/${key}: empty`)
      for (const issue of report.invalid) errors.push(`${code}/${issue}`)
      if (options.release) {
        const inclusion = inclusions?.inclusions.find(entry => entry.locale === code)
        const approved = inclusion && inclusion.sourceInputsSha256 === sourceInputsSha256 && inclusion.catalogSha256 === hashText(readFileSync(projectPath(root, `src/locales/${code}.json`), 'utf8'))
        if (!approved) {
          for (const key of report.stale) errors.push(`${code}/${key}: review required`)
        }
      }
    }
    locales.push(report)
  }
  return { ok: errors.length === 0, sourceLocale: registry.sourceLocale, fallbackLocale: registry.fallbackLocale, errors, locales }
}

function writeJson(root: string, name: string, value: unknown, exclusive = false) {
  const path = projectPath(root, name, true)
  mkdirSync(dirname(path), { recursive: true })
  // Recheck after parent creation, before touching the final path.
  projectPath(root, name, true)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' })
}

/** One-time migration of the existing operating catalogs; never called by build/sync/check. */
export function seedImportedReviews(root: string): Reviews {
  const registry = readRegistry(root)
  try {
    projectPath(root, 'src/locales/reviews.json')
    throw new Error('Imported review baseline already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const report = checkProject(root)
  if (!report.ok) throw new Error(`Cannot import invalid baseline: ${report.errors.join('; ')}`)
  const source = flattenCatalog(readCatalog(root, registry.sourceLocale))
  const reviews: Reviews = { version: 1, sourceLocale: registry.sourceLocale, locales: {} }
  for (const [code, metadata] of Object.entries(registry.locales)) {
    if (metadata.status !== 'ready') continue
    const target = flattenCatalog(readCatalog(root, code))
    const keys: Record<string, Review> = Object.create(null)
    for (const [key, original] of Object.entries(source)) {
      if (!target[key]?.trim()) throw new Error(`Cannot import incomplete baseline: ${code}/${key}`)
      keys[key] = { sourceHash: hashText(original), targetHash: hashText(target[key]), kind: 'imported' }
    }
    reviews.locales[code] = keys
  }
  writeJson(root, 'src/locales/reviews.json', reviews, true)
  return reviews
}

export function addLocale(root: string, code: string, metadata: Partial<LocaleDefinition> = {}) {
  if (!validLocaleCode(code) || ['en-XA', 'ar-XB'].includes(code)) throw new Error(`Invalid or reserved locale: ${code}`)
  const registry = readRegistry(root)
  if (Object.keys(registry.locales).some(existing => existing.toLowerCase() === code.toLowerCase())) throw new Error(`Locale already registered: ${code}`)
  const source = readCatalog(root, registry.sourceLocale)
  const blank = (catalog: Catalog): Catalog => Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, typeof value === 'string' ? '' : blank(value)]))
  registry.locales[code] = {
    nativeName: metadata.nativeName ?? code,
    direction: metadata.direction ?? 'ltr',
    status: 'draft',
    matches: [],
    antdLocale: metadata.antdLocale ?? 'en_US',
    pluralCategories: metadata.pluralCategories ?? categoryOrder.filter(category => new Intl.PluralRules(code).resolvedOptions().pluralCategories.includes(category as Intl.LDMLPluralRule)),
  }
  const locale = registry.locales[code]
  if (!locale.nativeName.trim() || !['ltr', 'rtl'].includes(locale.direction) || !/^[a-z]{2,3}_[A-Z]{2}$/.test(locale.antdLocale)) throw new Error('Invalid new locale metadata')
  try {
    require.resolve(`ant-design-vue/locale/${locale.antdLocale}`)
  } catch {
    throw new Error(`Ant Design locale is not installed: ${locale.antdLocale}`)
  }
  writeJson(root, `src/locales/${code}.json`, blank(source), true)
  writeJson(root, 'src/locales/registry.json', registry)
}

export function syncCatalogs(root: string) {
  const registry = readRegistry(root)
  const source = readCatalog(root, registry.sourceLocale)
  const merge = (original: Catalog, target: Catalog): Catalog => {
    const result = { ...target }
    for (const [key, value] of Object.entries(original)) {
      if (!(key in result)) result[key] = typeof value === 'string' ? '' : merge(value, {})
      else if (typeof value !== 'string' && typeof result[key] !== 'string') result[key] = merge(value, result[key] as Catalog)
      // A conflicting node type is preserved and reported; never overwrite a translation.
    }
    return result
  }
  for (const code of Object.keys(registry.locales)) {
    if (code === registry.sourceLocale) continue
    const target = readCatalog(root, code)
    const merged = merge(source, target)
    if (JSON.stringify(target) !== JSON.stringify(merged)) writeJson(root, `src/locales/${code}.json`, merged)
  }
  return checkProject(root)
}

export function reviewKeys(root: string, code: string, keys: string[]) {
  const registry = readRegistry(root)
  if (!registry.locales[code]) throw new Error(`Unregistered locale: ${code}`)
  const report = checkProject(root)
  const locale = report.locales.find(item => item.code === code)!
  const source = flattenCatalog(readCatalog(root, registry.sourceLocale))
  const target = flattenCatalog(readCatalog(root, code))
  const reviews = readReviews(root, registry.sourceLocale)
  for (const key of keys) {
    if (!Object.hasOwn(source, key) || !source[key]?.trim() || !target[key]?.trim() || locale.invalid.some(issue => issue.startsWith(`${key}:`))) throw new Error(`Cannot review invalid or missing message: ${code}/${key}`)
    messageSignature(source[key])
  }
  reviews.locales[code] ??= {}
  for (const key of keys) reviews.locales[code][key] = { sourceHash: hashText(source[key]), targetHash: hashText(target[key]), kind: 'reviewed' }
  writeJson(root, 'src/locales/reviews.json', reviews)
}

export function cleanCatalog(catalog: Catalog): Catalog {
  const result: Catalog = {}
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === 'string') {
      if (value.trim()) result[key] = value
    } else {
      const cleaned = cleanCatalog(value)
      if (Object.keys(cleaned).length) result[key] = cleaned
    }
  }
  return result
}

export function createPseudoCatalog(catalog: Catalog, direction: 'ltr' | 'rtl' = 'ltr'): Catalog {
  const accent: Record<string, string> = { a: 'á', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Á', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' }
  const pseudo = (message: string) => {
    const { ast } = messageSignature(message)
    const replacements: Array<{ start: number, end: number, text: string }> = []
    const walk = (node: MessageNode) => {
      if (node.type === 3 && node.start !== undefined && node.end !== undefined && node.value?.trim()) {
        const text = message.slice(node.start, node.end).replace(/[aeiou]/gi, character => accent[character])
        const expanded = `${text}${'~'.repeat(Math.ceil(node.value.length * 0.4))}`
        replacements.push({ start: node.start, end: node.end, text: direction === 'rtl' ? `\u2067${expanded}\u2069` : expanded })
      }
      for (const child of node.items ?? []) walk(child)
      for (const child of node.cases ?? []) walk(child)
      if (node.body) walk(node.body)
    }
    walk(ast)
    return replacements.sort((a, b) => b.start - a.start).reduce((value, replacement) => value.slice(0, replacement.start) + replacement.text + value.slice(replacement.end), message)
  }
  return Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, typeof value === 'string' ? pseudo(value) : createPseudoCatalog(value, direction)]))
}
