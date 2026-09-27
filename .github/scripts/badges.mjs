import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const repository = 'd-meloper/dmelopers-block-pet'
const repositoryId = 1390031914
const profiles = Object.freeze({
  official: { repository, repositoryId },
  test: { repository: 'oup030416/dmelopers-block-pet-test', repositoryId: 1390032052 },
})
function source(profile) {
  assert(Object.hasOwn(profiles, profile), 'unsupported badge profile')
  return profiles[profile]
}
const allowed = ['badge-data.json', 'downloads.svg', 'license.svg', 'release.svg', 'stars.svg']
const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const maxVersionPart = 18446744073709551615n

function versionParts(tag) {
  if (typeof tag !== 'string' || tag.length > 63 || !versionPattern.test(tag)) return null
  const parts = tag.slice(1).split('.').map(BigInt)
  return parts.every(part => part <= maxVersionPart) ? parts : null
}

function isStable(release) {
  return release.draft === false && release.prerelease === false && versionParts(release.tag_name) !== null
}

function timestamp(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value), 'invalid UTC timestamp')
  const time = new Date(value)
  assert(Number.isFinite(time.valueOf()) && time.valueOf() >= 0 &&
    time.toISOString().replace('.000Z', 'Z') === value, 'invalid UTC timestamp')
  return time.valueOf()
}

function verifiedAsset(release, name) {
  const matching = release.assets.filter(asset => asset.name === name)
  assert.equal(matching.length, 1, `missing or duplicate asset: ${name}`)
  const asset = matching[0]
  assert.equal(asset.state, 'uploaded', `incomplete asset: ${name}`)
  assert(Number.isSafeInteger(asset.size) && asset.size > 0, `invalid asset size: ${name}`)
  assert(typeof asset.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/.test(asset.digest), `invalid asset digest: ${name}`)
  assert(typeof release.body === 'string', 'missing Release notes')
  const checksums = release.body.split(/\r?\n/).map(line => /^SHA256[ \t]+(\S+)[ \t]+(.+?)\s*$/.exec(line))
    .filter(match => match && match[2] === name)
  assert.equal(checksums.length, 1, `missing or duplicate Release checksum: ${name}`)
  assert(/^[a-fA-F0-9]{64}$/.test(checksums[0][1]), `invalid Release checksum: ${name}`)
  const sha256 = asset.digest.slice('sha256:'.length).toLowerCase()
  assert.equal(checksums[0][1].toLowerCase(), sha256, `Release checksum differs from asset digest: ${name}`)
  return { name, size: asset.size, sha256 }
}

export function payload(repo, releases, verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), profile = 'official') {
  const { repository, repositoryId } = source(profile)
  assert.equal(repo.full_name, repository)
  assert.equal(repo.id, repositoryId)
  assert.equal(repo.private, false)
  assert.equal(repo.visibility, 'public')
  const verifiedTime = timestamp(verifiedAt)
  assert(Array.isArray(releases))
  const stable = releases.filter(isStable)
  assert.equal(new Set(stable.map(release => release.tag_name)).size, stable.length, 'duplicate stable tag')
  stable.sort((a, b) => {
    const av = versionParts(a.tag_name)
    const bv = versionParts(b.tag_name)
    for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? -1 : 1
    return 0
  })
  let downloads = 0
  for (const release of stable) {
    assert(Array.isArray(release.assets))
    const expected = `dmelopers-block-pet_${release.tag_name.slice(1)}_x64-setup.exe`
    const assets = release.assets.filter(a => a.name === expected && a.state === 'uploaded')
    assert(assets.length <= 1, 'duplicate installer identity')
    for (const asset of assets) {
      assert(Number.isSafeInteger(asset.download_count) && asset.download_count >= 0)
      downloads += asset.download_count
      assert(Number.isSafeInteger(downloads))
    }
  }
  assert(Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= 0)
  let latest = null
  if (stable.length) {
    const release = stable[0]
    assert(timestamp(release.published_at) <= verifiedTime, 'Release published after feed verification')
    const version = release.tag_name.slice(1)
    const name = `dmelopers-block-pet_${version}_x64-setup.exe`
    latest = { version, tag: release.tag_name, platform: 'windows-x86_64',
      installer: verifiedAsset(release, name), signature: verifiedAsset(release, `${name}.sig`),
      publishedAt: release.published_at }
  }
  return { schemaVersion: 2, repository, repositoryId, visibility: 'public',
    release: stable[0]?.tag_name ?? 'not released', downloads, stars: repo.stargazers_count, license: 'MIT',
    verifiedAt, latest }
}

function count(value) {
  return value >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}K` : `${value}`
}

export function svg(label, message, left, right) {
  assert(/^[A-Z0-9 _-]+$/.test(label) && /^[A-Za-z0-9 ._+-]+$/.test(message))
  const lw = Math.max(54, label.length * 8.4 + 18)
  const rw = Math.max(40.5, message.length * 8.4 + 18)
  const n = x => +x.toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(lw + rw)}" height="28" role="img" aria-label="${label}: ${message}">
<title>${label}: ${message}</title>
<g shape-rendering="crispEdges"><rect width="${n(lw)}" height="28" fill="#${left}"/><rect x="${n(lw)}" width="${n(rw)}" height="28" fill="#${right}"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100">
<text transform="scale(.1)" x="${n(lw * 5)}" y="175" textLength="${label.length * 70}">${label}</text>
<text transform="scale(.1)" x="${n((lw + rw / 2) * 10)}" y="175" textLength="${message.length * 70}" font-weight="bold" fill="#333">${message}</text>
</g></svg>\n`
}

export function files(data) {
  return {
    'badge-data.json': JSON.stringify(data, null, 2) + '\n',
    'release.svg': svg('RELEASE', data.release, '2F334D', '9FE870'),
    'downloads.svg': svg('DOWNLOADS', count(data.downloads), '4A4F63', 'FFB07C'),
    'stars.svg': svg('STARS', count(data.stars), '2F334D', 'C6C4FF'),
    'license.svg': svg('LICENSE', 'MIT', '2F334D', 'C6C4FF'),
  }
}

async function api(path, method = 'GET', body, profile = 'official') {
  const { repository } = source(profile)
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${response.status}`)
  return response.json()
}

async function allPages(path, request) {
  const records = []
  const ids = new Set()
  for (let page = 1; ; page++) {
    const next = await request(`${path}?per_page=100&page=${page}`)
    assert(Array.isArray(next) && next.length <= 100, 'invalid GitHub page')
    for (const record of next) {
      assert(Number.isSafeInteger(record.id) && record.id > 0 && !ids.has(record.id), 'invalid or repeated GitHub object')
      ids.add(record.id)
      records.push(record)
    }
    if (next.length < 100) return records
  }
}

export async function allReleases(request = api) {
  const releases = await allPages('releases', request)
  // Embedded assets can be truncated. Enumerate the asset endpoint for each
  // stable release used by either the download count or latest-version record.
  for (const release of releases.filter(isStable)) {
    release.assets = await allPages(`releases/${release.id}/assets`, request)
  }
  return releases
}

export async function publish(output, request, profile = 'official') {
  const { repository } = source(profile)
  request ??= (path, method, body) => api(path, method, body, profile)
  assert.deepEqual(Object.keys(output).sort(), allowed, 'unexpected badge output files')
  assert(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_REF === 'refs/heads/main')
  assert(process.env.GH_TOKEN, 'GitHub App installation token required')
  // The protected branch is provisioned separately. Missing refs fail closed.
  const ref = await request('git/ref/heads/badges')
  const base = await request(`git/commits/${ref.object.sha}`)
  const old = await request(`git/trees/${base.tree.sha}?recursive=1`)
  assert(!old.truncated && new Set(old.tree.map(f => f.path)).size === old.tree.length &&
    old.tree.every(f => f.type === 'blob' && f.mode === '100644' && allowed.includes(f.path)))
  const entries = []
  let changed = old.tree.length !== allowed.length
  for (const [path, content] of Object.entries(output)) {
    const blob = await request('git/blobs', 'POST', { content, encoding: 'utf-8' })
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    changed ||= old.tree.find(f => f.path === path)?.sha !== blob.sha
  }
  if (!changed) return
  const tree = await request('git/trees', 'POST', { tree: entries })
  const commit = await request('git/commits', 'POST', { message: 'Update public badges', tree: tree.sha, parents: [ref.object.sha] })
  await request('git/refs/heads/badges', 'PATCH', { sha: commit.sha, force: false })
  assert.equal((await request('git/ref/heads/badges')).object.sha, commit.sha)
}

export async function main(args = process.argv.slice(2), request) {
  const profileIndex = args.indexOf('--profile')
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'official'
  source(profile)
  request ??= (path, method, body) => api(path, method, body, profile)
  const fixture = args.indexOf('--fixture')
  assert(!(args.includes('--publish') && fixture >= 0), 'fixture cannot publish')
  const input = fixture >= 0 ? JSON.parse(await readFile(args[fixture + 1], 'utf8')) : {
    repository: await request(''), releases: await allReleases(request),
  }
  const output = files(payload(input.repository, input.releases, input.verifiedAt, profile))
  if (args.includes('--publish')) {
    await publish(output, request, profile)
  } else {
    const index = args.indexOf('--output')
    assert(index >= 0, '--output required without --publish')
    await mkdir(args[index + 1], { recursive: true })
    for (const [name, content] of Object.entries(output)) await writeFile(`${args[index + 1]}/${name}`, content)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
