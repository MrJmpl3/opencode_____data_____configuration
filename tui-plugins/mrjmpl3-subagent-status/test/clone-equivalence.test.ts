import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cloneState } from '@mrjmpl3/tui-kit';
import { createChild, createState } from './fixtures/subagent-state.ts';

/**
 * clone-equivalence test: verifies that cloneState produces the same result
 * as structuredClone for the full SubagentState types from the subagent plugin.
 *
 * This validates the structural compatibility between kit's minimal types
 * and the subagent's full domain types (TypeScript structural typing contract).
 */

describe('cloneState equivalence with structuredClone (full SubagentState types)', () => {
  it('produces same JSON as structuredClone for representative states built with full types', () => {
    // Single child with tokens
    const s1 = createState([
      createChild({ id: 'child-1', title: 'Test', parentID: 'parent-1', tokens: { input: 100, output: 50 } }),
    ]);
    expect(JSON.stringify(cloneState(s1))).toBe(JSON.stringify(structuredClone(s1)));

    // Multiple children, mixed statuses
    const s2 = createState([
      createChild({ id: 'a', title: 'Running', parentID: 'p', status: 'running' }),
      createChild({ id: 'b', title: 'Done', parentID: 'p', status: 'done', endedAt: '2026-06-04T12:00:00.000Z' }),
      createChild({
        id: 'c',
        title: 'Error',
        parentID: 'p',
        status: 'error',
        tokens: { input: 200, output: 100, total: 300 },
      }),
    ]);
    expect(JSON.stringify(cloneState(s2))).toBe(JSON.stringify(structuredClone(s2)));

    // Empty state
    const s3 = createState([]);
    expect(JSON.stringify(cloneState(s3))).toBe(JSON.stringify(structuredClone(s3)));

    // State with recovering flag
    const s4 = { ...createState([]), recovering: true as const };
    expect(JSON.stringify(cloneState(s4))).toBe(JSON.stringify(structuredClone(s4)));
  });

  it('produces same JSON as structuredClone for a state with many children (50)', () => {
    const children = Array.from({ length: 50 }, (_, i) =>
      createChild({
        id: `child-${i}`,
        title: `Child ${i}`,
        parentID: 'parent-ses',
        status: (['running', 'done', 'error', 'stale'] as const)[i % 4],
        tokens: i % 3 === 0 ? undefined : { input: i * 100, output: i * 50 },
      }),
    );

    const state = createState(children, 42);
    const result = JSON.stringify(cloneState(state));
    const expected = JSON.stringify(structuredClone(state));

    expect(result).toBe(expected);
  });

  it('produces same JSON as structuredClone for a state with purged sessions', () => {
    const state = {
      ...createState([createChild({ id: 'a', title: 'A', parentID: 'p', status: 'done' })]),
      purgedSessionIDs: { ses_old1: true as const, ses_old2: true as const },
      totalExecuted: 5,
    };

    expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(structuredClone(state)));
  });

  it('JSON.stringify(cloneState(s)) === JSON.stringify(structuredClone(s)) for 1000 random states', () => {
    // Build random SubagentStates using the real createChild/createState factories
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 10 }),
            title: fc.string({ minLength: 1, maxLength: 20 }),
            parentID: fc.constant('parent-ses'),
            status: fc.constantFrom('running' as const, 'done' as const, 'error' as const, 'stale' as const),
            tokens: fc.option(
              fc.record({
                input: fc.option(fc.integer({ min: 0, max: 100000 }), { nil: undefined }),
                output: fc.option(fc.integer({ min: 0, max: 100000 }), { nil: undefined }),
                total: fc.option(fc.integer({ min: 0, max: 200000 }), { nil: undefined }),
              }),
              { nil: undefined },
            ),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (childrenData) => {
          const children = childrenData.map((d) =>
            createChild({
              id: d.id,
              title: d.title,
              parentID: d.parentID,
              status: d.status,
              tokens: d.tokens as { input?: number; output?: number; total?: number } | undefined,
            }),
          );
          const state = createState(children);
          expect(JSON.stringify(cloneState(state))).toBe(JSON.stringify(structuredClone(state)));
        },
      ),
      { numRuns: 1000 },
    );
  });
});
