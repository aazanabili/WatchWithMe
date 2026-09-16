import { expect, test } from '@playwright/test';

const fixture = Buffer.from('AAAAFGZ0eXBtcDQyAAAAAG1wNDJpc29t', 'base64');

test('invite uses independent contexts, preserves connection, and reconnects without duplicates', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const hostContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const guestContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  for (const page of [host, guest]) {
    await page.route('https://fixtures.example.test/watch.mp4', (route) =>
      route.fulfill({ status: 200, contentType: 'video/mp4', body: fixture }),
    );
  }
  await host.goto('/create');
  await host.getByLabel('اسمك في الغرفة').fill('Host');
  await host.getByRole('button', { name: /أنشئ الغرفة/ }).click();
  await host.waitForURL(/\/room\//);
  const code = new URL(host.url()).pathname.split('/').pop()!;
  await expect(host.getByRole('button', { name: 'انسخ رابط الدعوة' })).toBeVisible();
  await host.getByRole('button', { name: 'انسخ رابط الدعوة' }).click();
  await expect(host.getByText('تم نسخ رابط الدعوة')).toBeVisible();
  const invite = await host.evaluate(() => navigator.clipboard.readText());
  expect(new URL(invite).pathname).toBe('/join');
  expect(new URL(invite).searchParams.get('room')).toBe(code);
  expect(invite).not.toContain('token');

  await guest.goto(invite);
  await expect(guest.getByLabel('رمز الغرفة')).toHaveValue(code);
  await expect(guest.getByLabel('رمز الغرفة')).toHaveAttribute('readonly', '');
  await guest.getByLabel('اسمك').fill('Guest');
  await guest.getByRole('button', { name: /ادخل الغرفة/ }).click();
  await guest.waitForURL(new RegExp(`/room/${code}$`));
  await expect(host.getByText('متصل ومتزامن')).toBeVisible();
  await expect(guest.getByText('متصل ومتزامن')).toBeVisible();
  await expect(host.locator('.kicker', { hasText: /الحاضرون/ })).toContainText('2');
  await expect(guest.locator('.kicker', { hasText: /الحاضرون/ })).toContainText('2');

  await host.selectOption('#provider', 'mp4');
  await host.getByLabel('رابط مصدر الفيديو').fill('https://fixtures.example.test/watch.mp4');
  await host.getByRole('button', { name: 'Load' }).click();
  await expect(host.getByTestId('video-player')).toBeVisible();
  await expect(guest.getByTestId('video-player')).toBeVisible();
  await host
    .getByTestId('video-player')
    .evaluate((video) => video.dispatchEvent(new Event('canplay')));
  await host.getByRole('button', { name: 'تشغيل' }).click();
  await host.getByRole('button', { name: 'إيقاف' }).click();
  await host.getByLabel('التقديم في الفيديو').fill('17');

  await host.reload();
  await guest.reload();
  await expect(host.getByText('متصل ومتزامن')).toBeVisible();
  await expect(guest.getByText('متصل ومتزامن')).toBeVisible();
  await expect(host.locator('.kicker', { hasText: /الحاضرون/ })).toContainText('2');
  await expect(guest.locator('.kicker', { hasText: /الحاضرون/ })).toContainText('2');
  await hostContext.close();
  await guestContext.close();
});

test('direct room access redirects to invite join and invalid invite reports an accessible error', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/rooms/DOES-NOT-EXIST/join', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'room_not_found' }),
    }),
  );
  await page.goto('/room/DOES-NOT-EXIST');
  await expect(page).toHaveURL(/\/join\?room=DOES-NOT-EXIST$/);
  await expect(page.getByText('تعذر تحميل الغرفة')).toHaveCount(0);
  await page.getByLabel('اسمك').fill('Nobody');
  await page.getByRole('button', { name: /ادخل الغرفة/ }).click();
  await expect(page.getByText('لم نجد هذه الغرفة')).toBeVisible();
  await context.close();
});

test('stale credentials are cleared and a viewer cannot promote itself through storage', async ({
  browser,
  request,
}) => {
  const createdResponse = await request.post('http://127.0.0.1:4000/api/rooms', {
    data: { displayName: 'Host' },
  });
  const created = await createdResponse.json();
  const guestResponse = await request.post(
    `http://127.0.0.1:4000/api/rooms/${created.roomId}/join`,
    { data: { displayName: 'Guest' } },
  );
  const guest = await guestResponse.json();
  const staleContext = await browser.newContext();
  const stale = await staleContext.newPage();
  await stale.addInitScript(
    ({ id, participantId }) =>
      sessionStorage.setItem(
        `watch-with-me:${id}`,
        JSON.stringify({ token: 'expired-token', participantId }),
      ),
    { id: created.roomId, participantId: created.participantId },
  );
  await stale.goto(`/room/${created.roomId}`);
  await expect
    .poll(() => new URL(stale.url()).pathname + new URL(stale.url()).search)
    .toBe(`/join?room=${created.roomId}`);
  await expect(
    stale.evaluate((id) => sessionStorage.getItem(`watch-with-me:${id}`), created.roomId),
  ).resolves.toBeNull();
  await staleContext.close();
  const tamperedContext = await browser.newContext();
  const tampered = await tamperedContext.newPage();
  await tampered.addInitScript(
    ({ id, token, participantId }) =>
      sessionStorage.setItem(
        `watch-with-me:${id}`,
        JSON.stringify({ token, participantId, role: 'host' }),
      ),
    { id: created.roomId, token: guest.token, participantId: created.participantId },
  );
  await tampered.goto(`/room/${created.roomId}`);
  await expect(tampered.getByText('متصل ومتزامن')).toBeVisible();
  await expect(tampered.getByRole('button', { name: 'Load' })).toHaveCount(0);
  await expect(tampered.getByRole('button', { name: 'تشغيل' })).toHaveCount(0);
  await tampered.reload();
  await expect(tampered.getByText('متصل ومتزامن')).toBeVisible();
  await expect(tampered.getByRole('button', { name: 'Load' })).toHaveCount(0);
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  await hostPage.addInitScript(
    ({ id, token, participantId }) =>
      sessionStorage.setItem(
        `watch-with-me:${id}`,
        JSON.stringify({ token, participantId, role: 'viewer' }),
      ),
    { id: created.roomId, token: created.token, participantId: created.participantId },
  );
  await hostPage.goto(`/room/${created.roomId}`);
  await expect(hostPage.getByText('متصل ومتزامن')).toBeVisible();
  await expect(hostPage.getByRole('button', { name: 'Load' })).toBeVisible();
  await hostContext.close();
  await tamperedContext.close();
});

test('clears credentials when state succeeds but the socket rejects the stale token', async ({
  browser,
  request,
}) => {
  const createdResponse = await request.post('http://127.0.0.1:4000/api/rooms', {
    data: { displayName: 'Socket host' },
  });
  const created = await createdResponse.json();
  const stateResponse = await request.get(
    `http://127.0.0.1:4000/api/rooms/${created.roomId}/state`,
    { headers: { Authorization: `Bearer ${created.token}` } },
  );
  const state = await stateResponse.json();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(
    ({ id, participantId }) =>
      sessionStorage.setItem(
        `watch-with-me:${id}`,
        JSON.stringify({ token: 'stale-socket-token', participantId }),
      ),
    { id: created.roomId, participantId: created.participantId },
  );
  await page.route(`**/api/rooms/${created.roomId}/state`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }),
  );
  await page.goto(`/room/${created.roomId}`);
  await expect
    .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
    .toBe(`/join?room=${created.roomId}`);
  await expect(
    page.evaluate((id) => sessionStorage.getItem(`watch-with-me:${id}`), created.roomId),
  ).resolves.toBeNull();
  await context.close();
});
