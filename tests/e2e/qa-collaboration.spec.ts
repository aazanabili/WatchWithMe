import { expect, test, type APIRequestContext } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

const api = 'http://127.0.0.1:4000';

async function room(request: APIRequestContext) {
  const created = await request.post(`${api}/api/rooms`, { data: { displayName: 'QA host' } });
  expect(created.ok()).toBeTruthy();
  const host = await created.json();
  const joined = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
    data: { displayName: 'QA viewer' },
  });
  expect(joined.ok()).toBeTruthy();
  return { host, viewer: await joined.json() };
}

async function connected(roomId: string, token: string): Promise<Socket> {
  const socket = io('http://127.0.0.1:4000', { auth: { roomCode: roomId, token } });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function ack(socket: Socket, event: string, payload?: unknown) {
  return new Promise<any>((resolve) => socket.emit(event, payload, resolve));
}

test.describe('Docker collaboration interaction QA', () => {
  test('chat history/order/plain text/reconnect/delete and moderation mute/kick', async ({
    request,
  }) => {
    const { host, viewer } = await room(request);
    const hostSocket = await connected(host.roomId, host.token);
    const viewerSocket = await connected(host.roomId, viewer.token);
    const received: unknown[] = [];
    viewerSocket.on('chat.message', (message) => received.push(message));

    await ack(hostSocket, 'chat.send', { text: 'first', clientMessageId: 'chat-1' });
    await ack(hostSocket, 'chat.send', { text: 'second', clientMessageId: 'chat-2' });
    await expect.poll(() => received.length).toBe(2);
    expect((received[0] as { text: string }).text).toBe('first');
    const first = received[0] as { messageId: string };
    expect((await ack(viewerSocket, 'chat.history')).map((x: { text: string }) => x.text)).toEqual([
      'first',
      'second',
    ]);

    viewerSocket.disconnect();
    const reconnected = await connected(host.roomId, viewer.token);
    expect((await ack(reconnected, 'chat.history')).length).toBe(2);
    expect(await ack(hostSocket, 'chat.delete', { messageId: first.messageId })).toMatchObject({
      ok: true,
    });
    expect(
      await ack(hostSocket, 'moderation.mute', { participantId: viewer.participantId }),
    ).toMatchObject({ ok: true });
    expect(
      await ack(hostSocket, 'moderation.kick', { participantId: viewer.participantId }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(async () =>
        (
          await request.get(`${api}/api/rooms/${host.roomId}/state`, {
            headers: { Authorization: `Bearer ${viewer.token}` },
          })
        ).status(),
      )
      .toBe(401);
    hostSocket.disconnect();
    reconnected.disconnect();
  });

  test('host transfer, explicit leave, auto-oldest, and no-viewer close', async ({ request }) => {
    const created = await request.post(`${api}/api/rooms`, { data: { displayName: 'Host' } });
    const host = await created.json();
    const oneResponse = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
      data: { displayName: 'One' },
    });
    const twoResponse = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
      data: { displayName: 'Two' },
    });
    const one = await oneResponse.json();
    const two = await twoResponse.json();
    const oneSocket = await connected(host.roomId, one.token);
    const twoSocket = await connected(host.roomId, two.token);
    expect(
      (
        await request.post(`${api}/api/rooms/${host.roomId}/leave`, {
          headers: { Authorization: `Bearer ${host.token}` },
        })
      ).status(),
    ).toBe(204);
    await expect
      .poll(async () =>
        (
          await request.get(`${api}/api/rooms/${host.roomId}/state`, {
            headers: { Authorization: `Bearer ${one.token}` },
          })
        ).json(),
      )
      .toMatchObject({ currentParticipant: { role: 'host' } });
    expect(
      (
        await request.post(`${api}/api/rooms/${host.roomId}/leave`, {
          headers: { Authorization: `Bearer ${two.token}` },
        })
      ).status(),
    ).toBe(204);
    oneSocket.disconnect();
    twoSocket.disconnect();
    expect(
      (
        await request.post(`${api}/api/rooms/${host.roomId}/leave`, {
          headers: { Authorization: `Bearer ${one.token}` },
        })
      ).status(),
    ).toBe(204);
    const closed = await request.get(`${api}/api/rooms/${host.roomId}/state`, {
      headers: { Authorization: `Bearer ${one.token}` },
    });
    expect(closed.status()).toBe(401);
  });
});
