// Frame sources: webcam / phone-as-webcam (getUserMedia), WebRTC stream, video/image file, demo world.
// Everything downstream reads `source.canvas` (already rotated/mirrored), so orientation is handled in one place.

export class FrameSource extends EventTarget {
  constructor() {
    super();
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280; this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d');
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true; this.video.loop = true;
    this.kind = 'none'; this.label = ''; this.stream = null; this.image = null; this.demo = null;
    this.rotation = 0; this.mirror = false;
    this.frameId = 0; this.fps = 0; this._fpsCount = 0; this._fpsT = performance.now();
    this._pending = false; this._dirty = true; this._demoT = 0; this.alwaysFresh = false; // alwaysFresh: re-deliver still images every frame (live mode on a photo)
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = () => { this._pending = true; this.video.requestVideoFrameCallback(cb); };
      this.video.requestVideoFrameCallback(cb);
    }
  }
  get active() { return this.kind !== 'none'; }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }
  _emit() { this.dispatchEvent(new CustomEvent('change')); }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (devs.some((d) => d.kind === 'videoinput' && !d.label)) {
      try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* permission denied: list without labels */ }
    }
    return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.demo = null; this.image = null;
    this.video.pause(); this.video.srcObject = null; this.video.removeAttribute('src');
    this.kind = 'none'; this.label = '';
    this._emit();
  }

  async useCamera(deviceId, res = 1080) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost.');
    const [w, h] = res === 720 ? [1280, 720] : res === 2160 ? [3840, 2160] : [1920, 1080];
    const video = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    await this.useStream(stream, stream.getVideoTracks()[0]?.label || 'Camera', 'camera');
  }

  async useStream(stream, label, kind = 'stream') {
    if (this.kind !== 'none' && this.stream !== stream) this.stop();
    this.stream = stream; this.kind = kind; this.label = label;
    this.video.srcObject = stream;
    this.video.loop = false;
    await this.video.play();
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { this.stop(); });
    this._dirty = true; this._emit();
  }

  async useFile(file) {
    this.stop();
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read image')); img.src = url; });
      this.image = img; this.kind = 'image';
    } else {
      this.video.src = url; this.video.loop = true;
      await this.video.play();
      this.kind = 'video';
    }
    this.label = file.name; this._dirty = true; this._emit();
  }

  useDemo(world) {
    this.stop();
    this.demo = world; this.kind = 'demo'; this.label = 'Demo wall (simulated)';
    this._dirty = true; this._emit();
  }

  setOrientation({ rotation = this.rotation, mirror = this.mirror }) { this.rotation = rotation; this.mirror = mirror; this._dirty = true; }

  /** Call once per animation frame. Returns true when `canvas` holds a new frame. */
  tick(now = performance.now()) {
    let fresh = false;
    if (this.kind === 'demo') {
      this.demo.render(this._target(this.demo.width, this.demo.height), now);
      fresh = true;
    } else if (this.kind === 'image') {
      if (this._dirty || this.alwaysFresh) { this._drawSource(this.image, this.image.naturalWidth, this.image.naturalHeight); fresh = true; }
    } else if (this.kind !== 'none' && this.video.readyState >= 2 && this.video.videoWidth) {
      const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
      if (this._dirty || (hasRvfc ? this._pending : this.video.currentTime !== this._lastT)) {
        this._pending = false; this._lastT = this.video.currentTime;
        this._drawSource(this.video, this.video.videoWidth, this.video.videoHeight);
        fresh = true;
      }
    }
    this._dirty = false;
    if (fresh) {
      this.frameId++; this._fpsCount++;
      if (now - this._fpsT >= 1000) { this.fps = Math.round((this._fpsCount * 1000) / (now - this._fpsT)); this._fpsCount = 0; this._fpsT = now; this._emit(); }
    }
    return fresh;
  }

  _target(w, h) {
    const swap = this.rotation % 180 !== 0, cw = swap ? h : w, ch = swap ? w : h;
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    return this.ctx;
  }
  _drawSource(src, w, h) {
    const ctx = this._target(w, h), cw = this.canvas.width, ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((this.rotation * Math.PI) / 180);
    if (this.mirror) ctx.scale(-1, 1);
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Try to freeze exposure / white balance / focus (not every camera or browser allows it). */
  async lock(on) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return { ok: false, reason: 'This source does not support camera locking.' };
    const caps = track.getCapabilities(), st = track.getSettings(), adv = {}, done = [];
    const pick = (mode, extra) => {
      if (!caps[mode]) return;
      const want = on ? 'manual' : 'continuous';
      if (caps[mode].includes(want)) { adv[mode] = want; done.push(mode.replace('Mode', '')); if (on && extra && st[extra] != null) adv[extra] = st[extra]; }
    };
    pick('exposureMode', 'exposureTime'); pick('whiteBalanceMode', 'colorTemperature'); pick('focusMode', 'focusDistance');
    if (!done.length) return { ok: false, reason: 'This camera does not expose manual controls in the browser. Disable auto-exposure in the camera app if possible.' };
    try { await track.applyConstraints({ advanced: [adv] }); return { ok: true, locked: on, applied: done }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }
}
