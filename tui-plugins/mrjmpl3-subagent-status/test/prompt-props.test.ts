import { describe, expect, it, vi } from 'vitest';

import { normalizeHomePromptProps, normalizeSessionPromptProps } from '../src/runtime/prompt-props.ts';

describe('prompt prop normalization', () => {
  it('maps snake_case home props without overriding explicit camelCase values', () => {
    const forwardedRef = vi.fn();
    const composePromptRef = vi.fn((slotRef) => slotRef);

    const promptProps = normalizeHomePromptProps(
      {
        workspaceID: 'workspace-camel',
        workspace_id: 'workspace-snake',
        ref: forwardedRef,
      },
      composePromptRef,
    );

    expect(promptProps.workspaceID).toBe('workspace-camel');
    expect(promptProps.workspace_id).toBe('workspace-snake');
    expect(promptProps.ref).toBe(forwardedRef);
    expect(composePromptRef).toHaveBeenCalledWith(forwardedRef);
  });

  it('maps session snake_case props and preserves explicit right/onSubmit values', () => {
    const explicitOnSubmit = vi.fn();
    const fallbackRight = { slot: 'generated' };
    const forwardedRef = vi.fn();
    const composePromptRef = vi.fn((slotRef) => slotRef);

    const promptProps = normalizeSessionPromptProps(
      {
        sessionID: 'ses_explicit',
        session_id: 'ses_snake',
        onSubmit: explicitOnSubmit,
        on_submit: vi.fn(),
        right: 'custom-right',
        ref: forwardedRef,
      },
      composePromptRef,
      fallbackRight,
    );

    expect(promptProps.sessionID).toBe('ses_explicit');
    expect(promptProps.session_id).toBe('ses_snake');
    expect(promptProps.onSubmit).toBe(explicitOnSubmit);
    expect(promptProps.right).toBe('custom-right');
    expect(promptProps.ref).toBe(forwardedRef);
  });

  it('fills session camelCase props from snake_case values and applies fallback right content', () => {
    const submitFromSnake = vi.fn();
    const composedRef = vi.fn();
    const composePromptRef = vi.fn(() => composedRef);

    const promptProps = normalizeSessionPromptProps(
      {
        session_id: 'ses_child',
        on_submit: submitFromSnake,
      },
      composePromptRef,
      'generated-right',
    );

    expect(promptProps.sessionID).toBe('ses_child');
    expect(promptProps.onSubmit).toBe(submitFromSnake);
    expect(promptProps.right).toBe('generated-right');
    expect(promptProps.ref).toBe(composedRef);
  });

  it('accepts sessionId aliases without breaking prompt normalization', () => {
    const composePromptRef = vi.fn((slotRef) => slotRef);

    const promptProps = normalizeSessionPromptProps(
      {
        sessionId: 'ses_alias',
      },
      composePromptRef,
      'generated-right',
    );

    expect(promptProps.sessionID).toBe('ses_alias');
    expect(promptProps.right).toBe('generated-right');
  });

  it('preserves falsey right values and only falls back for nullish ones', () => {
    const composePromptRef = vi.fn((slotRef) => slotRef);

    expect(normalizeSessionPromptProps({ right: '' }, composePromptRef, 'fallback-right').right).toBe('');
    expect(normalizeSessionPromptProps({ right: false }, composePromptRef, 'fallback-right').right).toBe(false);
    expect(normalizeSessionPromptProps({ right: 0 }, composePromptRef, 'fallback-right').right).toBe(0);
    expect(normalizeSessionPromptProps({ right: undefined }, composePromptRef, 'fallback-right').right).toBe(
      'fallback-right',
    );
    expect(normalizeSessionPromptProps({ right: null }, composePromptRef, 'fallback-right').right).toBe(
      'fallback-right',
    );
  });
});
