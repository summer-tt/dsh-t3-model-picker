import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Use the factory definition from the shipped source, without a browser or
// another copy of the compatibility adapter.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function createSubmissionGuard(')
const end = source.indexOf('\n    // End submission guard', start)
assert.ok(start >= 0 && end > start)
const createGuard = new Function(`${source.slice(start, end)}\nreturn createSubmissionGuard`)()

class Session {
  args = []
  abandoned = []
  #next = 0

  beginSubmission() {
    const requestId = String(++this.#next)
    return { requestId, abandon: () => this.abandoned.push(requestId) }
  }

  async prompt(...args) {
    this.args.push(args)
    return { ok: true, value: { accepted: true } }
  }
}

const session = new Session()
const binding = { sessionId: 's', session }
let current = binding
const guard = createGuard(() => current)
let pending
let sealCount = 0
const detach = guard.register(binding, () => { sealCount++ }, () => pending)
assert.equal(typeof detach, 'function')

const content = [{ type: 'text', text: 'draft' }]
const first = Promise.withResolvers()
const second = Promise.withResolvers()
pending = first.promise
const handle = session.beginSubmission({ text: 'draft' })
assert.equal(sealCount, 1)
const signal = new AbortController().signal
const sent = session.prompt(content, 'queue', signal, handle.requestId)
assert.equal(session.args.length, 0)
pending = second.promise
first.resolve()
await first.promise
assert.equal(session.args.length, 0)
second.resolve()
assert.equal((await sent).ok, true)
assert.deepEqual(session.args, [[content, 'queue', signal, handle.requestId]])
assert.deepEqual(session.abandoned, [])

const failure = Promise.withResolvers()
pending = failure.promise
const denied = session.beginSubmission({ text: 'keep original draft' })
// Attachment serialization can outlast the failing settings operation.
pending = undefined
failure.reject(new Error('save failed'))
assert.equal((await session.prompt(content, 'steer', signal, denied.requestId)).ok, false)
denied.abandon()
assert.deepEqual(session.abandoned, [denied.requestId])
assert.equal(session.args.length, 1)

const controller = new AbortController()
pending = new Promise(() => {})
const cancelled = session.beginSubmission({})
const cancelledSend = session.prompt(content, 'queue', controller.signal, cancelled.requestId)
controller.abort()
assert.equal((await cancelledSend).ok, false)
assert.deepEqual(session.abandoned, [denied.requestId, cancelled.requestId])

pending = undefined
const beforeReset = session.beginSubmission({})
guard.reset()
assert.equal((await session.prompt(content, 'queue', signal, beforeReset.requestId)).ok, false)
assert.ok(session.abandoned.includes(beforeReset.requestId))

const attachmentError = session.beginSubmission({})
attachmentError.abandon()
attachmentError.abandon()
assert.equal(session.abandoned.filter(id => id === attachmentError.requestId).length, 1)

const previousGeneration = session.beginSubmission({})
current = { ...binding, session: new Session() }
detach()
assert.equal((await session.prompt(content, 'queue', signal, previousGeneration.requestId)).ok, false)
assert.ok(session.abandoned.includes(previousGeneration.requestId))
assert.equal(Object.hasOwn(session, 'prompt'), false)
assert.equal(Object.hasOwn(session, 'beginSubmission'), false)
const hotSession = new Session()
const hotBinding = { sessionId: 'hot', session: hotSession }
const oldGuard = createGuard(() => hotBinding)
const oldSave = Promise.withResolvers()
oldGuard.register(hotBinding, () => {}, () => oldSave.promise)
const oldAttempt = hotSession.beginSubmission({})
const oldSend = hotSession.prompt(content, 'queue', signal, oldAttempt.requestId)
oldGuard.dispose()
const newGuard = createGuard(() => hotBinding)
newGuard.register(hotBinding, () => {}, () => undefined)
assert.equal((await oldSend).ok, false)
assert.deepEqual(hotSession.abandoned, [oldAttempt.requestId])
const newAttempt = hotSession.beginSubmission({})
const newSend = hotSession.prompt(content, 'queue', signal, newAttempt.requestId)
assert.equal(hotSession.args.length, 0)
oldSave.resolve()
assert.equal((await newSend).ok, true)
assert.equal(hotSession.args.length, 1)
newGuard.dispose()
assert.equal(Object.hasOwn(hotSession, 'prompt'), false)
console.log('Submission guard passed for success, later saves, failure after serialization, abort, reset, attachment failure, Session replacement and hot reload')
