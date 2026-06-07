import type { TuiRouteCurrent } from '@opencode-ai/plugin/tui';
import { describe, expect, it, vi } from 'vitest';

import { normalizeEventPayload } from '../src/runtime/boundaries/event-payload.ts';
import { normalizeSessionRouteParams, resolveRouteSessionId } from '../src/runtime/boundaries/route-params.ts';
import {
  createSessionClientBoundary,
  type SessionClientBoundaryApi,
} from '../src/runtime/boundaries/session-client.ts';
import { normalizeSessionSlotPayload, resolveSlotSessionId } from '../src/runtime/boundaries/slot-payload.ts';

describe('runtime boundary normalizers', () => {
  it('normalizes route params across known and generic route shapes', () => {
    const homeRoute: TuiRouteCurrent = { name: 'home' };
    const genericRoute: TuiRouteCurrent = {
      name: 'custom',
      params: { session_id: 'ses_generic' },
    };

    expect(normalizeSessionRouteParams(homeRoute)).toEqual({});
    expect(resolveRouteSessionId({ name: 'session', params: { sessionID: 'ses_direct' } })).toBe('ses_direct');
    expect(resolveRouteSessionId(genericRoute)).toBe('ses_generic');
  });

  it('normalizes slot payload session identifiers', () => {
    expect(normalizeSessionSlotPayload({ sessionId: 'ses_slot' })).toEqual({ sessionID: 'ses_slot' });
    expect(resolveSlotSessionId({ session_id: 'ses_sidebar' })).toBe('ses_sidebar');
    expect(resolveSlotSessionId(undefined)).toBe('');
  });

  it('normalizes event envelopes and strips malformed nested payloads', () => {
    expect(normalizeEventPayload(undefined)).toBeUndefined();
    expect(
      normalizeEventPayload({
        type: 'session.created',
        properties: {
          info: { id: 'ses_child', time: { created: 1 } },
          part: { type: 'subtask' },
        },
      }),
    ).toMatchObject({
      type: 'session.created',
      properties: {
        info: { id: 'ses_child', time: { created: 1 } },
        part: { type: 'subtask' },
      },
    });
    expect(
      normalizeEventPayload({
        type: 'session.updated',
        properties: { info: 'bad', part: 'bad' },
      }),
    ).toMatchObject({
      properties: {
        info: undefined,
        part: undefined,
      },
    });
  });

  it('normalizes session client reads and hides missing methods behind safe defaults', async () => {
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({ data: [{ id: 'ses_child' }] })),
          status: vi.fn(async () => ({ data: { ses_child: { type: 'running' } } })),
          messages: vi.fn(async () => ({ data: [{ id: 'msg_1' }] })),
        },
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
      },
    } satisfies SessionClientBoundaryApi;

    const sessionClient = createSessionClientBoundary(api);

    await expect(sessionClient.listChildren('ses_parent')).resolves.toEqual({ data: [{ id: 'ses_child' }] });
    await expect(sessionClient.readStatusMap()).resolves.toEqual({ ses_child: { type: 'running' } });
    await expect(sessionClient.readMessages('ses_child')).resolves.toEqual([{ id: 'msg_1' }]);
  });
});
