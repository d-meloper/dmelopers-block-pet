import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const metadataLimit = 1024 * 1024
const fileLimit = 16 * 1024 * 1024
const pngPaths = new Set([
  'assets/hero.png', 'app/public/logo.png', 'app/src-tauri/assets/tray.png', 'app/src-tauri/assets/models/dmeloper/default.png',
  'assets/install-warnings/백신 1.png',
  'assets/install-warnings/백신 2.png',
  'assets/install-warnings/스마트스크린.png',
  'assets/install-warnings/스마트스크린0.png',
  'assets/install-warnings/엣지0.png',
  'assets/install-warnings/엣지1.png',
  'assets/install-warnings/엣지2.png',
  'assets/install-warnings/en/edge-download-warning.png',
  'assets/install-warnings/en/edge-keep-anyway.png',
  'assets/install-warnings/en/edge-keep.png',
  'assets/install-warnings/en/smartscreen-more-info.png',
  'assets/install-warnings/en/smartscreen-run-anyway.png',
  'assets/install-warnings/en/v3-file-actions.png',
  'assets/install-warnings/en/v3-isolation-scan.png',
])
const glbPath = 'app/src-tauri/assets/models/dmeloper/dmeloper.glb'
const gifBlockLimit = 131072
const gifHeaders = [Buffer.from('GIF87a'), Buffer.from('GIF89a')]
const gifAssets = new Map([
  ['assets/features/input-mouse.gif', { sha256: '80a56ce10ce85718f2508dce729bc66eeafaa037203ae590982dbabe06810b84', bytes: 8182388, width: 640, height: 480, frames: 76 }],
  ['assets/features/input-keyboard.gif', { sha256: 'c1093f1f9814dc973902fdab1b1b711f93db1193201fff074e34a9ec2d57839b', bytes: 4986372, width: 640, height: 480, frames: 47 }],
  ['assets/features/skin-selection.gif', { sha256: '2fe26fe62d35a4ae7ffe42df977d4530ce2166de902c20eb96cd4e38cf6a6be8', bytes: 7293479, width: 640, height: 480, frames: 66 }],
  ['assets/features/pet-customization.gif', { sha256: '2261c379ebfa60ac0ca985389f77bb28faccb4bff62951fee99fc99197cc8f46', bytes: 7339596, width: 640, height: 480, frames: 65 }],
  ['assets/features/display-customization.gif', { sha256: '338828fbd25860a82f02b064b113c61c428d05fa8f5fb7da7699865cb8d101b9', bytes: 6629896, width: 640, height: 480, frames: 58 }],
  ['assets/features/object-customization.gif', { sha256: '55835c6555735d44347e60b53f889882496a8bfde711b59351cb58e364f52bff', bytes: 7885064, width: 640, height: 480, frames: 71 }],
  ['assets/features/presets.gif', { sha256: '890f340c8af432fa52b2952eee65808a221e801791773878646f4e9a4b920e7f', bytes: 13760171, width: 1200, height: 532, frames: 152 }],
])

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

export function inspectGif(bytes, path) {
  assert(bytes.length <= fileLimit && gifHeaders.some(header => bytes.subarray(0, 6).equals(header)), `invalid GIF header or size: ${path}`)
  let offset = 6, blocks = 0, frames = 0, metadataSize = 0, control = null
  function take(length) {
    assert(offset + length <= bytes.length, `truncated GIF: ${path}`)
    const value = bytes.subarray(offset, offset + length)
    offset += length
    return value
  }
  function inspect(data) {
    metadataSize += data.length
    assert(metadataSize <= metadataLimit, `GIF metadata limit: ${path}`)
    inspectText(data, path)
  }
  function subblocks(text = false) {
    const pieces = []
    let total = 0
    while (true) {
      assert(++blocks <= gifBlockLimit, `GIF block limit: ${path}`)
      const length = take(1)[0]
      if (!length) {
        if (text) inspect(Buffer.concat(pieces))
        return total
      }
      const value = take(length)
      total += length
      if (text) {
        assert(total + metadataSize <= metadataLimit, `GIF metadata limit: ${path}`)
        pieces.push(value)
      }
    }
  }
  const screen = take(7), width = screen.readUInt16LE(0), height = screen.readUInt16LE(2)
  assert(width && height && width * height <= 16 * 1024 * 1024, `invalid GIF canvas: ${path}`)
  const globalColors = screen[4] & 0x80 ? 1 << ((screen[4] & 7) + 1) : 0
  if (globalColors) { take(3 * globalColors); assert(screen[5] < globalColors, `invalid GIF background: ${path}`) }
  while (true) {
    assert(++blocks <= gifBlockLimit, `GIF block limit: ${path}`)
    const marker = take(1)[0]
    if (marker === 0x3b) {
      assert(offset === bytes.length && frames && control === null, `GIF trailer, trailing data or frames: ${path}`)
      return { width, height, frames }
    }
    if (marker === 0x2c) {
      const image = take(9), left = image.readUInt16LE(0), top = image.readUInt16LE(2)
      const frameWidth = image.readUInt16LE(4), frameHeight = image.readUInt16LE(6), flags = image[8]
      assert(frameWidth && frameHeight && left + frameWidth <= width && top + frameHeight <= height && !(flags & 0x18), `invalid GIF image bounds: ${path}`)
      const colors = flags & 0x80 ? 1 << ((flags & 7) + 1) : globalColors
      assert(colors, `GIF image palette missing: ${path}`)
      if (flags & 0x80) take(3 * colors)
      assert(control === null || !(control[0] & 1) || control[3] < colors, `invalid GIF transparency index: ${path}`)
      control = null
      const minimumCode = take(1)[0]
      assert(minimumCode >= 2 && minimumCode <= 8 && subblocks(), `invalid GIF LZW data: ${path}`)
      assert(++frames <= 1024, `GIF frame limit: ${path}`)
    } else if (marker === 0x21) {
      const kind = take(1)[0]
      if (kind === 0xf9) {
        assert(control === null && take(1)[0] === 4, `invalid GIF graphic control: ${path}`)
        control = take(4)
        assert(!(control[0] & 0xe0) && ((control[0] >> 2) & 7) <= 3 && take(1)[0] === 0, `invalid GIF graphic control: ${path}`)
        inspect(control)
      } else if (kind === 0xff) {
        assert(take(1)[0] === 11, `invalid GIF application header: ${path}`)
        inspect(take(11)); subblocks(true)
      } else if (kind === 0xfe) subblocks(true)
      else if (kind === 0x01) {
        assert(take(1)[0] === 12, `invalid GIF text header: ${path}`)
        const header = take(12)
        assert(globalColors && header.readUInt16LE(4) && header.readUInt16LE(6) && header[8] && header[9]
          && header.readUInt16LE(0) + header.readUInt16LE(4) <= width && header.readUInt16LE(2) + header.readUInt16LE(6) <= height
          && Math.max(header[10], header[11]) < globalColors, `invalid GIF text bounds or palette: ${path}`)
        control = null
        inspect(header); subblocks(true)
      } else assert.fail(`unknown GIF extension: ${path}`)
    } else assert.fail(`unknown GIF block: ${path}`)
  }
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
  if (path.toLowerCase().endsWith('.gif')) {
    assert(gifAssets.has(path), `unreviewed GIF: ${path}`)
    const expected = gifAssets.get(path), info = inspectGif(bytes, path)
    assert(bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256
      && Object.entries(info).every(([key, value]) => expected[key] === value), `reviewed GIF bytes or dimensions differ: ${path}`)
    return
  }
  assert(!gifHeaders.some(header => bytes.subarray(0, 6).equals(header)), `disguised GIF: ${path}`)
  inspectText(bytes, path)
  if (path.toLowerCase().endsWith('.png')) { assert(pngPaths.has(path), `unreviewed PNG: ${path}`); inspectPng(bytes, path) }
  else if (path.toLowerCase().endsWith('.glb')) { assert(path === glbPath, `unreviewed GLB: ${path}`); inspectGlb(bytes, path) }
  else assert(!bytes.subarray(0, 4).equals(Buffer.from('glTF')) && !bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])), `disguised asset: ${path}`)
}

export function inspectMarkdownLinks(text, path, files) {
  if (!path.endsWith('.md') || (path.includes('/') && !path.startsWith('docs/'))) return
  const inventory = new Set(files)
  const repository = 'https://github.com/d-meloper/dmelopers-block-pet/'
  const specialView = /^docs\/(?:CONTRIBUTING|SECURITY)(?:\.ko-KR)?\.md$/.test(path)
  // GitHub's repository tabs and security/policy render these files from the
  // repository root, even though ordinary file views retain their docs/ path.
  const prose = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g, '$1')
    .replace(/(`+)[^`]*?\1/g, '')
  const targets = []
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g))
    targets.push(match[1] ?? match[2])
  for (const match of prose.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))/gm))
    targets.push(match[1] ?? match[2])
  for (const match of prose.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi))
    targets.push(match[1])
  for (const target of targets) {
    if (target.startsWith('#')) continue
    let destination
    const repositoryTarget = target.startsWith(repository) ? target.slice(repository.length)
      : target.startsWith('/d-meloper/dmelopers-block-pet/') ? target.slice('/d-meloper/dmelopers-block-pet/'.length) : null
    if (repositoryTarget !== null) {
      if (!/^(?:blob|tree)\/main\//.test(repositoryTarget)) continue
      assert(!specialView || target.startsWith(repository + 'blob/main/'), `use canonical repository link: ${path}: ${target}`)
      destination = repositoryTarget.replace(/^(?:blob|tree)\/main\//, '')
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue
      assert(!specialView, `root-rendered document needs canonical repository link: ${path}: ${target}`)
      assert(!target.startsWith('/'), `use canonical repository link: ${path}: ${target}`)
      destination = posix.join(posix.dirname(path), target.split(/[?#]/)[0])
    }
    destination = posix.normalize(decodeURIComponent(destination.split(/[?#]/)[0])).replace(/\/$/, '')
    assert(inventory.has(destination) || [...inventory].some(file => file.startsWith(destination + '/')),
      `missing or wrong-case Markdown target: ${path}: ${target} -> ${destination}`)
  }
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
  for (const path of actual) {
    const bytes = await readFile(join(root, path))
    inspectFile(path, bytes)
    inspectMarkdownLinks(bytes.toString('utf8'), path, expected)
  }
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
