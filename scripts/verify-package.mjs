#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_FILES = Object.freeze([
  'lib/index.js',
  'lib/index.js.map',
  'lib/client.js',
  'lib/client.js.map',
  'cordis.patch.yml',
  'scripts/feishu-relay.mjs',
  'scripts/feishu-relay.config.example.json',
  'assets/icon-180.png',
  'assets/icon-512.png',
  'package.json',
  'README.md',
  'LICENSE',
])

/** Validate npm pack --json output against the checkout and release identity. */
export function verifyPackage({ manifest, pack, repository, tag }) {
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Expected repository must be an owner/repository pair')
  }
  const repositoryUrl = typeof manifest?.repository === 'string'
    ? manifest.repository
    : manifest?.repository?.url
  const allowedUrls = [
    `https://github.com/${repository}`,
    `https://github.com/${repository}.git`,
    `git+https://github.com/${repository}.git`,
  ]
  if (!allowedUrls.includes(repositoryUrl)) {
    throw new Error(`Package repository must match https://github.com/${repository}`)
  }
  if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('Package name and version are required')
  }
  if (tag !== undefined && tag !== `v${manifest.version}`) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must equal v${manifest.version}`)
  }
  if (!Array.isArray(pack) || pack.length !== 1) {
    throw new Error('Expected exactly one npm pack result')
  }
  const entry = pack[0]
  if (entry?.name !== manifest.name || entry?.version !== manifest.version) {
    throw new Error('Packed package name/version must match package.json')
  }
  if (typeof entry.filename !== 'string' || !/^[\w.-]+\.tgz$/.test(entry.filename)) {
    throw new Error('Packed filename must be a plain .tgz basename')
  }
  if (!Array.isArray(entry.files)) throw new Error('Packed file list is required')
  const seen = new Set()
  for (const file of entry.files) {
    if (!REQUIRED_FILES.includes(file?.path)) {
      throw new Error(`Unexpected packed file: ${JSON.stringify(file?.path)}`)
    }
    if (seen.has(file.path)) throw new Error(`Duplicate packed file: ${file.path}`)
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`Packed file must be nonempty: ${file.path}`)
    }
    seen.add(file.path)
  }
  const missing = REQUIRED_FILES.filter((path) => !seen.has(path))
  if (missing.length) throw new Error(`Missing packed files: ${missing.join(', ')}`)
  return { filename: entry.filename, name: entry.name, version: entry.version, fileCount: seen.size }
}

function main(args) {
  const options = {}
  const accepted = new Set(['--pack-json', '--package-json', '--repository', '--tag'])
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i]
    if (!accepted.has(option) || Object.hasOwn(options, option) || args[i + 1] === undefined) {
      throw new Error('Usage: node scripts/verify-package.mjs [--pack-json FILE] [--repository OWNER/REPO] [--package-json FILE] [--tag vVERSION]')
    }
    options[option] = args[i + 1]
  }
  const manifest = JSON.parse(readFileSync(options['--package-json'] ?? 'package.json', 'utf8'))
  const packText = options['--pack-json']
    ? readFileSync(options['--pack-json'], 'utf8')
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' })
  const result = verifyPackage({
    manifest,
    pack: JSON.parse(packText),
    repository: options['--repository'] ?? 'lolkda/dsh-meow-smooth',
    tag: options['--tag'],
  })
  console.log(`Verified ${result.name}@${result.version}: ${result.fileCount} files in ${result.filename}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`Package verification failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
