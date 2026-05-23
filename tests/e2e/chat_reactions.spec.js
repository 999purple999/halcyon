// HALCYON e2e (): reactions emoji sui messaggi della chat.
import { test, expect } from '@playwright/test';

const ROOM_URL = 'https://localhost:8443';

async function joinAs(page, nickname) {
  await page.goto(ROOM_URL);
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });
  await page.fill('#nickname', nickname);
  await page.click('#join-btn');
  await page.waitForSelector('#room-screen:not(.hidden)');
  await expect(page.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 10_000,
  });
}

test('Alice manda messaggio, Bob reagisce, Alice vede la reaction', async ({ browser }) => {
  test.setTimeout(60_000);
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await joinAs(pageA, 'Alice');
  await joinAs(pageB, 'Bob');

  await pageA.click('#chat-toggle');
  await pageA.fill('#chat-input', 'msg per reaction test');
  await pageA.locator('#chat-input').press('Enter');
  await pageA.waitForFunction(
    () => (window.__ar?.chat?.()?.messages || []).some((m) => m.text.includes('msg per reaction')),
    null,
    { timeout: 10_000 },
  );

  // Bob apre chat, trova messaggio, manda reaction via API esposta
  await pageB.click('#chat-toggle');
  await pageB.waitForFunction(
    () => (window.__ar?.chat?.()?.messages || []).some((m) => m.text.includes('msg per reaction')),
    null,
    { timeout: 10_000 },
  );
  const msgId = await pageB.evaluate(() => {
    const m = window.__ar.chat().messages.find((x) => x.text.includes('msg per reaction'));
    return m?.id;
  });
  expect(msgId).toBeDefined();

  // Bob clicca emoji 🎉 dal quick picker (sempre presente, opacity 0 ma click ok)
  await pageB.evaluate((id) => {
    const el = document.querySelector(
      `.chat-msg[data-id="${id}"] .chat-quick-react[data-emoji="🎉"]`,
    );
    el?.click();
  }, msgId);

  // Alice deve vedere la reaction
  await pageA.waitForFunction(
    (id) => {
      const m = window.__ar.chat().messages.find((x) => x.id === id);
      return m?.reactions && m.reactions['🎉']?.count === 1;
    },
    msgId,
    { timeout: 10_000 },
  );

  const aliceHtml = await pageA
    .locator(`#chat-list .chat-msg[data-id="${msgId}"] .chat-reactions`)
    .innerHTML();
  expect(aliceHtml).toMatch(/🎉/);
  expect(aliceHtml).toMatch(/r-count">1</);

  // Bob ri-clicca = togglie off
  await pageB.evaluate((id) => {
    const el = document.querySelector(
      `.chat-msg[data-id="${id}"] .chat-quick-react[data-emoji="🎉"]`,
    );
    el?.click();
  }, msgId);

  await pageA.waitForFunction(
    (id) => {
      const m = window.__ar.chat().messages.find((x) => x.id === id);
      return !m?.reactions?.['🎉'] || m.reactions['🎉'].count === 0;
    },
    msgId,
    { timeout: 10_000 },
  );

  await ctxA.close();
  await ctxB.close();
});
