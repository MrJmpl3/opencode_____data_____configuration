export const HASH_LENGTH = 5
export const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH"
export const ANCHOR_PATTERN = new RegExp(`^(\\d+)#([${HASH_ALPHABET}]{${HASH_LENGTH}})$`)

export type ParsedFile = {
  hasTrailingNewline: boolean
  lines: string[]
  newline: string
}

export type ParsedAnchor = {
  hash: string
  line: number
  raw: string
}

export type NormalizedEdit = {
  end?: ParsedAnchor
  lines: string[]
  op: "replace" | "append" | "prepend"
  pos?: ParsedAnchor
}

export type LegacyEditArgs = {
  anchors?: string[]
  mode?: "replace" | "insert_before" | "insert_after"
  newText?: string
}

export type RawEditArgs = LegacyEditArgs & {
  delete?: boolean
  edits?: Array<{
    end?: string
    lines: string | string[]
    op: "replace" | "append" | "prepend"
    pos?: string
  }>
  filePath: string
  rename?: string
}
