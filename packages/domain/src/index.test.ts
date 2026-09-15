import { describe, expect, it } from 'vitest';
import {
  addViewer,
  classifyDrift,
  clockOffset,
  correctionPolicy,
  createRoomState,
  expectedPosition,
  transition,
} from './index';
import type { CommandEnvelope } from '@watch-with-me/contracts';

const at = '2026-01-01T00:00:00.000Z';
const command = (commandId: string, value: CommandEnvelope['command']): CommandEnvelope => ({
  version: 'v1',
  commandId,
  command: value,
});

describe('room and playback domain', () => {
  it('applies host transitions and calculates server-time position', () => {
    let room = createRoomState('r', 'h');
    room = addViewer(room, 'v');
    const loaded = transition(
      room,
      command('1', { type: 'load', provider: 'mp4', videoId: 'movie' }),
      { actorId: 'h', now: at },
    );
    const played = transition(loaded.state, command('2', { type: 'play' }), {
      actorId: 'h',
      now: Date.parse(at) + 1000,
    });
    expect(played.state.playback?.status).toBe('playing');
    expect(expectedPosition(played.state.playback!, Date.parse(at) + 3500)).toBe(2.5);
    expect(played.state.revision).toBe(2);
    expect(played.state.playback?.revision).toBe(2);
  });

  it('rejects viewer controls but permits state requests', () => {
    const room = addViewer(createRoomState('r', 'h'), 'v');
    const denied = transition(room, command('x', { type: 'seek', positionSeconds: 5 }), {
      actorId: 'v',
      now: at,
    });
    expect(denied.reason).toBe('viewer_controls_forbidden');
    const requested = transition(denied.state, command('y', { type: 'request_state' }), {
      actorId: 'v',
      now: at,
    });
    expect(requested.event.type).toBe('snapshot');
  });

  it('is idempotent and never reuses sequence numbers', () => {
    const room = createRoomState('r', 'h');
    const first = transition(
      room,
      command('same', { type: 'load', provider: 'youtube', videoId: 'a' }),
      { actorId: 'h', now: at },
    );
    const duplicate = transition(
      first.state,
      command('same', { type: 'load', provider: 'youtube', videoId: 'b' }),
      { actorId: 'h', now: at },
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state.sequence).toBe(1);
    expect(duplicate.state.revision).toBe(1);
    expect(
      transition(first.state, command('new', { type: 'pause' }), { actorId: 'h', now: at }).event
        .sequence,
    ).toBe(2);
  });

  it('handles missing media, clock offset, drift thresholds and hysteresis', () => {
    const rejected = transition(createRoomState('r', 'h'), command('p', { type: 'play' }), {
      actorId: 'h',
      now: at,
    });
    expect(rejected.accepted).toBe(false);
    expect(clockOffset({ clientSentAt: 100, serverReceivedAt: 250, clientReceivedAt: 200 })).toBe(
      100,
    );
    expect(classifyDrift(0.2)).toBe('synced');
    expect(classifyDrift(0.4)).toBe('minor');
    expect(classifyDrift(0.3, 'minor')).toBe('minor');
    expect(correctionPolicy(2)).toBe('hard_seek');
  });

  it('rejects invalid envelope and seek positions instead of producing invalid wire state', () => {
    const room = createRoomState('r', 'h');
    expect(() =>
      transition(
        room,
        {
          ...command('bad', { type: 'load', provider: 'mp4', videoId: 'x' }),
          version: 'v2' as 'v1',
        },
        { actorId: 'h', now: at },
      ),
    ).toThrow();
    const loaded = transition(
      room,
      command('load', { type: 'load', provider: 'mp4', videoId: 'x' }),
      { actorId: 'h', now: at },
    );
    expect(() =>
      transition(loaded.state, command('seek', { type: 'seek', positionSeconds: Number.NaN }), {
        actorId: 'h',
        now: at,
      }),
    ).toThrow();
  });
});
