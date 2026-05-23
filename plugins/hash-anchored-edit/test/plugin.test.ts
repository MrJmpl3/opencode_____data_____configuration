import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"

import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import HashAnchoredEditPlugin from "../src/index.ts"

type PluginTools = {
  edit: {
    execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  }
  read: {
    execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  }
}

const outputText = (result: ToolResult) => (typeof result === "string" ? result : result.output)

const extractAnchors = (result: ToolResult) =>
  outputText(result)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|", 1)[0].trim())

const createToolContext = (directory: string): ToolContext => ({
  abort: new AbortController().signal,
  agent: "test",
  ask: async () => {},
  directory,
  messageID: "message",
  metadata: () => {},
  sessionID: "session",
  worktree: directory,
})

const loadTools = async (directory: string) => {
  const hooks = await HashAnchoredEditPlugin({
    $: {} as never,
    client: {} as never,
    directory,
    experimental_workspace: {
      register: () => {},
    },
    project: {} as never,
    serverUrl: new URL("https://example.com"),
    worktree: directory,
  })

  return {
    context: createToolContext(directory),
    tools: hooks.tool as unknown as PluginTools,
  }
}

describe("HashAnchoredEditPlugin", () => {
  let directory = ""

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hash-anchored-edit-"))
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it("creates empty files with a stable empty diff", async () => {
    const { context, tools } = await loadTools(directory)

    const result = await tools.edit.execute(
      {
        edits: [{ lines: [], op: "append" }],
        filePath: "empty.txt",
      },
      context,
    )

    expect(await readFile(path.join(directory, "empty.txt"), "utf8")).toBe("")
    expect(outputText(result)).toContain("@@ -0,0 +0,0 @@")
  })

  it("creates non-empty files with a trailing newline", async () => {
    const { context, tools } = await loadTools(directory)

    await tools.edit.execute(
      {
        edits: [{ lines: ["hello"], op: "append" }],
        filePath: "note.txt",
      },
      context,
    )

    expect(await readFile(path.join(directory, "note.txt"), "utf8")).toBe("hello\n")
  })

  it("rejects reads for missing paths", async () => {
    const { context, tools } = await loadTools(directory)

    await expect(tools.read.execute({ filePath: "missing.txt" }, context)).rejects.toThrow("No file: missing.txt")
  })

  it("rejects binary files", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "blob.bin"), Buffer.from([0, 1, 2, 3]))

    await expect(tools.read.execute({ filePath: "blob.bin" }, context)).rejects.toThrow("Binary file")
  })

  it("rejects multiline replace ranges", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "doc.txt"), "one\ntwo\nthree\n", "utf8")

    const readResult = await tools.read.execute({ filePath: "doc.txt" }, context)
    const [firstLine, secondLine] = extractAnchors(readResult)

    await expect(
      tools.edit.execute(
        {
          edits: [{ end: secondLine, lines: ["replaced"], op: "replace", pos: firstLine }],
          filePath: "doc.txt",
        },
        context,
      ),
    ).rejects.toThrow("Multiline replace is not supported")
  })

  it("rejects overlapping replace edits on the same line", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "overlap.txt"), "line\n", "utf8")

    const readResult = await tools.read.execute({ filePath: "overlap.txt" }, context)
    const [anchor] = extractAnchors(readResult)

    await expect(
      tools.edit.execute(
        {
          edits: [
            { lines: ["first"], op: "replace", pos: anchor },
            { lines: ["second"], op: "replace", pos: anchor },
          ],
          filePath: "overlap.txt",
        },
        context,
      ),
    ).rejects.toThrow("Overlapping replace ranges")
  })

  it("rejects rename combined with edits", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "doc.txt"), "content\n", "utf8")

    await expect(
      tools.edit.execute(
        {
          anchors: ["1#ZPMQV"],
          filePath: "doc.txt",
          mode: "insert_after",
          newText: "next",
          rename: "renamed.txt",
        },
        context,
      ),
    ).rejects.toThrow("rename cannot be combined with edits")
  })

  it("supports pure rename without touching content", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "before.txt"), "content\n", "utf8")

    const result = await tools.edit.execute(
      {
        filePath: "before.txt",
        rename: "after.txt",
      },
      context,
    )

    expect(await readFile(path.join(directory, "after.txt"), "utf8")).toBe("content\n")
    await expect(readFile(path.join(directory, "before.txt"), "utf8")).rejects.toThrow()
    expect(outputText(result)).toContain("Moved before.txt -> after.txt")
  })

  it("rejects stale anchors after the file changes", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "stale.txt"), "alpha\n", "utf8")

    const readResult = await tools.read.execute({ filePath: "stale.txt" }, context)
    const [anchor] = extractAnchors(readResult)

    await writeFile(path.join(directory, "stale.txt"), "beta\n", "utf8")

    await expect(
      tools.edit.execute(
        {
          edits: [{ lines: ["gamma"], op: "replace", pos: anchor }],
          filePath: "stale.txt",
        },
        context,
      ),
    ).rejects.toThrow("Stale")
  })

  it("returns a stable one-line diff for updates", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "update.txt"), "before\n", "utf8")

    const readResult = await tools.read.execute({ filePath: "update.txt" }, context)
    const [anchor] = extractAnchors(readResult)

    const result = await tools.edit.execute(
      {
        edits: [{ lines: ["after"], op: "replace", pos: anchor }],
        filePath: "update.txt",
      },
      context,
    )

    expect(await readFile(path.join(directory, "update.txt"), "utf8")).toBe("after\n")
    expect(outputText(result)).toContain("Updated update.txt")
    expect(outputText(result)).toContain("@@ -1,1 +1,1 @@")
  })

  it("applies prepend and append around the same anchor in order", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "surround.txt"), "middle\n", "utf8")

    const readResult = await tools.read.execute({ filePath: "surround.txt" }, context)
    const [anchor] = extractAnchors(readResult)

    await tools.edit.execute(
      {
        edits: [
          { lines: ["before"], op: "prepend", pos: anchor },
          { lines: ["after"], op: "append", pos: anchor },
        ],
        filePath: "surround.txt",
      },
      context,
    )

    expect(await readFile(path.join(directory, "surround.txt"), "utf8")).toBe("before\nmiddle\nafter\n")
  })

  it("renders empty-file deletes with a zero-line hunk", async () => {
    const { context, tools } = await loadTools(directory)
    await writeFile(path.join(directory, "empty-delete.txt"), "", "utf8")

    const result = await tools.edit.execute(
      {
        delete: true,
        filePath: "empty-delete.txt",
      },
      context,
    )

    expect(outputText(result)).toContain("@@ -0,0 +0,0 @@")
  })
})
