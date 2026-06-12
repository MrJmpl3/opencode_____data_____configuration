# ⚙️ My Complete OpenCode Configuration

A complete OpenCode configuration workspace with custom and improved plugins, skills, commands, TUI extensions, model helpers, memory integration, and SDD workflow support.

<p>
  <a href="https://github.com/MrJmpl3/opencode_____data_____configuration">
    <img src="https://img.shields.io/badge/OPENCODE-CONFIG-2f3136?style=for-the-badge&logo=github&logoColor=white" alt="OpenCode Config" />
  </a>
  <a href="./plugins">
    <img src="https://img.shields.io/badge/READ-THE_PLUGINS-ff2fa3?style=for-the-badge" alt="Read the plugins" />
  </a>
  <a href="./skills">
    <img src="https://img.shields.io/badge/EXPLORE-SKILLS-374151?style=for-the-badge" alt="Explore skills" />
  </a>
  <a href="./tui-plugins">
    <img src="https://img.shields.io/badge/TUI-EXTENSIONS-0f76d8?style=for-the-badge" alt="TUI extensions" />
  </a>
</p>

This repository contains my full OpenCode setup: global configuration, custom plugins, improved plugin variants, reusable skills, SDD commands, prompt templates, TUI status components, and OpenSpec artifacts.

It is meant to be read as a practical map of how I use OpenCode, what I customized, and where each piece lives.

---

## 🚀 Start Here

If you want to understand the setup quickly, follow this path:

1. **Open [`opencode.json`](./opencode.json)**  
   Main OpenCode configuration: agents, models, MCP servers, permissions, LSPs, and plugin loading.

2. **Read [`AGENTS.md`](./AGENTS.md)**  
   Global behavior rules used by OpenCode sessions.

3. **Explore [`plugins/`](./plugins)**  
   Custom OpenCode plugins for Engram, model variants, RTK rewriting, and skill registry behavior.

4. **Explore [`tui-plugins/`](./tui-plugins)**  
   TUI extensions for quota, cache, limits, logo, and subagent status.

5. **Check [`skills/`](./skills)**  
   Reusable instruction modules for different languages, frameworks, workflows, reviews, and architecture topics.

6. **Check [`commands/`](./commands) and [`prompts/sdd/`](./prompts/sdd)**  
   Command definitions and prompts that support the SDD workflow.

---

## 🧭 Repository Map

```text
ROOT
│
├── AGENTS.md              # Global OpenCode behavior and session rules
├── opencode.json          # Main OpenCode configuration
├── tui.json               # TUI plugin configuration
│
├── commands/              # Custom OpenCode command definitions
├── prompts/
│   └── sdd/               # SDD phase prompts
│
├── skills/                # Reusable skill instructions
├── plugins/               # OpenCode runtime plugins
├── tui-plugins/           # OpenCode TUI extensions
│
└── openspec/              # OpenSpec config, specs, and archived changes
```

---

## 🔌 Custom OpenCode Plugins

The [`plugins/`](./plugins) directory contains custom OpenCode plugin adapters.

| Plugin | What it adds |
|---|---|
| [`mrjmpl3-engram`](./plugins/mrjmpl3-engram) | Engram memory integration: starts/connects to the local memory server, captures prompts, injects memory instructions, and avoids subagent session inflation. |
| [`mrjmpl3-model-variants`](./plugins/mrjmpl3-model-variants) | Reads model/provider variant data from OpenCode and writes a local cache for Gentle AI. |
| [`mrjmpl3-rtk`](./plugins/mrjmpl3-rtk) | Rewrites shell commands through `rtk rewrite` when available to reduce token usage. |
| [`mrjmpl3-skill-registry`](./plugins/mrjmpl3-skill-registry) | Keeps the skill registry refresh behavior available through the same `mrjmpl3-*` plugin layout. |

Each plugin has its own README with install, exports, and development notes.

---

## 🖥️ TUI Plugins

The [`tui-plugins/`](./tui-plugins) directory contains OpenCode TUI extensions.

| Plugin | Purpose |
|---|---|
| `mrjmpl3-cache` | Cache-related status information. |
| `mrjmpl3-gentle-logo` | Gentle AI branding for the TUI. |
| `mrjmpl3-limits` | Limit-related status information. |
| `mrjmpl3-quota` | Provider quota display. |
| `mrjmpl3-subagent-status` | Subagent status, idle state, and recovery visibility. |

These extensions are wired from [`tui.json`](./tui.json).

---

## 🧩 Skills

The [`skills/`](./skills) directory is the reusable instruction layer of this setup.

Skills are grouped as focused `SKILL.md` files that can be loaded when a task needs specific behavior, for example:

- PR and issue workflows
- chained PR planning
- code review
- documentation design
- SDD phases
- language/framework-specific guidance
- testing, architecture, security, Docker, Laravel, Python, TypeScript, and more

This keeps the main configuration smaller while still allowing task-specific behavior to be injected when needed.

---

## 🛠️ Commands and SDD Workflow

The [`commands/`](./commands) directory defines user-facing workflow commands.

Important SDD-related commands include:

| Command file | Purpose |
|---|---|
| [`sdd-new.md`](./commands/sdd-new.md) | Start a new SDD change. |
| [`sdd-explore.md`](./commands/sdd-explore.md) | Explore an idea before committing to a change. |
| [`sdd-ff.md`](./commands/sdd-ff.md) | Fast-forward planning phases. |
| [`sdd-continue.md`](./commands/sdd-continue.md) | Continue the next dependency-ready phase. |
| [`sdd-apply.md`](./commands/sdd-apply.md) | Apply implementation tasks. |
| [`sdd-verify.md`](./commands/sdd-verify.md) | Verify implementation against specs and tasks. |
| [`sdd-archive.md`](./commands/sdd-archive.md) | Archive completed change artifacts. |

The detailed phase prompts live in [`prompts/sdd/`](./prompts/sdd).

---

## 📐 OpenSpec Artifacts

[`openspec/`](./openspec) stores the Spec-Driven Development configuration and artifacts.

It includes:

- OpenSpec project configuration
- active changes
- archived changes
- specs
- apply progress
- verification reports
- archive reports

This makes the repo useful not only as an OpenCode config, but also as a record of how configuration changes were planned, implemented, and verified.

---

## 🧪 Development Notes

This repository has both root-level configuration and package-local plugin projects.

Some plugin packages include scripts such as:

```bash
npm install
npm run format
npm run format:check
npm test
npm run typecheck
```

For package-local checks, run commands inside the relevant plugin directory.

Example:

```bash
cd tui-plugins/mrjmpl3-subagent-status
npm test
npm run typecheck
```

---

## ⚠️ Local Setup Notes

This repository includes environment-specific paths and assumptions.

Examples:

```text
/home/mrjmpl3/.config/opencode
/home/mrjmpl3/.local/bin/engram
```

Before reusing parts of this setup, review:

- absolute paths
- local binaries such as `engram` and `rtk`
- provider/model names
- MCP configuration
- plugin entrypoints
- shell and Git permissions

The safest way to use this repo is to study the structure, copy the ideas that fit your workflow, and adapt paths/configuration to your own machine.

---

## 🌱 Why This Repo Is Useful

This is a practical example of a deeply customized OpenCode environment.

It shows how to organize:

- global OpenCode behavior
- reusable skills
- custom runtime plugins
- TUI status plugins
- SDD commands and prompts
- memory integration
- model/provider helpers
- review and workflow automation

If you already use OpenCode, SDD, Engram, or Gentle AI, this repository is a useful reference for improving your own stack.
