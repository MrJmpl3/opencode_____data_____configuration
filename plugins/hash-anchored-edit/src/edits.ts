import { parseAnchor } from "./anchors.ts"
import { parseText, validateAnchor } from "./text.ts"
import { type NormalizedEdit, type ParsedFile, type RawEditArgs } from "./types.ts"

const parseLinePayload = (lines: string | string[]) => {
  if (Array.isArray(lines)) return [...lines]

  return parseText(lines).lines
}

export const hasEditPayload = (args: RawEditArgs) =>
  Boolean(args.mode || args.anchors || typeof args.newText === "string" || (args.edits && args.edits.length > 0))

const validateEdit = (file: ParsedFile, edit: NormalizedEdit) => {
  if (edit.lines.length === 0) {
    throw new Error(`${edit.op} needs lines.`)
  }

  if (edit.op === "replace") {
    if (!edit.pos) throw new Error("replace needs pos.")

    validateAnchor(file, edit.pos)

    if (!edit.end) return

    validateAnchor(file, edit.end)

    if (edit.end.line < edit.pos.line) {
      throw new Error(`Bad range ${edit.pos.raw}..${edit.end.raw}.`)
    }

    if (edit.end.line !== edit.pos.line) {
      throw new Error("Multiline replace is not supported. Use one-line replace or multiple single-line edits.")
    }

    return
  }

  if (edit.pos && edit.end) {
    throw new Error(`${edit.op} uses one anchor: pos or end.`)
  }

  const anchor = edit.pos ?? edit.end

  if (!anchor) {
    throw new Error(`${edit.op} needs pos or end.`)
  }

  validateAnchor(file, anchor)
}

const getEditLine = (edit: NormalizedEdit) => edit.pos?.line ?? edit.end?.line ?? 0

const getReplaceRange = (edit: NormalizedEdit) => {
  const start = edit.pos?.line ?? 0
  const end = edit.end?.line ?? start

  return { end, start }
}

const isLineInsideRange = (line: number, range: { end: number; start: number }) => line >= range.start && line <= range.end

export const validateEditBatch = (file: ParsedFile, edits: NormalizedEdit[]) => {
  if (edits.length === 0) {
    throw new Error("Need at least one edit.")
  }

  for (const edit of edits) {
    validateEdit(file, edit)
  }

  const replacements = edits
    .filter((edit) => edit.op === "replace")
    .map((edit) => ({
      ...getReplaceRange(edit),
      raw: edit.pos?.raw ?? "",
    }))
    .sort((left, right) => left.start - right.start)

  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1]
    const current = replacements[index]

    if (current.start <= previous.end) {
      throw new Error("Overlapping replace ranges.")
    }
  }

  for (const edit of edits) {
    if (edit.op === "replace") continue

    const line = getEditLine(edit)
    const containingRange = replacements.find((range) => isLineInsideRange(line, range))

    if (!containingRange) continue

    if (line !== containingRange.start) {
      throw new Error(`${edit.op} on ${edit.pos?.raw ?? edit.end?.raw} conflicts with replace ${containingRange.raw}. Use its first line.`)
    }
  }
}

const normalizeLegacyArgs = (args: RawEditArgs): NormalizedEdit[] | null => {
  if (!args.mode) return null

  if (!args.anchors || args.anchors.length === 0) {
    throw new Error("Legacy needs anchors.")
  }

  if (typeof args.newText !== "string") {
    throw new Error("Legacy needs newText.")
  }

  if (args.mode === "replace") {
    if (args.anchors.length === 1) {
      return [
        {
          lines: parseLinePayload(args.newText),
          op: "replace",
          pos: parseAnchor(args.anchors[0]),
        },
      ]
    }

    return [
      {
        end: parseAnchor(args.anchors[args.anchors.length - 1]),
        lines: parseLinePayload(args.newText),
        op: "replace",
        pos: parseAnchor(args.anchors[0]),
      },
    ]
  }

  if (args.anchors.length !== 1) {
    throw new Error(`Legacy ${args.mode} needs one anchor.`)
  }

  return [
    {
      lines: parseLinePayload(args.newText),
      op: args.mode === "insert_after" ? "append" : "prepend",
      pos: parseAnchor(args.anchors[0]),
    },
  ]
}

export const normalizeEditArgs = (args: RawEditArgs) => {
  if (args.edits && args.edits.length > 0) {
    return args.edits.map((edit) => ({
      end: edit.end ? parseAnchor(edit.end) : undefined,
      lines: parseLinePayload(edit.lines),
      op: edit.op,
      pos: edit.pos ? parseAnchor(edit.pos) : undefined,
    }))
  }

  const legacyEdits = normalizeLegacyArgs(args)

  if (legacyEdits) return legacyEdits

  throw new Error("Need edits[] or legacy mode+anchors+newText.")
}

export const validateDeleteMode = (args: RawEditArgs) => {
  if (!args.delete) return

  if (args.rename) {
    throw new Error("delete + rename is invalid.")
  }

  if (args.mode || args.anchors || typeof args.newText === "string") {
    throw new Error("delete cannot use legacy fields.")
  }

  if (args.edits && args.edits.length > 0) {
    throw new Error("delete cannot include edits.")
  }
}

export const validateCreateEdits = (edits: NormalizedEdit[]) => {
  if (edits.length === 0) {
    throw new Error("Create needs append/prepend.")
  }

  for (const edit of edits) {
    if (edit.op === "replace") {
      throw new Error("replace needs an existing file.")
    }

    if (edit.pos || edit.end) {
      throw new Error(`Create cannot anchor ${edit.op}.`)
    }
  }
}

export const buildCreatedFile = (edits: NormalizedEdit[]): ParsedFile => {
  const prepends = edits.filter((edit) => edit.op === "prepend").flatMap((edit) => edit.lines)
  const appends = edits.filter((edit) => edit.op === "append").flatMap((edit) => edit.lines)

  return {
    hasTrailingNewline: prepends.length + appends.length > 0,
    lines: [...prepends, ...appends],
    newline: "\n",
  }
}

const collectLinesByOperation = (edits: NormalizedEdit[], op: "append" | "prepend") => {
  const grouped = new Map<number, string[]>()

  for (const edit of edits) {
    if (edit.op !== op) continue

    const line = getEditLine(edit)
    const existing = grouped.get(line) ?? []

    existing.push(...edit.lines)
    grouped.set(line, existing)
  }

  return grouped
}

const collectReplacementStarts = (edits: NormalizedEdit[]) => {
  const replacements = new Map<number, { end: number; lines: string[] }>()

  for (const edit of edits) {
    if (edit.op !== "replace") continue

    const { end, start } = getReplaceRange(edit)

    replacements.set(start, {
      end,
      lines: edit.lines,
    })
  }

  return replacements
}

export const applyEdits = (file: ParsedFile, edits: NormalizedEdit[]) => {
  const prepends = collectLinesByOperation(edits, "prepend")
  const appends = collectLinesByOperation(edits, "append")
  const replacements = collectReplacementStarts(edits)
  const nextLines: string[] = []

  for (let lineNumber = 1; lineNumber <= file.lines.length; ) {
    const prependLines = prepends.get(lineNumber) ?? []
    const appendLines = appends.get(lineNumber) ?? []
    const replacement = replacements.get(lineNumber)

    if (prependLines.length > 0) {
      nextLines.push(...prependLines)
    }

    if (replacement) {
      nextLines.push(...replacement.lines)

      if (appendLines.length > 0) {
        nextLines.push(...appendLines)
      }

      lineNumber = replacement.end + 1
      continue
    }

    nextLines.push(file.lines[lineNumber - 1])

    if (appendLines.length > 0) {
      nextLines.push(...appendLines)
    }

    lineNumber += 1
  }

  return {
    ...file,
    lines: nextLines,
  }
}
