import { readFile } from "node:fs/promises";

import { formatAnchor, formatAnchoredLine, hashLine } from "./anchors.ts";
import { type ParsedAnchor, type ParsedFile } from "./types.ts";

const isBinaryBuffer = (buffer: Uint8Array) => buffer.includes(0);

export const parseText = (content: string): ParsedFile => {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");

  if (normalized === "") {
    return {
      hasTrailingNewline: false,
      lines: [],
      newline,
    };
  }

  const hasTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");

  if (hasTrailingNewline) lines.pop();

  return {
    hasTrailingNewline,
    lines,
    newline,
  };
};

export const serializeText = ({
  hasTrailingNewline,
  lines,
  newline,
}: ParsedFile) => {
  const body = lines.join(newline);

  if (hasTrailingNewline && lines.length > 0) return `${body}${newline}`;

  return body;
};

export const readTextFile = async (filePath: string) => {
  const buffer = await readFile(filePath);

  if (isBinaryBuffer(buffer)) {
    throw new Error(`Binary file: ${filePath}`);
  }

  return parseText(buffer.toString("utf8"));
};

export const renderAnchoredLines = (lines: string[], startLine = 1) =>
  lines
    .map((line, index) => formatAnchoredLine(startLine + index, line))
    .join("\n");

export const renderContextAroundLine = (
  file: ParsedFile,
  line: number,
  radius = 1,
) => {
  const start = Math.max(1, line - radius);
  const end = Math.min(file.lines.length, line + radius);

  return renderAnchoredLines(file.lines.slice(start - 1, end), start);
};

export const validateAnchor = (file: ParsedFile, anchor: ParsedAnchor) => {
  if (anchor.line < 1 || anchor.line > file.lines.length) {
    const nearestLine = Math.min(
      Math.max(anchor.line, 1),
      Math.max(file.lines.length, 1),
    );
    const context =
      file.lines.length > 0
        ? `\n${renderContextAroundLine(file, nearestLine)}`
        : "";

    throw new Error(`Anchor ${anchor.raw} is out of range.${context}`);
  }

  const actualContent = file.lines[anchor.line - 1];
  const actualHash = hashLine(anchor.line, actualContent);

  if (actualHash !== anchor.hash) {
    throw new Error(
      `Stale ${anchor.raw}; now ${formatAnchor(anchor.line, actualContent)}.` +
        `\n${renderContextAroundLine(file, anchor.line)}`,
    );
  }
};

const getHunkCount = (lines: string[]) => lines.length;

const getHunkStart = (lineNumber: number, count: number) =>
  count === 0 ? 0 : lineNumber;

export const renderUnifiedDiff = (before: ParsedFile, after: ParsedFile) => {
  if (serializeText(before) === serializeText(after)) {
    return "(No content changes)";
  }

  const beforeLines = before.lines;
  const afterLines = after.lines;
  let prefix = 0;

  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;

  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const beforeChunk = beforeLines.slice(prefix, beforeSuffix + 1);
  const afterChunk = afterLines.slice(prefix, afterSuffix + 1);
  const beforeCount = getHunkCount(beforeChunk);
  const afterCount = getHunkCount(afterChunk);
  const beforeStart = getHunkStart(prefix + 1, beforeCount);
  const afterStart = getHunkStart(prefix + 1, afterCount);
  const output = [
    `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
  ];

  for (let index = 0; index < beforeChunk.length; index += 1) {
    output.push(
      `- ${formatAnchoredLine(prefix + index + 1, beforeChunk[index])}`,
    );
  }

  for (let index = 0; index < afterChunk.length; index += 1) {
    output.push(
      `+ ${formatAnchoredLine(prefix + index + 1, afterChunk[index])}`,
    );
  }

  return output.join("\n");
};

export const renderCreateDiff = (file: ParsedFile) => {
  const count = getHunkCount(file.lines);
  const output = [`@@ -0,0 +${getHunkStart(1, count)},${count} @@`];

  for (let index = 0; index < file.lines.length; index += 1) {
    output.push(`+ ${formatAnchoredLine(index + 1, file.lines[index])}`);
  }

  return output.join("\n");
};

export const renderDeleteDiff = (file: ParsedFile) => {
  const count = getHunkCount(file.lines);
  const output = [`@@ -${getHunkStart(1, count)},${count} +0,0 @@`];

  for (let index = 0; index < file.lines.length; index += 1) {
    output.push(`- ${formatAnchoredLine(index + 1, file.lines[index])}`);
  }

  return output.join("\n");
};

export const renderAnchoredSlice = (
  file: ParsedFile,
  offset: number,
  limit: number,
) => {
  const start = Math.max(offset, 1);
  const end = Math.min(file.lines.length, start + limit - 1);

  if (start > end) return "";

  const output: string[] = [];

  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    output.push(formatAnchoredLine(lineNumber, file.lines[lineNumber - 1]));
  }

  return output.join("\n");
};
