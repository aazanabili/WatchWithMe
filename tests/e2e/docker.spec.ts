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
      .toMatchObject(
        { provider: 'youtube', videoId: VIDEO_ID },
        'Host app state must expose the lowercase YouTube contract and requested video ID',
      );
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot, { timeout: 30_000 })
      .toMatchObject(
        { provider: 'youtube', videoId: VIDEO_ID },
        'Viewer app state must receive the lowercase YouTube contract and requested video ID',
      );

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
      throw new Error(message);
    }
    await expect(iframe, 'Host YouTube iframe must be visible for the requested video').toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await expect(
      viewerIframe,
      'Viewer YouTube iframe must be visible for the requested video',
    ).toBeVisible({ timeout: 30_000 });

    // Exercise real controls. The server snapshot is the synchronization contract;
    // the viewer must observe each command, even when browser autoplay is blocked.
    await expect(
      host.getByRole('button', { name: 'تشغيل' }),
      'YouTube API must report ready before Play is attempted',
    ).toBeEnabled({ timeout: 30_000 });
    await host.getByRole('button', { name: 'تشغيل' }).click();
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot.status, {
        message: 'Viewer must observe YouTube Play state',
      })
      .toBe('playing');
    await host.getByRole('button', { name: 'إيقاف' }).click();
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot.status, {
        message: 'Viewer must observe YouTube Pause state',
      })
      .toBe('paused');
    const seek = host.getByLabel('التقديم في الفيديو');
    const box = await seek.boundingBox();
    expect(box, 'seek control must have a pointer target').not.toBeNull();
    const max = Number(await seek.getAttribute('max'));
    const ratio = Math.min(7 / max, 0.99);
    const direction = await seek.evaluate((element) => getComputedStyle(element).direction);
    const targetX = box!.x + box!.width * (direction === 'rtl' ? 1 - ratio : ratio);
    const targetY = box!.y + box!.height / 2;
    // Exercise the native range with one pointer gesture. Unlike fill(), this
    // emits the browser input/change path and then commits on release/blur.
    await host.mouse.move(targetX, targetY);
    await host.mouse.down();
    await host.mouse.up();
    // Commit the reset through the native input path at the exact minimum;
    // keyboard End can leave a transient preview value in an RTL range.
    await seek.evaluate((element) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, '0');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(async () => Math.round((await snapshot(viewer, roomId)).snapshot.positionSeconds), {
        timeout: 15_000,
        message: 'Viewer must observe the range reset before incremental seek',
      })
      .toBeLessThan(1);
    // Reassert paused state after the reset so the incremental contract is
    // measured from a stable position, not from playback advancing during
    // the reset round-trip.
    await host.getByRole('button', { name: 'إيقاف' }).click();
    await expect.poll(async () => (await snapshot(viewer, roomId)).snapshot.status).toBe('paused');
    // The reset is committed at the exact range minimum, so always send the
    // contract's 70 x 100ms increments rather than deriving a count from a
    // transient snapshot sample.
    const steps = 70;
    await seek.focus();
    for (let i = 0; i < steps; i += 1) await seek.press('ArrowLeft', { delay: 300 });
    await seek.press('Tab');
    await expect
      .poll(async () => (await snapshot(viewer, roomId)).snapshot.positionSeconds, {
        timeout: 15_000,
        message: 'Viewer must observe the requested YouTube Seek position',
      })
      .toBe(7);
  } finally {
    await testInfo.attach('docker-e2e-host-url', { body: host.url(), contentType: 'text/plain' });
    await hostContext.close();
    await viewerContext.close();
  }
});
