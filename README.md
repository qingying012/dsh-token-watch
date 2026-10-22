# dsh-token-watch

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that watches every session's token
usage and pops a **whale-styled desktop alert** when a threshold is crossed — a small white
speech bubble with a dark-navy outline and the whale mascot, in the corner of your screen.

It rides the host's own `session/event` stream, so there is no log tailing, no startup script
and no second process to keep alive. Every workspace, every new session, is covered
automatically.

> Windows only for the desktop alert. On other platforms the plugin still logs and keeps
> running; it just skips the popup.

## What it watches

| Rule | Default | Meaning |
| :-- | --: | :-- |
| `singleCost` | ¥0.30 | a single message costs more than this |
| `singleTokens` | 300,000 | a single message carries more than this many tokens |
| `win5mCost` | ¥1.00 | spend in the last 5 minutes |
| `win1hCost` | ¥3.00 | spend in the last hour |
| `win10mMsgs` | 12 | assistant messages in the last 10 minutes (runaway tool loops) |
| `cacheRatio` | 98% | `cacheRead / total` above this, for messages ≥ 500k tokens |

The same rule alerts at most once every `cooldownMs` (default 10 minutes), so a busy loop
does not turn into a notification storm.

Cost is an **estimate**: prices are USD per 1M tokens from the host's
`providers/data/deepseek.json`, converted with `usdCny`. It is not a bill.

## Install

Client (Electron app): **插件 → + 添加插件**, paste the package name (or a local directory
path while developing), install, then **立即启用**.

CLI profiles can use the normal plugin command:

```powershell
dsh plugin --profile web add dsh-token-watch
```

The desktop profile is owned by the Electron app and refuses the CLI
(`profile "desktop" is managed exclusively by the Electron application`), so use the UI there.

> **Fresh releases:** npm needs a few minutes to propagate a brand-new package to its CDN.
> Until then `pnpm add` fails with `ERR_PNPM_FETCH_404 ... .tgz` even though the metadata page
> already renders. The China mirror (`registry.npmmirror.com`) syncs later still — pick
> **npm 官方源** in the install dialog, wait a few minutes, then retry.
>
> **Do not uninstall a `link:` install while keeping it as your working copy.** The client's
> plugin manager deletes the linked directory when the plugin is removed. Recover it from the
> published tarball (`npm pack dsh-token-watch`) or from git.

## Configure

Thresholds and behaviour are plugin config, set in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-token-watch
  name: dsh-token-watch
  config:
    notify: true
    usdCny: 7.2
    thresholds:
      singleCost: 0.3
      singleTokens: 300000
      win5mCost: 1.0
      win1hCost: 3.0
      win10mMsgs: 12
      cacheRatio: 0.98
      cacheMinTokens: 500000
    cooldownMs: 600000
    # Extra or overridden prices, USD per 1M tokens:
    # prices:
    #   my-model: { input: 0.3, output: 1.2, cacheRead: 0.006 }
```

| Option | Default | Notes |
| :-- | :-- | :-- |
| `enabled` | `true` | set to `false` to load the plugin but do nothing |
| `notify` | `true` | `false` keeps logging only |
| `restoreState` | `true` | restore today's totals from `state.json` on reload |
| `usdCny` | `7.2` | exchange rate for the estimate |
| `logDir` | `$DSH_HOME/logs/token-watch` | one file per day |
| `prices` | built-in table | per-model overrides / additions |

Unknown models are counted for tokens and message rate but cost nothing, so the estimate
never silently invents a price.

### Why there is no historical replay

The session logs are multi-frame zstd. The Node bundled with the Electron host (24.21) only
decodes the first frame, so replaying them from inside the plugin would silently undercount.
The plugin persists a small `state.json` and restores today's totals from it instead; a fresh
install starts counting from zero at load time.

## Output

- Log: `~/.dsh/logs/token-watch/token-watch-YYYY-MM-DD.log`, one line per message plus a
  minute heartbeat. Same format as the standalone `token-watch.mjs` this plugin replaces.
- State: `~/.dsh/token-watch/state.json` — today's totals, so a host restart does not reset
  the daily counter.
- Desktop alert: `assets/notify.ps1`, a borderless WPF window (white bubble, `#2A3A6B` outline,
  circular whale avatar). It falls back to a WinRT toast, then to a tray balloon.

Clicking the bubble opens today's log in Notepad. It closes itself after 10 seconds.

## Self-test

```powershell
npm run selftest
```

Drives the plugin with a fake context and one synthetic expensive message, so you can see the
alert immediately without waiting for a real threshold. It uses a temporary `DSH_HOME`, so your
real log and totals are untouched — the popup is real.

## Notes

- The plugin reads only `usage` numbers from session events; it never stores message text.
- It lives inside the host process, so **it only runs while DeepSeek Harness is running**.
  If you also want monitoring with the app closed, keep the standalone daemon instead.
- `assets/notify.ps1` must stay UTF-8 with BOM — PowerShell 5.1 reads a BOM-less file as GBK
  and mangles the Chinese strings.

## License

MIT
