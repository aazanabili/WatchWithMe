import { describe, expect, it } from 'vitest';
import { conferenceTokenHeaders, livekitErrorReason, livekitUrl, shouldApplyConferenceStatus } from './conference-panel';
describe('LiveKit integration helpers', () => {
  it('creates authenticated token headers', () => expect(conferenceTokenHeaders('room-secret').Authorization).toBe('Bearer room-secret'));
  it('does not leak connection details in production', () => expect(livekitErrorReason(new Error('secret url'), true)).toBe('تعذر الاتصال بـ LiveKit.'));
  it('returns a configured URL without requiring browser permissions', () => expect(typeof livekitUrl()).toBe('string'));
  it('ignores a deferred status response after a newer socket policy event', () => {
    let generation = 0; let policy = false; const request = generation; generation += 1; policy = true;
    if (shouldApplyConferenceStatus(request, generation)) policy = false;
    expect(policy).toBe(true);
  });
  it('keeps a newer grant when an older status response resolves later', () => {
    let generation = 4; let granted = true; const request = generation; generation += 1; granted = true;
    if (shouldApplyConferenceStatus(request, generation)) granted = false;
    expect(granted).toBe(true);
  });
});
