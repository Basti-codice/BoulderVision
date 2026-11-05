// Phone-as-camera over WebRTC (PeerJS). Only the tiny signalling handshake goes through the PeerJS cloud broker;
// the video itself flows peer-to-peer (LAN when both are on the same network).
import Peer from 'peerjs';
import qrcode from 'qrcode-generator';

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export const phoneIdFromHash = () => (location.hash.match(/phone=([\w-]+)/) || [])[1] || null;

/** Laptop side: waits for a phone to call and hands the MediaStream to onStream. */
export class PhoneReceiver {
  constructor({ onStream, onState }) { this.onStream = onStream; this.onState = onState; this.peer = null; }
  start(baseUrl) {
    this.stop();
    return new Promise((resolve, reject) => {
      this.onState('waiting-broker');
      const peer = new Peer(undefined, { debug: 0 });
      this.peer = peer;
      peer.on('open', (id) => {
        const url = `${baseUrl.replace(/#.*$/, '')}#phone=${id}`;
        this.onState('waiting-phone');
        resolve({ id, url });
      });
      peer.on('call', (call) => {
        call.answer();
        call.on('stream', (s) => { this.onState('streaming'); this.onStream(s); });
        call.on('close', () => this.onState('closed'));
      });
      peer.on('error', (e) => { this.onState('error', e.type || e.message); reject(e); });
      peer.on('disconnected', () => this.onState('broker-lost'));
    });
  }
  stop() { this.peer?.destroy(); this.peer = null; }
}

/** Phone side: renders a minimal page into `root` and streams the rear camera to the laptop. */
export function runPhoneSender(root, laptopId) {
  root.innerHTML = `
  <div class="phone">
    <h1>BoulderVision camera</h1>
    <p class="muted">Mount the phone on the tripod, then start. Keep this page open and the screen on.</p>
    <video playsinline muted autoplay></video>
    <div class="row"><select id="res"><option value="1080">1080p</option><option value="720">720p</option><option value="2160">4K (if supported)</option></select>
    <button id="flip" class="btn">Flip camera</button></div>
    <button id="go" class="btn primary big">Start streaming</button>
    <p id="msg" class="muted">Not started.</p>
  </div>`;
  const $ = (s) => root.querySelector(s), video = $('video'), msg = $('#msg');
  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  if (!secure) {
    $('#go').disabled = true; $('#flip').disabled = true;
    msg.style.color = '#ff9aa4';
    msg.innerHTML = `This page was opened over <b>${location.protocol.replace(':', '')}</b>, and phone browsers only allow the camera on <b>https</b>.<br><br>
      On the laptop: stop the server, run <b>npm run dev:phone</b>, open the printed <b>https</b> address, create a new pairing code and scan it again.
      The phone shows a certificate warning once: choose Advanced, then continue.`;
    const info = document.createElement('p'); info.className = 'muted'; info.style.fontSize = '11px'; info.style.wordBreak = 'break-all';
    info.textContent = `Diagnostics: ${location.href} | secure context: ${window.isSecureContext} | camera API: ${!!navigator.mediaDevices}`;
    root.querySelector('.phone').appendChild(info);
    return;
  }
  let facing = 'environment', stream = null, peer = null, call = null, wake = null;
  const say = (t) => { msg.textContent = t; };
  async function start() {
    try {
      stream?.getTracks().forEach((t) => t.stop());
      const h = +$('#res').value, w = Math.round((h * 16) / 9);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } }, audio: false });
      stream.getVideoTracks()[0].contentHint = 'detail';
      video.srcObject = stream;
      const s = stream.getVideoTracks()[0].getSettings();
      say(`Camera ${s.width}x${s.height}. Connecting to laptop...`);
      stream.getVideoTracks()[0].addEventListener('ended', () => say('Camera stopped. Tap Start streaming again.'));
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
      peer?.destroy();
      peer = new Peer(undefined, { debug: 0 });
      peer.on('open', () => {
        call = peer.call(laptopId, stream);
        call.on('stream', () => {});
        const poll = setInterval(() => {
          const pc = call.peerConnection;
          if (!pc) return;
          if (pc.connectionState === 'connected') {
            say(`Streaming ${s.width}x${s.height} to the laptop.`);
            pc.getSenders().forEach((snd) => { try { const p = snd.getParameters(); if (!p.encodings?.length) p.encodings = [{}]; p.encodings[0].maxBitrate = 8e6; snd.setParameters(p); } catch { /* optional */ } });
            clearInterval(poll);
          }
          if (pc.connectionState === 'failed') { say('Connection failed. Both devices should be on the same network.'); clearInterval(poll); }
        }, 500);
      });
      peer.on('error', (e) => say(`Error: ${e.type || e.message}`));
    } catch (e) { say(`Camera error: ${e.message}`); }
  }
  $('#go').onclick = start;
  $('#flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; if (stream) start(); };
}
