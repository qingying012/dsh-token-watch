// dsh-token-watch — DeepSeek Harness plugin
//
// Watches every session's assistant messages for token usage, estimates the
// per-message cost from a built-in price table, and pops a whale-styled
// desktop alert (see assets/notify.ps1) when a threshold is crossed.
//
// Why a plugin instead of a standalone daemon: it rides the host's own
// `session/event` stream, so there is no log tailing, no VBS startup entry and
// no second process to keep alive. It covers every workspace and every future
// session automatically, because the host emits one event per message.
//
// Non-goals: this is an estimate for self-observation, not a bill. Prices are
// USD per 1M tokens and are converted with `usdCny`.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-token-watch'

// No host service is required: `session/event` is a core event.
export const inject = []

const NOTIFY_PS1 = fileURLToPath(new URL('../assets/notify.ps1', import.meta.url))
const IS_WIN = process.platform === 'win32'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// USD per 1M tokens, matching the host's providers/deepseek.json.
const DEFAULT_PRICES = {
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  'deepseek-v4-pro-0813': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
}

const DEFAULTS = {
  enabled: true,
  // Desktop alerts. Turn off to keep logging only.
  notify: true,
  // Restore today's totals from state.json when the plugin (re)loads, so a host
  // restart does not reset the daily counter.
  restoreState: true,
  usdCny: 7.2,
  logDir: '',
  thresholds: {
    singleCost: 0.3, // CNY per message
    singleTokens: 300_000, // total tokens per message
    win5mCost: 1.0, // CNY spent in the last 5 minutes
    win1hCost: 3.0, // CNY spent in the last hour
    win10mMsgs: 12, // assistant messages in the last 10 minutes
    cacheRatio: 0.98, // cacheRead / total ratio
    cacheMinTokens: 500_000, // only check the ratio above this size
  },
  // Per-model overrides or additions, same shape as DEFAULT_PRICES.
  prices: {},
  // Minimum gap between two alerts for the same rule, in ms.
  cooldownMs: 10 * 60_000,
}

const HOUR = 3600_000

function mergeConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {}
  return {
    ...DEFAULTS,
    ...cfg,
    thresholds: { ...DEFAULTS.thresholds, ...(cfg.thresholds || {}) },
    prices: { ...DEFAULT_PRICES, ...(cfg.prices || {}) },
    logDir: cfg.logDir || join(DSH_HOME, 'logs', 'token-watch'),
  }
}

const pad = (n) => String(n).padStart(2, '0')
const localDay = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const timeStr = (t = Date.now()) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
const fmt = (n) => Number(n || 0).toLocaleString('en-US')
const cny = (n) => (n == null ? '价格未知' : n < 0.01 ? `¥${n.toFixed(4)}` : `¥${n.toFixed(2)}`)

export function apply(ctx, userConfig = {}) {
  const config = mergeConfig(userConfig)
  if (!config.enabled) return

  const tag = '[token-watch]'
  const logger = (...args) => {
    try {
      console.log(tag, ...args)
    } catch {
      /* host console can be closed */
    }
  }

  const stateFile = join(DSH_HOME, 'token-watch', 'state.json')

  const state = {
    events: [], // records from the last hour
    lastAlert: new Map(), // rule -> timestamp
    day: localDay(),
    todayMsgs: 0,
    todayTokens: 0,
    todayCost: 0,
    byModel: new Map(),
    lastFlush: 0,
  }

  function logFile(t = Date.now()) {
    return join(config.logDir, `token-watch-${localDay(t)}.log`)
  }

  function appendLog(line) {
    logger(line)
    try {
      mkdirSync(config.logDir, { recursive: true })
      appendFileSync(logFile(), line + '\n')
    } catch {
      /* disk problems must not break monitoring */
    }
  }

  function notifyDesktop(title, message) {
    if (!config.notify) return
    if (!IS_WIN) {
      logger('desktop alerts are Windows-only; skipping')
      return
    }
    if (!existsSync(NOTIFY_PS1)) {
      logger('assets/notify.ps1 is missing; skipping alert')
      return
    }
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NOTIFY_PS1],
        {
          env: { ...process.env, TW_TITLE: title, TW_MSG: message, TW_LOG: logFile() },
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      child.unref()
    } catch (error) {
      logger('failed to show alert:', error?.message ?? String(error))
    }
  }

  function costOf(rec) {
    const price = config.prices[rec.model]
    if (!price) return null
    return (
      ((rec.input * price.input +
        rec.output * price.output +
        rec.cacheRead * price.cacheRead +
        (rec.cacheWrite || 0) * (price.cacheWrite || 0)) /
        1e6) *
      config.usdCny
    )
  }

  function sumCost(list) {
    let sum = 0
    for (const r of list) {
      const c = costOf(r)
      if (c != null) sum += c
    }
    return sum
  }

  function rollDayIfNeeded(t) {
    const day = localDay(t)
    if (day === state.day) return
    state.day = day
    state.todayMsgs = 0
    state.todayTokens = 0
    state.todayCost = 0
    state.byModel.clear()
    state.lastAlert.clear()
  }

  function addAggregate(rec, cost) {
    rollDayIfNeeded(rec.time)
    state.todayMsgs++
    state.todayTokens += rec.total
    if (cost != null) state.todayCost += cost
    const m = state.byModel.get(rec.model) || { msgs: 0, tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0 }
    m.msgs++
    m.tokens += rec.total
    m.input += rec.input
    m.output += rec.output
    m.cacheRead += rec.cacheRead
    if (cost != null) m.cost += cost
    state.byModel.set(rec.model, m)
  }

  function alert(rule, message, force = false) {
    const t = Date.now()
    if (!force && state.lastAlert.has(rule) && t - state.lastAlert.get(rule) < config.cooldownMs) return
    state.lastAlert.set(rule, t)
    appendLog(`[ALERT ${timeStr(t)}] ${message}`)
    notifyDesktop('token-watch 告警', message)
    flushState(true)
  }

  function flushState(force = false) {
    const t = Date.now()
    if (!force && t - state.lastFlush < 30_000) return
    state.lastFlush = t
    try {
      mkdirSync(join(DSH_HOME, 'token-watch'), { recursive: true })
      writeFileSync(
        stateFile,
        JSON.stringify({
          day: state.day,
          msgs: state.todayMsgs,
          tokens: state.todayTokens,
          cost: state.todayCost,
          updatedAt: t,
        }),
      )
    } catch {
      /* ignore */
    }
  }

  function prune() {
    const cutoff = Date.now() - HOUR
    while (state.events.length && state.events[0].time < cutoff) state.events.shift()
  }

  function checkWindows() {
    const now = Date.now()
    const r5 = state.events.filter((r) => r.time >= now - 300_000)
    const r10 = state.events.filter((r) => r.time >= now - 600_000)
    const r1h = state.events.filter((r) => r.time >= now - HOUR)
    const c5 = sumCost(r5)
    const c1h = sumCost(r1h)
    const th = config.thresholds
    if (c5 >= th.win5mCost) {
      alert('win5m', `最近 5 分钟花费 ≈${cny(c5)}（${r5.length} 条）≥ 阈值 ${cny(th.win5mCost)}`)
    }
    if (c1h >= th.win1hCost) {
      alert('win1h', `最近 1 小时花费 ≈${cny(c1h)}（${r1h.length} 条）≥ 阈值 ${cny(th.win1hCost)}`)
    }
    if (r10.length >= th.win10mMsgs) {
      alert('rate', `最近 10 分钟新增 ${r10.length} 条 assistant 消息（≥ ${th.win10mMsgs}），请求过于频繁`)
    }
  }

  function observe(rec) {
    const cost = costOf(rec)
    addAggregate(rec, cost)
    state.events.push(rec)
    appendLog(
      `[${timeStr(rec.time)}] +1 ${rec.model} in=${fmt(rec.input)} out=${fmt(rec.output)} cacheRead=${fmt(rec.cacheRead)} total=${fmt(rec.total)} ≈${cny(cost)} | 今日 ${state.todayMsgs} 条 ≈${cny(state.todayCost)}`,
    )
    const th = config.thresholds
    if (rec.total >= th.singleTokens) {
      alert('singleTokens', `单条消息 total=${fmt(rec.total)} ≥ ${fmt(th.singleTokens)}（模型 ${rec.model}）`)
    }
    if (cost != null && cost >= th.singleCost) {
      alert('singleCost', `单条消息费用 ≈${cny(cost)} ≥ ${cny(th.singleCost)}（模型 ${rec.model}，total=${fmt(rec.total)}）`)
    }
    if (rec.total >= th.cacheMinTokens && rec.cacheRead / Math.max(rec.total, 1) >= th.cacheRatio) {
      alert(
        'cacheRatio',
        `单条消息 cacheRead 占 ${((rec.cacheRead / rec.total) * 100).toFixed(1)}%（total=${fmt(rec.total)}），历史上下文重复计费`,
      )
    }
    checkWindows()
    prune()
    flushState()
  }

  // ---------- restore today's totals ----------
  // Session logs are multi-frame zstd; the Electron host's Node (24.21) only
  // decodes the first frame, so replaying them from inside the plugin is not
  // reliable. Persist the running totals instead and restore them when the
  // plugin (re)loads on the same day.
  if (config.restoreState) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (saved && saved.day === localDay()) {
        state.todayMsgs = Number(saved.msgs) || 0
        state.todayTokens = Number(saved.tokens) || 0
        state.todayCost = Number(saved.cost) || 0
        appendLog(
          `[${timeStr()}] 恢复今日累计：${state.todayMsgs} 条 ≈${cny(state.todayCost)}（上次写入 ${timeStr(Number(saved.updatedAt) || Date.now())}）`,
        )
      }
    } catch {
      /* no state yet: start from zero */
    }
  }

  appendLog(
    `[${timeStr()}] token-watch 插件启动 | Node ${process.version} | 通知 ${config.notify ? '开' : '关'} | 日志 ${config.logDir}`,
  )

  // ---------- live events ----------
  const off = ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      const data = event.data
      const usage = data?.usage
      if (!usage || typeof usage !== 'object') return
      observe({
        time: Date.now(),
        model: data?.message?.source?.model || 'unknown',
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0,
        total: Number(usage.totalTokens) || 0,
      })
    } catch (error) {
      logger('session event failed:', error?.message ?? String(error))
    }
  })

  // Heartbeat: keeps the daily line visible in the log even when idle.
  const heartbeat = setInterval(() => {
    prune()
    const now = Date.now()
    const r5 = state.events.filter((r) => r.time >= now - 300_000)
    const r1h = state.events.filter((r) => r.time >= now - HOUR)
    appendLog(
      `[心跳 ${timeStr(now)}] 今日 ${state.todayMsgs} 条 / ${fmt(state.todayTokens)} tok / ≈${cny(state.todayCost)} | 近1h ${r1h.length} 条 ≈${cny(sumCost(r1h))} | 近5m ${r5.length} 条 ≈${cny(sumCost(r5))}`,
    )
    flushState(true)
  }, 60_000)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      clearInterval(heartbeat)
    } catch {
      /* ignore */
    }
    try {
      if (typeof off === 'function') off()
    } catch {
      /* ignore */
    }
    flushState(true)
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

  // Exposed for tests / manual pokes; harmless in production.
  return { observe, snapshot: () => ({ ...state, events: undefined }) }
}
