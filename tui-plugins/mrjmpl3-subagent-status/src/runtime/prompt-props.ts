import type { TuiPromptRef } from '@opencode-ai/plugin/tui';

import type { PromptRefProp } from './focus.ts';

export type HomePromptProps = {
  workspaceID?: string;
  workspace_id?: string;
  ref?: PromptRefProp;
  [key: string]: unknown;
};

export type SessionPromptProps = {
  sessionID?: string;
  sessionId?: string;
  session_id?: string;
  right?: unknown;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  on_submit?: () => void;
  ref?: PromptRefProp;
  [key: string]: unknown;
};

export type NormalizedHomePromptProps = Omit<HomePromptProps, 'ref'> & {
  ref?: ComposedPromptRef;
};

export type NormalizedSessionPromptProps = Omit<SessionPromptProps, 'ref'> & {
  ref?: ComposedPromptRef;
};

type ComposedPromptRef = (ref: TuiPromptRef | undefined) => void;
type ComposePromptRef = (slotRef: PromptRefProp) => ComposedPromptRef;

export const normalizeHomePromptProps = (
  props: HomePromptProps,
  composePromptRef: ComposePromptRef,
): NormalizedHomePromptProps => {
  return {
    ...props,
    ...(props.workspaceID === undefined && props.workspace_id !== undefined ? { workspaceID: props.workspace_id } : {}),
    ref: composePromptRef(props.ref),
  };
};

export const normalizeSessionPromptProps = (
  props: SessionPromptProps,
  composePromptRef: ComposePromptRef,
  fallbackRight: unknown,
): NormalizedSessionPromptProps => {
  return {
    ...props,
    ...(props.sessionID === undefined && props.session_id !== undefined ? { sessionID: props.session_id } : {}),
    ...(props.sessionID === undefined && props.sessionId !== undefined ? { sessionID: props.sessionId } : {}),
    ...(props.onSubmit === undefined && props.on_submit !== undefined ? { onSubmit: props.on_submit } : {}),
    right: props.right ?? fallbackRight,
    ref: composePromptRef(props.ref),
  };
};
