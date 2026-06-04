export type SubagentStatus = 'running' | 'done' | 'error';

export interface SubagentTokens {
  input?: number;
  output?: number;
  total?: number;
  contextPercent?: number;
}

export interface SubagentChild {
  id: string;
  title: string;
  summary?: string;
  agentName?: string;
  parentID: string;
  messageID?: string;
  source?: 'session' | 'subtask' | 'tool';
  targetSessionID?: string;
  status: SubagentStatus;
  color?: 'yellow' | 'green' | 'red';
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  tokens?: SubagentTokens;
}

export interface SubagentCounts {
  running: number;
  done: number;
  error: number;
}

export interface SubagentState {
  children: Record<string, SubagentChild>;
  countedChildIDs: Record<string, true>;
  totalExecuted: number;
  updatedAt: string;
}
