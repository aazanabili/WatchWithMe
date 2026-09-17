import { expect, test } from '@playwright/test';

test('creates a room, joins a second client, and keeps viewer controls read-only', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const fixture = Buffer.from('AAAAFGZ0eXBtcDQyAAAAAG1wNDJpc29t', 'base64');
  const host = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await host.route('https://fixtures.example.test/watch.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture }),
  );
  await host.goto('/create');
  await host.getByLabel('اسمك في الغرفة').fill('Host');
  await host.getByRole('button', { name: /أنشئ الغرفة/ }).click();
  await host.waitForURL(/\/room\//);
  const roomId = new URL(host.url()).pathname.split('/').pop()!;
  const viewer = await browser.newPage({ viewport: { width: 320, height: 740 } });
  await viewer.route('https://fixtures.example.test/watch.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture }),
  );
  await viewer.goto('/join');
  await viewer.getByLabel('رمز الغرفة').fill(roomId);
  await viewer.getByLabel('اسمك').fill('Viewer');
  await viewer.getByRole('button', { name: /ادخل الغرفة/ }).click();
  await viewer.waitForURL(/\/room\//);
  await expect(host.locator('.participants')).toContainText('المضيف');
  await expect(viewer.locator('.participants')).toContainText('مشاهد');
  await expect(viewer.getByRole('button', { name: 'تشغيل' })).toHaveCount(0);
  await expect(viewer.getByTestId('video-player')).toHaveCount(0);
  await expect(host.getByText('متصل ومتزامن')).toBeVisible();
  await host.selectOption('#provider', 'mp4');
  await host.getByLabel('رابط مصدر الفيديو').fill('https://fixtures.example.test/watch.mp4');
  await host.getByRole('button', { name: 'Load' }).click();
  await expect(host.getByTestId('video-player')).toBeVisible();
  await expect(viewer.getByTestId('video-player')).toBeVisible();
  await host
    .getByTestId('video-player')
    .evaluate((video) => video.dispatchEvent(new Event('canplay')));
  await expect(host.getByRole('button', { name: 'تشغيل' })).toBeEnabled();
  await expect(host.getByRole('button', { name: 'إيقاف' })).toBeEnabled();
  await expect(host.getByLabel('التقديم في الفيديو')).toBeVisible();
  await expect(host.getByLabel('التقديم في الفيديو')).toBeEnabled();
  await host.getByRole('button', { name: 'تشغيل' }).click();
  await host.getByRole('button', { name: 'إيقاف' }).click();
  const seek = host.getByLabel('التقديم في الفيديو');
  await seek.evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, '42');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(viewer.getByRole('button', { name: 'تشغيل' })).toHaveCount(0);
  await expect(viewer.getByLabel('التقديم في الفيديو')).toHaveCount(0);
  await expect(viewer.getByTestId('video-player')).not.toHaveAttribute('controls', 'true');
  const token = await host.evaluate(
    (id) => JSON.parse(sessionStorage.getItem(`watch-with-me:${id}`)!).token,
    roomId,
  );
  const state = await request.get(`http://127.0.0.1:4000/api/rooms/${roomId}/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(state.ok()).toBeTruthy();
  // The seek command is delivered over Socket.IO; do not race its async
  // commit by reading the HTTP snapshot immediately after the input event.
  await expect
    .poll(
      async () => {
        const response = await request.get(`http://127.0.0.1:4000/api/rooms/${roomId}/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return (await response.json()).snapshot.positionSeconds;
      },
      { timeout: 15_000, message: 'Host seek must be committed before the state is asserted' },
    )
    .toBe(42);
  await expect(viewer.locator('body')).toHaveCSS('overflow-x', 'visible');
  await host.close();
  await viewer.close();
});

test('room pages are noindex and health endpoints respond', async ({ request }) => {
  const created = await request.post('http://127.0.0.1:4000/api/rooms', {
    data: { displayName: 'Meta' },
  });
  const room = await created.json();
  const page = await request.get(`/room/${room.roomId}`);
  expect(page.ok()).toBeTruthy();
  expect((await page.text()).toLowerCase()).toContain('noindex');
  for (const endpoint of ['/health/live', '/health/ready']) {
    const response = await request.get(`http://127.0.0.1:4000${endpoint}`);
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).status).toBe('ok');
  }
});
