# First run on real hardware

The logic is covered by automated tests and a simulated wall, but nothing here could be run against a real board or a
real climber while this was written. Go through this list once and note anything that differs.

## Aurora board protocol (check in the Board step)

1. **Connect**: the picker lists your board. If it stays empty, the board may not advertise the service UUID. The app
   then falls back to devices named `Kilter…`/`Aurora…`.
2. **Click a hold** in the wall view (Board step): exactly that LED should light, green. Click again to turn it off.
3. **Clear**: press *All lights off*. All LEDs should go dark.
   If some stay lit, the board ignores empty frames; the app already sends explicit black entries, so report it.
4. **Frame semantics**: scan LEDs, then light-test two holds one after the other. If the first one stays lit, the
   board merges frames instead of replacing them. The app is written to work either way, but tell me.
5. **Speed**: during the scan the status line shows progress. A full scan (500 LED positions) should take 1 to 2 minutes.
   If the board drops frames (LEDs missing or wrong), the app slows down automatically; if it still fails, rescan.
6. **Reconnect**: switch the board off and on during live mode. The app retries 6 times.

## LED scan

* The scan lights at most about 30 LEDs at a time (row/column patterns), so a weak power supply should not sag. If the
  LEDs still look dim during the scan, tell me the LED count and what the board does.
* Hold numbers are always consecutive (start at 0 or 1, your choice). The LED position is shown separately.

* Keep people out of the camera view and lock the phone's exposure (the *Lock* option, or disable auto-exposure in
  the camera app). Room lights should not flicker or change.
* After the scan the Board step reports how many LEDs were found and a verification score (aim for above 97 %).
  Amber dots in the wall view are low-confidence LEDs.
* Dashed circles = an LED whose hold was not detected (empty hole or a hold the detector missed).

## Live tracking

* The camera usually sees the climber from behind. Check that the labelled hands follow the right hands; if left/right are
  swapped, use *Swap left / right* or change *Climber faces*.
* If contacts flicker, raise *Contact tolerance* a little. If hands seem to touch holds they only pass, lower it.
* If the frame rate is low (< 15 fps), choose *Lite* or *Full* instead of *Heavy*.

## Phone as camera

The phone must open the app over **HTTPS** (browsers block the camera on plain http) and reach the laptop over Wi-Fi.

1. Start the laptop with `npm run dev:phone` and open the **https** address it prints (accept the certificate warning once).
2. Camera -> Phone (QR): the address of the laptop in your Wi-Fi is filled in automatically. Click *Create pairing code*.
3. Scan the QR code with the phone, accept the certificate warning (Advanced -> continue), allow the camera, tap *Start streaming*.

Pairing needs internet (PeerJS cloud broker, only for the handshake); the video then flows directly phone to laptop.
Windows may ask whether Node.js may use private networks: allow it. Not tested with real devices here.
Alternative without certificate warning: serve a built copy from a hosted HTTPS address (e.g. GitHub Pages) and enter it as the app address.
