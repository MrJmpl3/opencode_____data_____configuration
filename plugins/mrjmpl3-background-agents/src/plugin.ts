import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Plugin } from '@opencode-ai/plugin';
import type { Event } from '@opencode-ai/sdk';

import { DELEGATION_RULES, formatDelegationContext } from './context.ts';
import { createLogger } from './logger.ts';
import { DelegationManager } from './manager.ts';
import { getProjectId } from './project-id.ts';
import { refreshSkillRegistry } from './skill-registry.ts';
import { createDelegate, createDelegationList, createDelegationRead } from './tools.ts';
import type { OpencodeClient, SystemTransformInput } from './types.ts';

export const BackgroundAgents: Plugin = async (ctx) => {
  const { client, directory } = ctx;

  // Create logger early for all components
  const log = createLogger(client as OpencodeClient);

  // Project-level storage directory (shared across sessions)
  // Uses git root commit hash for cross-worktree consistency
  const projectId = await getProjectId(directory);
  const baseDir = path.join(os.homedir(), '.local', 'share', 'opencode', 'delegations', projectId);

  // Ensure base directory exists (for debug logs etc)
  await fs.mkdir(baseDir, { recursive: true });

  const manager = new DelegationManager(client as OpencodeClient, baseDir, log);

  await manager.debugLog('BackgroundAgents initialized with delegation system');
  let skillRegistryRefreshStarted = false;
  const refreshSkillRegistryOnce = async () => {
    if (skillRegistryRefreshStarted) return;
    skillRegistryRefreshStarted = true;
    await refreshSkillRegistry(directory, (level, message) => {
      manager.debugLog(`[${level}] ${message}`).catch(() => {});
    });
  };

  return {
    tool: {
      delegate: createDelegate(manager),
      delegation_read: createDelegationRead(manager),
      delegation_list: createDelegationList(manager),
    },

    // NOTE: tool.execute.before hook for task/delegate routing removed.
    // All agents can use both `delegate` (background, async, persisted) and `task` (native, synchronous).
    // The agent chooses based on whether it needs async background execution or synchronous results.

    // Inject delegation rules into system prompt
    'experimental.chat.system.transform': async (_input: SystemTransformInput, output) => {
      await refreshSkillRegistryOnce();
      const combined = [...output.system, DELEGATION_RULES].join('\n\n---\n\n');
      output.system = [combined];
    },

    // Compaction hook - inject delegation context for context recovery
    'experimental.session.compacting': async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      // Get running delegations for this session tree
      const running = (await manager.getRunningDelegationsForSession(input.sessionID)).map((d) => ({
        id: d.id,
        agent: d.agent,
        title: d.title,
        description: d.description,
        status: d.status,
        startedAt: d.startedAt,
        prompt: d.prompt,
      }));

      // Get recent completed delegations (last 10)
      const allDelegations = await manager.listDelegations(input.sessionID);
      const completed = allDelegations
        .filter((d) => d.status !== 'running')
        .slice(-10)
        .map((d) => ({
          id: d.id,
          agent: d.agent,
          title: d.title,
          description: d.description,
          status: d.status,
        }));

      // Early exit if nothing to inject
      if (running.length === 0 && completed.length === 0) return;

      output.context.push(formatDelegationContext(running, completed));
    },

    // Event hook
    event: async ({ event }: { event: Event }): Promise<void> => {
      if (event.type === 'session.idle') {
        const sessionID = event.properties.sessionID;
        const delegation = manager.findBySession(sessionID);
        if (delegation) {
          await manager.handleSessionIdle(sessionID);
        }
      }

      if (event.type === 'message.updated') {
        const sessionID = event.properties.info.sessionID;
        if (sessionID) {
          manager.handleMessageEvent(sessionID);
        }
      }
    },
  };
};

export default BackgroundAgents;
