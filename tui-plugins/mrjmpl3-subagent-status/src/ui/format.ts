import type { SubagentChild } from '../domain/types.ts';

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

function formatCompactPercentUsed(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
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

export function statusColor(status: SubagentChild['status']): NonNullable<SubagentChild['color']> {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  return 'yellow';
}
