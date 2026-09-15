import { describe, expect, it, afterAll } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { httpServer, io, rooms } from './index';

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
});
