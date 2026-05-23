// HALCYON e2e (): identita' persistente.
// Verifichiamo che dopo un page.reload() lo userId resti stabile e che il
// nickname (parte del profile) precompili la form di join.
import { test, expect } from '@playwright/test';

const ROOM_URL = 'https://localhost:8443';

test('userId stabile fra reload + nickname precompilato', async ({ page }) => {
  await page.goto(ROOM_URL);
  // Aspetta che __ar.profile() sia disponibile (loadProfile async)
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });

  const firstProfile = await page.evaluate(() => window.__ar.profile());
  expect(firstProfile.userId).toMatch(/^[0-9a-f-]{20,}$|^sess-/i);

  // Compila il nickname (trigger save debounced 500ms)
  await page.fill('#nickname', 'PersistedAlice');
  // Aspetta la flush (un po' oltre il debounce)
  await page.waitForTimeout(900);

  // Reload
  await page.reload();
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });

  const secondProfile = await page.evaluate(() => window.__ar.profile());
  expect(secondProfile.userId).toBe(firstProfile.userId);
  expect(secondProfile.data.nickname).toBe('PersistedAlice');

  // E il campo #nickname deve essere stato precompilato
  await expect(page.locator('#nickname')).toHaveValue('PersistedAlice');
});

test('profile fluctuante: server sincrono con localStorage', async ({ page }) => {
  await page.goto(ROOM_URL);
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });
  const uid = await page.evaluate(() => window.__ar.profile().userId);

  // PUT diretto via API (simula un altro device o un seed manuale)
  const newSettings = { nickname: 'SeededName', aecOn: false, theme: 'cyberpunk' };
  const r = await page.request.put(`${ROOM_URL}/api/settings`, {
    headers: { 'Content-Type': 'application/json' },
    data: { userId: uid, settings: newSettings },
  });
  expect(r.ok()).toBe(true);

  // Reload: il client deve fetcharlo dal server e applicarlo
  await page.reload();
  await page.waitForFunction(
    () => window.__ar?.profile?.()?.data?.nickname === 'SeededName',
    null,
    { timeout: 10_000 },
  );

  const p = await page.evaluate(() => window.__ar.profile());
  expect(p.data.nickname).toBe('SeededName');
  expect(p.data.aecOn).toBe(false);
  expect(p.data.theme).toBe('cyberpunk');
});
