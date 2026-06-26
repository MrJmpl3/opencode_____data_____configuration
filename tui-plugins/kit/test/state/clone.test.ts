import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cloneState } from '../../src/state/clone.js';

// Test helpers use broader types for the full SubagentState shape,
// including fields spread by cloneState but not inspected directly.

interface TestSubagentState {
  children: Record<string, TestSubagentChild>;
  countedChildIDs: Record<string, true>;
  purgedSessionIDs?: Record<string, true>;
  totalExecuted?: number;
  updatedAt?: string;
  recovering?: boolean;
  [key: string]: unknown;
}

interface TestSubagentChild {
  id?: string;
  title?: string;
  parentID?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  tokens?: { input?: number; output?: number; total?: number; contextPercent?: number } | undefined;
  [key: string]: unknown;
}

const makeState = (overrides: Partial<TestSubagentState> = {}): TestSubagentState => ({
  children: {},
  countedChildIDs: {},
  purgedSessionIDs: {},
  totalExecuted: 0,
  updatedAt: '2026-06-25T12:00:00.000Z',
  ...overrides,
});

const makeChild = (id: string, overrides: Record<string, unknown> = {}): TestSubagentChild => ({
  id,
  title: `Child ${id}`,
  parentID: 'parent-ses',
  status: 'running',
  startedAt: '2026-06-25T11:00:00.000Z',
  updatedAt: '2026-06-25T11:30:00.000Z',
  ...overrides,
});

// ─── Scenario: Mutating a child in the clone leaves the original unchanged ───

describe('cloneState — isolation', () => {
  it('mutating a child status in the clone does not propagate to the original', () => {
    const original = makeState({
      children: {
        a: makeChild('a', { status: 'running' }),
        b: makeChild('b', { status: 'running' }),
      },
      countedChildIDs: { a: true as const, b: true as const },
    });

    const cloned = cloneState(original);

    // Mutate clone
    cloned.children['a']!.status = 'done';

    // Original must be unchanged
    expect(original.children['a']!.status).toBe('running');
    // Clone reflects mutation
    expect(cloned.children['a']!.status).toBe('done');
    // Both still have child b untouched
    expect(original.children['b']!.status).toBe('running');
    expect(cloned.children['b']!.status).toBe('running');
  });

  it('clone is a different reference from the original', () => {
    const original = makeState();
    const cloned = cloneState(original);

    expect(cloned).not.toBe(original);
    expect(cloned.children).not.toBe(original.children);
  });

  // ─── Scenario: Deep tokens shared between clone and original ───

  it('clone child tokens are a new object, not the same reference', () => {
    const original = makeState({
      children: {
        a: makeChild('a', { tokens: { input: 100, output: 50 } }),
      },
      countedChildIDs: { a: true as const },
    });

    const cloned = cloneState(original);

    expect(cloned.children['a']).not.toBe(original.children['a']);
    expect(cloned.children['a']!.tokens).not.toBe(original.children['a']!.tokens);
    expect(cloned.children['a']!.tokens).toEqual({ input: 100, output: 50 });
  });

  it('child without tokens clones correctly (tokens stay undefined)', () => {
    const original = makeState({
      children: {
        a: makeChild('a'),
      },
      countedChildIDs: { a: true as const },
    });

    const cloned = cloneState(original);

    expect(cloned.children['a']!.tokens).toBeUndefined();
    // Mutate original tokens — clone unaffected
    original.children['a']!.tokens = { input: 999 };
    expect(cloned.children['a']!.tokens).toBeUndefined();
  });

  it('child with only partial tokens (e.g. only input) clones correctly', () => {
    const original = makeState({
      children: {
        a: makeChild('a', { tokens: { input: 42 } }),
      },
      countedChildIDs: { a: true as const },
    });

    const cloned = cloneState(original);

    expect(cloned.children['a']!.tokens).toEqual({ input: 42 });
    expect(cloned.children['a']!.tokens).not.toBe(original.children['a']!.tokens);
    // output should not exist
    expect((cloned.children['a']!.tokens as Record<string, unknown>).output).toBeUndefined();
  });

  it('child with multiple tokens fields (input, output, total, contextPercent) all preserved', () => {
    const original = makeState({
      children: {
        a: makeChild('a', { tokens: { input: 100, output: 50, total: 150, contextPercent: 33 } }),
      },
      countedChildIDs: { a: true as const },
    });

    const cloned = cloneState(original);

    expect(cloned.children['a']!.tokens).toEqual({
      input: 100,
      output: 50,
      total: 150,
      contextPercent: 33,
    });
  });

  // ─── Scenario: CountedChildIDs mutation isolated ───

  it('adding a key to cloned countedChildIDs does not affect original', () => {
    const original = makeState({
      countedChildIDs: { a: true as const },
    });

    const cloned = cloneState(original);

    cloned.countedChildIDs['b'] = true as const;

    expect(original.countedChildIDs).toEqual({ a: true });
    expect('b' in original.countedChildIDs).toBe(false);
    expect(cloned.countedChildIDs).toEqual({ a: true, b: true });
  });

  // ─── Scenario: Empty state clones without error ───

  it('empty state clones without error and is structurally equal', () => {
    const original = makeState();
    const cloned = cloneState(original);

    expect(cloned).not.toBe(original);
    expect(cloned.children).toEqual({});
    expect(cloned.countedChildIDs).toEqual({});
    expect(cloned.totalExecuted).toBe(0);
    expect(cloned.updatedAt).toBe(original.updatedAt);
  });

  it('top-level recovering flag is preserved in clone', () => {
    const original = makeState({ recovering: true });
    const cloned = cloneState(original);

    expect(cloned.recovering).toBe(true);
  });
});

// ─── Scenario: Property-based equivalence ───

describe('cloneState — property-based equivalence', () => {
  // Arbitrary builder for SubagentState
  const arbitrarySubagentState = fc.record({
    children: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 12 }),
        title: fc.string({ minLength: 1, maxLength: 20 }),
        parentID: fc.string({ minLength: 1, maxLength: 12 }),
        status: fc.constantFrom('running' as const, 'done' as const, 'error' as const, 'stale' as const),
        startedAt: fc.constant('2026-06-25T11:00:00.000Z'),
        updatedAt: fc.constant('2026-06-25T11:30:00.000Z'),
        tokens: fc.option(
          fc.record({
            input: fc.option(fc.integer({ min: 0, max: 100000 }), { nil: undefined }),
            output: fc.option(fc.integer({ min: 0, max: 100000 }), { nil: undefined }),
            total: fc.option(fc.integer({ min: 0, max: 200000 }), { nil: undefined }),
            contextPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
          }),
          { nil: undefined },
        ),
      }),
      { maxKeys: 20 },
    ),
    countedChildIDs: fc.constant({}),
    purgedSessionIDs: fc.constant({}),
    totalExecuted: fc.integer({ min: 0, max: 100 }),
    updatedAt: fc.constant('2026-06-25T12:00:00.000Z'),
    recovering: fc.option(fc.constant(true as const), { nil: undefined }),
  });

  it(
    'JSON.stringify(cloneState(s)) === JSON.stringify(structuredClone(s)) for random states',
    { timeout: 15000 },
    () => {
      fc.assert(
        fc.property(arbitrarySubagentState, (state) => {
          const cloneResult = cloneState(state as TestSubagentState);
          const structuredResult = structuredClone(state);

          expect(JSON.stringify(cloneResult)).toBe(JSON.stringify(structuredResult));
        }),
        { numRuns: 1000 },
      );
    },
  );

  it('cloneState produces a structurally-independent copy (mutation check with random states)', () => {
    fc.assert(
      fc.property(arbitrarySubagentState, (state) => {
        const cloned = cloneState(state as TestSubagentState);

        // Mutate a random child status if children exist
        const childIds = Object.keys(cloned.children);
        if (childIds.length > 0) {
          const randomId = childIds[Math.floor(Math.random() * childIds.length)];
          const originalStatus = cloned.children[randomId]!.status;
          cloned.children[randomId]!.status = 'error';
          // cloned reflects change
          expect(cloned.children[randomId]!.status).toBe('error');
          // But re-cloning from original should produce original status
          const recloned = cloneState(state as TestSubagentState);
          expect(recloned.children[randomId]!.status).toBe(originalStatus);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Scenario: State with multiple children round-trips identically ───

describe('cloneState — multi-child round-trip', () => {
  it('50 children of mixed statuses and tokens clone identically', () => {
    const statuses = ['running', 'done', 'error', 'stale'] as const;
    const children: Record<string, Record<string, unknown>> = {};

    for (let i = 0; i < 50; i++) {
      const id = `child-${i}`;
      children[id] = makeChild(id, {
        status: statuses[i % 4],
        tokens: i % 3 === 0 ? undefined : { input: i * 100, output: i * 50, total: i * 150 },
      });
    }

    const original = makeState({ children });
    const cloned = cloneState(original);

    // Structural equality via JSON round-trip
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(original));

    // All children present
    expect(Object.keys(cloned.children)).toHaveLength(50);

    // Each child is a different reference
    for (const id of Object.keys(children)) {
      expect(cloned.children[id]).not.toBe(original.children[id]);
      if (original.children[id]!.tokens) {
        expect(cloned.children[id]!.tokens).not.toBe(original.children[id]!.tokens);
      }
    }
  });

  it('purgedSessionIDs field is preserved via spread (structural sharing — safe)', () => {
    const original = makeState({
      purgedSessionIDs: { ses_dead: true as const, ses_gone: true as const },
    });

    const cloned = cloneState(original);

    expect(cloned.purgedSessionIDs).toEqual({ ses_dead: true, ses_gone: true });
    // purgedSessionIDs is spread (structural sharing per design):
    // mutations only add/delete keys on Record<string, true>, never mutate values
  });

  it('totalExecuted is preserved', () => {
    const original = makeState({ totalExecuted: 42 });
    const cloned = cloneState(original);

    expect(cloned.totalExecuted).toBe(42);
  });
});
