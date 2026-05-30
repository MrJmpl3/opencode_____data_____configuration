const BAR_WIDTH = 14;

export const progressBar = (pct: number, w: number = BAR_WIDTH): string => {
  const filled = Math.round((Math.min(pct, 100) / 100) * w);
  return '█'.repeat(filled) + '░'.repeat(w - filled);
};

export const fmtDuration = (sec?: number): string => {
  if (!sec || sec <= 0) return '0s';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export const fmtDurationIso = (iso: string): string => {
  if (!iso) return '';
  const diff = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  return fmtDuration(diff);
};
