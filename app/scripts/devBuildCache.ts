import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { arch, env, platform, version } from 'node:process'

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export async function listBuildInputs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(entries.map(entry => entry.isDirectory()
    ? listBuildInputs(resolve(directory, entry.name))
    : [resolve(directory, entry.name)]))
  return children.flat().sort()
}

export async function buildFingerprint(inputs: string[]): Promise<string> {
  const paths = [...new Set(inputs.map(path => resolve(path)))].sort()
  const hashes = await Promise.all(paths.map(async path => [path, digest(await readFile(path))]))
  // Vite defaults an unset NODE_ENV to production while resolving build config.
  return digest(JSON.stringify({ version, platform, arch, nodeEnv: env.NODE_ENV ?? 'production', hashes }))
}

async function outputFingerprints(outputs: string[]) {
  return Promise.all(outputs.map(async path => ({ path: resolve(path), sha256: digest(await readFile(path)) })))
}

export async function buildCacheMatches(cachePath: string, inputFingerprint: string, outputs: string[]): Promise<boolean> {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    if (cached.schemaVersion !== 1 || cached.inputFingerprint !== inputFingerprint) return false
    if (!Array.isArray(cached.dependencies)
      || JSON.stringify(cached.dependencies) !== JSON.stringify(await outputFingerprints(cached.dependencies.map((item: { path: string }) => item.path)))) {
      return false
    }
    return JSON.stringify(cached.outputs) === JSON.stringify(await outputFingerprints(outputs))
  } catch {
    // Missing/corrupt metadata or output always rebuilds; timestamps are not proof.
    return false
  }
}

export async function saveBuildCache(cachePath: string, inputFingerprint: string, outputs: string[], dependencies: string[] = []) {
  const cache = { schemaVersion: 1, inputFingerprint, outputs: await outputFingerprints(outputs), dependencies: await outputFingerprints(dependencies) }
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, 'utf8')
    return true
  } catch {
    // Cache storage is optional; valid generated assets still allow development.
    return false
  }
}

export async function writeFileIfChanged(path: string, content: string | Uint8Array): Promise<boolean> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  try {
    if ((await readFile(path)).equals(bytes)) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(path, bytes)
  return true
}
