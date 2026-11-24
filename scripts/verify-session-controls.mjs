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
let batch = true
let runningEdits = false
let revision = 0
let windowOutcome
let dropReceipt
let nextWindowId = 0
// Model-switch gate: how long a stubbed selectModel stays in flight (0 settles
// on the next tick), and the transport timeout (Infinity disables it).
let selectDelay = 0
let selectTimeout = Infinity
const defaultControls = { speed: 'fast', contextWindow: 500000 }
const readControls = (address) => {
  const pref = preferences.get(address) ?? defaultControls
  return {
    ...(availability.speed ? { speed: { value: pref.speed, options: ['standard', 'fast', 'ultrafast'] } } : {}),
    ...(availability.contextWindow ? { contextWindow: { value: pref.contextWindow, options: [272000, 500000, 872000] } } : {}),
    efforts,
    ...(batch && { batch: true, revision: String(revision), reasoningEffort: pref.reasoningEffort ?? null }),
    ...(runningEdits && { runningEdits: true }),
    ...(availability.contextWindow && pref.pendingWindow && { pendingWindow: pref.pendingWindow }),
    ...(availability.contextWindow && pref.windowWarning && { windowWarning: pref.windowWarning }),
  }
}
const settleWindow = (address, reason) => {
  const pref = preferences.get(address)
  assert.ok(pref.pendingWindow)
  const pending = pref.pendingWindow
  preferences.set(address, {
    ...pref, pendingWindow: undefined,
    ...(reason === undefined ? { contextWindow: pending.target } : {
      windowWarning: { ...pending, retained: pref.contextWindow, reason },
    }),
  })
  revision++
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
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><base href="${mount}"><div id="app" style="position: fixed; bottom: 12px; right: 12px"></div><button id="outside">Outside</button><div id="overlays"></div>` })
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
    const patch = data.changes ?? { [data.field]: data.value }
    for (const [field, value] of Object.entries(patch)) {
      assert.ok(field === 'reasoningEffort' ? value === null || efforts.includes(value) : readControls(address)[field]?.options.includes(value))
    }
    if (data.changes) assert.equal(data.expectedRevision, String(revision))
    assert.equal(data.allowRunning, runningEdits ? true : undefined)
    await delays.get(`POST ${address}`)?.promise
    const error = denied.get(address)
    if (error !== undefined) {
      await route.fulfill({ status: 409, json: { ok: false, error } })
      return
    }
    const saved = { ...defaultControls, ...preferences.get(address), ...patch }
    if (data.allowRunning && Object.hasOwn(patch, 'contextWindow')) {
      const retained = readControls(address).contextWindow.value
      saved.pendingWindow = undefined
      saved.windowWarning = undefined
      if (patch.contextWindow < retained) {
        const candidate = { id: String(++nextWindowId), target: patch.contextWindow }
        saved.contextWindow = retained
        if (windowOutcome === undefined) saved.pendingWindow = candidate
        else saved.windowWarning = { ...candidate, retained, reason: windowOutcome }
      }
    }
    preferences.set(address, saved)
    revision++
    if (dropReceipt) {
      const onDrop = dropReceipt
      dropReceipt = undefined
      onDrop(address)
      await route.abort()
      return
    }
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
    let overlay
    const bindings = new Map()
    const sends = []
    const abandons = []
    let requestSequence = 0
    // Model-switch fixtures: one deferred selectModel per call, so a test can
    // hold a switch "in flight" and decide when it settles.
    const selects = []
    let selectDelay = 0
    let selectTimeout = Infinity
    function binding(sessionId) {
      if (!bindings.has(sessionId)) bindings.set(sessionId, { sessionId, session: {
        beginSubmission() {
          const requestId = String(++requestSequence)
          return { requestId, abandon: () => abandons.push(requestId) }
        },
        async prompt(content, mode, signal, requestId) {
          sends.push({ sessionId, content, mode, requestId })
          return { ok: true, value: { accepted: true } }
        },
      } })
      return bindings.get(sessionId)
    }
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
          // Mirror the real ModelDirectory: mark selecting+pending synchronously,
          // then settle to ready/current or error. The switch is deferred so a
          // test can observe the picker before it settles.
          const record = { sessionId, ...selection }
          record.promise = new Promise((resolve) => { record.release = resolve })
          selects.push(record)
          state = { ...state, status: 'selecting', pending: selection }
          publish()
          if (typeof selectDelay === 'number' && Number.isFinite(selectDelay)) setTimeout(() => record.release(), selectDelay)
          if (selectTimeout !== Infinity) {
            const timer = new Promise((_, reject) => setTimeout(() => reject(Object.assign(
              new Error('Request timed out'), { name: 'TimeoutError' },
            )), selectTimeout))
            try {
              await Promise.race([record.promise, timer])
            } catch (error) {
              state = { ...state, status: 'error', pending: null, error: error.message }
              publish()
              throw error
            }
          } else {
            await record.promise
          }
          if (selectError !== undefined) {
            state = { ...state, status: 'error', pending: null, error: selectError }
            publish()
            return { ok: false, error: { code: 'test/rejected', message: selectError } }
          }
          state = { ...state, status: 'ready', pending: null, error: null, current: selection }
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
      sessions: { subagentAddress: () => undefined, binding },
      modelDirectories: { directoryFor: sessionId => {
        if (!directories.has(sessionId)) directories.set(sessionId, makeDirectory(sessionId))
        return directories.get(sessionId)
      } },
      slots: {
        inject: (_, fn) => fn(),
        register: (options, component) => {
          if (options.name === 'conversation.input.model') seat = { options, component }
          if (options.name === 'shell.overlay') overlay = { options, component }
        },
      },
    })
    const root = ReactDOM.createRoot(document.querySelector('#app'))
    const overlayRoot = ReactDOM.createRoot(document.querySelector('#overlays'))
    const t = (name, params) => dictionary[name].replace(/\{(\w+)\}/g, (_, param) => params[param])
    window.fixture = {
      send(sessionId) {
        const session = binding(sessionId).session
        const handle = session.beginSubmission({ text: 'preserve draft' })
        window.lastSend = session.prompt([{ type: 'text', text: 'preserve draft' }], 'queue', undefined, handle.requestId)
      },
      sends, abandons,
      render(sessionId, running = false, remount = false) {
        if (remount) revision += 1
        if (overlay) overlayRoot.render(h(overlay.component, {
          ...overlay.options.inject?.(), t,
          renderFactorySlot: (name, props) => h('button', { 'data-notice': name, onClick: props.onDone }, props.text),
        }))
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
      selects,
      // Hold the next selectModel in flight for `ms`, or Infinity to wait for releaseSelect().
      delaySelect(ms) { selectDelay = ms },
      // Give the transport a `ms` timeout (or Infinity to disable it).
      setSelectTimeout(ms) { selectTimeout = ms },
      releaseSelect(sessionId, modelId) {
        const record = selects.findLast(item => !item.released
          && (sessionId === undefined || item.sessionId === sessionId)
          && (modelId === undefined || item.model === modelId))
        if (!record) throw new Error('releaseSelect: no in-flight selectModel')
        record.released = true
        record.release()
      },
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
  assert.equal(await trigger.locator('[data-t3mp-window]').textContent(), '500K')
  assert.equal(await trigger.locator('[data-t3mp-speed]').getAttribute('data-t3mp-speed'), 'fast')
  assert.ok(await team.isVisible())
  const bounds = await panel.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 244)
  assert.ok((await panel.locator('.t3mp-list').boundingBox()).height >= 56)
  await team.scrollIntoViewIfNeeded()
  const teamBounds = await team.boundingBox()
  assert.ok(teamBounds.y >= 0 && teamBounds.y + teamBounds.height <= 244)
  await trigger.click()
  await panel.waitFor({ state: 'hidden' })
  await reopen()

  const closePicker = async () => {
    await page.mouse.click(3, 3) // Outside the popup's minimum viewport margin.
    await panel.waitFor({ state: 'hidden' })
  }
  const choose = async (slider, keyboard) => { await slider.focus(); await page.keyboard.press(keyboard) }
  const counts = () => page.evaluate(() => [window.fixture.sends.length, window.fixture.abandons.length])
  const send = () => page.evaluate(sessionId => window.fixture.send(sessionId), sessionA)
  const sendOutcome = () => page.evaluate(() => window.lastSend)
  const waitPosts = size => assert.equal(posts().length, size)

  await choose(effort, 'Home')
  await choose(speed, 'End')
  await choose(windowSize, 'End')
  await waitValue('speed', 'Ultrafast')
  await waitValue('contextWindow', '872000 tokens')
  waitPosts(0)
  const slow = deferred()
  delays.set(`POST ${key(sessionA)}`, slow)
  const firstPost = page.waitForRequest(request => request.method() === 'POST')
  await send()
  await panel.waitFor({ state: 'hidden' })
  await firstPost
  waitPosts(1)
  assert.deepEqual(posts()[0].changes, { reasoningEffort: 'low', speed: 'ultrafast', contextWindow: 872000 })
  assert.deepEqual(await counts(), [0, 0])
  slow.release()
  assert.equal((await sendOutcome()).ok, true)
  assert.deepEqual(await counts(), [1, 0])
  assert.equal(await trigger.locator('[data-t3mp-window]').textContent(), '872K')
  assert.equal(await trigger.locator('[data-t3mp-speed]').getAttribute('data-t3mp-speed'), 'ultrafast')
  delays.delete(`POST ${key(sessionA)}`)

  await reopen()
  await waitValue('speed', 'Ultrafast')
  await choose(speed, 'Home')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  waitPosts(1)
  await reopen()
  await waitValue('speed', 'Ultrafast')
  denied.set(key(sessionA), 'Rejected by fixture')
  await choose(speed, 'Home')
  await choose(windowSize, 'Home')
  await send()
  assert.equal((await sendOutcome()).ok, false)
  assert.deepEqual(await counts(), [1, 1])
  assert.match(await page.locator('[data-notice="workspace.toast.content"]').textContent(), /Rejected by fixture/)
  await send()
  assert.equal((await sendOutcome()).ok, false)
  assert.deepEqual(await counts(), [1, 2])
  assert.match(await page.locator('[data-notice="workspace.toast.content"]').textContent(), /restore or discard unsaved settings/)
  await reopen()
  await waitValue('speed', 'Ultrafast')
  await waitValue('contextWindow', '872000 tokens')
  assert.ok(await panel.locator('.t3mp-main').evaluate(element => element.scrollWidth <= element.clientWidth))
  await panel.getByRole('button', { name: 'Restore unsaved changes' }).click()
  await waitValue('speed', 'Standard')
  await panel.getByRole('button', { name: 'Discard unsaved changes' }).click()
  await waitValue('speed', 'Ultrafast')
  await closePicker()
  waitPosts(2)
  denied.delete(key(sessionA))

  for (const [enableSpeed, enableWindow] of [[true,false], [false,true], [false,false], [true,true]]) {
    availability = { speed:enableSpeed, contextWindow:enableWindow }
    await page.evaluate(sessionId => window.fixture.render(sessionId, false, true), sessionB + `${enableSpeed}-${enableWindow}`)
    await trigger.click()
    await effort.waitFor()
    if (enableSpeed) await speed.waitFor()
    if (enableWindow) await windowSize.waitFor()
    await page.waitForFunction(() => !document.querySelector('.t3mp-status'))
    assert.equal(await speed.count(), Number(enableSpeed))
    assert.equal(await windowSize.count(), Number(enableWindow))
    assert.equal(await trigger.locator('[data-t3mp-speed]').count(), Number(enableSpeed))
    assert.equal(await trigger.locator('[data-t3mp-window]').count(), Number(enableWindow))
    await closePicker()
  }

  const flagSession = sessionB + '-flag-refresh'
  const heldRead = deferred()
  delays.set(`GET ${key(flagSession)}`, heldRead)
  const initialRead = page.waitForRequest(request => request.url().includes(flagSession))
  await page.evaluate(sessionId => window.fixture.render(sessionId, false, true), flagSession)
  await initialRead
  availability = { speed: false, contextWindow: true }
  await page.evaluate(() => window.fixture.refresh())
  await page.evaluate(() => new Promise(requestAnimationFrame))
  delays.delete(`GET ${key(flagSession)}`)
  heldRead.release()
  await page.waitForFunction(() => document.querySelector('[data-t3mp-window]') && !document.querySelector('[data-t3mp-speed]'))
  assert.equal(gets(key(flagSession)).length, 2)
  availability = { speed: true, contextWindow: true }

  batch = false
  await page.evaluate(sessionId => window.fixture.render(sessionId, false, true), sessionB)
  await trigger.click()
  await speed.waitFor()
  await choose(speed, 'End')
  const legacyPost = page.waitForRequest(request => request.method() === 'POST')
  await closePicker()
  assert.deepEqual((await legacyPost).postDataJSON(), { sessionId: sessionB, provider, model, field: 'speed', value: 'ultrafast' })
  getOverride = () => ({ status: 404, json: null })
  await page.evaluate(sessionId => window.fixture.render(sessionId, false, true), sessionB + '-no-api')
  await trigger.click()
  await effort.waitFor()
  await choose(effort, 'End')
  await closePicker()
  await page.waitForFunction(() => window.fixture.selectCalls.some(selection => selection.reasoningEffort === 'high'))
  getOverride = () => ({ status: 503, json: { ok: false, error: 'Capability lookup unavailable' } })
  await page.evaluate(sessionId => window.fixture.render(sessionId, false, true), sessionB + '-lookup-error')
  await trigger.click()
  await panel.getByText(/Capability lookup unavailable/).waitFor()
  assert.notEqual(await effort.getAttribute('aria-disabled'), 'true')
  await choose(effort, 'Home')
  await closePicker()
  await page.waitForFunction(() => window.fixture.selectCalls.some(selection => selection.sessionId.endsWith('-lookup-error') && selection.reasoningEffort === 'low'))
  batch = true
  getOverride = undefined
  const legacyRunning = `${sessionB}-legacy-running`
  await page.evaluate(sessionId => window.fixture.render(sessionId, true), legacyRunning)
  await reopen()
  for (const slider of [speed, effort, windowSize]) assert.equal(await slider.getAttribute('aria-disabled'), 'true')
  await closePicker()

  runningEdits = true
  const liveSession = `${sessionB}-running-edits`
  const liveAddress = key(liveSession)
  const renderRunning = running => page.evaluate(([id, active]) => window.fixture.render(id, active), [liveSession, running])
  const notice = page.locator('[data-notice="workspace.toast.content"]')
  await notice.click() // Dismiss the earlier rejected-save fixture's toast.
  const indicator = trigger.locator('[data-t3mp-window]')
  const waitWindow = value => page.waitForFunction(size => document.querySelector('[data-t3mp-window]')?.dataset.t3mpWindow === String(size), value)
  const submitControls = async () => {
    const request = page.waitForRequest(item => item.method() === 'POST')
    await closePicker()
    return (await request).postDataJSON()
  }
  // A draft survives the transition from idle to running. The trigger keeps the effective window.
  await renderRunning(false)
  await reopen()
  await choose(speed, 'End')
  await renderRunning(true)
  await choose(effort, 'Home')
  await choose(windowSize, 'Home')
  const firstRunningWrite = await submitControls()
  assert.equal(firstRunningWrite.allowRunning, true)
  assert.deepEqual(firstRunningWrite.changes, { speed: 'ultrafast', reasoningEffort: 'low', contextWindow: 272000 })
  await waitWindow(500000)
  await reopen()
  await waitValue('contextWindow', '272000 tokens')
  assert.match(await trigger.getAttribute('aria-label'), /Context window 500000 tokens/)
  await choose(windowSize, 'ArrowRight')
  const beforeEscape = posts().length
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  assert.equal(posts().length, beforeEscape)
  await reopen()
  await waitValue('contextWindow', '272000 tokens')
  await choose(windowSize, 'ArrowRight')
  assert.deepEqual((await submitControls()).changes, { contextWindow: 500000 })
  await reopen()
  await waitValue('contextWindow', '500000 tokens')
  assert.equal(preferences.get(liveAddress).pendingWindow, undefined)

  // After a known candidate settles, saving an open draft uses its new revision.
  await choose(windowSize, 'Home')
  await submitControls()
  await reopen()
  await waitValue('contextWindow', '272000 tokens')
  await choose(speed, 'Home')
  settleWindow(liveAddress)
  await waitWindow(272000)
  assert.deepEqual((await submitControls()).changes, { speed: 'standard' })
  await reopen()
  await waitValue('speed', 'Standard')
  assert.equal(await notice.count(), 0)

  // Async rejection still uses the notification slot with the picker closed. Idle pauses polling.
  await choose(windowSize, 'End')
  await submitControls()
  await waitWindow(872000)
  await reopen()
  await choose(windowSize, 'Home')
  await submitControls()
  settleWindow(liveAddress, 'over-budget')
  await renderRunning(false)
  await notice.filter({ hasText: /Kept 872000 tokens.*does not fit/ }).waitFor()
  assert.equal(await indicator.textContent(), '872K')
  await notice.click()
  const readsAtIdle = gets(liveAddress).length
  await page.waitForTimeout(1150)
  assert.equal(gets(liveAddress).length, readsAtIdle)
  await reopen()
  await waitValue('contextWindow', '872000 tokens')
  assert.equal(await notice.count(), 0)
  await closePicker()

  // A lost response can be verified as a candidate, or as a rejection with all other fields saved.
  await renderRunning(true)
  await reopen()
  await choose(windowSize, 'Home')
  dropReceipt = () => {
    getOverride = () => {
      getOverride = undefined
      return { status: 503, json: { ok: false, error: 'Transient verification error' } }
    }
  }
  await page.evaluate(id => window.fixture.send(id), liveSession)
  assert.equal((await sendOutcome()).ok, true)
  assert.equal(await indicator.textContent(), '872K')
  await reopen()
  await waitValue('contextWindow', '272000 tokens')
  await choose(windowSize, 'ArrowRight')
  await choose(speed, 'End')
  dropReceipt = address => settleWindow(address, 'measurement-failed')
  await page.evaluate(id => window.fixture.send(id), liveSession)
  assert.equal((await sendOutcome()).ok, true)
  await notice.filter({ hasText: /Kept 872000 tokens.*could not measure/ }).waitFor()
  await notice.click()
  await reopen()
  await waitValue('contextWindow', '872000 tokens')
  await waitValue('speed', 'Ultrafast')
  assert.equal(await notice.count(), 0)

  // A direct rejection receipt is also a valid partial save, with a localized reason.
  windowOutcome = 'unavailable'
  await choose(windowSize, 'Home')
  await choose(effort, 'End')
  await submitControls()
  await notice.filter({ hasText: /Kept 872000 tokens.*cannot check/ }).waitFor()
  assert.equal(preferences.get(liveAddress).reasoningEffort, null)
  assert.equal(await indicator.textContent(), '872K')
  await notice.click()

  // Idle performs one final GET, even if the candidate will need a subsequent turn to settle.
  windowOutcome = undefined
  const openRead = page.waitForResponse(response => response.request().method() === 'GET')
  await reopen()
  await (await openRead).finished()
  await choose(windowSize, 'Home')
  const savedCandidate = page.waitForResponse(response => response.request().method() === 'POST')
  await submitControls()
  assert.ok((await (await savedCandidate).json()).value.pendingWindow)
  const readsBeforeIdle = gets(liveAddress).length
  const idleRead = page.waitForResponse(response => response.request().method() === 'GET')
  await renderRunning(false)
  await idleRead
  assert.equal(gets(liveAddress).length, readsBeforeIdle + 1)
  await page.waitForTimeout(1150)
  assert.equal(gets(liveAddress).length, readsBeforeIdle + 1)
  settleWindow(liveAddress)
  await renderRunning(true)
  await waitWindow(272000)
  assert.equal(await notice.count(), 0)

  // ── Optimistic model switch ────────────────────────────────────────────────
  // The composer trigger is the chat box's model label: it must show the newly
  // chosen model as soon as the row is clicked, before selectModel settles, and
  // no request may leave while the switch is still in flight. A failed or
  // timed-out switch rolls the label back and notifies, then sending recovers.
  const switchSession = `${sessionB}-optimistic-switch`
  const renderSwitch = running => page.evaluate(([id, active]) => window.fixture.render(id, active), [switchSession, running])
  const triggerLabel = () => page.locator('.t3mp-trigger .t3mp-trigger-label')
  const rowFor = name => panel.locator('.t3mp-row').filter({ hasText: name })
  const sendSwitch = () => page.evaluate(id => window.fixture.send(id), switchSession)
  const sendOk = () => page.evaluate(() => window.lastSend.then(value => value.ok))
  const switchCounts = () => page.evaluate(() => [window.fixture.sends.length, window.fixture.abandons.length])
  const resetCounters = () => page.evaluate(() => {
    window.fixture.selects.length = 0; window.fixture.sends.length = 0; window.fixture.abandons.length = 0
  })
  const pendingSelect = () => page.evaluate(() => {
    const list = window.fixture.selects
    if (list.length === 0) return null
    const { promise, release, released, ...rest } = list[list.length - 1]
    return rest
  })
  const waitSelect = count => page.waitForFunction(n => window.fixture.selects.length >= n, count)
  const waitLabel = value => page.waitForFunction(text =>
    document.querySelector('.t3mp-trigger .t3mp-trigger-label')?.textContent === text, value)
  const clearNotices = async () => { while (await notice.count()) await notice.first().click() }
  const pick = async name => {
    await trigger.click()
    await panel.waitFor()
    await rowFor(name).first().click()
    assert.ok(await panel.isVisible())
  }
  try {
    const pickerSession = `${sessionB}-keep-picker-open`
    const targetAddress = key(pickerSession, otherModel)
    const slowControls = deferred()
    delays.set(`GET ${targetAddress}`, slowControls)
    await page.evaluate(id => window.fixture.render(id, false), pickerSession)
    await resetCounters()
    await page.evaluate(() => window.fixture.delaySelect(Infinity))
    await reopen()
    await choose(speed, 'End')
    const target = rowFor(otherModel).first()
    await target.focus()
    await page.keyboard.press('Enter')
    await panel.getByText('Switching model…').waitFor()
    assert.equal(await target.getAttribute('aria-checked'), 'true')
    assert.ok(await panel.getByRole('textbox').evaluate(input => document.activeElement === input))
    assert.equal(await panel.getByRole('slider').count(), 0)
    assert.equal(await trigger.locator('[data-t3mp-window], [data-t3mp-speed]').count(), 0)
    await waitSelect(1)
    assert.equal(preferences.get(key(pickerSession)).speed, 'ultrafast')
    await page.evaluate(() => window.fixture.releaseSelect())
    await panel.getByText('Loading session controls…').waitFor()
    slowControls.release()
    delays.delete(`GET ${targetAddress}`)
    await waitValue('speed', 'Fast')
    await waitValue('contextWindow', '500000 tokens')
    await choose(speed, 'End')
    await choose(windowSize, 'End')
    const savedTarget = page.waitForResponse(response => response.request().method() === 'POST')
    await target.click()
    await panel.waitFor({ state: 'hidden' })
    assert.ok((await savedTarget).ok())
    assert.equal(preferences.get(targetAddress).speed, 'ultrafast')
    assert.equal(preferences.get(targetAddress).contextWindow, 872000)
    assert.equal((await pendingSelect()).model, otherModel)
    assert.equal(await page.evaluate(() => window.fixture.selects.length), 1)

    await reopen()
    await choose(speed, 'Home')
    await page.locator('#outside').focus()
    assert.ok(await panel.isVisible())
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    assert.ok(await trigger.evaluate(button => document.activeElement === button))
    assert.equal(preferences.get(targetAddress).speed, 'ultrafast')

    await pick(model)
    await waitSelect(2)
    await rowFor(model).first().click()
    await panel.waitFor({ state: 'hidden' })
    await page.evaluate(() => window.fixture.releaseSelect())
    await trigger.locator('[data-t3mp-window]').waitFor()
    await renderSwitch(false)
    await triggerLabel().waitFor()
    assert.equal(await triggerLabel().textContent(), model)
    await resetCounters()
    const targetReadsStart = gets(key(switchSession, otherModel)).length

    // 1) The label switches immediately while the switch is still in flight, and
    //    the confirmed model's controls are not re-fetched for the target.
    await page.evaluate(() => window.fixture.delaySelect(Infinity))
    await pick(otherModel)
    await waitLabel(otherModel)
    await waitSelect(1)
    assert.deepEqual(await pendingSelect(), { sessionId: switchSession, provider, model: otherModel, reasoningEffort: 'medium' })
    assert.equal(gets(key(switchSession, otherModel)).length, targetReadsStart,
      'the picker must not load the target model controls before the switch confirms')

    // 2) No request is sent while the switch has not confirmed.
    await sendSwitch()
    await page.waitForTimeout(50)
    assert.deepEqual(await switchCounts(), [0, 0])

    // 3) Confirming the switch lets the queued request go, still showing the new model.
    await page.evaluate(() => window.fixture.releaseSelect())
    assert.equal(await sendOk(), true)
    assert.deepEqual(await switchCounts(), [1, 0])
    assert.equal(await triggerLabel().textContent(), otherModel)

    // 4) A failing switch abandons the in-flight request, rolls the label back and
    //    notifies; a later request recovers instead of staying blocked forever.
    await clearNotices()
    await resetCounters()
    await page.evaluate(() => window.fixture.failSelect('switch rejected'))
    await pick(model)
    await waitLabel(model)
    await waitSelect(1)
    await sendSwitch()
    await page.waitForTimeout(50)
    assert.deepEqual(await switchCounts(), [0, 0])
    await page.evaluate(() => window.fixture.releaseSelect())
    assert.equal(await sendOk(), false)
    assert.deepEqual(await switchCounts(), [0, 1])
    await notice.filter({ hasText: /switch rejected/ }).waitFor()
    assert.equal(await triggerLabel().textContent(), otherModel)
    await page.evaluate(() => window.fixture.failSelect(undefined))
    await sendSwitch()
    assert.equal(await sendOk(), true)
    assert.equal((await switchCounts())[0], 1)

    // 5) A switch that times out rolls the label back and notifies, and sending
    //    recovers afterwards.
    await clearNotices()
    await resetCounters()
    await page.evaluate(() => { window.fixture.delaySelect(Infinity); window.fixture.setSelectTimeout(150) })
    await pick(model)
    await waitLabel(model)
    await notice.filter({ hasText: /Request timed out/ }).waitFor()
    assert.equal(await triggerLabel().textContent(), otherModel)
    await sendSwitch()
    assert.equal(await sendOk(), true)
    assert.equal((await switchCounts())[0], 1)
    await clearNotices()
  } finally {
    await page.evaluate(() => {
      window.fixture.failSelect(undefined)
      window.fixture.delaySelect(undefined)
      window.fixture.setSelectTimeout(10000)
    })
  }

  assert.deepEqual(pageErrors, [])
  console.log(`T3 browser regression passed (${calls.length - posts().length} reads, ${posts().length} writes)`)
} finally {
  await browser.close()
}
