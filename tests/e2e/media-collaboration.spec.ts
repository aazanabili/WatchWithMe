import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const api = 'http://127.0.0.1:4000';
type Room = { roomId: string; token: string; participantId: string };
type Fixtures = { mp4: string; ts: string; webm: boolean; dir: string };
let fixtures: Fixtures;

test.beforeAll(() => {
  fixtures = JSON.parse(execFileSync('node', ['scripts/generate-media-fixtures.cjs'], { encoding: 'utf8' }));
});

async function create(request: APIRequestContext, name: string): Promise<Room> {
  const response = await request.post(`${api}/api/rooms`, { data: { displayName: name } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function join(request: APIRequestContext, roomId: string, name: string): Promise<Room> {
  const response = await request.post(`${api}/api/rooms/${roomId}/join`, { data: { displayName: name } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function upload(request: APIRequestContext, room: Room, file: string, type: string) {
  const body = readFileSync(file);
  const extension = file.endsWith('.ts') ? 'ts' : file.endsWith('.webm') ? 'webm' : 'mp4';
  const intentResponse = await request.post(`${api}/api/rooms/${room.roomId}/media/upload-intent`, {
    headers: { Authorization: `Bearer ${room.token}` },
    data: { fileName: `tiny.${extension}`, contentType: type, sizeBytes: body.length },
  });
  expect(intentResponse.status()).toBe(201);
  const intent = await intentResponse.json();
  const put = await request.put(intent.url, { headers: { 'Content-Type': type }, data: body });
  expect(put.ok()).toBeTruthy();
  const complete = await request.post(`${api}/api/rooms/${room.roomId}/media/upload-complete`, {
    headers: { Authorization: `Bearer ${room.token}` }, data: { uploadId: intent.uploadId, checksum: 'runtime-fixture' },
  });
  expect(complete.status()).toBe(202);
  await expect.poll(async () => (await (await request.get(`${api}/api/rooms/${room.roomId}/media/${intent.assetId}/status`, { headers: { Authorization: `Bearer ${room.token}` } })).json()).status, { timeout: 45_000 }).toBe('completed');
  const completed = await request.get(`${api}/api/rooms/${room.roomId}/media/${intent.assetId}/status`, { headers: { Authorization: `Bearer ${room.token}` } });
  expect((await completed.json()).durationSeconds).toBeGreaterThan(0);
  const playback = await request.get(`${api}/api/rooms/${room.roomId}/media/${intent.assetId}/playback-url`, { headers: { Authorization: `Bearer ${room.token}` } });
  expect(playback.ok()).toBeTruthy();
  const playbackJson = await playback.json();
  expect(playbackJson.url).toMatch(/^https?:\/\//);
  return { ...intent, playbackUrl: playbackJson.url };
}
async function openRoom(browser: Browser, room: Room, name: string): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(({ roomId, token }) => {
    sessionStorage.setItem(`watch-with-me:${roomId}`, JSON.stringify({ token }));
    const peers: RTCPeerConnection[] = [];
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, { construct(target, args, newTarget) { const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection; peers.push(peer); return peer; } });
    (window as Window & { __watchWithMePeerConnections?: RTCPeerConnection[] }).__watchWithMePeerConnections = peers;
  }, { roomId: room.roomId, token: room.token });
  await page.goto(`/room/${room.roomId}`);
  await page.waitForURL(/\/room\//);
  return page;
}
async function logConnectionType(page: Page, label: string) {
  const readStats = () => page.evaluate(async () => {
    const peers = (window as Window & { __watchWithMePeerConnections?: RTCPeerConnection[] }).__watchWithMePeerConnections ?? [];
    const reports = await Promise.all(peers.map(peer => peer.getStats()));
    return reports.flatMap(report => { const values = Array.from(report.values()); const candidates = new Map(values.filter(report => report.type === 'local-candidate' || report.type === 'remote-candidate').map(report => [report.id, report])); return values.filter(report => report.type === 'candidate-pair' && (report as RTCIceCandidatePairStats).state === 'succeeded').map(report => { const pair = report as RTCIceCandidatePairStats; const local = candidates.get(pair.localCandidateId) as RTCIceCandidateStats | undefined; return { connectionType: local?.protocol ?? pair.protocol ?? null, candidateType: local?.candidateType ?? null, state: pair.state, nominated: pair.nominated }; }); });
  });
  let stats: Awaited<ReturnType<typeof readStats>> = [];
  await expect.poll(async () => { stats = await readStats(); return stats.length; }, { timeout: 15_000, message: `${label} must expose a succeeded ICE candidate pair` }).toBeGreaterThan(0);
  console.log(`[livekit:connectionType] ${label}: ${JSON.stringify(stats)}`);
  expect(stats.every(stat => stat.connectionType === 'udp'), `${label} must use UDP`).toBe(true);
}
async function expectMediaTopology(page: Page, selector: string, labels: string[], message: string) {
  let last = '';
  await expect.poll(
    () => page.locator('.conference-grid video, .conference-grid audio').evaluateAll((elements, targetSelector) => { const records = elements.map(element => ({ label: element.getAttribute('aria-label'), participantId: element.getAttribute('data-participant-id'), source: element.getAttribute('data-media-source'), kind: element.tagName.toLowerCase(), readyState: element instanceof HTMLVideoElement || element instanceof HTMLAudioElement ? element.readyState : null })).sort((a, b) => `${a.source}:${a.kind}:${a.participantId}:${a.label}`.localeCompare(`${b.source}:${b.kind}:${b.participantId}:${b.label}`)); const targetSource = targetSelector.match(/data-media-source="([^"]+)"/)?.[1]; const value = records.filter(record => record.source === targetSource && ((targetSelector.includes('video') && record.kind === 'video') || (targetSelector.includes('audio') && record.kind === 'audio'))).map(record => record.label).sort(); return { records, value }; }, selector).then(({ value, records }) => { const snapshot = JSON.stringify({ value, records }); if (snapshot !== last) { console.log(`[livekit:source-snapshot] ${message}: ${snapshot}`); last = snapshot; } return value; }),
    { message, timeout: 15_000 },
  ).toEqual([...labels].sort());
}
const cameraSelector = '.conference-grid video[data-media-source="camera"]';
const screenSelector = '.conference-grid video[data-media-source="screen_share"]';
const microphoneSelector = '.conference-grid audio[data-media-source="microphone"]';
const screenAudioSelector = '.conference-grid audio[data-media-source="screen_share_audio"]';
const expectCameraTopology = (page: Page, labels: string[], message: string) => expectMediaTopology(page, cameraSelector, labels, message);
const expectScreenTopology = (page: Page, labels: string[], message: string) => expectMediaTopology(page, screenSelector, labels, message);
const expectMicrophoneTopology = (page: Page, labels: string[], message: string) => expectMediaTopology(page, microphoneSelector, labels, message);
const expectScreenAudioTopology = (page: Page, labels: string[], message: string) => expectMediaTopology(page, screenAudioSelector, labels, message);

test.describe('runtime collaboration/media QA', () => {
  test('uploads FFmpeg MP4 and TS, completes worker processing, and exposes playback', async ({ request }) => {
    test.setTimeout(120_000);
    const room = await create(request, 'Runtime media host');
    const files: [string, string][] = [[fixtures.mp4, 'video/mp4'], [fixtures.ts, 'video/mp2t']];
    if (fixtures.webm) files.push([`${fixtures.dir}/wwm-tiny.webm`, 'video/webm']);
    for (const [file, type] of files) {
      const uploaded = await upload(request, room, file, type);
      expect(uploaded.playbackUrl).toContain('9000');
    }
  });

  test('loads completed media in host/viewer UI and verifies host controls versus viewer mute', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const room = await create(request, 'Playback host');
    const host = await openRoom(browser, room, 'Host');
    const viewerRoom = await join(request, room.roomId, 'Viewer');
    const viewer = await openRoom(browser, viewerRoom, 'Viewer');
    await host.getByLabel('رفع فيديو (تنتهي صلاحية الرابط بعد 3 ساعات)').setInputFiles(fixtures.mp4);
    await expect(host.getByRole('status').filter({ hasText: 'تم تحميل الفيديو' })).toBeVisible({ timeout: 45_000 });
    await expect(host.getByTestId('video-player')).toBeVisible();
    await expect(viewer.getByTestId('video-player')).toBeVisible();
    await host.locator('video').evaluate((video) => { video.crossOrigin = 'anonymous'; video.load(); });
    await expect(host.getByLabel('مدة الفيديو')).toBeVisible();
    await expect(host.getByLabel('التقديم في الفيديو')).toBeEnabled();
    await host.getByRole('button', { name: 'تشغيل' }).click();
    await host.getByRole('button', { name: 'إيقاف' }).click();
    await host.getByLabel('التقديم في الفيديو').fill('1');
    await expect(viewer.getByLabel('التقديم في الفيديو')).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: /كتم صوت الفيديو/ })).toHaveCount(0);
    await host.close(); await viewer.close();
  });

  test('processes actual VTT and SRT uploads, attaches a track, and proves cue/selector behavior', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const room = await create(request, 'Subtitle host');
    const page = await openRoom(browser, room, 'Host');
    await page.getByLabel('رفع فيديو (تنتهي صلاحية الرابط بعد 3 ساعات)').setInputFiles(fixtures.mp4);
    await expect(page.getByRole('status').filter({ hasText: 'تم تحميل الفيديو' })).toBeVisible({ timeout: 45_000 });
    for (const [name, type, content] of [['captions.vtt', 'text/vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello'], ['captions.srt', 'application/x-subrip', '1\n00:00:00,000 --> 00:00:01,000\nHello']] as const) {
      await page.getByLabel('لغة الترجمة').fill(name.endsWith('srt') ? 'en' : 'ar');
      await page.getByLabel('ترجمة VTT/SRT').setInputFiles({ name, mimeType: type, buffer: Buffer.from(content) });
      await expect(page.getByRole('status').filter({ hasText: /إضافة الترجمة|تعذر/ })).toBeVisible({ timeout: 45_000 });
    }
    await expect
      .poll(
        async () => {
          const state = await page.locator('video').evaluate((video) => {
            const tracks = Array.from(video.textTracks).map((track) => {
              const cue = track.cues?.[0];
              return { mode: track.mode, cueCount: track.cues?.length ?? 0, text: cue?.text ?? null, startTime: cue?.startTime ?? null, endTime: cue?.endTime ?? null };
            });
            return { trackCount: video.textTracks.length, tracks };
          });
          expect(state.trackCount).toBeGreaterThan(0);
          return state.tracks.find((track) => track.cueCount > 0) ?? null;
        },
        { timeout: 15_000, message: 'manual subtitle track must expose a real cue' },
      )
      .toMatchObject({ mode: 'showing', cueCount: 1, text: 'Hello', startTime: 0, endTime: 1 });
    await expect(page.getByText(/الترجمة: .*تشغيل/)).toBeVisible();
    await page.getByRole('checkbox', { name: /الترجمة/ }).uncheck();
    await expect(page.getByText(/الترجمة: .*إيقاف/)).toBeVisible();
    await expect
      .poll(() => page.locator('video').evaluate((video) => Array.from(video.textTracks).some((track) => track.mode === 'disabled')), {
        message: 'subtitle toggle must disable the manual text track',
      })
      .toBe(true);
    await page.getByRole('checkbox', { name: /الترجمة/ }).check();
    await expect
      .poll(async () => {
        const state = await page.locator('video').evaluate((video) => {
          const tracks = Array.from(video.textTracks).map((track) => { const cue = track.cues?.[0]; return { mode: track.mode, cueCount: track.cues?.length ?? 0, text: cue?.text ?? null, startTime: cue?.startTime ?? null, endTime: cue?.endTime ?? null }; });
          return { trackCount: video.textTracks.length, tracks };
        });
        expect(state.trackCount).toBeGreaterThan(0);
        return state.tracks.find((track) => track.cueCount > 0) ?? null;
      }, { message: 're-enabled manual subtitle track must retain its cue' })
      .toMatchObject({ mode: 'showing', cueCount: 1, text: 'Hello', startTime: 0, endTime: 1 });
    await page.close();
  });

  test('runs LiveKit with Chromium fake camera/mic, grant, remote grid, local mute, screen approval and cleanup', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const room = await create(request, 'Conference host'); const viewerRoom = await join(request, room.roomId, 'Conference viewer');
    const auth = { Authorization: `Bearer ${room.token}` };
    const host = await openRoom(browser, room, 'Host'); const viewer = await openRoom(browser, viewerRoom, 'Viewer');
    const notFound: string[] = [];
    for (const page of [host, viewer]) page.on('response', response => { if (response.status() === 404) notFound.push(`${response.request().method()} ${response.url()}`); });
    host.on('dialog', (dialog) => void dialog.accept());
    await viewer.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async (constraints?: MediaStreamConstraints) => {
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
        const context2d = canvas.getContext('2d');
        context2d?.fillRect(0, 0, canvas.width, canvas.height);
        const videoTrack = canvas.captureStream(5).getVideoTracks()[0];
        const tracks = [videoTrack];
        if (constraints?.audio) {
          const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
          tracks.push(...audio.getAudioTracks());
        }
        return new MediaStream(tracks);
      };
    });
    await expect(host.getByText('متصل ومتزامن')).toBeVisible();
    await expect(viewer.getByText('متصل ومتزامن')).toBeVisible();
    await host.getByRole('checkbox', { name: 'تفعيل المؤتمر للمشاهدين' }).check();
    await expect(viewer.getByRole('button', { name: 'انضمام إلى الفيديو' })).toBeEnabled();
    await expect.poll(async () => {
      const response = await request.get(`${api}/api/rooms/${room.roomId}/conference/status`, { headers: { Authorization: `Bearer ${viewerRoom.token}` } });
      return response.ok() ? (await response.json()).enabled : false;
    }, { message: 'conference policy must be persisted before issuing viewer token' }).toBe(true);

    const hostToken = host.waitForResponse(response => response.url().endsWith('/conference/token') && response.request().method() === 'POST');
    await host.getByRole('button', { name: 'انضمام إلى الفيديو' }).click();
    expect((await hostToken).status()).toBe(200);
    const viewerToken = viewer.waitForResponse(response => response.url().endsWith('/conference/token') && response.request().method() === 'POST');
    await viewer.getByRole('button', { name: 'انضمام إلى الفيديو' }).click();
    expect((await viewerToken).status()).toBe(200);
    await expect(host.getByRole('status').filter({ hasText: 'تم الاتصال' })).toBeVisible({ timeout: 20_000 });
    await expect(viewer.getByRole('status').filter({ hasText: 'تم الاتصال' })).toBeVisible({ timeout: 20_000 });
    await logConnectionType(host, 'host');
    await logConnectionType(viewer, 'viewer');
    await host.getByRole('button', { name: 'تشغيل الكاميرا' }).click();
    await expect(host.getByRole('button', { name: 'إيقاف الكاميرا' })).toBeVisible();
    await expectCameraTopology(host, ['أنت'], 'host initially renders only its local camera tile');
    await expectCameraTopology(viewer, [room.participantId], 'viewer initially renders only the host remote camera tile');
    await expect(viewer.getByRole('button', { name: 'تشغيل الكاميرا' })).toBeDisabled();
    await host.getByRole('button', { name: 'سماح' }).click();
    await expect(viewer.getByRole('button', { name: 'تشغيل الكاميرا' })).toBeEnabled();
    await viewer.getByRole('button', { name: 'تشغيل الكاميرا' }).click();
    await expect(viewer.getByRole('button', { name: 'إيقاف الكاميرا' })).toBeVisible();
    await expectCameraTopology(host, ['أنت', viewerRoom.participantId], 'host renders exactly local host and remote viewer cameras');
    await expectCameraTopology(viewer, ['أنت', room.participantId], 'viewer renders exactly remote host and local viewer cameras');
    await viewer.getByRole('button', { name: 'كتم محلي' }).click();
    await expect(viewer.getByRole('button', { name: 'إلغاء الكتم المحلي' })).toBeVisible();

    await host.getByRole('button', { name: 'إيقاف الكاميرا' }).click();
    await expectCameraTopology(host, [viewerRoom.participantId], 'host removes its local camera after camera phase');
    await expectCameraTopology(viewer, ['أنت'], 'viewer removes the remote host camera after camera phase');
    await viewer.getByRole('button', { name: 'إيقاف الكاميرا' }).click();
    await expectCameraTopology(host, [], 'host removes all cameras after camera phase');
    await expectCameraTopology(viewer, [], 'viewer removes all cameras after camera phase');

    await host.getByRole('button', { name: 'تشغيل الميكروفون' }).click();
    await expect(host.getByRole('button', { name: 'كتم الميكروفون' })).toBeVisible();
    await expectMicrophoneTopology(host, ['أنت'], 'host renders its local microphone tile');
    await viewer.getByRole('button', { name: 'تشغيل الميكروفون' }).click();
    await expect(viewer.getByRole('button', { name: 'كتم الميكروفون' })).toBeVisible();
    await expectMicrophoneTopology(host, ['أنت', viewerRoom.participantId], 'host renders local and remote microphone tiles');
    await expectMicrophoneTopology(viewer, ['أنت', room.participantId], 'viewer renders local and remote microphone tiles');
    await viewer.getByRole('button', { name: 'كتم الميكروفون' }).click();
    await expectMicrophoneTopology(host, ['أنت'], 'host removes remote microphone after microphone phase');
    await host.getByRole('button', { name: 'كتم الميكروفون' }).click();
    await expectMicrophoneTopology(host, [], 'host removes all microphones after microphone phase');
    await expectMicrophoneTopology(viewer, [], 'viewer removes all microphones after microphone phase');

    await viewer.getByRole('button', { name: 'مشاركة الشاشة' }).click();
    await expect(viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' })).toBeVisible();
    await expectScreenTopology(host, [viewerRoom.participantId], 'host renders remote screen share without audio');
    await expectScreenTopology(viewer, ['أنت'], 'viewer renders local screen share without audio');
    await expectScreenAudioTopology(host, [], 'host has no remote screen-share audio without audio capture');
    await expectScreenAudioTopology(viewer, [], 'viewer has no local screen-share audio without audio capture');
    await viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' }).click();
    await expectScreenTopology(host, [], 'host removes remote screen share without audio');
    await expectScreenTopology(viewer, [], 'viewer removes local screen share without audio');
    await expectScreenAudioTopology(host, [], 'host has no screen-share audio after no-audio share stops');
    await expectScreenAudioTopology(viewer, [], 'viewer has no screen-share audio after no-audio share stops');
    await viewer.getByLabel('مشاركة صوت النظام').check();
    await viewer.getByRole('button', { name: 'مشاركة الشاشة' }).click();
    await expect(viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' })).toBeVisible();
    await expectScreenTopology(host, [viewerRoom.participantId], 'host renders remote screen share with audio');
    await expectScreenTopology(viewer, ['أنت'], 'viewer renders local screen share with audio');
    await expectScreenAudioTopology(host, [viewerRoom.participantId], 'host renders remote screen-share audio');
    await expectScreenAudioTopology(viewer, ['أنت'], 'viewer renders local screen-share audio');
    await viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' }).click();
    await expectScreenTopology(host, [], 'host removes remote screen share with audio');
    await expectScreenTopology(viewer, [], 'viewer removes local screen share with audio');
    await expectScreenAudioTopology(host, [], 'host removes remote screen-share audio');
    await expectScreenAudioTopology(viewer, [], 'viewer removes local screen-share audio');

    await viewer.getByRole('button', { name: 'تشغيل الكاميرا' }).click();
    await expect(viewer.getByRole('button', { name: 'إيقاف الكاميرا' })).toBeVisible();
    await expectCameraTopology(host, [viewerRoom.participantId], 'host renders viewer camera before revoke');
    await expectCameraTopology(viewer, ['أنت'], 'viewer renders only local camera before revoke');
    const revoke = await request.post(`${api}/api/rooms/${room.roomId}/conference/revoke`, { headers: auth, data: { participantId: viewerRoom.participantId } });
    expect(revoke.status()).toBe(204);
    await expect(viewer.getByRole('button', { name: 'تشغيل الكاميرا' })).toBeDisabled();
    await expect(viewer.getByRole('status').filter({ hasText: 'تم الاتصال' })).toBeVisible();
    await expectCameraTopology(viewer, [], 'revoke removes viewer local camera while connection remains');
    await expectCameraTopology(host, [], 'revoke removes remote viewer camera while host remains connected');
    await viewer.getByRole('button', { name: 'مغادرة الفيديو' }).click();
    await expect(viewer.getByRole('button', { name: 'انضمام إلى الفيديو' })).toBeVisible();
    await expectCameraTopology(viewer, [], 'leaving video removes all viewer camera tiles without duplicates');
    await expectCameraTopology(host, [], 'host has no camera after viewer leave cleanup');
    expect(notFound, 'LiveKit/media E2E must not produce 404 responses').toEqual([]);
    await host.close(); await viewer.close();
  });

  test('renders all six social providers as view-only UI without playback controls', async ({ browser, request }) => {
    const room = await create(request, 'Social host'); const page = await openRoom(browser, room, 'Host');
    await expect(page.getByRole('region', { name: 'المحادثة' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'مغادرة الغرفة' })).toBeVisible();
    const sources: Record<string, string> = {
      instagram: 'https://www.instagram.com/p/ABC123/', tiktok: 'https://www.tiktok.com/@qa/video/1234567890',
      vimeo: 'https://vimeo.com/123456789', dailymotion: 'https://www.dailymotion.com/video/x123456',
      twitch: 'https://www.twitch.tv/qa', facebook: 'https://www.facebook.com/watch/?v=123456789',
    };
    for (const provider of Object.keys(sources)) {
      await page.selectOption('#provider', provider); await page.getByLabel('رابط مصدر الفيديو').fill(sources[provider]); await page.getByRole('button', { name: 'Load' }).click();
      await expect(page.getByText(new RegExp(`مصدر ${provider} خارجي للعرض فقط`))).toBeVisible();
      await expect(page.getByRole('button', { name: 'تشغيل' })).toHaveCount(0); await expect(page.getByLabel('التقديم في الفيديو')).toHaveCount(0);
    }
    await page.close();
  });
});
