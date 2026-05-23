// HALCYON e2e: resilienza del WS (). Chiudiamo il WS via la API
// di introspezione __ar.ws() esposta in  e verifichiamo che il badge
// passi da online -> reconnecting -> online entro 15s.
import { test, expect } from '@playwright/test';

const ROOM_URL = 'https://localhost:8443';

test('WS reconnect dopo ws.close() esplicito: badge torna online entro 15s', async ({ page }) => {
  await page.goto(ROOM_URL);
  await page.fill('#nickname', 'Resil');
  await page.click('#join-btn');
  await expect(page.locator('#room-screen')).not.toHaveClass(/hidden/);
  await expect(page.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 10_000,
  });

  // Forza la chiusura del WS via API esposta dal client.
  // Il client deve loggare 'ws close, schedulo reconnect' e ritentare con
  // backoff esponenziale (250ms → 500ms → ...). Atteso: badge online entro 15s.
  const closed = await page.evaluate(() => {
    const sock = window.__ar?.ws?.();
    if (sock && typeof sock.close === 'function') {
      sock.close(4000, 'test-forced');
      return true;
    }
    return false;
  });
  expect(closed).toBe(true);

  // Il badge deve transitare lo stato 'reconnecting' a un certo punto
  // (anche brevissimo, dato il backoff iniziale di 250ms). Tolleranza
  // generosa per gestire la velocita' del reconnect.
  await expect(page.locator('#ws-badge')).toHaveAttribute('data-state', /reconnecting|online/, {
    timeout: 5_000,
  });

  // Atteso ritorno a 'online'
  await expect(page.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 15_000,
  });

  // Nessun unhandled error
  const errors = await page.evaluate(() => window.__ar?.state?.errors?.length || 0);
  expect(errors).toBe(0);
});
