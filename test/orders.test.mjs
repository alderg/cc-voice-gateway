// Standing orders (orders.mjs): made on the driver's words, for one
// repository, a scope and an expiry; checked when a dispatch cites one; kept
// across a restart; ended by their time, by the controller and by the kill
// switch. How the gateway uses them is in workers.test.mjs (dispatch with
// order) and killswitch.test.mjs (the lock ends them).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderUntil } from '../src/channel.mjs'
import { Night } from '../src/night.mjs'
import { DEFAULT_HOURS, MAX_HOURS, Orders, orderRule } from '../src/orders.mjs'
import { runLines } from '../src/workers.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'voice-gw-orders-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const HOUR = 3600 * 1000
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

function ordersAt(start, file = null) {
  const clock = { now: start }
  return { clock, orders: new Orders({ file, now: () => clock.now, log: () => {} }) }
}

test('an order: its id, its scope and words as said, until when, at most 24 hours', () => {
  const { clock, orders } = ordersAt(at(31, 22))
  const order = orders.add({ worker: 'alpha', scope: 'continue the Simple Modern milestones from the concept', words: 'keep going with the milestones tonight', request: 'r2ab', until: at(32, 7, 30) })
  assert.match(order.id, /^o[a-z0-9]{3}$/)
  assert.equal(order.until, at(32, 7, 30))
  assert.equal(order.request, 'r2ab')
  assert.equal(orders.add({ worker: 'beta', scope: 's', words: 'w', until: clock.now + 48 * HOUR }).until, clock.now + MAX_HOURS * HOUR)
  assert.equal(orders.add({ worker: 'beta', scope: 's', words: 'w', until: clock.now - HOUR }).until, clock.now + 60 * 1000, 'not already over')
  assert.equal(orders.active().length, 3)
  assert.deepEqual(orders.check(order.id.toUpperCase(), 'alpha'), { ok: true, order, why: null })
})

test('check: only for its repository, while it holds, unless ended; an order for scratch/new covers its folders', () => {
  const { clock, orders } = ordersAt(at(31, 22))
  const order = orders.add({ worker: 'alpha', scope: 'the milestones', words: 'keep going', until: at(32, 2) })
  assert.match(orders.check(order.id, 'beta').why, new RegExp(`^standing order ${order.id} is for alpha, not beta$`))
  assert.match(orders.check('ozzz', 'alpha').why, /^there is no standing order ozzz$/)
  orders.used(order, 't1ab')
  orders.used(order, 't1ab')
  assert.deepEqual(order.tasks, ['t1ab'])
  assert.deepEqual(orders.lines(), [`Standing order ${order.id} for alpha, until 02:00 on 1 Nov: "the milestones"; dispatched under it: t1ab.`])
  clock.now = at(32, 2)
  assert.match(orders.check(order.id, 'alpha').why, /ran out at 02:00$/)
  assert.deepEqual(orders.lines(), [])

  const scratch = orders.add({ worker: 'scratch/new', scope: 'research the trip', words: 'look into the trip', until: at(32, 6) })
  orders.used(scratch, 't2cd', 'scratch/2026-11-01-ab12')
  assert.equal(orders.check(scratch.id, 'scratch/2026-11-01-ab12').ok, true, 'a follow-up in its folder')
  assert.equal(orders.check(scratch.id, 'scratch/other').ok, false)
  assert.equal(orders.end(scratch.id, 'ended by the controller'), true)
  assert.equal(orders.end(scratch.id), false, 'once')
  assert.match(orders.check(scratch.id, 'scratch/new').why, /was ended \(ended by the controller\)$/)
})

test('the kill switch ends every order that holds; kept across a restart, ended ones a week', () => {
  const file = join(TMP, 'orders.json')
  const first = ordersAt(at(31, 22), file)
  const a = first.orders.add({ worker: 'alpha', scope: 'a', words: 'w a', until: at(32, 6) })
  const b = first.orders.add({ worker: 'beta', scope: 'b', words: 'w b', until: at(32, 6) })
  first.orders.end(b.id, 'done')
  const again = ordersAt(at(31, 23), file)
  assert.deepEqual(again.orders.active().map(order => order.id), [a.id])
  assert.deepEqual(again.orders.endAll('the kill switch locked (voice)').map(order => order.id), [a.id])
  assert.match(again.orders.check(a.id, 'alpha').why, /was ended \(the kill switch locked \(voice\)\)$/)
  const later = ordersAt(at(31, 23) + 8 * 24 * HOUR, file)
  later.orders.save()
  assert.equal(later.orders.orders.length, 0, 'gone after a week')
})

test('until when a new order holds: the hours given; else the night, the next quiet hours, or 12 hours; at most 24', () => {
  const now = at(31, 21)
  assert.equal(orderUntil(null, 3, now), now + 3 * HOUR)
  assert.equal(orderUntil(null, 30, now), now + MAX_HOURS * HOUR)
  assert.equal(orderUntil(null, null, now), now + DEFAULT_HOURS * HOUR)
  const quiet = new Night({ hours: '23:00-07:30', now: () => now, log: () => {} })
  assert.equal(orderUntil(quiet, null, now), at(32, 7, 30), 'the end of the next quiet hours')
  const away = new Night({ now: () => now, log: () => {} })
  away.away('voice')
  assert.equal(orderUntil(away, null, now), now + 12 * HOUR, 'the end of the night going')
})

test('a run under an order reads its scope, for a repository or a work folder', () => {
  const order = { id: 'o2ab', worker: 'alpha', scope: 'the milestones' }
  assert.equal(
    orderRule(order),
    '- Standing order o2ab: the driver is away and allowed tasks for this repository within this scope, in their words: ' +
      '"the milestones". This task comes under it. Stay within it; what falls outside, note as a deferred question ' +
      'instead of doing it.',
  )
  assert.match(orderRule({ ...order, worker: 'scratch/new' }), /tasks for this work folder within/)
  assert.equal(runLines({ order }), `${orderRule(order)}\n`)
})
