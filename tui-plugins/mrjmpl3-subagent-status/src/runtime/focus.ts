import type { TuiPromptRef } from '@opencode-ai/plugin/tui';

export type SidebarReturnFocusAction = 'none' | 'clear-pending' | 'focus-prompt';

export type PendingSidebarRefocus = {
  parentSessionID: string;
  childSessionID: string;
  childRowID: string;
};

export type PromptRefProp =
  | ((ref: TuiPromptRef | undefined) => void)
  | { current?: TuiPromptRef | undefined }
  | undefined;

const scheduleDeferred = (callback: () => void): void => {
  setTimeout(callback, 0);
};

export function resolveSidebarReturnFocusAction(input: {
  pendingSidebarRefocus?: {
    parentSessionID: string;
    childSessionID: string;
    childRowID: string;
  };
  previousRouteSessionID?: string;
  routeSessionID?: string;
}): SidebarReturnFocusAction {
  const { pendingSidebarRefocus, previousRouteSessionID, routeSessionID } = input;
  if (!pendingSidebarRefocus || previousRouteSessionID === routeSessionID) {
    return 'none';
  }

  if (
    previousRouteSessionID === pendingSidebarRefocus.childSessionID &&
    routeSessionID === pendingSidebarRefocus.parentSessionID
  ) {
    return 'focus-prompt';
  }

  if (routeSessionID === undefined) {
    return 'none';
  }

  if (routeSessionID !== pendingSidebarRefocus.childSessionID) {
    return 'clear-pending';
  }

  return 'none';
}

export function focusPromptWithDeferredRetry(
  tryFocusPrompt: () => boolean,
  schedule: (callback: () => void) => void = scheduleDeferred,
): void {
  schedule(() => {
    if (tryFocusPrompt()) return;
    schedule(() => {
      void tryFocusPrompt();
    });
  });
}

export function createPromptFocusController(
  schedule: (callback: () => void) => void = scheduleDeferred,
) {
  let previousRouteSessionID: string | undefined;
  let pendingSidebarRefocus: PendingSidebarRefocus | undefined;
  let activePromptRef: TuiPromptRef | undefined;

  const composePromptRef = (slotRef: PromptRefProp) => {
    return (ref: TuiPromptRef | undefined): void => {
      activePromptRef = ref;
      if (typeof slotRef === 'function') {
        slotRef(ref);
      } else if (slotRef && 'current' in slotRef) {
        slotRef.current = ref;
      }
    };
  };

  const focusActivePrompt = (): void => {
    focusPromptWithDeferredRetry(
      () => {
        if (!activePromptRef) return false;
        activePromptRef.focus();
        return true;
      },
      schedule,
    );
  };

  const handleRouteChange = (routeSessionID: string | undefined): void => {
    const sidebarReturnAction = resolveSidebarReturnFocusAction({
      pendingSidebarRefocus,
      previousRouteSessionID,
      routeSessionID,
    });

    if (sidebarReturnAction === 'focus-prompt') {
      pendingSidebarRefocus = undefined;
      focusActivePrompt();
    } else if (sidebarReturnAction === 'clear-pending') {
      pendingSidebarRefocus = undefined;
    }

    if (routeSessionID !== undefined) {
      previousRouteSessionID = routeSessionID;
    }
  };

  return {
    composePromptRef,
    handleRouteChange,
    rememberSidebarChildNavigation: (input: PendingSidebarRefocus): void => {
      pendingSidebarRefocus = input;
    },
  };
}
