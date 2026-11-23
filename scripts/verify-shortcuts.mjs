/**
 * Check the picker's keyboard chords against the real component.
 *
 * Loads `client.js` into a jsdom page, mounts the component React hands the
 * composer, and dispatches real `KeyboardEvent`s at the window. Nothing inside
 * the plugin is mocked. Only the host surfaces it needs are stubbed: the slot
 * registry, the locale, the model directory and the remote catalog. The props
 * come from the seat's own `inject()`, so the component sees what the composer
 * gives it.
 *
 * The plugin itself has no dependencies, so the harness brings its own:
 *
 *   npm install --no-save react react-dom jsdom
 *   node scripts/verify-shortcuts.mjs
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLIENT = new URL('../client.js', import.meta.url)

let failures = 0
let checks = 0

function check(name, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function load(moduleName) {
  try {
    return require(moduleName)
  } catch {
    console.error(`${moduleName} is missing. Run: npm install --no-save react react-dom jsdom`)
    process.exit(2)
  }
}

const { JSDOM } = load('jsdom')

/** A subscribable store in the shape the component's `useSnapshot` expects. */
function createStore(snapshot, extra = {}) {
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setSnapshot(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
    ...extra,
  }
}

const GROUPS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
      },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ],
  },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'account-model', name: 'Account model' }] },
  { id: 'magpie', name: 'Magpie', models: [{ id: 'gateway-model', name: 'Gateway model' }] },
  { id: 'openai-codex', name: 'Codex Subscription', models: [{ id: 'codex-model', name: 'Codex model' }] },
  { id: 'custom', name: 'Custom Provider', models: [{ id: 'custom-model', name: 'Custom model' }] },
]

const CURRENT = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'medium' }

/** Boot a page, load the real client half, and hand back what a check needs. */
async function boot({ platform }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  // jsdom does no layout, so the two measurements the component asks for come
  // back empty. Stand in for a laid-out node.
  window.Element.prototype.getClientRects = function getClientRects() { return [{ width: 40, height: 28 }] }
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}

  for (const name of [
    'window', 'document', 'navigator', 'location', 'localStorage', 'Node', 'Element',
    'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'NodeFilter', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'CSS',
  ]) {
    if (window[name] !== undefined) {
      Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const React = load('react')
  const ReactDOM = load('react-dom/client')
  const { act } = React
  const h = React.createElement

  let dictionary = null
  const disposers = []
  const catalog = { ok: true, value: { routableProviders: ['deepseek', 'openai'] } }
  let seat = null
  let teamError
  const team = createStore({ enabled: false })
  const teamCalls = []
  const previousFetch = globalThis.fetch
  const apiCalls = []
  globalThis.fetch = async (url, request) => {
    apiCalls.push({ url: String(url), method: request.method })
    return new Response('Not found', { status: 404 })
  }
  const ctx = {
    effect(fn) { disposers.push(fn()) },
    on() {},
    inject(_keys, setup) { setup(ctx) },
    locale: { register(_ns, dicts) { dictionary = dicts.en } },
    remote: {
      $on() {},
      session: { modelCatalog: () => Promise.resolve(catalog) },
      agentTeams: {
        async setEnabled(sessionId, enabled) {
          teamCalls.push({ sessionId, enabled })
          if (teamError !== undefined) return { ok: false, error: { message: teamError } }
          team.setSnapshot({ enabled })
          return { ok: true }
        },
      },
    },
    slots: {
      inject(_name, loadSeat) { return loadSeat() },
      register(options, component) {
        seat = { component, props: options.inject('session-1') }
        return () => {}
      },
    },
    modelDirectories: {
      directoryFor: () => {
        const store = createStore(
          { status: 'ready', groups: GROUPS, current: CURRENT, failures: [], error: null },
          { load: () => Promise.resolve(), select: () => Promise.resolve({ ok: true }) },
        )
        return { store, load: store.load, select: store.select }
      },
    },
    sessions: { subagentAddress: () => undefined },
  }

  const loaded = []
  window.__ModuleLoader__ = { load: (definition) => { loaded.push(definition) } }
  new Function(readFileSync(CLIENT, 'utf8'))()

  const definition = loaded.find(entry => entry.id === 'dsh-t3-model-picker')
  if (definition === undefined) throw new Error('client.js did not register its module')
  // Render the plugin's dialog content through a stub of the host primitives.
  const primitives = {
    Button: ({ variant, ...props }) => h('button', { type: 'button', ...props }),
    Modal: ({ open, title, tone, className, onClose, closeLabel, footer, children }) => open
      ? require('react-dom').createPortal(h('section', {
        role: 'dialog', 'aria-modal': true, 'aria-label': title, className, 'data-tone': tone,
        'data-invoker': window.document.activeElement?.className,
      }, h('button', { onClick: onClose }, closeLabel), children, footer), window.document.body)
      : null,
  }
  definition.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name)).apply(ctx)

  const t = (key, params) => String(dictionary[key] ?? key).replace(
    /\{(\w+)\}/gu,
    (_, name) => String(params?.[name] ?? ''),
  )

  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = ReactDOM.createRoot(container)

  const render = async (count, overrides = {}) => {
    await act(async () => {
      root.render(h(
        'div',
        null,
        ...Array.from({ length: count }, (_, index) => h(
          seat.component,
          {
            ...seat.props, t, key: `seat-${index}`, sessionId: 'session-1',
            useSession: selector => selector({ subagent: null }),
            useSessions: selector => selector({ byId: {} }),
            useProjection: name => {
              const mode = React.useSyncExternalStore(team.subscribe, team.getSnapshot)
              return name === 'agentTeam' ? mode : { lastUsed: CURRENT }
            },
            ...overrides,
          },
        )),
      ))
    })
  }

  /** Dispatch a real keydown, flushed through React, and hand back the event. */
  const press = async (init, from) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    await act(async () => { (from ?? window).dispatchEvent(event) })
    return event
  }

  const click = async (node) => { await act(async () => { node.click() }) }

  return {
    window, act, render, press, click, t, team, teamCalls, apiCalls,
    failTeam: (message) => { teamError = message },
    panels: () => window.document.querySelectorAll('.t3mp-panel').length,
    triggers: () => window.document.querySelectorAll('.t3mp-trigger'),
    expanded: () => window.document.querySelectorAll('.t3mp-trigger[aria-expanded="true"]').length,
    search: () => window.document.querySelector('.t3mp-search input'),
    unmount: async () => { await act(async () => { root.unmount() }) },
    dispose: () => {
      globalThis.fetch = previousFetch
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

const MAC = { metaKey: true, shiftKey: true, code: 'KeyM', key: 'M' }
const OTHER = { ctrlKey: true, shiftKey: true, code: 'KeyM', key: 'M' }

async function main() {
  console.log('\nmacOS, Cmd+Shift:')
  const mac = await boot({ platform: 'MacIntel' })
  await mac.render(1)

  check('the card starts closed', mac.panels() === 0)
  const triggerEffort = () => mac.triggers()[0].querySelector('.t3mp-trigger-effort')
  check('the closed trigger displays the current effort', triggerEffort()?.textContent === 'Medium')

  const directory = createStore({ status: 'ready', groups: GROUPS, current: CURRENT, failures: [], error: null })
  await mac.render(1, { directory })
  const renderSelection = (current) => mac.act(() => {
    directory.setSnapshot({ ...directory.getSnapshot(), current })
  })
  await renderSelection({ ...CURRENT, reasoningEffort: 'high' })
  check('the visible effort updates with the session selection', triggerEffort()?.textContent === 'High')
  await renderSelection({ provider: CURRENT.provider, model: CURRENT.model })
  check('the visible effort falls back to the model default', triggerEffort()?.textContent === 'Medium')
  await renderSelection({ provider: 'deepseek', model: 'deepseek-chat' })
  check('the trigger omits effort for a model without a reasoning ladder', triggerEffort() === null)
  for (const [provider, model, logo] of [
    ['magpie', 'gateway-model', 'magpie'],
    ['openai-codex', 'codex-model', 'codex'],
    ['deepseek-account', 'account-model', 'deepseek'],
    ['custom', 'custom-model', 'generic'],
  ]) {
    await renderSelection({ provider, model })
    check(`the composer shows the ${logo} icon for ${provider}`, mac.triggers()[0].querySelector(
      `svg.t3mp-trigger-glyph[data-t3mp-logo="${logo}"] > path`,
    ) !== null)
  }
  await mac.render(1)

  const opened = await mac.press(MAC)
  check('Cmd+Shift+M opens the card', mac.panels() === 1, `panels=${mac.panels()}`)
  check('the chord is consumed, not passed on to the host', opened.defaultPrevented)
  for (const [provider, logo] of [
    ['deepseek-account', 'deepseek'], ['magpie', 'magpie'],
    ['openai-codex', 'codex'], ['custom', 'generic'],
  ]) {
    const tile = mac.window.document.querySelector(`[data-t3mp-rail="${provider}"]`)
    check(`the rail shows the ${logo} icon for ${provider}`, tile?.getAttribute('aria-label')
      && tile.querySelector(`svg[data-t3mp-logo="${logo}"] > path`) && tile.textContent === '')
  }
  const rowProvider = mac.window.document.querySelector('.t3mp-row-footer')
  check('model rows show only the provider name', rowProvider?.textContent === 'DeepSeek'
    && rowProvider.children.length === 1 && rowProvider.firstElementChild.matches('.t3mp-row-provider'))
  check('the search field takes focus on open', mac.search() !== null
    && mac.window.document.activeElement === mac.search())
  await mac.act(() => {
    const input = mac.search()
    const setValue = Object.getOwnPropertyDescriptor(mac.window.HTMLInputElement.prototype, 'value').set
    setValue.call(input, 'seek chat')
    input.dispatchEvent(new mac.window.Event('input', { bubbles: true }))
  })
  const results = [...mac.window.document.querySelectorAll('.t3mp-row-name')].map(row => row.textContent)
  check('multi-word search still filters models', results.length === 1 && results[0] === 'DeepSeek Chat')
  const section = mac.window.document.querySelector('.t3mp-section-head')
  check('search group headings show the provider name without an icon', section?.textContent === 'DeepSeek'
    && section.querySelector('svg') === null)

  // The same chord typed into the composer editor, not into the card.
  const editor = mac.window.document.createElement('textarea')
  mac.window.document.body.appendChild(editor)
  await mac.press(MAC, editor)
  check('Cmd+Shift+M closes the card again', mac.panels() === 0, `panels=${mac.panels()}`)

  // The bare Cmd+M text binding is not the chord, so it must survive.
  const bare = await mac.press({ metaKey: true, code: 'KeyM', key: 'm' }, editor)
  check('a bare Cmd+M is left to the text field', bare.defaultPrevented === false)
  check('a bare Cmd+M leaves the card closed', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press({ code: 'KeyM', key: 'm' })
  check('a bare M does nothing', mac.panels() === 0)

  await mac.press({ metaKey: true, code: 'KeyM', key: 'm' })
  check('Cmd+M without Shift does nothing', mac.panels() === 0)

  await mac.press({ ...MAC, altKey: true })
  check('Cmd+Alt+Shift+M does nothing', mac.panels() === 0)

  await mac.press({ ...MAC, repeat: true })
  check('a held chord does not flicker the card open', mac.panels() === 0)

  await mac.press(OTHER)
  check('Ctrl+Shift+M does nothing on macOS', mac.panels() === 0)

  await mac.press({ metaKey: true, shiftKey: true, code: 'KeyN', key: 'N' })
  check('Cmd+Shift+N does nothing', mac.panels() === 0)

  // The trigger click path, which shares `toggle` with the chord.
  await mac.click(mac.triggers()[0])
  check('clicking the trigger opens the card', mac.panels() === 1, `panels=${mac.panels()}`)
  await mac.click(mac.triggers()[0])
  check('clicking the trigger again closes it', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press(MAC)
  const effortRange = mac.window.document.querySelector('[data-t3mp-control="effort"]')
  check('a Host without session controls still offers native effort', effortRange?.type === 'range'
    && effortRange.getAttribute('aria-valuetext') === 'Medium' && effortRange.tabIndex === 0)
  check('the missing endpoint hides the optional controls without an error', mac.window.document.querySelectorAll('[data-t3mp-control]').length === 1
    && mac.window.document.querySelector('.t3mp-panel [role="alert"]') === null)
  check('opening fetches the exact active session model', mac.apiCalls.some(call => call.method === 'GET'
    && new URL(call.url).searchParams.get('sessionId') === 'session-1'
    && new URL(call.url).searchParams.get('provider') === CURRENT.provider
    && new URL(call.url).searchParams.get('model') === CURRENT.model))
  await mac.act(() => { effortRange.focus() })
  await mac.press(MAC, effortRange)
  check('the chord closes the card from the effort slider', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.press(MAC)
  await mac.press({ key: 'Escape' }, mac.search())
  check('Escape still closes the card', mac.panels() === 0, `panels=${mac.panels()}`)

  // Two seats mounted, as two live sessions would: one keystroke, one card.
  await mac.render(2)
  await mac.press(MAC)
  check('two mounted seats open exactly one card', mac.panels() === 1, `panels=${mac.panels()}`)
  check('exactly one seat reports itself open', mac.expanded() === 1, `expanded=${mac.expanded()}`)
  await mac.press(MAC)
  check('the chord closes it again', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.render(1, { locked: true })
  await mac.press(MAC)
  check('a locked seat ignores the chord', mac.panels() === 0, `panels=${mac.panels()}`)
  check('a locked seat shows a disabled trigger', mac.triggers()[0]?.disabled === true)

  await mac.render(1, { available: false })
  await mac.press(MAC)
  check('an unavailable seat ignores the chord', mac.panels() === 0, `panels=${mac.panels()}`)

  await mac.render(1)
  check('the trigger tooltip advertises ⌘⇧M on macOS', mac.triggers()[0].title.endsWith('⌘⇧M'), mac.triggers()[0].title)

  await renderSelection({ provider: 'deepseek', model: 'deepseek-chat' })
  await mac.render(1, { directory })
  await mac.press(MAC)
  const teamSwitch = () => mac.window.document.querySelector('.t3mp-team-switch')
  check('a model without effort still offers Team in a root session', teamSwitch()?.checked === false
    && mac.window.document.querySelector('[data-t3mp-control="effort"]') === null)
  await mac.click(teamSwitch())
  check('enabling targets the current session', mac.teamCalls[0]?.sessionId === 'session-1'
    && mac.teamCalls[0]?.enabled === true)
  check('the switch shows the saved Team projection', teamSwitch()?.checked === true)
  await mac.press(MAC)
  await mac.press(MAC)
  check('reopening the menu shows Team already enabled', teamSwitch()?.checked === true)

  mac.window.confirm = () => { throw new Error('Browser confirmation must not be used') }
  const dialog = () => mac.window.document.querySelector('.t3mp-disable-dialog')
  const action = (label) => [...dialog().querySelectorAll('button')].find(button => button.textContent === label)
  await mac.click(teamSwitch())
  check('disabling opens the application warning dialog after closing the picker', mac.panels() === 0
    && dialog()?.dataset.tone === 'warning' && dialog()?.dataset.invoker === 't3mp-trigger')
  check('the dialog asks the host to focus Cancel first', action('Cancel')?.hasAttribute('data-modal-autofocus'))
  await mac.press(MAC)
  check('the model shortcut does not reopen the picker over the confirmation', mac.panels() === 0 && dialog() !== null)
  await mac.click(action('Cancel'))
  check('cancelling leaves Team enabled', dialog() === null
    && mac.teamCalls.length === 1 && mac.team.getSnapshot().enabled)

  await mac.press(MAC)
  await mac.click(teamSwitch())
  mac.failTeam('Team write refused')
  await mac.click(action('Disable'))
  check('a failed confirmation stays open with an error and can be retried', mac.team.getSnapshot().enabled
    && dialog()?.querySelector('[role="alert"]')?.textContent.includes('Team write refused')
    && action('Disable')?.disabled === false)
  mac.failTeam(undefined)
  await mac.click(action('Disable'))
  check('confirming disable saves the change for the same session and closes the dialog', dialog() === null
    && mac.teamCalls[2]?.sessionId === 'session-1' && mac.teamCalls[2]?.enabled === false
    && !mac.team.getSnapshot().enabled)

  await mac.press(MAC)
  mac.failTeam('Team write refused')
  await mac.click(teamSwitch())
  check('failed writes report the error without changing the saved mode', teamSwitch()?.checked === false
    && mac.window.document.querySelector('.t3mp-toast')?.textContent.includes('Team write refused'))
  await mac.render(1, { directory, useSessions: selector => selector({ byId: { 'session-1': { origin: 'subagent' } } }) })
  check('listed subagents do not expose the Team switch', teamSwitch() === null)

  await mac.unmount()
  await mac.press(MAC)
  check('an unmounted seat releases the chord', mac.panels() === 0, `panels=${mac.panels()}`)
  mac.dispose()

  console.log('\nWindows and Linux, Ctrl+Shift:')
  const pc = await boot({ platform: 'Win32' })
  await pc.render(1)
  check('the tooltip advertises Ctrl+Shift+M off macOS', pc.triggers()[0].title.endsWith('Ctrl+Shift+M'), pc.triggers()[0].title)
  await pc.press(MAC)
  check('Cmd+Shift+M does nothing off macOS', pc.panels() === 0, `panels=${pc.panels()}`)
  await pc.press(OTHER)
  check('Ctrl+Shift+M opens the card', pc.panels() === 1, `panels=${pc.panels()}`)
  await pc.press(OTHER)
  check('Ctrl+Shift+M closes the card', pc.panels() === 0, `panels=${pc.panels()}`)

  // A layout where M is not the letter m, such as Dvorak or a non-Latin one.
  await pc.press({ ctrlKey: true, shiftKey: true, code: 'KeyM', key: 'ь' })
  check('the chord follows the physical key, not the layout', pc.panels() === 1, `panels=${pc.panels()}`)

  await pc.unmount()
  pc.dispose()

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
