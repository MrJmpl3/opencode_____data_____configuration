/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from 'solid-js';
import type { TuiPluginModule, TuiPluginApi } from '@opencode-ai/plugin/tui';

import { detailLine, eventProperties, eventSessionId, formatCompactNumber, isRecord, slotSessionId } from '../shared/tui.js';

type MessageModel = {
  modelId: string;
  providerId?: string;
};

type ModelLimits = {
  name?: string;
  context: number;
  output: number;
};

type ProviderModelRecord = {
  name?: unknown;
  limit?: unknown;
};

type ProviderRecord = {
  id?: unknown;
  models?: unknown;
};

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
};

const readModelRecord = (provider: ProviderRecord, modelId: string): ProviderModelRecord | undefined => {
  if (!isRecord(provider.models)) return undefined;

  const model = provider.models[modelId];

  return isRecord(model) ? model : undefined;
};

const readLimitValue = (model: ProviderModelRecord, key: string): number => {
  if (!isRecord(model.limit)) return 0;

  const value = model.limit[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

// --- extract model info from the last message that carries it ---
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

// --- look up model definition in the provider registry ---
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

// --- View ---
const View = (props: {
  modelLabel: () => string;
  contextLimit: () => number;
  outputLimit: () => number;
  hasData: () => boolean;
  api: TuiPluginApi;
}) => {
  const theme = () => props.api.theme.current;
  const limitLines = () => {
    const parts: string[] = [];
    if (props.contextLimit() > 0) parts.push(`Context ${formatCompactNumber(props.contextLimit())}`);
    if (props.outputLimit() > 0) parts.push(`Output ${formatCompactNumber(props.outputLimit())}`);
    return parts.length > 0 ? [parts.join(' · ')] : [];
  };
  return (
    <box gap={0}>
      <text fg={theme().text}>Limits</text>
      <Show
        when={props.hasData()}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            No data
          </text>
        }
      >
        <>
          <text fg={theme().textMuted} wrapMode="none">
            Model
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {detailLine(props.modelLabel())}
          </text>
          <Show when={limitLines().length > 0}>
            <text fg={theme().textMuted} wrapMode="none">
              Limits
            </text>
            {limitLines().map((line) => (
              <text fg={theme().textMuted} wrapMode="none">
                {detailLine(line)}
              </text>
            ))}
          </Show>
        </>
      </Show>
    </box>
  );
};

// --- plugin definition ---
const plugin: TuiPluginModule & { id: string } = {
  id: 'limits',

  // --- tui() lifecycle ---
  tui: async (api) => {
    const { slots, event: evt, lifecycle } = api;
    const [modelLabel, setModelLabel] = createSignal('');
    const [contextLimit, setContextLimit] = createSignal(0);
    const [outputLimit, setOutputLimit] = createSignal(0);
    const [hasData, setHasData] = createSignal(false);
    let disposed = false;
    let currentSessionId = '';
    let resolvedSessionId = '';
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlightVersion = 0;

    const REFRESH_EVENTS = ['tui.session.select', 'session.idle'] as const;

    // --- apply a (providerId, modelId) pair ---
    const resetState = () => {
      setModelLabel('');
      setContextLimit(0);
      setOutputLimit(0);
      setHasData(false);
      resolvedSessionId = '';
    };

    const switchSession = (sessionId: string) => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      resetState();
      currentSessionId = sessionId;
    };

    const applyModel = (providerId: string | undefined, modelId: string) => {
      const resolved = providerId ? resolveModel(providerId, modelId, api.state.provider as readonly ProviderRecord[]) : undefined;
      setModelLabel(resolved?.name || modelId);
      setContextLimit(resolved?.context ?? 0);
      setOutputLimit(resolved?.output ?? 0);
      setHasData(true);
      resolvedSessionId = currentSessionId;
    };

    // --- refresh: discover model for current session ---
    const refresh = async (sessionId?: string) => {
      if (disposed) return;

      const sid = sessionId || currentSessionId;
      if (!sid) {
        resetState();
        return;
      }
      const currentVersion = ++inFlightVersion;

      // Keep currentSessionId in sync so applyModel binds correctly
      currentSessionId = sid;

      // If model already resolved for this session, we're done
      if (hasData() && resolvedSessionId === sid) {
        setHasData(true);
        return;
      }

      // Try to discover model from loaded messages
      const msgs = api.state.session.messages(sid) as readonly unknown[];
      if (currentVersion !== inFlightVersion) return;

      // 1. Extract model from messages
      const msgModel = getModelFromMessages(msgs);
      if (msgModel) {
        applyModel(msgModel.providerId, msgModel.modelId);
        return;
      }

      // 2. Fallback: config default model
      const configModel = api.state.config.model;
      if (configModel) {
        for (const p of api.state.provider as readonly ProviderRecord[]) {
          if (readModelRecord(p, configModel)) {
            applyModel(typeof p.id === 'string' ? p.id : undefined, configModel);
            return;
          }
        }
        setModelLabel(configModel);
        setContextLimit(0);
        setOutputLimit(0);
        setHasData(true);
        resolvedSessionId = sid;
        return;
      }

      // 3. Last resort: show modelID from last message
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!isRecord(m)) continue;

        if (m.role === 'user' && isRecord(m.model)) {
          const modelId = readString(m.model, 'modelID');
          if (!modelId) continue;
          setModelLabel(modelId);
          setContextLimit(0);
          setOutputLimit(0);
          setHasData(true);
          resolvedSessionId = sid;
          return;
        }
        if (m.role === 'assistant') {
          const modelId = readString(m, 'modelID');
          if (!modelId) continue;
          setModelLabel(modelId);
          setContextLimit(0);
          setOutputLimit(0);
          setHasData(true);
          resolvedSessionId = sid;
          return;
        }
      }

      // No data yet — retry when TUI loads messages
      if (msgs.length === 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (!disposed) refresh(sid);
        }, 1500);
      }
    };

    const unsubModelSwitch = evt.on('session.next.model.switched' as never, (event: unknown) => {
      const props = eventProperties(event);
      const m = props.model;
      const sid = eventSessionId(event, currentSessionId);
      if (isRecord(m) && typeof m.id === 'string' && typeof m.providerID === 'string') {
        currentSessionId = sid;
        applyModel(m.providerID, m.id);
        if (sid) refresh(sid).catch(() => {});
      }
    });

    const unsubs: (() => void)[] = [unsubModelSwitch];
    const onRefresh = (event: unknown) => {
      const sid = eventSessionId(event, currentSessionId);
      if (sid) refresh(sid).catch(() => {});
    };
    for (const eventName of REFRESH_EVENTS) {
      unsubs.push(evt.on(eventName as never, onRefresh));
    }

    lifecycle.onDispose(() => {
      disposed = true;
      clearTimeout(retryTimer);
      for (const fn of unsubs) fn();
    });

    // --- register sidebar slot ---
    slots.register({
      order: 120,
      slots: {
        sidebar_content: (_ctx: unknown, slotInput: unknown) => {
          const sid = slotSessionId(slotInput);
          if (sid && sid !== currentSessionId) {
            switchSession(sid);
            refresh(sid);
          } else if (sid && !hasData()) {
            refresh(sid).catch(() => {});
          }
          return (
            <View
              modelLabel={modelLabel}
              contextLimit={contextLimit}
              outputLimit={outputLimit}
              hasData={hasData}
              api={api}
            />
          );
        },
      },
    });
  },
};

export default plugin;
