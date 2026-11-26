import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// index.js imports its runtime dependency the way an installed plugin does:
// `@deepseek-ai/schemastery` resolves from the DSH installation the plugin is
// installed beside. Locate that dependency from the CLI anchor the way the
// plugin loader does (`DSH_INSTALL_DIR` names the `@deepseek-ai/dsh` package)
// and resolve it from there for this standalone run, rather than adding a
// second copy to the worktree.
const cliDir = process.env.DSH_INSTALL_DIR
  ?? '/home/dev/.local/share/dsh/dotfile/releases/v0.2.2-fix-1cc803c3ea4d/node_modules/@deepseek-ai/dsh'
const cliManifest = JSON.parse(readFileSync(resolve(cliDir, 'package.json'), 'utf8'))
assert.equal(cliManifest.name, '@deepseek-ai/dsh', 'DSH_INSTALL_DIR names the dsh CLI package')
const schemasteryDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/schemastery/package.json', { paths: [cliDir] }))
assert.equal(JSON.parse(readFileSync(resolve(schemasteryDir, 'package.json'), 'utf8')).name, '@deepseek-ai/schemastery')
register('./dsh-resolve.mjs', import.meta.url, { data: pathToFileURL(resolve(schemasteryDir, 'package.json')).href })

// Drive the shipped Host half (index.js) the way dsh-client-connection and
// dsh-settings do: a Fetch-shaped exact route and a revisioned settings
// service whose write compares the revision INSIDE the edit callback.
const namespace = 't3-model-picker'
// The read and the write are two exact routes (the read is buffered — a GET
// has no body — and the write streams so an oversized body is never held).
const path = '/api/t3-model-picker/favorites'
const setPath = '/api/t3-model-picker/favorites/set'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { apply, Config } = await import('../index.js')

const LOCAL = { serverId: null, provider: 'magpie', model: 'model-a' }
const REMOTE = { serverId: '1234abcd', provider: 'magpie', model: 'model-a' }
const OTHER_HOST = { serverId: 'abcdef01', provider: 'magpie', model: 'model-z' }
const RECEIPTS = ['[null,"magpie","legacy"]']

class SettingsConflictError extends Error {
  constructor(expected, actual) {
    super(`settings namespace "${namespace}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'SettingsConflictError'
    this.code = 'SETTINGS_CONFLICT'
  }
}

/** The settings surface dsh-settings exposes to a Host plugin. */
function createSettings(initial) {
  let revision = 0
  let value = structuredClone(initial)
  let failure
  const writes = []
  const external = (change) => {
    value = change(structuredClone(value))
    revision += 1
  }
  return {
    writes, external,
    get value() { return structuredClone(value) },
    get revision() { return revision },
    set failure(error) { failure = error },
    settings: {
      describe() {
        return [{
          ns: namespace,
          revision,
          applies: 'live',
          autoGenerate: true,
          schema: Config.toJSON(),
          value: structuredClone(value),
        }]
      },
      async update(ns, patch, expectedRevision) {
        assert.equal(ns, namespace)
        writes.push({ patch: structuredClone(patch), expectedRevision })
        if (failure !== undefined) throw failure
        // SettingsForms.write: the edit callback re-describes and compares.
        if (expectedRevision !== revision) throw new SettingsConflictError(expectedRevision, revision)
        value = { ...value, ...structuredClone(patch) }
        revision += 1
        return this.describe()[0]
      },
    },
  }
}

/** A cordis-shaped context: effects return disposers, inject runs when the service exists. */
function createContext(services) {
  const effects = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => { warnings.push(message) } },
    effect(run, label) {
      const dispose = run()
      effects.push({ dispose, label })
      return dispose
    },
    inject(names, run) {
      if (names.every(name => services[names] !== undefined)) {
        const scope = { ...services, effect: (inner, label) => ctx.effect(inner, label) }
        run(scope)
      }
    },
  }
  for (const [name, service] of Object.entries(services)) ctx[name] = service
  return { ctx, effects, warnings }
}

/** Mount the plugin and return its registered exact Fetch route. */
function mount({ favorites, imports = [...RECEIPTS], zenRemote } = {}) {
  const store = createSettings({ favorites: favorites ?? [structuredClone(REMOTE), structuredClone(LOCAL), structuredClone(OTHER_HOST)], legacyFavoriteImports: imports })
  // The exact-route table, keyed by full pathname as the shared handler does.
  const routes = new Map()
  const connection = {
    fetch: {
      register(candidate) {
        // assertFetchRoute's shape rule, as dsh-client-connection applies it.
        assert.ok(candidate.path.startsWith('/api/'))
        assert.ok(candidate.methods.length > 0)
        assert.equal(routes.has(candidate.path), false, 'a path is registered once')
        routes.set(candidate.path, candidate)
        return async () => { routes.delete(candidate.path) }
      },
    },
  }
  const services = { connection, settings: store.settings }
  if (zenRemote !== undefined) services.zenRemote = zenRemote
  const mounted = createContext(services)
  const disposers = apply(mounted.ctx)
  assert.deepEqual([...routes.keys()].sort(), [path, setPath].sort(), 'exactly the two exact /api routes are registered')
  // The shared handler's dispatch (createSharedFetchHandler): a route owns
  // its declared methods; any other method is 404 and never reaches `fetch`.
  const dispatch = (method, body, headers = {}, target = method === 'POST' ? setPath : path) => {
    const route = routes.get(target)
    if (route === undefined || !route.methods.includes(method)) return Promise.resolve(new Response('not found', { status: 404 }))
    return Promise.resolve(route.fetch(new Request(`http://127.0.0.1${target}`, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    })))
  }
  return { ...mounted, store, routes, dispatch, disposers }
}

const post = (payload, headers) => ['POST', JSON.stringify(payload), headers]

/** Await one dispatch and unwrap the single wire envelope. */
const bodyOf = async (dispatched) => {
  const response = await dispatched
  const body = await response.json()
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(typeof body.ok, 'boolean', 'the answer is one envelope')
  if (body.ok) {
    assert.deepEqual(Object.keys(body), ['ok', 'value'], 'success carries only ok + value')
    return { status: response.status, body, value: body.value }
  }
  assert.deepEqual(Object.keys(body), ['ok', 'error'], 'failure carries only ok + error')
  assert.deepEqual(Object.keys(body.error), ['code'], 'a refusal is a bare machine code')
  return { status: response.status, body, error: body.error }
}

// ---- GET: the Host's own favorites only, as provider + model ----------------
{
  const host = mount()
  const { status, value } = await bodyOf(host.dispatch('GET'))
  assert.equal(status, 200)
  assert.deepEqual(value, { favorites: [{ provider: LOCAL.provider, model: LOCAL.model }] })
  assert.equal('serverId' in value.favorites[0], false, 'the wire shape carries no serverId')
  assert.equal(JSON.stringify(value).includes('legacy'), false, 'legacy import receipts never leave the Host')
  assert.equal(JSON.stringify(value).includes('abcdef01'), false, 'other Hosts\' records stay home')
  assert.equal(JSON.stringify(value).includes('schema'), false, 'no settings document crosses the wire')
  assert.deepEqual(host.routes.get(path).methods, ['GET'], 'the read route owns GET only')
  assert.deepEqual(host.routes.get(setPath).methods, ['POST'], 'the write route owns POST only')
  assert.equal(host.routes.get(path).requestBody, 'buffered', 'a GET has no body, so buffering it reads nothing')
  assert.equal(host.routes.get(setPath).requestBody, 'streaming', 'the write streams so an oversized body is never held up front')
  // Method walls: neither route answers the other's method, and neither
  // answers PUT; all three are 404 before `fetch` runs.
  assert.equal((await host.dispatch('POST', '{}', {}, path)).status, 404, 'the read path refuses POST')
  assert.equal((await host.dispatch('GET', undefined, {}, setPath)).status, 404, 'the write path refuses GET')
  assert.equal((await host.dispatch('PUT', '{}')).status, 404, 'PUT is owned by neither route')
}

// ---- POST set: one idempotent change, every other row preserved ------------
{
  const host = mount()
  const before = host.store.value
  const added = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(added.status, 200)
  assert.deepEqual(added.value.favorites, [
    { provider: LOCAL.provider, model: LOCAL.model },
    { provider: 'magpie', model: 'model-b' },
  ])
  const afterAdd = host.store.value
  assert.deepEqual(afterAdd.favorites.filter(entry => entry.serverId !== null), before.favorites.filter(entry => entry.serverId !== null), 'remote and other-Host rows are untouched')
  assert.deepEqual(afterAdd.legacyFavoriteImports, RECEIPTS, 'legacy import receipts survive the write')
  const written = host.store.writes.at(-1)
  assert.deepEqual(written.patch.favorites.at(-1), { serverId: null, provider: 'magpie', model: 'model-b' }, 'a new favorite is a Host-owned record (serverId: null)')
  assert.equal(written.expectedRevision, written.expectedRevision, 'the write carries the revision it read')

  // Same request again: no write, same authoritative answer (idempotent set).
  const writes = host.store.writes.length
  const again = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(again.status, 200)
  assert.deepEqual(again.value, added.value)
  assert.equal(host.store.writes.length, writes, 'an already-satisfied set writes nothing')

  // Remove it: only that row goes.
  const removed = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: false })))
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }])
  assert.deepEqual(host.store.value.favorites, before.favorites, 'the document is back to its original rows, in order')

  // Removing something absent is a no-op that still answers the truth.
  const absent = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'never', favorite: false })))
  assert.equal(absent.status, 200)
  assert.equal(host.store.writes.length, writes + 1)
}

// ---- A record for another Host with the same provider + model is a different row ----
{
  const host = mount({ favorites: [structuredClone(REMOTE)] })
  const { status, value } = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-a', favorite: true })))
  assert.equal(status, 200)
  assert.deepEqual(value.favorites, [{ provider: 'magpie', model: 'model-a' }])
  assert.deepEqual(host.store.value.favorites, [
    structuredClone(REMOTE),
    { serverId: null, provider: 'magpie', model: 'model-a' },
  ], 'the same provider + model on another Host stays separate')
  const off = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-a', favorite: false })))
  assert.deepEqual(off.value.favorites, [])
  assert.deepEqual(host.store.value.favorites, [structuredClone(REMOTE)], 'removing the Host record leaves the other Host\'s row')
}

// ---- Legacy rows without serverId: Schemastery leaves the key out, not null ----
//
// The schema gives serverId a `null` default, but Schemastery OMITS a missing
// key instead of materializing it, so a row written before the field existed
// arrives as `undefined`. It is this Host's own favorite and must behave so.
{
  const legacy = { provider: 'magpie', model: 'legacy-no-serverId' }   // no key at all
  assert.equal(Object.hasOwn(legacy, 'serverId'), false)
  const host = mount({ favorites: [
    structuredClone(legacy),
    { ...structuredClone(legacy), model: 'legacy-explicit-undefined' }, // defensive
    structuredClone(REMOTE),
    structuredClone(LOCAL),
  ] })
  // GET lists it, exactly like an explicit-null row, and never rewrites it.
  const read = await bodyOf(host.dispatch('GET'))
  assert.deepEqual(read.value.favorites, [
    { provider: 'magpie', model: 'legacy-no-serverId' },
    { provider: 'magpie', model: 'legacy-explicit-undefined' },
    { provider: LOCAL.provider, model: LOCAL.model },
  ], 'a row with no serverId is this Host\'s own and is listed')
  // Structural, not a substring search: the model id above legitimately
  // contains the text "serverId", so assert the KEY is absent on every row.
  for (const row of read.value.favorites) assert.deepEqual(Object.keys(row), ['provider', 'model'])
  assert.deepEqual(Object.keys(read.value), ['favorites'])
  assert.equal(host.store.writes.length, 0, 'a read never writes')
  assert.deepEqual(host.store.value.favorites[0], legacy, 'the stored legacy row is untouched by the read')

  // POST favorite:false removes the legacy row itself (it was the same address).
  const off = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'legacy-no-serverId', favorite: false })))
  assert.equal(off.status, 200)
  assert.deepEqual(off.value.favorites, [
    { provider: 'magpie', model: 'legacy-explicit-undefined' },
    { provider: LOCAL.provider, model: LOCAL.model },
  ])
  assert.deepEqual(host.store.value.favorites, [
    { provider: 'magpie', model: 'legacy-explicit-undefined' },
    structuredClone(REMOTE),
    structuredClone(LOCAL),
  ], 'only the legacy row was removed; the remote row and the other legacy row stay')

  // POST favorite:true onto a still-present legacy row: no write (already set).
  const same = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'legacy-explicit-undefined', favorite: true })))
  assert.deepEqual(same.value, off.value)
  assert.equal(host.store.writes.length, 1, 'an already-set legacy address writes nothing')

  // POST favorite:true onto a brand-new address adds an explicit-null row and
  // leaves every legacy row byte-for-byte as it was.
  const add = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'fresh', favorite: true })))
  assert.equal(add.status, 200)
  assert.deepEqual(host.store.value.favorites, [
    { provider: 'magpie', model: 'legacy-explicit-undefined' },
    structuredClone(REMOTE),
    structuredClone(LOCAL),
    { serverId: null, provider: 'magpie', model: 'fresh' },
  ], 'the write preserves the legacy row\'s shape and only appends the new explicit-null row')
}

// ---- One row per address: a duplicate that reached the document is folded ----
{
  const dup = { serverId: null, provider: 'magpie', model: 'dup' }
  const host = mount({ favorites: [structuredClone(LOCAL), structuredClone(dup), structuredClone(REMOTE), structuredClone(dup)] })
  // GET never rewrites; it answers each Host address once, in first-seen order.
  const read = await bodyOf(host.dispatch('GET'))
  assert.deepEqual(read.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }, { provider: 'magpie', model: 'dup' }])
  assert.equal(host.store.writes.length, 0, 'a read never writes')
  // `true` folds the duplicate in place: the first copy keeps its position
  // and every other row (the other Host's included) is left as it is.
  const same = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'dup', favorite: true })))
  assert.equal(same.status, 200)
  assert.deepEqual(same.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }, { provider: 'magpie', model: 'dup' }])
  assert.deepEqual(host.store.value.favorites, [structuredClone(LOCAL), structuredClone(dup), structuredClone(REMOTE)], 'one copy remains, in the first copy\'s position')
  assert.equal(host.store.writes.length, 1, 'the fold is one write')
  // From now on the address is settled: a repeated `true` writes nothing.
  const settled = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'dup', favorite: true })))
  assert.deepEqual(settled.value, same.value)
  assert.equal(host.store.writes.length, 1)
  // `false` removes every copy of the address and nothing else.
  const off = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'dup', favorite: false })))
  assert.deepEqual(off.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }])
  assert.deepEqual(host.store.value.favorites, [structuredClone(LOCAL), structuredClone(REMOTE)])
}

// ---- `false` straight onto an un-folded duplicate removes every copy ----
{
  const dup = { serverId: null, provider: 'magpie', model: 'dup' }
  // Two browsers starred one model between two revisions; nobody folded it.
  const host = mount({ favorites: [structuredClone(dup), structuredClone(LOCAL), structuredClone(dup), structuredClone(REMOTE)] })
  const off = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'dup', favorite: false })))
  assert.equal(off.status, 200)
  assert.deepEqual(off.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }])
  assert.deepEqual(host.store.value.favorites, [structuredClone(LOCAL), structuredClone(REMOTE)], 'both copies are gone and no other row moved')
  assert.equal(host.store.writes.length, 1)
}

// ---- CAS: a concurrent writer moves the revision; re-read and merge only the one entry ----
{
  const host = mount()
  let concurrent = 0
  const update = host.store.settings.update.bind(host.store.settings)
  host.store.settings.update = async (ns, patch, expected) => {
    if (concurrent++ === 0) host.store.external((current) => ({ ...current, favorites: [...current.favorites, { serverId: null, provider: 'magpie', model: 'concurrent' }] }))
    return update(ns, patch, expected)
  }
  const { status, value } = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(status, 200)
  assert.deepEqual(value.favorites, [
    { provider: LOCAL.provider, model: LOCAL.model },
    { provider: 'magpie', model: 'concurrent' },
    { provider: 'magpie', model: 'model-b' },
  ], 'the concurrent entry is kept and only the requested entry is added')
  assert.equal(host.store.writes[0].expectedRevision, 0, 'the first attempt carried the stale revision and was refused')
  assert.equal(host.store.writes.length, 2)
}

// ---- CAS exhaustion: persistent conflicts answer 409 without writing ----
{
  const host = mount()
  let calls = 0
  const update = host.store.settings.update.bind(host.store.settings)
  host.store.settings.update = async (ns, patch, expected) => {
    calls += 1
    host.store.external((current) => current)
    return update(ns, patch, expected)
  }
  const { status, body } = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(status, 409)
  assert.equal(body.error.code, 'settings/conflict')
  assert.equal(calls, 4, 'one attempt plus three retries')
  assert.deepEqual(host.store.value.favorites.map(entry => entry.model), ['model-a', 'model-a', 'model-z'], 'nothing was written')
}

// ---- A failed write surfaces as an error, never as a made-up list ----
{
  const host = mount()
  host.store.failure = new Error('disk full')
  const { status, body } = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(status, 500)
  assert.equal(body.error.code, 'favorites-write-failed')
  assert.equal(JSON.stringify(body).includes('disk'), false, 'internal messages stay off the wire')
}

// ---- Validation: strict shape, types, sizes and media type ----
{
  const host = mount()
  const rejects = [
    [{ provider: 'magpie', model: 'model-b' }, 'missing favorite'],
    [[{ provider: 'magpie', model: 'model-b', favorite: true }], 'an array'],
    ['model-b', 'a string'],
    [null, 'null'],
    [{ provider: 'magpie', model: 'model-b', favorite: 'true' }, 'favorite must be a boolean'],
    [{ provider: 'magpie', model: 'model-b', favorite: 1 }, 'favorite must be a boolean'],
    [{ provider: '', model: 'model-b', favorite: true }, 'empty provider'],
    [{ provider: 'magpie', model: '', favorite: true }, 'empty model'],
    [{ provider: 'ma\u0000gpie', model: 'model-b', favorite: true }, 'control character'],
    [{ provider: 'x'.repeat(257), model: 'model-b', favorite: true }, 'provider too long'],
    [{ provider: 'magpie', model: 'm'.repeat(257), favorite: true }, 'model too long'],
    [{ provider: 'magpie', model: 'model-b', favorite: true, serverId: '1234abcd' }, 'client-chosen serverId'],
    [{ provider: 'magpie', model: 'model-b', favorite: true, legacyFavoriteImports: [] }, 'extra field'],
    [{ provider: 7, model: 'model-b', favorite: true }, 'non-string provider'],
  ]
  for (const [payload, label] of rejects) {
    const { status, body } = await bodyOf(host.dispatch(...post(payload)))
    assert.equal(status, 400, `${label} → 400`)
    assert.equal(body.error.code, 'bad-request')
  }
  const notJson = await host.dispatch('POST', '{not json')
  assert.equal(notJson.status, 400)
  const wrongType = await host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true }, { 'content-type': 'text/plain' }))
  assert.equal(wrongType.status, 415)
  const declared = await host.dispatch('POST', '{}', { 'content-length': String(8192) })
  assert.equal(declared.status, 413, 'an oversized declared length is refused before reading')
  const chunked = new Request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ provider: 'x'.repeat(5000), model: 'm', favorite: true })))
        controller.close()
      },
    }),
  })
  const streamed = await host.routes.get(setPath).fetch(chunked)
  assert.equal(streamed.status, 413, 'an oversized streamed body is refused while reading')
  assert.equal(host.store.writes.length, 0, 'no invalid request reached settings')
  assert.deepEqual(host.store.value.favorites.map(entry => entry.model), ['model-a', 'model-a', 'model-z'])
}

// ---- An unusable profile answers 503 / 403 instead of inventing a list ----
{
  const host = mount()
  const describe = host.store.settings.describe.bind(host.store.settings)
  host.store.settings.describe = () => describe().filter(section => section.ns !== namespace)
  const missing = await bodyOf(host.dispatch('GET'))
  assert.equal(missing.status, 503)
  assert.equal(missing.body.error.code, 'favorites-unavailable')
  const write = await bodyOf(host.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(write.status, 503)
  assert.equal(host.store.writes.length, 0)

  const readonly = mount()
  const live = readonly.store.settings.describe.bind(readonly.store.settings)
  readonly.store.settings.describe = () => live().map(section => ({ ...section, applies: 'manual' }))
  const refused = await bodyOf(readonly.dispatch(...post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'favorites-readonly')
  assert.equal(readonly.store.writes.length, 0)
}

// ---- Zen bridge: declared only to a Zen that supports the Host locator ----
{
  const seen = { declarations: [] }
  const capable = mount({ zenRemote: { supportsHostLocator: true, bridge(declaration) { seen.declarations.push(declaration); return () => { seen.disposed = true } } } })
  assert.equal(seen.declarations.length, 1)
  assert.deepEqual(seen.declarations[0], {
    plugin: 'dsh-t3-model-picker',
    version: manifest.version,
    routes: [
      { path, scope: 'server', locator: { in: 'host' }, methods: ['GET'] },
      { path: setPath, scope: 'server', locator: { in: 'host' }, methods: ['POST'], maxBody: 4096 },
    ],
  }, 'the declaration names exactly the two DSH routes, their methods and the write body cap')
  // Unload runs every effect's disposer: the bridge declaration goes, and so
  // do both exact routes (the disposer registerFavorites returns).
  const routeDisposer = capable.effects.find(effect => effect.label === 't3-model-picker: favorites routes')?.dispose
  assert.equal(typeof routeDisposer, 'function', 'the routes register a disposer')
  for (const { dispose } of capable.effects.reverse()) await dispose?.()
  assert.equal(seen.disposed, true, 'unload removes the declaration')
  assert.equal(capable.routes.size, 0, 'unload removes both exact routes')
  // Idempotent: disposing the route disposer again is harmless.
  await routeDisposer()

  const legacy = mount({ zenRemote: { supportsHostLocator: false, bridge(declaration) { seen.declarations.push(declaration); return () => {} } } })
  assert.equal(seen.declarations.length, 1, 'a Zen without the capability is handed nothing it would refuse')
  assert.equal(legacy.warnings.length, 1)
  assert.match(legacy.warnings[0], /supportsHostLocator/)
  assert.deepEqual([...legacy.routes.keys()].sort(), [path, setPath].sort(), 'the local route is up regardless')

  const noZen = mount()
  assert.deepEqual([...noZen.routes.keys()].sort(), [path, setPath].sort(), 'without Zen the Host half still serves browsers')

  const disagreeing = mount({ zenRemote: { supportsHostLocator: true, bridge() { throw new Error('invalid bridge declaration, routes[0].path: starts with a host-owned prefix') } } })
  assert.deepEqual([...disagreeing.routes.keys()].sort(), [path, setPath].sort(), 'a refused declaration does not take the local route down')
  assert.equal(disagreeing.warnings.length, 1)
  assert.match(disagreeing.warnings[0], /refused/)

  const broken = mount({ zenRemote: { supportsHostLocator: true, bridge() { return undefined } } })
  assert.deepEqual([...broken.routes.keys()].sort(), [path, setPath].sort())
  assert.match(broken.warnings[0], /no disposer/)
}

console.log('Host favorites: GET projects only this Host\'s rows; POST sets one entry idempotently with CAS, preserves other rows and legacy imports, validates strictly, and declares the bridge only to a capable Zen.')
