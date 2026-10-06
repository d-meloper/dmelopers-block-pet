import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { inspectFile, inspectText, inspectPng, inspectGlb, checkTree } from './public-check.mjs'

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
