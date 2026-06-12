import type { SubagentChild } from '../domain/types.ts';

import { hasContextUsage, resolveTokenTotal } from '../domain/tokens.ts';

const ELLIPSIS = '…';
const SIDEBAR_CONTENT_MAX = 30;
const SIDEBAR_ROW_PREFIX_MAX = 2;
const SIDEBAR_NAV_HINT_MAX = 2;
const SIDEBAR_META_INDENT_MAX = 2;
const SIDEBAR_AGENT_MAX = 8;
export const formatRelativeRecency = (timestamp: string | undefined, nowMs = Date.now()): string => {
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
};

export const formatDuration = (elapsedMs: number | undefined): string => {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const normalizeLabel = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

export const truncateLabel = (value: string, maxChars: number): string => {
  const normalized = normalizeLabel(value);
  if (maxChars <= 0) return '';
  if (normalized.length <= maxChars) return normalized;
  if (maxChars === 1) return ELLIPSIS;

  return `${normalized.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
};

const formatCompactTokenCount = (total: number): string => {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`;
  return `${Math.round(value)} tok`;
};

const formatSidebarTokenCount = (total: number): string => {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
};

const formatCompactPercentUsed = (percent: number): string => {
  return `${Math.max(0, Math.round(percent))}%`;
};

const formatAgentCompact = (agentName: string | undefined): string => {
  if (!agentName) return '';

  const normalized = normalizeLabel(agentName);
  if (!normalized) return '';

  return `@${truncateLabel(normalized, SIDEBAR_AGENT_MAX)}`;
};

const joinCompactParts = (parts: readonly string[], maxChars: number): string => {
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
};

export const formatTokenCompact = (child: SubagentChild): string => {
  const total = resolveTokenTotal(child.tokens);
  if (typeof total === 'number' && Number.isFinite(total)) {
    return formatCompactTokenCount(total);
  }

  return '';
};

export const formatContextCompact = (child: SubagentChild): string => {
  if (hasContextUsage(child.tokens)) {
    return formatCompactPercentUsed(child.tokens?.contextPercent ?? 0);
  }

  return '';
};

export const formatUsageCompact = (child: SubagentChild): string => {
  return [formatTokenCompact(child), formatContextCompact(child)].filter((part) => part.length > 0).join(' ');
};

const formatSidebarTokenCompact = (child: SubagentChild): string => {
  const total = resolveTokenTotal(child.tokens);
  if (typeof total === 'number' && Number.isFinite(total)) {
    return formatSidebarTokenCount(total);
  }

  return '';
};

const formatSidebarContextCompact = (child: SubagentChild): string => {
  if (hasContextUsage(child.tokens)) {
    return formatCompactPercentUsed(child.tokens?.contextPercent ?? 0);
  }

  return '';
};

const formatSidebarUsageCompact = (child: SubagentChild): string => {
  return [formatSidebarTokenCompact(child), formatSidebarContextCompact(child)]
    .filter((part) => part.length > 0)
    .join(' ');
};

export const formatSidebarCompactCount = (value: number): string => {
  if (!Number.isFinite(value)) return value > 0 ? '999T+' : '0';

  const count = Math.max(0, Math.round(value));
  if (count >= 1_000_000_000_000_000) return '999T+';

  const suffixTiers: readonly [number, string][] = [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'k'],
  ];

  for (const [threshold, suffix] of suffixTiers) {
    if (count < threshold) continue;

    const scaled = count / threshold;
    const compact = scaled >= 100 ? String(Math.floor(scaled)) : scaled.toFixed(1);

    return `${compact}${suffix}`;
  }

  return String(count);
};

export const formatSidebarSectionHeading = (label: string, count: number): string => {
  return truncateLabel(`${label} · ${formatSidebarCompactCount(count)}`, SIDEBAR_CONTENT_MAX);
};

export const formatSidebarTitle = (child: SubagentChild, navigable = false): string => {
  const base = child.summary?.trim() || child.title?.trim() || child.id;
  const maxChars = SIDEBAR_CONTENT_MAX - SIDEBAR_ROW_PREFIX_MAX - (navigable ? SIDEBAR_NAV_HINT_MAX : 0);

  return truncateLabel(base || '', maxChars);
};

export const formatSidebarRunningMeta = (child: SubagentChild): string => {
  return joinCompactParts(
    [formatDuration(child.elapsedMs), formatAgentCompact(child.agentName), formatSidebarUsageCompact(child)],
    SIDEBAR_CONTENT_MAX - SIDEBAR_META_INDENT_MAX,
  );
};

export const formatSidebarTerminalMeta = (child: SubagentChild, nowMs = Date.now()): string => {
  return joinCompactParts(
    [
      formatRelativeRecency(child.endedAt ?? child.updatedAt, nowMs),
      formatSidebarUsageCompact(child),
      formatDuration(child.elapsedMs),
    ],
    SIDEBAR_CONTENT_MAX - SIDEBAR_META_INDENT_MAX,
  );
};

export const formatCount = (value: number): string => {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
};

export const statusColor = (status: SubagentChild['status']): NonNullable<SubagentChild['color']> => {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  if (status === 'stale') return 'red';
  return 'yellow';
};
