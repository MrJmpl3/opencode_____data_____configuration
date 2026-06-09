import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveAgentModel } from './agents.ts';
import { dispatchDelegationNotifications, PendingDelegationNotifications } from './delegation-notifications.ts';
import { getDelegationResult } from './delegation-results.ts';
import { DelegationStorage } from './delegation-storage.ts';
import { generateReadableId } from './ids.ts';
import type { Logger } from './logger.ts';
import { generateMetadata } from './metadata.ts';
import { MAX_RUN_TIME_MS } from './types.ts';
import type { DelegateInput, Delegation, DelegationListItem, OpencodeClient } from './types.ts';

interface AgentSummary {
  name: string;
  description?: string;
  mode?: string;
}

type SessionPromptInput = Parameters<OpencodeClient['session']['prompt']>[0];

export class DelegationManager {
  private delegations: Map<string, Delegation> = new Map();
  private client: OpencodeClient;
  private baseDir: string;
  private log: Logger;
  private storage: DelegationStorage;
  private notificationTracker = new PendingDelegationNotifications();

  constructor(client: OpencodeClient, baseDir: string, log: Logger) {
    this.client = client;
    this.baseDir = baseDir;
    this.log = log;
    this.storage = new DelegationStorage(baseDir, (sessionID) => this.getRootSessionID(sessionID));
  }

  /**
   * Resolves the root session ID by walking up the parent chain.
   */
  async getRootSessionID(sessionID: string): Promise<string> {
    let currentID = sessionID;
    // Prevent infinite loops with max depth
    for (let depth = 0; depth < 10; depth++) {
      try {
        const session = await this.client.session.get({
          path: { id: currentID },
        });

        if (!session.data?.parentID) {
          return currentID;
        }

        currentID = session.data.parentID;
      } catch {
        // If we can't fetch the session, assume current is root or best effort
        return currentID;
      }
    }
    return currentID;
  }

  private assertValidDelegationId(id: string): void {
    this.storage.assertValidDelegationId(id);
  }

  private async delegationBelongsToRoot(delegation: Delegation, requestedRootID: string): Promise<boolean> {
    return (await this.getRootSessionID(delegation.parentSessionID)) === requestedRootID;
  }

  /**
   * Ensure the delegations directory exists
   */
  private async ensureDelegationsDir(sessionID: string): Promise<string> {
    return await this.storage.ensureDelegationsDir(sessionID);
  }

  private async validateStorageRoot(sessionID: string): Promise<void> {
    await this.storage.validateSessionRoot(sessionID);
  }

  /**
   * Delegate a task to an agent
   */
  async delegate(input: DelegateInput): Promise<Delegation> {
    this.assertValidDelegationParentInput(input.parentSessionID);
    await this.assertAgentExists(input.agent);
    await this.validateStorageRoot(input.parentSessionID);

    const delegationId = await this.generateUniqueDelegationId();

    // NOTE: Read-only restriction removed — any sub-agent can use delegate.
    // Background delegations run in isolated sessions outside OpenCode's session tree.
    // The undo/branching system cannot track changes made in background sessions.
    // This is an accepted tradeoff for the ability to run sub-agents in parallel.

    const sessionID = await this.createDelegationSession(delegationId, input.parentSessionID);
    const delegation = this.buildDelegation(input, delegationId, sessionID);
    const promptInput = await this.buildDelegationPromptInput(delegation);

    await this.registerDelegation(delegation);
    this.scheduleDelegationTimeout(delegation.id);
    this.startDelegationPrompt(delegation, promptInput);

    return delegation;
  }

  private assertValidDelegationParentInput(parentSessionID: string): void {
    this.storage.assertValidSessionId(parentSessionID);
  }

  private async generateUniqueDelegationId(): Promise<string> {
    const id = generateReadableId();
    await this.debugLog(`delegate() called, generated ID: ${id}`);

    let finalId = id;
    let attempts = 0;
    while (this.delegations.has(finalId) && attempts < 10) {
      finalId = generateReadableId();
      attempts++;
    }

    if (this.delegations.has(finalId)) {
      throw new Error('Failed to generate unique delegation ID after 10 attempts');
    }

    return finalId;
  }

  private async assertAgentExists(agentName: string): Promise<void> {
    const agentsResult = await this.client.app.agents({});
    const agents = (agentsResult.data ?? []) as AgentSummary[];

    if (agents.find((agent) => agent.name === agentName)) return;

    const available = this.formatAvailableAgents(agents);
    throw new Error(`Agent "${agentName}" not found.\n\nAvailable agents:\n${available || '(none)'}`);
  }

  private formatAvailableAgents(agents: AgentSummary[]): string {
    return agents
      .filter((agent) => agent.mode === 'subagent' || agent.mode === 'all' || !agent.mode)
      .map((agent) => `• ${agent.name}${agent.description ? ` - ${agent.description}` : ''}`)
      .join('\n');
  }

  private async createDelegationSession(delegationId: string, parentSessionID: string): Promise<string> {
    const sessionResult = await this.client.session.create({
      body: {
        title: `Delegation: ${delegationId}`,
        parentID: parentSessionID,
      },
    });

    await this.debugLog(`session.create result: ${JSON.stringify(sessionResult.data)}`);

    if (!sessionResult.data?.id) {
      throw new Error('Failed to create delegation session');
    }

    return sessionResult.data.id;
  }

  private buildDelegation(input: DelegateInput, delegationId: string, sessionID: string): Delegation {
    return {
      id: delegationId,
      sessionID,
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      prompt: input.prompt,
      agent: input.agent,
      status: 'running',
      startedAt: new Date(),
      progress: {
        toolCalls: 0,
        lastUpdate: new Date(),
      },
    };
  }

  private async registerDelegation(delegation: Delegation): Promise<void> {
    await this.debugLog(`Created delegation ${delegation.id}`);
    this.delegations.set(delegation.id, delegation);

    const pendingCount = this.notificationTracker.track(delegation.parentSessionID, delegation.id);
    await this.debugLog(
      `Tracking delegation ${delegation.id} for parent ${delegation.parentSessionID}. Pending count: ${pendingCount}`,
    );

    await this.debugLog(
      `Delegation added to map. Current delegations: ${Array.from(this.delegations.keys()).join(', ')}`,
    );
  }

  private scheduleDelegationTimeout(delegationId: string): void {
    setTimeout(() => {
      const current = this.delegations.get(delegationId);
      if (current && current.status === 'running') {
        void this.handleTimeout(delegationId);
      }
    }, MAX_RUN_TIME_MS + 5000);
  }

  private async buildDelegationPromptInput(delegation: Delegation): Promise<SessionPromptInput> {
    await this.ensureDelegationsDir(delegation.parentSessionID);

    const agentModel = await resolveAgentModel(this.client, delegation.agent, this.log);

    return {
      path: { id: delegation.sessionID },
      body: {
        agent: delegation.agent,
        ...(agentModel && { model: { providerID: agentModel.providerID, modelID: agentModel.modelID } }),
        ...(agentModel?.variant && { variant: agentModel.variant }),
        parts: [{ type: 'text', text: delegation.prompt }],
        tools: {
          task: false,
          delegate: false,
          todowrite: false,
          plan_save: false,
        },
      },
    };
  }

  private startDelegationPrompt(delegation: Delegation, promptInput: SessionPromptInput): void {
    void this.client.session.prompt(promptInput).catch((error: Error) => {
      void this.handlePromptError(delegation, error);
    });
  }

  private async handlePromptError(delegation: Delegation, error: Error): Promise<void> {
    delegation.status = 'error';
    delegation.error = error.message;
    delegation.completedAt = new Date();
    await this.persistOutput(delegation, `Error: ${error.message}`);
    await this.notifyParent(delegation);
  }

  /**
   * Handle delegation timeout
   */
  private async handleTimeout(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation || delegation.status !== 'running') return;

    await this.debugLog(`handleTimeout for delegation ${delegation.id}`);

    delegation.status = 'timeout';
    delegation.completedAt = new Date();
    delegation.error = `Delegation timed out after ${MAX_RUN_TIME_MS / 1000}s`;

    // Try to cancel the session
    try {
      await this.client.session.delete({
        path: { id: delegation.sessionID },
      });
    } catch {
      // Ignore
    }

    // Get whatever result was produced so far
    const result = await this.getResult(delegation);
    await this.persistOutput(delegation, `${result}\n\n[TIMEOUT REACHED]`);

    // Notify parent session
    await this.notifyParent(delegation);
  }

  /**
   * Wait for a delegation to complete (polling)
   */
  private async waitForCompletion(delegationId: string): Promise<void> {
    const pollInterval = 1000;
    const startTime = Date.now();

    const delegation = this.delegations.get(delegationId);
    if (!delegation) return;

    while (
      delegation.status === 'running' &&
      Date.now() - startTime < MAX_RUN_TIME_MS + 10000 // Slightly more than global limit
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Handle session.idle event - called when a session becomes idle
   */
  async handleSessionIdle(sessionID: string): Promise<void> {
    const delegation = this.findBySession(sessionID);
    if (!delegation || delegation.status !== 'running') return;

    await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`);

    delegation.status = 'complete';
    delegation.completedAt = new Date();

    // Get the result
    const result = await this.getResult(delegation);
    delegation.result = result;

    // Generate title and description using small model
    const metadata = await generateMetadata(this.client, result, delegation.sessionID, (msg) => this.debugLog(msg));
    delegation.title = metadata.title;
    delegation.description = metadata.description;

    // Persist output with generated metadata
    await this.persistOutput(delegation, result);

    // Notify parent session
    await this.notifyParent(delegation);
  }

  /**
   * Get the result from a delegation's session
   */
  private async getResult(delegation: Delegation): Promise<string> {
    return await getDelegationResult(this.client, delegation, (message) => this.debugLog(message));
  }

  /**
   * Persist delegation output to storage
   */
  private async persistOutput(delegation: Delegation, content: string): Promise<void> {
    try {
      const filePath = await this.storage.persistOutput(delegation, content);
      await this.debugLog(`Persisted output to ${filePath}`);
    } catch (error) {
      await this.debugLog(`Failed to persist output: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Notify parent session that delegation is complete.
   * Uses batching: individual notifications are silent (noReply: true),
   * but when ALL delegations for a parent session complete, triggers a response.
   */
  private async notifyParent(delegation: Delegation): Promise<void> {
    try {
      const completionState = this.notificationTracker.complete(delegation.parentSessionID, delegation.id);
      await dispatchDelegationNotifications(this.client, delegation, completionState.allComplete);

      await this.debugLog(
        `Notified parent session ${delegation.parentSessionID} (allComplete=${completionState.allComplete}, remaining=${completionState.remaining})`,
      );
    } catch (error) {
      await this.debugLog(`Failed to notify parent: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Read a delegation's output by ID. Blocks if the delegation is still running.
   */
  async readOutput(sessionID: string, id: string): Promise<string> {
    this.assertValidDelegationId(id);

    const persistedOutput = await this.storage.readOutput(sessionID, id);
    if (persistedOutput !== undefined) return persistedOutput;

    const requestedRootID = await this.getRootSessionID(sessionID);

    // Check if it's currently running in memory for the requested session root.
    const delegation = this.delegations.get(id);
    if (delegation && (await this.delegationBelongsToRoot(delegation, requestedRootID))) {
      if (delegation.status === 'running') {
        await this.debugLog(`readOutput: waiting for delegation ${delegation.id} to complete`);
        await this.waitForCompletion(delegation.id);

        // Re-check after waiting
        const completedOutput = await this.storage.readOutput(sessionID, id);
        if (completedOutput !== undefined) return completedOutput;

        // If still no file after waiting (e.g. error/timeout/cancel)
        const updated = this.delegations.get(id);
        if (updated && updated.status !== 'running') {
          const title = updated.title || updated.id;
          return `Delegation "${title}" ended with status: ${updated.status}. ${updated.error || ''}`;
        }
      }
    }

    throw new Error(`Delegation "${id}" not found.\n\nUse delegation_list() to see available delegations.`);
  }

  /**
   * List all delegations for a session
   */
  async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
    const results: DelegationListItem[] = [];
    const requestedRootID = await this.getRootSessionID(sessionID);

    // Add in-memory delegations that match this session root.
    for (const delegation of this.delegations.values()) {
      if (!(await this.delegationBelongsToRoot(delegation, requestedRootID))) continue;

      results.push({
        id: delegation.id,
        status: delegation.status,
        title: delegation.title || '(generating...)',
        description: delegation.description || '(generating...)',
      });
    }

    for (const persistedDelegation of await this.storage.listPersistedDelegations(sessionID)) {
      // Deduplicate: prioritize in-memory status
      if (!results.find((result) => result.id === persistedDelegation.id)) {
        results.push(persistedDelegation);
      }
    }

    return results;
  }

  /**
   * Delete a delegation by id (cancels if running, removes from storage)
   * Used internally for cleanup (timeout, etc.)
   */
  async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
    this.assertValidDelegationId(id);
    const requestedRootID = await this.getRootSessionID(sessionID);

    // Find delegation by id
    let delegationId: string | undefined;
    for (const [dId, d] of this.delegations) {
      if (d.id === id && (await this.delegationBelongsToRoot(d, requestedRootID))) {
        delegationId = dId;
        break;
      }
    }

    if (delegationId) {
      const delegation = this.delegations.get(delegationId);
      if (delegation?.status === 'running') {
        try {
          await this.client.session.delete({
            path: { id: delegation.sessionID },
          });
        } catch {
          // Session may already be deleted
        }
        delegation.status = 'cancelled';
        delegation.completedAt = new Date();
      }
      if (delegation) {
        this.notificationTracker.remove(delegation.parentSessionID, delegation.id);
      }
      this.delegations.delete(delegationId);
    }

    return await this.storage.deleteOutput(sessionID, id);
  }

  /**
   * Find a delegation by its session ID
   */
  findBySession(sessionID: string): Delegation | undefined {
    return Array.from(this.delegations.values()).find((d) => d.sessionID === sessionID);
  }

  /**
   * Handle message events for progress tracking
   */
  handleMessageEvent(sessionID: string, messageText?: string): void {
    const delegation = this.findBySession(sessionID);
    if (!delegation || delegation.status !== 'running') return;

    delegation.progress.lastUpdate = new Date();
    if (messageText) {
      delegation.progress.lastMessage = messageText;
      delegation.progress.lastMessageAt = new Date();
    }
  }

  /**
   * Get count of pending delegations for a parent session
   */
  getPendingCount(parentSessionID: string): number {
    return this.notificationTracker.count(parentSessionID);
  }

  getPendingParentCount(): number {
    return this.notificationTracker.totalParents();
  }

  /**
   * Get all currently running delegations (in-memory only)
   */
  getRunningDelegations(): Delegation[] {
    return Array.from(this.delegations.values()).filter((d) => d.status === 'running');
  }

  async getRunningDelegationsForSession(sessionID: string): Promise<Delegation[]> {
    const requestedRootID = await this.getRootSessionID(sessionID);
    const runningDelegations: Delegation[] = [];

    for (const delegation of this.getRunningDelegations()) {
      if (await this.delegationBelongsToRoot(delegation, requestedRootID)) {
        runningDelegations.push(delegation);
      }
    }

    return runningDelegations;
  }

  /**
   * Get recent completed delegations for compaction injection
   */
  async getRecentCompletedDelegations(sessionID: string, limit: number = 10): Promise<DelegationListItem[]> {
    const all = await this.listDelegations(sessionID);
    return all.filter((d) => d.status !== 'running').slice(-limit);
  }

  /**
   * Log debug messages
   */
  async debugLog(msg: string): Promise<void> {
    // Only log if debug is enabled (could be env var or static const)
    // For now, mirroring previous behavior but writing to the new baseDir/debug.log
    const timestamp = new Date().toISOString();
    const line = `${timestamp}: ${msg}\n`;
    const debugFile = path.join(this.baseDir, 'background-agents-debug.log');

    try {
      await fs.appendFile(debugFile, line, 'utf8');
    } catch {
      // Ignore errors, try to ensure dir once if it fails?
      // Simpler to just ignore for debug logs
    }
  }
}
