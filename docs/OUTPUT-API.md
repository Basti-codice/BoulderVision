# Output interface

Every contact change is published as an event. The same events go to all enabled outputs.

## WebSocket (client)

The app connects to the URL you enter (`ws://host:port`) and sends JSON text frames. It reconnects automatically.

On connect:

```json
{"type":"hello","app":"bouldervision","version":1,
 "wall":{"widthM":3.6,"heightM":3.6},
 "holds":[{"id":17,"label":17,"led":212,"x":0.4123,"y":0.8821,"xCm":148,"yCm":42,"diaCm":6.1}, ...]}
```

`x`, `y` are 0..1 from the top-left of the straightened wall; `xCm`, `yCm` are centimetres from the bottom-left.
`led` is the LED position (Kilter mode) or `null`.

On every contact change (one per limb):

```json
{"type":"contact","t":18342.5,"limb":"LH","hold":17,"holdId":17,"led":212,"on":true}
```

* `limb`: `LH` / `RH` (hands), `LF` / `RF` (feet), left/right as seen from the climber.
* `t`: milliseconds since live tracking started.
* `hold`: the hold's number (label). `holdId` is the internal id, stable within a profile.

After each change, a snapshot of all four limbs:

```json
{"type":"state","t":18342.5,"contacts":{"LH":{"hold":17,"holdId":17,"led":212},"RH":null,"LF":{"hold":3,"holdId":3,"led":14},"RF":null}}
```

Minimal receiver (Node):

```js
import { WebSocketServer } from 'ws';
new WebSocketServer({ port: 8765 }).on('connection', (s) => s.on('message', (m) => console.log(JSON.parse(m))));
```

## Web Serial (Arduino, ESP32, ...)

One text line per contact event at 115200 baud:

```
C,<limb>,<hold>,<led or -1>,<1 = on, 0 = off>\n
```

Example: `C,LH,17,212,1`.

## Aurora / Kilter board

With *Light the holds hands and feet are on* enabled, hands are lit cyan and feet orange. Only the LEDs of held
holds are on; everything else is switched off.

## Files

* **Hold map**: `Export hold map (JSON)` writes the `holds` message above.
* **Session**: JSON (`{"format":"bouldervision-session","events":[...]}`) or CSV (`t_ms,limb,hold,led,on`).
* **Profile**: Export/Import in the profile menu (corners, holds, LED map, wall snapshot).
