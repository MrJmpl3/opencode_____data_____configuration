/// <reference path="./solid-reactive.d.ts" />
/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { Mock } from 'vitest';
import type { Accessor, Setter } from 'solid-js';
// The project resolves `solid-js` to the SSR (server) build, which stubs out
// reactivity. The harness needs real reactive primitives to count renders and
// evaluations, so it imports the isomorphic reactive build directly. This is
// test-only infrastructure; production code keeps importing `solid-js`.
import { createComputed, createRoot, createSignal } from 'solid-js/dist/solid.js';

/**
 * Track function injected into components rendered by `renderWithCount`.
 * Each call creates a Solid signal whose getter increments the harness
 * evaluation counter, so reactive reads are observable in tests.
 */
export type TrackFn = <S>(initial: S) => [Accessor<S>, Setter<S>];

export type RenderHarness<T> = {
  /** Dispose the underlying createRoot, stopping all reactive computations. */
  unmount: () => void;
  /** Number of times the rendering effect has run (initial mount + re-runs). */
  renderCount: () => number;
  /** Total tracked-signal getter reads observed by the harness. */
  signalEvaluations: () => number;
  /** The value returned by the rendered component. */
  result: T;
};

/**
 * Wrap a Solid `createSignal` so every getter read notifies an `onRead`
 * callback. Used to count signal evaluations deterministically.
 */
export const createTrackedSignal = <S,>(
  initial: S,
  onRead: () => void,
): [Accessor<S>, Setter<S>] => {
  const [get, set] = createSignal(initial);
  const trackedGet: Accessor<S> = () => {
    onRead();
    return get();
  };
  return [trackedGet, set];
};

/**
 * Mount a component inside a Solid `createRoot` and count every effect run
 * (render) and every tracked-signal read (evaluation). The component receives
 * a `track` helper that creates tracked signals bound to the evaluation
 * counter, so updates to those signals re-run the effect and bump both
 * counters. `unmount()` disposes the root cleanly (TH-3).
 *
 * The signature enriches the spec's `component: () => T` with a `track`
 * injection so tracked signals can share the harness counter without circular
 * initialization — every acceptance scenario (TH-1..TH-5) is satisfied.
 */
export const renderWithCount = <T,>(
  component: (track: TrackFn) => T,
  _options?: { fakeTimers?: boolean },
): RenderHarness<T> => {
  let evaluations = 0;
  let renders = 0;
  let result: T | undefined;
  let hasResult = false;

  const track: TrackFn = <S,>(initial: S): [Accessor<S>, Setter<S>] =>
    createTrackedSignal(initial, () => {
      evaluations += 1;
    });

  const dispose = createRoot((disposeRoot) => {
    createComputed(() => {
      result = component(track);
      hasResult = true;
      renders += 1;
    });
    return disposeRoot;
  });

  return {
    unmount: dispose,
    renderCount: () => renders,
    signalEvaluations: () => evaluations,
    result: hasResult ? (result as T) : (undefined as unknown as T),
  };
};

/**
 * A captured signal pair from the mocked `solid-js` `createSignal`. The setter
 * is a Vitest mock so call counts are observable.
 */
export type SignalSpy = { get: () => unknown; set: Mock };

/**
 * Runtime harness returned by `mountRuntimeHarness`. Exposes spied setters for
 * `nowMs` (clock) and `lines` (view state) so tests can assert call counts, a
 * `mountSlot` to simulate the host rendering the sidebar slot, and the event
 * bus + disposers for driving the runtime lifecycle.
 */
export type QuotaRuntimeHarness = {
  setNowMs: Mock;
  setLines: Mock;
  getLines: () => unknown;
  mountSlot: (slotInput?: unknown) => unknown;
  events: Map<string, (payload?: unknown) => void>;
  disposers: Array<() => void>;
  flushAsync: () => Promise<void>;
  dispose: () => void;
};

const flushAsyncTasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Register the quota TUI runtime against a stubbed API and return spies for the
 * `nowMs` and `lines` signals. The caller MUST have already called
 * `vi.resetModules()` + `vi.doMock('solid-js', …)` (with a `createSignal` that
 * pushes `{ get, set }` into `signals` as `Mock` setters) + the `@opentui/solid`
 * jsx stubs, then dynamically imported `registerQuotaTui`. The helper only
 * builds the API mock and drives registration — it does NOT mock modules, so
 * relative `vi.doMock` paths stay owned by the test file.
 */
export const mountRuntimeHarness = async (
  registerQuotaTui: (api: TuiPluginApi, options: unknown) => Promise<void>,
  signals: SignalSpy[],
  pluginOptions?: unknown,
): Promise<QuotaRuntimeHarness> => {
  const events = new Map<string, (payload?: unknown) => void>();
  const disposers: Array<() => void> = [];
  const slotRegistrations: Array<{ slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }> = [];

  const api = {
    event: {
      on: (eventName: string, handler: (payload?: unknown) => void) => {
        events.set(eventName, handler);
        return () => events.delete(eventName);
      },
    },
    lifecycle: {
      onDispose: (handler: () => void) => disposers.push(handler),
    },
    slots: {
      register: (registration: {
        slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown };
      }) => slotRegistrations.push(registration),
    },
    theme: { current: { text: 'white', textMuted: 'gray' } },
  } as unknown as TuiPluginApi;

  await registerQuotaTui(api, pluginOptions);
  await flushAsyncTasks();

  const linesSpy = signals[0];
  const nowMsSpy = signals[1];

  return {
    setNowMs: nowMsSpy?.set,
    setLines: linesSpy?.set,
    getLines: () => linesSpy?.get(),
    mountSlot: (slotInput?: unknown) => slotRegistrations[0]?.slots.sidebar_content(undefined, slotInput),
    events,
    disposers,
    flushAsync: flushAsyncTasks,
    dispose: () => disposers.forEach((dispose) => dispose()),
  };
};
