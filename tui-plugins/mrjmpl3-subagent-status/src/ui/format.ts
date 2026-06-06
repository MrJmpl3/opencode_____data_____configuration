import type { SubagentChild } from '../domain/types.ts';

const ELLIPSIS = '…';
const SIDEBAR_TITLE_MAX = 28;
const SIDEBAR_RUNNING_META_PRIMARY_MAX = 22;
const SIDEBAR_RUNNING_META_SECONDARY_MAX = 20;
const SIDEBAR_TERMINAL_META_MAX = 20;
const SIDEBAR_AGENT_MAX = 12;

export function formatRelativeRecency(timestamp: string | undefined, nowMs = Date.now()): string {
  if (!timestamp) return '';

  const targetMs = Date.parse(timestamp);
  if (Number.isNaN(targetMs)) return '';

  const diffMs = Math.max(0, nowMs - targetMs);
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 5) return 'now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatDuration(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateLabel(value: string, maxChars: number): string {
  const normalized = normalizeLabel(value);
  if (maxChars <= 0) return '';
  if (normalized.length <= maxChars) return normalized;
  if (maxChars === 1) return ELLIPSIS;

  return `${normalized.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}

function resolveTokenTotal(child: SubagentChild): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === 'number' && Number.isFinite(total)) {
    return total;
  }

  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === 'number' || typeof output === 'number') {
    return (input ?? 0) + (output ?? 0);
  }

  return undefined;
}

function formatCompactTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ctx`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k ctx`;
  return `${Math.round(value)} ctx`;
}

function formatSidebarTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function formatCompactPercentUsed(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
}

function formatAgentCompact(agentName: string | undefined): string {
  if (!agentName) return '';

  const normalized = normalizeLabel(agentName);
  if (!normalized) return '';

  return `@${truncateLabel(normalized, SIDEBAR_AGENT_MAX)}`;
}

function joinCompactParts(parts: readonly string[], maxChars: number): string {
  let result = '';

  for (const part of parts) {
    if (!part) continue;

    const next = result.length > 0 ? `${result} · ${part}` : part;
    if (next.length <= maxChars) {
      result = next;
      continue;
    }

    if (!result) return truncateLabel(part, maxChars);
    break;
  }

  return result;
}

export function formatContextCompact(child: SubagentChild): string {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;

  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);

  if (hasTotal && hasPercent) {
    return `${formatCompactTokenCount(total)} ${formatCompactPercentUsed(percent)}`;
  }

  if (hasTotal) return formatCompactTokenCount(total);
  if (hasPercent) return formatCompactPercentUsed(percent);
  return '';
}

function formatSidebarContextCompact(child: SubagentChild): string {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;

  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);

  if (hasTotal && hasPercent) {
    return `${formatSidebarTokenCount(total)} ${formatCompactPercentUsed(percent)}`;
  }

  if (hasTotal) return formatSidebarTokenCount(total);
  if (hasPercent) return formatCompactPercentUsed(percent);
  return '';
}

export function formatSidebarTitle(child: SubagentChild): string {
  const base = child.summary?.trim() || child.title?.trim() || child.id;
  return truncateLabel(base || '', SIDEBAR_TITLE_MAX);
}

export function formatSidebarRunningMeta(child: SubagentChild): { primary: string; secondary: string } {
  return {
    primary: joinCompactParts(
      [formatDuration(child.elapsedMs), formatAgentCompact(child.agentName)],
      SIDEBAR_RUNNING_META_PRIMARY_MAX,
    ),
    secondary: truncateLabel(formatSidebarContextCompact(child), SIDEBAR_RUNNING_META_SECONDARY_MAX),
  };
}

export function formatSidebarTerminalMeta(child: SubagentChild, nowMs = Date.now()): string {
  return joinCompactParts(
    [formatRelativeRecency(child.endedAt ?? child.updatedAt, nowMs), formatSidebarContextCompact(child), formatDuration(child.elapsedMs)],
    SIDEBAR_TERMINAL_META_MAX,
  );
}

export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

export function statusColor(status: SubagentChild['status']): NonNullable<SubagentChild['color']> {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  return 'yellow';
}
