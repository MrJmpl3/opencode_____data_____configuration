# mrjmpl3-gentle-logo

TUI plugin for OpenCode that replaces the home logo with the Gentle AI mark.

## What it does

- renders the full rose logo when the terminal has enough space
- falls back to a compact text logo on smaller terminals
- keeps layout selection in pure domain logic with focused tests

## Install

Add the package directory to your OpenCode TUI config.

```json
{
  "plugin": ["/absolute/path/to/tui-plugins/mrjmpl3-gentle-logo"]
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
