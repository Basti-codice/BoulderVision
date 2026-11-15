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

## When something is off

Press **Save debug report** (bottom of the left panel) right after the problem and keep the file. It contains the frame
rate, Bluetooth timing, detection and LED statistics, the hold/LED map and the last events and errors. Tick *include a
camera image* if the problem is about what the camera sees.

## Games (smoke test of the whole chain)

Live -> *Game* -> **Coins**: two lit holds appear on screen and on the board; grab one with a hand: it flashes green and a
new one appears. **Dodge**: a red bar falls; it must never light more than about half of the wall width. If hands/feet do not
score, adjust *Feet/Hands: shift up* in the Live panel first.

