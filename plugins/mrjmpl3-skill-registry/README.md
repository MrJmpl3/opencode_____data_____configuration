# mrjmpl3-skill-registry

OpenCode plugin wrapper for the Gentle AI skill registry refresh hook.

## What it does

- preserves the existing `skill-registry` startup behavior
- exposes it through the `mrjmpl3-*` plugin folder layout used by the other custom plugins
- keeps the prefixed top-level plugin entrypoint consistent for OpenCode config loading

## Install

To load this plugin from OpenCode config, point at the prefixed entrypoint:

```json
{
  "plugin": ["/absolute/path/to/plugins/mrjmpl3-skill-registry.ts"]
}
```

## Exports

- `SkillRegistryPlugin`
- `default`

## Development

```bash
npm install
npm run format
npm test
npm run typecheck
```

Restart OpenCode after changing plugin files so the config-time module is reloaded.
