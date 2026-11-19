/**
 * Client half of the T3 model picker.
 *
 * A port of the model selector from T3 Code
 * (https://github.com/pingdotgg/t3code), by the T3 Code authors under MIT.
 * The shape, the search ranking, the favorites model, and the jump chords are
 * theirs; only the data underneath is DeepSeek Harness's.
 *
 * Registers a second occupant of the composer's `conversation.input.model`
 * seat at priority -1, so it shadows the shipped ModelSelect (same cell,
 * different priority = shadowing) while reading the SAME per-session model
 * directory (`ctx.modelDirectories`) that seat and the `/model` popup use.
 * A switch made here is what those surfaces show next.
 *
 * Shape and behavior follow T3 Code's ProviderModelPicker: a 44px provider
 * rail on the left (Favorites first), a borderless search field at the top of
 * the results column, model rows that carry a provider footer line, a star
 * toggle per row, and Cmd/Ctrl+1..9 jump shortcuts for the first nine rows of
 * the visible list. Four deliberate departures:
 *   - search results are grouped under provider headings, where T3 renders one
 *     flat ranked list;
 *   - a footer row keeps the reasoning-effort selector reachable, since the
 *     shadowed seat was the only surface that exposed it in the composer;
 *   - the row of the model in use carries a check mark, because this seat is
 *     single-select and the trigger is not always in view;
 *   - Cmd/Ctrl+Shift+M opens and closes the card, which T3 leaves to the
 *     trigger alone, so the picker answers a chord while the composer holds
 *     focus.
 */

window.__ModuleLoader__.load({
  id: 'dsh-t3-model-picker',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const {
      useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 't3ModelPicker'

    /** Favorites persistence key; the value is a JSON array of `{ provider, model }`. */
    const FAVORITES_KEY = 'dsh.t3-model-picker.favorites.v1'

    /** Number of models reachable through the jump chord (Cmd/Ctrl+1..9). */
    const JUMP_COUNT = 9

    /** Score subtracted from a favorite so favorites win near-ties (T3's boost). */
    const FAVORITE_SCORE_BOOST = 24

    const EN = {
      'trigger.fallback': 'Select model',
      'trigger.loading': 'Loading models…',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'badge.unavailable': 'Unavailable',
      'search.placeholder': 'Search models...',
      'panel.aria': 'Model picker',
      'rail.aria': 'Providers',
      'rail.favorites': 'Favorites',
      'favorite.add': 'Add to favorites',
      'favorite.remove': 'Remove from favorites',
      'empty.models': 'No models found',
      'status.loading': 'Loading models…',
      'error.load': 'Catalog failed to load: {message}',
      'error.action': 'Model selection failed: {message}',
      'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
      'action.retry': 'Retry',
      'effort.row': 'Effort',
      'effort.title': 'Reasoning effort',
      'effort.providerDefault': 'Default',
      'effort.back': 'Back to models',
      'team.label': 'Enable agent teamwork',
      'team.disableTitle': 'Disable agent teamwork?',
      'team.disableDescription': 'Disabling agent teamwork during a conversation stops the use of shared task tools and team coordination instructions.',
      'team.disableWarning': 'Disabling it may affect cache reuse, increase subsequent token usage and costs, and affect collaboration on the current task.',
      'team.disableConfirm': 'Disable',
      'team.disableCancel': 'Cancel',
      'team.disableClose': 'Close',
      'team.failed': 'Could not save agent teamwork: {message}',
      'warning.groupLoad': '{name} failed to load: {message}',
      'group.models': '{count} models',
      'shortcut.aria': 'Shortcut {label}',
    }

    const ZH = {
      'trigger.fallback': '选择模型',
      'trigger.loading': '正在加载模型…',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
      'badge.unavailable': '不可用',
      'search.placeholder': '搜索模型...',
      'panel.aria': '模型选择器',
      'rail.aria': '提供方',
      'rail.favorites': '收藏',
      'favorite.add': '添加收藏',
      'favorite.remove': '取消收藏',
      'empty.models': '没有匹配的模型',
      'status.loading': '正在加载模型…',
      'error.load': '模型目录加载失败：{message}',
      'error.action': '模型切换失败：{message}',
      'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
      'action.retry': '重试',
      'effort.row': '推理等级',
      'effort.title': '推理等级',
      'effort.providerDefault': '默认',
      'effort.back': '返回模型列表',
      'team.label': '启用智能体团队协作',
      'team.disableTitle': '确认停用智能体团队协作？',
      'team.disableDescription': '对话过程中停用智能体团队协作，将停止共享任务工具和团队协调指令。',
      'team.disableWarning': '停用后可能影响缓存复用、增加后续 token 用量与开销，并影响当前任务的协作效果。',
      'team.disableConfirm': '确认停用',
      'team.disableCancel': '取消',
      'team.disableClose': '关闭',
      'team.failed': '无法保存智能体团队协作设置：{message}',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'group.models': '{count} 个模型',
      'shortcut.aria': '快捷键 {label}',
    }

    // ---------------------------------------------------------------- search

    /** Lowercase and trim; the scoring tiers expect pre-normalized inputs. */
    function normalize(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : ''
    }

    /** Subsequence score with first-index, gap, span, and length penalties. */
    function scoreSubsequence(value, query) {
      if (query === '') return 0
      let queryIndex = 0
      let firstMatchIndex = -1
      let previousMatchIndex = -1
      let gapPenalty = 0
      for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
        if (value[valueIndex] !== query[queryIndex]) continue
        if (firstMatchIndex === -1) firstMatchIndex = valueIndex
        if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1
        previousMatchIndex = valueIndex
        queryIndex += 1
        if (queryIndex === query.length) {
          const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length
          return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty(value, query)
        }
      }
      return null
    }

    function lengthPenalty(value, query) {
      return Math.min(64, Math.max(0, value.length - query.length))
    }

    function boundaryIndex(value, query, markers) {
      let best = null
      for (const marker of markers) {
        const at = value.indexOf(marker + query)
        if (at === -1) continue
        const index = at + marker.length
        if (best === null || index < best) best = index
      }
      return best
    }

    function scoreQueryMatch(input) {
      const { value, query } = input
      if (value === '' || query === '') return null
      if (value === query) return input.exactBase
      if (value.startsWith(query)) return input.prefixBase + lengthPenalty(value, query)
      const boundary = boundaryIndex(value, query, [' ', '-', '_', '/'])
      if (boundary !== null) return input.boundaryBase + boundary * 2 + lengthPenalty(value, query)
      const includes = value.indexOf(query)
      if (includes !== -1) return input.includesBase + includes * 2 + lengthPenalty(value, query)
      if (input.fuzzyBase !== undefined && query.length >= 3) {
        const fuzzy = scoreSubsequence(value, query)
        if (fuzzy !== null) return input.fuzzyBase + fuzzy
      }
      return null
    }

    /** Concatenated searchable text; also the deterministic tie-breaker. */
    function searchText(row) {
      return normalize([
        row.model.name, row.model.description, row.provider, row.providerName,
      ].filter(value => typeof value === 'string' && value.length > 0).join(' '))
    }

    /** Tiered tokenized score over the row's searchable fields; null means no match. */
    function scoreRow(row, query) {
      const tokens = normalize(query).split(/\s+/).filter(token => token.length > 0)
      if (tokens.length === 0) return 0
      const name = normalize(row.model.name)
      const description = normalize(row.model.description)
      const provider = normalize(row.provider)
      const providerName = normalize(row.providerName)
      const combined = searchText(row)
      const fields = description === ''
        ? [name, provider, providerName, combined]
        : [name, description, provider, providerName, combined]
      let score = 0
      for (const token of tokens) {
        let best = null
        for (let index = 0; index < fields.length; index += 1) {
          const value = fields[index]
          if (value === '') continue
          const fieldScore = scoreQueryMatch({
            value,
            query: token,
            exactBase: index * 10,
            prefixBase: index * 10 + 2,
            boundaryBase: index * 10 + 4,
            includesBase: index * 10 + 6,
            ...(token.length >= 3 ? { fuzzyBase: index * 10 + 100 } : {}),
          })
          if (fieldScore !== null && (best === null || fieldScore < best)) best = fieldScore
        }
        if (best === null) return null
        score += best
      }
      return row.favorite ? score - FAVORITE_SCORE_BOOST : score
    }

    // ------------------------------------------------------------- shortcuts

    /** Whether this platform renders the Command glyph. */
    function isCommandPlatform() {
      const platform = typeof navigator === 'undefined' ? '' : String(navigator.platform ?? '')
      return /mac|iphone|ipad|ipod/i.test(platform)
    }

    /** The Cmd/Ctrl+N label for the Nth (0-based) jump slot. */
    function jumpLabel(index) {
      return `${isCommandPlatform() ? '⌘' : 'Ctrl+'}${index + 1}`
    }

    /** The jump index for a keydown event, or null. */
    function jumpIndexFromEvent(event) {
      const primary = isCommandPlatform() ? event.metaKey : event.ctrlKey
      if (!primary || event.shiftKey || event.altKey) return null
      if (!/^[1-9]$/u.test(event.key)) return null
      return Number(event.key) - 1
    }

    /** The Cmd/Ctrl+Shift+M label for the open/close chord. */
    function toggleLabel() {
      return isCommandPlatform() ? '⌘⇧M' : 'Ctrl+Shift+M'
    }

    /**
     * Whether a keydown is the open/close chord: Cmd/Ctrl+Shift+M, with no Alt
     * beside it and no auto-repeat, so holding the chord does not flicker the
     * card. Shift is part of the chord, which keeps the bare Cmd/Ctrl+M text
     * binding in the composer working.
     */
    function isToggleChord(event) {
      const primary = isCommandPlatform() ? event.metaKey : event.ctrlKey
      if (!primary || !event.shiftKey || event.altKey || event.repeat) return false
      return event.code === 'KeyM' || String(event.key).toLowerCase() === 'm'
    }

    // ----------------------------------------------------------- toggle chord

    /** Whether a node is in the document and actually laid out. */
    function isRendered(node) {
      return node?.isConnected === true && node.getClientRects().length > 0
    }

    /**
     * The mounted pickers, in mount order. The chord is document-wide and the
     * card has to answer it while closed, so one listener in `apply` serves
     * every seat; the seat that takes the keystroke is the last mounted one
     * still on screen and not locked.
     */
    const mountedPickers = new Set()

    /** The picker the toggle chord drives, or null when none can take it. */
    function toggleTarget() {
      let target = null
      for (const picker of mountedPickers) {
        if (picker.enabled()) target = picker
      }
      return target
    }

    // ------------------------------------------------------------- favorites

    function readFavorites() {
      try {
        const raw = window.localStorage.getItem(FAVORITES_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter(entry => entry !== null && typeof entry === 'object'
            && typeof entry.provider === 'string' && typeof entry.model === 'string')
          .map(entry => ({ provider: entry.provider, model: entry.model }))
      } catch (error) {
        console.warn('[t3-model-picker] favorites were not readable:', error)
        return []
      }
    }

    /** Favorites as one subscribable value, persisted to localStorage per toggle. */
    function createFavoritesStore() {
      let value = readFavorites()
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /**
         * Add or remove one `provider/model` entry.
         * @param provider - the provider id.
         * @param model - the provider-owned model id.
         */
        toggle(provider, model) {
          const present = value.some(entry => entry.provider === provider && entry.model === model)
          value = present
            ? value.filter(entry => !(entry.provider === provider && entry.model === model))
            : [...value, { provider, model }]
          try {
            window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(value))
          } catch (error) {
            console.warn('[t3-model-picker] favorites were not persisted:', error)
          }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ---------------------------------------------------------- availability

    /**
     * The Host catalog's routable provider list, which is what marks a
     * provider "Unavailable" in the picker. The shared model directory does
     * not carry it, so this reads the same `session/modelCatalog` RPC once
     * per Host generation and refreshes on the events that can change it.
     *
     * @param remote - the client remote service.
     * @returns a snapshot store of `{ status, providers }`.
     */
    function createRoutableStore(remote) {
      let value = { status: 'idle', providers: [] }
      const listeners = new Set()
      let inflight
      const publish = (next) => {
        value = next
        for (const listener of [...listeners]) listener()
      }
      const load = () => {
        if (inflight !== undefined) return inflight
        publish({ status: 'loading', providers: value.providers })
        inflight = Promise.resolve()
          .then(() => remote.session.modelCatalog())
          .then((response) => {
            if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
            publish({ status: 'ready', providers: [...response.value.routableProviders] })
          })
          .catch((error) => {
            console.warn('[t3-model-picker] provider availability unavailable:', error)
            publish({ status: 'error', providers: [] })
          })
          .finally(() => { inflight = undefined })
        return inflight
      }
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        load,
      }
    }

    // ------------------------------------------------------------------ icons

    function icon(children, props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        ...props,
      }, children)
    }

    function SearchIcon(props) {
      return icon([h('circle', { cx: 11, cy: 11, r: 8, key: 'c' }), h('path', { d: 'm21 21-4.3-4.3', key: 'p' })], props)
    }

    function ChevronDownIcon(props) {
      return icon(h('path', { d: 'm6 9 6 6 6-6' }), props)
    }

    function ChevronRightIcon(props) {
      return icon(h('path', { d: 'm9 18 6-6-6-6' }), props)
    }

    function CheckIcon(props) {
      return icon(h('path', { d: 'M20 6 9 17l-5-5' }), props)
    }

    function StarIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: props.filled === true ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        className: props.className,
      }, h('polygon', {
        points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
      }))
    }

    /** A slug-shaped provider name (`command-code`, `opencode_go`) as words. */
    function displayProviderName(name) {
      const value = String(name ?? '')
      if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/u.test(value) || !/[_-]/u.test(value)) return value
      return value
        .split(/[_-]+/u)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    }

    // Brand paths and their licenses are recorded in THIRD_PARTY_NOTICES.txt.
    const LOGO_PATHS = {
      deepseek: "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z",
      codex: "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
      openai: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
      magpie: "M1.5 5.5C1.3 5.7 1.2 6.5 1.2 6.9C1.2 6.9 1.2 7 1.2 7.1C1.1 7.4 1.3 8 1.4 8.3C1.4 8.4 1.5 8.5 1.5 8.7C1.5 8.9 1.7 9 1.8 9.3C2.2 9.9 2.2 10 2.3 10.1C2.4 10.2 2.5 10.3 2.6 10.5C2.8 10.8 3 11.1 3.2 11.3C3.3 11.3 3.4 11.6 3.6 11.8C3.8 12 4.1 12.4 4.2 12.5C4.7 13 5.2 13.7 5.4 13.9C6 14.5 6.5 15.1 6.7 15.3C6.7 15.4 6.9 15.5 6.9 15.7C7.3 15.9 7.7 16.5 7.9 16.8C7.9 16.8 8 16.9 8 16.9C8.1 16.9 8.2 17.2 8.2 17.3C8.2 17.3 8.1 17.2 8.1 17.1C7.9 16.9 7.9 16.9 7.6 16.6C7.5 16.5 7.4 16.5 7.4 16.3C7.2 16.2 6.7 15.7 6.3 15.2C6.1 15.1 6 14.9 6 14.9C5.9 14.8 5.7 14.7 5.7 14.6C5.6 14.5 5.4 14.3 5.3 14.2C5.1 14.1 4.9 13.8 4.7 13.5C4.5 13.3 4.2 13.1 4.1 12.9C4.1 12.9 3.8 12.7 3.8 12.5C3.5 12.3 3 11.8 2.8 11.4C1.8 10.5 0.9 9.6 0.7 9.6C0.6 9.7 0.6 9.8 0.5 10C0.5 10.1 0.6 10.2 0.5 10.3C0.5 10.4 0.6 10.5 0.6 10.6C0.5 10.7 0.5 10.9 0.6 11C0.5 11.1 0.6 11.4 0.6 11.5C0.9 12.9 1.3 13.8 2.8 14.9C2.9 15.1 3.3 15.3 3.4 15.4C3.4 15.5 3.6 15.6 3.7 15.7C4.2 16 6.4 17.8 7 18.4C7.4 18.8 7.4 18.8 7.5 18.9C7.6 19 7.7 19 7.7 19.1C7.7 19.2 7.8 19.2 7.9 19.2C7.9 19.3 8.1 19.4 8.1 19.5C8.2 19.6 8.2 19.7 8.3 19.7C8.3 19.7 8.3 19.7 8.2 19.7C8.2 19.6 8.1 19.6 8 19.6C7.9 19.5 7.9 19.4 7.8 19.4C7.7 19.3 7.6 19.2 7.6 19.2C7.6 19.1 7.5 19 7.3 18.9C7.2 18.9 6.9 18.6 6.7 18.4C6.1 17.8 4.5 16.6 3.5 16C3.4 15.8 3 15.6 2.9 15.5C2.6 15.3 1.5 14.6 0.9 14.3C0.7 14.1 0.6 14.1 0.6 14.2C0.5 14.5 0.8 15.9 0.9 16.1C0.9 16.2 1 16.2 0.9 16.3C1.2 16.8 1.9 17.6 2.7 18.3C2.8 18.5 4 19.2 4.7 19.5C6.2 20.5 6.6 20.7 7.4 21.5C8.2 22.2 8.7 22.7 9.3 23.6C9.5 24.1 9.9 24.4 10.3 25.3C10.4 25.5 10.5 25.8 10.5 25.8C10.7 25.8 10.8 25.7 11 25.4C11.6 25 11.9 24.6 12.3 24.3C12.8 24 13 23.8 13 23.7C13.1 23.7 13.1 23.8 13 24C12 24.8 11 26 10.2 26.9C10.1 27.1 9.9 27.5 9.7 27.7C9.5 27.8 9.4 28 9.4 28C9.4 28 9.3 28.3 9.1 28.5C8.6 29.2 7.7 30.8 7.7 30.9C7.7 31 7.8 31 8.3 30.8C9 30.4 9.5 30.2 10.4 30C11.7 29.6 12.5 29.6 11.6 30C10.5 30.2 9.7 30.6 9.2 31.2C8.8 31.7 8.8 31.7 9.3 31.7C10.1 31.8 10.9 31.9 11.6 32.2C12.8 32.7 13.5 33.1 15.5 34.8C16.4 35.5 17.3 36.2 17.8 36.4C17.9 36.5 18.1 36.7 18.2 36.8C19.1 37.3 21.2 38.1 22.3 38.3C22.4 38.3 22.7 38.3 22.8 38.3C22.8 38.5 23 38.5 23 38.5C23.1 38.5 23.2 38.5 23.3 38.5C23.6 38.6 25.9 38.6 26.1 38.5C26.2 38.5 26.3 38.5 26.4 38.5C26.5 38.5 26.6 38.5 26.7 38.3C26.7 38.3 27 38.3 27.1 38.3C28.3 38.1 30.2 37.3 31.4 36.7C31.5 36.7 31.7 36.4 31.8 36.4C32.2 36.2 33.2 35.4 33.4 35.2C34.2 34.5 35.5 33 35.8 32.6C35.8 32.5 36 32.2 36.1 32C36.4 31.8 36.6 31.4 36.6 31.2C36.7 31.1 36.8 30.9 36.9 30.8C37.2 30.4 37.5 29.6 37.7 29.2C37.7 29.1 37.8 28.7 37.9 28.7C38.1 28.5 38.4 27.1 38.5 26.8C39 25.2 39.1 23.7 39 22.4C39 22.2 38.9 21.9 38.9 21.8C38.9 21.7 38.9 21.6 38.9 21.4C38.6 20.5 38.5 19.9 38.2 19C37.9 18.5 37.5 17.5 37.3 17.2C37 16.8 36.8 15.8 36.8 15.2C36.8 13.8 37.7 12.7 39.6 12.2C40.1 12.1 41.3 11.8 42.1 11.7C43.5 11.5 43.5 11.5 43.4 11.3C42.9 10.7 40.9 9.9 39.2 9.7C37.9 9.5 38.1 9.5 37.6 9C37 8.6 36.4 8 36 7.9C36 7.8 35.8 7.8 35.7 7.7C35.1 7.3 34.2 7 33.1 6.9C32.6 6.7 31.6 6.9 31 7C29.6 7.3 28.3 8 27.3 9.2C26.7 9.8 26.2 10.8 25.7 11.7C25.5 12.1 24.8 13.4 24.7 13.7C24.6 13.9 24.5 14.1 24.1 14.7C23.5 15.7 22.1 16.9 20.6 17.8C20.5 18 20.3 18.2 20.1 18.3C19.7 18.5 19.4 18.8 19.1 19C18.9 19.1 18.7 19.3 18.5 19.4C18 19.8 17.2 20.3 17 20.5C16.9 20.5 16.8 20.6 16.7 20.7C16.3 20.8 16.1 20.9 16 20.9C15.5 20.8 14.9 20.5 14.2 20.2C13.7 19.8 12.7 18.9 12.4 18.6C12.3 18.5 12.2 18.4 12.1 18.2C11.9 18 11.2 17.1 11 16.6C10.9 16.5 10.8 16.4 10.7 16.3C10.7 16.2 10.6 16.1 10.6 15.9C10.5 15.9 10.4 15.7 10.4 15.6C10.3 15.5 10.2 15.2 10.1 15C10 14.8 9.8 14.4 9.7 14.2C9.6 14 9.5 13.7 9.4 13.6C9.4 13.4 9.3 13.2 9.2 13C9.2 12.8 9 12.6 9 12.5C8.9 12.3 8.7 12.1 8.7 12C8.7 12 8.5 11.7 8.5 11.7C8.3 11.2 8.2 10.9 7.5 10C6.4 8.3 4.2 6.4 2.7 5.8C2 5.5 1.6 5.4 1.5 5.5ZM28.4 16.7C29.2 16.9 29.7 17.2 29.9 17.7C30.1 18.2 30 18.9 29.6 19.4C29.2 19.9 28.2 20.9 27.6 21.2C26.8 21.7 25.3 22.4 24.2 22.7C23.9 22.8 23.6 22.9 23.5 22.9C22.8 23.2 20.7 23.7 19.6 24C19 24.2 18.4 24.3 18.1 24.4C17.9 24.4 16.1 24.9 15.3 25.1C14.6 25.2 14.7 25.1 15.7 23.6C16.4 22.7 18.5 20.6 19.4 19.9C20.8 18.8 21.4 18.4 23.2 17.6C23.8 17.4 25.6 16.8 25.9 16.8C25.9 16.8 26.3 16.8 26.6 16.7C26.8 16.7 28.2 16.7 28.4 16.7ZM30.4 20.2C30.5 20.3 30.6 20.6 30.6 20.7C31.7 23.1 33.4 24.6 35.6 25.3C36.1 25.5 36.7 25.7 37.2 25.8C37.7 25.8 37.8 25.9 37.8 26.1C37.7 26.2 37.7 26.3 37.7 26.5C37.7 26.6 37.7 26.8 37.6 27C37.4 28.5 36.8 29.9 36.1 31C36.1 31.2 35.9 31.4 35.9 31.6C35.7 31.9 35.2 32.6 34.7 33.3C32.6 35.6 29.7 37.3 26.6 37.8C26.5 37.8 26.3 37.9 26.2 37.9C25.8 37.9 23.7 37.9 23.3 37.9C23.2 37.9 23 37.8 22.9 37.8C21.1 37.6 19.3 36.8 18 35.7C17.7 35.4 17 34.7 16.8 34.5C16.3 33.8 16.1 33 16.3 32.5C16.5 31.8 16.8 31.6 17.9 31.1C19.1 30.5 19.4 30.4 20.2 30C21.4 29.4 23.2 28.4 23.9 27.9C23.9 27.8 24.2 27.7 24.5 27.6C26.3 26.3 28 24.6 28.9 22.9C29.5 22.2 29.7 21.6 29.9 20.7C30.1 20 30.2 19.9 30.4 20.2Z",
    }
    const PROVIDER_LOGOS = new Map([
      ['deepseek', 'deepseek'], ['deepseek-account', 'deepseek'], ['deepseek-official', 'deepseek'],
      ['magpie', 'magpie'], ['dsh-magpie-connect', 'magpie'],
      ['openai-codex', 'codex'], ['codex-subscription', 'codex'], ['openai', 'openai'],
    ])

    function ProviderLogo({ providerId, className }) {
      const brand = PROVIDER_LOGOS.get(providerId)
      return h('svg', {
        className,
        viewBox: brand === 'magpie' ? '0 0 44 44' : '0 0 24 24',
        'data-t3mp-logo': brand ?? 'generic',
        'aria-hidden': true,
        focusable: false,
      }, brand === undefined
        ? h('path', { d: 'M4 5h16v5H4zm0 9h16v5H4zm4-6h.01m0 9h.01', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })
        : h('path', { d: LOGO_PATHS[brand], fill: 'currentColor', fillRule: 'evenodd' }))
    }

    // ------------------------------------------------------------------ store

    /** Subscribe a component to one snapshot store. */
    function useSnapshot(store) {
      const subscribe = useCallback(listener => store.subscribe(listener), [store])
      const getSnapshot = useCallback(() => store.getSnapshot(), [store])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    // ------------------------------------------------------------------- view

    const PANEL_WIDTH = 360
    const PANEL_MAX_HEIGHT = 346
    const PANEL_MARGIN = 12

    /**
     * The composer's model seat: trigger plus, while open, the T3-shaped card.
     * @param props - owner share (`locked`), the injected face, and the `t` seat.
     * @returns the seated control.
     */
    function ModelPicker({
      locked, available, directory, load, select, favorites, routable, teamRemote,
      sessionId, useProjection, useSession, useSessions, t,
    }) {
      const state = useSnapshot(directory)
      const catalog = useSnapshot(routable)
      const favoriteList = useSnapshot(favorites)
      const setTeamEnabled = useSnapshot(teamRemote)
      const teamMode = useProjection('agentTeam')
      const modelSelection = useProjection('modelSelection')
      const addressedChild = useSession(snapshot => snapshot.subagent !== null)
      const listedChild = useSessions(snapshot => snapshot.byId[sessionId]?.origin === 'subagent')
      const [teamPending, setTeamPending] = useState(false)
      const [disableRequest, setDisableRequest] = useState(null)

      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('favorites')
      const [query, setQuery] = useState('')
      const [highlight, setHighlight] = useState(0)
      const [menuPos, setMenuPos] = useState(null)
      const [toast, setToast] = useState(null)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const panelRef = useRef(null)
      const searchRef = useRef(null)
      const railRef = useRef(null)
      const rowRefs = useRef([])
      const toastSeq = useRef(0)
      const lastActionRef = useRef('load')

      const groups = state.groups
      const current = state.current
      const favoriteKeys = useMemo(
        () => new Set(favoriteList.map(entry => `${entry.provider}\u0000${entry.model}`)),
        [favoriteList],
      )
      const routableKnown = catalog.status === 'ready'
      const routableSet = useMemo(() => new Set(catalog.providers), [catalog.providers])

      /** Every advertised model with the provider facts the rows render. */
      const allRows = useMemo(() => {
        const rows = []
        groups.forEach((group, groupIndex) => {
          group.models.forEach((model, modelIndex) => {
            const key = `${group.id}\u0000${model.id}`
            rows.push({
              key,
              provider: group.id,
              providerName: displayProviderName(group.name),
              model,
              groupIndex,
              modelIndex,
              favorite: favoriteKeys.has(key),
              unavailable: routableKnown && !routableSet.has(group.id),
            })
          })
        })
        return rows
      }, [groups, favoriteKeys, routableKnown, routableSet])

      const rowByKey = useMemo(() => new Map(allRows.map(row => [row.key, row])), [allRows])
      const currentRow = current === null
        ? undefined
        : rowByKey.get(`${current.provider}\u0000${current.model}`)
      const reasoning = currentRow?.model.reasoning
      const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined
        ? undefined
        : effectiveEffort === undefined
          ? t('effort.providerDefault')
          : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort

      /** The provider list the rail renders, in catalog order. */
      const providers = useMemo(
        () => groups.map(group => ({ id: group.id, name: displayProviderName(group.name) })),
        [groups],
      )

      const searching = normalize(query).length > 0

      /** The rows the results column shows, plus whether they carry provider headings. */
      const listed = useMemo(() => {
        if (searching) {
          const scored = []
          for (const row of allRows) {
            const score = scoreRow(row, query)
            if (score !== null) scored.push({ row, score })
          }
          scored.sort((left, right) => {
            if (left.score !== right.score) return left.score - right.score
            const leftFavorite = left.row.favorite ? 0 : 1
            const rightFavorite = right.row.favorite ? 0 : 1
            if (leftFavorite !== rightFavorite) return leftFavorite - rightFavorite
            if (left.row.groupIndex !== right.row.groupIndex) return left.row.groupIndex - right.row.groupIndex
            if (left.row.modelIndex !== right.row.modelIndex) return left.row.modelIndex - right.row.modelIndex
            return searchText(left.row).localeCompare(searchText(right.row))
          })
          const sections = []
          const byProvider = new Map()
          for (const { row } of scored) {
            let section = byProvider.get(row.provider)
            if (section === undefined) {
              section = { id: row.provider, name: row.providerName, rows: [], unavailable: row.unavailable }
              byProvider.set(row.provider, section)
              sections.push(section)
            }
            section.rows.push(row)
          }
          return { grouped: true, sections, rows: scored.map(entry => entry.row) }
        }
        if (pane === 'favorites') {
          const rows = allRows
            .filter(row => row.favorite)
            .sort((left, right) => (left.groupIndex - right.groupIndex) || (left.modelIndex - right.modelIndex))
          return { grouped: false, sections: [], rows }
        }
        const rows = allRows
          .filter(row => row.provider === pane)
          .sort((left, right) => (Number(right.favorite) - Number(left.favorite)) || (left.modelIndex - right.modelIndex))
        return { grouped: false, sections: [], rows }
      }, [allRows, pane, query, searching])

      const effortChoices = useMemo(() => {
        if (reasoning === undefined) return []
        return [
          ...reasoning.defaultEffort === undefined
            ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
            : [],
          ...reasoning.efforts.map(level => ({ key: `effort:${level.id}`, effort: level.id, label: level.name })),
        ]
      }, [reasoning, t])

      const showEffortRow = reasoning !== undefined && pane !== 'effort'
      const effortPane = pane === 'effort'

      /** Flattened display order: what the keyboard and the jump chords index into. */
      const visibleRows = useMemo(() => (effortPane
        ? effortChoices.map(choice => ({ kind: 'effort', choice }))
        : listed.rows.map(row => ({ kind: 'model', row }))), [effortChoices, effortPane, listed.rows])

      /** Cmd/Ctrl+1..9 for the first nine visible rows. */
      const jumpLabels = useMemo(() => {
        const labels = new Map()
        for (let index = 0; index < Math.min(JUMP_COUNT, visibleRows.length); index += 1) {
          const entry = visibleRows[index]
          labels.set(entry.kind === 'model' ? entry.row.key : entry.choice.key, jumpLabel(index))
        }
        return labels
      }, [visibleRows])

      const busy = state.status === 'selecting'
      const waiting = current === null && state.status === 'loading'

      const modelLabel = waiting
        ? t('trigger.loading')
        : currentRow?.model.name
          ?? (current === null ? t('trigger.fallback') : `${current.provider}/${current.model}`)
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      const triggerAria = waiting
        ? t('trigger.loading')
        : current === null
          ? t('trigger.fallback')
          : effortLabel === undefined
            ? t('trigger.aria', { model: modelLabel })
            : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
      const triggerUnavailable = currentRow?.unavailable === true
        || (current !== null && routableKnown && !routableSet.has(current.provider))

      const reload = useCallback(() => {
        lastActionRef.current = 'load'
        load()
      }, [load])

      const close = useCallback((restoreFocus) => {
        setOpen(false)
        setPane('favorites')
        setQuery('')
        setHighlight(0)
        if (restoreFocus === true) queueMicrotask(() => { triggerRef.current?.focus() })
      }, [])

      const show = useCallback(() => {
        triggerRef.current?.focus()
        setPane(favoriteList.length > 0 ? 'favorites' : (current?.provider ?? 'favorites'))
        setQuery('')
        setHighlight(0)
        setOpen(true)
        reload()
        routable.load()
      }, [current, favoriteList.length, reload, routable])

      /** What the trigger click and the toggle chord both do. */
      const toggle = useCallback(() => {
        if (open) close(true)
        else show()
      }, [close, open, show])

      const reportFailure = useCallback((text) => {
        setToast({ seq: ++toastSeq.current, text })
      }, [])

      const teamLocked = locked || busy || teamPending || modelSelection === undefined
      const confirmDisable = disableRequest?.sessionId === sessionId
      const saveTeam = async (enabled, onFailure) => {
        if (teamLocked || setTeamEnabled === undefined) return false
        setTeamPending(true)
        try {
          const result = await setTeamEnabled(sessionId, enabled)
          if (result.ok) return true
          onFailure(t('team.failed', { message: result.error.message }))
        } catch (error) {
          onFailure(t('team.failed', { message: error instanceof Error ? error.message : String(error) }))
        } finally {
          setTeamPending(false)
        }
        return false
      }

      const selectTeam = (enabled) => {
        if (teamLocked) return
        if (!enabled && modelSelection.lastUsed !== null) {
          close()
          triggerRef.current?.focus()
          setDisableRequest({ sessionId, error: null })
          return
        }
        void saveTeam(enabled, reportFailure)
      }

      const confirmTeamDisable = async () => {
        const request = disableRequest
        const saved = await saveTeam(false, (error) => {
          setDisableRequest(current => current === request ? { ...request, error } : current)
        })
        if (saved) setDisableRequest(current => current === request ? null : current)
      }

      const cancelTeamDisable = () => {
        if (!teamPending) setDisableRequest(null)
      }

      const submit = useCallback((selection) => {
        lastActionRef.current = 'select'
        triggerRef.current?.focus()
        void select(selection).then((result) => {
          if (result === undefined) return
          if (result.ok) {
            close(true)
            return
          }
          reportFailure(result.error.code === 'session/writer-held'
            ? t('error.sessionInUse')
            : t('error.action', { message: `${result.error.code}: ${result.error.message}` }))
        })
      }, [close, reportFailure, select, t])

      const chooseModel = useCallback((row) => {
        if (current !== null && current.provider === row.provider && current.model === row.model.id) {
          close(true)
          return
        }
        submit({
          provider: row.provider,
          model: row.model.id,
          ...row.model.reasoning?.defaultEffort === undefined
            ? {}
            : { reasoningEffort: row.model.reasoning.defaultEffort },
        })
      }, [close, current, submit])

      const chooseEffort = useCallback((effort) => {
        if (current === null) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        submit({
          provider: current.provider,
          model: current.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        })
      }, [close, current, effectiveEffort, submit])

      const activate = useCallback((entry) => {
        if (entry === undefined) return
        if (entry.kind === 'effort') chooseEffort(entry.choice.effort)
        else chooseModel(entry.row)
      }, [chooseEffort, chooseModel])

      // Focus the search field whenever the card opens, mirroring T3.
      useLayoutEffect(() => {
        if (!open) return
        searchRef.current?.focus({ preventScroll: true })
        const frame = window.requestAnimationFrame(() => {
          searchRef.current?.focus({ preventScroll: true })
        })
        return () => { window.cancelAnimationFrame(frame) }
      }, [open])

      // Highlight always names a live row of the shown pane.
      useEffect(() => {
        if (!open) return
        setHighlight(0)
      }, [open, pane, query])

      useEffect(() => {
        if (highlight >= visibleRows.length) setHighlight(0)
      }, [highlight, visibleRows.length])

      useEffect(() => {
        if (!open) return
        rowRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
      }, [highlight, open])

      // Outside press closes the card.
      useEffect(() => {
        if (!open) return
        const onMouseDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (panelRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onMouseDown)
        return () => { document.removeEventListener('mousedown', onMouseDown) }
      }, [open])

      // Jump chords stay document-wide so a keystroke works while the composer
      // editor or a row holds focus.
      useEffect(() => {
        if (!open) return
        const onKeyDown = (event) => {
          if (busy) return
          const index = jumpIndexFromEvent(event)
          if (index === null) return
          const entry = visibleRows[index]
          if (entry === undefined) return
          if (entry.kind === 'model' && entry.row.unavailable && entry.row.provider !== current?.provider) return
          event.preventDefault()
          event.stopPropagation()
          activate(entry)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => { window.removeEventListener('keydown', onKeyDown, true) }
      }, [activate, busy, current, open, visibleRows])

      // Lend this seat to the document-wide toggle chord. The handle reads the
      // live DOM and the current props, so it is never stale between the
      // keystroke and the render that follows it.
      useEffect(() => {
        if (!available) return undefined
        const handle = {
          enabled: () => locked !== true && isRendered(rootRef.current),
          toggle,
        }
        mountedPickers.add(handle)
        return () => { mountedPickers.delete(handle) }
      }, [available, locked, toggle])

      // Portaled placement above the trigger, right edges aligned.
      useLayoutEffect(() => {
        if (!open) { setMenuPos(null); return }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const width = panelRef.current?.offsetWidth ?? PANEL_WIDTH
          const height = panelRef.current?.offsetHeight ?? PANEL_MAX_HEIGHT
          let left = rect.right - width
          let top = rect.top - 8 - height
          left = Math.min(Math.max(left, PANEL_MARGIN), window.innerWidth - width - PANEL_MARGIN)
          top = Math.min(Math.max(top, PANEL_MARGIN), window.innerHeight - height - PANEL_MARGIN)
          setMenuPos({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, pane, query, state, listed])

      if (!available) return null

      const moveHighlight = (delta) => {
        const count = visibleRows.length
        if (count === 0) return
        setHighlight((previous) => (previous + delta + count) % count)
      }

      const onPanelKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (effortPane) {
            setPane('favorites')
            return
          }
          close(true)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const active = document.activeElement
          if (active instanceof HTMLButtonElement && active.dataset.t3mpRow !== undefined) {
            const index = rowRefs.current.indexOf(active)
            if (index !== -1) {
              event.preventDefault()
              moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
              return
            }
          }
          if (active instanceof HTMLButtonElement && active.dataset.t3mpRail !== undefined) return
          event.preventDefault()
          moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter') {
          if (document.activeElement === searchRef.current) {
            event.preventDefault()
            activate(visibleRows[highlight])
          }
        }
      }

      const onPanelBlur = (event) => {
        if (event.relatedTarget instanceof Node && (
          rootRef.current?.contains(event.relatedTarget) === true
          || panelRef.current?.contains(event.relatedTarget) === true
        )) return
        setOpen(false)
      }

      const railSelect = (id) => {
        setPane(id)
        setQuery('')
        setHighlight(0)
        searchRef.current?.focus({ preventScroll: true })
      }

      const onRailKeyDown = (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          searchRef.current?.focus({ preventScroll: true })
        }
      }

      const onSearchKeyDown = (event) => {
        if (event.key === 'ArrowRight' && query.length === 0 && !searching) {
          event.preventDefault()
          railRef.current?.querySelector('button')?.focus()
          return
        }
        if (event.key === 'Tab' && event.shiftKey && !searching) {
          event.preventDefault()
          railRef.current?.querySelector('button')?.focus()
        }
      }

      rowRefs.current = []

      const renderModelRow = (row, index) => {
        const isFavorite = favoriteKeys.has(row.key)
        const isSelected = current !== null
          && current.provider === row.provider
          && current.model === row.model.id
        const label = jumpLabels.get(row.key)
        const disabled = busy
          || (row.unavailable && current?.provider !== row.provider)
        return h('button', {
          key: row.key,
          ref: (node) => { rowRefs.current[index] = node },
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': isSelected,
          'aria-disabled': disabled || undefined,
          'data-t3mp-row': '',
          className: [
            't3mp-row',
            isSelected && 't3mp-row-selected',
            highlight === index && 't3mp-row-active',
            disabled && 't3mp-row-disabled',
          ].filter(Boolean).join(' '),
          disabled,
          onMouseEnter: () => { setHighlight(index) },
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { chooseModel(row) },
        },
          h('span', { className: 't3mp-row-main' },
            h('span', { className: 't3mp-row-title' },
              h('span', { className: 't3mp-row-name' }, row.model.name),
              row.unavailable ? h('span', { className: 't3mp-badge' }, t('badge.unavailable')) : null,
            ),
            h('span', { className: 't3mp-row-footer' },
              h('span', { className: 't3mp-row-provider' }, row.providerName),
            ),
          ),
          h('span', { className: 't3mp-row-end' },
            isSelected ? h(CheckIcon, { className: 't3mp-check' }) : null,
            label !== undefined ? h('kbd', { className: 't3mp-kbd', title: t('shortcut.aria', { label }) }, label) : null,
            h('span', {
              role: 'button',
              tabIndex: -1,
              className: isFavorite ? 't3mp-star t3mp-star-on' : 't3mp-star',
              'aria-label': isFavorite ? t('favorite.remove') : t('favorite.add'),
              'aria-pressed': isFavorite,
              title: isFavorite ? t('favorite.remove') : t('favorite.add'),
              onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
              onClick: (event) => {
                event.stopPropagation()
                favorites.toggle(row.provider, row.model.id)
              },
            }, h(StarIcon, { filled: isFavorite, className: 't3mp-star-icon' })),
          ),
        )
      }

      const renderEffortRow = (choice, index) => {
        const isSelected = effectiveEffort === choice.effort
        const label = jumpLabels.get(choice.key)
        return h('button', {
          key: choice.key,
          ref: (node) => { rowRefs.current[index] = node },
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': isSelected,
          'data-t3mp-row': '',
          className: [
            't3mp-row',
            isSelected && 't3mp-row-selected',
            highlight === index && 't3mp-row-active',
          ].filter(Boolean).join(' '),
          disabled: busy,
          onMouseEnter: () => { setHighlight(index) },
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { chooseEffort(choice.effort) },
        },
          h('span', { className: 't3mp-row-main' },
            h('span', { className: 't3mp-row-title' },
              h('span', { className: 't3mp-row-name' }, choice.label),
            ),
          ),
          h('span', { className: 't3mp-row-end' },
            isSelected ? h(CheckIcon, { className: 't3mp-check' }) : null,
            label !== undefined ? h('kbd', { className: 't3mp-kbd' }, label) : null,
          ),
        )
      }

      const renderSection = (section) => h('div', { className: 't3mp-section', key: section.id },
        h('div', { className: 't3mp-section-head' },
          h('span', { className: 't3mp-section-name' }, section.name),
          section.unavailable ? h('span', { className: 't3mp-badge' }, t('badge.unavailable')) : null,
        ),
        section.rows.map(row => renderModelRow(row, listed.rows.indexOf(row))),
      )

      const resultNodes = effortPane
        ? visibleRows.map((entry, index) => renderEffortRow(entry.choice, index))
        : listed.grouped
          ? listed.sections.map(renderSection)
          : listed.rows.map((row, index) => renderModelRow(row, index))

      const empty = state.status === 'ready' && visibleRows.length === 0

      const rail = searching ? null : h('div', {
        ref: railRef,
        className: 't3mp-rail',
        role: 'toolbar',
        'aria-label': t('rail.aria'),
        'aria-orientation': 'vertical',
        onKeyDown: onRailKeyDown,
      },
        h('div', { className: 't3mp-rail-inner' },
          h('button', {
            type: 'button',
            'data-t3mp-rail': 'favorites',
            className: pane === 'favorites' ? 't3mp-rail-button t3mp-rail-on' : 't3mp-rail-button',
            'aria-pressed': pane === 'favorites',
            'aria-label': t('rail.favorites'),
            title: t('rail.favorites'),
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { railSelect('favorites') },
          }, h(StarIcon, { filled: true, className: 't3mp-rail-icon' })),
          h('div', { className: 't3mp-rail-divider' }),
          providers.map(provider => h('button', {
            key: provider.id,
            type: 'button',
            'data-t3mp-rail': provider.id,
            className: pane === provider.id ? 't3mp-rail-button t3mp-rail-on' : 't3mp-rail-button',
            'aria-pressed': pane === provider.id,
            'aria-label': provider.name,
            title: routableKnown && !routableSet.has(provider.id)
              ? `${provider.name} — ${t('badge.unavailable')}`
              : provider.name,
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { railSelect(provider.id) },
          }, h(ProviderLogo, { providerId: provider.id, className: 't3mp-rail-glyph' }))),
        ),
      )

      const header = h('div', { className: 't3mp-search' },
        h('div', { className: 't3mp-search-inner' },
          h(SearchIcon, { className: 't3mp-search-icon' }),
          h('input', {
            ref: searchRef,
            className: 't3mp-search-input',
            type: 'text',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.placeholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => { setQuery(event.target.value) },
            onKeyDown: onSearchKeyDown,
            onMouseDown: (event) => { event.stopPropagation() },
          }),
        ),
      )

      const statusNodes = []
      if (effortPane) {
        statusNodes.push(h('div', { className: 't3mp-pane-head', key: 'pane-head' },
          h('button', {
            type: 'button',
            className: 't3mp-back',
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { setPane('favorites') },
          }, h(ChevronRightIcon, { className: 't3mp-back-icon' }), t('effort.back')),
          h('span', { className: 't3mp-pane-title' }, t('effort.title')),
        ))
      } else {
        if (state.status === 'loading') {
          statusNodes.push(h('div', { className: 't3mp-status', key: 'loading' }, t('status.loading')))
        }
        if (state.error !== null && lastActionRef.current === 'load') {
          statusNodes.push(h('div', { className: 't3mp-error', key: 'error' },
            h('span', {}, t('error.load', { message: state.error })),
            h('button', { type: 'button', className: 't3mp-retry', onClick: reload }, t('action.retry')),
          ))
        }
        for (const failure of state.failures) {
          statusNodes.push(h('div', { className: 't3mp-warning', key: `failure:${failure.id}` },
            h('span', {}, t('warning.groupLoad', { name: failure.name, message: failure.message })),
            h('button', { type: 'button', className: 't3mp-retry', onClick: reload }, t('action.retry')),
          ))
        }
      }

      const effortRow = showEffortRow && h('button', {
        type: 'button',
        className: 't3mp-effort-row',
        disabled: current === null,
        onMouseDown: (event) => { event.preventDefault() },
        onClick: () => { setPane('effort') },
      },
        h('span', { className: 't3mp-effort-label' }, t('effort.row')),
        h('span', { className: 't3mp-effort-value' }, effortLabel ?? ''),
        h(ChevronRightIcon, { className: 't3mp-effort-chevron' }),
      )

      const panel = h('div', {
        ref: panelRef,
        className: 't3mp-panel',
        style: menuPos ?? { visibility: 'hidden', left: 0, top: 0 },
        role: 'dialog',
        'aria-label': t('panel.aria'),
        onKeyDown: onPanelKeyDown,
        onBlur: onPanelBlur,
      },
        rail,
        h('div', { className: rail === null ? 't3mp-main t3mp-main-full' : 't3mp-main' },
          header,
          statusNodes,
          h('div', { className: 't3mp-list scrollable' }, resultNodes),
          empty ? h('div', { className: 't3mp-empty' }, t('empty.models')) : null,
          effortRow,
          open && !effortPane && !addressedChild && !listedChild && teamMode !== undefined && setTeamEnabled !== undefined
            ? h('label', { className: 't3mp-team-row' },
              t('team.label'),
              h('input', {
                className: 't3mp-team-switch', type: 'checkbox', role: 'switch',
                checked: teamMode.enabled, disabled: teamLocked,
                onChange: (event) => { void selectTeam(event.target.checked) },
              }),
            )
            : null,
        ),
      )

      return h(React.Fragment, null, h('div', {
        ref: rootRef,
        className: 't3mp-root',
        onBlur: onPanelBlur,
        onMouseDown: (event) => {
          if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
        },
      },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 't3mp-trigger',
          'aria-label': currentRow === undefined ? triggerAria : `${triggerAria} · ${currentRow.providerName}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: [triggerLabel, currentRow?.providerName, toggleLabel()].filter(Boolean).join(' · '),
          disabled: locked,
          onClick: toggle,
        },
          current !== null
            ? h(ProviderLogo, { providerId: current.provider, className: 't3mp-trigger-glyph' })
            : h(ChevronDownIcon, { className: 't3mp-trigger-fallback' }),
          h('span', { className: 't3mp-trigger-label' }, modelLabel),
          effortLabel === undefined
            ? null
            : h('span', { className: 't3mp-trigger-effort' }, effortLabel),
          triggerUnavailable
            ? h('span', { className: 't3mp-badge' }, t('badge.unavailable'))
            : null,
          h(ChevronDownIcon, { className: open ? 't3mp-chevron t3mp-chevron-open' : 't3mp-chevron' }),
        ),
        open ? ReactDOM.createPortal(panel, document.body) : null,
        toast === null ? null : h('div', { key: toast.seq, className: 't3mp-toast', role: 'status' }, toast.text),
      ), confirmDisable ? h(Modal, {
        open: true,
        tone: 'warning',
        title: t('team.disableTitle'),
        closeLabel: t('team.disableClose'),
        onClose: cancelTeamDisable,
        className: 't3mp-disable-dialog',
        contentClassName: 't3mp-disable-content',
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: teamPending, 'data-modal-autofocus': true, onClick: cancelTeamDisable }, t('team.disableCancel')),
          h(Button, { variant: 'primary', disabled: teamLocked, onClick: () => { void confirmTeamDisable() } }, t('team.disableConfirm')),
        ),
      },
        h('div', { className: 't3mp-disable-copy' },
          h('p', null, t('team.disableDescription')),
          h('p', null, t('team.disableWarning')),
        ),
        disableRequest.error === null ? null : h('p', { role: 'alert', className: 't3mp-disable-error' }, disableRequest.error),
      ) : null)
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
.t3mp-root { position: relative; min-width: 0; }

.t3mp-trigger {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  max-width: 220px; max-width: min(360px, 45cqw); height: 28px; padding: 0 4px 0 8px;
  border: none; border-radius: 24px; outline: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.t3mp-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.t3mp-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.t3mp-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.t3mp-trigger-label {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: var(--dsh-composer-model-text-display, block);
}
.t3mp-trigger-effort {
  flex: 0 1 auto; min-width: 0; max-width: 45%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.t3mp-trigger-glyph, .t3mp-trigger-fallback { flex: 0 0 auto; }
.t3mp-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.t3mp-chevron-open { transform: rotate(180deg); }

.t3mp-badge {
  flex: 0 0 auto; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px; color: var(--dsw-alias-label-caption);
  font-size: 10px; line-height: 15px; font-weight: 500; white-space: nowrap;
}

.t3mp-panel {
  position: fixed; z-index: 1100; display: flex; flex-direction: row;
  width: ${PANEL_WIDTH}px; max-width: calc(100vw - 24px);
  height: ${PANEL_MAX_HEIGHT}px; max-height: calc(100vh - 24px);
  overflow: hidden; padding: 0; border: 0; border-radius: 16px;
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  font-family: var(--dsw-font-family);
}

.t3mp-rail { width: 44px; flex: 0 0 44px; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.t3mp-rail-inner { display: flex; flex-direction: column; gap: 4px; padding: 4px; height: 100%; overflow-y: auto; }
.t3mp-rail-inner::-webkit-scrollbar { display: none; }
.t3mp-rail-button {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; flex: 0 0 auto; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0;
  transition: background-color 120ms ease;
}
.t3mp-rail-button:hover { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-rail-button:focus-visible { outline: none; background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-rail-on::after {
  content: ''; position: absolute; right: -4px; top: 50%; width: 3px; height: 20px;
  transform: translateY(-50%); border-radius: 999px 0 0 999px; background: var(--dsw-alias-brand-primary);
}
.t3mp-rail-divider { height: 1px; margin: 0 2px 4px; background: var(--dsw-alias-border-l1); }
.t3mp-rail-icon { color: var(--dsw-alias-label-primary); }

.t3mp-main { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 40%, transparent); }
.t3mp-main-full { border-left: none; }
.t3mp-rail + .t3mp-main { border-left: 1px solid var(--dsw-alias-border-l1); }

.t3mp-search { padding: 8px 8px 0; flex: 0 0 auto; }
.t3mp-search-inner {
  display: flex; align-items: center; gap: 6px; height: 30px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 10px;
}
.t3mp-search-inner:focus-within { border-bottom-color: var(--dsw-alias-border-l3); }
.t3mp-search-icon { flex: 0 0 auto; color: var(--dsw-alias-label-caption); opacity: 0.7; }
.t3mp-search-input {
  flex: 1 1 auto; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 26px; font-family: inherit; padding: 0;
}
.t3mp-search-input::placeholder { color: var(--dsw-alias-label-caption); }

.t3mp-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px 2px 6px 8px; }
.t3mp-status, .t3mp-empty { padding: 12px 12px; color: var(--dsw-alias-label-caption); font-size: 12px; }
.t3mp-error, .t3mp-warning {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 6px 8px; padding: 6px 8px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.t3mp-warning { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.t3mp-retry {
  border: none; background: transparent; color: var(--dsw-alias-link);
  font: inherit; cursor: pointer; padding: 0 4px; flex: 0 0 auto;
}

.t3mp-section { margin-bottom: 4px; }
.t3mp-section-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 2px; }
.t3mp-section-name { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: var(--dsw-alias-label-caption); text-transform: none; }

.t3mp-row {
  display: flex; align-items: center; gap: 12px; width: 100%; max-width: 100%; min-width: 0;
  padding: 8px; border: none; border-radius: 8px; background: transparent;
  color: inherit; text-align: left; cursor: pointer; font-family: inherit;
  transition: background-color 100ms ease, color 100ms ease;
}
.t3mp-row + .t3mp-row { margin-top: 2px; }
.t3mp-row-active, .t3mp-row:hover { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-row-selected { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.t3mp-row-selected.t3mp-row-active { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-row-disabled { opacity: 0.5; cursor: not-allowed; }
.t3mp-row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.t3mp-row-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.t3mp-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 1.35; }
.t3mp-row-footer { display: flex; min-width: 0; color: var(--dsw-alias-label-caption); }
.t3mp-row-provider { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 400; line-height: 1.35; }
.t3mp-row-end { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.t3mp-check { color: var(--dsw-alias-label-primary); flex: 0 0 auto; }
.t3mp-kbd {
  display: inline-flex; align-items: center; height: 16px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);
  color: var(--dsw-alias-label-caption); font-family: inherit; font-size: 10px; line-height: 1;
}
.t3mp-star {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-caption); opacity: 0.64; transition: opacity 100ms ease, color 100ms ease;
}
.t3mp-row:hover .t3mp-star, .t3mp-row-active .t3mp-star { opacity: 1; }
.t3mp-star-on { opacity: 1; color: #eab308; }

.t3mp-effort-row {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  margin: 0; padding: 8px 12px; border: none; border-top: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.t3mp-effort-row:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-specific-menu) 88%, var(--dsw-alias-label-primary)); }
.t3mp-effort-row:disabled { opacity: 0.5; cursor: default; }
.t3mp-effort-label { flex: 0 0 auto; color: var(--dsw-alias-label-caption); }
.t3mp-effort-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.t3mp-effort-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); }
.t3mp-team-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer;
}
.t3mp-team-row:has(:disabled) { opacity: 0.5; cursor: default; }
.t3mp-team-switch { margin: 0; flex: 0 0 auto; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }

.t3mp-disable-dialog { width: min(440px, 100%); max-height: 100%; }
.t3mp-disable-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.t3mp-disable-copy { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }
.t3mp-disable-copy p { margin: 0; }
.t3mp-disable-copy p + p { margin-top: 12px; }
.t3mp-disable-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }

.t3mp-pane-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; flex: 0 0 auto; }
.t3mp-back {
  display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent;
  color: var(--dsw-alias-link); font-family: inherit; font-size: 12px; cursor: pointer; padding: 0;
}
.t3mp-back-icon { transform: rotate(180deg); }
.t3mp-pane-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-caption); }

.t3mp-trigger-glyph, .t3mp-rail-glyph { width: 16px; height: 16px; flex: 0 0 auto; }
.t3mp-rail-glyph { width: 20px; height: 20px; }

.t3mp-toast {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 1200;
  max-width: 320px; padding: 8px 10px; border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.4;
}
`

    // ------------------------------------------------------------------ apply

    /**
     * Required client services: the seat registry, locale, the model faces, and
     * the remote namespaces. `remote.session` is listed because
     * `modelDirectories.directoryFor` runs behind the caller-context tracker,
     * and because this plugin reads the catalog for provider availability.
     */
    const inject = ['slots', 'locale', 'sessions', 'modelDirectories', 'remote', 'remote.session']

    /**
     * Client plugin body: register the plugin's dictionaries and shadow the
     * composer model seat with the T3 picker.
     * @param ctx - the plugin's client context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 't3-model-picker: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.t3ModelPicker = ''
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 't3-model-picker: styles')

      const favorites = createFavoritesStore()
      const routable = createRoutableStore(ctx.remote)

      // Keep the picker available on profiles that omit the Team remote.
      const teamListeners = new Set()
      let teamSelection
      const publishTeamSelection = (select) => {
        teamSelection = select
        for (const listener of teamListeners) listener()
      }
      const teamRemote = {
        getSnapshot: () => teamSelection,
        subscribe(listener) {
          teamListeners.add(listener)
          return () => { teamListeners.delete(listener) }
        },
      }
      ctx.inject(['remote', 'remote.agentTeams'], (scope) => {
        scope.effect(() => {
          publishTeamSelection((sessionId, enabled) => scope.remote.agentTeams.setEnabled(sessionId, enabled))
          return () => { publishTeamSelection(undefined) }
        })
      })

      const refresh = () => { void routable.load() }
      ctx.on('connection/reset', refresh)
      ctx.remote.$on('llm/adapters-updated', refresh)
      ctx.remote.$on('settings/document-updated', refresh)

      // Cmd/Ctrl+Shift+M opens and closes the card. It has to be
      // document-wide and live while the card is closed, so it lives here
      // rather than in the component, and it claims the chord with
      // stopImmediatePropagation so a host binding on the same keys never also
      // runs.
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (!isToggleChord(event) || document.querySelector('.t3mp-disable-dialog') !== null) return
          const target = toggleTarget()
          if (target === null) return
          event.preventDefault()
          event.stopImmediatePropagation()
          target.toggle()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => { window.removeEventListener('keydown', onKeyDown, true) }
      }, 't3-model-picker: toggle chord')

      ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
        name: 'conversation.input.model',
        // Lower than the shipped seat's default 0: same cell, different
        // priority, so this entry is the one the composer renders.
        priority: -1,
        locale: NS,
        inject: (sessionId) => {
          const directory = ctx.modelDirectories.directoryFor(sessionId)
          const sessions = ctx.sessions
          const available = sessions.subagentAddress(sessionId) === undefined
          return {
            available,
            directory: directory.store,
            load: () => {
              if (available) directory.load().catch(() => { /* surfaced on the store */ })
            },
            select: selection => available
              ? directory.select(selection)
              : Promise.resolve(undefined),
            favorites,
            routable,
            teamRemote,
          }
        },
      }, ModelPicker))
    }

    return { inject, apply }
  },
})
