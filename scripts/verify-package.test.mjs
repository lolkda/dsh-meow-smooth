import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { REQUIRED_FILES, verifyPackage } from './verify-package.mjs'

function fixture() {
  return {
    repository: 'lolkda/dsh-meow-smooth',
    manifest: {
      name: '@lolkda/meow-smooth',
      version: '0.8.3',
      repository: { type: 'git', url: 'git+https://github.com/lolkda/dsh-meow-smooth.git' },
    },
    pack: [{
      name: '@lolkda/meow-smooth',
      version: '0.8.3',
      filename: 'lolkda-meow-smooth-0.8.3.tgz',
      files: REQUIRED_FILES.map((path) => ({ path, size: 100 })),
    }],
  }
}

test('accepts the complete package and a matching release tag', () => {
  assert.deepEqual(verifyPackage({ ...fixture(), tag: 'v0.8.3' }), {
    filename: 'lolkda-meow-smooth-0.8.3.tgz', name: '@lolkda/meow-smooth', version: '0.8.3', fileCount: 12,
  })
})

test('accepts non-release validation without a tag', () => {
  assert.equal(verifyPackage(fixture()).fileCount, 12)
})

for (const missing of REQUIRED_FILES) {
  test(`rejects missing ${missing}`, () => {
    const input = fixture()
    input.pack[0].files = input.pack[0].files.filter((file) => file.path !== missing)
    assert.throws(() => verifyPackage(input), /Missing packed files/)
  })
}

for (const unexpected of [
  'artifacts/report.json', 'scripts/feishu-relay.config.json', 'node_modules/foo/index.js',
  'tests/private.mjs', 'src/client.ts', '.npmrc', '../secret', 'lib/extra.js',
]) {
  test(`rejects unexpected ${unexpected}`, () => {
    const input = fixture()
    input.pack[0].files.push({ path: unexpected, size: 100 })
    assert.throws(() => verifyPackage(input), /Unexpected packed file/)
  })
}

test('rejects an upstream or otherwise mismatched repository', () => {
  const input = fixture()
  input.manifest.repository.url = 'git+https://github.com/Phant0Meow/dsh-meow-smooth.git'
  assert.throws(() => verifyPackage(input), /Package repository must match/)
})

for (const tag of ['v0.8.2', '0.8.3', 'v0.8.3-extra', '']) {
  test(`rejects mismatched tag ${JSON.stringify(tag)}`, () => {
    assert.throws(() => verifyPackage({ ...fixture(), tag }), /Release tag/)
  })
}

test('rejects mismatched packed identity', () => {
  for (const property of ['name', 'version']) {
    const input = fixture()
    input.pack[0][property] = 'different'
    assert.throws(() => verifyPackage(input), /name\/version must match/)
  }
})

test('rejects duplicate and empty files', () => {
  const duplicate = fixture()
  duplicate.pack[0].files.push(duplicate.pack[0].files[0])
  assert.throws(() => verifyPackage(duplicate), /Duplicate packed file/)
  const empty = fixture()
  empty.pack[0].files[0].size = 0
  assert.throws(() => verifyPackage(empty), /must be nonempty/)
})

test('rejects malformed or multiple pack results', () => {
  for (const pack of [null, {}, [], [...fixture().pack, ...fixture().pack]]) {
    assert.throws(() => verifyPackage({ ...fixture(), pack }), /exactly one/)
  }
})

test('rejects archive paths outside the artifact directory', () => {
  const input = fixture()
  input.pack[0].filename = '../other.tgz'
  assert.throws(() => verifyPackage(input), /plain .tgz basename/)
})

test('CLI rejects invalid input with a nonzero exit code without invoking npm', () => {
  const script = fileURLToPath(new URL('./verify-package.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--not-an-option', 'value'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Package verification failed: Usage:/)
})
