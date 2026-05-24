/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";

type LimitsPluginOptions = {
  compact?: boolean;
};

// --- number formatting ---
const fmt = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1_000) + "K";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
};

const detailLine = (text: string): string => `  ${text}`;

// --- extract model info from the last message that carries it ---
const getModelFromMessages = (
  msgs: readonly any[],
): { modelId: string; providerId: string } | null => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === "user" && msg.model?.modelID && msg.model?.providerID)
      return { modelId: msg.model.modelID, providerId: msg.model.providerID };
    if (msg.role === "assistant" && msg.modelID && msg.providerID)
      return { modelId: msg.modelID, providerId: msg.providerID };
  }
  return null;
};

// --- look up model definition in the provider registry ---
const resolveModel = (
  providerId: string,
  modelId: string,
  providers: readonly any[],
): { name?: string; context?: number; output?: number } => {
  for (const p of providers) {
    if (p.id === providerId) {
      const m = p.models?.[modelId];
      if (m)
        return {
          name: m.name,
          context: m.limit?.context,
          output: m.limit?.output,
        };
    }
  }
  return {};
};

// --- View ---
const View = (props: {
  modelLabel: () => string;
  contextLimit: () => number;
  outputLimit: () => number;
  hasData: () => boolean;
  compact: boolean;
  api: TuiPluginApi;
}) => {
  const theme = () => props.api.theme.current;
  const limitLines = () => {
    const lines: string[] = [];
    if (props.contextLimit() > 0) {
      lines.push(`Context ${fmt(props.contextLimit())}`);
    }
    if (props.outputLimit() > 0) {
      lines.push(`Output ${fmt(props.outputLimit())}`);
    }
    return lines;
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
        <Show
          when={props.compact}
          fallback={
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
          }
        >
          <text fg={theme().textMuted} wrapMode="none">
            {props.modelLabel()}
          </text>
          {limitLines().map((line) => (
            <text fg={theme().textMuted} wrapMode="none">
              {line}
            </text>
          ))}
        </Show>
      </Show>
    </box>
  );
};

// --- plugin definition ---
const plugin: TuiPluginModule & { id: string } = {
  id: "limits",

  // --- tui() lifecycle ---
  tui: async (api, options) => {
    const { slots, event: evt, lifecycle } = api;
    const compact =
      (options as LimitsPluginOptions | undefined)?.compact ?? true;
    const [modelLabel, setModelLabel] = createSignal("");
    const [contextLimit, setContextLimit] = createSignal(0);
    const [outputLimit, setOutputLimit] = createSignal(0);
    const [hasData, setHasData] = createSignal(false);
    let disposed = false;
    let currentSessionId = "";
    let resolvedSessionId = "";
    let retryTimer: any = null;
    let inFlightVersion = 0;

    const REFRESH_EVENTS = ["tui.session.select", "session.idle"] as const;

    // --- apply a (providerId, modelId) pair ---
    const applyModel = (providerId: string, modelId: string) => {
      const resolved = resolveModel(providerId, modelId, api.state.provider);
      setModelLabel(resolved.name || modelId);
      if (resolved.context) setContextLimit(resolved.context);
      if (resolved.output) setOutputLimit(resolved.output);
      setHasData(true);
      resolvedSessionId = currentSessionId;
    };

    // --- refresh: discover model for current session ---
    const refresh = async (sessionId?: string) => {
      if (disposed) return;

      const sid = sessionId || currentSessionId;
      if (!sid) {
        setHasData(false);
        return;
      }
      const currentVersion = ++inFlightVersion;

      // Keep currentSessionId in sync so applyModel binds correctly
      currentSessionId = sid;

      // If model already resolved for this session, we're done
      if (modelLabel() && contextLimit() > 0 && resolvedSessionId === sid) {
        setHasData(true);
        return;
      }

      // Try to discover model from loaded messages
      const msgs = api.state.session.messages(sid) as any[];
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
        for (const p of api.state.provider) {
          if (p.models?.[configModel]) {
            applyModel(p.id, configModel);
            return;
          }
        }
        setModelLabel(configModel);
        setHasData(true);
        resolvedSessionId = sid;
        return;
      }

      // 3. Last resort: show modelID from last message
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === "user" && m.model?.modelID) {
          setModelLabel(m.model.modelID);
          setHasData(true);
          resolvedSessionId = sid;
          return;
        }
        if (m.role === "assistant" && m.modelID) {
          setModelLabel(m.modelID);
          setHasData(true);
          resolvedSessionId = sid;
          return;
        }
      }

      // No data yet — retry when TUI loads messages
      if (msgs.length === 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!disposed) refresh(sid);
        }, 1500);
      }
    };

    const unsubModelSwitch = evt.on(
      "session.next.model.switched" as any,
      (event: any) => {
        const props = event.properties || event;
        const m = props.model;
        const sid = props.sessionID || currentSessionId;
        if (m?.id && m?.providerID) {
          currentSessionId = sid;
          applyModel(m.providerID, m.id);
          if (sid) refresh(sid).catch(() => {});
        }
      },
    );

    const unsubs: (() => void)[] = [unsubModelSwitch];
    const onRefresh = (event: any) => {
      const props = event.properties || event;
      const sid = props.sessionID || currentSessionId;
      if (sid) refresh(sid).catch(() => {});
    };
    for (const eventName of REFRESH_EVENTS) {
      unsubs.push(evt.on(eventName as any, onRefresh));
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
        sidebar_content: (_ctx: any, slotInput: any) => {
          const sid: string = slotInput?.session_id ?? "";
          if (sid && sid !== currentSessionId) {
            clearTimeout(retryTimer);
            retryTimer = null;
            currentSessionId = sid;
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
              compact={compact}
              api={api}
            />
          );
        },
      },
    });
  },
};

export default plugin;
