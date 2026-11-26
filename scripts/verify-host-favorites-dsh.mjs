import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// Run the shipped Host half (index.js) against the REAL shipped DSH services
// it depends on, instead of the hand-written doubles in
// verify-host-favorites.mjs: dsh-client-connection's HostConnectionService
// (the exact `/api` route registry, its owner-only gate and its method
// dispatch) and dsh-settings' SettingsForms (the revisioned describe/update
// whose CAS runs inside the config editor's edit callback). Both are resolved
// from the running DSH installation, the way an installed plugin resolves
// them; only the Loader-owned configEditor is an in-memory fixture.
//
// Why the read-merge-write in index.js is safe against concurrent writers:
// dsh-config-editor's edit() serializes every profile write under a file
// lock and calls `change` (which re-describes and compares the revision)
// INSIDE that lock, so a write that read a stale list is refused by
// SettingsConflictError before anything is persisted. The route then re-reads
// and merges again. The CAS block below lands a concurrent writer through
// that same edit() path, as every production writer does.
const cliDir = process.env.DSH_INSTALL_DIR
  ?? '/home/dev/.local/share/dsh/dotfile/releases/v0.2.2-fix-1cc803c3ea4d/node_modules/@deepseek-ai/dsh'
assert.equal(JSON.parse(readFileSync(resolve(cliDir, 'package.json'), 'utf8')).name, '@deepseek-ai/dsh')
const schemasteryDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/schemastery/package.json', { paths: [cliDir] }))
register('./dsh-resolve.mjs', import.meta.url, { data: pathToFileURL(resolve(schemasteryDir, 'package.json')).href })
const require = createRequire(pathToFileURL(resolve(cliDir, 'package.json')).href)
const { Context, resolveConfig } = require('@deepseek-ai/cordis')
const { updateVolatile, volatileEntries } = require('@deepseek-ai/cosmokit')
const connectionModule = require('@deepseek-ai/dsh-client-connection')
const { HostConnectionService } = connectionModule
const { WebServer } = require('@deepseek-ai/dsh-host-webserver')
const { SettingsForms } = require('@deepseek-ai/dsh-settings')
const plugin = await import('../index.js')

const namespace = 't3-model-picker'
// The contract lead froze with the Zen Remote side. Written out literally so
// the route and the bridge declaration cannot drift together unnoticed.
const CONTRACT_PATH = '/api/t3-model-picker/favorites'
const CONTRACT_SET_PATH = '/api/t3-model-picker/favorites/set'
const path = CONTRACT_PATH
const setPath = CONTRACT_SET_PATH
const REMOTE = { serverId: '1234abcd', provider: 'magpie', model: 'model-a' }
const LOCAL = { serverId: null, provider: 'magpie', model: 'model-a' }

/** Loader-shaped entry + in-memory config editor: the one piece DSH's
 * Loader owns. `edit` is the serialization point SettingsForms relies on, and
 * the volatile fields are resolved and committed exactly as the Loader's
 * `_commitVolatile` does (cordis `resolveConfig` + cosmokit `updateVolatile`),
 * so `SettingsForms.describe()` reads the live resolved values. */
function createProfile(runtime) {
  const fiber = { uid: 1, state: 2, runtime, effectiveConfig: undefined, ctx: {} }
  fiber.ctx.fiber = fiber
  const entry = { id: namespace, options: { id: namespace, config: {} }, fiber }
  const commit = () => {
    const candidate = resolveConfig(runtime, entry.options.config)
    const refs = volatileEntries(fiber.effectiveConfig)
    if (refs.length === 0) {
      fiber.effectiveConfig = candidate
      return
    }
    for (const { path, ref } of refs) {
      const source = path.reduce((value, key) => Reflect.get(value, key), candidate)
      updateVolatile(ref, source)
    }
  }
  const editor = {
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    entries: () => [entry],
    documentPath: '/profile/cordis.patch.yml',
    async edit(target, change) {
      assert.equal(target, entry)
      const next = change(entry.options.config, {})
      await new Promise(done => setImmediate(done))
      entry.options.config = next
      commit()
    },
  }
  return { entry, editor }
}

/** Set the initial raw config the way a profile patch would, then resolve it. */
function withConfig(profile, config) {
  profile.entry.options.config = structuredClone(config)
  // The first commit has no running references yet: resolve from scratch.
  const fiber = profile.entry.fiber
  fiber.effectiveConfig = resolveConfig(fiber.runtime, profile.entry.options.config)
  return profile
}

// SettingsForms imports a legacy settings.yaml from the profile home once the
// Loader settles; an empty temporary home has none, so the import is a no-op.
const home = mkdtempSync(resolve(tmpdir(), 't3-host-favorites-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

async function mount(config, zenRemote) {
  const profile = withConfig(createProfile({ Config: plugin.Config }), config)
  const root = new Context()
  root.loader = { await: async () => {} }
  root.provide('configEditor', profile.editor)
  root.provide('profileContext', { name: 'web', home })
  if (zenRemote !== undefined) root.provide('zenRemote', zenRemote)
  // The REAL cordis logger, captured through its exporter: the plugin's
  // `ctx.logger.warn(...)` form is verified against the shipped Context.
  const warnings = []
  root.logger.exporter({ export: (message) => { warnings.push(message.args.join(' ')) } })
  // SettingsForms reads the credentials-less path: no secrets in this Config.
  // Constructing a Service registers it under its name.
  const settings = new SettingsForms(root)
  // HostConnectionService over a webServer-less root: no /api carrier is
  // mounted, so the shared Fetch handler is driven directly, as DSH's own
  // tests do. BrowserAuth is only consulted by admit(), not by fetch().
  const connection = new HostConnectionService(root, [], { isAuthenticated: () => false, authenticateApi: () => undefined })
  const scope = root.extend()
  plugin.apply(scope)
  const shared = connection.createSharedFetchHandler('/api')
  const dispatch = (request, peer = connection.browserPeer) => shared.fetch(request, peer)
  const send = (method, body, target = method === 'POST' ? setPath : path, peer) => shared.fetch(new Request(`http://127.0.0.1${target}`, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(body === undefined ? {} : { duplex: 'half' }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), peer)
  return { dispatch, send, shared, connection, profile, settings, warnings }
}

const bodyOf = async (dispatched) => {
  const response = await dispatched
  return { status: response.status, body: await response.json() }
}

/** Bounded poll for a value that arrives on a later tick; fails loudly. */
async function waitFor(read, accept, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms (last value: ${String(value)})`)
    await new Promise(done => setTimeout(done, stepMs))
  }
}
const get = () => new Request(`http://127.0.0.1${path}`, { method: 'GET' })
// The write goes to its own exact route; it is declared streaming, so the
// request carries a stream body with `duplex: 'half'` as the bridge builds it.
const post = (payload) => new Request(`http://127.0.0.1${setPath}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), duplex: 'half',
})

// ---- The real shared handler dispatches the route for GET and POST only ----
{
  const host = await mount({ favorites: [structuredClone(REMOTE), structuredClone(LOCAL)], legacyFavoriteImports: ['r'] })
  // The read is buffered (a GET has no body, so that mode reads nothing; it
  // cannot stream — the Fetch API refuses a body on GET). The write STREAMS so
  // the bridge never holds the body before the route's 4 KiB limit runs.
  const mode = (method, target) => host.shared.requestBodyMode({ method, url: new URL(`http://x${target}`) })
  assert.equal(mode('GET', path), 'buffered')
  assert.equal(mode('POST', setPath), 'streaming')
  assert.equal(mode('POST', path), 'buffered', 'the read path is not a write route')
  assert.equal(mode('GET', setPath), 'buffered', 'the write path is not a read route')

  // The route answers on the contract path and nowhere else on this plugin's
  // prefix: a sibling path is not an exact route (the shared handler 404s).
  assert.equal((await host.dispatch(new Request('http://127.0.0.1/api/t3-model-picker/favs', { method: 'GET' }))).status, 404)
  const read = await bodyOf(host.dispatch(get()))
  assert.equal(read.status, 200)
  assert.deepEqual(read.body, { ok: true, value: { favorites: [{ provider: 'magpie', model: 'model-a' }] } })

  const added = await bodyOf(host.dispatch(post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(added.status, 200)
  assert.deepEqual(added.body.value.favorites, [{ provider: 'magpie', model: 'model-a' }, { provider: 'magpie', model: 'model-b' }])
  // The real SettingsForms wrote the whole user section through edit().
  assert.deepEqual(host.profile.entry.options.config, {
    favorites: [structuredClone(REMOTE), structuredClone(LOCAL), { serverId: null, provider: 'magpie', model: 'model-b' }],
    legacyFavoriteImports: ['r'],
  })
  assert.equal(host.settings.describe().find(row => row.ns === namespace).revision, 1)

  // Undeclared methods never reach a route in the real handler (404), and
  // neither route answers the other's method.
  assert.equal((await host.dispatch(new Request(`http://127.0.0.1${path}`, { method: 'PUT' }))).status, 404)
  assert.equal((await host.dispatch(new Request(`http://127.0.0.1${path}`, { method: 'HEAD' }))).status, 404)
  assert.equal((await host.send('POST', '{}', path)).status, 404, 'the read path refuses POST')
  assert.equal((await host.send('GET', undefined, setPath)).status, 404, 'the write path refuses GET')
}

// ---- The real owner gate: a non-owner Peer is refused before the route ----
{
  const host = await mount({ favorites: [structuredClone(LOCAL)] })
  const stranger = host.connection.createPeer({ principal: { kind: 'member' } })
  assert.equal((await host.dispatch(get(), stranger)).status, 403)
  assert.equal((await host.dispatch(post({ provider: 'magpie', model: 'model-b', favorite: true }), stranger)).status, 403, 'the write route is owner-only too')
  assert.deepEqual(host.profile.entry.options.config.favorites, [structuredClone(LOCAL)], 'a non-owner write never reaches settings')
}

// ---- The real CAS: a concurrent writer lands between read and update ----
{
  const host = await mount({ favorites: [structuredClone(LOCAL)], legacyFavoriteImports: [] })
  const settings = host.settings
  const realUpdate = settings.update.bind(settings)
  let moved = false
  settings.update = async (ns, patch, expected) => {
    if (!moved) {
      moved = true
      // Another writer lands first THROUGH THE SAME config editor, so the
      // Loader-owned commit path (edit → resolve → volatile refs) runs for
      // it exactly as it would in production.
      await host.profile.editor.edit(host.profile.entry, (raw) => ({
        ...raw,
        favorites: [...raw.favorites, { serverId: null, provider: 'magpie', model: 'concurrent' }],
      }))
      settings.describe()
    }
    return realUpdate(ns, patch, expected)
  }
  const result = await bodyOf(host.dispatch(post({ provider: 'magpie', model: 'model-b', favorite: true })))
  assert.equal(moved, true)
  assert.equal(result.status, 200, 'the stale write was refused by the REAL SettingsConflictError and retried')
  assert.deepEqual(result.body.value.favorites, [
    { provider: 'magpie', model: 'model-a' },
    { provider: 'magpie', model: 'concurrent' },
    { provider: 'magpie', model: 'model-b' },
  ], 'the concurrent entry survives the retry and only the requested entry is added')
  assert.deepEqual(host.profile.entry.options.config.favorites.map(row => row.model), ['model-a', 'concurrent', 'model-b'])
}

// ---- The real cordis logger and service registry: an older Zen Remote ----
{
  // Zen Remote provides `zenRemote` on its own row's fiber; here the service
  // is provided on the root the same way. It lacks the Host-locator
  // capability, so nothing must be declared and the local route stays up.
  const declarations = []
  const host = await mount({ favorites: [structuredClone(LOCAL)] }, { bridge(declaration) { declarations.push(declaration); return () => {} } })
  assert.equal(declarations.length, 0, 'an older Zen Remote is handed nothing it would refuse')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /supportsHostLocator/, 'the reason is reported through the REAL ctx.logger')
  const read = await bodyOf(host.dispatch(get()))
  assert.equal(read.status, 200, 'the local route still serves browsers')

  // A capable Zen Remote receives the declaration through ctx.inject, and
  // withdrawing the service (the row unloading) removes it again.
  const capable = []
  let disposed = 0
  const seen = { supportsHostLocator: true, bridge(declaration) { capable.push(declaration); return () => { disposed += 1 } } }
  const live = await mount({ favorites: [structuredClone(LOCAL)] }, seen)
  assert.equal(capable.length, 1, 'ctx.inject([\'zenRemote\']) fired once the service was provided')
  assert.equal(capable[0].routes[0].locator.in, 'host')
  assert.deepEqual(capable[0].routes.map(route => [route.path, route.methods]), [
    [CONTRACT_PATH, ['GET']],
    [CONTRACT_SET_PATH, ['POST']],
  ], 'the declaration names the same two paths the routes answer on')
  assert.equal(live.warnings.length, 0, 'nothing to warn about')
}

// ---- Legacy rows without serverId, through the REAL Schemastery ----
//
// The schema gives serverId a `null` default, but the shipped Schemastery
// OMITS a missing key rather than materializing it: a row written before the
// field existed resolves with NO serverId key at all (`undefined`). The Host
// must read and set it as this Host's own favorite. This is the real resolve
// path (cordis resolveConfig over the shipped Config), not a double.
{
  const legacy = { provider: 'magpie', model: 'legacy-no-serverId' }   // no key at all
  assert.equal(Object.hasOwn(legacy, 'serverId'), false)
  const host = await mount({ favorites: [structuredClone(legacy), structuredClone(REMOTE), structuredClone(LOCAL)], legacyFavoriteImports: ['r'] })

  // What the shipped stack actually hands the route: no serverId key.
  const described = host.settings.describe().find(row => row.ns === namespace).value.favorites
  assert.equal(Object.hasOwn(described[0], 'serverId'), false, 'the shipped Schemastery leaves the key out')
  assert.equal(described[0].serverId, undefined)

  // GET lists it as this Host's own, and does not rewrite the stored row.
  const read = await bodyOf(host.dispatch(get()))
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.value.favorites, [
    { provider: 'magpie', model: 'legacy-no-serverId' },
    { provider: LOCAL.provider, model: LOCAL.model },
  ], 'a row with no serverId is this Host\'s own and is listed')
  for (const row of read.body.value.favorites) assert.deepEqual(Object.keys(row), ['provider', 'model'])
  assert.deepEqual(host.profile.entry.options.config.favorites[0], legacy, 'the stored legacy row is untouched by the read')

  // POST favorite:false removes the legacy row itself, through the real
  // SettingsForms write, leaving the other Host's row and the receipts.
  const off = await bodyOf(host.dispatch(post({ provider: 'magpie', model: 'legacy-no-serverId', favorite: false })))
  assert.equal(off.status, 200)
  assert.deepEqual(off.body.value.favorites, [{ provider: LOCAL.provider, model: LOCAL.model }])
  assert.deepEqual(host.profile.entry.options.config, {
    favorites: [structuredClone(REMOTE), structuredClone(LOCAL)],
    legacyFavoriteImports: ['r'],
  }, 'only the legacy row was removed; the remote row and receipts survive the real write')

  // POST favorite:true onto an address that is still legacy-shaped: no write.
  const host2 = await mount({ favorites: [{ provider: 'magpie', model: 'legacy-explicit-undefined' }], legacyFavoriteImports: [] })
  const writesBefore = host2.settings.describe().find(row => row.ns === namespace).revision
  const same = await bodyOf(host2.dispatch(post({ provider: 'magpie', model: 'legacy-explicit-undefined', favorite: true })))
  assert.equal(same.status, 200)
  assert.deepEqual(same.body.value.favorites, [{ provider: 'magpie', model: 'legacy-explicit-undefined' }])
  assert.equal(host2.settings.describe().find(row => row.ns === namespace).revision, writesBefore, 'an already-set legacy address writes nothing')
}

// ---- The REAL transport: an oversized body never buffers near the carrier cap ----
//
{
  // Mount the REAL carrier the way the Loader does: as plugins, so cordis runs
  // each Service's [Service.init] lifecycle (that is where WebServer binds).
  const profile = withConfig(createProfile({ Config: plugin.Config }), { favorites: [structuredClone(LOCAL)], legacyFavoriteImports: [] })
  const root = new Context()
  root.loader = { await: async () => {} }
  root.provide('configEditor', profile.editor)
  root.provide('profileContext', { name: 'web', home })
  // An in-memory credential provider holding the GENERATED test signing
  // secret for the browser-session grant. No real credential is read.
  const records = new Map()
  root.provide('credentials', {
    async modifyRecord(key, change) {
      const next = await change(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
  })
  const warnings = []
  root.logger.exporter({ export: message => { warnings.push(message.args.join(' ')) } })
  const settings = new SettingsForms(root)
  const fibers = []
  const mountPlugin = async (plugin_, config) => { const fiber = root.plugin(plugin_, config); fibers.push(fiber); await fiber.await(); return fiber }
  await mountPlugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = root.webServer
  const port = await waitFor(() => server.port, value => Number.isInteger(value) && value > 0)
  assert.ok(port > 0, 'the real WebServer bound an OS-assigned port')

  // Count the request-body bytes the server pulls off the socket for /api
  // requests, BEFORE the shipped Connection registers its /api prefix route.
  let read = 0
  const originalRegister = server.register.bind(server)
  server.register = route => originalRegister(route.kind === 'prefix' && route.path === '/api'
    ? { ...route, handler: (req, res) => { req.on('data', chunk => { read += chunk.length }); return route.handler(req, res) } }
    : route)

  // The shipped /api carrier: trust fence, cookie auth, bridge(), shared handler.
  await mountPlugin(connectionModule, { trustedHosts: [] })
  assert.equal(typeof root.connection?.fetch?.register, 'function', 'the real Connection service is provided')
  // As the Loader does with the plugin's exported inject: apply the plugin
  // only once `connection` and `settings` are provided.
  const scope = root.extend()
  plugin.apply(scope)
  await new Promise(done => setImmediate(done))
  try {
    // The owner cookie from the shipped token exchange. The browser form
    // (`GET /?token=…` → 303) is served by the SPA fallback, which this
    // minimal composition does not mount; `GET /connect?token=…` is the
    // Connection's own route and mints the cookie for an OWNER Peer
    // (rpc-host.ts publishPeer: principal { kind: 'owner' }).
    const launchUrl = root.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
    const token = new URL(launchUrl).searchParams.get('token')
    const exchange = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/connect?token=${encodeURIComponent(token)}`, method: 'GET', agent: false }, res => {
        res.resume()
        res.on('end', () => resolve(res))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(exchange.statusCode, 302, 'the launch token exchanges for the owner cookie')
    const setCookie = exchange.headers['set-cookie']
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1)
    const cookie = setCookie[0].split(';', 1)[0]

    const send = (body, headers = {}, method = 'POST', target = method === 'POST' ? setPath : path) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: target, method, agent: false, headers: { 'content-type': 'application/json', cookie, ...headers } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body)
    })

    // A valid request still works end to end over the real transport, and a
    // GET (declared streaming, like POST) answers with no body read at all.
    read = 0
    const got = await send(undefined, {}, 'GET')
    assert.equal(got.status, 200, 'a streaming-declared GET works on the real carrier')
    assert.deepEqual(JSON.parse(got.text), { ok: true, value: { favorites: [{ provider: 'magpie', model: 'model-a' }] } })
    assert.equal(read, 0, 'a GET reads no body byte')

    const okResponse = await send(JSON.stringify({ provider: 'magpie', model: 'model-b', favorite: true }))
    assert.equal(okResponse.status, 200)
    assert.deepEqual(JSON.parse(okResponse.text), { ok: true, value: { favorites: [{ provider: 'magpie', model: 'model-a' }, { provider: 'magpie', model: 'model-b' }] } })

    // The oversized body: 8 MiB, far past the 4 KiB cap, sent chunked (no
    // Content-Length) so nothing can be refused on a header alone — the limit
    // must be enforced by the route's bounded reader while the bytes stream.
    read = 0
    const oversized = await send(Buffer.alloc(8 * 1024 * 1024, 0x20))
    assert.equal(oversized.status, 413, 'the route answers 413 body-too-large')
    assert.deepEqual(JSON.parse(oversized.text), { ok: false, error: { code: 'body-too-large' } })
    // The bound: the route reads at most MAX_BODY_BYTES plus whatever one
    // socket read delivers past it. The whole 8 MiB was offered; the server
    // must NOT have consumed it — and nowhere near the 300 MiB carrier cap.
    assert.ok(read < 1024 * 1024, `the server buffered only ${read} bytes of an 8 MiB body before refusing`)
    assert.equal(settings.describe().find(row => row.ns === namespace).revision, 1, 'the refused write never reached settings')

    // An unauthenticated caller is refused by admit() BEFORE bridge() is
    // reached (dsh-client-connection lib/index.js L1049-1055), so no
    // application code reads the body. What the counter still sees is the
    // socket buffer Node's parser already holds: a bare node:http server that
    // answers 401 without reading surfaces the same amount to a `data`
    // listener (measured ~128 KiB for a 1 MiB upload). So the bound is "at
    // most one socket buffer", not literally zero.
    read = 0
    const anonymous = await send(Buffer.alloc(1024 * 1024, 0x20), { cookie: '' })
    assert.equal(anonymous.status, 401)
    assert.ok(read < 1024 * 1024, `a request refused by authentication consumed ${read} bytes (one socket buffer), not the 1 MiB body`)
    assert.equal(settings.describe().find(row => row.ns === namespace).revision, 1, 'the refused write never reached settings')
    // A non-owner API credential cannot reach the exact route: there is no
    // such credential to mint here, and the owner gate is asserted in the
    // in-process block above against the same createSharedFetchHandler.
  } finally {
    // Drive each plugin fiber's lifecycle so the shipped WebServer closes its
    // listener (its effect disposer). With `agent: false` every test request
    // already closed its own socket, so the loop then drains by itself; a
    // server handle left behind fails here instead of being forced away.
    await scope.fiber.dispose?.()
    for (const fiber of fibers.reverse()) await fiber.dispose?.()
    const servers = () => process._getActiveHandles().filter(h => h.constructor?.name === 'Server')
    await waitFor(() => servers().length, value => value === 0, { timeoutMs: 2000 })
    assert.equal(servers().length, 0, 'the real WebServer closed its listener on dispose')
  }
}

console.log('Against the shipped DSH services: the real /api handler dispatches GET/POST and gates non-owner Peers, the real SettingsForms persists the single-entry change with its revision, and a real SettingsConflictError is retried.')
