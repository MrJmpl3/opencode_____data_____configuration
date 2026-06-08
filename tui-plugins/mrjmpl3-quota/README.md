# mrjmpl3-quota

TUI plugin for OpenCode that displays provider quota and usage status in the sidebar.

## What it does

- reads quota data from supported providers
- caches provider responses to avoid unnecessary refreshes
- renders responsible weekly usage and pace information
- handles quota rate-limit retry windows defensively

## Install

Add the package directory to your OpenCode TUI config.

```json
{
  "plugin": ["/absolute/path/to/tui-plugins/mrjmpl3-quota"]
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
