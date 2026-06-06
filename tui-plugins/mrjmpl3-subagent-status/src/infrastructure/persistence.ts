import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import os from 'node:os';

import type { SubagentState } from '../domain/types.ts';

import { hydrateStateFromRecoverySources, type RecoveryContext, type RecoverySource } from './recovery.ts';
import { createSerializedTaskQueue } from '../runtime/queue.ts';
import {
  createEmptyState,
  clearPurgedSession,
  normalizeChild,
  pruneOrphanedSyntheticRunningChildren,
  pruneTerminalChildren,
  rekeyCountedExecution,
  resolveExecutionCountIdentity,
  syncExecutionState,
} from '../domain/state.ts';

const STATUS_DIRNAME = 'mrjmpl3-subagent-status';
const STATUS_FILENAME = 'state.json';
const STATUS_DIR_MODE = 0o700;
const STATUS_FILE_MODE = 0o600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function safeReadJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function writeLocalFile(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: STATUS_DIR_MODE });

  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, contents, { encoding: 'utf8', mode: STATUS_FILE_MODE });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveStatePath(
  input: string | { workspaceDirectory?: string; statePath?: string } = process.cwd(),
): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof input.statePath === 'string' &&
    input.statePath.trim().length > 0
  ) {
    return input.statePath;
  }

  const workspaceDirectory = typeof input === 'string' ? input : (input.workspaceDirectory ?? process.cwd());
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const resolvedWorkspaceDirectory = resolve(workspaceDirectory);
  const workspaceHash = createHash('sha256').update(resolvedWorkspaceDirectory).digest('hex').slice(0, 16);

  return join(runtimeDir, STATUS_DIRNAME, `workspace-${workspaceHash}`, STATUS_FILENAME);
}

export function resolveTextPath(statePath: string): string {
  return join(dirname(statePath), 'status.txt');
}

export function resolveDebugPath(statePath: string): string {
  return join(dirname(statePath), 'debug.json');
}

export function shouldPreserveStateOnStartup(input?: { preserveStateOnStartup?: boolean }): boolean {
  return input?.preserveStateOnStartup === true;
}

export async function loadState(
  statePath: string,
  options: {
    recoveryContext?: RecoveryContext;
    recoverySources?: RecoverySource[];
  } = {},
): Promise<SubagentState> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = safeReadJSON(raw);
    if (!isRecord(parsed)) return createEmptyState();

    const state = createEmptyState();
    state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : state.updatedAt;

    if (isRecord(parsed.countedChildIDs)) {
      for (const [id, value] of Object.entries(parsed.countedChildIDs)) {
        if (value === true && id) state.countedChildIDs[id] = true;
      }
    }
    if (isRecord(parsed.purgedSessionIDs)) {
      for (const [id, value] of Object.entries(parsed.purgedSessionIDs)) {
        if (value === true && id.startsWith('ses_')) state.purgedSessionIDs[id] = true;
      }
    }
    state.totalExecuted = Math.max(
      toNonNegativeInteger(parsed.totalExecuted) ?? 0,
      Object.keys(state.countedChildIDs).length,
    );

    const rawChildren = isRecord(parsed.children) ? parsed.children : {};
    for (const [id, value] of Object.entries(rawChildren)) {
      if (!isRecord(value)) continue;
      if (typeof value.parentID !== 'string') continue;

      const tokens = isRecord(value.tokens)
        ? {
            input: toFiniteNumber(value.tokens.input),
            output: toFiniteNumber(value.tokens.output),
            total: toFiniteNumber(value.tokens.total),
            contextPercent: toFiniteNumber(value.tokens.contextPercent),
          }
        : undefined;

      const child = normalizeChild(
        {
          id: typeof value.id === 'string' ? value.id : id,
          title: typeof value.title === 'string' ? value.title : id,
          summary: typeof value.summary === 'string' ? value.summary : undefined,
          agentName: typeof value.agentName === 'string' ? value.agentName : undefined,
          parentID: value.parentID,
          messageID: typeof value.messageID === 'string' ? value.messageID : undefined,
          source:
            value.source === 'session' || value.source === 'subtask' || value.source === 'tool'
              ? value.source
              : undefined,
          targetSessionID: typeof value.targetSessionID === 'string' ? value.targetSessionID : undefined,
          status: value.status === 'done' || value.status === 'error' ? value.status : 'running',
          color: value.color === 'green' || value.color === 'red' || value.color === 'yellow' ? value.color : undefined,
          startedAt: typeof value.startedAt === 'string' ? value.startedAt : state.updatedAt,
          updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : state.updatedAt,
          endedAt: typeof value.endedAt === 'string' ? value.endedAt : undefined,
          elapsedMs: toFiniteNumber(value.elapsedMs),
          tokens:
            tokens?.input === undefined &&
            tokens?.output === undefined &&
            tokens?.total === undefined &&
            tokens?.contextPercent === undefined
              ? undefined
              : tokens,
        },
        Date.parse(state.updatedAt),
      );
      clearPurgedSession(state, child.id);
      state.children[child.id] = child;
    }

    for (const child of Object.values(state.children)) {
      if (child.source === 'subtask' && child.targetSessionID && state.countedChildIDs[child.id]) {
        rekeyCountedExecution(state, child.id, child.targetSessionID);
      }

      const countIdentity = resolveExecutionCountIdentity(state, child);
      if (countIdentity && !state.countedChildIDs[countIdentity]) {
        state.countedChildIDs[countIdentity] = true;
      }
    }

    syncExecutionState(state);

    if (options.recoverySources && options.recoverySources.length > 0) {
      await hydrateStateFromRecoverySources(
        state,
        {
          directory: options.recoveryContext?.directory ?? process.cwd(),
          parentSessionID: options.recoveryContext?.parentSessionID,
        },
        options.recoverySources,
      );
    }

    const prunedTerminalChildren = pruneTerminalChildren(state, Date.now());
    const prunedOrphanedSyntheticChildren = pruneOrphanedSyntheticRunningChildren(state);
    if (prunedTerminalChildren || prunedOrphanedSyntheticChildren) {
      state.updatedAt = new Date().toISOString();
    }

    return state;
  } catch {
    return createEmptyState();
  }
}

export async function saveStatusText(textPath: string, contents: string): Promise<void> {
  await writeLocalFile(textPath, contents);
}

export async function saveDebugSnapshot(debugPath: string, contents: string): Promise<void> {
  await writeLocalFile(debugPath, contents);
}

export async function saveState(statePath: string, state: SubagentState): Promise<void> {
  await writeLocalFile(statePath, JSON.stringify(state, null, 2));
}

export type PersistedSnapshotArtifacts = {
  statusText: string;
  debugSnapshot: string;
};

export async function persistSnapshot(
  statePath: string,
  textPath: string,
  state: SubagentState,
  artifacts: PersistedSnapshotArtifacts,
): Promise<void> {
  try {
    await saveState(statePath, state);
    await saveStatusText(textPath, artifacts.statusText);
    await saveDebugSnapshot(resolveDebugPath(statePath), artifacts.debugSnapshot);
  } catch {
    // Persistence is best-effort.
  }
}

export function createPersistQueue<TMeta>(
  statePath: string,
  textPath: string,
  formatArtifacts: (state: SubagentState, meta: TMeta) => PersistedSnapshotArtifacts,
) {
  const enqueue = createSerializedTaskQueue(async (payload: { state: SubagentState; meta: TMeta }) => {
    await persistSnapshot(statePath, textPath, payload.state, formatArtifacts(payload.state, payload.meta));
  });

  return (state: SubagentState, meta: TMeta): Promise<void> =>
    enqueue({ state: structuredClone(state) as SubagentState, meta });
}
