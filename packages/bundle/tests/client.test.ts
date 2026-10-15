/**
 * Tests for the settings page bundle.
 *
 * The browser half is a classic script that registers itself through
 * `window.__ModuleLoader__`, so it cannot be imported. These tests install the same
 * facade the shell installs, run the bundle, and then actually render the page with
 * a small React stand-in: `useState` and `useEffect` are implemented well enough to
 * mount the component, run its loader effect, and re-render with the host data. That
 * catches what a browser would otherwise be the first to see — a broken export shape,
 * a slot registered under the wrong name, a render that throws on real host data, or
 * a route the page calls that does not exist.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/**
 * The route prefix the page talks to the host on.
 *
 * Defined once because the same string appears in a stub route table for nearly every test: written
 * out each time, a rename had to be applied in thirty-one places, and one missed occurrence reads as
 * a page that fails to load rather than as a missing edit.
 *
 * It has to agree with the host's own registration, which the last test in this file checks against
 * the client bundle's source rather than against this constant.
 */
const PREFIX = '/.dsh-wechat-plugin'

/**
 * Any timer this long is the section watchdog; nothing else in the bundle waits seconds for the shell.
 *
 * Matched as "at least" rather than by the exact window on purpose: a test that compared against
 * 20 000 would quietly stop capturing the timer the day the window changed, and would then assert
 * against a timer that never arrives.
 */
const WATCHDOG_MIN_MS = 10_000

/**
 * A React stand-in with working `useState` and a runnable `useEffect`.
 *
 * Effects are collected during render and executed by {@link Mounted.flushEffects},
 * which lets a test await the component's data loading and then re-render.
 */
function createReactStub() {
  const state = []
  const effects = []
  let cursor = 0

  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const index = cursor++
      if (state[index] === undefined) {
        state[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        state[index],
        (next) => {
          state[index] = typeof next === 'function' ? next(state[index]) : next
        },
      ]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      effects.push(fn)
    },
    /** Reset the hook cursor for the next render pass. */
    __beginRender() {
      cursor = 0
      effects.length = 0
    },
    /** Run the effects collected by the last render, returning their cleanups. */
    __runEffects() {
      const cleanups = []
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return cleanups
    },
  }
  return react
}

/** Render a component once, returning the tree. */
function render(react, component) {
  react.__beginRender()
  return component({})
}

/** Collect every string in a rendered tree, for content assertions. */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

/** Collect every element of a given tag, depth-first. */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const child of node.children ?? []) collectByType(child, type, out)
  return out
}

/**
 * Collect every element carrying a class, depth-first.
 *
 * Selecting by class rather than by tag is what keeps an assertion about one list from counting a
 * second list that happens to share its element type.
 *
 * @param node - Tree to search.
 * @param name - Class name to match.
 */
function collectByClass(node, name, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, name, out)
    return out
  }
  const className = node.props?.className
  if (typeof className === 'string' && className.split(/\s+/).includes(name)) out.push(node)
  for (const child of node.children ?? []) collectByClass(child, name, out)
  return out
}

/**
 * Load the client bundle with the shell's facade in place.
 *
 * The globals stay installed for the lifetime of the returned handle so the
 * component can keep calling `fetch` and `setInterval` during the test.
 */
async function loadClientBundle(options = {}) {
  const source = await readFile(clientPath, 'utf8')
  const registrations = []
  const react = options.react ?? createReactStub()
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  // `navigator` is deliberately not saved: it is a read-only global in Node and the
  // bundle only reads `navigator.language`, which Node already provides.

  const head = {
    children: [],
    append(node) {
      node.parentNode = this
      this.children.push(node)
    },
  }
  const documentStub = {
    documentElement: { lang: 'zh-CN' },
    head,
    getElementById: (id) => head.children.find((node) => node.id === id) ?? null,
    createElement: (tag) => ({
      tag,
      id: '',
      textContent: '',
      parentNode: undefined,
      /** Mirrors `Element.remove`, so disposal can be verified. */
      remove() {
        const parent = this.parentNode
        if (parent === undefined) return
        const index = parent.children.indexOf(this)
        if (index >= 0) parent.children.splice(index, 1)
      },
    }),
  }

  /*
   * Window subscriptions are captured, not dropped: the page reloads its settings when the window
   * regains focus, and that reload is what the folder dialog provokes — opening the dialog blurs
   * the window, closing it focuses the window again. A stub that swallowed the handler could not
   * tell a page that survives that from one that quietly loses what the user just picked.
   */
  const windowListeners = new Map<string, () => void>()
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    addEventListener(type, handler) {
      windowListeners.set(type, handler)
    },
    removeEventListener(type, handler) {
      if (windowListeners.get(type) === handler) windowListeners.delete(type)
    },
  }
  globalThis.document = documentStub
  // Timers are neutralised: the poll loop is not what these tests exercise.
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  /*
   * The watchdog's own timer is captured rather than scheduled.
   *
   * It waits twenty seconds, so a test that had to wait for it would either be slow or assert
   * nothing, and a test that asserted on a *different* clock would not be testing this bundle. The
   * real timer is also what held this file's process open for twenty seconds — every test that
   * loaded the bundle armed one. Anything shorter still runs on the real clock, so the waits the
   * tests themselves perform and the page's own transient "已保存" timer behave as before.
   */
  const watchdogTimers = []
  const realSetTimeout = saved.setTimeout
  globalThis.setTimeout = (callback, delay, ...rest) => {
    if (typeof delay === 'number' && delay >= WATCHDOG_MIN_MS) {
      watchdogTimers.push(callback)
      return 0
    }
    return realSetTimeout(callback, delay, ...rest)
  }
  if (options.fetchImpl) globalThis.fetch = options.fetchImpl

  try {
    const run = new Function('window', 'document', 'navigator', `${source}\n`)
    run(globalThis.window, documentStub, { language: 'zh-CN' })
  } catch (error) {
    Object.assign(globalThis, saved)
    throw error
  }

  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  const registration = registrations[0]
  assert.equal(registration.id, 'dsh-wechat-plugin')
  assert.equal(typeof registration.factory, 'function')

  const exported = registration.factory((request) => {
    if (request === 'react') return react
    throw new Error(`unexpected client require: ${request}`)
  })

  return {
    exports: exported,
    react,
    documentStub,
    /**
     * Let the twenty seconds pass.
     *
     * Asserting on the watchdog means asserting on what it does when its window closes, and this is
     * the only way to do that without waiting for it. Exactly one timer is expected: the bundle arms
     * it once, while its factory runs. An assertion here rather than a silent no-op, because a
     * harness that stopped capturing the timer would make every "no error" test below pass by
     * having fired nothing.
     */
    fireWatchdog() {
      assert.equal(watchdogTimers.length, 1, 'the watchdog must be armed exactly once, at load time')
      const [timer] = watchdogTimers.splice(0)
      timer()
    },
    /**
     * Fire a window event the page subscribed to.
     *
     * Only `focus` matters here, and it is the one event the page's own dialogs cause: the folder
     * dialog blurs the window while it is open and focuses it again when it closes, so every pick
     * is followed by a reload. A test that cannot fire it cannot see that reload.
     *
     * @param type - Event name the page listens for.
     */
    fireWindowEvent(type) {
      const handler = windowListeners.get(type)
      assert.ok(handler, `the page must subscribe to window ${type}`)
      handler()
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

/** Mount the page against stubbed routes and return the final tree. */
async function mountPage(routes, options = {}) {
  const requested = []
  /**
   * Every request the page made, with its method and body.
   *
   * The path alone cannot show whether a save carried the value the user picked, and that is the
   * question this page has repeatedly answered wrongly: the field held a directory, the page said
   * nothing, and the host never heard about it.
   */
  const calls = []
  const react = createReactStub()
  const bundle = await loadClientBundle({
    react,
    fetchImpl: async (url, options) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      const method = options?.method ?? 'GET'
      requested.push(path)
      calls.push({ path, method, body: options?.body })
      const entry = routes[path]
      if (entry === undefined) {
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) }
      }
      /*
       * A route is a body, or a function of the request for the cases that need one: a stub that
       * answers a save with the same object it served on load cannot tell a value the host stored
       * from one it refused, and that difference is the subject of several tests below.
       */
      const answer =
        typeof entry === 'function' ? entry({ path, method, body: options?.body }) : { status: 200, body: entry }
      const status = answer.status ?? 200
      if (status !== 200) {
        const message = answer.body?.error ?? `HTTP ${String(status)}`
        return { ok: false, status, text: async () => JSON.stringify({ error: message }) }
      }
      return { ok: true, status, text: async () => JSON.stringify(answer.body) }
    },
  })

  const sections = []
  const disposers = []
  const ctx = {
    /*
     * The workspace service, when the test supplies one.
     *
     * It is the fallback route to the folder dialog, and reaching it is the only proof that the
     * page kept the context `apply` was given: a component cannot see that argument on its own, and
     * naming it anyway is a `ReferenceError` thrown before the picker is called.
     *
     * This is the *stub* shape of a context — a plain object, where the service is a property. A
     * test that wants the shape cordis actually hands over asks for `options.cordis` instead; see
     * below.
     */
    ...(options.uiWorkspace === undefined ? {} : { uiWorkspace: options.uiWorkspace }),
    /*
     * The cordis route to a service: `get(name)`, which in the real context reads from the service
     * store without the `inject` requirement. Present only under `options.cordis`, so the plain
     * stub above keeps exercising the property-read route on its own.
     */
    ...(options.cordis === undefined ? {} : { get: (name) => options.cordis.services[name] }),
    // The client-plugin rules require resources to be registered through `effect`,
    // so the stub runs the body and collects the returned cleaner.
    effect(execute) {
      const cleanup = execute()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    slots: {
      inject: (_slot, factory) => factory(),
      register(definition, component) {
        sections.push({ definition, component })
        return () => {
          sections.pop()
        }
      },
    },
  }
  /*
   * `options.cordis` makes the stub behave the way the context proxy does on the real page: a
   * service the plugin did not declare through `inject` throws when read as a property, and is
   * reachable only through `get`.
   *
   * This is the reported failure, exactly: on a browser there is no `__DSH_DIRECTORY_PICKER__`, so
   * 「选择文件夹」 fell through to `ctx.uiWorkspace`, the proxy threw
   * `cannot get property "uiWorkspace" without inject`, and the page showed it as
   * `打开文件夹选择器失败: cannot get property "uiWorkspace" without inject`. Optional chaining was
   * never going to help — `ctx` is not null, the getter is what throws.
   */
  bundle.exports.apply(
    options.cordis === undefined
      ? ctx
      : new Proxy(ctx, {
          get(target, prop, receiver) {
            if (typeof prop !== 'symbol' && !Reflect.has(target, prop)) {
              throw new Error(`cannot get property "${String(prop)}" without inject`)
            }
            return Reflect.get(target, prop, receiver)
          },
        }),
  )
  assert.equal(sections.length, 1, 'apply must register one settings section')

  const component = sections[0].component
  let tree = render(react, component)
  bundle.react.__runEffects()
  // Effects kick off async loads; let them settle, then re-render with the data.
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render(react, component)

  return {
    tree,
    requested,
    calls,
    sections,
    bundle,
    disposers,
    /**
     * Render again from the live hook state.
     *
     * The stub does not re-render on `setState`, so a test that clicks something and asserts on
     * what appears must ask for a new pass — otherwise it sees the tree from before the click.
     */
    rerender: () => render(react, component),
  }
}

/**
 * Let the page's promises settle, then render what the click produced.
 *
 * The stub has no scheduler: a handler that awaits the host updates state *after* the current pass,
 * so a test that asserted without waiting would read the tree from before its own click.
 *
 * @param page - The mounted page.
 * @returns The tree after the pending work finished.
 */
async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return page.rerender()
}

/** The first button whose text contains the given label. */
function findButton(tree, label) {
  const button = collectByType(tree, 'button').find((node) => collectText(node).join('').includes(label))
  assert.ok(button, `expected a button labelled ${label}`)
  return button
}

/**
 * A settings route that answers the way the host does in the one respect that matters here.
 *
 * A GET serves what is stored; a POST stores what it was sent and answers with that. `transform`
 * stands in for everything the host may do to a value on the way in — it is where a test makes the
 * host drop a field, which the page has to notice rather than report as saved.
 *
 * @param initial - Stored settings.
 * @param transform - Applied to `(sent, stored)` on a POST; returns what is stored next.
 */
function settingsRoute(initial, transform = (sent) => sent) {
  let stored = { ...initial }
  return ({ method, body }) => {
    if (method === 'POST') stored = { ...stored, ...transform(JSON.parse(body), stored) }
    return { status: 200, body: { settings: { ...stored }, defaults: { ...initial } } }
  }
}

/** The routes a page needs to render, with the settings route the test wants. */
function pageRoutes(settings, status = STATUS) {
  return {
    [PREFIX + '/status']: status,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: settings,
  }
}

/**
 * Put a stand-in for the desktop preload's directory picker in place.
 *
 * The page reads `globalThis.__DSH_DIRECTORY_PICKER__` when the button is pressed, the way the
 * desktop shell publishes it. Returns the undo, so a test cannot leave it for the next one.
 */
function withDirectoryPicker(pick) {
  globalThis.__DSH_DIRECTORY_PICKER__ = { pick }
  return () => {
    delete globalThis.__DSH_DIRECTORY_PICKER__
  }
}

/**
 * Every client failure the page sent to the host, parsed.
 *
 * `reportFailure` reaches the host as a POST to `/client-error` carrying `{ scope, message, stack }`,
 * and the scope is what says *which* phase failed. That is the whole question when a boot log has to
 * tell "this bundle never registered a page" apart from "the page registered and then could not
 * load" — two different failures with two different fixes.
 *
 * @param calls - The request log {@link mountPage} returns.
 */
function clientErrors(calls) {
  return calls
    .filter((call) => call.path === PREFIX + '/client-error')
    .map((call) => JSON.parse(call.body))
}

/**
 * A `fetch` stand-in that records what the page reported and answers 200.
 *
 * The page's only way out of the browser is that route, so what lands here is exactly what the host
 * would have written to the boot log.
 *
 * @param reports - Array the reported calls are appended to.
 */
function reportingFetch(reports) {
  return async (url, options) => {
    reports.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), body: options?.body })
    return { ok: true, status: 200, text: async () => '{}' }
  }
}

/**
 * Apply the bundle to a slot-registry stand-in and report what it did.
 *
 * It mirrors the two registry semantics the watchdog now rests on: `inject` runs its contributor as
 * soon as the slot is declared — `ui-renderer` calls it synchronously when the declaration already
 * exists — and it calls nothing at all when the shell never declares the slot.
 *
 * @param bundle - Handle from {@link loadClientBundle}.
 * @param options - `declared: false` for a shell that never declares the section slot;
 *   `crashChannel: false` for a shell that does not offer `slots.onEntryError`.
 */
function applyToRegistry(bundle, options = {}) {
  const sections = []
  const crashListeners = []
  const declared = options.declared ?? true
  const ctx = {
    effect(execute) {
      execute()
    },
    slots: {
      inject: (_slot, contributor) => (declared ? contributor() : () => {}),
      register(definition, component) {
        sections.push({ definition, component })
        return () => {}
      },
      ...(options.crashChannel === false
        ? {}
        : {
            onEntryError(listener) {
              crashListeners.push(listener)
              return () => {}
            },
          }),
    },
  }
  bundle.exports.apply(ctx)
  return { ctx, sections, crashListeners }
}

const STATUS = {
  enabled: true,
  accounts: [{ accountId: 'fd17bd2d40c3@im.bot', userId: 'peer@im.wechat', polling: true }],
  needsLogin: false,
  errors: ['2026-10-06T00:00:00.000Z 示例错误'],
  diagnostics: {
    logPath: 'C:\\Users\\me\\.dsh\\wechat\\boot.log',
    statePath: 'C:\\Users\\me\\.dsh\\wechat\\state.json',
    workspace: 'C:\\Users\\me\\.dsh\\dsh_wechat',
    // The ordinary state of a fresh install: nothing chosen, so the default directory is in use.
    settingsWorkspace: '',
    logTail: ['2026-10-06T00:00:00.000Z apply: mounted'],
  },
}

/** Effective settings and the defaults behind them. */
const SETTINGS = {
  mergeWindowMs: 10_000,
  maxReplyChars: 4_000,
  settleMs: 1_200,
  quoteHistory: 40,
  autoReplyAttachments: true,
  presenceNote: '[渠道：微信] 对方在手机上。',
}

const LOGIN_RUNNING = {
  phase: 'running',
  step: '请用手机微信扫码',
  qrUrl: 'https://liteapp.weixin.qq.com/q/abc',
  qrDataUrl: 'data:image/png;base64,AAAA',
}

test('the client bundle exports the plugin shape under the expected name', async () => {
  const bundle = await loadClientBundle()
  try {
    assert.equal(bundle.exports.name, 'dsh-wechat-plugin')
    assert.equal(typeof bundle.exports.apply, 'function')
  } finally {
    bundle.restore()
  }
})

test('the client half injects slots, so it cannot activate before the registry exists', async () => {
  // A boot-critical declaration, and the bug that made the desktop shell refuse to
  // start. Cordis holds a plugin back until every injected service is available; with
  // an empty list this plugin activates early, `ctx.slots` is undefined, `apply`
  // throws, the entry is recorded as `failed`, and the shell's boot audit aborts the
  // whole application. The audit reports only `<id>: failed` — never the cause.
  const bundle = await loadClientBundle()
  try {
    assert.deepEqual(bundle.exports.inject, ['slots'])
  } finally {
    bundle.restore()
  }
})

test('apply registers its resources through effect and cleans them up', async () => {
  const bundle = await loadClientBundle()
  try {
    const sections = []
    const disposers = []
    const ctx = {
      effect(execute) {
        const cleanup = execute()
        if (typeof cleanup === 'function') disposers.push(cleanup)
      },
      slots: {
        // Mirror the real shape: `inject` runs the contributor and returns a
        // disposer for whatever it registered.
        inject: (slot, factory) => {
          assert.equal(slot, 'settings.section')
          return factory()
        },
        register: (definition, component) => (
          sections.push({ definition, component }),
          () => {
            const index = sections.findIndex((entry) => entry.definition === definition)
            if (index >= 0) sections.splice(index, 1)
          }
        ),
      },
    }

    bundle.exports.apply(ctx)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].definition.name, 'settings.section')
    assert.equal(sections[0].definition.id, 'wechat')
    assert.equal(sections[0].definition.order, 40)
    assert.equal(typeof sections[0].definition.label(), 'string')

    const styles = () => bundle.documentStub.head.children.filter((node) => node.id === 'dsh-wechat-style')
    assert.equal(styles().length, 1, 'the stylesheet is installed')

    // Disposal must remove both the section and the stylesheet: a disabled plugin
    // has to leave nothing behind.
    assert.equal(disposers.length, 1, 'apply registered exactly one effect')
    disposers[0]()
    assert.equal(sections.length, 0, 'the section is unregistered')
    assert.equal(styles().length, 0, 'the stylesheet is removed')
  } finally {
    bundle.restore()
  }
})

test('a launch that never opens the settings page reports no error', async () => {
  /*
   * The bug this pins down. The bundle is loaded at application start (`dsh.client.immediately`),
   * while the component only mounts when the user opens 设置 → 微信 — so "nothing rendered within 20
   * seconds" is the ordinary state of every launch that stays in the conversation view. The old
   * signal was set in the component body, so it turned that ordinary state into one false error per
   * boot: `客户端错误[mount]: 插件已加载，但设置页在 20 秒内没有渲染`.
   *
   * The health signal now comes from registering the section, and registration happens whether or
   * not anybody ever opens the page.
   */
  const reports = []
  const bundle = await loadClientBundle({ fetchImpl: reportingFetch(reports) })
  try {
    const { sections } = applyToRegistry(bundle)
    assert.equal(sections.length, 1, 'the section registered with the shell')

    bundle.fireWatchdog() // twenty seconds later, with the user still in the conversation view

    assert.deepEqual(reports, [], 'a settings page nobody opened is not a failure')
  } finally {
    bundle.restore()
  }
})

test('a bundle that loads but never registers its section is still reported', async () => {
  /*
   * The watchdog's value, and the half the fix must not throw away. If the shell never declares
   * `settings.section`, the registry never runs the contributor, no section is ever registered, and
   * 设置 → 微信 will never appear — with nothing else anywhere to say so. Silence here would be the
   * exact failure mode this log exists to prevent.
   *
   * The registry stand-in has no `onEntryError` either, which is the other thing this test holds:
   * the crash channel is an optional extra, and a shell without it must still activate the plugin.
   */
  const reports = []
  const bundle = await loadClientBundle({ fetchImpl: reportingFetch(reports) })
  try {
    const { sections } = applyToRegistry(bundle, { declared: false, crashChannel: false })
    assert.equal(sections.length, 0, 'nothing registered: this is the failure the watchdog watches for')

    bundle.fireWatchdog()

    assert.equal(reports.length, 1, 'the watchdog still speaks when nothing registered')
    assert.equal(reports[0].path, PREFIX + '/client-error')
    const payload = JSON.parse(reports[0].body)
    assert.equal(payload.scope, 'register', 'the scope names the step that failed')
    assert.match(payload.message, /看门狗/, 'the log line names the watchdog, so it can be traced here')
  } finally {
    bundle.restore()
  }
})

test("a section that throws while rendering is reported, and another plugin's crash is not", async () => {
  /*
   * Registering a section proves the shell accepted it; it says nothing about the render. The shell
   * renders every slot entry inside an error boundary that reports crashes through
   * `ctx.slots.onEntryError` — the one seam visible from here, and the same one the shell's own
   * cordis client runner subscribes to.
   *
   * The filter matters as much as the report: every settings section in the shell shares this slot,
   * so a crash reported without checking whose entry it was would blame this plugin for another
   * plugin's bug.
   */
  const reports = []
  const bundle = await loadClientBundle({ fetchImpl: reportingFetch(reports) })
  try {
    const { sections, crashListeners } = applyToRegistry(bundle)
    assert.equal(crashListeners.length, 1, "the plugin listens on the shell's crash channel")

    const [crash] = crashListeners
    crash('settings.section', { component: () => null }, new Error('某个别的插件崩了'), {
      abdicated: true,
    })
    assert.deepEqual(reports, [], 'a crash that is not ours must not be attributed to this plugin')

    crash('settings.section', { component: sections[0].component }, new Error('render exploded'), {
      abdicated: true,
    })
    assert.equal(reports.length, 1, 'our own render crash reaches the boot log')
    const payload = JSON.parse(reports[0].body)
    assert.equal(payload.scope, 'render')
    assert.match(payload.message, /render exploded/, 'and carries what was thrown')
  } finally {
    bundle.restore()
  }
})

test('the page loads every route it renders from', async () => {
  const { tree, requested, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    assert.deepEqual(
      [...requested].sort(),
      [PREFIX + '/login', PREFIX + '/settings', PREFIX + '/status'],
      'the page must call exactly these routes',
    )

    const text = collectText(tree).join(' | ')
    // The bound account and its polling badge.
    assert.match(text, /fd17bd2d40c3@im\.bot/)
    assert.match(text, /peer@im\.wechat/)
    // The QR code is rendered as an image with the data URL the host produced.
    const images = collectByType(tree, 'img')
    assert.equal(images.length, 1)
    assert.equal(images[0].props.src, LOGIN_RUNNING.qrDataUrl)
    assert.equal(images[0].props.alt.length > 0, true)
    // Each account offers the action that ends the link itself.
    assert.ok(
      collectByType(tree, 'button').some((node) =>
        collectText(node).join('').includes('断开连接'),
      ),
      'the disconnect button is rendered next to the account',
    )
    // Conversation-to-session bindings are not shown at all: the list was removed as noise.
    assert.doesNotMatch(text, /会话绑定/)
    // Errors from the host are surfaced.
    assert.match(text, /示例错误/)
  } finally {
    bundle.restore()
  }
})

test('disconnecting runs straight away, with no verification step', async () => {
  const { tree, bundle, requested } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const button = collectByType(tree, 'button').find((node) =>
      collectText(node).join('').includes('断开连接'),
    )
    assert.ok(button, 'the disconnect button is rendered')
    button.props.onClick()
    // Security was removed deliberately, so the action is unguarded. Asserted rather than left
    // implicit: re-adding a prompt would otherwise go unnoticed.
    assert.ok(
      requested.includes(PREFIX + '/disconnect'),
      'the request goes out without a password',
    )
  } finally {
    bundle.restore()
  }
})

test('the page has no password or security-question UI at all', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const text = collectText(tree).join(' | ')
    // The whole feature was removed on request; these are the words it used to contribute.
    assert.doesNotMatch(text, /密码/)
    assert.doesNotMatch(text, /密保/)
    assert.equal(
      collectByType(tree, 'input').filter((node) => node.props.type === 'password').length,
      0,
      'no password field',
    )
  } finally {
    bundle.restore()
  }
})

test('the page groups its settings, so unlike decisions are told apart', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Unrelated settings sitting side by side with nothing to say they were different kinds of
    // decision was the readability problem this grouping exists to fix. The stub does not
    // materialise function components, so the groups are matched by the component that declares
    // them rather than by the section it returns.
    const groups = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child)
        return
      }
      if (typeof node.type === 'function' && node.type.name === 'Group') groups.push(node)
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
    const titles = groups.map((group) => String(group.props.title))
    assert.deepEqual(
      titles,
      ['帮助', '连接', '行为', '指令', '诊断'],
      'in the order they should be read',
    )
    // The diagnostics group carries no hint: the card below it already says what the log is, so a
    // group-level line would repeat it. Asserted so the duplication cannot creep back in.
    const diagnostics = groups.find((group) => String(group.props.title) === '诊断')
    assert.equal(diagnostics.props.hint, undefined, 'no group hint for diagnostics')
    // Help comes first: it answers the questions the switches below it raise, and a docs link placed
    // last is one nobody reaches until they have already given up.
    assert.equal(titles[0], '帮助', 'the guide comes first')
  } finally {
    bundle.restore()
  }
})

test('the page carries no inline layout styles, so the stylesheet stays the one source', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Layout written inline wins over the stylesheet and cannot be restyled or themed, which is
    // how the page drifted into inconsistent spacing before. Only `style` props are inspected:
    // the markup is otherwise free to carry class names.
    const offenders = []
    const visit = (node, path) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child, path)
        return
      }
      if (node.props?.style !== undefined) offenders.push(`${path}/${String(node.type)}`)
      for (const child of node.children ?? []) visit(child, `${path}/${String(node.type)}`)
    }
    visit(tree, '')
    assert.deepEqual(offenders, [], 'all layout belongs in the stylesheet')
  } finally {
    bundle.restore()
  }
})

test('the diagnostics paths are a definition list, so their labels line up', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    // Selector by class rather than by count: the page holds more than one definition list now
    // that the command reference uses the same pattern.
    const facts = collectByClass(tree, 'dsh-wechat-facts')
    assert.equal(facts.length, 1, 'one list of paths')
    const terms = collectByType(facts[0], 'dt').map((node) => collectText(node).join(''))
    assert.deepEqual(terms, ['日志文件', '状态文件', '会话工作目录', '设置里存的值'])
  } finally {
    bundle.restore()
  }
})

test('the command reference lists every command with what it does', async () => {
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    [PREFIX + '/settings']: { settings: SETTINGS, defaults: SETTINGS },
  })
  try {
    const commands = collectByClass(tree, 'dsh-wechat-command')
    // The page is where someone finds out these exist, so every one the channel answers has to be
    // here — a command missing from the list is one nobody will use.
    assert.deepEqual(
      commands.map((node) => collectText(collectByType(node, 'dt')[0]).join('')),
      ['/help', '/new [标题]', '/list', '/switch <编号>', '/model [编号或名字]', '/current', '/cancel'],
    )
    const meanings = commands.map((node) => collectText(collectByType(node, 'dd')[0]).join(''))
    assert.ok(meanings.every((text) => text.length > 0), 'every command explains itself')
  } finally {
    bundle.restore()
  }
})

test('the page asks for a verification code only when the host says so', async () => {
  const waiting = { phase: 'running', step: '服务端要求输入配对验证码', awaitingVerifyCode: true }
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: waiting,
    [PREFIX + '/bindings']: { bindings: [] },
  })
  try {
    const inputs = collectByType(tree, 'input')
    assert.equal(inputs.length, 1, 'exactly one verification-code field')
    // The heading carries the wording; the button is just the verb, so match the section text
    // rather than a button label that no longer repeats it.
    const text = collectText(tree).join(' | ')
    assert.match(text, /配对验证码/, 'the section says what is being asked for')
    const buttons = collectByType(tree, 'button').map((node) => collectText(node).join(''))
    assert.ok(
      buttons.includes('提交'),
      `expected a submit button, got: ${buttons.join(' / ')}`,
    )
  } finally {
    bundle.restore()
  }
})

test('a failing status route renders an error instead of throwing', async () => {
  const { tree, calls, bundle } = await mountPage({
    // Status is the one the page cannot render without, so its absence is fatal.
    [PREFIX + '/login']: LOGIN_RUNNING,
  })
  try {
    const text = collectText(tree).join(' | ')
    assert.match(text, /not found|读取设置失败|Could not read/)
    const buttons = collectByType(tree, 'button')
    assert.ok(buttons.length >= 1, 'an error state offers a retry')
    /*
     * And the failure reaches the host, under its own scope.
     *
     * This is the path the watchdog is *not* responsible for, and the two must stay apart: a page
     * that opens and cannot read its routes is a different event from a bundle that never managed
     * to register a page at all, and only the scope in the boot log tells them apart.
     */
    const reported = clientErrors(calls)
    assert.deepEqual(
      reported.map((report) => report.scope),
      ['load'],
      'a settings page that fails to load is reported under the load scope',
    )
  } finally {
    bundle.restore()
  }
})

test('a failing optional route degrades instead of blanking the page', async () => {
  // The settings route is the most optional. A page that refused to render because it 404s would
  // take the channel switch down with it, so the core sections must still appear.
  const { tree, bundle } = await mountPage({
    [PREFIX + '/status']: STATUS,
    [PREFIX + '/login']: LOGIN_RUNNING,
    // settings is absent, so it 404s.
  })
  try {
    const text = collectText(tree).join(' | ')
    assert.match(text, /已绑定账号|Bound accounts/, 'the accounts section still renders')
    assert.match(text, /fd17bd2d40c3@im\.bot/, 'from the status the host did return')
    // And the settings and password forms are simply absent rather than broken.
    assert.doesNotMatch(text, /行为设置 \|/)
    assert.doesNotMatch(text, /密码保护 \|/)
  } finally {
    bundle.restore()
  }
})

test('the manifest declares a web client half with no extra externals', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  // Only the platform baseline (React) is needed, so nothing extra is declared.
  assert.equal(manifest.dsh.client.external, undefined)
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'))
  assert.ok(manifest.files.includes('dist'), 'the vendored core must ship')
})

test('the client half is declared immediately, because nothing consumes it', async () => {
  // A boot-critical declaration, not a preference. The shell's boot audit requires
  // every client entry to activate, and module bodies are lazy — they run only on
  // first materialization. An entry with no consumer and no `immediately` therefore
  // never runs, the audit reports `dsh-wechat: failed`, and the desktop shell refuses
  // to start the whole application.
  //
  // There are two ways to satisfy the audit: be consumed (declare `dsh.client.inject`,
  // as `dsh-orb` does with the settings page) or activate at boot. This plugin is
  // self-contained with no consumer, so it must activate at boot.
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    manifest.dsh.client.immediately,
    true,
    'without this the desktop shell fails to start: the entry never activates',
  )
  assert.equal(manifest.dsh.client.inject, undefined, 'nothing else consumes this plugin')
})

test('the package name, the host row id and the client module id agree', async () => {
  /*
   * Three places carry this plugin's identity, and the shipped bundles keep them identical: the
   * package name, the `id` of the row `cordis.patch.yml` inserts, and the `id` the client registers
   * itself under. The client-plugin convention depends on it — a Host row whose id differs from its
   * package name cannot be loaded by name.
   *
   * One of the three was missed when the package was renamed (`dsh-wechat` was already taken on npm by
   * an unrelated plugin of the same purpose), and nothing failed: the host half still loaded, so only
   * the settings page went blank. Hence this test.
   */
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
  const client = await readFile(clientPath, 'utf8')

  const name = manifest.name
  const rowId = /- id:\s*(\S+)/.exec(patch)?.[1]
  const rowName = /name:\s*'([^']+)'/.exec(patch)?.[1]
  const moduleId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1]

  assert.equal(rowId, name, 'the cordis row id must equal the package name')
  assert.equal(rowName, name, 'the cordis row name must equal the package name')
  assert.equal(moduleId, name, 'the client module id must equal the package name')
})

/**
 * Choosing a folder, saving, and what the page says about either.
 *
 * These exist because of a report that could not be answered from the outside: a directory was
 * chosen, the page showed nothing, the field was empty again after a restart, and conversations
 * kept using the default. The state file's `settings` had never contained the key — not even as an
 * empty string — which proved the save had never left the browser, while every visible part of the
 * page looked fine. What was missing was any statement of what had just happened: picking a folder
 * fills the box and saves nothing, a picker that refuses to open must say so instead of doing
 * nothing, and a save must be distinguishable from a field the host quietly refused.
 */
test('a folder the dialog returns fills the box and says it is not saved yet', async () => {
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  const undo = withDirectoryPicker(async () => 'C:\\picked-ws')
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    const field = collectByType(tree, 'input').find((node) => node.props.type === 'text')
    assert.equal(field.props.value, 'C:\\picked-ws', 'the chosen directory is in the field')
    assert.match(
      collectText(tree).join(' | '),
      /点「保存设置」/,
      'the page says that choosing a folder does not save it',
    )
    // The distinction the whole report turned on: the picker is not a save.
    assert.equal(
      page.calls.filter((call) => call.method === 'POST').length,
      0,
      'picking a folder must not post anything',
    )
  } finally {
    undo()
    page.bundle.restore()
  }
})

test('the folder dialog is reached through the workspace service when the desktop has no global', async () => {
  /*
   * This is the test that would have caught the original report. The button's handler named `ctx`
   * from inside the section component, where `apply`'s argument does not exist, so pressing it
   * threw `ReferenceError: ctx is not defined` while building the arguments — the picker was never
   * called, the `try` around it never saw the throw, and the page showed nothing at all. Both
   * routes to the dialog therefore have to be exercised, not just the desktop global.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)), {
    uiWorkspace: { pickDirectory: async () => 'C:\\from-workspace' },
  })
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    const field = collectByType(tree, 'input').find((node) => node.props.type === 'text')
    assert.equal(field.props.value, 'C:\\from-workspace', 'the service route fills the field')
    assert.doesNotMatch(collectText(tree).join(' | '), /打开文件夹选择器失败/, 'and nothing failed')
  } finally {
    page.bundle.restore()
  }
})

test('the folder dialog is reached through cordis get(), where reading the service as a property throws', async () => {
  /*
   * The browser report, in the shape it arrived in: `打开文件夹选择器失败: cannot get property
   * "uiWorkspace" without inject`.
   *
   * The page used to read `ctx?.uiWorkspace`. On the real page `ctx` is cordis's context proxy,
   * which throws for every service the plugin did not declare through `inject`, so the fallback
   * never ran and the user got a message about internals instead of a dialog. `ctx.get` is the
   * read that does not require the inject declaration, and this is the test that holds the page to
   * it — a plain stub context (the test above) cannot, because nothing on a plain object throws.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)), {
    cordis: { services: { uiWorkspace: { pickDirectory: async () => 'C:\\from-cordis' } } },
  })
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    const field = collectByType(tree, 'input').find((node) => node.props.type === 'text')
    assert.equal(field.props.value, 'C:\\from-cordis', 'the service route fills the field')
    assert.doesNotMatch(
      collectText(tree).join(' | '),
      /without inject/,
      'and the page never reports the inject guard to the user',
    )
    assert.doesNotMatch(collectText(tree).join(' | '), /打开文件夹选择器失败/, 'and nothing failed')
  } finally {
    page.bundle.restore()
  }
})

test('a client with no picker at all still says so, rather than looking like a cancelled dialog', async () => {
  /*
   * The other half of the contract: a context that offers nothing must produce the page's own
   * message. Without this, a fix that quietly swallowed the missing service would leave the button
   * doing nothing at all — the failure mode the page was written to avoid.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)), {
    cordis: { services: {} },
  })
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    assert.match(
      collectText(tree).join(' | '),
      /no directory picker is available in this client/,
      'the page reports the missing picker itself',
    )
  } finally {
    page.bundle.restore()
  }
})

test('a picked folder survives the reload the dialog itself provokes', async () => {
  /*
   * The reported failure, in order: 「弹出了对话框，我选择了目录，输入框有内容，但是保存设置后输入框就没有内容了」.
   *
   * The folder dialog blurs the window while it is open and focuses it again when it closes, and
   * this page reloads its settings on `focus`. That reload rebuilt the draft from the *stored*
   * settings, so the directory the dialog had just returned was erased a moment after it appeared —
   * and 「保存设置」 then posted the stored settings, which the host recorded as
   * `workspacePath "" -> ""`. Nothing reported a failure anywhere, because nothing failed: the page
   * threw the value away and then honestly saved what was left.
   *
   * Every step is asserted, because the symptom was invisible from every other angle: the box, the
   * note beside it, and the body the save actually carries.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  const undo = withDirectoryPicker(async () => 'C:\\picked-ws')
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const picked = await settle(page)
    const field = () => collectByType(picked, 'input').find((node) => node.props.type === 'text')
    assert.equal(field().props.value, 'C:\\picked-ws', 'the dialog fills the box')

    page.bundle.fireWindowEvent('focus')
    const reloaded = await settle(page)
    const afterReload = collectByType(reloaded, 'input').find((node) => node.props.type === 'text')
    assert.equal(
      afterReload.props.value,
      'C:\\picked-ws',
      'and the reload the dialog provoked must not empty it',
    )
    assert.match(
      collectText(reloaded).join(' | '),
      /有改动还没保存/,
      'the page still says the picked directory is not saved yet',
    )

    findButton(reloaded, '保存设置').props.onClick()
    await settle(page)
    const post = page.calls.find((call) => call.method === 'POST' && call.path === PREFIX + '/settings')
    assert.ok(post, 'the save has to reach the host')
    assert.equal(
      JSON.parse(post.body).workspacePath,
      'C:\\picked-ws',
      'the picked directory is what gets posted, not the stored empty one',
    )
  } finally {
    undo()
    page.bundle.restore()
  }
})

test('a reload still brings in a value that changed elsewhere', async () => {
  /*
   * The other half of the contract: keeping the user's own edits must not freeze the page against
   * the host. A key nobody edited locally is still replaced by whatever the reload returned.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  try {
    const before = collectByType(page.tree, 'input').find((node) => node.props.type === 'text')
    assert.equal(before.props.value, '', 'nothing stored yet')

    page.bundle.fireWindowEvent('focus')
    const reloaded = await settle(page)
    const after = collectByType(reloaded, 'input').find((node) => node.props.type === 'text')
    assert.equal(after.props.value, '', 'an untouched field still shows what is stored')
    assert.doesNotMatch(collectText(reloaded).join(' | '), /有改动还没保存/, 'and nothing is pending')
  } finally {
    page.bundle.restore()
  }
})

test('saving posts the chosen directory, so it can reach the state file', async () => {
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  const undo = withDirectoryPicker(async () => 'C:\\picked-ws')
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const picked = await settle(page)
    findButton(picked, '保存设置').props.onClick()
    await settle(page)

    const post = page.calls.find(
      (call) => call.method === 'POST' && call.path === PREFIX + '/settings',
    )
    assert.ok(post, 'the save has to reach the host: nothing else writes the setting')
    assert.equal(
      JSON.parse(post.body).workspacePath,
      'C:\\picked-ws',
      'the body carries the directory the user chose',
    )
    // And the note about that pick does not outlive the save it was waiting for.
    const after = await settle(page)
    assert.doesNotMatch(collectText(after).join(' | '), /选文件夹本身不保存/)
  } finally {
    undo()
    page.bundle.restore()
  }
})

test('a save that fails says so beside the button instead of looking saved', async () => {
  const failing = ({ method }) =>
    method === 'POST'
      ? { status: 500, body: { error: 'EACCES: state.json is not writable' } }
      : { status: 200, body: { settings: { ...SETTINGS }, defaults: { ...SETTINGS } } }
  const page = await mountPage(pageRoutes(failing))
  try {
    findButton(page.tree, '保存设置').props.onClick()
    const tree = await settle(page)

    const text = collectText(tree).join(' | ')
    assert.match(text, /保存失败/, 'a failed save is reported')
    assert.match(text, /not writable/, 'the host\'s own words are shown')
    assert.doesNotMatch(text, /已保存/, 'and it must not also claim success')
  } finally {
    page.bundle.restore()
  }
})

test('a value the host would not accept is reported, not counted as saved', async () => {
  /*
   * The host drops any field it cannot accept and answers with what is stored, so the page would
   * otherwise print "已保存" over a value that never took effect — the same lie as a save the user
   * never made, just in the other direction.
   */
  const stored = { ...SETTINGS, maxReplyChars: 4_000 }
  const page = await mountPage(
    pageRoutes(settingsRoute(stored, (sent, current) => ({ ...sent, maxReplyChars: current.maxReplyChars }))),
  )
  try {
    const field = collectByType(page.tree, 'input').find((node) => node.props.type === 'number')
    assert.ok(field, 'the reply-length field is rendered')
    // Find it by value rather than by order: the page has several number fields.
    const replyLimit = collectByType(page.tree, 'input').find((node) => node.props.value === 4_000)
    replyLimit.props.onChange({ target: { value: '500000' } })
    const edited = await settle(page)
    findButton(edited, '保存设置').props.onClick()
    const tree = await settle(page)

    const text = collectText(tree).join(' | ')
    assert.match(text, /没有被主机接受/, 'the page admits the value did not stick')
    assert.match(text, /回复长度上限/, 'and names the setting, so it can be fixed')
  } finally {
    page.bundle.restore()
  }
})

test('a picker that refuses to open is reported instead of swallowing the failure', async () => {
  /*
   * The desktop side guards this call and throws for a frame it does not own. Swallowing that throw
   * made the button indistinguishable from a dialog the user had cancelled, so the failure could
   * not even be reported afterwards — which is what made the original report undiagnosable.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  const reported = []
  const originalError = console.error
  console.error = (...args) => reported.push(args.map(String).join(' '))
  const undo = withDirectoryPicker(async () => {
    throw new Error('dsh desktop: rejected directory picker from an unowned renderer')
  })
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    const text = collectText(tree).join(' | ')
    assert.match(text, /打开文件夹选择器失败/, 'the page says the dialog could not be opened')
    assert.match(text, /unowned renderer/, 'and repeats what the picker said')
    assert.ok(reported.length > 0, 'the console keeps a record as well')
    // Sent to the host's log too, which is the only place a failure survives the page.
    assert.ok(
      page.calls.some((call) => call.path === PREFIX + '/client-error'),
      'the failure reaches the boot log',
    )
  } finally {
    undo()
    console.error = originalError
    page.bundle.restore()
  }
})

test('cancelling the dialog is not an error and changes nothing', async () => {
  // `null` is the documented shape of "the user closed the dialog". Treating it as a failure would
  // put an error message beside a field nobody tried to change.
  const page = await mountPage(pageRoutes(settingsRoute({ ...SETTINGS, workspacePath: 'C:\\kept' })))
  const undo = withDirectoryPicker(async () => null)
  try {
    findButton(page.tree, '选择文件夹').props.onClick()
    const tree = await settle(page)

    const text = collectText(tree).join(' | ')
    // Narrow patterns on purpose: the page's own diagnostics hint contains the word 失败, and the
    // settings hint mentions saving, so a broad match would fail on the page's ordinary copy.
    assert.doesNotMatch(text, /打开文件夹选择器失败/, 'a cancelled dialog is not a failure')
    assert.doesNotMatch(text, /选文件夹本身不保存/, 'and nothing was put in the box to save')
    const field = collectByType(tree, 'input').find((node) => node.props.type === 'text')
    assert.equal(field.props.value, 'C:\\kept', 'the field keeps what it already held')
  } finally {
    undo()
    page.bundle.restore()
  }
})

test('a directory that is stored but not in effect says a restart is needed', async () => {
  /*
   * Both states showed the same thing before — the directory in use. "It never saved" and "it saved
   * and is not in effect" were indistinguishable, on the page and in the report that was filed.
   */
  const chosen = 'C:\\Users\\me\\picked-ws'
  // The host's own diagnostic, as it answers once the directory is saved and still not in effect.
  const stored = {
    ...STATUS,
    diagnostics: { ...STATUS.diagnostics, settingsWorkspace: chosen },
  }
  const page = await mountPage(pageRoutes(settingsRoute({ ...SETTINGS, workspacePath: chosen }), stored))
  try {
    const text = collectText(page.tree).join(' | ')
    assert.match(text, /重启 DSH 后才生效/, 'the page says the saved directory is not in use yet')
    assert.match(text, /C:\\Users\\me\\picked-ws/, 'and shows the value the settings file holds')
  } finally {
    page.bundle.restore()
  }
})

test('the effective directory and the stored one are shown apart', async () => {
  // Two rows, because they answer two questions: what conversations are using now, and what the
  // settings page has saved. With one row, a user who saved without restarting sees no change at
  // all and concludes the save did nothing.
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  try {
    const facts = collectByClass(page.tree, 'dsh-wechat-facts')
    const rows = collectByType(facts[0], 'div').filter((node) =>
      collectByType(node, 'dt').length === 1,
    )
    const byTerm = (term) => rows.find((row) => collectText(collectByType(row, 'dt')[0]).join('') === term)
    assert.equal(
      collectText(collectByType(byTerm('会话工作目录'), 'dd')[0]).join(''),
      'C:\\Users\\me\\.dsh\\dsh_wechat（正在使用）',
      'the row says this is the directory in use',
    )
    assert.match(
      collectText(collectByType(byTerm('设置里存的值'), 'dd')[0]).join(''),
      /^（未设置，用默认位置）/,
      'and the stored value is reported as unset rather than guessed at',
    )
  } finally {
    page.bundle.restore()
  }
})

test('a change that is not stored yet is pointed out while it is not', async () => {
  /*
   * Every control writes to the draft and none of them saves, while a filled box looks exactly like
   * a stored value. The report that produced these tests was, in the end, someone who believed the
   * page had saved and had no way to find out otherwise.
   */
  const page = await mountPage(pageRoutes(settingsRoute(SETTINGS)))
  try {
    assert.doesNotMatch(collectText(page.tree).join(' | '), /有改动还没保存/, 'nothing to save yet')

    const field = collectByType(page.tree, 'input').find((node) => node.props.type === 'text')
    field.props.onChange({ target: { value: 'C:\\typed-by-hand' } })
    const edited = await settle(page)
    assert.match(collectText(edited).join(' | '), /有改动还没保存/, 'typing is a change, not a save')
    assert.equal(
      page.calls.filter((call) => call.method === 'POST').length,
      0,
      'and typing must not save on its own',
    )

    findButton(edited, '保存设置').props.onClick()
    const saved = await settle(page)
    assert.match(collectText(saved).join(' | '), /已保存/, 'the save is confirmed')
    assert.doesNotMatch(
      collectText(saved).join(' | '),
      /有改动还没保存/,
      'and the form is no longer outstanding',
    )
  } finally {
    page.bundle.restore()
  }
})

test('the page and the host agree on the route prefix', async () => {  // The page calls routes; the host registers them. If the two strings drift, every request 404s and
  // the settings page renders empty — with no error anywhere, because a 404 is a valid response.
  const hostSource = await readFile(join(here, '..', 'src', 'host.ts'), 'utf8')
  const registered = /path:\s*'([^']+)'/.exec(hostSource)?.[1]
  assert.equal(
    registered,
    PREFIX,
    'the host route prefix and the page\'s PREFIX constant must be the same string',
  )

  /*
   * `routes.ts` is the third copy of this string, and it is the one that decides the paths the host
   * actually answers on: `host.ts` registers a prefix, but `routes.ts` composes the concrete paths
   * from its own `ROUTE_PREFIX`.
   *
   * Missing it shipped a broken release. The package was renamed, `host.ts` and `client.js` were
   * updated, and `routes.ts` was not — so the host registered `/.dsh-wechat-plugin` while every
   * handler compared against `/.dsh-wechat/…`. The settings page showed "status unavailable" and
   * nothing worked. The assertion above passed throughout, because it only checked the two copies that
   * had been edited. Hence this one: all three, always.
   */
  const routesSource = await readFile(join(here, '..', 'src', 'routes.ts'), 'utf8')
  const routePrefix = /ROUTE_PREFIX\s*=\s*'([^']+)'/.exec(routesSource)?.[1]
  assert.equal(
    routePrefix,
    PREFIX,
    'ROUTE_PREFIX in routes.ts must equal the page\'s PREFIX: it is what the host answers on',
  )
})

/**
 * The bundle is a classic script, and the shell evaluates it again on every rebuild.
 *
 * It is not a module: the shell loads it as an external `<script src=…?rev=…>`, so every revision
 * is a *new classic script* in the *same realm* and the *same global lexical scope*. A top-level
 * `let`, `const` or `class` is therefore declared twice once a rebuild arrives, and the second
 * script fails to parse:
 *
 *     Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
 *
 * The failure is silent where it matters. Parsing happens before the file's first statement, so the
 * registration never runs, no new copy replaces the entry, and the page keeps running the previous
 * revision until it is reloaded — a rebuild that looks like it did nothing. The mechanics are in the
 * shell's own packages: `dsh-client-modules` appends a `<script>` element for the bundle URL with
 * the next revision, and `dsh-client-hmr` calls `entries.reload(id, rev)` for a `rebuilt` frame.
 *
 * Hence this test: run the file twice in one context and require *both* runs to parse and register.
 * "Does not throw" alone would be satisfied by a guard that skips the second registration, which
 * reproduces the very symptom — a rebuilt bundle that never takes effect.
 */
test('the bundle can be evaluated again after a rebuild, in the page\'s own scope', async () => {
  const source = await readFile(clientPath, 'utf8')
  const registrations = []
  // The facade the shell installs, plus the globals a classic script in the page can see. Only
  // `window` is read while this file evaluates today; the rest are present so that a top-level
  // mention of one fails here as a name error instead of passing on a browser tolerance.
  const context = createContext({
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    navigator: { language: 'zh-CN' },
    document: { documentElement: { lang: 'zh-CN' } },
    fetch: () => Promise.resolve({}),
    Blob: class {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  })

  const evaluate = (revision) =>
    runInContext(source, context, { filename: `client.js?rev=${revision}` })

  assert.doesNotThrow(() => evaluate('first'), 'the first evaluation must succeed')
  assert.doesNotThrow(
    () => evaluate('rebuilt'),
    'a rebuild evaluates the whole file again, in the scope the page already has',
  )
  assert.deepEqual(
    registrations.map((registration) => registration.id),
    ['dsh-wechat-plugin', 'dsh-wechat-plugin'],
    'both copies register under the id whose entry they replace',
  )

  /*
   * And the reason it works: the file declares nothing in the shared scope. `var` and `function`
   * are tolerated by a second evaluation, but they still land in a realm the whole application
   * shares, so a name as ordinary as `PREFIX` would be a collision waiting to happen.
   */
  const declared = runInContext(
    'typeof PREFIX + "|" + typeof HANDBOOK_URL + "|" + typeof reportFailure',
    context,
  )
  assert.equal(declared, 'undefined|undefined|undefined', 'the bundle must keep to its own scope')
})
