# BoulderVision

Browser app that watches a climbing wall with a fixed camera. It finds the holds, and in live mode tracks one climber
and shows which hold each hand and foot is on. An optional **Kilter mode** talks to an Aurora/Kilter LED board
over Web Bluetooth: it learns which LED belongs to which hold, and can light the holds you are touching.

Everything runs locally in the browser. There is no backend.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173  (camera and Bluetooth work on localhost)
```

Use **Chrome or Edge** (Web Bluetooth and Web Serial are not available in Firefox/Safari).
For a hosted copy, build with `npm run build` and serve `dist/` over **HTTPS** (e.g. GitHub Pages).
For the phone-as-camera mode run `npm run dev:phone` instead (HTTPS with a self-signed certificate, the QR code then points to your laptop's Wi-Fi address) and open the printed https address on the laptop too.

No hardware at hand? Open the app, choose **Camera → Demo → Start demo wall**. It runs the complete workflow with a
simulated wall, a virtual LED board and a virtual climber.

## Workflow

| Step | What happens |
| --- | --- |
| **Camera** | Webcam, USB/phone webcam, phone via QR code (WebRTC), or a video/photo file. Rotate/mirror, lock exposure. |
| **Align** | Drag four handles onto the wall corners; a live straightened preview and grid show the result. Enter the real wall size. |
| **Holds** | One click detects all holds. Three filters (sensitivity, min size, max size). Select / Add / Remove tools, undo/redo, numbering. |
| **Board** (Kilter mode) | Connect over Bluetooth, scan LEDs (Gray-code patterns, ~1 min), light test by clicking a hold. |
| **Go live** | Pose tracking, contact detection, optional LED output, session recording and export. |

Profiles (one per board) store corners, holds and the LED map in IndexedDB. For a new session with the same board
you only re-mark the corners (or use **Auto-align with LEDs**) and go live.

## Kilter extras (Board step)

* **Light test**: click a hold, its LED lights.
* **Routes**: pick a role (start / hand / foot / finish) and click holds; the board shows the route live in Kilter-style
  colours. Several routes per board, saved with the profile, exportable as JSON. Roles are tied to the LED position,
  so routes survive re-detecting holds.
* **Light show**: rainbow, sweeps, sparkle, pulse and a *number walk* that lights holds in numbering order. Plays in the
  wall view even without a board; the board gets the 36 brightest LEDs per frame (Bluetooth is slow).
* **Export**: annotated image (PNG with numbered holds), hold list (CSV), hold map (JSON with LED map), and the complete
  board file (re-importable from the profile menu).

## Live tracking

* Pose: MediaPipe Pose Landmarker (heavy / full / lite, models bundled in `public/models`). *Auto* starts with the most
  accurate model and steps down when the machine cannot keep up. Runs on the GPU when available.
* A hand or foot counts as "on a hold" when its fingertip/toe stays within the contact tolerance of the hold outline
  for about 120 ms and is not just swiping past; it is released after 160 ms away. Short occlusions keep the contact.
* Only one climber is tracked (the one nearest to the previous position / the tallest inside the wall).
* Robustness: while no climber is found the app searches the wall in overlapping tiles and tries the image upright and
  rotated by 90 degrees (horizontal bodies on steep walls confuse the model); once found, a tight crop follows the
  climber and the rotation is only changed when hands/feet are clearly better visible in another orientation.
* Hold detection ignores people standing in the picture while the wall is captured (skeleton mask).

## Output interface

Contact events go to WebSocket, Web Serial (Arduino) and the board. See [docs/OUTPUT-API.md](docs/OUTPUT-API.md).

## Tests

```bash
npm test                         # unit tests (protocol, geometry, hold detection, LED decoding, contact logic)
npm run build && npx vite preview --port 4173 &
npm run e2e                      # drives the demo world in headless Chromium (needs Playwright)
```

Before using it on a real board, go through [docs/HARDWARE-CHECKLIST.md](docs/HARDWARE-CHECKLIST.md).

## Layout

```
src/core      geometry, camera sources, WebGL warp, filters, contact logic
src/cv        hold detection, LED calibration
src/board     Aurora protocol + Bluetooth/mock transports
src/pose      MediaPipe wrapper, landmarks -> limb points
src/outputs   WebSocket / Serial / board sinks, session recorder
src/sim       demo wall, LED board and climber
src/app       controller (state + workflows)     src/ui  Preact UI and stage canvas
```
