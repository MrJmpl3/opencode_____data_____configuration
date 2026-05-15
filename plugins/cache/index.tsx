/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";

const fmt = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1_000) + "K";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const pct = (ratio: number): string =>
  Math.round(Math.max(0, Math.min(1, ratio)) * 100) + "%";

function View(props: {
  hasData: () => boolean;
  ratio: () => number;
  read: () => number;
  write: () => number;
  api: TuiPluginApi;
}) {
  const theme = () => props.api.theme.current;
  const ratio = () => props.ratio();
  const hitEmoji = () => {
    const r = ratio();
    if (r >= 0.7) return "✅";
    if (r >= 0.4) return "⚠️";
    if (r >= 0.1) return "❌";
    return "💀";
  };
  const hitColor = () => {
    const r = ratio();
    if (r >= 0.7) return theme().success;
    if (r >= 0.4) return theme().warning;
    return theme().error;
  };

  return (
    <box gap={0}>
      <text fg={theme().text}>Cache</text>
      <Show
        when={props.hasData()}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            No data
          </text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme().textMuted }}>Hit  </span>
          <span style={{ fg: hitColor() }}>
            {hitEmoji()}  {pct(ratio())}
          </span>
        </text>
        <text fg={theme().textMuted} wrapMode="none">
          Read  {fmt(props.read())}
        </text>
        <text fg={theme().textMuted} wrapMode="none">
          Write  {fmt(props.write())}
        </text>
      </Show>
    </box>
  );
}

const plugin: TuiPluginModule & { id: string } = {
  id: "cache",

  tui: async (api) => {
    const { slots, event: evt, lifecycle } = api;
    const [hasData, setHasData] = createSignal(false);
    const [ratio, setRatio] = createSignal(0);
    const [read, setRead] = createSignal(0);
    const [write, setWrite] = createSignal(0);
    let disposed = false;
    let currentSessionId = "";

    const IMMEDIATE_REFRESH_EVENTS = ["tui.session.select"];
    const COMPLETION_REFRESH_EVENTS = ["session.idle"];

    function refresh(sessionId?: string) {
      if (disposed) return;

      const sid = sessionId || currentSessionId;
      if (!sid) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        return;
      }

      const msgs = api.state.session.messages(sid);

      let input = 0;
      let r = 0;
      let w = 0;

      for (const msg of msgs) {
        if (msg.role !== "assistant") continue;
        input += num(msg.tokens?.input);
        r += num(msg.tokens?.cache?.read);
        w += num(msg.tokens?.cache?.write);
      }

      if (r === 0 && w === 0) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        return;
      }

      const ratioVal = r + input > 0 ? r / (r + input) : 0;

      setHasData(true);
      setRatio(ratioVal);
      setRead(r);
      setWrite(w);
    }

    const unsubs: (() => void)[] = [];
    for (const eventName of [...IMMEDIATE_REFRESH_EVENTS, ...COMPLETION_REFRESH_EVENTS]) {
      unsubs.push(evt.on(eventName as any, () => refresh()));
    }

    lifecycle.onDispose(() => {
      disposed = true;
      for (const fn of unsubs) fn();
    });

    slots.register({
      order: 140,
      slots: {
        sidebar_content(_ctx: any, input: any) {
          const sid: string = input?.session_id ?? "";
          if (sid && sid !== currentSessionId) {
            currentSessionId = sid;
            refresh(sid);
          }
          return (
            <View
              hasData={hasData}
              ratio={ratio}
              read={read}
              write={write}
              api={api}
            />
          );
        },
      },
    });
  },
};

export default plugin;
