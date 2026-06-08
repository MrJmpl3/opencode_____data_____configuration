# mrjmpl3-cache

TUI plugin for OpenCode that displays cache usage statistics in the sidebar.

## What it does

- renders cache hit ratio and saved token totals
- reports input and output token traffic
- includes cache write totals when providers expose them
- refreshes on session changes and idle events

## Install

Add the package directory to your OpenCode TUI config.

```json
{
  "plugin": ["/absolute/path/to/tui-plugins/mrjmpl3-cache"]
}
```

## Development

```bash
npm install
npm run format
npm test
npm run typecheck
```

The package follows the repository-level Prettier config automatically.
