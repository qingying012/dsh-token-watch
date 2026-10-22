// Self-test: drives the plugin with a fake context and a synthetic expensive
// message, so you can confirm the log line and the desktop alert without
// waiting for a real threshold to be crossed.
//
//   npm run selftest
//
// It writes to a temporary DSH_HOME, so your real log and daily totals are
// untouched. The alert itself is real.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-token-watch-selftest-'))
process.env.DSH_HOME = home

const { apply } = await import('../dsh/index.js')

let handler = null
let dispose = null
const ctx = {
  on(event, callback) {
    if (event === 'session/event') handler = callback
    return () => {
      handler = null
    }
  },
  effect(callback) {
    dispose = callback()
  },
}

apply(ctx, { logDir: join(home, 'logs') })

if (!handler) {
  console.error('selftest failed: plugin did not subscribe to session/event')
  process.exit(1)
}

handler(
  { id: 'selftest' },
  {
    type: 'assistant/message',
    data: {
      usage: {
        inputTokens: 250_000,
        outputTokens: 1_800,
        cacheReadTokens: 40_000,
        totalTokens: 291_800,
      },
      message: { source: { model: 'deepseek-v4-pro' } },
    },
  },
)

console.log('selftest: synthetic message sent; watch for the desktop alert.')
setTimeout(() => {
  if (typeof dispose === 'function') dispose()
  process.exit(0)
}, 4_000)
