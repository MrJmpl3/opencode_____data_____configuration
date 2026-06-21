# ⚙️ My Complete OpenCode Configuration

> **English below · Español más abajo**

A practical, opinionated OpenCode configuration workspace with custom plugins, reusable skills, TUI extensions, model helpers, Engram memory integration, and Spec-Driven Development (SDD) workflow support.

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

This repository documents how I run OpenCode day to day: global behavior, custom runtime plugins, improved plugin variants, reusable skills, TUI status components, SDD commands, prompt templates, and OpenSpec artifacts.

It is useful as a reference map: read it to understand the setup, copy the patterns that fit your workflow, and adapt paths or assumptions to your own machine.

## Language / Idioma

- [English version](#english-version)
- [Versión en español](#versión-en-español)

---

## English version

### 🚀 Start here

If you want to understand the setup quickly, follow this path:

1. **Open [`opencode.json`](./opencode.json)**  
   Main OpenCode configuration: agents, models, MCP servers, permissions, LSPs, and plugin loading.

2. **Read [`AGENTS.md`](./AGENTS.md)**  
   Global behavior, session rules, memory protocol, persona behavior, and skill-loading rules.

3. **Explore [`plugins/`](./plugins)**  
   Custom OpenCode runtime plugins for Engram, model variants, RTK command rewriting, and skill registry behavior.

4. **Explore [`tui-plugins/`](./tui-plugins)**  
   TUI extensions for quota, cache, limits, branding, and subagent status.

5. **Check [`skills/`](./skills)**  
   Reusable instruction modules for languages, frameworks, SDD phases, reviews, architecture, testing, security, and workflows.

6. **Check [`commands/`](./commands) and [`prompts/sdd/`](./prompts/sdd)**  
   Command definitions and phase prompts that power the SDD workflow.

### 🧭 Repository map

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

### 🔌 Custom OpenCode plugins

The [`plugins/`](./plugins) directory contains custom OpenCode plugin adapters.

| Plugin                                 | What it adds                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`engram.ts`](./plugins/engram.ts)     | Engram memory integration: starts/connects to the local memory server, captures prompts, injects memory instructions, and avoids subagent session inflation. |
| [`model-variants.ts`](./plugins/model-variants.ts) | Reads model/provider variant data from OpenCode and writes a local cache for Gentle AI.                                                          |
| [`rtk.ts`](./plugins/rtk.ts)           | Rewrites shell commands through `rtk rewrite` when available to reduce token usage.                                                                          |
| [`skill-registry.ts`](./plugins/skill-registry.ts) | Refreshes the local skill registry from the flattened plugin entrypoint layout.                                                               |

These plugins now live as flat runtime entrypoints under [`plugins/`](./plugins).

### 🖥️ TUI plugins

The [`tui-plugins/`](./tui-plugins) directory contains OpenCode TUI extensions.

| Plugin                    | Purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `mrjmpl3-cache`           | Cache-related status information.                     |
| `gentle-logo.tsx`         | Gentle AI branding for the TUI.                       |
| `mrjmpl3-limits`          | Limit-related status information.                     |
| `mrjmpl3-quota`           | Provider quota display.                               |
| `mrjmpl3-subagent-status` | Subagent status, idle state, and recovery visibility. |

These extensions are wired from [`tui.json`](./tui.json).

### 🧩 Skills

The [`skills/`](./skills) directory is the reusable instruction layer of this setup.

Skills are focused `SKILL.md` files loaded when a task needs specific behavior, for example:

- PR and issue workflows
- chained PR planning
- code review
- documentation design
- SDD phases
- language/framework-specific guidance
- testing, architecture, security, Docker, Laravel, Python, TypeScript, and more

This keeps the main configuration smaller while still allowing task-specific behavior to be injected only when it is useful.

### 🛠️ Commands and SDD workflow

The [`commands/`](./commands) directory defines user-facing workflow commands.

Important SDD-related commands include:

| Command file                                    | Purpose                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| [`sdd-new.md`](./commands/sdd-new.md)           | Start a new SDD change.                        |
| [`sdd-explore.md`](./commands/sdd-explore.md)   | Explore an idea before committing to a change. |
| [`sdd-ff.md`](./commands/sdd-ff.md)             | Fast-forward planning phases.                  |
| [`sdd-continue.md`](./commands/sdd-continue.md) | Continue the next dependency-ready phase.      |
| [`sdd-apply.md`](./commands/sdd-apply.md)       | Apply implementation tasks.                    |
| [`sdd-verify.md`](./commands/sdd-verify.md)     | Verify implementation against specs and tasks. |
| [`sdd-archive.md`](./commands/sdd-archive.md)   | Archive completed change artifacts.            |

The detailed phase prompts live in [`prompts/sdd/`](./prompts/sdd).

### 📐 OpenSpec artifacts

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

### 🧪 Development notes

This repository has both root-level configuration and package-local TUI plugin projects.

Some local packages include scripts such as:

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

### ⚠️ Local setup notes

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

### 🌱 Why this repo is useful

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

If you already use OpenCode, SDD, Engram, or Gentle AI, this repository can help you improve your own stack without starting from zero.

---

## Versión en español

Un workspace práctico y opinado de configuración para OpenCode, con plugins personalizados, skills reutilizables, extensiones de TUI, helpers de modelos, integración con memoria Engram y soporte para flujos Spec-Driven Development (SDD).

Este repositorio documenta cómo uso OpenCode en el día a día: comportamiento global, plugins de runtime, variantes mejoradas de plugins, skills reutilizables, componentes de estado para la TUI, comandos SDD, plantillas de prompts y artefactos OpenSpec.

Sirve como mapa de referencia: leelo para entender la estructura, copiar los patrones que encajen con tu flujo y adaptar rutas o supuestos a tu propia máquina.

### 🚀 Empezá por acá

Si querés entender rápido la configuración, seguí este recorrido:

1. **Abrí [`opencode.json`](./opencode.json)**  
   Configuración principal de OpenCode: agentes, modelos, servidores MCP, permisos, LSPs y carga de plugins.

2. **Leé [`AGENTS.md`](./AGENTS.md)**  
   Reglas globales de comportamiento, sesiones, memoria, persona y carga de skills.

3. **Explorá [`plugins/`](./plugins)**  
   Plugins personalizados de OpenCode para Engram, variantes de modelos, reescritura de comandos con RTK y registro de skills.

4. **Explorá [`tui-plugins/`](./tui-plugins)**  
   Extensiones para la TUI: cuotas, caché, límites, branding y estado de subagentes.

5. **Revisá [`skills/`](./skills)**  
   Módulos de instrucciones reutilizables para lenguajes, frameworks, fases SDD, reviews, arquitectura, testing, seguridad y flujos de trabajo.

6. **Revisá [`commands/`](./commands) y [`prompts/sdd/`](./prompts/sdd)**  
   Definiciones de comandos y prompts por fase que sostienen el flujo SDD.

### 🧭 Mapa del repositorio

```text
ROOT
│
├── AGENTS.md              # Reglas globales de comportamiento y sesión
├── opencode.json          # Configuración principal de OpenCode
├── tui.json               # Configuración de plugins para la TUI
│
├── commands/              # Definiciones de comandos personalizados
├── prompts/
│   └── sdd/               # Prompts de fases SDD
│
├── skills/                # Instrucciones reutilizables por skill
├── plugins/               # Plugins de runtime de OpenCode
├── tui-plugins/           # Extensiones para la TUI de OpenCode
│
└── openspec/              # Configuración, specs y cambios archivados de OpenSpec
```

### 🔌 Plugins personalizados de OpenCode

El directorio [`plugins/`](./plugins) contiene adaptadores de plugins personalizados para OpenCode.

| Plugin                                         | Qué agrega                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`engram.ts`](./plugins/engram.ts)             | Integración con memoria Engram: inicia o conecta el servidor local, captura prompts, inyecta instrucciones de memoria y evita inflar sesiones de subagentes. |
| [`model-variants.ts`](./plugins/model-variants.ts) | Lee datos de variantes de modelos/proveedores desde OpenCode y escribe una caché local para Gentle AI.                                                   |
| [`rtk.ts`](./plugins/rtk.ts)                   | Reescribe comandos de shell mediante `rtk rewrite` cuando está disponible para reducir uso de tokens.                                                        |
| [`skill-registry.ts`](./plugins/skill-registry.ts) | Actualiza el registro local de skills desde el layout aplanado de entrypoints de plugins.                                                               |

Estos plugins ahora viven como entrypoints planos de runtime dentro de [`plugins/`](./plugins).

### 🖥️ Plugins de TUI

El directorio [`tui-plugins/`](./tui-plugins) contiene extensiones para la TUI de OpenCode.

| Plugin                    | Propósito                                         |
| ------------------------- | ------------------------------------------------- |
| `mrjmpl3-cache`           | Información de estado relacionada con caché.      |
| `gentle-logo.tsx`         | Branding de Gentle AI para la TUI.                |
| `mrjmpl3-limits`          | Información de estado relacionada con límites.    |
| `mrjmpl3-quota`           | Visualización de cuotas por proveedor.            |
| `mrjmpl3-subagent-status` | Estado de subagentes, inactividad y recuperación. |

Estas extensiones se conectan desde [`tui.json`](./tui.json).

### 🧩 Skills

El directorio [`skills/`](./skills) es la capa de instrucciones reutilizables de esta configuración.

Las skills son archivos `SKILL.md` enfocados que se cargan cuando una tarea necesita comportamiento específico, por ejemplo:

- flujos de PRs e issues
- planificación de PRs encadenados
- code review
- diseño de documentación
- fases SDD
- guías específicas por lenguaje o framework
- testing, arquitectura, seguridad, Docker, Laravel, Python, TypeScript y más

Esto mantiene la configuración principal más chica y permite inyectar comportamiento específico solo cuando aporta valor.

### 🛠️ Comandos y flujo SDD

El directorio [`commands/`](./commands) define comandos de workflow orientados al usuario.

Comandos importantes relacionados con SDD:

| Archivo de comando                              | Propósito                                               |
| ----------------------------------------------- | ------------------------------------------------------- |
| [`sdd-new.md`](./commands/sdd-new.md)           | Iniciar un nuevo cambio SDD.                            |
| [`sdd-explore.md`](./commands/sdd-explore.md)   | Explorar una idea antes de comprometerse con un cambio. |
| [`sdd-ff.md`](./commands/sdd-ff.md)             | Avanzar rápido por fases de planificación.              |
| [`sdd-continue.md`](./commands/sdd-continue.md) | Continuar la próxima fase lista según dependencias.     |
| [`sdd-apply.md`](./commands/sdd-apply.md)       | Aplicar tareas de implementación.                       |
| [`sdd-verify.md`](./commands/sdd-verify.md)     | Verificar la implementación contra specs y tareas.      |
| [`sdd-archive.md`](./commands/sdd-archive.md)   | Archivar artefactos de cambios completados.             |

Los prompts detallados por fase viven en [`prompts/sdd/`](./prompts/sdd).

### 📐 Artefactos OpenSpec

[`openspec/`](./openspec) guarda la configuración y los artefactos del flujo Spec-Driven Development.

Incluye:

- configuración del proyecto OpenSpec
- cambios activos
- cambios archivados
- specs
- progreso de aplicación
- reportes de verificación
- reportes de archivo

Esto hace que el repositorio sea útil no solo como configuración de OpenCode, sino también como registro de cómo se planificaron, implementaron y verificaron los cambios de configuración.

### 🧪 Notas de desarrollo

Este repositorio combina configuración de raíz con proyectos de plugins locales.

Algunos paquetes de plugins incluyen scripts como:

```bash
npm install
npm run format
npm run format:check
npm test
npm run typecheck
```

Para checks locales de un paquete, ejecutá los comandos dentro del directorio del plugin correspondiente.

Ejemplo:

```bash
cd tui-plugins/mrjmpl3-subagent-status
npm test
npm run typecheck
```

### ⚠️ Notas de configuración local

Este repositorio incluye rutas y supuestos específicos del entorno local.

Ejemplos:

```text
/home/mrjmpl3/.config/opencode
/home/mrjmpl3/.local/bin/engram
```

Antes de reutilizar partes de esta configuración, revisá:

- rutas absolutas
- binarios locales como `engram` y `rtk`
- nombres de proveedores/modelos
- configuración MCP
- entrypoints de plugins
- permisos de shell y Git

La forma más segura de usar este repo es estudiar la estructura, copiar las ideas que sirvan para tu flujo y adaptar rutas/configuración a tu propia máquina.

### 🌱 Por qué este repo es útil

Este es un ejemplo práctico de un entorno OpenCode profundamente personalizado.

Muestra cómo organizar:

- comportamiento global de OpenCode
- skills reutilizables
- plugins personalizados de runtime
- plugins de estado para la TUI
- comandos y prompts SDD
- integración con memoria
- helpers de modelos/proveedores
- automatización de reviews y workflows

Si ya usás OpenCode, SDD, Engram o Gentle AI, este repositorio puede ayudarte a mejorar tu propio stack sin empezar desde cero.
