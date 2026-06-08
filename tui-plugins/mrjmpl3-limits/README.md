# mrjmpl3-limits

TUI plugin for OpenCode that displays model context and output limits in the sidebar.

## What it does

- resolves the active model from session messages or config
- reads provider model metadata when available
- displays context and output limits with compact formatting
- refreshes on session changes, idle events, and model switches

## Install

Add the package directory to your OpenCode TUI config.

```json
{
  "plugin": ["/absolute/path/to/tui-plugins/mrjmpl3-limits"]
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
