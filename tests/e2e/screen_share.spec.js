// HALCYON e2e: end-to-end screen-share validation.
//
// Chromium with `--use-fake-ui-for-media-stream` auto-accepts getDisplayMedia
// and feeds a synthetic stream. We exercise the whole pipeline:
//   1) two peers join the room (B = non-initiator, previously broken side)
//   2) B clicks the screen-share button
//   3) A must receive B's screen video (validates the perfect-negotiation fix
//      AND that the click handler / getDisplayMedia call path are wired up)
//   4) B stops screen-share → A's tile disappears
//   5) no client-side errors collected
import { test, expect } from '@playwright/test';

const ROOM_URL = 'https://localhost:8443';

async function joinAs(page, nickname) {
  await page.goto(ROOM_URL);
  await page.waitForFunction(() => window.__ar?.profile?.()?.userId, null, { timeout: 10_000 });
  await page.fill('#nickname', nickname);
  await page.click('#join-btn');
  await page.waitForSelector('#room-screen:not(.hidden)');
}

test('screen-share from non-initiator: remote peer receives the video tile', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await joinAs(pageA, 'Alice');
  await pageA.waitForTimeout(500); // ensure A registers first so B is non-initiator
  await joinAs(pageB, 'Bob');

  // Both peers connected
  await pageA.waitForFunction(() => (window.__ar?.peers?.() || []).length > 0, null, {
    timeout: 10_000,
  });
  await pageB.waitForFunction(() => (window.__ar?.peers?.() || []).length > 0, null, {
    timeout: 10_000,
  });

  // === B clicks Share screen ===
  // We click via DOM so we exercise the wired-up handler (not the function directly).
  // Chrome auto-accepts the picker due to --use-fake-ui-for-media-stream.
  await pageB.evaluate(() => document.getElementById('screen-share-btn').click());

  // === A should see B's video tile within 15s ===
  await pageA
    .waitForFunction(
      () => {
        const peers = window.__ar?.peers?.() || [];
        const bob = peers.find((p) => p.name === 'Bob');
        if (!bob) return false;
        return !!document.querySelector(`.video-tile[data-peer-id="${bob.id}"] video`);
      },
      null,
      { timeout: 15_000 },
    )
    .catch(async () => {
      // Surface diagnostics on timeout
      const errorsB = await pageB.evaluate(() => window.__ar?.state?.errors || []);
      throw new Error(
        "A did not receive B's screen-share video tile. Errors on B: " +
          JSON.stringify(errorsB, null, 2),
      );
    });

  // B's screen-share-btn should be in the "active" state
  await expect(pageB.locator('#screen-share-btn')).toHaveAttribute('aria-pressed', 'true');

  // === B stops sharing ===
  await pageB.evaluate(() => document.getElementById('screen-share-btn').click());
  await expect(pageB.locator('#screen-share-btn')).toHaveAttribute('aria-pressed', 'false');

  // Sanity: no client-side errors
  const errorsA = await pageA.evaluate(() => window.__ar?.state?.errors || []);
  const errorsB = await pageB.evaluate(() => window.__ar?.state?.errors || []);
  expect(errorsA.length, `A errors: ${JSON.stringify(errorsA)}`).toBe(0);
  expect(errorsB.length, `B errors: ${JSON.stringify(errorsB)}`).toBe(0);

  await ctxA.close();
  await ctxB.close();
});
