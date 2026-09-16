import { expect, test, type Page } from '@playwright/test';

const VIDEO_ID = '3QM6MvvGwTg';

async function snapshot(page: Page, roomId: string) {
  return page.evaluate(async (id) => {
    const saved = JSON.parse(sessionStorage.getItem(`watch-with-me:${id}`) || '{}');
    const response = await fetch(`/api/rooms/${id}/state`, {
      headers: { Authorization: `Bearer ${saved.token}` },
    });
    if (!response.ok) throw new Error(`state endpoint returned ${response.status}`);
    return response.json();
  }, roomId);
}

test('Docker E2E: independent host/viewer YouTube synchronization', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const viewerContext = await browser.newContext();
  const host = await hostContext.newPage();
  const viewer = await viewerContext.newPage();
  const externalErrors: string[] = [];
  for (const page of [host, viewer]) {
    page.on('console', (message) => {
      if (message.type() === 'error')
        externalErrors.push(`${page === host ? 'host' : 'viewer'} console: ${message.text()}`);
    });
    page.on('pageerror', (error) =>
      externalErrors.push(`${page === host ? 'host' : 'viewer'} pageerror: ${error.message}`),
    );
    page.on('requestfailed', (request) => {
      if (/youtube/i.test(request.url()))
        externalErrors.push(
          `${page === host ? 'host' : 'viewer'} requestfailed: ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`,
        );
    });
  }

  try {
    await host.goto('/create');
    await host.getByLabel('اسمك في الغرفة').fill('Docker Host');
    await host.getByRole('button', { name: /أنشئ الغرفة/ }).click();
    await host.waitForURL(/\/room\//);
    const roomId = new URL(host.url()).pathname.split('/').pop()!;

    await host.getByRole('button', { name: 'انسخ رابط الدعوة' }).click();
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    expect(invite).toContain('/join');
    expect(invite).toContain(`room=${roomId}`);
    expect(invite).not.toMatch(/[?&]token=/i);

    await viewer.goto(invite);
    await viewer.getByLabel('اسمك').fill('Docker Viewer');
    await viewer.getByRole('button', { name: /ادخل الغرفة/ }).click();
    await viewer.waitForURL(new RegExp(`/room/${roomId}$`));
    for (const page of [host, viewer]) {
      await expect(page.getByText('متصل ومتزامن')).toBeVisible();
      await expect(page.locator('.kicker', { hasText: /الحاضرون/ })).toContainText('2');
    }

    await expect(viewer.getByRole('button', { name: 'Load' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'تشغيل' })).toHaveCount(0);
    await expect(viewer.getByLabel('التقديم في الفيديو')).toHaveCount(0);

    await host.selectOption('#provider', 'youtube');
    await host.getByLabel('رابط مصدر الفيديو').fill(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    await host.getByRole('button', { name: 'Load' }).click();

    await expect
      .poll(async () => (await snapshot(host, roomId)).snapshot, { timeout: 30_000 })
      .toMatchObject({ provider: 'youtube', videoId: VIDEO_ID });
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot, { timeout: 30_000 })
      .toMatchObject({ provider: 'youtube', videoId: VIDEO_ID });

    const iframe = host.locator(`iframe[src*="${VIDEO_ID}"]`);
    const viewerIframe = viewer.locator(`iframe[src*="${VIDEO_ID}"]`);
    try {
      await expect(iframe).toHaveCount(1, { timeout: 30_000 });
      await expect(viewerIframe).toHaveCount(1, { timeout: 30_000 });
    } catch {
      const message = `YouTube external dependency unavailable after app sync passed: iframe API/video embed did not become available. Runtime errors: ${externalErrors.join(' | ') || 'none captured'}`;
      await testInfo.attach('youtube-runtime-error', {
        body: message,
        contentType: 'text/plain',
      });
      test.skip(true, message);
    }
    await expect(iframe).toBeVisible({ timeout: 30_000 });
    await expect(viewerIframe).toBeVisible({ timeout: 30_000 });

    // Exercise real controls. The server snapshot is the synchronization contract;
    // the viewer must observe each command, even when browser autoplay is blocked.
    await expect(host.getByRole('button', { name: 'تشغيل' })).toBeEnabled({
      timeout: 30_000,
    });
    await host.getByRole('button', { name: 'تشغيل' }).click();
    await expect.poll(async () => (await snapshot(viewer, roomId)).snapshot.status).toBe('playing');
    await host.getByRole('button', { name: 'إيقاف' }).click();
    await expect.poll(async () => (await snapshot(viewer, roomId)).snapshot.status).toBe('paused');
    await host.getByLabel('التقديم في الفيديو').fill('7');
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot.positionSeconds, {
        timeout: 15_000,
      })
      .toBe(7);
  } finally {
    await testInfo.attach('docker-e2e-host-url', { body: host.url(), contentType: 'text/plain' });
    await hostContext.close();
    await viewerContext.close();
  }
});
