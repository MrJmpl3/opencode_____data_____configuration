import { rename, unlink } from "node:fs/promises"

import { type Plugin, tool } from "@opencode-ai/plugin"

import { applyEdits, buildCreatedFile, hasEditPayload, normalizeEditArgs, validateCreateEdits, validateDeleteMode, validateEditBatch } from "./edits.ts"
import { ensureParentDirectory, readFileInfo, relativeLabel, renderDirectory, resolveFilePath, writeTextFileAtomically } from "./pathing.ts"
import { readTextFile, renderAnchoredSlice, renderCreateDiff, renderDeleteDiff, renderUnifiedDiff, serializeText } from "./text.ts"
import { type RawEditArgs } from "./types.ts"

export const HashAnchoredEditPlugin: Plugin = async () => {
  return {
    tool: {
      read: tool({
        description:
          "Read files or directories. Text files are returned with hash anchors in the form LINE#ID| content. Reuse the exact LINE#ID tokens with the edit tool to avoid stale-line edits.",
        args: {
          filePath: tool.schema.string(),
          offset: tool.schema.number().int().positive().optional(),
          limit: tool.schema.number().int().positive().optional(),
        },
        async execute(args, context) {
          const filePath = resolveFilePath(context.directory, args.filePath)
          const info = await readFileInfo(filePath)
          const label = relativeLabel(context.worktree, filePath)

          if (!info) {
            throw new Error(`No file: ${label}`)
          }

          if (info.isDirectory()) {
            return {
              title: label,
              output: await renderDirectory(filePath),
            }
          }

          const file = await readTextFile(filePath)

          return {
            title: label,
            output: renderAnchoredSlice(file, args.offset ?? 1, args.limit ?? 2000),
          }
        },
      }),
      edit: tool({
        description:
          "Edit a text file using LINE#ID anchors from read. Prefer edits[] with { op, pos, end, lines } where op is replace, append, or prepend. Supports create with unanchored append or prepend, plus safe rename or delete. rename cannot be combined with edits.",
        args: {
          anchors: tool.schema.array(tool.schema.string()).optional(),
          delete: tool.schema.boolean().optional(),
          edits: tool.schema
            .array(
              tool.schema.object({
                end: tool.schema.string().optional(),
                lines: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]),
                op: tool.schema.enum(["replace", "append", "prepend"]),
                pos: tool.schema.string().optional(),
              }),
            )
            .optional(),
          filePath: tool.schema.string(),
          mode: tool.schema.enum(["replace", "insert_before", "insert_after"]).optional(),
          newText: tool.schema.string().optional(),
          rename: tool.schema.string().optional(),
        },
        async execute(rawArgs, context) {
          const args = rawArgs as RawEditArgs
          const filePath = resolveFilePath(context.directory, args.filePath)
          const label = relativeLabel(context.worktree, filePath)
          const renamePath = args.rename ? resolveFilePath(context.directory, args.rename) : undefined
          const renameLabel = renamePath ? relativeLabel(context.worktree, renamePath) : undefined
          const pureRename =
            Boolean(renamePath && renamePath !== filePath) &&
            !args.delete &&
            !args.mode &&
            !args.anchors &&
            typeof args.newText !== "string" &&
            (!args.edits || args.edits.length === 0)

          validateDeleteMode(args)

          if (renamePath && renamePath !== filePath && hasEditPayload(args)) {
            throw new Error("rename cannot be combined with edits. Use separate calls.")
          }

          const info = await readFileInfo(filePath)

          if (args.delete) {
            if (!info) {
              throw new Error(`No file: ${label}`)
            }

            if (!info.isFile()) {
              throw new Error(`Not a file: ${label}`)
            }

            const deletedFile = await readTextFile(filePath)

            await unlink(filePath)

            return {
              title: label,
              output: [`Deleted ${label}`, renderDeleteDiff(deletedFile)].join("\n"),
            }
          }

          if (pureRename) {
            if (!info) {
              throw new Error(`No file: ${label}`)
            }

            if (!info.isFile()) {
              throw new Error(`Not a file: ${label}`)
            }

            const renameInfo = await readFileInfo(renamePath!)

            if (renameInfo) {
              throw new Error(`Rename target exists: ${renameLabel}`)
            }

            await ensureParentDirectory(renamePath!)
            await rename(filePath, renamePath!)

            return {
              title: renameLabel ?? label,
              output: [`Moved ${label} -> ${renameLabel}`, "(No content changes)"].join("\n"),
            }
          }

          const edits = normalizeEditArgs(args)

          if (!info) {
            validateCreateEdits(edits)

            const nextFile = buildCreatedFile(edits)
            const nextContent = serializeText(nextFile)

            await writeTextFileAtomically(filePath, nextContent)

            return {
              title: label,
              output: [`Created ${label}`, renderCreateDiff(nextFile)].join("\n"),
            }
          }

          if (!info.isFile()) {
            throw new Error(`Not a file: ${label}`)
          }

          const file = await readTextFile(filePath)

          validateEditBatch(file, edits)

          const nextFile = applyEdits(file, edits)
          const nextContent = serializeText(nextFile)
          const previousContent = serializeText(file)

          if (nextContent === previousContent) {
            return {
              title: label,
              output: "No changes.",
            }
          }

          await writeTextFileAtomically(filePath, nextContent)

          return {
            title: label,
            output: [`Updated ${label}`, renderUnifiedDiff(file, nextFile)].join("\n"),
          }
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        "Hash-anchored editing is enabled. Read existing files before editing. Lines come back as LINE#ID| content. Prefer edit with edits[] and { op, pos, end, lines }. edit validates anchors, supports create via unanchored append or prepend, safe rename or delete, rejects stale edits, and does not allow rename mixed with edits.",
      )
    },
    "tool.definition": async (input, output) => {
      if (input.toolID === "apply_patch") {
        output.description = `${output.description} Prefer edit for normal existing-file changes because edit validates LINE#ID anchors against the current file content and rejects stale edits.`
      }
    },
  }
}

export default HashAnchoredEditPlugin
