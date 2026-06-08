import { isRecord } from '../runtime/tui.ts';

export type MessageModel = {
  modelId: string;
  providerId?: string;
};

export type ModelLimits = {
  name?: string;
  context: number;
  output: number;
};

export type ProviderModelRecord = {
  name?: unknown;
  limit?: unknown;
};

export type ProviderRecord = {
  id?: unknown;
  models?: unknown;
};

export const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
};

export const readModelRecord = (provider: ProviderRecord, modelId: string): ProviderModelRecord | undefined => {
  if (!isRecord(provider.models)) return undefined;

  const model = provider.models[modelId];

  return isRecord(model) ? model : undefined;
};

const readLimitValue = (model: ProviderModelRecord, key: string): number => {
  if (!isRecord(model.limit)) return 0;

  const value = model.limit[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export const getModelFromMessages = (msgs: readonly unknown[]): MessageModel | null => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!isRecord(msg)) continue;

    if (msg.role === 'user' && isRecord(msg.model)) {
      const modelId = readString(msg.model, 'modelID');
      const providerId = readString(msg.model, 'providerID');
      if (modelId) return { modelId, providerId };
    }

    if (msg.role === 'assistant') {
      const modelId = readString(msg, 'modelID');
      const providerId = readString(msg, 'providerID');
      if (modelId) return { modelId, providerId };
    }
  }
  return null;
};

export const resolveModel = (
  providerId: string,
  modelId: string,
  providers: readonly ProviderRecord[],
): ModelLimits => {
  for (const p of providers) {
    if (p.id === providerId) {
      const m = readModelRecord(p, modelId);
      if (m)
        return {
          name: typeof m.name === 'string' ? m.name : undefined,
          context: readLimitValue(m, 'context'),
          output: readLimitValue(m, 'output'),
        };
    }
  }
  return { context: 0, output: 0 };
};
