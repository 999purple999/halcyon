# HALCYON troubleshooting

## "Two peers connect but I hear nothing and the latency badge stays — ms"

The WebSocket signaling worked (both names appeared in the room), and the
audio track even attached, but no media flows and the top-left badge says
`— ms`. This means **ICE never reached a working candidate-pair**: the
peers cannot reach each other on a shared network path.

This is **not a halcyon bug**. The included e2e test (`tests/e2e/ice_media_flow.spec.js`)
proves halcyon's RTC code works correctly between two browser contexts on
the same machine. The failure happens at the network layer.

Common causes, in order of likelihood:

1. **You and your peer are on different networks.** LAN-first means "use it
   on the same Wi-Fi". When two peers are on different routers, their LAN
   IP host candidates do not reach each other and there is no relay.
2. **Symmetric NAT or carrier-grade NAT** (mobile hotspots, university
   networks, hotel Wi-Fi). STUN cannot punch through symmetric NAT; only
   a TURN relay can.
3. **UDP blocked by a firewall.** Some corporate or school networks drop
   UDP entirely; only a TURN-over-TCP relay survives.

### Fixes

**Option A: put both peers on the same network (recommended for LAN-first
usage).** Both on the same Wi-Fi or wired LAN. Confirm with a quick ping
in the terminal.

**Option B: install Tailscale on both machines.** Tailscale puts both
peers on a single virtual LAN over WireGuard with zero config. Halcyon
sees Tailscale peers as if they were on the same LAN and ICE host
candidates work immediately. Free for personal use, runs on Windows /
macOS / Linux / iOS / Android.

1. https://tailscale.com -> install + sign in on both machines.
2. On the host: `npm start` -> open `https://<your-tailscale-ip>:8443`.
3. Send your peer the same URL.

**Option C: supply your own TURN server.** If you have access to a
`coturn` server on a public IP (typical setup: a 5 EUR VPS), pass the
TURN config via URL params or window globals before joining:

```
https://localhost:8443/?turn=turn:turn.yourdomain.com:3478&turnUser=alice&turnPass=secret
```

Or in a `<script>` tag before `app.js`:

```html
<script>
  window.HALCYON_TURN = 'turn:turn.yourdomain.com:3478';
  window.HALCYON_TURN_USER = 'alice';
  window.HALCYON_TURN_PASS = 'secret';
</script>
```

Halcyon will add it to the ICE config. ICE still tries direct host /
STUN paths first; the TURN relay only kicks in when nothing else works.

### How to diagnose

Open DevTools, console. After joining:

- `[sig] peer=X setRemoteDescription type=offer` -> SDP exchange started
- `[sig] peer=X sending answer` -> your side answered
- `[ice] peer=X gathering=complete` -> all ICE candidates collected
- `[ice] peer=X state=checking` -> ICE is trying candidate pairs
- `[ice] peer=X state=connected` -> a pair worked, media should flow
- `[pc] peer=X conn=connected` -> peer connection is live (toast pops up)

If the sequence stops at `state=checking` for more than 15 seconds and
then goes to `state=failed`, you have hit one of the network conditions
above. Apply one of the fixes.

For deeper inspection: `chrome://webrtc-internals/` shows every candidate
pair attempted and why they failed.

## "Test beep does not play"

The test beep is a local AudioContext oscillator: it does not touch
WebRTC. If you cannot hear it, the issue is OS-level audio routing.

1. Check the output device selected in the topbar Audio dropdown.
   Picking a device that is not where you are listening (e.g. a
   BEHRINGER MAIN OUT going to studio monitors that are off) silences
   everything. Switch to `Default` and try again.
2. Check Chrome tab mute: right-click on the browser tab, look for
   "Unmute site".
3. Check Windows volume mixer (right-click speaker icon) and make sure
   the browser is not muted there.

## "Microphone prompt never appears anymore"

The browser cached a "block" decision for the origin. Visit
`chrome://settings/content/microphone`, find the halcyon origin, set it
back to Ask, reload.

If that does not help, in DevTools -> Application -> Service Workers ->
Unregister, then Storage -> Clear site data, then reload.
