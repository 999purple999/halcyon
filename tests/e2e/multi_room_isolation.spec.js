// HALCYON e2e (): isolation chat per stanza (?room=X).
import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:8443';

async function joinAs(page, nickname, roomId) {
  await page.goto(roomId ? `${BASE}/?room=${roomId}` : BASE);
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });
  await page.fill('#nickname', nickname);
  await page.click('#join-btn');
  await page.waitForSelector('#room-screen:not(.hidden)');
  await expect(page.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 10_000,
  });
}

test('chat e2e isolata fra room A e room B', async ({ browser }) => {
  test.setTimeout(60_000);
  const ctxA1 = await browser.newContext({ permissions: ['microphone'] });
  const ctxA2 = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const pageA1 = await ctxA1.newPage();
  const pageA2 = await ctxA2.newPage();
  const pageB = await ctxB.newPage();

  await joinAs(pageA1, 'Alice1', 'roomA');
  await joinAs(pageA2, 'Alice2', 'roomA');
  await joinAs(pageB, 'BobOther', 'roomB');

  await pageA1.click('#chat-toggle');
  await pageA1.fill('#chat-input', 'messaggio SOLO in roomA');
  await pageA1.locator('#chat-input').press('Enter');

  // Alice2 (stessa room) deve riceverlo
  await pageA2.waitForFunction(
    () => (window.__ar?.chat?.()?.messages || []).some((m) => m.text.includes('SOLO in roomA')),
    null,
    { timeout: 10_000 },
  );

  // BobOther (room diversa) NON deve riceverlo entro 4s
  await pageB.waitForTimeout(4000);
  const bobMessages = await pageB.evaluate(() => window.__ar.chat().messages);
  expect(bobMessages.some((m) => m.text.includes('SOLO in roomA'))).toBe(false);

  // Bob manda in roomB: Alice non deve riceverlo
  await pageB.click('#chat-toggle');
  await pageB.fill('#chat-input', 'eco da roomB');
  await pageB.locator('#chat-input').press('Enter');
  await pageA1.waitForTimeout(3000);
  const a1messages = await pageA1.evaluate(() => window.__ar.chat().messages);
  expect(a1messages.some((m) => m.text.includes('eco da roomB'))).toBe(false);

  await ctxA1.close();
  await ctxA2.close();
  await ctxB.close();
});
