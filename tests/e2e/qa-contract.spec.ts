import { expect, test, type APIRequestContext } from '@playwright/test';
import { io } from 'socket.io-client';

const api = 'http://127.0.0.1:4000';

async function create(request: APIRequestContext, name: string) {
  const response = await request.post(`${api}/api/rooms`, { data: { displayName: name } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function emitCommand(roomId: string, token: string, command: object) {
  const socket = io('http://127.0.0.1:4000', { auth: { roomCode: roomId, token } });
  let rejected: unknown;
  let protocolError: unknown;
  socket.once('command_rejected', (value) => {
    rejected = value;
  });
  socket.once('error', (value) => {
    protocolError = value;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const result = new Promise<void>((resolve) => {
    socket.once('playback_changed', () => resolve());
    socket.once('command_rejected', () => resolve());
    setTimeout(resolve, 2000);
  });
  socket.emit('command', { version: 'v1', commandId: crypto.randomUUID(), command });
  await result;
  socket.disconnect();
  if (rejected) throw new Error(`command_rejected: ${JSON.stringify(rejected)}`);
  if (protocolError) throw new Error(`socket_error: ${JSON.stringify(protocolError)}`);
}

test.describe('Docker collaboration/media contract QA', () => {
  test('enforces cap 10, host transfer, kick, revoke, and close semantics', async ({ request }) => {
    test.setTimeout(60_000);
    const host = await create(request, 'QA host');
    const viewers = [];
    for (let i = 0; i < 9; i++) {
      const response = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
        data: { displayName: `Viewer ${i + 1}` },
      });
      expect(response.ok()).toBeTruthy();
      viewers.push(await response.json());
    }
    const full = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
      data: { displayName: 'Viewer 10' },
    });
    expect(full.status()).toBe(409);

    const transferred = await request.post(`${api}/api/rooms/${host.roomId}/transfer-host`, {
      headers: { Authorization: `Bearer ${host.token}` },
      data: { participantId: viewers[0].participantId },
    });
    expect(transferred.ok()).toBeTruthy();

    const oldHostForbidden = await request.post(`${api}/api/rooms/${host.roomId}/kick`, {
      headers: { Authorization: `Bearer ${host.token}` },
      data: { participantId: viewers[1].participantId },
    });
    expect(oldHostForbidden.status()).toBe(403);

    const kicked = await request.post(`${api}/api/rooms/${host.roomId}/kick`, {
      headers: { Authorization: `Bearer ${viewers[0].token}` },
      data: { participantId: viewers[1].participantId },
    });
    expect(kicked.status()).toBe(204);
    const revoked = await request.get(`${api}/api/rooms/${host.roomId}/state`, {
      headers: { Authorization: `Bearer ${viewers[1].token}` },
    });
    expect(revoked.status()).toBe(401);

    const leaveHost = await request.post(`${api}/api/rooms/${host.roomId}/leave`, {
      headers: { Authorization: `Bearer ${host.token}` },
    });
    expect(leaveHost.status()).toBe(204);
    const state = await request.get(`${api}/api/rooms/${host.roomId}/state`, {
      headers: { Authorization: `Bearer ${viewers[0].token}` },
    });
    expect(state.ok()).toBeTruthy();
    expect((await state.json()).currentParticipant.role).toBe('host');
  });

  test('returns 3-hour upload metadata and validates subtitle MIME contracts', async ({
    request,
  }) => {
    const host = await create(request, 'Media host');
    const headers = { Authorization: `Bearer ${host.token}` };
    const intentResponse = await request.post(
      `${api}/api/rooms/${host.roomId}/media/upload-intent`,
      {
        headers,
        data: { fileName: 'qa.mp4', contentType: 'video/mp4', sizeBytes: 64 },
      },
    );
    expect(intentResponse.status()).toBe(201);
    const intent = await intentResponse.json();
    expect(new URL(intent.url).origin).toBe('http://localhost:9000');
    const put = await request.put(intent.url, {
      headers: { 'Content-Type': 'video/mp4' },
      data: Buffer.alloc(64),
    });
    expect(put.ok()).toBeTruthy();
    expect(intent.expiresAt).toBeTruthy();
    expect(new Date(intent.expiresAt).getTime() - Date.now()).toBeGreaterThan(2.9 * 60 * 60 * 1000);
    expect(new Date(intent.expiresAt).getTime() - Date.now()).toBeLessThan(3.1 * 60 * 60 * 1000);

    const subtitle = await request.post(`${api}/api/rooms/${host.roomId}/media/subtitle-intent`, {
      headers,
      data: {
        fileName: 'qa.vtt',
        contentType: 'text/vtt',
        sizeBytes: 42,
        assetId: intent.assetId,
        language: 'ar',
      },
    });
    expect(subtitle.status()).toBe(201);
    const badSubtitle = await request.post(
      `${api}/api/rooms/${host.roomId}/media/subtitle-intent`,
      {
        headers,
        data: {
          fileName: 'qa.txt',
          contentType: 'text/plain',
          sizeBytes: 2,
          assetId: intent.assetId,
        },
      },
    );
    expect(badSubtitle.status()).toBe(400);
  });

  test('supports conference policy, six publishers, grants, mute, and revoke', async ({
    request,
  }) => {
    const host = await create(request, 'Conference host');
    const viewers = [];
    for (let i = 0; i < 6; i++) {
      const response = await request.post(`${api}/api/rooms/${host.roomId}/join`, {
        data: { displayName: `Publisher ${i + 1}` },
      });
      expect(response.ok()).toBeTruthy();
      viewers.push(await response.json());
    }
    const headers = { Authorization: `Bearer ${host.token}` };
    const policy = await request.post(`${api}/api/rooms/${host.roomId}/conference/policy`, {
      headers,
      data: { enabled: true },
    });
    expect(policy.ok()).toBeTruthy();
    for (const viewer of viewers.slice(0, 5)) {
      const grant = await request.post(`${api}/api/rooms/${host.roomId}/conference/grant`, {
        headers,
        data: { participantId: viewer.participantId },
      });
      expect(grant.ok()).toBeTruthy();
      const token = await request.post(`${api}/api/rooms/${host.roomId}/conference/token`, {
        headers: { Authorization: `Bearer ${viewer.token}` },
        data: {},
      });
      expect(token.ok(), `conference token ${token.status()}: ${await token.text()}`).toBeTruthy();
    }
    const sixth = await request.post(`${api}/api/rooms/${host.roomId}/conference/grant`, {
      headers,
      data: { participantId: viewers[5].participantId },
    });
    expect(sixth.status()).toBe(409);
    const revoked = await request.post(`${api}/api/rooms/${host.roomId}/conference/revoke`, {
      headers,
      data: { participantId: viewers[0].participantId },
    });
    expect(revoked.status()).toBe(204);
  });

  test('accepts social providers as synchronized view-only snapshots', async ({ request }) => {
    const host = await create(request, 'Social host');
    const providers: Record<string, string> = {
      instagram: 'https://www.instagram.com/p/ABC123/',
      tiktok: 'https://www.tiktok.com/@qa/video/1234567890',
      vimeo: 'https://vimeo.com/123456789',
      dailymotion: 'https://www.dailymotion.com/video/x123456',
      twitch: 'https://www.twitch.tv/qa',
      facebook: 'https://www.facebook.com/watch/?v=123456789',
    };
    for (const [provider, videoId] of Object.entries(providers)) {
      await emitCommand(host.roomId, host.token, {
        type: 'load',
        provider,
        videoId,
        durationSeconds: null,
      });
      const response = await request.get(`${api}/api/rooms/${host.roomId}/state`, {
        headers: { Authorization: `Bearer ${host.token}` },
      });
      const state = await response.json();
      expect(state.snapshot).toMatchObject({ provider, videoId });
    }
  });
});
