/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiSlotContext } from '@opencode-ai/plugin/tui';
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js';

import { registerSubagentCommands } from './commands.ts';
import { createPromptFocusController } from './focus.ts';
import {
  normalizeHomePromptProps,
  normalizeSessionPromptProps,
  type HomePromptProps,
  type SessionPromptProps,
} from './prompt-props.ts';
import { createEmptyState } from '../domain/state.ts';
import type { SubagentState } from '../domain/types.ts';
import { buildTuiSnapshot } from './snapshot.ts';
import { HomeBottomView, SidebarView } from '../ui/view.tsx';
import { normalizeSubagentStatusPluginOptions } from './options.ts';
import { createTuiRuntime } from './tui-runtime.ts';
import { resolveRouteSessionId } from './boundaries/route-params.ts';

export const registerSubagentStatusTui = async (api: TuiPluginApi, options: unknown): Promise<void> => {
  // El contrato del loader expone `options` como unknown; la normalizacion vive
  // en un solo borde para que todo el runtime consuma una forma explicita.
  const resolvedOptions = normalizeSubagentStatusPluginOptions(options);

  createRoot((disposeRoot) => {
    const { slots } = api;
    const [state, setState] = createSignal<SubagentState>(createEmptyState());
    const [sessionId, setSessionId] = createSignal('');
    const [expanded, setExpanded] = createSignal(true);
    const [nowMs, setNowMs] = createSignal(Date.now());
    const snapshot = createMemo(() => buildTuiSnapshot(state(), nowMs()));
    const promptFocusController = createPromptFocusController();

    const runtime = createTuiRuntime(
      api,
      {
        getState: state,
        setState,
        getSessionId: sessionId,
        setSessionId,
        setNowMs,
      },
      resolvedOptions,
    );

    api.lifecycle.onDispose(() => {
      runtime.dispose();
      disposeRoot();
    });

    const disposeCommands = registerSubagentCommands({
      api,
      sectionEnabled: expanded,
      setSectionEnabled: (enabled) => setExpanded(enabled),
    });

    api.lifecycle.onDispose(() => {
      disposeCommands();
    });

    createEffect(() => {
      void api.route.current;
      promptFocusController.handleRouteChange(resolveRouteSessionId(api.route.current));
    });

    slots.register({
      order: 120,
      slots: {
        home_prompt: (_ctx: TuiSlotContext, props: HomePromptProps) => {
          const promptProps = normalizeHomePromptProps(props, promptFocusController.composePromptRef);
          return <api.ui.Prompt {...promptProps} />;
        },
        session_prompt: (_ctx: TuiSlotContext, props: SessionPromptProps) => {
          const nextSessionId = props.sessionID ?? props.session_id ?? props.sessionId;
          const promptProps = normalizeSessionPromptProps(
            props,
            promptFocusController.composePromptRef,
            nextSessionId ? <api.ui.Slot name="session_prompt_right" session_id={nextSessionId} /> : undefined,
          );
          return <api.ui.Prompt {...promptProps} />;
        },
        sidebar_content: (_ctx: unknown, slotInput: unknown) => {
          runtime.refreshFromSlot(slotInput);

          return (
            <SidebarView
              api={api}
              snapshot={snapshot}
              totalExecuted={() => state().totalExecuted}
              expanded={expanded()}
              onToggle={() => setExpanded((value) => !value)}
              onNavigateToChild={promptFocusController.rememberSidebarChildNavigation}
            />
          );
        },
        home_bottom: () => <HomeBottomView api={api} snapshot={snapshot} totalExecuted={() => state().totalExecuted} />,
      },
    });

    void runtime.bootstrap();
  });
};
