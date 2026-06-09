import type { Delegation, OpencodeClient } from './types.ts';

export interface DelegationCompletionState {
  allComplete: boolean;
  remaining: number;
}

export class PendingDelegationNotifications {
  private pendingByParent: Map<string, Set<string>> = new Map();

  track(parentSessionID: string, delegationID: string): number {
    const existing = this.pendingByParent.get(parentSessionID);
    const pendingSet = existing ?? new Set<string>();

    pendingSet.add(delegationID);
    this.pendingByParent.set(parentSessionID, pendingSet);

    return pendingSet.size;
  }

  complete(parentSessionID: string, delegationID: string): DelegationCompletionState {
    const pendingSet = this.pendingByParent.get(parentSessionID);

    if (!pendingSet) {
      return { allComplete: true, remaining: 0 };
    }

    pendingSet.delete(delegationID);

    if (pendingSet.size === 0) {
      this.pendingByParent.delete(parentSessionID);

      return { allComplete: true, remaining: 0 };
    }

    return { allComplete: false, remaining: pendingSet.size };
  }

  remove(parentSessionID: string, delegationID: string): DelegationCompletionState {
    const pendingSet = this.pendingByParent.get(parentSessionID);

    if (!pendingSet) {
      return { allComplete: true, remaining: 0 };
    }

    pendingSet.delete(delegationID);

    if (pendingSet.size === 0) {
      this.pendingByParent.delete(parentSessionID);

      return { allComplete: true, remaining: 0 };
    }

    return { allComplete: false, remaining: pendingSet.size };
  }

  count(parentSessionID: string): number {
    return this.pendingByParent.get(parentSessionID)?.size ?? 0;
  }

  totalParents(): number {
    return this.pendingByParent.size;
  }
}

export function formatCompletionNotification(delegation: Delegation): string {
  const statusText = delegation.status === 'complete' ? 'complete' : delegation.status;

  return `[TASK NOTIFICATION]
ID: ${delegation.id}
Status: ${statusText}
Use delegation_read(id) to retrieve the full result.`;
}

export function formatAllCompleteNotification(): string {
  return `[TASK NOTIFICATION] All delegations complete.`;
}

export async function dispatchDelegationNotifications(
  client: OpencodeClient,
  delegation: Delegation,
  allComplete: boolean,
): Promise<void> {
  await client.session.prompt({
    path: { id: delegation.parentSessionID },
    body: {
      noReply: true,
      agent: delegation.parentAgent,
      parts: [{ type: 'text', text: formatCompletionNotification(delegation) }],
    },
  });

  if (!allComplete) return;

  await client.session.prompt({
    path: { id: delegation.parentSessionID },
    body: {
      noReply: false,
      agent: delegation.parentAgent,
      parts: [{ type: 'text', text: formatAllCompleteNotification() }],
    },
  });
}
