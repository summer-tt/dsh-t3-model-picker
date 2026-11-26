import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

const favorite = z.object({
  serverId: z.union([z.string().pattern(/^[0-9a-f]{8}$/u), z.const(null)]).default(null),
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** This package's version, read from its own manifest at load time. */
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export const Config = z.object({
  favorites: z.array(favorite).default([]).volatile(),
  legacyFavoriteImports: z.array(z.string()).default([]).volatile(),
})

// ------------------------------------------------------- favorites Host half

/** Profile entry that owns the favorites document (`Config` above). */
const FAVORITES_NAMESPACE = 't3-model-picker'

/**
 * The favorites routes. Both callers reach them through DSH's exact `/api`
 * Fetch registry: browsers on this Host directly, and a paired Zen Remote
 * Host through its plugin bridge. Their path segments satisfy
 * `endpointFromPath` in dsh-client-connection (letters, digits, `_ $ . -`).
 *
 * Read and write are two exact routes because the body mode differs and
 * dsh-client-connection picks ONE mode per path:
 *
 * - `GET` is `buffered`. A GET has no body, so that mode reads nothing.
 *   It cannot be `streaming`: the bridge would build the Fetch request with
 *   `body: Readable.toWeb(req)` whatever the method, and the Fetch API
 *   refuses a body on GET ("Request with GET/HEAD method cannot have
 *   body"), which surfaces as a 400 before the route runs.
 * - `POST` is `streaming`. In the buffered mode the bridge holds the WHOLE
 *   body in memory before `fetch`, up to its carrier cap (300 MiB by
 *   default), and only then would this route's 4 KiB limit run. Streaming
 *   holds nothing up front: `readJson` reads at most MAX_BODY_BYTES plus
 *   one chunk and cancels, and the bridge closes the connection instead of
 *   draining the rest of an oversized body.
 *
 * Both routes sit behind the same admission and owner gate.
 */
const FAVORITES_PATH = '/api/t3-model-picker/favorites'
const FAVORITES_SET_PATH = '/api/t3-model-picker/favorites/set'

/**
 * The Zen Remote service capability that accepts a Host-located bridge route
 * (`locator: { in: 'host' }`, `scope: 'server'`). Zen versions without it
 * refuse the `/api` path outright and keep every bridged route
 * session-located, so the declaration is handed over only when the service
 * advertises the capability; the local routes stay up either way.
 */
const HOST_LOCATOR_CAPABILITY = 'supportsHostLocator'

/**
 * POST bodies larger than this are refused before being parsed.
 */
const MAX_BODY_BYTES = 4 * 1024

/** Upper bound for one provider or model id; long enough for every shipped id. */
const MAX_ID_LENGTH = 256

/** CAS retries after a concurrent writer moved the revision. */
const MAX_CONFLICT_RETRIES = 3

/**
 * Whether a stored row belongs to THIS Host. The schema declares
 * `serverId` as an 8-hex id or `null`, but Schemastery leaves the key out
 * entirely when it is missing rather than materializing the `null` default,
 * so a row written before the field existed (or edited by hand) arrives as
 * `undefined`. Both mean "this Host"; any other value is another Host's.
 */
function isOwnHost(value) {
  return value.serverId === null || value.serverId === undefined
}

/**
 * Shape of one stored favorite. Everything else in the profile document —
 * legacy import receipts, other rows — never leaves this module.
 */
function isStoredFavorite(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && isOwnHost(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
}

/** Public view: this Host's own favorites, one row per provider + model. The
 * stored list is keyed by that address; a document that somehow carries the
 * same address twice (two browsers starring one model between two
 * revisions) still answers it once, in first-seen order. */
function publicFavorites(entries) {
  const seen = new Set()
  const favorites = []
  for (const entry of entries) {
    if (!isStoredFavorite(entry)) continue
    const key = JSON.stringify([entry.provider, entry.model])
    if (seen.has(key)) continue
    seen.add(key)
    favorites.push({ provider: entry.provider, model: entry.model })
  }
  return { favorites }
}

function sameFavorite(entry, provider, model) {
  return isOwnHost(entry) && entry.provider === provider && entry.model === model
}

/**
 * The one wire envelope, in both directions: success carries the value
 * under `value`; a refusal carries only a machine-readable `code`. No other
 * profile data, and no internal message, crosses the wire.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const ok = (favorites) => json(200, { ok: true, value: publicFavorites(favorites) })
const fail = (status, code) => json(status, { ok: false, error: { code } })

// Every call returns a NEW Response: a Response body can be read once, and
// the /api bridge reads it to write it to the socket.
const BAD_REQUEST = () => fail(400, 'bad-request')
const UNAVAILABLE = () => fail(503, 'favorites-unavailable')
const TOO_LARGE = () => fail(413, 'body-too-large')

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { ok: false, response: fail(415, 'unsupported-media-type') }
  }
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return { ok: false, response: TOO_LARGE() }
  const reader = request.body?.getReader()
  if (reader === undefined) return { ok: true, value: undefined }
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return { ok: false, response: TOO_LARGE() }
    }
    chunks.push(value)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, response: BAD_REQUEST() }
  }
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Strict `{ provider, model, favorite }`: exactly these fields, nothing else. */
function parseSetRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const keys = Object.keys(body)
  if (keys.length !== 3 || !keys.includes('provider') || !keys.includes('model') || !keys.includes('favorite')) return undefined
  if (!validId(body.provider) || !validId(body.model) || typeof body.favorite !== 'boolean') return undefined
  return { provider: body.provider, model: body.model, favorite: body.favorite }
}

/** A refused stale write: dsh-settings raises this when the revision moved. */
function isConflict(error) {
  return error?.code === 'SETTINGS_CONFLICT' || error?.code === 'settings/conflict' || error?.name === 'SettingsConflictError'
}

/**
 * Read the favorites document. Returns the volatile fields the Host owns
 * plus the revision a write must carry; throws when the entry is absent.
 */
async function readDocument(settings) {
  const document = settings.describe()
  const section = (Array.isArray(document) ? document : document.namespaces)
    .find(entry => entry.ns === FAVORITES_NAMESPACE)
  if (section === undefined || !Number.isSafeInteger(section.revision)) {
    throw new Error(`Plugin entry "${FAVORITES_NAMESPACE}" is not configurable`)
  }
  return {
    writable: document.writable !== false && section.applies === 'live',
    revision: section.revision,
    favorites: Array.isArray(section.value?.favorites) ? section.value.favorites : [],
    imports: Array.isArray(section.value?.legacyFavoriteImports) ? section.value.legacyFavoriteImports : [],
  }
}

/**
 * Create the GET / POST handler pair over the Host settings service.
 * @param settings - `ctx.settings` (dsh-settings), read live per request.
 */
function createFavoritesHandlers(settings) {
  const read = async () => {
    try {
      return ok((await readDocument(settings)).favorites)
    } catch {
      return UNAVAILABLE()
    }
  }

  const write = async (request) => {
    const body = await readJson(request)
    if (!body.ok) return body.response
    const change = parseSetRequest(body.value)
    if (change === undefined) return BAD_REQUEST()

    for (let attempt = 0; ; attempt += 1) {
      let document
      try {
        document = await readDocument(settings)
      } catch {
        return UNAVAILABLE()
      }
      if (!document.writable) return fail(403, 'favorites-readonly')

      // One idempotent change: touch only the matching Host-owned entry and
      // keep every other row (other Hosts' records included) as it is. The
      // address holds at most one row, so `true` also folds a duplicate that
      // reached the document, and `false` removes every copy.
      const matches = entry => sameFavorite(entry, change.provider, change.model)
      const copies = document.favorites.filter(matches).length
      const added = { serverId: null, provider: change.provider, model: change.model }
      let favorites = document.favorites
      if (change.favorite && copies !== 1) {
        // Keep the first copy in place; drop the rest.
        let kept = false
        favorites = document.favorites.filter((entry) => {
          if (!matches(entry)) return true
          if (kept) return false
          kept = true
          return true
        })
        if (copies === 0) favorites = [...favorites, added]
      } else if (!change.favorite && copies > 0) {
        favorites = favorites.filter(entry => !matches(entry))
      }

      if (favorites === document.favorites) {
        // Already in the desired state: nothing to write, report the truth.
        return ok(favorites)
      }
      try {
        await settings.update(FAVORITES_NAMESPACE, {
          favorites,
          // Restate the receipts so a concurrent legacy import is not erased
          // by this array-replacing write.
          legacyFavoriteImports: document.imports,
        }, document.revision)
        // Re-read: the authoritative list after the write, not the proposal.
        return ok((await readDocument(settings)).favorites)
      } catch (error) {
        if (isConflict(error)) {
          if (attempt < MAX_CONFLICT_RETRIES) continue
          return fail(409, 'settings/conflict')
        }
        return fail(500, 'favorites-write-failed')
      }
    }
  }

  return { read, write }
}

/**
 * Register the favorites routes on the Host. DSH's exact `/api` registry
 * applies the Host/Origin fence, the signed browser or API credential, and
 * its owner-only gate before `fetch` runs; the routes themselves check
 * nothing. See the path constants for why the read is buffered and the
 * write streams.
 * @param ctx - Host plugin context with `connection` and `settings`.
 * @returns a disposer removing both routes.
 */
function registerFavorites(ctx) {
  const handlers = createFavoritesHandlers(ctx.settings)
  const read = ctx.connection.fetch.register({
    path: FAVORITES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => handlers.read(),
  })
  const write = ctx.connection.fetch.register({
    path: FAVORITES_SET_PATH,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (request) => handlers.write(request),
  })
  return async () => { await write(); await read() }
}

/**
 * Hand Zen Remote the bridge declaration for the favorites route. Only a
 * Zen service that advertises the Host-locator capability receives it; an
 * older Zen keeps its refusal of `/api` paths and this Host simply stays
 * unreachable through the bridge. A throwing registration (a Zen whose
 * validator disagrees) is reported and swallowed: it must not take the
 * local routes down.
 * @param zenRemote - the `zenRemote` service of the running Zen Remote row.
 * @param version - this package's running version (the bridge compares it).
 * @param warn - reports a refused registration.
 * @returns the declaration's disposer, or undefined when nothing registered.
 */
function declareBridge(zenRemote, version, warn) {
  if (typeof zenRemote?.bridge !== 'function') return undefined
  if (zenRemote[HOST_LOCATOR_CAPABILITY] !== true) {
    warn(`zen-remote does not advertise ${HOST_LOCATOR_CAPABILITY}; remote Hosts cannot reach this Host's favorites through the bridge`)
    return undefined
  }
  try {
    const dispose = zenRemote.bridge({
      plugin: 'dsh-t3-model-picker',
      version,
      routes: [
        { path: FAVORITES_PATH, scope: 'server', locator: { in: 'host' }, methods: ['GET'] },
        { path: FAVORITES_SET_PATH, scope: 'server', locator: { in: 'host' }, methods: ['POST'], maxBody: MAX_BODY_BYTES },
      ],
    })
    if (typeof dispose !== 'function') throw new TypeError('zenRemote.bridge returned no disposer')
    return dispose
  } catch (error) {
    warn(`favorites bridge declaration was refused: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export const inject = ['connection', 'settings']

/**
 * Host half: the favorites read and single-entry set routes, declared to a
 * capable Zen Remote for paired-Host access.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const warn = (message) => { ctx.logger?.warn(`t3-model-picker: ${message}`) }
  ctx.effect(() => registerFavorites(ctx), 't3-model-picker: favorites routes')
  ctx.inject(['zenRemote'], (scope) => {
    scope.effect(() => declareBridge(scope.zenRemote, version, warn), 't3-model-picker: favorites bridge declaration')
  })
}
