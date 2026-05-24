/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";

type CachePluginOptions = {
  compact?: boolean;
};

// Cache sidebar plugin for OpenCode TUI.
// Shows hit ratio, tokens saved by reads, input/output totals,
// and cache writes (when the provider reports them).
// --- number formatting helpers ---
const fmt = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1_000) + "K";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
};

const detailLine = (text: string): string => `  ${text}`;

// Coerce unknown to a finite number, defaulting to 0.
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

// Clamp ratio to [0,1] and show as integer percentage.
const pct = (ratio: number): string =>
  Math.round(Math.max(0, Math.min(1, ratio)) * 100) + "%";

// --- View: renders cache stats in the sidebar ---
const View = (props: {
  hasData: () => boolean;
  ratio: () => number;
  read: () => number;
  write: () => number;
  input: () => number;
  output: () => number;
  compact: boolean;
  api: TuiPluginApi;
}) => {
  const theme = () => props.api.theme.current;
  const compactPrimaryLine = () =>
    `Hit ${pct(props.ratio())} · Save ${fmt(props.read())}`;
  const trafficLines = () => {
    const lines = [
      `Input ${fmt(props.input())}`,
      `Output ${fmt(props.output())}`,
    ];
    if (props.write() > 0) lines.push(`Write ${fmt(props.write())}`);
    return lines;
  };
  return (
    <box gap={0}>
      <text fg={theme().text}>Cache</text>
      {/* "No data" while no provider has reported cache info */}
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
                Usage
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {detailLine(compactPrimaryLine())}
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                Traffic
              </text>
              {trafficLines().map((line) => (
                <text fg={theme().textMuted} wrapMode="none">
                  {detailLine(line)}
                </text>
              ))}
            </>
          }
        >
          <text fg={theme().textMuted} wrapMode="none">
            {compactPrimaryLine()}
          </text>
          {trafficLines().map((line) => (
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
  id: "cache",

  // --- tui() lifecycle: signals, events, refresh ---
  tui: async (api, options) => {
    const { slots, event: evt, lifecycle } = api;
    const compact =
      (options as CachePluginOptions | undefined)?.compact ?? true;
    const [hasData, setHasData] = createSignal(false);
    const [ratio, setRatio] = createSignal(0);
    const [read, setRead] = createSignal(0);
    const [write, setWrite] = createSignal(0);
    const [output, setOutput] = createSignal(0);
    const [inp, setInp] = createSignal(0);
    let disposed = false;
    let currentSessionId = "";
    let retryTimer: any = null;
    let inFlightVersion = 0;
    // Refresh immediately on session switch; re-accumulate on session idle
    const IMMEDIATE_REFRESH_EVENTS = ["tui.session.select"];
    const COMPLETION_REFRESH_EVENTS = ["session.idle"];

    // --- refresh(): accumulate tokens across all messages ---
    const refresh = (sessionId?: string) => {
      if (disposed) return;

      const sid = sessionId || currentSessionId;
      if (!sid) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        return;
      }

      // Fetch every message in the current session
      const currentVersion = ++inFlightVersion;
      const msgs = api.state.session.messages(sid);
      // Discard stale responses from earlier concurrent calls
      if (currentVersion !== inFlightVersion) return;

      let inpAcc = 0;
      let outAcc = 0;
      let r = 0;
      let w = 0;

      // Sum cache and token metrics across assistant messages
      for (const msg of msgs) {
        if (msg.role !== "assistant") continue;
        inpAcc += num(msg.tokens?.input);
        outAcc += num(msg.tokens?.output);
        r += num(msg.tokens?.cache?.read);
        w += num(msg.tokens?.cache?.write);
      }

      // Fallback: step-finish parts may carry cache.write that message.tokens lacks.
      // Some providers report write tokens only on the final streaming part, not on
      // the aggregated message object. This loop catches that edge case.
      if (w === 0 && r > 0) {
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue;
          for (const part of api.state.part(msg.id)) {
            if ((part as any).tokens?.cache?.write) {
              w += num((part as any).tokens.cache.write);
            }
          }
        }
      }
      // No cache data at all: keep the plugin invisible
      if (r === 0 && w === 0) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        setInp(0);
        setOutput(0);
        // Retry when TUI loads messages into memory
        if (!retryTimer && msgs.length === 0) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!disposed) refresh(sid);
          }, 1500);
        }
        return;
      }

      // Ratio = r / (r + input): what fraction of total input was served from cache
      const ratioVal = r + inpAcc > 0 ? r / (r + inpAcc) : 0;

      setHasData(true);
      setRatio(ratioVal);
      setRead(r);
      setWrite(w);
      setInp(inpAcc);
      setOutput(outAcc);
    };

    // --- subscribe to events that trigger refresh ---
    const unsubs: (() => void)[] = [];
    for (const eventName of [
      ...IMMEDIATE_REFRESH_EVENTS,
      ...COMPLETION_REFRESH_EVENTS,
    ]) {
      unsubs.push(
        evt.on(eventName as any, (event: any) => {
          const props = event.properties || event;
          const sid = props.sessionID || currentSessionId;
          if (sid) refresh(sid);
        }),
      );
    }

    lifecycle.onDispose(() => {
      disposed = true;
      clearTimeout(retryTimer);
      for (const fn of unsubs) fn();
    });

    // --- register sidebar slot ---
    // order: 140 places this plugin mid-list in the sidebar
    slots.register({
      order: 140,
      slots: {
        sidebar_content: (_ctx: any, slotInput: any) => {
          const sid: string = slotInput?.session_id ?? "";
          if (sid && sid !== currentSessionId) {
            clearTimeout(retryTimer);
            retryTimer = null;
            currentSessionId = sid;
            refresh(sid);
          } else if (sid && !hasData()) {
            refresh(sid);
          }
          return (
            <View
              hasData={hasData}
              ratio={ratio}
              read={read}
              write={write}
              input={inp}
              output={output}
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
