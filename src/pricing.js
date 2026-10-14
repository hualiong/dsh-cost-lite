// dsh-cost-lite — price table (host half).
//
// Unit: CNY per 1,000,000 tokens, four buckets:
//   input      = uncached input  (DeepSeek "缓存未命中")
//   cacheRead  = cache hit       (DeepSeek "缓存命中")
//   cacheWrite = writing new cache entries
//   output     = generated tokens
//
// WHY a static table (and not the time-of-day aware one used by
// temp/dsh-cost-meter/lib/pricing.js): the frozen client contract (spec §2) carries one
// price per model per message and no tier count, so the badge shows ONE effective rate per
// bucket. The 高峰/空闲 tier itself is selected by index.js from each EVENT's own `time` —
// an immutable property of the stored event, never a clock read at fold or render time — so
// the answer stays a pure function of the folded log and cannot drift between polls.
// Cross-checked against dsh-cost-meter's three-bucket model (cacheHit / cacheMiss / output)
// — its completeTier() maps cacheMiss→input, cacheHit→cacheRead, which is exactly this
// table's shape.
//
// OFFICIAL PROVIDER ONLY (user decision m01476) AND EXACT-ID-ONLY (user decision m00059):
// only DeepSeek-official providers are billable, and only the two model ids that have a row
// below. index.js skips any event whose (provider, model) has no exact row, so an unknown
// provider OR an unrecognised model id means "not billed" — NOT "perhaps free", and NOT "price
// it at the provider's flash rate". The former 智谱 GLM-4-Flash free row and the withdrawn
// `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` rows were deleted for exactly that
// reason — the latter two are no longer offered by the official API at all (m00086); the
// per-provider fallback that used to price an unknown id at the flash rate was removed with
// them (user decision m00059: 无法精确匹配就不计费).

/** Currency of every number in this module (spec §5: CNY). */
const CURRENCY = 'CNY'

// --- sourced entries ----------------------------------------------------------
//
// Source (fetched 2026-10-11): https://api-docs.deepseek.com/zh-cn/quick_start/pricing
//   deepseek-flash (DeepSeek-V4.1-Flash)
//     空闲时段: 缓存命中 ¥0.02 / 缓存未命中 ¥1   / 输出 ¥4      per 1M tokens
//     高峰时段: 缓存命中 ¥0.04 / 缓存未命中 ¥2   / 输出 ¥8      (= 空闲价 ×2)
//   deepseek-v4-pro (DeepSeek-V4-Pro-0813)
//     空闲时段: 缓存命中 ¥0.15 / 缓存未命中 ¥4.5 / 输出 ¥13.5
//     高峰时段: 缓存命中 ¥0.30 / 缓存未命中 ¥9   / 输出 ¥27     (= 空闲价 ×2)
//   高峰时段 = 北京时间周一至周五(非法定节假日) 9:00-12:00 与 14:00-18:00;
//   其余时间(含周末与法定节假日)全天为「空闲时段」。
//   The page lists exactly TWO models, matching DSH's own catalog: `deepseek-flash` and
//   `deepseek-v4-pro` — and the table below carries exactly those two per provider. The
//   ids `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are gone from the official
//   line-up entirely (m00086), so their former alias rows were deleted outright: a withdrawn
//   id must not be billed at all, and an old log that still names one is not silently
//   inherited from the Flash row.
//   The 更新日志 (same host, /zh-cn/updates, 2026-09-10 「API 变更」) confirms v4-pro stays on
//   its own price — see the H8 note below the constants.
//
// cacheWrite: DeepSeek bills exactly three buckets {缓存命中, 缓存未命中, 输出}; there is
// no cache-write price. dsh-cost-meter/lib/pricing.js:31-32 resolves that gap as "cache
// write 按 cache hit 计", the Lead's ruling is 0 — and since DeepSeek never reports
// cache-write tokens, both choices are numerically identical today. We store 0 (no rate
// published) rather than inventing a rate for a bucket the provider does not bill.
//
// 高峰时段 = 2× the 空闲价 IS applied: index.js's isPeakHour()/PEAK_MULTIPLIER pick the tier
// from each event's own `time` and multiply only that event's peak share, then emit the
// EFFECTIVE (blended) rate from this table, so a peak-only bucket displays ￥2.00/M and a
// half-and-half one the true average, while an off-peak row is exactly the number below.
// 法定节假日 ARE modelled: index.js carries the 国务院办公厅 2026 date list and treats those
// Beijing calendar days as 空闲. A weekday holiday MISSING from that list is charged 2× — the
// ceiling errs HIGH (overstates), never low — and isPeakHour's `ponytail:` note names the
// yearly-refresh upgrade path.

const DEEPSEEK_FLASH = Object.freeze({ input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 })
// H8 was WRONG and is replaced here. `deepseek-v4-pro` IS billed at its own list price.
// Source (fetched 2026-10-12): https://api-docs.deepseek.com/zh-cn/updates — 2026-09-10 entry,
// 「API 变更」:
//   「为响应广大用户的需求，我们决定在 2026 年 9 月 14 日之后继续提供 DeepSeek V4 Pro 的
//    API 调用服务，计费方式保持不变；如有变动，我们将另行通知！」
// That CANCELS the routing announced on https://api-docs.deepseek.com/zh-cn/news/news260910
// (「北京时间 2026 年 9 月 14 日 12:00 之后，至未来 V4.1 Pro 上线之前，用户访问
//  deepseek-v4-pro 的请求将全部路由到 V4.1 Flash，并按 V4.1 Flash 单价计费」) — the news
// page was never updated, the changelog supersedes it, and the live pricing page still lists
// v4-pro on its own row (0.15 / 4.5 / 13.5 空闲, ×2 高峰). So v4-pro keeps its own rates.
// temp/dsh-cost-meter/lib/pricing.js:605-615 is STALE here: it still routes every v4-pro call
// to the Flash price (via PRO_FLASH_ROUTING_EFFECTIVE_AT) — do not copy that decision again.
const V4_PRO_LIST_PRICE = Object.freeze({ input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 })

/**
 * The built-in table, keyed `"<provider>/<model>"`. Frozen so a config merge must build a
 * new object instead of mutating this one in place (plug-ins share a process).
 * Official-only AND exact-id-only: a row here is the only thing that makes a (provider, model)
 * pair billable. There is no provider-level fallback any more, so a pair with no row is not
 * billed at all (index.js skips it at fold time) rather than billed at a guessed rate (spec §5).
 */
export const PRICE_TABLE = Object.freeze({
  // The official catalog carries exactly TWO ids — `deepseek-flash` (DeepSeek-V4.1-Flash) and
  // `deepseek-v4-pro` (DeepSeek-V4-Pro-0813). Source: DSH's own model catalog (app.asar
  // DEFAULT_MODELS, shared by `deepseek-account` and `deepseek-official`) plus the pricing page,
  // whose two columns are the same two ids. Ids that appear in no official source are NOT rows
  // here: the former `deepseek-pro` / `deepseek-v4.1-flash` aliases and the withdrawn
  // `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` ids (no longer offered, m00086) were
  // all deleted, and a lookup that misses falls through to "not billed" — never to the
  // provider's flash row.
  'deepseek-account/deepseek-flash': DEEPSEEK_FLASH,
  'deepseek-account/deepseek-v4-pro': V4_PRO_LIST_PRICE,
  'deepseek-official/deepseek-flash': DEEPSEEK_FLASH,
  'deepseek-official/deepseek-v4-pro': V4_PRO_LIST_PRICE,
})

/**
 * The DEFAULT row (spec §5): all zeros = "no rate known". `lookup` returns `undefined` rather
 * than this row, because a zero row would silently turn an unknown model into priced:true —
 * exactly the guess spec §5 forbids. It is exported for config merges and for callers that
 * want an explicit zero floor.
 */
export const DEFAULT_PRICE = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

const RATE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']
// A hand-written config entry is only trusted when every bucket is a finite, non-negative
// number; a partial row would otherwise make NaN leak into the cost arithmetic.
function sanitizeRates(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const key of RATE_KEYS) {
    const value = raw[key]
    out[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  return Object.freeze(out)
}

function sanitizeTable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const rates = sanitizeRates(value)
    if (rates !== undefined) out[key] = rates
  }
  return out
}

/**
 * Resolve a price for one (provider, model) pair by EXACT `"<provider>/<model>"` row, and by
 * nothing else (user decision m00059). A pair with no row resolves to `undefined` — never a
 * guessed rate, not even the provider's own flash price — and index.js treats `undefined` as
 * "not billable" rather than "bill at zero" (spec §5).
 * @returns the rate row, or `undefined` when the model is unknown (caller skips the event).
 */
function lookup(table, provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (p === '' || m === '') return undefined
  return table[`${p}/${m}`]
}

// There is deliberately no standalone `priceFor(provider, model)` export: it would resolve
// against the built-in table without a config view, so it would ignore `config.models` and
// disagree with the instance method below — and nothing in the package consumed it. Callers go
// through `pricingFromConfig(config).priceFor(...)`.

/**
 * Build the pricing view used by one plugin instance. Defensive by design (spec §5): a
 * missing, odd or hostile `config` always falls back to the built-in table.
 * `config.models` entries replace/extend table rows keyed `"<provider>/<model>"` — that is
 * also the ONLY escape hatch from official-only, exact-id-only billing: an explicitly
 * configured row makes its (provider, model) pair billable again.
 */
export function pricingFromConfig(config) {
  const cfg = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const overrides = sanitizeTable(cfg.models)
  const table = Object.keys(overrides).length > 0 ? Object.freeze({ ...PRICE_TABLE, ...overrides }) : PRICE_TABLE
  const currency = typeof cfg.currency === 'string' && cfg.currency.trim() !== '' ? cfg.currency.trim() : CURRENCY
  return {
    currency,
    priceFor: (provider, model) => lookup(table, provider, model),
  }
}
