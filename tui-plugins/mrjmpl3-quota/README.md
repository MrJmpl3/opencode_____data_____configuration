# mrjmpl3-quota

TUI plugin for OpenCode that displays provider quota, usage pace, and reset windows in the sidebar.

## What it shows

For each provider, the plugin displays:

- **Usage windows** — remaining or used quota with time until reset (e.g. `Wk 87% · 4d12h`)
- **Usage pace** — a secondary line under each paced window showing whether current consumption is
  on track or exceeding the responsible rate (e.g. `✓ 2.15% under` or `⚠ 7.14% over`)
- **Recovery projection** — when usage is over the responsible pace, the pace line appends how long
  the AI would need to stay inactive to return to responsible usage (e.g. `⚠ 7.14% over · ~12h`).
  Only shown when the window length is known and recovery is mathematically possible.
- **Rate-limit awareness** — backs off automatically when a provider returns 429, with configurable
  cooldown
- **Reset credits (OpenAI)** — banked/reset credit count with next expiry date (e.g.
  `Reset · 1 available · Jul 17`). Distinguishes `available`, `none`, and `unavailable` states.

## Supported providers

| Provider         | Data shown                                                                                             | Auth                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `opencode-go`    | Rolling 5h, Weekly, Monthly windows + Monthly pace                                                     | `OPENCODE_GO_AUTH_COOKIE` + local workspace source                |
| `github-copilot` | Monthly window + Monthly pace                                                                          | `auth.json` (oauth entry `github-copilot`)                        |
| `openrouter`     | Credit balance                                                                                         | `OPENROUTER_API_KEY` or `~/.config/opencode/openrouter-auth.json` |
| `openai`         | 5h, Weekly, Code windows + Weekly pace + compact additional rate limits + Reset credits (experimental) | `auth.json` (oauth entry `openai`)                                |

## Options

Configure the plugin by passing an options object:

```json
{
  "plugin": [
    [
      "/absolute/path/to/tui-plugins/mrjmpl3-quota",
      {
        "displayMode": "remaining",
        "visibleProviders": ["opencode-go", "github-copilot", "openrouter"],
        "pollIntervalMs": 600000,
        "minRefreshIntervalMs": 120000,
        "providerCacheTtlMs": 300000,
        "providerErrorBackoffMs": 900000
      }
    ]
  ]
}
```

### `displayMode`

Controls whether the plugin shows remaining or used quota.

| Value         | Behavior                     |
| ------------- | ---------------------------- |
| `"remaining"` | Shows what is left (default) |
| `"used"`      | Shows what has been consumed |

```json
{ "displayMode": "used" }
```

### `visibleProviders`

Which providers to display and in what order. Invalid or unknown IDs are ignored.

**Allowed values:** `"opencode-go"`, `"github-copilot"`, `"openrouter"`, `"openai"`

**Default:** `["opencode-go", "github-copilot", "openrouter"]`

```json
{ "visibleProviders": ["openai", "opencode-go", "openrouter"] }
```

### `pollIntervalMs`

How often to refresh quota data in the background, in milliseconds.

**Default:** `600000` (10 minutes).  
**Minimum:** `60000` (1 minute).  
**Set to `0`** to disable periodic polling (refreshes still happen on session events).

```json
{ "pollIntervalMs": 300000 }
```

### `minRefreshIntervalMs`

Minimum time between two consecutive refresh requests, in milliseconds. Prevents burst refreshes
from session events.

**Default:** `120000` (2 minutes).  
**Minimum:** `60000` (1 minute).

```json
{ "minRefreshIntervalMs": 60000 }
```

### `providerCacheTtlMs`

How long a successful provider response is considered fresh before re-fetching, in milliseconds.

**Default:** `300000` (5 minutes).  
**Minimum:** `60000` (1 minute).

```json
{ "providerCacheTtlMs": 600000 }
```

### `providerErrorBackoffMs`

Base backoff duration when a provider returns a **rate-limit error** (HTTP 429, or messages
containing rate-limit keywords such as `rate limit`, `too many requests`, `temporarily`, or
`secondary rate`). On consecutive rate-limit errors the backoff multiplies (×1, ×2, ×3, ×4) up to a
1-hour cap. Non-rate-limit errors (including generic 403 auth/forbidden) use `providerCacheTtlMs` as
the base instead. When the error message includes a `retry-after` or `rate-limit-reset` header
value, the plugin respects that duration if it is longer than the computed backoff.

**Default:** `900000` (15 minutes).  
**Minimum:** `60000` (1 minute).

```json
{ "providerErrorBackoffMs": 300000 }
```

### `experimentalOpenAIResetCredits`

**EXPERIMENTAL — OFF by default.** Enables fetching OpenAI reset credits from an undocumented
private ChatGPT endpoint. This endpoint is unsupported, may break without notice, and uses
client-impersonation headers. Only set to `true` if you accept those risks.

| Value   | Behavior                                               |
| ------- | ------------------------------------------------------ |
| `false` | Reset credits are not fetched (default)                |
| `true`  | Reset credits are fetched from the private ChatGPT API |

```json
{ "experimentalOpenAIResetCredits": true }
```

## Environment variables

### OpenCode Go

The auth cookie is always read from the environment:

```bash
export OPENCODE_GO_AUTH_COOKIE="Fe26.2**..."
```

Choose exactly one workspace source:

1. Preferred: point `OPENCODE_GO_WORKSPACES_FILE` at a local JSON file with an array of
   `{ workspaceId, label }` entries.

   ```bash
   export OPENCODE_GO_WORKSPACES_FILE="$HOME/.config/opencode/go-workspaces.json"
   ```

   ```json
   [
     { "workspaceId": "wrk_123", "label": "Personal" },
     { "workspaceId": "wrk_456", "label": "Team" }
   ]
   ```

2. Fallback: set `OPENCODE_GO_WORKSPACES` to the same JSON array as a string.

   ```bash
   export OPENCODE_GO_WORKSPACES='[{"workspaceId":"wrk_123","label":"Personal"}]'
   ```

3. Legacy single-workspace fallback: set `OPENCODE_GO_WORKSPACE_ID`.

```bash
export OPENCODE_GO_WORKSPACE_ID="wrk_..."
```

If the file or JSON source is present but empty or invalid, the plugin skips OpenCode Go rendering
and does not fall back to `OPENCODE_GO_WORKSPACE_ID`.

The workspace ID is visible in your dashboard URL: `https://opencode.ai/workspace/<ID>/go`

### OpenRouter

Either set the environment variable or place a JSON file:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

```json
// ~/.config/opencode/openrouter-auth.json
{ "apiKey": "sk-or-v1-..." }
```

### GitHub Copilot and OpenAI

These providers read credentials automatically from `~/.local/share/opencode/auth.json` (the
standard OpenCode auth file). No additional setup required if you are already authenticated in
OpenCode.

## Reset credits (OpenAI) — EXPERIMENTAL, disabled by default

> **Warning:** This feature uses an **undocumented private ChatGPT endpoint** with
> client-impersonation headers. It is unsupported, may break without notice, and could violate
> OpenAI's terms of service. **Use at your own risk.**

Reset credits fetching is **OFF by default**. To enable it, set
`experimentalOpenAIResetCredits: true` in the plugin options:

```json
{
  "plugin": [
    [
      "/absolute/path/to/tui-plugins/mrjmpl3-quota",
      {
        "visibleProviders": ["openai"],
        "experimentalOpenAIResetCredits": true
      }
    ]
  ]
}
```

When enabled, the plugin fetches banked/reset credits from a private ChatGPT backend endpoint
alongside the usage data. This is a defensive optional fetch — if it fails, the existing
usage/pace/credits lines are not affected.

The plugin shows three explicit states:

- **Available** — `  Reset · 1 available · Jul 17`
- **None available** — `  Reset · none` (200 response with zero credits)
- **Unavailable** — `  Reset · unavailable` (fetch/parse failure or auth/HTTP problem)

When grant data is available, a second line shows the grant date in the same compact month/day
shape:

```
   Reset · 1 available · Jul 17
  Granted Jun 17
```

The plugin does not expose auth tokens, account IDs, raw credit IDs, or raw payload dumps. Date/time
is rendered using the local timezone via `Intl.DateTimeFormat`.

## Recovery projection

When usage is over the responsible pace and the window length is known, the pace line appends a
recovery projection:

```
    ⚠ 7.14% over · ~12h
```

This tells you how long the AI would need to stay inactive (consume zero additional quota) for the
responsible usage rate to catch up to the current usage level. The projection is only shown when it
is mathematically defensible — it is omitted when usage is at or below the responsible pace, or when
the window length is unknown.

## Layout

The plugin uses a structured multi-line layout per provider:

```
▸ OpenAI
  5h 20% · 5h
  Wk 30% · 4d12h
    ✓ 0.1% under
  Code 40% · 15h
  Credits $5.00
```

- Provider heading (`▸ OpenAI`)
- One primary line per window: `label value · reset`
- Optional secondary pace line (indented further): pace status and recovery projection
- Metadata lines (credits, reset status) grouped after windows
- OpenAI additional rate limits render with compact visible state text such as `blocked · Vision` or
  `limit reached · Audio`; long labels are shortened to keep the sidebar narrow

## Development

```bash
npm install
npm run format
npm run format:check
npm test
npm run typecheck
```
