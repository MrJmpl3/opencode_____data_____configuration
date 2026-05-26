import { createHash } from "node:crypto";

import {
  ANCHOR_PATTERN,
  HASH_ALPHABET,
  HASH_LENGTH,
  type ParsedAnchor,
} from "./types.ts";

export const hashLine = (lineNumber: number, content: string) => {
  const digest = createHash("sha256")
    .update(`${lineNumber}:${content}`)
    .digest();
  let output = "";

  for (let index = 0; index < HASH_LENGTH; index += 1) {
    const byte = digest[Math.floor(index / 2)];
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    output += HASH_ALPHABET[nibble];
  }

  return output;
};

export const formatAnchor = (lineNumber: number, content: string) =>
  `${lineNumber}#${hashLine(lineNumber, content)}`;

export const formatAnchoredLine = (lineNumber: number, content: string) =>
  `${formatAnchor(lineNumber, content)}| ${content}`;

export const parseAnchor = (anchor: string): ParsedAnchor => {
  const normalizedAnchor = anchor.trim().toUpperCase();
  const match = normalizedAnchor.match(ANCHOR_PATTERN);

  if (!match) {
    throw new Error(
      `Bad anchor \"${anchor}\". Need LINE#ID, e.g. 42#${HASH_ALPHABET[0].repeat(HASH_LENGTH)}.`,
    );
  }

  return {
    hash: match[2],
    line: Number(match[1]),
    raw: normalizedAnchor,
  };
};
