import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { isPlainObject as isRecord } from '@mrjmpl3/tui-kit';

type SessionStatusMap = Record<string, unknown>;

export type SessionClientBoundaryApi = {
  client: {
    session?: {
      children?: (input: { sessionID: string; directory: string }) => Promise<unknown>;
      status?: (input: { directory: string }) => Promise<{ data?: unknown } | undefined>;
      messages?: (input: { sessionID: string; directory: string }) => Promise<{ data?: unknown } | undefined>;
    };
  };
  state: {
    path: {
      directory: string;
    };
  };
};

const normalizeStatusMap = (input: unknown): SessionStatusMap => {
  return isRecord(input) ? input : {};
};

const normalizeMessages = (input: unknown): readonly unknown[] => {
  return Array.isArray(input) ? input : [];
};

export const createSessionClientBoundary = (api: SessionClientBoundaryApi) => {
  const directory = api.state.path.directory;
  const sessionClient = api.client.session;

  return {
    listChildren: async (sessionID: string): Promise<unknown> => {
      return sessionClient?.children?.({ sessionID, directory });
    },
    readStatusMap: async (): Promise<SessionStatusMap> => {
      return normalizeStatusMap((await sessionClient?.status?.({ directory }))?.data);
    },
    readMessages: async (sessionID: string): Promise<readonly unknown[]> => {
      return normalizeMessages((await sessionClient?.messages?.({ sessionID, directory }))?.data);
    },
  };
};
