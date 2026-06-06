import { describe, expect, it, vi } from 'vitest';

import {
  createPromptFocusController,
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
} from '../src/runtime/focus.ts';

describe('runtime focus helpers', () => {
  it('returns focus-prompt only when navigating back from child to parent', () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus: {
          parentSessionID: 'ses_parent',
          childSessionID: 'ses_child',
          childRowID: 'tool:delegate_1',
        },
        previousRouteSessionID: 'ses_child',
        routeSessionID: 'ses_parent',
      }),
    ).toBe('focus-prompt');
  });

  it('clears pending focus when navigation goes somewhere else', () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus: {
          parentSessionID: 'ses_parent',
          childSessionID: 'ses_child',
          childRowID: 'tool:delegate_1',
        },
        previousRouteSessionID: 'ses_child',
        routeSessionID: 'ses_other',
      }),
    ).toBe('clear-pending');
  });

  it('keeps pending focus across intermediate non-session route transitions', () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus: {
          parentSessionID: 'ses_parent',
          childSessionID: 'ses_child',
          childRowID: 'tool:delegate_1',
        },
        previousRouteSessionID: 'ses_child',
        routeSessionID: undefined,
      }),
    ).toBe('none');
  });

  it('retries focusing the prompt once when the first attempt fails', () => {
    const attempts = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const scheduled: Array<() => void> = [];

    focusPromptWithDeferredRetry(attempts, (callback) => {
      scheduled.push(callback);
    });

    expect(attempts).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it('forwards prompt refs and restores focus when returning from child to parent', () => {
    const scheduled: Array<() => void> = [];
    const controller = createPromptFocusController((callback) => {
      scheduled.push(callback);
    });
    const focus = vi.fn();
    const forwarded = vi.fn();

    controller.composePromptRef(forwarded)({ focus } as never);
    controller.rememberSidebarChildNavigation({
      parentSessionID: 'ses_parent',
      childSessionID: 'ses_child',
      childRowID: 'tool:delegate_1',
    });

    controller.handleRouteChange('ses_child');
    controller.handleRouteChange('ses_parent');

    expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ focus }));
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('forwards object refs and clears pending focus on unrelated navigation', () => {
    const scheduled: Array<() => void> = [];
    const controller = createPromptFocusController((callback) => {
      scheduled.push(callback);
    });
    const objectRef = { current: undefined } as { current?: { focus: () => void } };
    const focus = vi.fn();

    controller.composePromptRef(objectRef as never)({ focus } as never);
    controller.rememberSidebarChildNavigation({
      parentSessionID: 'ses_parent',
      childSessionID: 'ses_child',
      childRowID: 'tool:delegate_1',
    });

    controller.handleRouteChange('ses_child');
    controller.handleRouteChange('ses_other');
    controller.handleRouteChange('ses_parent');

    expect(objectRef.current).toEqual(expect.objectContaining({ focus }));
    expect(scheduled).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
  });
});
