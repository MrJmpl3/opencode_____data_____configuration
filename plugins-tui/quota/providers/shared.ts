import { isRecord } from '../../shared/tui.js';

export const getNested = (obj: unknown, path: readonly string[]): unknown => {
  let v: unknown = obj;
  for (const k of path) {
    if (!isRecord(v)) return undefined;
    v = v[k];
  }
  return v;
};

export const findNumber = (data: unknown, paths: readonly (readonly string[])[]): number | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

export const findBoolean = (data: unknown, paths: readonly (readonly string[])[]): boolean | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === 'boolean') return v;
  }
  return undefined;
};

export const findString = (data: unknown, paths: readonly (readonly string[])[]): string | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === 'string') return v;
  }
  return undefined;
};

export const readStringField = (data: Record<string, unknown>, key: string): string | undefined => {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

export const readBooleanField = (data: Record<string, unknown>, key: string): boolean | undefined => {
  const value = data[key];
  return typeof value === 'boolean' ? value : undefined;
};

export const readNumericField = (data: Record<string, unknown>, key: string): number | undefined => {
  const value = data[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const firstDefined = <T>(...values: readonly (T | undefined)[]): T | undefined => {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
};
