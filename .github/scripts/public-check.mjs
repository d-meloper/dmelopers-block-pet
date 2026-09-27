import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function main() {
const inventory = JSON.parse(await readFile('.github/public-files.json', 'utf8'))
const expected = inventory.files
const actual = []
async function visit(directory = '.') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`
    assert(!(await lstat(path)).isSymbolicLink(), `link: ${path}`)
    if (entry.isDirectory()) await visit(path)
    else actual.push(path)
  }
}
await visit()
assert.deepEqual(actual.sort(), expected, 'public file inventory changed')
for (const path of actual) {
  assert(!/(^|\/)(?:node_modules|target|dist|\.env[^/]*|\.harness|\.agents|BlenderWork)(\/|$)/i.test(path))
  const bytes = await readFile(path)
  assert(!/\.(?:blend\d*|pfx|pem|key|pdb|log|zip|exe)$/i.test(path), `forbidden file: ${path}`)
  for (const content of [bytes.toString('utf8'), bytes.toString('utf16le')]) {
    assert(!/[A-Z]:[\\/]Users[\\/][^\r\n\\/]+[\\/]/i.test(content), `personal profile: ${path}`)
    assert(!/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/.test(content), `credential: ${path}`)
    assert(!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(content), `private key: ${path}`)
  }
}
const manifest = JSON.parse(await readFile('app/package.json', 'utf8'))
assert.equal(manifest.name, 'dmelopers-block-pet')
assert(!manifest.scripts['distribution:audit'] && !manifest.scripts['distribution:gate'])
const config = JSON.parse(await readFile('app/src-tauri/tauri.conf.json', 'utf8'))
assert.equal(config.productName, "DMeloper's Block Pet")
assert.equal(config.identifier, 'com.dmeloper.blockpet')
console.log(`Verified ${actual.length} public files`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
