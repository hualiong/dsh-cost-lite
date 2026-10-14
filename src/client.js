// dsh-cost-lite: CLIENT half.
//
// Two 「计费用量」 badges that sit exactly where the built-in token badges live:
//   * conversation.composer.dock        -> session badge, beside the `stats` pill
//   * conversation.chat.assistant-actions -> per-turn badge, between `用量 n tok` and the timestamp
// Each badge polls the host endpoint (there is no projection key we may rely on)
// and opens a stat-dialog popover cloned from the built-in `TurnUsagePanel`.
//
// Visual fidelity note: the trigger/pill and the panel CSS below are copied rule
// for rule from the shipped @deepseek-ai/dsh-client-ui-chat CSS modules
// (`TurnUsagePanel.module.css`, `StatsPills.module.css`, `stat-dialog.module.css`)
// with only the hashed class prefix replaced, so the badges inherit the same
// --dsw-* theme tokens, spacing, 999px pill radius and hover/aria-expanded grey.
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-cost-lite',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // The built-in chat bundle calls exactly these with exactly these shapes, so they
    // are called directly here rather than probed behind fallbacks.
    const { IconDatabaseOutlineRegular, useAnchoredPosition, useDismissOnOutsidePointer } = primitives
    // The badge glyph, in one place so it is a one-line swap. The built-in set ships 97
    // `Icon*OutlineRegular` components and NONE of them is money/coin/wallet/currency, so
    // there is no dedicated billing icon; the near-misses either read wrong or collide with a
    // neighbour (the gauge one is the dock's 会话统计 time pill), so this is deliberately the
    // SAME database glyph as the built-in token pill (user choice).
    const BadgeIcon = IconDatabaseOutlineRegular

    // react-dom is a shared client module, but keep the whole half loadable even
    // if a build ever stops exposing it: no portal just means inline rendering.
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const NS = 'dsh-cost-lite'
    const SESSION_SLOT = 'conversation.composer.dock'
    const SESSION_ID = 'cost-lite-session'
    const TURN_SLOT = 'conversation.chat.assistant-actions'
    const TURN_ID = 'cost-lite-turn'
    const ENDPOINT = '/__cost-lite/usage'
    const POLL_MS = 2000
    const PANEL_GAP = 8 // built-in stat dialog gap
    const PANEL_MARGIN = 12 // built-in stat dialog viewport margin
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    const P = 'clite' // our own CSS-module prefix (never collide with Rd79tq_/iq1doa_/Xt1eiG_)

    // --- locale -----------------------------------------------------------------

    const zhDict = {
      // Accessible name for BOTH badges. The visible text is not this (user request m01723:
      // no currency symbol in either trigger) -- the session badge shows the amount alone and
      // the per-turn badge shows SHORT wording + amount, so the two triggers need two keys.
      'badgeAria': '计费用量 {value}',
      // Visible per-turn trigger wording. The session trigger has no wording key: an empty one
      // would just be a second place to keep in sync.
      'badgeTurn': '计费 {value}',
      'title': '计费用量',
      'model': '提供方 / 模型',
      'input': '未缓存输入',
      'cacheRead': '缓存读取',
      'cacheWrite': '缓存写入',
      'output': '输出',
      // FULLWIDTH YEN SIGN (U+FFE5), not the halfwidth ¥ + space: the fullwidth glyph
      // carries its own side bearing, so 「￥0.93」 needs no separating space.
      'perMillion': '￥{price}/M',
    }

    const enDict = {
      'badgeAria': 'Cost {value}',
      'badgeTurn': 'Cost {value}',
      'title': 'Cost',
      'model': 'Provider / model',
      'input': 'Uncached input',
      'cacheRead': 'Cache read',
      'cacheWrite': 'Cache write',
      'output': 'Output',
      'perMillion': '￥{price}/M',
    }

    // --- injected CSS (copied from the built-in CSS modules) ----------------------

    const CSS = [
      // TurnUsagePanel.module.css / StatsPills.module.css `pill` + `anchor` + `label`
      `.${P}_root{min-width:0;display:inline-flex;align-items:center}`,
      // POSITION (user request m01639): the per-turn badge uses its NATURAL slot position --
      // inside `MessageIconActions`' flex row, between the copy button and the branch button.
      // `conversation.chat.assistant-actions` is a `list` slot whose outlet returns a Fragment,
      // so our root span is a direct child of that row: [copy][extraActions = this slot][branch]
      // [endInfo = [usageAction, clock]]. The row's own `gap:8px` spaces us from both neighbours.
      //
      // An earlier build forced the badge into the 「用量 n tok」/timestamp gap with a
      // `display:contents` + `order` trick on the built-in `xD_KDq_`-hashed wrapper; the user
      // dropped that request because the natural position costs no CSS and no host-hash
      // dependency. Nothing below depends on a DSH-internal class name any more, so a DSH
      // upgrade cannot silently move or mis-style this badge.
      `.${P}_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}`,
      `.${P}_pill svg{flex:none;width:14px;height:14px}`,
      `button.${P}_pill:hover,button.${P}_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`,
      `.${P}_label{text-overflow:ellipsis;min-width:0;overflow:hidden}`,
      // TurnUsagePanel.module.css `.Rd79tq_trigger`, verbatim except prefix. The dock
      // badge sits beside the built-in `stats` pill and keeps the 999px pill above;
      // the per-turn badge sits directly beside the built-in 「用量 n tok」 button,
      // which is this taller/shorter-radius geometry. Both classes ride on the same
      // button, and the compound selectors below out-specify the pill defaults, so
      // the turn variant wins regardless of rule order.
      `button.${P}_pill.${P}_turn{height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);line-height:calc(24px + var(--dsh-content-font-delta,0px));gap:4px;padding:6px 8px}`,
      `.${P}_pill.${P}_turn svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}`,
      `button.${P}_pill.${P}_turn:hover,button.${P}_pill.${P}_turn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}`,
      // The built-in collapses its label to an icon-only square below 480px; mirroring
      // it keeps the two neighbours the same width on narrow screens.
      `@media (width<=480px){button.${P}_pill.${P}_turn{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.${P}_pill.${P}_turn .${P}_label{display:none}}`,
      // stat-dialog.module.css, verbatim except prefix
      `.${P}_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}`,
      `.${P}_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}`,
      `.${P}_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}`,
      `.${P}_titleValue{font-variant-numeric:tabular-nums}`,
      `.${P}_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}`,
      `.${P}_titleLabel svg{flex:none;width:14px;height:14px}`,
      `.${P}_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}`,
      `.${P}_details dt,.${P}_details dd{min-width:0;margin:0}`,
      `.${P}_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}`,
      `.${P}_details .${P}_route{overflow-wrap:anywhere}`,
      `.${P}_price{color:var(--dsw-alias-label-tertiary);margin-left:6px}`,
    ].join('')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      const tagId = '@hualiong/dsh-cost-lite/badge.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@hualiong/dsh-cost-lite'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const cx = (name) => `${P}_${name}`

    // --- formatting (mirrors the built-in Number formatting) ---------------------

    // The digits behind both badges: a single turn routinely costs a fraction of a fen
    // (0.003), so a flat 2 decimals would print 「0.00」 for a whole per-turn popover; widen to
    // 4 decimals only when 2 would round the amount away.
    function cnyDigits(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)
    }

    // Popover amounts keep the FULLWIDTH YEN SIGN (U+FFE5, no following space): it reads as one
    // token with the digits, which lets a row sit closer to its rate suffix.
    function formatCny(value) {
      return `￥${cnyDigits(value)}`
    }

    // BADGE amounts carry NO symbol (user request m01723) -- a trailing 「元」 instead, so the
    // badge reads as a sentence rather than as a price tag.
    function formatYuan(value) {
      return `${cnyDigits(value)} 元`
    }

    // --- data: poll the host endpoint ---------------------------------------------

    /**
     * ONE poller per session, shared by every badge on the page. `conversation.chat
     * .assistant-actions` mounts a badge per finalized assistant message, so a long
     * transcript can easily hold >100 of them: polling per instance would issue one
     * request per tick *per message* against a response that can approach 256 KB.
     * Entries are created by the first subscriber and deleted by the last one, so a
     * page with no badge polls nothing at all.
     */
    const pollers = new Map()

    function startPolling(sessionId, entry) {
      if (entry.timer !== null) return // already polling: another badge joined
      const load = () => {
        if (entry.listeners.size === 0) return
        if (entry.controller !== null) entry.controller.abort()
        entry.controller = new AbortController()
        const signal = entry.controller.signal
        fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, { signal, cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (entry.listeners.size === 0 || data === null || typeof data !== 'object') return
            if (data.ok !== true) return
            entry.snapshot = data
            // Copy before iterating: a listener may unsubscribe while we notify.
            for (const listener of Array.from(entry.listeners)) listener(data)
          })
          .catch(() => { /* aborted or offline: keep the last good snapshot */ })
      }
      load()
      entry.timer = setInterval(load, POLL_MS)
    }

    function stopPolling(entry) {
      if (entry.timer !== null) {
        clearInterval(entry.timer)
        entry.timer = null
      }
      if (entry.controller !== null) {
        entry.controller.abort()
        entry.controller = null
      }
    }

    function subscribeUsage(sessionId, listener) {
      let entry = pollers.get(sessionId)
      if (entry === undefined) {
        entry = { snapshot: null, listeners: new Set(), timer: null, controller: null }
        pollers.set(sessionId, entry)
      }
      entry.listeners.add(listener)
      startPolling(sessionId, entry)
      return () => {
        entry.listeners.delete(listener)
        // Only the entry that is still registered for this session may be torn down,
        // so a late unsubscribe from a previous mount cannot kill a live poller.
        if (pollers.get(sessionId) === entry && entry.listeners.size === 0) {
          stopPolling(entry)
          pollers.delete(sessionId)
        }
      }
    }

    /**
     * Subscribe to the shared snapshot for one session. Any failure (abort, HTTP
     * error, bad JSON) is swallowed and leaves the last good snapshot on the entry,
     * so a badge can never throw into React; a scope that resolves to no snapshot
     * simply renders nothing.
     */
    function useCostUsage(sessionId) {
      const [snapshot, setSnapshot] = useState(null)
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setSnapshot(null)
          return undefined
        }
        // Seed from the shared entry so a badge mounting mid-poll renders the current
        // value immediately instead of staying blank until the next tick.
        const entry = pollers.get(sessionId)
        setSnapshot(entry === undefined ? null : entry.snapshot)
        return subscribeUsage(sessionId, setSnapshot)
      }, [sessionId])
      return snapshot
    }

    // --- popover rows --------------------------------------------------------------

    function row(key, label, value, extraClass) {
      return React.createElement(React.Fragment, { key }, [
        React.createElement('dt', { key: 'dt' }, label),
        React.createElement('dd', { key: 'dd', className: extraClass === undefined ? undefined : cx(extraClass) }, value),
      ])
    }

    // Each bucket row shows the MONEY it cost, not the token count (user request): the
    // equivalent tokens are already listed by the built-in 「Token 用量」 popover next
    // door, while the amount is what this plugin exists to show. The unit rate stays as a
    // subdued suffix because it is the only place the per-1M price remains visible.
    function bucketValue(cost, price, t) {
      const head = formatCny(cost)
      if (typeof price !== 'number' || !Number.isFinite(price)) return head
      return [
        head,
        React.createElement('span', { key: 'price', className: cx('price') }, t('perMillion', { price: price.toFixed(2) })),
      ]
    }

    // The row list is deliberately short (user request). The headline amount is already in
    // the title row, 缓存命中 is a row of the built-in token popover next door, and a token
    // 合计 row is what this plugin replaces — so none of them is repeated here.
    function detailRows(record, isTurn, t) {
      const rows = []
      const models = Array.isArray(record.models) ? record.models : []
      // Only the per-turn popover names the provider/model, to line up with the built-in
      // 「本轮用量」 panel. A session can span several models and its badge is about the
      // session total, so the route row is skipped there.
      if (isTurn && models.length > 0) {
        rows.push(row('model', t('model'), models.map((m) => `${m.provider}/${m.model}`).join('  ·  '), 'route'))
      }
      // An entry carries no per-bucket cost of its own: every bucket is summed over the
      // `models[]` rows, each of which holds its own `inputCost` / `cacheReadCost` / …
      const sum = (field) => models.reduce((total, m) => total + (typeof m[field] === 'number' ? m[field] : 0), 0)
      // A per-price suffix only makes sense for a single priced model; with several models
      // there is a different rate per bucket and no single number to print.
      const solo = models.length === 1 && models[0].priced === true ? models[0] : null
      // Reaching here means the entry is positively priced (the callers gate on it), so every
      // bucket is a number and there is no 「—」 placeholder left to render.
      const value = (field, priceKey) => bucketValue(sum(field), solo === null ? undefined : solo[priceKey], t)
      rows.push(row('input', t('input'), value('inputCost', 'inputPrice')))
      rows.push(row('cacheRead', t('cacheRead'), value('cacheReadCost', 'cacheReadPrice')))
      // The built-in panel hides this row entirely when nothing was written, so an
      // all-zero row never appears for a session that has no cache writes.
      if ((record.cacheWriteTokens ?? 0) !== 0) {
        rows.push(row('cacheWrite', t('cacheWrite'), value('cacheWriteCost', 'cacheWritePrice')))
      }
      rows.push(row('output', t('output'), value('outputCost', 'outputPrice')))
      return rows
    }

    // --- badge --------------------------------------------------------------------

    function CostBadge({ record, isTurn, t }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const toggle = useCallback(() => setOpen((value) => !value), [])
      const close = useCallback(() => setOpen(false), [])
      const pos = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
      })
      useDismissOnOutsidePointer(rootRef, open, close, panelRef)
      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, close])

      const valueText = formatYuan(record.cost)
      // The wording differs per trigger (user request m01723): the per-turn badge reads
      // 「计费 3.42 元」, the session badge the amount alone 「3.42 元」. Both keep the long form
      // as their accessible name. The popover is NOT part of this: its title bar and money rows
      // keep the ￥ form (user request), so it reads the same as the built-in token popover.
      const titleValue = formatCny(record.cost)
      const label = t('badgeAria', { value: valueText })
      const visible = isTurn ? t('badgeTurn', { value: valueText }) : valueText

      const panel = React.createElement('div', {
        ref: panelRef,
        className: cx('panel'),
        role: 'dialog',
        'aria-label': t('title'),
        style: pos === null || pos === undefined ? MEASURE_STYLE : pos,
      }, [
        React.createElement('div', { key: 'title', className: cx('title') }, [
          React.createElement('span', { key: 'label', className: cx('titleLabel') }, [
            React.createElement(BadgeIcon, { key: 'icon' }),
            t('title'),
          ]),
          React.createElement('span', { key: 'value', className: cx('titleValue') }, titleValue),
        ]),
        React.createElement('div', { key: 'rule', className: cx('titleRule'), 'aria-hidden': true }),
        React.createElement('dl', { key: 'details', className: cx('details'), 'data-cost-lite-details': true },
          detailRows(record, isTurn, t)),
      ])

      return React.createElement('span', {
        ref: rootRef,
        className: cx('root'),
      }, [
        React.createElement('button', {
          key: 'trigger',
          type: 'button',
          className: isTurn ? `${cx('pill')} ${cx('turn')}` : cx('pill'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label,
          'data-cost-lite': isTurn ? 'turn' : 'session',
          onClick: toggle,
        }, [
          React.createElement(BadgeIcon, { key: 'icon' }),
          React.createElement('span', { key: 'label', className: cx('label') }, visible),
        ]),
        open
          ? (typeof createPortal === 'function' ? createPortal(panel, document.body) : panel)
          : null,
      ])
    }

    // --- the two registered badges --------------------------------------------------

    // Both badges render ONLY once the host has positively priced the scope (user request:
    // no 「—」 placeholder). `usage.priced` is the session TOTAL's flag -- the host bills every
    // unpriced bucket as 0 and sets the flag when at least one model resolved (`index.js:282`),
    // so a session that mixes DeepSeek with an unknown model shows the DeepSeek part instead
    // of vanishing, and a session that is entirely unknown shows nothing at all.
    function SessionCostBadge({ sessionId, t }) {
      const usage = useCostUsage(sessionId)
      const session = usage !== null && typeof usage.session === 'object' && usage.session !== null ? usage.session : null
      if (session === null || usage.priced !== true || typeof session.cost !== 'number') return null
      return React.createElement(CostBadge, { record: session, isTurn: false, t })
    }

    function TurnCostBadge({ sessionId, messageId, t }) {
      const usage = useCostUsage(sessionId)
      const messages = usage !== null && typeof usage.messages === 'object' && usage.messages !== null ? usage.messages : null
      const record = messages !== null && typeof messageId === 'string' ? messages[messageId] : undefined
      // No entry for this assistant message, or a route the price table does not know, or a
      // host that has not answered yet => render nothing at all, so the badge can never show a
      // neighbouring turn's number nor a placeholder. An assistant message carries exactly one
      // model, so `record.priced` is the per-turn answer.
      if (record === undefined || record === null || typeof record !== 'object') return null
      if (record.priced !== true || typeof record.cost !== 'number') return null
      return React.createElement(CostBadge, { record, isTurn: true, t })
    }

    // --- apply ----------------------------------------------------------------------

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }))
      const injectProps = () => ({ t: ctx.locale.bind(NS) })

      ctx.slots.inject(SESSION_SLOT, () => ctx.slots.register({
        name: SESSION_SLOT,
        id: SESSION_ID,
        order: 5,
        locale: NS,
        inject: injectProps,
      }, SessionCostBadge))

      ctx.slots.inject(TURN_SLOT, () => ctx.slots.register({
        name: TURN_SLOT,
        id: TURN_ID,
        order: 20,
        locale: NS,
        inject: injectProps,
      }, TurnCostBadge))
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
