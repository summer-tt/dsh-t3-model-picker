import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import vm from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const namespace = 't3-model-picker'
const legacyKey = 'dsh.t3-model-picker.favorites.v1'
const local = { serverId: null, provider: 'magpie', model: 'model-a' }
const remote = { serverId: '1234abcd', provider: 'magpie', model: 'model-a' }
const existing = { serverId: null, provider: 'magpie', model: 'model-b' }
let revision = 0
let entries = [existing]
let failure
let imports = []
const watchers = new Set()
const section = () => ({ ns: namespace, revision, applies: 'live', value: { favorites: entries, legacyFavoriteImports: imports } })
const update = (next) => {
  entries = next
  revision += 1
  for (const watch of watchers) watch(namespace)
}
const ok = value => ({ ok: true, value })

function openClient(legacy, { storage = new Map(), preserveLegacy = false } = {}) {
  if (legacy !== undefined) storage.set(legacyKey, JSON.stringify(legacy))
  const handlers = new Map()
  let definition
  vm.runInNewContext(client, {
    window: {
      __ModuleLoader__: { load(value) { definition = value } },
      addEventListener() {},
      removeEventListener() {},
      localStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => { if (!preserveLegacy) storage.delete(key) } },
    },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    console, AbortController,
  })
  const cleanups = []
  let favorites
  let notices
  const settings = {
    async describe() { return ok({ writable: true, namespaces: [section()] }) },
    async update(ns, patch, expectedRevision) {
      assert.equal(ns, namespace)
      assert.ok(patch.favorites.every(entry => !entry.provider.startsWith('zr~')))
      if (failure !== undefined) return { ok: false, error: failure }
      if (expectedRevision !== revision) return { ok: false, error: { code: 'settings/conflict', message: 'Stale revision' } }
      if (patch.legacyFavoriteImports !== undefined) imports = structuredClone(patch.legacyFavoriteImports)
      update(structuredClone(patch.favorites))
      return ok(section())
    },
  }
  const ctx = {
    effect(run) { cleanups.push(run()) },
    inject(keys, run) { if (keys.includes('remote.settings')) run(ctx) },
    locale: { register() {} },
    on(event, listener) { handlers.set(event, listener) },
    remote: {
      settings,
      session: { async modelCatalog() { return ok({ routableProviders: [] }) } },
      $on(event, listener) {
        if (event === 'settings/document-updated') {
          watchers.add(listener)
          cleanups.push(() => watchers.delete(listener))
        }
      },
    },
    slots: {
      inject(_name, run) { run() },
      register(options) {
        if (options.name === 'conversation.input.model') favorites = options.inject('session').favorites
        if (options.name === 'shell.overlay') notices = options.inject().notices
      },
    },
    modelDirectories: { directoryFor: () => ({ store: {} }) },
    sessions: { subagentAddress() {} },
  }
  definition.factory(() => ({})).apply(ctx)
  return {
    favorites, notices, storage,
    reconnect() { handlers.get('connection/reset')() },
    close() { for (const cleanup of cleanups.reverse()) cleanup?.() },
  }
}

const first = openClient([
  { provider: local.provider, model: local.model },
  { provider: 'zr~1234abcd~magpie', model: remote.model },
  { provider: local.provider, model: local.model },
])
const second = openClient()
const snapshot = client => structuredClone(client.favorites.getSnapshot().entries)
await setImmediate()
assert.deepEqual(entries, [existing, local, remote])
assert.deepEqual(snapshot(first), entries)
assert.deepEqual(snapshot(second), entries)
assert.equal(first.storage.has(legacyKey), false)

first.favorites.toggle('magpie', local.model, false)
second.favorites.toggle('zr~1234abcd~magpie', 'model-c', true)
await setImmediate()
assert.deepEqual(entries, [existing, remote, { ...remote, model: 'model-c' }])
assert.deepEqual(snapshot(first), entries)
assert.deepEqual(snapshot(second), entries)

failure = { code: 'settings/rejected', message: 'Read only' }
first.favorites.toggle('magpie', 'model-d', true)
const importing = openClient([{ provider: 'magpie', model: 'model-e' }])
await setImmediate()
assert.equal(first.notices.getSnapshot().error.message, 'Read only')
assert.equal(importing.favorites.getSnapshot().error.message, 'Read only')
assert.equal(importing.storage.has(legacyKey), true)
assert.deepEqual(snapshot(first), entries)

failure = undefined
importing.favorites.refresh()
await setImmediate()
assert.equal(importing.storage.has(legacyKey), false)
assert.deepEqual(entries.at(-1), { ...local, model: 'model-e' })
assert.deepEqual(snapshot(second), entries)
const shared = new Map()
const sameOrigin = openClient([{ provider: 'magpie', model: 'model-f' }], { storage: shared, preserveLegacy: true })
await setImmediate()
assert.equal(shared.has(legacyKey), true)
second.favorites.toggle('magpie', 'model-f', false)
await setImmediate()
assert.equal(entries.some(entry => entry.model === 'model-f'), false)
const otherTab = openClient(undefined, { storage: shared })
await setImmediate()
assert.equal(entries.some(entry => entry.model === 'model-f'), false)
assert.equal(shared.has(legacyKey), false)

first.favorites.toggle('magpie', 'interrupted', true)
first.reconnect()
await setImmediate()
assert.equal(first.notices.getSnapshot().key, 'error.favoritesInterrupted')
assert.equal(entries.some(entry => entry.model === 'interrupted'), false)
for (const client of [first, second, importing, sameOrigin, otherTab]) client.close()
assert.equal(watchers.size, 0)
console.log('Profile favorites migrate, synchronize, merge concurrent edits, and retain legacy data on failure.')
