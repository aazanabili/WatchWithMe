import { describe, expect, it, afterAll } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import {
  httpServer,
  io,
  rooms,
  InMemoryRoomRepository,
  RoomService,
  type Room,
  type RoomRepository,
} from './index';
import { ServerEvent } from '@watch-with-me/contracts';

let address: string;
const listen = new Promise<void>((resolve) =>
  httpServer.listen(0, () => {
    const a = httpServer.address();
    if (a && typeof a !== 'string') address = `http://127.0.0.1:${a.port}`;
    resolve();
  }),
);
const waitFor = (socket: Socket, event: string) =>
  new Promise<unknown>((resolve) => socket.once(event, resolve));
const waitForStatus = (socket: Socket, status: string) =>
  new Promise<unknown>((resolve) =>
    socket.on('playback_changed', function handler(value) {
      if (value.data?.status === status) {
        socket.off('playback_changed', handler);
        resolve(value);
      }
    }),
  );

class FailSavesRepository implements RoomRepository {
  readonly inner = new InMemoryRoomRepository();
  failures: number;
  constructor(failures: number) {
    this.failures = failures;
  }
  create(room: Room) {
    return this.inner.create(room);
  }
  async get(code: string) {
    const room = await this.inner.get(code);
    if (!room) return undefined;
    return {
      ...room,
      participants: new Map([...room.participants].map(([id, p]) => [id, { ...p }])),
      commands: new Map(room.commands),
      playback: room.playback ? { ...room.playback } : null,
    };
  }
  async save(room: Room, expected?: number) {
    if (this.failures-- > 0) return false;
    return (this.inner as RoomRepository).save(room, expected);
  }
}

describe('realtime MVP integration', async () => {
  await listen;
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        io.close();
        httpServer.close(() => resolve());
      }),
  );

  it('isolates rooms and enforces host-only commands with dedupe', async () => {
    const created = await fetch(`${address}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Host' }),
    }).then((r) => r.json());
    const joined = await fetch(`${address}/api/rooms/${created.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Viewer' }),
    }).then((r) => r.json());
    const host = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    const viewer = connect(address, { auth: { roomCode: created.roomCode, token: joined.token } });
    await Promise.all([waitFor(host, 'snapshot'), waitFor(viewer, 'snapshot')]);
    const rejected = waitFor(viewer, 'command_rejected');
    viewer.emit('command', { version: 'v1', commandId: 'viewer-1', command: { type: 'play' } });
    expect(((await rejected) as { reason: string }).reason).toBe('host_only');
    const changed = waitFor(host, 'playback_changed');
    const command = {
      version: 'v1',
      commandId: 'host-1',
      command: { type: 'load', provider: 'youtube', videoId: 'dQw4w9WgXcQ' },
    };
    host.emit('command', command);
    expect(((await changed) as { data: { videoId: string } }).data.videoId).toBe('dQw4w9WgXcQ');
    expect(((await changed) as { revision: number }).revision).toBe(1);
    const playing = waitForStatus(viewer, 'playing');
    host.emit('command', { version: 'v1', commandId: 'host-play', command: { type: 'play' } });
    expect(((await playing) as { data: { status: string } }).data.status).toBe('playing');
    const seeked = waitFor(viewer, 'playback_changed');
    host.emit('command', {
      version: 'v1',
      commandId: 'host-seek',
      command: { type: 'seek', positionSeconds: 42 },
    });
    expect(((await seeked) as { data: { positionSeconds: number } }).data.positionSeconds).toBe(42);
    const viewerSeek = waitFor(viewer, 'command_rejected');
    viewer.emit('command', {
      version: 'v1',
      commandId: 'viewer-seek',
      command: { type: 'seek', positionSeconds: 1 },
    });
    expect(((await viewerSeek) as { reason: string }).reason).toBe('host_only');
    const duplicate = waitFor(host, 'snapshot');
    host.emit('command', command);
    expect(((await duplicate) as { data: { sequence: number } }).data.sequence).toBeGreaterThan(0);
    host.close();
    viewer.close();
  });

  it('can reconnect with the same capability and receives a snapshot', async () => {
    const created = await fetch(`${address}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Reconnect' }),
    }).then((r) => r.json());
    const socket = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    await waitFor(socket, 'snapshot');
    socket.close();
    const again = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    const finalSnapshot = (await waitFor(again, 'snapshot')) as {
      data: { roomId: string; revision: number };
    };
    expect(finalSnapshot.data.roomId).toBe(created.roomCode);
    expect(finalSnapshot.data.revision).toBeGreaterThanOrEqual(0);
    again.close();
  });

  it('serializes concurrent host tabs and preserves online state across stale disconnects', async () => {
    const created = await fetch(`${address}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Multi-tab host' }),
    }).then((r) => r.json());
    const first = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    const second = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    await Promise.all([waitFor(first, 'snapshot'), waitFor(second, 'snapshot')]);
    const firstState = await rooms.get(created.roomCode);
    expect(firstState?.sequence).toBe(2); // two connects are state-changing lifecycle events
    expect([...firstState!.participants.values()][0].online).toBe(true);

    const loaded = waitFor(first, 'playback_changed');
    first.emit('command', {
      version: 'v1',
      commandId: 'multi-load',
      command: { type: 'load', provider: 'youtube', videoId: 'dQw4w9WgXcQ' },
    });
    await loaded;
    const playing = waitFor(first, 'playback_changed');
    second.emit('command', { version: 'v1', commandId: 'multi-play', command: { type: 'play' } });
    await playing;
    const paused = waitFor(first, 'playback_changed');
    first.emit('command', { version: 'v1', commandId: 'multi-pause', command: { type: 'pause' } });
    await paused;
    const afterCommands = await rooms.get(created.roomCode);
    expect(afterCommands?.sequence).toBe(5); // 2 connects + 3 commands

    const stillOnline = waitFor(second, 'participants');
    first.close();
    await stillOnline;
    expect([...(await rooms.get(created.roomCode))!.participants.values()][0].online).toBe(true);
    second.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const final = await rooms.get(created.roomCode);
    expect([...final!.participants.values()][0].online).toBe(false);
    expect(final?.sequence).toBe(7);
  });

  it('retries command and join CAS without inflating sequence or revision', async () => {
    const repository = new FailSavesRepository(1);
    const service = new RoomService(repository);
    const created = await service.create('deterministic host');
    const joined = await service.join(created.room.code, 'deterministic viewer');
    expect(joined.participantId).toBeTruthy();
    repository.failures = 1;
    const result = await service.commitCommandWithRetry(
      created.room.code,
      created.participantId,
      'retry-1',
      (room) => {
        room.playback = {
          provider: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          status: 'paused',
          positionSeconds: 0,
          updatedAt: new Date().toISOString(),
          revision: room.revision + 1,
        };
        return true;
      },
    );
    expect(result.kind).toBe('saved');
    const saved = await service.get(created.room.code);
    expect(saved?.sequence).toBe(1);
    expect(saved?.revision).toBe(1);
    const duplicate = await service.commitCommandWithRetry(
      created.room.code,
      created.participantId,
      'retry-1',
      () => {
        throw new Error('must not apply');
      },
    );
    expect(duplicate.kind).toBe('duplicate');
    expect((await service.get(created.room.code))?.revision).toBe(1);
  });

  it('rejects playback controls without media and validates every server event', async () => {
    const created = await fetch(`${address}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'No media host' }),
    }).then((r) => r.json());
    const host = connect(address, { auth: { roomCode: created.roomCode, token: created.token } });
    const invalidEvents: unknown[] = [];
    host.onAny((name, payload) => {
      if (
        ['snapshot', 'participants', 'command_rejected', 'playback_changed', 'error'].includes(name)
      )
        invalidEvents.push(ServerEvent.parse(payload));
    });
    await waitFor(host, 'snapshot');
    const initial = await rooms.get(created.roomCode);
    let playbackChanges = 0;
    host.on('playback_changed', () => playbackChanges++);
    for (const [type, payload] of [
      ['play', {}],
      ['pause', {}],
      ['seek', { positionSeconds: 12 }],
    ] as const) {
      const rejected = waitFor(host, 'command_rejected');
      host.emit('command', {
        version: 'v1',
        commandId: `no-media-${type}`,
        command: { type, ...payload },
      });
      expect(((await rejected) as { reason: string }).reason).toBe('no_media_loaded');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const final = await rooms.get(created.roomCode);
    expect(final?.sequence).toBe(initial?.sequence);
    expect(final?.revision).toBe(initial?.revision);
    expect(final?.playback).toBeNull();
    expect(playbackChanges).toBe(0);
    expect(invalidEvents.length).toBeGreaterThan(0);
    host.close();
  });

  it('retries concurrent joins through the HTTP boundary', async () => {
    const created = await fetch(`${address}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'join host' }),
    }).then((r) => r.json());
    const responses = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        fetch(`${address}/api/rooms/${created.roomCode}/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: `joiner-${i}` }),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const state = await fetch(`${address}/api/rooms/${created.roomCode}/state`, {
      headers: { authorization: `Bearer ${created.token}` },
    }).then((r) => r.json());
    expect(state.sequence).toBe(0);
    expect(state.revision).toBe(0);
    expect(state.participants).toHaveLength(4);
  });

  it('returns bounded conflict exhaustion without broadcasting or mutating state', async () => {
    const repository = new FailSavesRepository(10);
    const service = new RoomService(repository);
    const created = await service.create('conflict host');
    const result = await service.commitCommandWithRetry(
      created.room.code,
      created.participantId,
      'never-saved',
      (room) => {
        room.playback = null;
        return true;
      },
    );
    expect(result.kind).toBe('conflict');
    const saved = await service.get(created.room.code);
    expect(saved?.sequence).toBe(0);
    expect(saved?.revision).toBe(0);
    expect(saved?.commands.size).toBe(0);
  });
});
