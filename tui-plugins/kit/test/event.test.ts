import { describe, expect, it } from 'vitest';
import {
  hasOwn,
  eventProperties,
  eventSessionId,
  slotSessionId,
} from '../src/event.js';

describe('hasOwn (E4)', () => {
  it('returns true for own property', () => {
    expect(hasOwn({ x: 1 }, 'x')).toBe(true);
  });

  it('returns false for missing property', () => {
    expect(hasOwn({}, 'x')).toBe(false);
  });

  it('returns false for inherited property', () => {
    expect(hasOwn({}, 'toString')).toBe(false);
  });

  it('returns false when value is not a record', () => {
    expect(hasOwn('x' as unknown as Record<string, unknown>, 'length')).toBe(false);
  });
});

describe('eventProperties (E1)', () => {
  it('returns event.properties if it is a record', () => {
    const event = { properties: { x: 1 } };
    expect(eventProperties(event)).toEqual({ x: 1 });
  });

  it('returns the event itself if no properties field', () => {
    const event = { x: 1 };
    expect(eventProperties(event)).toEqual({ x: 1 });
  });

  it('returns empty object for primitives', () => {
    expect(eventProperties('hello')).toEqual({});
    expect(eventProperties(null)).toEqual({});
    expect(eventProperties(undefined)).toEqual({});
    expect(eventProperties(42)).toEqual({});
  });

  it('returns properties even when event is an array', () => {
    const event = { properties: { sessionID: 'abc' } };
    expect(eventProperties(event)).toEqual({ sessionID: 'abc' });
  });
});

describe('eventSessionId (E2: reads properties.sessionID — capital D)', () => {
  it('reads sessionID from properties', () => {
    const event = { properties: { sessionID: 's1' } };
    expect(eventSessionId(event)).toBe('s1');
  });

  it('returns empty string when sessionID is missing', () => {
    const event = { properties: { x: 1 } };
    expect(eventSessionId(event)).toBe('');
  });

  it('returns custom fallback when sessionID is missing', () => {
    const event = { properties: { x: 1 } };
    expect(eventSessionId(event, 'fallback')).toBe('fallback');
  });

  it('returns fallback when event is not a record', () => {
    expect(eventSessionId(null, 'fallback')).toBe('fallback');
  });

  it('is case-sensitive (sessionID, not sessionId)', () => {
    const event = { properties: { sessionId: 'lower-d' } };
    expect(eventSessionId(event, 'fallback')).toBe('fallback');
  });
});

describe('slotSessionId (E3: reads slotInput.session_id)', () => {
  it('reads session_id from slot input', () => {
    const slotInput = { session_id: 'sl1' };
    expect(slotSessionId(slotInput)).toBe('sl1');
  });

  it('returns empty string when session_id is missing', () => {
    const slotInput = { x: 1 };
    expect(slotSessionId(slotInput)).toBe('');
  });

  it('returns custom fallback when session_id is missing', () => {
    const slotInput = { x: 1 };
    expect(slotSessionId(slotInput, 'fallback')).toBe('fallback');
  });

  it('returns fallback when slotInput is not a record', () => {
    expect(slotSessionId(null, 'fallback')).toBe('fallback');
  });

  it('rejects non-string session_id values', () => {
    expect(slotSessionId({ session_id: 123 }, 'fallback')).toBe('fallback');
  });
});
