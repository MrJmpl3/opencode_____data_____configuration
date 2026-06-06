import { describe, expect, it } from 'vitest';

import { deriveSessionStatus, deriveTerminalSessionStatus } from '../src/domain/session-status.ts';

describe('session status classification', () => {
  it('classifies structured running, terminal, and errored states consistently', () => {
    expect(deriveSessionStatus({ phase: 'queued' })).toBe('running');
    expect(deriveSessionStatus({ result: 'completed' })).toBe('done');
    expect(deriveSessionStatus({ error: { message: 'boom' } })).toBe('error');
  });

  it('does not treat idle as done', () => {
    expect(deriveSessionStatus('idle')).toBeUndefined();
    expect(deriveSessionStatus({ type: 'idle' })).toBeUndefined();
    expect(deriveTerminalSessionStatus('idle')).toBeUndefined();
  });

  it('derives terminal states without turning idle-like gaps into done', () => {
    expect(deriveTerminalSessionStatus({ status: 'completed' })).toBe('done');
    expect(deriveTerminalSessionStatus({ state: 'error' })).toBe('error');
    expect(deriveTerminalSessionStatus({ type: 'queued' })).toBeUndefined();
  });

  it('normalizes whitespace, casing, and boolean running hints', () => {
    expect(deriveSessionStatus('  Completed  ')).toBe('done');
    expect(deriveSessionStatus({ running: true })).toBe('running');
    expect(deriveSessionStatus({ busy: true, status: ' idle ' })).toBe('running');
  });

  it('keeps error precedence when payloads contain contradictory signals', () => {
    expect(deriveSessionStatus({ status: 'completed', error: { message: 'boom' }, busy: true })).toBe('error');
    expect(deriveTerminalSessionStatus({ phase: 'queued', result: 'complete', error: { message: 'boom' } })).toBe(
      'error',
    );
  });

  it('ignores running-only hints when deriving terminal-only status', () => {
    expect(deriveTerminalSessionStatus({ running: true, phase: 'queued', status: 'idle' })).toBeUndefined();
    expect(deriveTerminalSessionStatus({ busy: true, type: 'running' })).toBeUndefined();
  });
});
