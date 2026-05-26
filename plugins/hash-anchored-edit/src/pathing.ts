import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const resolveFilePath = (directory: string, filePath: string) => {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);

  return path.resolve(directory, filePath);
};

export const relativeLabel = (worktree: string, filePath: string) => {
  const relativePath = path.relative(worktree, filePath);

  if (!relativePath || relativePath.startsWith("..")) return filePath;

  return relativePath;
};

export const readFileInfo = async (filePath: string) => {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;

    throw error;
  }
};

export const ensureParentDirectory = async (filePath: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
};

export const writeTextFileAtomically = async (
  filePath: string,
  content: string,
) => {
  await ensureParentDirectory(filePath);

  const tempFilePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempFilePath, content, "utf8");
    await rename(tempFilePath, filePath);
  } catch (error) {
    await unlink(tempFilePath).catch(() => undefined);
    throw error;
  }
};

export const renderDirectory = async (filePath: string) => {
  const entries = await readdir(filePath, { withFileTypes: true });

  return entries
    .sort((left: { name: string }, right: { name: string }) =>
      left.name.localeCompare(right.name),
    )
    .map(
      (entry: { isDirectory: () => boolean; name: string }) =>
        `${entry.name}${entry.isDirectory() ? "/" : ""}`,
    )
    .join("\n");
};
