/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { build } from 'vite'

import { runLocaleCommand } from '../locales'
import { addLocale, checkProject, createPseudoCatalog, flattenCatalog, hashText, messageSignature, readCatalog, readRegistry, readReviews, reviewKeys, seedImportedReviews, syncCatalogs } from './core'
import { createLocaleModule, localePlugin } from './vitePlugin'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'block-pet-locales-'))
  mkdirSync(join(root, 'src/locales'), { recursive: true })
  const registry = {
    version: 1,
    sourceLocale: 'ko-KR',
    fallbackLocale: 'en-US',
    locales: {
      'ko-KR': { nativeName: '한국어', direction: 'ltr', status: 'ready', matches: ['ko', 'ko-*'], antdLocale: 'ko_KR', pluralCategories: ['other'] },
      'en-US': { nativeName: 'English', direction: 'ltr', status: 'ready', matches: ['en', 'en-*'], antdLocale: 'en_US', pluralCategories: ['one', 'other'] },
    },
  }
  const ko = { greeting: '안녕 {name}', quantity: '수량: {count}', group: { word: '단어' } }
  const en = { greeting: 'Hello {name}', quantity: 'Quantity: {count}', group: { word: 'Word' } }
  const write = (name: string, value: unknown) => writeFileSync(join(root, `src/locales/${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
  write('registry', registry)
  write('ko-KR', ko)
  write('en-US', en)
  return { root, registry, ko, en, write }
}

// Synthetic offline-lock fixture; real snapshot compilation is covered by the
// private translation suite. No live provider evidence is implied here.
function lockFixture(root: string) {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value)
  const ready = Object.entries(readRegistry(root).locales).filter(([, locale]) => locale.status === 'ready').map(([code]) => code)
  const files = ['registry', 'reviews', ...ready].map(code => ({ path: `src/locales/${code}.json`, sha256: hashText(readFileSync(join(root, `src/locales/${code}.json`), 'utf8')) }))
  const body = { schemaVersion: 1, kind: 'BlockPetLocaleContentLock', sourceRevision: '1'.repeat(64), files, languages: ready.map(locale => ({ locale, provider: 'LocalFirstParty', sourceRevision: '1'.repeat(64), translationContentSha256: '2'.repeat(64), catalogSha256: files.find(file => file.path === `src/locales/${locale}.json`)!.sha256, provenanceSha256: '3'.repeat(64), reviewState: 'Unknown' })), snapshotInputsSha256: '4'.repeat(64) }
  writeFileSync(join(root, 'src/locales/content-lock.json'), JSON.stringify({ ...body, lockSha256: hashText(canonical(body)) }))
}

it('imports the operating baseline once, and invalidates source and target changes until explicit review', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  assert.equal(checkProject(f.root, { release: true }).ok, true)
  assert.equal(readReviews(f.root, 'ko-KR').locales['en-US'].greeting.kind, 'imported')
  assert.throws(() => seedImportedReviews(f.root), /already exists/)
  f.ko.greeting = '반가워 {name}'
  f.write('ko-KR', f.ko)
  assert.deepEqual(checkProject(f.root, { release: true }).locales.map(locale => locale.stale), [['greeting'], ['greeting']])
  reviewKeys(f.root, 'ko-KR', ['greeting'])
  reviewKeys(f.root, 'en-US', ['greeting'])
  assert.equal(checkProject(f.root, { release: true }).ok, true)
  f.en.greeting = 'Welcome {name}'
  f.write('en-US', f.en)
  assert.deepEqual(checkProject(f.root, { release: true }).locales[1].stale, ['greeting'])
  reviewKeys(f.root, 'en-US', ['greeting'])
  assert.equal(readReviews(f.root, 'ko-KR').locales['en-US'].greeting.kind, 'reviewed')
})

it('scaffolds drafts without overwriting files, and sync preserves translations and obsolete messages', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  addLocale(f.root, 'ja-JP', { nativeName: '日本語', antdLocale: 'ja_JP' })
  assert.equal(readRegistry(f.root).locales['ja-JP'].status, 'draft')
  assert.equal(flattenCatalog(readCatalog(f.root, 'ja-JP')).greeting, '')
  assert.equal(checkProject(f.root, { release: true }).ok, true)
  const before = readFileSync(join(f.root, 'src/locales/ja-JP.json'))
  assert.throws(() => addLocale(f.root, 'ja-JP'), /already registered/)
  assert.deepEqual(readFileSync(join(f.root, 'src/locales/ja-JP.json')), before)
  assert.throws(() => addLocale(f.root, '../../escape'), /Invalid/)
  f.write('de-DE', { retained: 'existing unregistered file' })
  assert.throws(() => addLocale(f.root, 'de-DE'), /EEXIST/)
  assert.equal(readRegistry(f.root).locales['de-DE'], undefined)
  f.write('ko-KR', { greeting: f.ko.greeting, quantity: f.ko.quantity, added: '새 항목' })
  const report = syncCatalogs(f.root)
  const english = flattenCatalog(readCatalog(f.root, 'en-US'))
  assert.equal(english.greeting, f.en.greeting)
  assert.equal(english['group.word'], 'Word')
  assert.equal(english.added, '')
  assert.deepEqual(report.locales[1].obsolete, ['group.word'])
  assert.equal(readReviews(f.root, 'ko-KR').locales['en-US'].added, undefined)
})

it('rejects duplicate JSON keys, broken grammar and incompatible parameters without recording review', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  const baseline = readFileSync(join(f.root, 'src/locales/reviews.json'))
  f.en.greeting = 'Hello {wrong}'
  f.write('en-US', f.en)
  assert.match(checkProject(f.root, { release: true }).errors.join('\n'), /Incompatible interpolation/)
  assert.throws(() => reviewKeys(f.root, 'en-US', ['greeting']), /Cannot review/)
  assert.deepEqual(readFileSync(join(f.root, 'src/locales/reviews.json')), baseline)
  f.en.greeting = 'Broken {name'
  f.write('en-US', f.en)
  assert.match(checkProject(f.root).errors.join('\n'), /Message syntax/)
  writeFileSync(join(f.root, 'src/locales/en-US.json'), '{"greeting":"first","greeting":"second"}')
  assert.match(checkProject(f.root).errors.join('\n'), /Duplicate JSON key/)
})

it('validates explicit plural forms against locale categories while allowing language-specific case counts', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  addLocale(f.root, 'ar-EG', { direction: 'rtl', antdLocale: 'ar_EG' })
  const arabic = { ...f.en, quantity: '{count} zero | {count} one | {count} two | {count} few | {count} many | {count} other' }
  f.write('ar-EG', arabic)
  assert.equal(checkProject(f.root).locales[2].invalid.length, 0)
  arabic.quantity = '{count} one | {count} other'
  f.write('ar-EG', arabic)
  assert.match(checkProject(f.root).locales[2].invalid.join('\n'), /Expected 6 plural forms/)
})

it('strips draft and pseudo catalogs plus metadata from production build inputs', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  addLocale(f.root, 'ja-JP', { nativeName: 'DRAFT_METADATA_SENTINEL' })
  f.write('ja-JP', { ...f.en, greeting: 'DRAFT_TEXT_SENTINEL' })
  const production = createLocaleModule(f.root, false)
  assert.ok(!production.includes('DRAFT_'))
  assert.ok(!production.includes('en-XA'))
  assert.ok(!production.includes('ar-XB'))
  assert.ok(createLocaleModule(f.root, true).includes('DRAFT_TEXT_SENTINEL'))
  assert.ok(createLocaleModule(f.root, true).includes('en-XA'))
  const plugin = localePlugin(f.root)
  const load = plugin.load as (id: string) => string | undefined
  const filteredSource = load(realpathSync.native(join(f.root, 'src/locales/registry.json')))
  assert.ok(filteredSource)
  const filtered = JSON.parse(filteredSource)
  assert.equal(filtered.locales['ja-JP'], undefined)
  assert.equal(Object.keys(filtered.locales).length, 2)
  assert.equal(load('/__locale_preview.ts'), undefined)
})

it('pseudo localization preserves compiler-recognized placeholders, linked keys and literal escapes', () => {
  const source = { text: 'Hello {name}, {0}, {\'@\'} | Goodbye {name}, {0}, {\'@\'}', linked: '@:word', word: 'World' }
  for (const direction of ['ltr', 'rtl'] as const) {
    const pseudo = createPseudoCatalog(source, direction)
    const signature = messageSignature(pseudo.text as string)
    assert.deepEqual(signature.parameters, ['list:0', 'named:name'])
    assert.equal(signature.forms, 2)
    assert.equal(pseudo.linked, source.linked)
    assert.ok((pseudo.text as string).length > source.text.length)
  }
})

it('enforces the release gate and excludes draft text through a real Vite bundle', async () => {
  const f = fixture()
  seedImportedReviews(f.root)
  addLocale(f.root, 'ja-JP', { nativeName: 'DRAFT_METADATA_SENTINEL' })
  f.write('ja-JP', { ...f.en, greeting: 'DRAFT_TEXT_SENTINEL' })
  const entry = join(f.root, 'entry.ts')
  writeFileSync(entry, 'import {messages,previewLocales} from \'virtual:block-pet-locales\';import registry from \'./src/locales/registry.json\';export {messages,previewLocales,registry};')
  const bundle = async () => {
    const result = await build({
      configFile: false,
      root: f.root,
      publicDir: false,
      logLevel: 'silent',
      plugins: [localePlugin(f.root)],
      build: { write: false, minify: false, lib: { entry, formats: ['es'] }, rollupOptions: { external: id => id.startsWith('ant-design-vue/') } },
    })
    return (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []).filter(item => item.type === 'chunk').map(item => item.code).join('\n')
  }
  lockFixture(f.root)
  const code = await bundle()
  assert.ok(!code.includes('DRAFT_'))
  assert.ok(!code.includes('ja-JP'))
  assert.ok(!code.includes('en-XA'))
  assert.ok(!code.includes('ar-XB'))
  f.en.greeting = 'Changed {name}'
  f.write('en-US', f.en)
  await assert.rejects(bundle(), /review required/)
})

it('requires explicit reviewed-key selection and gives an isolated development preview URL', () => {
  const f = fixture()
  seedImportedReviews(f.root)
  const output: string[] = []
  assert.throws(() => runLocaleCommand(f.root, ['review', 'en-US'], text => output.push(text)), /Select reviewed keys/)
  assert.equal(runLocaleCommand(f.root, ['preview', 'ar-XB'], text => output.push(text)), 0)
  assert.match(output.join('\n'), /__locale_preview\?locale=ar-XB/)
  lockFixture(f.root)
  assert.equal(runLocaleCommand(f.root, ['check', '--release'], () => {}), 0)
  f.write('en-US', { ...f.en, greeting: '' })
  assert.equal(runLocaleCommand(f.root, ['check', '--release'], () => {}), 1)
})

it('rejects ambiguous aliases and preserves existing dotted message identifiers', () => {
  const f = fixture()
  f.registry.locales['en-US'].matches.push('ko-*')
  f.write('registry', f.registry)
  assert.throws(() => readRegistry(f.root), /Ambiguous/)
  assert.deepEqual({ ...flattenCatalog({ labels: { 'preset.example': 'name' } }) }, { 'labels.preset.example': 'name' })
  assert.throws(() => flattenCatalog({ 'a.b': 'one', 'a': { b: 'two' } }), /Ambiguous/)
})

it('rejects a linked draft catalog without touching the destination', (context) => {
  const f = fixture()
  const destination = join(f.root, 'outside.json')
  writeFileSync(destination, 'original')
  try {
    symlinkSync(destination, join(f.root, 'src/locales/ja-JP.json'), 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Windows symlink creation unavailable')
      return
    }
    throw error
  }
  assert.throws(() => addLocale(f.root, 'ja-JP'), /ordinary/)
  assert.equal(readFileSync(destination, 'utf8'), 'original')
})
