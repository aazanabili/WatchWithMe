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
  }, { roomId: room.roomId, token: room.token });
  await page.goto(`/room/${room.roomId}`);
  await page.waitForURL(/\/room\//);
  return page;
}

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
    await host.getByRole('checkbox', { name: 'تفعيل المؤتمر للمشاهدين' }).check();
    await expect(viewer.getByRole('button', { name: 'انضمام إلى الفيديو' })).toBeEnabled();
    await host.getByRole('button', { name: 'انضمام إلى الفيديو' }).click(); await viewer.getByRole('button', { name: 'انضمام إلى الفيديو' }).click();
    await host.getByRole('button', { name: 'تشغيل الكاميرا' }).click(); await host.getByRole('button', { name: 'تشغيل الميكروفون' }).click();
    await expect(viewer.getByRole('button', { name: 'تشغيل الكاميرا' })).toBeDisabled();
    await host.getByRole('button', { name: 'سماح' }).click();
    await expect(viewer.getByRole('button', { name: 'تشغيل الكاميرا' })).toBeEnabled();
    await viewer.getByRole('button', { name: 'تشغيل الكاميرا' }).click(); await viewer.getByRole('button', { name: 'تشغيل الميكروفون' }).click();
    await expect(host.locator('.conference-grid .conference-tile')).toHaveCount(2);
    await expect(viewer.locator('.conference-grid .conference-tile')).toHaveCount(2);
    await viewer.getByRole('button', { name: 'كتم محلي' }).click();
    await expect(viewer.getByRole('button', { name: 'إلغاء الكتم المحلي' })).toBeVisible();
    await viewer.getByRole('button', { name: 'مشاركة الشاشة' }).click();
    await expect(viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' })).toBeVisible(); await viewer.getByRole('button', { name: 'إيقاف مشاركة الشاشة' }).click();
    const revoke = await request.post(`${api}/api/rooms/${room.roomId}/conference/revoke`, { headers: auth, data: { participantId: viewerRoom.participantId } });
    expect(revoke.status()).toBe(204);
    await expect(viewer.getByRole('button', { name: 'انضمام إلى الفيديو' })).toBeVisible();
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
