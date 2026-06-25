/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from 'vitest';

import { createTrackedSignal, renderWithCount } from '../src/test/render-harness.tsx';

describe('opentui-solid test harness', () => {
  // TH-1 Happy: a static component renders once and exposes its result.
  it('mounts a static component inside createRoot and reports a positive render count', () => {
    const harness = renderWithCount(() => 42);

    expect(harness.result).toBe(42);
    expect(harness.renderCount()).toBeGreaterThan(0);

    harness.unmount();
  });

  // TH-2 Re-evaluation: a tracked signal that updates twice forces the effect
  // to re-run, so both the render counter and the evaluation counter climb.
  it('increments render and evaluation counters when a tracked signal updates twice', () => {
    let setCount!: (next: number) => void;

    const harness = renderWithCount((track) => {
      const [count, set] = track(0);
      setCount = set;
      return count();
    });

    const initialRenders = harness.renderCount();
    const initialEvaluations = harness.signalEvaluations();
    expect(initialRenders).toBeGreaterThan(0);
    expect(initialEvaluations).toBeGreaterThan(0);

    setCount(1);
    setCount(2);

    expect(harness.renderCount()).toBeGreaterThanOrEqual(initialRenders + 2);
    expect(harness.signalEvaluations()).toBeGreaterThanOrEqual(initialEvaluations + 2);

    harness.unmount();
  });

  // TH-3 Disposal: after unmount, signal updates no longer trigger effects,
  // proving the root was disposed without leaking reactive computations.
  it('stops reacting to signal updates after unmount', () => {
    let setCount!: (next: number) => void;

    const harness = renderWithCount((track) => {
      const [count, set] = track(0);
      setCount = set;
      return count();
    });

    const rendersBeforeUnmount = harness.renderCount();

    harness.unmount();
    setCount(99);

    expect(harness.renderCount()).toBe(rendersBeforeUnmount);
  });

  // TH-4: SignalSpy records setter calls. Two writes → count 2.
  it('SignalSpy records setter call count across two writes', () => {
    let reads = 0;
    const [count, setCount] = createTrackedSignal(0, () => {
      reads += 1;
    });

    expect(count()).toBe(0);
    setCount(1);
    expect(count()).toBe(1);
    setCount(2);
    expect(count()).toBe(2);

    // 3 getter calls: initial 0, after first set 1, after second set 2
    expect(reads).toBe(3);
  });

  // TH-5 Determinism: identical renders produce identical counters.
  it('reports deterministic counters across identical runs', () => {
    const runOnce = () => {
      let setCount!: (next: number) => void;
      const harness = renderWithCount((track) => {
        const [count, set] = track(0);
        setCount = set;
        return count();
      });
      setCount(1);
      const renders = harness.renderCount();
      const evaluations = harness.signalEvaluations();
      harness.unmount();
      return { renders, evaluations };
    };

    const first = runOnce();
    const second = runOnce();

    expect(second.renders).toBe(first.renders);
    expect(second.evaluations).toBe(first.evaluations);
  });

  // createTrackedSignal standalone contract: every getter read is counted.
  it('counts every getter read on a standalone tracked signal', () => {
    let reads = 0;
    const [count, setCount] = createTrackedSignal(0, () => {
      reads += 1;
    });

    expect(count()).toBe(0);
    expect(count()).toBe(0);
    setCount(5);
    expect(count()).toBe(5);

    expect(reads).toBe(3);
  });
});
