// Standing orders: what the driver allows the controller to dispatch while
// they are away, so that it can chain work at night. A dispatch takes the
// driver's words from a voice request of the last minutes (channel.mjs), so
// at night nothing new could start. A standing order is made by voice, with
// the driver's words, checked as a dispatch's are (standing_order): a
// repository (or a work folder), a scope in their words ("continue the
// Simple Modern milestones from the concept"), and an expiry, by default the
// end of the quiet hours (night.mjs), at most MAX_HOURS. While it holds, the
// controller may dispatch tasks for that repository within that scope citing
// the order's id instead of fresh words; the gateway logs each, the worker
// reads the scope and stays within it, and open_items shows the order.
//
// What still stops everything stops these too: the kill switch, which also
// ends every order (after an alarm the driver says again what may go on), a
// standby, the usage limit's wait (workers.mjs). Text from workers or GitHub
// can never make or extend one: only the driver's words make an order, and
// none is ever extended; a new one takes new words. Kept in
// .state/orders.json, ended ones for a week, for reference.

import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { clock } from './limits.mjs'
import { log as defaultLog, preview } from './log.mjs'

export const MAX_HOURS = 24
export const DEFAULT_HOURS = 12 // without quiet hours
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ORDER_ID = /^o[a-z0-9]{3}$/

export class Orders {
  constructor({ file = null, now = () => Date.now(), log = defaultLog } = {}) {
    this.file = file
    this.now = now
    this.log = log
    this.orders = []
    this.load()
  }

  load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      this.orders = (Array.isArray(saved.orders) ? saved.orders : []).filter(
        order =>
          order &&
          ORDER_ID.test(order.id) &&
          ['worker', 'scope', 'words'].every(key => typeof order[key] === 'string') &&
          Number.isFinite(order.createdAt) &&
          Number.isFinite(order.until),
      )
      for (const order of this.orders) {
        order.tasks = Array.isArray(order.tasks) ? order.tasks.filter(id => typeof id === 'string') : []
        order.folders = Array.isArray(order.folders) ? order.folders.filter(name => typeof name === 'string') : []
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('standing orders file unreadable, starting without orders:', error.message)
    }
  }

  save() {
    const now = this.now()
    this.orders = this.orders.filter(order => !this.over(order, now) || now - (order.endedAt ?? order.until) < KEEP_MS)
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ orders: this.orders }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('standing orders not saved:', error.message)
    }
  }

  over(order, now = this.now()) {
    return Boolean(order.endedAt) || now >= order.until
  }

  // A new order, on the driver's words, which the caller checked: worker,
  // scope and words as said, request the voice request they came from,
  // until when, which is cut to MAX_HOURS.
  add({ worker, scope, words, request = null, via = 'voice', until }) {
    const now = this.now()
    let id
    do id = `o${Array.from({ length: 3 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')}`
    while (this.orders.some(order => order.id === id))
    const order = {
      id,
      worker,
      scope: preview(scope, 400),
      words: preview(words, 400),
      request,
      via, // voice, or telegram for words typed there: no push straight to main under it (channel.mjs)
      createdAt: now,
      until: Math.min(Math.max(until, now + 60 * 1000), now + MAX_HOURS * 60 * 60 * 1000),
      endedAt: null,
      endedWhy: null,
      tasks: [], // the tasks dispatched under it, t… or q…
      folders: [], // work folders its tasks made, for an order for scratch/new
    }
    this.orders.push(order)
    this.save()
    this.log(`standing order ${id} for ${worker}, until ${new Date(order.until).toISOString()}: "${preview(scope, 120)}"`)
    return order
  }

  get(id) {
    return this.orders.find(order => order.id === String(id ?? '').trim().toLowerCase()) ?? null
  }

  // The orders that hold now.
  active(now = this.now()) {
    return this.orders.filter(order => !this.over(order, now))
  }

  // Whether a dispatch for `worker` may cite order `id`: { ok, order, why }.
  // An order for scratch/new also covers the work folders its tasks made.
  check(id, worker) {
    const order = this.get(id)
    if (!order) return { ok: false, why: `there is no standing order ${preview(String(id ?? ''), 20)}` }
    if (order.endedAt) return { ok: false, order, why: `standing order ${order.id} was ended (${order.endedWhy})` }
    if (this.now() >= order.until) return { ok: false, order, why: `standing order ${order.id} ran out at ${clock(order.until, this.now())}` }
    if (order.worker !== worker && !order.folders.includes(worker)) {
      return { ok: false, order, why: `standing order ${order.id} is for ${order.worker}, not ${worker}` }
    }
    return { ok: true, order, why: null }
  }

  // A task dispatched under an order: its id, and the work folder it made.
  used(order, id, folder = null) {
    if (id && !order.tasks.includes(id)) order.tasks.push(id)
    if (folder && folder !== order.worker && !order.folders.includes(folder)) order.folders.push(folder)
    this.save()
  }

  // Ends an order before its time; why, in a few words. Whether it held.
  end(id, why = 'ended') {
    const order = this.get(id)
    if (!order || this.over(order)) return false
    Object.assign(order, { endedAt: this.now(), endedWhy: why })
    this.save()
    this.log(`standing order ${order.id} ended: ${why}`)
    return true
  }

  // Every order that holds ends: the kill switch locked. Returns them.
  endAll(why) {
    const ended = this.active()
    for (const order of ended) Object.assign(order, { endedAt: this.now(), endedWhy: why })
    if (ended.length) {
      this.save()
      this.log(`standing orders ended (${why}): ${ended.map(order => order.id).join(', ')}`)
    }
    return ended
  }

  // The orders that hold, a sentence each, for open_items and the answers.
  lines(now = this.now()) {
    return this.active(now).map(order => {
      const tasks = order.tasks.length ? `; dispatched under it: ${order.tasks.join(', ')}` : ''
      return `Standing order ${order.id} for ${order.worker}, until ${clock(order.until, now)}: "${order.scope}"${tasks}.`
    })
  }
}

// What a run under an order reads (workers.mjs, runLines).
export const orderRule = order =>
  `- Standing order ${order.id}: the driver is away and allowed tasks for this ${order.worker.startsWith('scratch/') ? 'work folder' : 'repository'} ` +
  `within this scope, in their words: "${order.scope}". This task comes under it. Stay within it; what falls outside, ` +
  'note as a deferred question instead of doing it.'
