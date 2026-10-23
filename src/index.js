// dsh-cost-lite: HOST half.
//
// Folds `assistant/message` session events into per-session cost accumulators and serves
// them to the client badge over one read-only HTTP endpoint:
//   GET /__cost-lite/usage?sessionId=<id>   (driven by the person, no agent tool)
//
// Design notes (WHY, not what):
//  - The client polls, so every answer must be a pure function of the folded history: no
//    clock, no randomness, no session-log writes (spec §6).
//  - Sessions are seeded lazily from the committed log (`ownEvents()`) and then advanced
//    from the live `session/event` feed. Each (provider, model) bucket is folded once and
//    never re-read, so FOLDING stays O(new events) per poll instead of O(session); BUILDING
//    the response is O(tracked messages + turns) every poll, bounded by the guards below.
//  - Subagent children fold in their OWN session states, discovered from the parent's
//    `subagent/catalog` events (parent-owned, durable). A read merges the whole descendant
//    tree into one `subagents` block and `allCost` = own + descendants. Child prefix
//    (`ownEvents()` / `events.slice(inheritedEventCount)`) never re-counts parent turns:
//    a fork child's log starts with a copy of the parent's events, and the inherited
//    prefix is exactly what both read paths drop.
//  - Nothing may escape into the host: this file guards URL parsing, the sessions
//    service, event shapes and the response writer. A detached session is a normal
//    all-zero answer, not an error.
import { DEFAULT_PRICE, pricingFromConfig } from './pricing.js'

const name = 'cost-lite'
// `webServer` and `sessions` are optional (a terminal-only profile has neither), so they
// are fetched defensively inside apply()/the handler rather than required at load.
const inject = []

const ROUTE = '/__cost-lite/usage'

// Response-size guards (spec §2: body ≤ ~256 KB). These trim only the *serialized*
// breakdown lists, oldest first. Token and cost totals are accumulated from the per-model
// buckets independently of these maps, so trimming a breakdown can never change a headline
// number — and a trim must never drop tokens (see addToBuckets).
// ponytail: the true worst case is MAX_MESSAGES x 8 models ≈ 1 MB, above the ~256 KB hint;
// the upgrade path is real per-entry truncation (or server-side paging), deliberately not
// built while the badge only renders one session summary.
// shortcut: per-session state is never evicted (a polled session keeps ~200 KB worst case);
// add an eviction pass if a long-lived host ever polls thousands of distinct sessions.
const MAX_MESSAGES = 400
const MAX_TURNS = 200
// Family walk guards: descendants beyond the cap are simply not summed on that read
// (bounded BFS); the retry bound keeps one deleted child id from re-reading storage
// every poll.
const MAX_DESCENDANTS = 128
const READ_RETRY_MS = 30000
const READ_TIMEOUT_MS = 5000
// Idempotence guard: a session log can hold thousands of events, so the chain of folded seq
// numbers is bounded. The OLDEST seq is evicted first — never the whole set: clearing it
// let a redelivered old event be folded twice.
const MAX_SEEN_SEQS = 20000

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// DeepSeek reports token counts that are sometimes missing and occasionally fractional;
// anything that is not a positive finite number contributes nothing.
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function integerOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function round(value, digits) {
  if (!Number.isFinite(value) || value === 0) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// --- 高峰 / 空闲 tier -----------------------------------------------------------
//
// DeepSeek doubles the 空闲 rates during 高峰时段 (flash 空闲 1/0.02/4 → 高峰 2/0.04/8).
// Source (fetched 2026-10-11): https://api-docs.deepseek.com/zh-cn/quick_start/pricing —
// 高峰时段 = 北京时间周一至周五(非法定节假日) 9:00-12:00 与 14:00-18:00；其余时间(含周末与
// 法定节假日)全天为「空闲时段」. The reference implementation records the same windows as
// UTC 01:00-04:00 / 06:00-10:00 (temp/dsh-cost-meter/lib/pricing.js:24-25).
const PEAK_MULTIPLIER = 2

// 法定节假日 as Beijing calendar days — 国务院办公厅 2026 年部分节假日安排, the same list the
// reference implementation carries (temp/dsh-cost-meter/lib/pricing.js:59-64).
// ponytail: refresh this list every year. A weekday holiday that is NOT listed is charged
// 2× — overstating is the accepted direction (never understate); the upgrade path is a
// bundled calendar (or a `config` override) instead of a hand-maintained array.
const PEAK_HOLIDAYS = Object.freeze([
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])
const MS_PER_DAY = 24 * 60 * 60 * 1000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
// Precomputed integer day indexes so a holiday test is one Set lookup per event.
const PEAK_HOLIDAY_DAYS = new Set(PEAK_HOLIDAYS.map((key) => Date.parse(`${key}T00:00:00Z`) / MS_PER_DAY))

/**
 * Is this instant inside 高峰时段? The tier comes from the EVENT's own `time` — an immutable
 * property of the stored event — never from a clock read at fold or render time, so a polled
 * answer stays a pure function of the log and cannot drift between polls.
 *
 * A missing, NaN or non-numeric timestamp is OFF-peak, which preserves the numbers an
 * untimestamped log produced before this tier existed.
 *
 * ponytail: the timestamp is the `assistant/message` event's own `time` (the settlement
 * instant), not the request's start, so a request straddling a boundary minute is billed at
 * its settlement tier. `event.startedAtMs` is the upgrade path — the reference bills from it
 * (temp/dsh-cost-meter/lib/native-search-billing.js:360) — but that needs request-start
 * tracking, which this fold deliberately avoids.
 * ponytail: calls older than DeepSeek's 2026-08-16 base-price change are out of scope; the
 * flat-price era (flash 基础价 输入 ¥1 / 输出 ¥2) is not modelled, so such a session is
 * priced with today's table (the reference keeps LEGACY_BASE_BOUNDARY/_PRICES for it).
 */
function isPeakHour(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return false
  const shifted = at + BEIJING_OFFSET_MS
  // Integer day index -> both the Beijing calendar day and its weekday, with no local-time
  // read: epoch day 0 (1970-01-01) was a Thursday, so (day + 4) % 7 is 0=Sun .. 6=Sat.
  const day = Math.floor(shifted / MS_PER_DAY)
  const weekday = (day + 4) % 7
  if (weekday < 1 || weekday > 5) return false
  if (PEAK_HOLIDAY_DAYS.has(day)) return false
  const hour = Math.floor((((shifted % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 3600000)
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

// --- folding ------------------------------------------------------------------

function createSessionState() {
  return {
    seeded: false,
    seen: new Set(),
    models: new Map(),
    messages: new Map(),
    turns: new Map(),
    // Direct-child session ids from `subagent/catalog` events in this session's OWN log.
    childIds: new Set(),
    // Cold-read bookkeeping for descendant seeding (see seedChildState).
    loading: undefined,
    nextTryAt: 0,
  }
}

function addToBuckets(buckets, provider, model, tokens, peak) {
  const key = `${provider}\u0000${model}`
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    // Every distinct model keeps its tokens counted; the bucket map is never capped, because
    // dropping a bucket silently drops that model's tokens from the session total.
    bucket = {
      provider, model,
      input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
      // The 高峰 share of each bucket is tracked next to the total, so buildEntry can price
      // the two shares separately and still emit an honest blended *Price.
      inputPeak: 0, cacheReadPeak: 0, cacheWritePeak: 0, outputPeak: 0,
    }
    buckets.set(key, bucket)
  }
  bucket.input += tokens.input
  bucket.cacheRead += tokens.cacheRead
  bucket.cacheWrite += tokens.cacheWrite
  bucket.output += tokens.output
  if (peak) {
    bucket.inputPeak += tokens.input
    bucket.cacheReadPeak += tokens.cacheRead
    bucket.cacheWritePeak += tokens.cacheWrite
    bucket.outputPeak += tokens.output
  }
}

/**
 * Fold one session event into an accumulator. Returns silently for anything that is not a
 * billable `assistant/message` — notably aborted attempts, which carry no `usage` (spec §2)
 * — and for every event whose (provider, model) has no price row: OFFICIAL PROVIDER ONLY
 * (user decision m01476), so an unbilled step costs nothing at all — no tokens, no cost, no
 * breakdown row, and no turn/message entry, which is what lets the client render nothing for
 * a non-official turn instead of a zero.
 */
function foldEvent(state, event, pricing) {
  if (!isPlainObject(event)) return
  // Parent-owned durable discovery fact: one catalog event names one direct child. It
  // carries no usage, so the billable path below must never see it.
  if (event.type === 'subagent/catalog') {
    const childId = isPlainObject(event.data) ? event.data.childId : undefined
    if (typeof childId === 'string' && childId !== '' && !UNSAFE_KEYS.has(childId) && state.childIds.size < MAX_DESCENDANTS) {
      state.childIds.add(childId)
    }
    return
  }
  if (event.type !== 'assistant/message') return
  const data = event.data
  if (!isPlainObject(data)) return
  const usage = data.usage
  if (!isPlainObject(usage)) return

  const message = isPlainObject(data.message) ? data.message : undefined
  const source = isPlainObject(message?.source) ? message.source : undefined
  // Provider/model decide whether the event is billable at all, so a missing source means
  // "not billed" rather than a guessed row.
  const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : 'unknown'
  const model = typeof source?.model === 'string' && source.model !== '' ? source.model : 'unknown'
  if (pricing.priceFor(provider, model) === undefined) return

  // 高峰 or 空闲 is a property of the stored event's own timestamp (see isPeakHour).
  const peak = isPeakHour(event.time)
  const tokens = {
    input: tokenCount(usage.inputTokens),
    cacheRead: tokenCount(usage.cacheReadTokens),
    cacheWrite: tokenCount(usage.cacheWriteTokens),
    output: tokenCount(usage.outputTokens),
  }

  addToBuckets(state.models, provider, model, tokens, peak)

  const turn = integerOr(data.turn, 0)
  const step = integerOr(data.step, 0)
  let turnEntry = state.turns.get(turn)
  if (turnEntry === undefined) {
    turnEntry = { turn, step, models: new Map() }
    state.turns.set(turn, turnEntry)
    // Evict the OLDEST turn (insertion-ordered Map), so the newest MAX_TURNS turns survive.
    while (state.turns.size > MAX_TURNS) {
      const oldest = state.turns.keys().next()
      if (oldest.done) break
      state.turns.delete(oldest.value)
    }
  }
  turnEntry.step = Math.max(turnEntry.step, step)
  addToBuckets(turnEntry.models, provider, model, tokens, peak)

  const messageId = typeof message?.id === 'string' && message.id !== '' ? message.id : undefined
  if (messageId !== undefined && !UNSAFE_KEYS.has(messageId)) {
    let messageEntry = state.messages.get(messageId)
    if (messageEntry === undefined) {
      messageEntry = { turn, step, models: new Map() }
      state.messages.set(messageId, messageEntry)
      while (state.messages.size > MAX_MESSAGES) {
        const oldest = state.messages.keys().next()
        if (oldest.done) break
        state.messages.delete(oldest.value)
      }
    } else {
      // A message id is folded once, but keep the newest turn/step if a session log
      // replays it across turns.
      messageEntry.turn = turn
      messageEntry.step = step
    }
    addToBuckets(messageEntry.models, provider, model, tokens, peak)
  }
}

/**
 * Record a folded seq as seen.
 *
 * The `seen` set — not a `seq <= lastSeq` watermark — is the idempotence guard, because a
 * Session may expose either the last committed or the next sequence number, so a watermark
 * comparison would drop real events. The set is FIFO-bounded by MAX_SEEN_SEQS and NEVER
 * cleared: wiping it let a redelivered old event fold a second time and inflate the total.
 * The bound applies to the seed path and the live path alike, so neither can grow without
 * limit on a long-lived session.
 */
function rememberSeq(state, seq) {
  while (state.seen.size >= MAX_SEEN_SEQS) {
    const oldest = state.seen.values().next()
    if (oldest.done) break
    state.seen.delete(oldest.value)
  }
  state.seen.add(seq)
}

/**
 * Seed from a caller-supplied event array exactly once (the cold-read path hands over a
 * pre-sliced clone; the live-session path slices via `ownEvents()`).
 */
function seedSessionFromEvents(state, events, pricing) {
  // Mark seeded BEFORE folding. A fold that throws used to leave the session looking
  // unseeded while its tokens were already accumulated, so every later poll re-folded the
  // whole log and doubled the totals forever. With the per-event try/catch below, one
  // malformed record now costs one event instead of the entire session.
  state.seeded = true
  if (!Array.isArray(events)) return
  for (const event of events) {
    try {
      foldEvent(state, event, pricing)
      const seq = isPlainObject(event) ? event.seq : undefined
      if (typeof seq === 'number' && Number.isFinite(seq)) rememberSeq(state, seq)
    } catch {
      // Skip the malformed record and keep folding the rest of the log.
    }
  }
}

/** Seed a live session from its committed log; `ownEvents()` drops the fork-inherited prefix. */
function seedSession(state, session, pricing) {
  let events = []
  try {
    if (typeof session.ownEvents === 'function') events = session.ownEvents()
  } catch {
    events = [] // a detached/half-open session: answer with whatever we can see
  }
  seedSessionFromEvents(state, events, pricing)
}

/** Field-wise union of two per-model bucket maps; the copy never aliases the source. */
function mergeBuckets(target, source) {
  for (const [key, bucket] of source) {
    const own = target.get(key)
    if (own === undefined) {
      target.set(key, { ...bucket })
      continue
    }
    own.input += bucket.input
    own.cacheRead += bucket.cacheRead
    own.cacheWrite += bucket.cacheWrite
    own.output += bucket.output
    own.inputPeak += bucket.inputPeak
    own.cacheReadPeak += bucket.cacheReadPeak
    own.cacheWritePeak += bucket.cacheWritePeak
    own.outputPeak += bucket.outputPeak
  }
}

// --- pricing / shaping --------------------------------------------------------

const MODEL_RATE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']
const COST_KEY_BY_RATE = {
  input: 'inputCost',
  cacheRead: 'cacheReadCost',
  cacheWrite: 'cacheWriteCost',
  output: 'outputCost',
}
const PRICE_KEY_BY_RATE = {
  input: 'inputPrice',
  cacheRead: 'cacheReadPrice',
  cacheWrite: 'cacheWritePrice',
  output: 'outputPrice',
}

/**
 * Turn one set of model buckets into the wire entry shared by `session`, `messages[...]`
 * and `turns[...]` (spec §2). Costs are CNY; rates are CNY per 1M tokens.
 */
function buildEntry(buckets, pricing) {
  const models = []
  let cost = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0

  for (const bucket of buckets.values()) {
    // Unknown models resolve to no rates: price fields stay 0 and `priced` is false.
    // DEFAULT_PRICE is the documented zero floor, never a guessed number (spec §5).
    const priced = pricing.priceFor(bucket.provider, bucket.model) !== undefined
    const rates = pricing.priceFor(bucket.provider, bucket.model) ?? DEFAULT_PRICE

    const entry = {
      provider: bucket.provider,
      model: bucket.model,
      priced,
      inputTokens: bucket.input,
      cacheReadTokens: bucket.cacheRead,
      cacheWriteTokens: bucket.cacheWrite,
      outputTokens: bucket.output,
      totalTokens: bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output,
      cost: 0,
      inputPrice: rates.input,
      cacheReadPrice: rates.cacheRead,
      cacheWritePrice: rates.cacheWrite,
      outputPrice: rates.output,
      inputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      outputCost: 0,
    }

    let modelCost = 0
    for (const key of MODEL_RATE_KEYS) {
      const bucketTokens = { input: entry.inputTokens, cacheRead: entry.cacheReadTokens, cacheWrite: entry.cacheWriteTokens, output: entry.outputTokens }[key]
      const peakTokens = { input: bucket.inputPeak, cacheRead: bucket.cacheReadPeak, cacheWrite: bucket.cacheWritePeak, output: bucket.outputPeak }[key]
      const rate = rates[key]
      // Off-peak share at the base rate, 高峰 share at ×2; cacheWrite keeps rate 0, so its
      // ×2 stays 0.
      const raw = priced ? ((bucketTokens - peakTokens) / 1e6) * rate + (peakTokens / 1e6) * rate * PEAK_MULTIPLIER : 0
      const part = round(raw, 6)
      // The frozen client contract carries ONE price per bucket, so emit the EFFECTIVE
      // (blended) rate instead of a tier pair: a peak-only bucket reads ￥2.00/M, a mixed
      // one the true average, and an off-peak bucket is byte-for-byte the base rate.
      entry[PRICE_KEY_BY_RATE[key]] = priced && bucketTokens > 0 ? round(raw / (bucketTokens / 1e6), 6) : rate
      entry[COST_KEY_BY_RATE[key]] = part
      modelCost += part
    }
    entry.cost = round(modelCost, 6)

    cost += entry.cost
    inputTokens += entry.inputTokens
    cacheReadTokens += entry.cacheReadTokens
    cacheWriteTokens += entry.cacheWriteTokens
    outputTokens += entry.outputTokens
    models.push(entry)
  }

  // Sort by cost desc (spec §2); provider/model asc makes ties deterministic.
  models.sort((a, b) => (b.cost - a.cost) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  const priced = models.some((entry) => entry.priced)

  const cacheDenominator = inputTokens + cacheReadTokens
  return {
    cost: round(cost, 6),
    priced,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    cacheHitRate: cacheDenominator > 0 ? round(cacheReadTokens / cacheDenominator, 4) : 0,
    models,
  }
}

/**
 * @param descendants - `{ models, count }` from the family walk: merged per-model buckets
 * of every descendant session, and how many sessions were folded. `undefined` (no walk
 * ran) means "omit the `subagents` block; `allCost` is the own cost".
 */
function buildPayload(sessionId, state, pricing, descendants) {
  const totals = buildEntry(state.models, pricing)
  // Spec §2 freezes the `session` key set: `priced` is a TOP-LEVEL field and also appears on
  // every messages/turns entry, but not on `session` — so it is lifted out here rather than
  // spread in (buildEntry always carries it for the per-message/turn entries).
  const { priced: ownPriced, ...session } = totals

  const messages = Object.create(null)
  for (const [messageId, entry] of state.messages) {
    messages[messageId] = { turn: entry.turn, step: entry.step, ...buildEntry(entry.models, pricing) }
  }

  const turns = Object.create(null)
  for (const turn of [...state.turns.keys()].sort((a, b) => a - b)) {
    const entry = state.turns.get(turn)
    turns[String(turn)] = { turn: entry.turn, step: entry.step, ...buildEntry(entry.models, pricing) }
  }

  const sub = descendants === undefined ? undefined : buildEntry(descendants.models, pricing)
  const subagents = sub === undefined ? undefined : {
    count: descendants.count,
    priced: sub.priced,
    cost: sub.cost,
    totalTokens: sub.totalTokens,
  }
  const subCost = subagents === undefined || !subagents.priced ? 0 : subagents.cost

  return {
    ok: true,
    sessionId,
    currency: pricing.currency,
    // The flag is about the WHOLE answer the badge headlines: the session badge shows
    // `allCost`, so it renders when either the own log or a descendant priced anything.
    priced: ownPriced || subCost > 0,
    // Headline for the session badge: own session + every descendant, rounded once at
    // the top so the popover amount is the sum of its rows.
    allCost: round(session.cost + subCost, 6),
    session,
    messages,
    turns,
    subagents,
  }
}

// The client renders "—" for this shape and stays silent (spec §2): an unknown or
// detached session is never an error for the badge.
function buildEmptyPayload(sessionId, pricing) {
  return {
    ok: true,
    sessionId,
    currency: pricing.currency,
    priced: false,
    allCost: 0,
    session: {
      cost: 0,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
      models: [],
    },
    messages: Object.create(null),
    turns: Object.create(null),
    subagents: { count: 0, priced: false, cost: 0, totalTokens: 0 },
  }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload, extraHeaders) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"error":"serialization failed"}'
    status = 500
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  } catch {
    // The client hung up mid-poll: nothing to do, and nothing may throw into the host.
  }
}

function readSessionId(req) {
  try {
    const rawUrl = typeof req?.url === 'string' ? req.url : ''
    const url = new URL(rawUrl, 'http://localhost')
    return (url.searchParams.get('sessionId') ?? '').trim()
  } catch {
    return ''
  }
}

// --- plugin -------------------------------------------------------------------

function apply(ctx, config) {
  const pricing = pricingFromConfig(config)
  const states = new Map()

  function stateFor(sessionId) {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = createSessionState()
      states.set(sessionId, state)
    }
    return state
  }

  // Live feed: only sessions already seeded on a read are advanced, so a session can
  // never be half-folded (its history comes from ownEvents() at seed time).
  function onSessionEvent(session, event) {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : undefined
      if (sessionId === undefined) return
      const state = states.get(sessionId)
      if (state === undefined || !state.seeded) return
      const seq = isPlainObject(event) ? event.seq : undefined
      const hasSeq = typeof seq === 'number' && Number.isFinite(seq)
      if (hasSeq && state.seen.has(seq)) return
      foldEvent(state, event, pricing)
      if (hasSeq) rememberSeq(state, seq)
    } catch {
      // A malformed event must never throw into the host's commit path.
    }
  }

  /**
   * Seed one descendant. Live children fold `ownEvents()` for free; cold ones are read
   * from persistence via `sessionQuery.readSession` and sliced at `inheritedEventCount`,
   * the same drop `ownEvents()` does for a forked live session — the inherited prefix is
   * the parent's own history, already counted in the parent's state.
   */
  async function seedChildState(state, childId, sessions, sessionQuery) {
    if (state.seeded) return
    if (state.loading !== undefined) {
      await state.loading
      return
    }
    let live
    try {
      live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(childId) : undefined
    } catch {
      live = undefined
    }
    if (live !== undefined && live !== null) {
      seedSession(state, live, pricing)
      return
    }
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return
    if (Date.now() < state.nextTryAt) return
    const loading = (async () => {
      try {
        // Deadline race: a stalled storage read must not hold the HTTP handler open —
        // the badge's contract is "never fail", which includes "never hang".
        const snapshot = await Promise.race([
          sessionQuery.readSession(childId),
          new Promise((_, reject) => {
            setTimeout(reject, READ_TIMEOUT_MS, new Error('cost-lite: readSession timed out'))
          }),
        ])
        const events = Array.isArray(snapshot?.events) ? snapshot.events : []
        const skip = Math.max(0, integerOr(snapshot?.inheritedEventCount, 0))
        seedSessionFromEvents(state, events.slice(skip), pricing)
      } catch {
        // A deleted or unreadable child: back off instead of re-hitting storage per poll.
        state.nextTryAt = Date.now() + READ_RETRY_MS
      }
    })()
    state.loading = loading
    try {
      await loading
    } finally {
      state.loading = undefined
    }
  }

  /**
   * Bounded BFS over the descendant tree rooted at `rootId` (already seeded by the
   * caller). `visited` makes a corrupted catalog cycle harmless; `MAX_DESCENDANTS` caps
   * the walk, so an oversized family under-counts visibly rather than blocking the host.
   * @returns merged per-model buckets and the number of folded descendant sessions.
   */
  async function collectDescendants(rootId, sessions, sessionQuery) {
    const merged = new Map()
    const visited = new Set([rootId])
    const queue = [rootId]
    let count = 0
    while (queue.length > 0 && count < MAX_DESCENDANTS) {
      const currentId = queue.shift()
      const state = stateFor(currentId)
      if (currentId !== rootId && !state.seeded) await seedChildState(state, currentId, sessions, sessionQuery)
      if (state.seeded && currentId !== rootId) {
        mergeBuckets(merged, state.models)
        count += 1
      }
      // A child's own catalog events were folded with it, so grandchildren queue up the
      // moment the child becomes seeded.
      if (state.seeded) {
        for (const childId of state.childIds) {
          if (visited.has(childId)) continue
          visited.add(childId)
          queue.push(childId)
        }
      }
      // Second discovery channel: the LIVE registry. Some descendants (e.g. teammates
      // from the agent-team tools) link through `header.parentSession` without writing a
      // catalog row, so catalog-only folding would miss them. `visited` keeps the two
      // channels from counting a child twice.
      if (sessions !== undefined && typeof sessions.list === 'function') {
        try {
          for (const live of sessions.list()) {
            const id = typeof live?.id === 'string' ? live.id : undefined
            const parent = typeof live?.header?.parentSession === 'string' ? live.header.parentSession : undefined
            if (id === undefined || parent !== currentId || visited.has(id)) continue
            visited.add(id)
            queue.push(id)
          }
        } catch {
          // A registry that refuses to be listed costs us only live-channel discovery.
        }
      }
    }
    return { models: merged, count }
  }

  async function handler(req, res) {
    if (req?.method !== 'GET') {
      // RFC 7231: a 405 SHOULD name the methods it allows.
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    const sessionId = readSessionId(req)
    if (sessionId === '') {
      sendJson(res, 400, { error: 'sessionId required' })
      return
    }
    try {
      const sessions = ctx.get('sessions')
      const sessionQuery = ctx.get('sessionQuery')
      const state = stateFor(sessionId)
      // The root seeds through the SAME path as a descendant: live => ownEvents();
      // disposed/finished (one-shot subagents, closed parents) => cold readSession slice
      // at inheritedEventCount. A bogus or unreadable id simply stays unseeded: the
      // payload below is all-zero, `priced:false`, no badge — same "never fail" contract.
      if (!state.seeded) await seedChildState(state, sessionId, sessions, sessionQuery)
      const descendants = await collectDescendants(sessionId, sessions, sessionQuery)
      sendJson(res, 200, buildPayload(sessionId, state, pricing, descendants))
    } catch {
      // Never fail the badge: an unreachable/detached session is an empty answer.
      sendJson(res, 200, buildEmptyPayload(sessionId, pricing))
    }
  }

  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: ROUTE,
      handler,
    }))
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', onSessionEvent)
    return () => {
      try {
        if (typeof off === 'function') off()
        else if (typeof ctx.off === 'function') ctx.off('session/event', onSessionEvent)
      } catch { /* already disposed */ }
    }
  })

  const ws = ctx.get('webServer')
  if (ws != null) {
    // `!= null`, not `!== undefined`: a profile can expose a null service, and
    // `null.register` used to throw straight out of apply().
    registerHttp(ws, ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      if (sub?.webServer != null) registerHttp(sub.webServer, sub)
    })
  }
  // No webServer and no inject helper: there is nothing to serve and nothing to throw about.
}

export { apply, inject, name }
