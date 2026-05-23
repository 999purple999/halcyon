// HALCYON e2e (): chat testuale per-stanza fra due peer.
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

test('Alice manda messaggio, Bob lo riceve nel drawer', async ({ browser }) => {
  test.setTimeout(60_000);
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await joinAs(pageA, 'Alice');
  await joinAs(pageB, 'Bob');

  // Alice apre la chat
  await pageA.click('#chat-toggle');
  await expect(pageA.locator('#chat-drawer')).toHaveClass(/open/);

  // Alice scrive e invia con Enter
  await pageA.fill('#chat-input', 'Ciao Bob, **funziona** la chat!');
  await pageA.locator('#chat-input').press('Enter');

  // Bob deve ricevere il messaggio (anche senza aprire il drawer la lista
  // viene popolata; il badge unread sale)
  await pageB.waitForFunction(
    () => (window.__ar?.chat?.()?.messages || []).some((m) => m.text.includes('funziona')),
    null,
    { timeout: 10_000 },
  );

  // Bob apre la chat, vede il messaggio renderizzato con markdown
  await pageB.click('#chat-toggle');
  const bobChat = await pageB.evaluate(() => window.__ar.chat());
  expect(bobChat.messages.length).toBeGreaterThanOrEqual(1);
  expect(bobChat.messages.some((m) => m.fromName === 'Alice')).toBe(true);

  // Il bold markdown e' presente nel DOM di Bob (post-render)
  const html = await pageB.locator('#chat-list').innerHTML();
  expect(html).toMatch(/<strong>funziona<\/strong>/);

  // Bob risponde, Alice riceve
  await pageB.fill('#chat-input', 'Ricevuto, grazie @alice!');
  await pageB.locator('#chat-input').press('Enter');
  await pageA.waitForFunction(
    () => (window.__ar?.chat?.()?.messages || []).some((m) => m.text.includes('Ricevuto')),
    null,
    { timeout: 10_000 },
  );
  const aliceHtml = await pageA.locator('#chat-list').innerHTML();
  expect(aliceHtml).toMatch(/<span class="mention">@alice<\/span>/);

  // Nessun errore
  expect(await pageA.evaluate(() => window.__ar?.state?.errors?.length || 0)).toBe(0);
  expect(await pageB.evaluate(() => window.__ar?.state?.errors?.length || 0)).toBe(0);

  await ctxA.close();
  await ctxB.close();
});

test('chat history persiste fra reload', async ({ browser }) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  await joinAs(page, 'Marco');
  await page.fill('#chat-input', 'messaggio test history');
  await page.locator('#chat-toggle').click();
  await page.locator('#chat-input').press('Enter');
  // Attendiamo l'eco
  await page.waitForFunction(
    () =>
      (window.__ar?.chat?.()?.messages || []).some((m) =>
        m.text.includes('messaggio test history'),
      ),
    null,
    { timeout: 10_000 },
  );

  // Reload: la history deve essere ripopolata dal server
  await page.reload();
  await joinAs(page, 'Marco');
  await page.waitForFunction(
    () =>
      (window.__ar?.chat?.()?.messages || []).some((m) =>
        m.text.includes('messaggio test history'),
      ),
    null,
    { timeout: 10_000 },
  );

  await ctx.close();
});
