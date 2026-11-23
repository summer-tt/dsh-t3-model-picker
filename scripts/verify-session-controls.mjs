/**
 * Browser regression for client.js with a stub of the Host connection and slots.
 * Run with React 18, React DOM 18 and Playwright installed and Chromium available.
 * Set T3_TEST_CHROMIUM to exercise a specific Chromium executable.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const browser = await chromium.launch({ executablePath: process.env.T3_TEST_CHROMIUM })
const origin = 'http://picker.test'
const mount = `${origin}/dsh-test/`
const sessionA = 'session-A'
const sessionB = 'session-B'
const model = 'codex/gpt-6.2-sol'
const otherModel = 'codex/gpt-6.2-astra'
const provider = 'magpie'
const key = (sessionId, modelId = model) => `${sessionId}/${modelId}`
const calls = []
const preferences = new Map()
const pageErrors = []
const denied = new Map()
const delays = new Map()
let availability = { speed: true, contextWindow: true }
let efforts = ['low', 'high']
let getOverride
const defaultControls = { speed: 'fast', contextWindow: 500000 }
const readControls = (address) => {
  const pref = preferences.get(address) ?? defaultControls
  return {
    ...(availability.speed ? { speed: { value: pref.speed, options: ['standard', 'fast', 'ultrafast'] } } : {}),
    ...(availability.contextWindow ? { contextWindow: { value: pref.contextWindow, options: [272000, 500000, 872000] } } : {}),
    efforts,
  }
}
const deferred = () => {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

try {
  const context = await browser.newContext({ viewport: { width: 320, height: 244 } })
  await context.addCookies([{ name: 'owner-test', value: 'fixture', url: mount, httpOnly: true }])
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error))
  page.setDefaultTimeout(4000)
  await page.route(`${mount}**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/dsh-test/session') {
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><base href="${mount}"><div id="app" style="position: fixed; bottom: 12px; right: 12px"></div>` })
      return
    }
    assert.equal(url.pathname, '/dsh-test/api/magpie-session-controls')
    assert.match(await request.headerValue('cookie'), /owner-test=fixture/)
    assert.equal(await request.headerValue('authorization'), null)
    const method = request.method()
    const data = method === 'GET' ? Object.fromEntries(url.searchParams) : request.postDataJSON()
    assert.equal(data.provider, provider)
    const address = key(data.sessionId, data.model)
    calls.push({ method, ...data })
    if (method === 'GET') {
      const override = getOverride?.(address)
      const json = override?.json ?? { ok: true, value: readControls(address) }
      await delays.get(`GET ${address}`)?.promise
      await route.fulfill({ status: override?.status ?? 200, json })
      return
    }
    assert.equal(method, 'POST')
    assert.deepEqual(Object.keys(data).sort(), ['field', 'model', 'provider', 'sessionId', 'value'])
    const { field, value } = data
    assert.ok(readControls(address)[field]?.options.includes(value))
    await delays.get(`POST ${address}`)?.promise
    const error = denied.get(address)
    if (error !== undefined) {
      await route.fulfill({ status: 409, json: { ok: false, error } })
      return
    }
    preferences.set(address, { ...defaultControls, ...preferences.get(address), [field]: value })
    await route.fulfill({ json: { ok: true, value: readControls(address) } })
  })
  await page.goto(`${mount}session`)
  for (const [pkg, umd] of [['react', 'react'], ['react-dom', 'react-dom']]) {
    const dir = dirname(require.resolve(`${pkg}/package.json`))
    await page.addScriptTag({ path: join(dir, 'umd', `${umd}.development.js`) })
  }
  await page.evaluate(({ provider, model, otherModel }) => {
    let definition
    let seat
    let dictionary
    let revision = 0
    let selectError
    const handlers = new Map()
    const directories = new Map()
    const selectCalls = []
    const h = React.createElement
    const reasoning = {
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })),
    }
    const makeDirectory = sessionId => {
      const groups = [{ id: provider, name: 'Magpie', models: [model, otherModel].map(id => ({ id, name: id, reasoning })) }]
      let state = { status: 'ready', current: { provider, model }, groups, error: null, failures: [] }
      const listeners = new Set()
      const publish = () => { for (const listener of listeners) listener() }
      return {
        load: async () => {},
        store: {
          getSnapshot: () => state,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        },
        update(selection) {
          state = { ...state, current: { ...state.current, ...selection } }
          publish()
        },
        async select(selection) {
          selectCalls.push({ sessionId, ...selection })
          if (selectError !== undefined) {
            state = { ...state, status: 'error', error: selectError }
            publish()
            return { ok: false, error: { code: 'test/rejected', message: selectError } }
          }
          state = { ...state, status: 'ready', error: null, current: selection }
          publish()
          return { ok: true }
        },
      }
    }
    window.__ModuleLoader__ = { load: entry => { definition = entry } }
    window.startPicker = () => definition.factory(pkg => ({
      react: React, 'react-dom': ReactDOM, '@deepseek-ai/dsh-client-ui-primitives': {},
    })[pkg]).apply({
      locale: { register: (_, values) => { dictionary = values.en } },
      effect: fn => fn(),
      on: (name, handler) => handlers.set(name, handler),
      inject: (_, setup) => setup({ effect: fn => fn(), remote: { agentTeams: {} } }),
      remote: {
        $on: (name, handler) => handlers.set(name, handler),
        session: { modelCatalog: async () => ({ ok: true, value: { routableProviders: [provider] } }) },
      },
      sessions: { subagentAddress: () => undefined },
      modelDirectories: { directoryFor: sessionId => {
        if (!directories.has(sessionId)) directories.set(sessionId, makeDirectory(sessionId))
        return directories.get(sessionId)
      } },
      slots: {
        inject: (_, fn) => fn(),
        register: (options, component) => { seat = { options, component } },
      },
    })
    const root = ReactDOM.createRoot(document.querySelector('#app'))
    window.fixture = {
      render(sessionId, running = false, remount = false) {
        if (remount) revision += 1
        root.render(h(seat.component, {
          ...seat.options.inject(sessionId), key: `${sessionId}:${revision}`, locked: false, sessionId,
          t: (name, params) => dictionary[name].replace(/\{(\w+)\}/g, (_, param) => params[param]),
          useProjection: name => name === 'agentTeam' ? { enabled: false } : { lastUsed: null },
          useSession: selector => selector({ running, subagent: null }),
          useSessions: selector => selector({ byId: {} }),
        }))
      },
      update(sessionId, selection) { directories.get(sessionId).update(selection) },
      refresh() { handlers.get('settings/document-updated')() },
      failSelect(message) { selectError = message },
      selectCalls,
    }
  }, { provider, model, otherModel })
  await page.addScriptTag({ path: fileURLToPath(new URL('../client.js', import.meta.url)) })
  await page.evaluate(sessionId => { window.startPicker(); window.fixture.render(sessionId) }, sessionA)
  const trigger = page.locator('.t3mp-trigger')
  const panel = page.getByRole('dialog', { name: 'Model picker' })
  const effort = panel.getByRole('slider', { name: 'Reasoning effort' })
  const speed = panel.getByRole('slider', { name: 'Speed' })
  const windowSize = panel.getByRole('slider', { name: 'Context window' })
  const team = panel.getByRole('switch', { name: 'Enable agent teamwork' })
  const posts = () => calls.filter(call => call.method === 'POST')
  const gets = address => calls.filter(call => call.method === 'GET' && key(call.sessionId, call.model) === address)
  const waitValue = (field, text) => page.waitForFunction(([name, value]) => {
    const input = document.querySelector(`[data-t3mp-control="${name}"]`)
    return input?.getAttribute('aria-valuetext') === value && input.getAttribute('aria-busy') !== 'true'
  }, [field, text])
  const reopen = async () => { await trigger.click(); await speed.waitFor() }
  await reopen()
  await waitValue('speed', 'Fast')
  await waitValue('contextWindow', '500000 tokens')
  assert.ok(await team.isVisible())
  const bounds = await panel.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 244)
  assert.ok((await panel.locator('.t3mp-list').boundingBox()).height >= 56)
  await team.scrollIntoViewIfNeeded()
  const teamBounds = await team.boundingBox()
  assert.ok(teamBounds.y >= 0 && teamBounds.y + teamBounds.height <= 244)

  await effort.focus()
  await page.keyboard.press('ArrowUp')
  await waitValue('effort', 'low')
  assert.deepEqual(await page.evaluate(() => window.fixture.selectCalls), [{ sessionId: sessionA, provider, model, reasoningEffort: 'low' }])
  assert.equal(await effort.evaluate(element => document.activeElement === element), true)
  await effort.focus()
  await page.keyboard.down('End')
  await page.waitForFunction(() => document.querySelector('[data-t3mp-control="effort"]').getAttribute('aria-valuetext') === 'high')
  assert.equal(await page.evaluate(() => window.fixture.selectCalls.length), 1)
  await page.keyboard.press('Escape')
  await page.keyboard.up('End')
  await waitValue('effort', 'low')
  assert.ok(await panel.isVisible())

  await speed.scrollIntoViewIfNeeded()
  let rect = await speed.boundingBox()
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width - 3, rect.y + rect.height / 2, { steps: 6 })
  await page.waitForFunction(() => document.querySelector('[data-t3mp-control="speed"]').getAttribute('aria-valuetext') === 'Ultrafast')
  assert.equal(posts().length, 0)
  await page.mouse.up()
  await waitValue('speed', 'Ultrafast')
  assert.deepEqual(posts()[0], { method: 'POST', sessionId: sessionA, provider, model, field: 'speed', value: 'ultrafast' })
  assert.ok(await panel.isVisible())
  await speed.scrollIntoViewIfNeeded()
  rect = await speed.boundingBox()
  await page.mouse.move(rect.x + rect.width - 3, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x + 3, rect.y + rect.height / 2, { steps: 4 })
  await page.waitForFunction(() => document.querySelector('[data-t3mp-control="speed"]').getAttribute('aria-valuetext') === 'Standard')
  await page.keyboard.press('Escape')
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 3 })
  await page.mouse.up()
  await waitValue('speed', 'Ultrafast')
  assert.equal(posts().length, 1)

  await windowSize.focus()
  await page.keyboard.press('End')
  await waitValue('contextWindow', '872000 tokens')
  assert.deepEqual(posts()[1], { method: 'POST', sessionId: sessionA, provider, model, field: 'contextWindow', value: 872000 })
  await page.evaluate(sessionId => window.fixture.render(sessionId, true), sessionA)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-t3mp-control]')].every(input => input.getAttribute('aria-disabled') === 'true'))
  await page.keyboard.press('Home')
  await speed.scrollIntoViewIfNeeded()
  rect = await speed.boundingBox()
  await page.mouse.click(rect.x + 3, rect.y + rect.height / 2)
  assert.equal(posts().length, 2)
  await page.evaluate(sessionId => window.fixture.render(sessionId), sessionA)
  await page.waitForFunction(() => document.querySelector('[data-t3mp-control="speed"]').getAttribute('aria-disabled') !== 'true')

  denied.set(key(sessionA), 'Session is already running')
  const delayedWrite = deferred()
  delays.set(`POST ${key(sessionA)}`, delayedWrite)
  await speed.focus()
  await page.keyboard.press('Home')
  await page.waitForFunction(() => document.querySelector('[data-t3mp-control="speed"]').getAttribute('aria-busy') === 'true')
  const previousReads = gets(key(sessionA)).length
  await page.evaluate(sessionId => window.fixture.render(sessionId), sessionB)
  await reopen()
  await waitValue('speed', 'Fast')
  assert.ok(gets(key(sessionB)).length > 0)
  await page.evaluate(sessionId => window.fixture.render(sessionId), sessionA)
  await trigger.click()
  await panel.getByText('Loading session controls…').waitFor()
  assert.equal(gets(key(sessionA)).length, previousReads)
  delayedWrite.release()
  await waitValue('speed', 'Ultrafast')
  await panel.getByRole('alert').getByText(/Session is already running/).waitFor()
  assert.equal(posts().length, 3)
  await panel.getByRole('button', { name: 'Dismiss' }).click()
  await panel.getByRole('alert').waitFor({ state: 'detached' })
  denied.clear()

  availability = { speed: false, contextWindow: true }
  await page.evaluate(() => window.fixture.refresh())
  await speed.waitFor({ state: 'detached' })
  await waitValue('contextWindow', '872000 tokens')
  availability = { speed: true, contextWindow: false }
  await page.evaluate(() => window.fixture.refresh())
  await windowSize.waitFor({ state: 'detached' })
  await waitValue('speed', 'Ultrafast')
  availability = { speed: false, contextWindow: false }
  await page.evaluate(() => window.fixture.refresh())
  await speed.waitFor({ state: 'detached' })
  await waitValue('effort', 'low')
  assert.equal(await panel.getByRole('slider').count(), 1)

  getOverride = () => ({ json: { ok: true, value: { contextWindow: { options: ['500000'], value: '500000' } } } })
  await page.evaluate(() => window.fixture.refresh())
  await panel.getByRole('button', { name: 'Retry' }).waitFor()
  assert.equal(await panel.getByRole('slider').count(), 1)
  await panel.getByText('Could not load session controls: Invalid session controls response').waitFor()
  getOverride = () => ({ status: 404, json: { ok: false, error: 'Session is not active' } })
  await panel.getByRole('button', { name: 'Retry' }).click()
  await panel.getByText('Could not load session controls: Session is not active').waitFor()
  assert.equal(await panel.getByRole('textbox').evaluate(element => document.activeElement === element), true)

  availability = { speed: true, contextWindow: true }
  const delayedRead = deferred()
  getOverride = address => address === key(sessionA) ? { json: { ok: true, value: {} } } : undefined
  delays.set(`GET ${key(sessionA)}`, delayedRead)
  const oldRequest = page.waitForRequest(request => {
    const query = new URL(request.url()).searchParams
    return request.method() === 'GET' && query.get('sessionId') === sessionA && query.get('model') === model
  })
  await panel.getByRole('button', { name: 'Retry' }).click()
  await oldRequest
  await panel.getByText('Loading session controls…').waitFor()
  await page.evaluate(({ sessionId, otherModel }) => window.fixture.update(sessionId, { model: otherModel }), { sessionId: sessionA, otherModel })
  await waitValue('speed', 'Fast')
  delayedRead.release()
  await waitValue('contextWindow', '500000 tokens')
  assert.ok(gets(key(sessionA, otherModel)).length > 0)

  efforts = ['high']
  await page.evaluate(() => { window.fixture.failSelect('Reasoning update refused'); window.fixture.refresh() })
  await waitValue('speed', 'Fast')
  const selectionCount = await page.evaluate(() => window.fixture.selectCalls.length)
  await effort.focus()
  await page.keyboard.press('End')
  await panel.getByText('Could not save Reasoning effort: Reasoning update refused').waitFor()
  await waitValue('effort', 'low')
  assert.equal(await effort.evaluate(element => document.activeElement === element), true)
  await page.evaluate(() => window.fixture.failSelect(undefined))
  await page.keyboard.press('End')
  await waitValue('effort', 'high')
  assert.equal(await effort.getAttribute('aria-disabled'), 'true')
  assert.deepEqual((await page.evaluate(() => window.fixture.selectCalls)).slice(selectionCount), [
    { sessionId: sessionA, provider, model: otherModel, reasoningEffort: 'high' },
    { sessionId: sessionA, provider, model: otherModel, reasoningEffort: 'high' },
  ])
  await page.evaluate(sessionId => window.fixture.update(sessionId, { reasoningEffort: 'low' }), sessionA)
  await waitValue('effort', 'low')
  const selectedModel = panel.getByRole('menuitemradio', { name: new RegExp(otherModel) })
  await selectedModel.click()
  await panel.waitFor({ state: 'hidden' })
  assert.deepEqual((await page.evaluate(() => window.fixture.selectCalls)).at(-1), { sessionId: sessionA, provider, model: otherModel, reasoningEffort: 'high' })
  assert.deepEqual(pageErrors, [])
  console.log('Chromium passed: keyboard and pointer preview/commit/cancel, owner cookie and mounted API, narrow panel, running lock, delayed write failure across remount, four capability combinations, invalid DTO, and stale model reads.')
} finally {
  await browser.close()
}
