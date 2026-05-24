// HALCYON e2e: verifies the perfect-negotiation fix.
//
// The previous code attached the `negotiationneeded` listener only on the
// initiator side. When the *non-initiator* peer added a track at runtime
// (clicking camera or screen-share), the event fired but had no listener →
// no SDP offer was generated → the remote peer never saw the new track.
//
// This test:
//   1) joins two peers (A is initiator for B; B is non-initiator)
//   2) enables camera on A → B should receive A's video track
//   3) enables camera on B (the *non-initiator* — the buggy path) → A should
//      receive B's video track
//
// Camera and screen-share use the same addTrack + renegotiation code path,
// so passing camera from both sides also validates screen-share.
import { test, expect } from '@playwright/test';

const ROOM_URL = 'https://localhost:8443';

async function joinAs(page, nickname) {
  await page.goto(ROOM_URL);
  await page.fill('#nickname', nickname);
  await page.click('#join-btn');
  await expect(page.locator('#room-screen')).not.toHaveClass(/hidden/);
}

async function clickCamera(page) {
  // The button toggles via the existing event handler; cameraStream null → start.
  await page.evaluate(() => document.getElementById('camera-btn').click());
}

async function expectVideoTilesFor(page, otherName, timeoutMs = 15000) {
  // Wait until the page sees the OTHER peer's video tile rendered in #video-grid.
  // We look for a .video-tile element whose dataset.peerId matches a peer with
  // the expected name in __ar.peers().
  await page.waitForFunction(
    (otherName) => {
      const peers = window.__ar?.peers?.() || [];
      const target = peers.find((p) => p.name === otherName);
      if (!target) return false;
      return !!document.querySelector(`.video-tile[data-peer-id="${target.id}"]`);
    },
    otherName,
    { timeout: timeoutMs },
  );
}

test('bidirectional renegotiation: both peers can add a camera track at runtime', async ({
  browser,
}) => {
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await joinAs(pageA, 'Alice');
  // Slight delay so the server registers A first; B then receives A in welcome
  // and becomes the "non-initiator" (the previously broken side).
  await pageA.waitForTimeout(500);
  await joinAs(pageB, 'Bob');

  // Both peers should reach the online signaling state.
  await expect(pageA.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 10_000,
  });
  await expect(pageB.locator('#ws-badge')).toHaveAttribute('data-state', 'online', {
    timeout: 10_000,
  });

  // Both peers see each other in the peers Map.
  await pageA.waitForFunction(() => (window.__ar?.peers?.() || []).length > 0, null, {
    timeout: 10_000,
  });
  await pageB.waitForFunction(() => (window.__ar?.peers?.() || []).length > 0, null, {
    timeout: 10_000,
  });

  // === Step 1: A (initiator) enables camera. This exercises the *working*
  // path even pre-fix, because the initiator had a negotiationneeded listener. ===
  await clickCamera(pageA);
  await expectVideoTilesFor(pageB, 'Alice');

  // === Step 2: B (NON-initiator) enables camera. Pre-fix this would silently
  // fail because negotiationneeded had no listener on B's pc. Post-fix the
  // universal listener fires, B sends an offer (polite side handles glare),
  // and A receives B's video. ===
  await clickCamera(pageB);
  await expectVideoTilesFor(pageA, 'Bob');

  // Sanity: no client-side errors collected in the ring buffer.
  const errorsA = await pageA.evaluate(() => window.__ar?.state?.errors || []);
  const errorsB = await pageB.evaluate(() => window.__ar?.state?.errors || []);
  if (errorsA.length || errorsB.length) {
    // Surface the actual error messages in the test report on failure.
    test.info().attach('errors-A', {
      body: JSON.stringify(errorsA, null, 2),
      contentType: 'application/json',
    });
    test.info().attach('errors-B', {
      body: JSON.stringify(errorsB, null, 2),
      contentType: 'application/json',
    });
  }
  expect(errorsA.length, 'no errors on A').toBe(0);
  expect(errorsB.length, 'no errors on B').toBe(0);

  await ctxA.close();
  await ctxB.close();
});
