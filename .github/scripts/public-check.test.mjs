import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { inspectFile, inspectText, inspectPng, inspectGif, inspectGlb, inspectMarkdownLinks, checkTree } from './public-check.mjs'

const secret = ['sk', 'proj', 'x'.repeat(24)].join('-')
const pngPath = 'app/public/logo.png'
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4)
  size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, body, checksum])
}
function png(...chunks) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...chunks, chunk('IEND', Buffer.alloc(0))])
}
function glb(json) {
  const document = Buffer.from(json + ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4))
  const header = Buffer.alloc(20)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + document.length, 8)
  header.writeUInt32LE(document.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([header, document])
}

function gifSubblocks(data, size = 255) {
  const pieces = []
  for (let offset = 0; offset < data.length; offset += size) {
    const part = data.subarray(offset, offset + size)
    pieces.push(Buffer.from([part.length]), part)
  }
  return Buffer.concat([...pieces, Buffer.from([0])])
}
function gif(extension = Buffer.alloc(0), local = false, version = 'GIF89a') {
  const screen = Buffer.from([1, 0, 1, 0, local ? 0 : 0x80, 0, 0])
  const palette = Buffer.from([0, 0, 0, 255, 255, 255])
  const image = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, local ? 0x80 : 0])
  return Buffer.concat([Buffer.from(version), screen, local ? Buffer.alloc(0) : palette, extension,
    image, local ? palette : Buffer.alloc(0), Buffer.from([2, 2, 0x44, 1, 0, 0x3b])])
}

test('credential and personal paths are found across byte encodings and alignments', () => {
  const samples = [secret, ['ghp', 'x'.repeat(24)].join('_'),
    ['C:', 'Users', 'fixture', 'file'].join('\\'), ['', 'home', 'fixture', 'file'].join('/'),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join('')]
  for (const value of samples) {
    const utf16 = Buffer.from(value, 'utf16le')
    for (const bytes of [Buffer.from(value), utf16, Buffer.from(utf16).swap16(), Buffer.concat([Buffer.from([255]), utf16])])
      assert.throws(() => inspectText(bytes, 'fixture'))
  }
})

test('credential directories, outputs and certificates remain forbidden even when inventoried', () => {
  for (const path of ['app/.git/config', 'app/.npmrc', '.ssh/config', 'app/.azure/profile', 'app/data.sqlite3',
    'app/runtime.dll', 'app/store.msix', 'app/cert.p12', 'app/archive.7z', 'app/.env.local', 'app/../escape'])
    assert.throws(() => inspectFile(path, Buffer.from('text')))
})

test('renamed executable/archive/database and disguised image are rejected by content', () => {
  for (const hex of ['4d5a', '7f454c46', '504b0304', '377abcaf271c', '53514c69746520666f726d6174203300'])
    assert.throws(() => inspectFile('app/source.txt', Buffer.from(hex, 'hex')), /binary/)
  assert.throws(() => inspectFile('app/source.txt', png()), /disguised/)
})

test('the reviewed README hero is allowed while other images and private metadata are rejected', () => {
  inspectFile('assets/hero.png', png())
  for (const path of ['assets/other.png', 'assets/Hero.png', 'assets/hero.jpg'])
    assert.throws(() => inspectFile(path, png()))
  assert.throws(() => inspectFile('assets/hero.png', png(chunk('tEXt', Buffer.from(secret)))), /credential/)
})

test('PNG metadata checks preserve ordinary ICC but inspect every text form', () => {
  inspectPng(png(chunk('iCCP', Buffer.concat([Buffer.from('sRGB\0\0'), deflateSync(Buffer.from('standard color profile'))]))), pngPath)
  const payload = Buffer.from(secret)
  const chunks = [chunk('tEXt', payload), chunk('eXIf', payload),
    chunk('zTXt', Buffer.concat([Buffer.from('note\0\0'), deflateSync(payload)])),
    chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0'), deflateSync(payload)])),
    chunk('iTXt', Buffer.concat([Buffer.from('note\0\x01\0\0\0'), deflateSync(payload)])),
    chunk('iTXt', Buffer.concat([Buffer.from('note\0\0\0\0\0'), payload]))]
  for (const metadata of chunks) assert.throws(() => inspectPng(png(metadata), pngPath), /credential/)
})

test('PNG bounds, CRC, compression headers and trailing data fail closed', () => {
  const oversized = chunk('zTXt', Buffer.concat([Buffer.from('note\0\0'), deflateSync(Buffer.alloc(1024 * 1024 + 2, 65))]))
  assert.throws(() => inspectPng(png(oversized), pngPath))
  const trailing = Buffer.concat([Buffer.from('note\0\0'), deflateSync(Buffer.from('ordinary')), deflateSync(Buffer.from(secret))])
  assert.throws(() => inspectPng(png(chunk('zTXt', trailing)), pngPath), /trailing/)
  assert.throws(() => inspectPng(png(chunk('zTXt', Buffer.from('note\0\x01bad'))), pngPath))
  const broken = png(); broken[29] ^= 1
  assert.throws(() => inspectPng(broken, pngPath), /CRC/)
  assert.throws(() => inspectPng(Buffer.concat([png(), Buffer.from('extra')]), pngPath), /trailing/)
})

test('GLB JSON escapes are decoded, with malformed and oversized documents rejected', () => {
  inspectGlb(glb('{"asset":{"version":"2.0"}}'), 'model.glb')
  const encoded = [...secret].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  assert.throws(() => inspectGlb(glb('{"extras":{"note":"' + encoded + '"}}'), 'model.glb'), /credential/)
  assert.throws(() => inspectGlb(glb('{"note":"' + 'a'.repeat(1024 * 1024) + '"}'), 'model.glb'), /limit/)
  const broken = glb('{}'); broken.writeUInt32LE(99, 8)
  assert.throws(() => inspectGlb(broken, 'model.glb'), /invalid/)
})

test('GIF structure accepts both headers, global and local palettes, and known extension blocks', () => {
  const extension = Buffer.concat([Buffer.from([0x21, 0xfe]), gifSubblocks(Buffer.from('Owner screenshot'), 3),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), gifSubblocks(Buffer.from([1, 0, 0])),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0])])
  for (const bytes of [gif(extension), gif(Buffer.alloc(0), true), gif(Buffer.alloc(0), false, 'GIF87a')])
    assert.deepEqual(inspectGif(bytes, 'fixture'), { width: 1, height: 1, frames: 1 })
  const text = Buffer.from([0x21, 1, 12, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1])
  assert.equal(inspectGif(gif(Buffer.concat([text, gifSubblocks(Buffer.from('A'))])), 'fixture').frames, 1)
})

test('GIF extension metadata detects credentials and profiles across subblocks with bounded work', () => {
  const text = Buffer.from([0x21, 1, 12, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1])
  for (const data of [Buffer.from(secret), Buffer.from(secret, 'utf16le'), Buffer.from(['C:', 'Users', 'fixture', 'private.txt'].join('/'))]) {
    for (const header of [Buffer.from([0x21, 0xfe]), Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('TESTAPP0001')]), text])
      assert.throws(() => inspectGif(gif(Buffer.concat([header, gifSubblocks(data, 3)])), 'fixture'), /credential|personal profile/)
  }
  const oversized = Buffer.concat([Buffer.from([0x21, 0xfe]), gifSubblocks(Buffer.alloc(1024 * 1024 + 1, 65))])
  assert.throws(() => inspectGif(gif(oversized), 'fixture'), /metadata limit/)
  const excessive = Buffer.from([0x21, 0xfe, 0])
  assert.throws(() => inspectGif(gif(Buffer.concat(Array(65537).fill(excessive))), 'fixture'), /block limit/)
})

test('GIF truncation, frame bounds, missing palette, LZW chain and trailing data fail closed', () => {
  const bytes = gif()
  const highBitHeader = Buffer.from(bytes); highBitHeader[0] |= 0x80
  assert.throws(() => inspectGif(highBitHeader, 'fixture'), /GIF header/)
  for (let length = 0; length < bytes.length; length++) assert.throws(() => inspectGif(bytes.subarray(0, length), 'fixture'))
  const bounds = Buffer.from(bytes); bounds.writeUInt16LE(2, 24)
  const code = Buffer.from(bytes); code[29] = 1
  const noPalette = Buffer.concat([bytes.subarray(0, 13), bytes.subarray(19)]); noPalette[10] = 0
  for (const broken of [bounds, code, noPalette, Buffer.concat([bytes.subarray(0, 19), Buffer.from([0x3b])]),
    Buffer.concat([bytes.subarray(0, 30), Buffer.from([0, 0x3b])]), Buffer.concat([bytes, Buffer.from('MZ trailing payload')]),
    gif(Buffer.from([0x21, 0xee, 0])), gif(Buffer.from([0x21, 0xf9, 3, 0, 0, 0, 0])),
    gif(Buffer.from([0x21, 0xf9, 4, 1, 0, 0, 3, 0]))]) assert.throws(() => inspectGif(broken, 'fixture'))
})

test('only the seven exact reviewed README GIF bytes are admitted; changes and disguises are rejected', async () => {
  const records = [
    ['assets/features/input-mouse.gif', 640, 480, 76], ['assets/features/input-keyboard.gif', 640, 480, 47],
    ['assets/features/skin-selection.gif', 640, 480, 66], ['assets/features/pet-customization.gif', 640, 480, 65],
    ['assets/features/display-customization.gif', 640, 480, 58], ['assets/features/object-customization.gif', 640, 480, 71],
    ['assets/features/presets.gif', 1200, 532, 152],
  ]
  const inventory = JSON.parse(await readFile(new URL('../public-files.json', import.meta.url), 'utf8'))
  assert.deepEqual(inventory.files.filter(path => path.endsWith('.gif')), records.map(row => row[0]).sort())
  for (const [path, width, height, frames] of records) {
    const bytes = await readFile(new URL('../../' + path, import.meta.url))
    inspectFile(path, bytes)
    assert.deepEqual(inspectGif(bytes, path), { width, height, frames })
    const changed = Buffer.from(bytes); changed[12] ^= 1
    assert.throws(() => inspectFile(path, changed), /reviewed GIF bytes/)
    assert.throws(() => inspectFile(path.toUpperCase(), bytes), /unreviewed GIF/)
  }
  for (const path of ['assets/features/other.gif', 'app/public/animation.gif'])
    assert.throws(() => inspectFile(path, gif()), /unreviewed GIF/)
  for (const path of ['app/source.txt', 'assets/hero.png', 'app/public/logo.png'])
    assert.throws(() => inspectFile(path, gif()), /disguised GIF/)
  assert.throws(() => inspectFile('assets/features/input-mouse.gif', gif()), /reviewed GIF bytes/)
})

const documentationFiles = ['LICENSE', 'README.md', 'assets/hero.png', 'docs/CONTRIBUTING.md',
  'docs/CONTRIBUTING.ko-KR.md', 'docs/SECURITY.md', 'docs/SECURITY.ko-KR.md', 'docs/PRIVACY.md', 'docs/SUPPORT.md']
const documentationBase = 'https://github.com/d-meloper/dmelopers-block-pet/blob/main/'

test('contribution and security links survive both GitHub root-rendered and ordinary file views', () => {
  for (const [path, target] of [['docs/CONTRIBUTING.md', 'CONTRIBUTING.ko-KR.md'],
    ['docs/SECURITY.md', 'SECURITY.ko-KR.md'], ['docs/SECURITY.md', 'PRIVACY.md'], ['docs/SECURITY.md', 'SUPPORT.md']]) {
    const fileView = new URL(target, documentationBase + path)
    const rootView = new URL(target, documentationBase)
    assert(documentationFiles.includes(fileView.pathname.split('/blob/main/')[1]))
    assert(!documentationFiles.includes(rootView.pathname.split('/blob/main/')[1]))
    assert.throws(() => inspectMarkdownLinks(`[link](${target})`, path, documentationFiles), /root-rendered/)
    const canonical = documentationBase + 'docs/' + target
    assert.equal(new URL(canonical, fileView).href, new URL(canonical, rootView).href)
    inspectMarkdownLinks(`[link](${canonical})`, path, documentationFiles)
  }
  assert.throws(() => inspectMarkdownLinks('[English](CONTRIBUTING.md)', 'docs/CONTRIBUTING.ko-KR.md', documentationFiles), /root-rendered/)
  assert.throws(() => inspectMarkdownLinks('[English](SECURITY.md)', 'docs/SECURITY.ko-KR.md', documentationFiles), /root-rendered/)
})

test('metadata links use exact projected paths, including HTML and reference-style links', () => {
  inspectMarkdownLinks('[Support](docs/SUPPORT.md#installation) [Directory](docs/) [License](LICENSE)\n' +
    '<img src="assets/hero.png"> [External](https://example.com/missing.md) [Mail](mailto:fixture@example.com) [Here](#usage)',
  'README.md', documentationFiles)
  inspectMarkdownLinks('[License](../LICENSE) [Data](PRIVACY.md)\n[help]: SUPPORT.md "Support"', 'docs/SUPPORT.md', documentationFiles)
  for (const prose of ['[Missing](docs/MISSING.md)', '[Case](docs/Support.md)', '<img src="assets/Hero.png">', '[help]: docs/MISSING.md'])
    assert.throws(() => inspectMarkdownLinks(prose, 'README.md', documentationFiles), /missing or wrong-case/)
  assert.throws(() => inspectMarkdownLinks(`[Data](${documentationBase}docs/privacy.md)`, 'docs/SECURITY.md', documentationFiles), /wrong-case/)
  assert.throws(() => inspectMarkdownLinks('[Data](/d-meloper/dmelopers-block-pet/blob/main/docs/PRIVACY.md)', 'docs/SECURITY.md', documentationFiles), /canonical/)
  assert.throws(() => inspectMarkdownLinks('[Data](/docs/PRIVACY.md)', 'README.md', documentationFiles), /canonical/)
})

test('Markdown examples and application documentation are outside metadata link checks', () => {
  inspectMarkdownLinks('`[example](missing.md)`\n```markdown\n[example](missing.md)\n```\n' +
    '~~~markdown\n[example](missing.md)\n~~~\n[License](LICENSE)', 'README.md', documentationFiles)
  inspectMarkdownLinks('[Local source](missing.md)', 'app/vendor/README.md', documentationFiles)
})

test('tree check excludes only root Git metadata and detects file/inventory drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-pet-public-check-'))
  try {
    await mkdir(join(root, '.github')); await mkdir(join(root, 'app/src-tauri'), { recursive: true })
    const files = ['.github/public-files.json', 'app/package.json', 'app/src-tauri/tauri.conf.json']
    const inventory = join(root, files[0])
    await writeFile(inventory, JSON.stringify({ schemaVersion: 1, files }))
    await writeFile(join(root, files[1]), JSON.stringify({ name: 'dmelopers-block-pet', scripts: {} }))
    await writeFile(join(root, files[2]), JSON.stringify({ productName: "DMeloper's Block Pet", identifier: 'com.dmeloper.blockpet' }))
    await mkdir(join(root, '.git')); await writeFile(join(root, '.git/config'), secret)
    assert.equal(await checkTree(root), 3)
    await writeFile(join(root, 'extra.txt'), 'unreviewed')
    await assert.rejects(checkTree(root), /inventory/)
    await rm(join(root, 'extra.txt'))
    await writeFile(inventory, JSON.stringify({ schemaVersion: 1, files: [...files, files[1]] }))
    await assert.rejects(checkTree(root), /unique/)
    await writeFile(inventory, JSON.stringify({ schemaVersion: 1, files }))
    await mkdir(join(root, 'app/.git'))
    await assert.rejects(checkTree(root), /forbidden path/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('tree check rejects missing Markdown destinations even when the file inventory is exact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'block-pet-public-links-'))
  try {
    await mkdir(join(root, '.github')); await mkdir(join(root, 'app/src-tauri'), { recursive: true })
    const files = ['.github/public-files.json', 'README.md', 'app/package.json', 'app/src-tauri/tauri.conf.json']
    await writeFile(join(root, files[0]), JSON.stringify({ schemaVersion: 1, files }))
    await writeFile(join(root, files[1]), '[Missing](docs/SUPPORT.md)')
    await writeFile(join(root, files[2]), JSON.stringify({ name: 'dmelopers-block-pet', scripts: {} }))
    await writeFile(join(root, files[3]), JSON.stringify({ productName: "DMeloper's Block Pet", identifier: 'com.dmeloper.blockpet' }))
    await assert.rejects(checkTree(root), /Markdown target/)
    await writeFile(join(root, files[1]), '[External](https://example.com/help)')
    assert.equal(await checkTree(root), 4)
  } finally { await rm(root, { recursive: true, force: true }) }
})
