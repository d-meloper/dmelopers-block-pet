import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const metadataLimit = 1024 * 1024
const fileLimit = 16 * 1024 * 1024
const pngPaths = new Set(['assets/hero.png', 'app/public/logo.png', 'app/src-tauri/assets/tray.png', 'app/src-tauri/assets/models/dmeloper/default.png'])
const glbPath = 'app/src-tauri/assets/models/dmeloper/dmeloper.glb'

export function inspectText(bytes, path) {
  const forms = [bytes.toString('utf8')]
  if (bytes.includes(0) || bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    for (const offset of [0, 1]) {
      const even = bytes.subarray(offset, offset + Math.floor((bytes.length - offset) / 2) * 2)
      forms.push(even.toString('utf16le'), Buffer.from(even).swap16().toString('utf16le'))
    }
  }
  for (const text of forms) {
    assert(!/[A-Z]:[\\/]Users[\\/][^\r\n\\/]+[\\/]/i.test(text), `personal profile: ${path}`)
    assert(!/(?:\/Users\/|\/home\/)[^/\s]+\//.test(text), `personal profile: ${path}`)
    assert(!/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/i.test(text), `credential: ${path}`)
    assert(!/(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/i.test(text), `credential: ${path}`)
    assert(!/-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/.test(text), `private key: ${path}`)
  }
}

export function inspectPath(path) {
  assert(typeof path === 'string' && path && !path.includes('\\') && !path.includes(':') &&
    !path.startsWith('/') && !path.split('/').some(x => !x || x === '.' || x === '..'), `unsafe path: ${path}`)
  assert(!/(^|\/)(?:node_modules|target|dist|\.env[^/]*|\.git|\.harness|\.agents|\.codex|\.ssh|\.aws|\.azure|\.vscode|BlenderWork|_Development|logs|credentials|\.npmrc|\.netrc|\.git-credentials|id_rsa|id_ed25519)(\/|$)/i.test(path), `forbidden path: ${path}`)
  assert(!/\.(?:blend\d*|pfx|p12|pem|key|pdb|log|zip|7z|rar|gz|tar|exe|dll|msi|msix|msixbundle|appx|appxbundle|sig|db|sqlite\d*|dmp|obj|ilk|bak|tmp|map|pid|class|jar|wasm|so|dylib|lib|o|a)$/i.test(path), `forbidden file: ${path}`)
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function inspectPng(bytes, path) {
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `invalid PNG: ${path}`)
  let offset = 8, count = 0, metadataBytes = 0, ended = false
  function inspect(data) {
    metadataBytes += data.length
    assert(metadataBytes <= metadataLimit, `PNG metadata limit: ${path}`)
    inspectText(data, path)
  }
  function inflate(data) {
    const result = inflateSync(data, { maxOutputLength: metadataLimit + 1, info: true })
    assert(result.engine.bytesWritten === data.length, `PNG compressed trailing data: ${path}`)
    return result.buffer
  }
  while (offset < bytes.length) {
    assert(++count <= 1024 && offset + 12 <= bytes.length, `invalid PNG chunks: ${path}`)
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length
    assert(end <= bytes.length, `truncated PNG: ${path}`)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, end - 4)
    assert(crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), `PNG CRC: ${path}`)
    assert(count !== 1 || (type === 'IHDR' && length === 13), `PNG header: ${path}`)
    if (type === 'zTXt' || type === 'iCCP') {
      const zero = data.indexOf(0)
      assert(zero > 0 && zero <= 79 && data[zero + 1] === 0, `PNG compression header: ${path}`)
      inspect(data.subarray(0, zero))
      inspect(inflate(data.subarray(zero + 2)))
    } else if (type === 'iTXt') {
      const zero = data.indexOf(0)
      assert(zero > 0 && zero <= 79 && [0, 1].includes(data[zero + 1]) && data[zero + 2] === 0, `PNG text header: ${path}`)
      const languageEnd = data.indexOf(0, zero + 3), translatedEnd = data.indexOf(0, languageEnd + 1)
      assert(languageEnd >= zero + 3 && translatedEnd >= languageEnd + 1, `PNG text fields: ${path}`)
      inspect(data.subarray(0, translatedEnd))
      const text = data.subarray(translatedEnd + 1)
      inspect(data[zero + 1] ? inflate(text) : text)
    } else if (type !== 'IDAT') {
      inspect(data)
    }
    offset = end
    if (type === 'IEND') { assert(length === 0 && offset === bytes.length, `PNG trailing data: ${path}`); ended = true; break }
  }
  assert(ended, `PNG end missing: ${path}`)
}

export function inspectGlb(bytes, path) {
  assert(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF' &&
    bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, `invalid GLB: ${path}`)
  let offset = 12, document, count = 0
  while (offset < bytes.length) {
    assert(++count <= 16 && offset + 8 <= bytes.length, `invalid GLB chunks: ${path}`)
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4)
    offset += 8
    assert(length % 4 === 0 && offset + length <= bytes.length, `truncated GLB: ${path}`)
    if (type === 0x4e4f534a) {
      assert(document === undefined && count === 1 && length <= metadataLimit, `GLB JSON limit/order: ${path}`)
      document = JSON.parse(bytes.toString('utf8', offset, offset + length).trim())
    } else assert(type === 0x004e4942, `unknown GLB chunk: ${path}`)
    offset += length
  }
  assert(document && !Array.isArray(document) && typeof document === 'object', `GLB JSON missing: ${path}`)
  // JSON escapes must be decoded before inspecting values and object keys.
  const pending = [document]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') inspectText(Buffer.from(value), path)
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { inspectText(Buffer.from(key), path); pending.push(child) }
    }
  }
}

export function inspectFile(path, bytes) {
  inspectPath(path)
  assert(bytes.length <= fileLimit, `file size limit: ${path}`)
  const forbiddenMagic = ['4d5a', '7f454c46', '504b0304', '504b0506', '504b0708', '377abcaf271c', '526172211a07', '1f8b', '53514c69746520666f726d6174203300', 'd0cf11e0a1b11ae1', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', '0061736d', '213c617263683e0a']
  assert(!forbiddenMagic.some(hex => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'))), `forbidden binary: ${path}`)
  inspectText(bytes, path)
  if (path.toLowerCase().endsWith('.png')) { assert(pngPaths.has(path), `unreviewed PNG: ${path}`); inspectPng(bytes, path) }
  else if (path.toLowerCase().endsWith('.glb')) { assert(path === glbPath, `unreviewed GLB: ${path}`); inspectGlb(bytes, path) }
  else assert(!bytes.subarray(0, 4).equals(Buffer.from('glTF')) && !bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])), `disguised asset: ${path}`)
}

export async function checkTree(root = '.') {
  const inventory = JSON.parse(await readFile(join(root, '.github/public-files.json'), 'utf8'))
  const expected = inventory.files
  assert(inventory.schemaVersion === 1 && Array.isArray(expected) && expected.every(x => typeof x === 'string'), 'invalid public inventory')
  assert.deepEqual(expected, [...new Set(expected)].sort(), 'inventory must be sorted and unique')
  expected.forEach(inspectPath)
  const actual = []
  async function visit(directory = '') {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!directory && entry.name === '.git') continue
      const path = directory ? `${directory}/${entry.name}` : entry.name
      inspectPath(path)
      const stat = await lstat(join(root, path))
      assert(!stat.isSymbolicLink(), `link: ${path}`)
      if (stat.isDirectory()) await visit(path)
      else { assert(stat.isFile() && stat.size <= fileLimit, `non-file or file size limit: ${path}`); actual.push(path) }
    }
  }
  await visit()
  assert.deepEqual(actual.sort(), expected, 'public file inventory changed')
  for (const path of actual) inspectFile(path, await readFile(join(root, path)))
  const manifest = JSON.parse(await readFile(join(root, 'app/package.json'), 'utf8'))
  assert.equal(manifest.name, 'dmelopers-block-pet')
  assert(!manifest.scripts['distribution:audit'] && !manifest.scripts['distribution:gate'])
  const config = JSON.parse(await readFile(join(root, 'app/src-tauri/tauri.conf.json'), 'utf8'))
  assert.equal(config.productName, "DMeloper's Block Pet")
  assert.equal(config.identifier, 'com.dmeloper.blockpet')
  return actual.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`Verified ${await checkTree()} public files`)
