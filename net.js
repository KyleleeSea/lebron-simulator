'use strict';
// ---------------------------------------------------------------------------
// net.js — PeerJS transport + deterministic lockstep driver.
// ---------------------------------------------------------------------------
const NET = (() => {
  const PREFIX = 'lbsim-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeCode() {
    const a = new Uint8Array(5); crypto.getRandomValues(a);
    return Array.from(a, v => CODE_CHARS[v % CODE_CHARS.length]).join('');
  }
  function peerOpts() { return { debug: 1, config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' } ] } }; }

  // Transport: exactly one data connection to the other player.
  class Transport {
    constructor(handlers) { this.h = handlers; this.peer = null; this.conn = null; this.closed = false; }
    host(code) {
      return new Promise((resolve, reject) => {
        this.peer = new Peer(PREFIX + code, peerOpts());
        this.peer.on('open', () => resolve(code));
        this.peer.on('error', e => { if (!this.conn) reject(e); this.h.onError && this.h.onError(e); });
        this.peer.on('disconnected', () => { if (!this.closed) try { this.peer.reconnect(); } catch (_) {} });
        this.peer.on('connection', c => {
          if (this.conn) { c.close(); return; }
          this._wire(c);
        });
      });
    }
    join(code) {
      return new Promise((resolve, reject) => {
        this.peer = new Peer(peerOpts());
        this.peer.on('error', e => { if (!this.conn || !this.conn.open) reject(e); this.h.onError && this.h.onError(e); });
        this.peer.on('disconnected', () => { if (!this.closed) try { this.peer.reconnect(); } catch (_) {} });
        this.peer.on('open', () => {
          const c = this.peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
          const timer = setTimeout(() => { if (!c.open) reject(new Error('Could not reach lobby ' + code)); }, 12000);
          c.on('open', () => { clearTimeout(timer); resolve(code); });
          this._wire(c);
        });
      });
    }
    _wire(c) {
      this.conn = c;
      c.on('open', () => this.h.onOpen && this.h.onOpen());
      c.on('data', d => this.h.onData && this.h.onData(d));
      c.on('close', () => this.h.onClose && this.h.onClose());
      c.on('error', e => this.h.onError && this.h.onError(e));
    }
    send(obj) { if (this.conn && this.conn.open) { try { this.conn.send(obj); } catch (e) { console.warn('send failed', e); } } }
    get open() { return !!(this.conn && this.conn.open); }
    destroy() { this.closed = true; try { this.conn && this.conn.close(); } catch (_) {} try { this.peer && this.peer.destroy(); } catch (_) {} }
  }

  // Lockstep driver. Tick N is simulated only once both players' inputs for
  // tick N are known. Local input for tick N is produced at tick N-delay and
  // sent immediately (with the previous few inputs for redundancy).
  class Lockstep {
    constructor(opts) {
      this.sim = opts.sim; this.state = opts.state; this.local = opts.local; this.delay = opts.delay;
      this.send = opts.send; this.sample = opts.sample; this.onEvents = opts.onEvents; this.onDesync = opts.onDesync;
      this.solo = !!opts.solo; this.isHost = !!opts.isHost;
      this.inputs = [new Map(), new Map()];
      this.tick = 0; this.acc = 0; this.last = -1; this.alpha = 0;
      this.stalled = false; this.stallSince = 0; this.remoteTick = 0;
      this.hashes = new Map(); this.remoteHashes = new Map();
      this.desynced = false; this.resyncPending = false;
      this.prev = null; this.TICK_MS = 1000 / this.sim.TPS;
      this.stats = { steps: 0, stalls: 0, resyncs: 0 };
    }
    remoteInput(t) {
      if (this.solo) return this.sim.EMPTY_INPUT;
      if (t < this.delay) return this.sim.EMPTY_INPUT;
      return this.inputs[1 - this.local].get(t) || null;
    }
    localInput(t) { if (t < this.delay) return this.sim.EMPTY_INPUT; return this.inputs[this.local].get(t) || this.sim.EMPTY_INPUT; }
    ensureLocal(t) {
      const m = this.inputs[this.local];
      if (m.has(t)) return;
      m.set(t, this.sample(t));
      if (!this.solo) {
        const d = [];
        for (let k = t - 5; k <= t; k++) if (m.has(k) && k >= this.delay) d.push([k, ...m.get(k)]);
        const msg = { t: 'i', d };
        if (this.pendingHash) { msg.h = this.pendingHash; this.pendingHash = null; }
        this.send(msg);
      }
    }
    onMessage(msg) {
      if (msg.t === 'i') {
        const m = this.inputs[1 - this.local];
        for (const r of msg.d) { if (!m.has(r[0])) m.set(r[0], r.slice(1)); if (r[0] > this.remoteTick) this.remoteTick = r[0]; }
        if (msg.h) this.noteRemoteHash(msg.h[0], msg.h[1]);
      } else if (msg.t === 'rs') { // resync request -> host sends snapshot
        if (this.isHost) this.send({ t: 'ss', tick: this.tick, state: JSON.stringify(this.state) });
      } else if (msg.t === 'ss') {
        this.state = JSON.parse(msg.state); this.tick = msg.tick; this.prev = null;
        this.hashes.clear(); this.remoteHashes.clear(); this.desynced = false; this.resyncPending = false;
        this.stats.resyncs++;
      }
    }
    noteRemoteHash(t, h) {
      this.remoteHashes.set(t, h);
      this.checkHash(t);
    }
    checkHash(t) {
      if (!this.hashes.has(t) || !this.remoteHashes.has(t)) return;
      const ok = this.hashes.get(t) === this.remoteHashes.get(t);
      if (!ok) { this.lastMismatch = { t, local: this.hashes.get(t), remote: this.remoteHashes.get(t) }; console.warn('lockstep hash mismatch', this.lastMismatch); }
      this.hashes.delete(t); this.remoteHashes.delete(t);
      if (!ok && !this.resyncPending) {
        this.desynced = true; this.resyncPending = true;
        this.onDesync && this.onDesync(t);
        if (!this.isHost) this.send({ t: 'rs' });
        else this.send({ t: 'ss', tick: this.tick, state: JSON.stringify(this.state) });
        setTimeout(() => { this.resyncPending = false; }, 3000);
      }
    }
    frame(now) {
      if (this.last < 0) this.last = now;
      let dt = now - this.last; this.last = now;
      if (dt > 250) dt = 250;
      this.acc += dt;
      // if the remote is far ahead of us, run faster to catch up
      const behind = this.remoteTick - this.delay - this.tick;
      const maxSteps = behind > 3 ? 4 : 2;
      if (this.acc > this.TICK_MS * 3) this.acc = this.TICK_MS * 3;
      let steps = 0;
      this.stalled = false;
      while (this.acc >= this.TICK_MS && steps < maxSteps) {
        this.ensureLocal(this.tick + this.delay);
        const rin = this.remoteInput(this.tick);
        if (rin === null) { this.stalled = true; if (!this.stallSince) this.stallSince = now; this.stats.stalls++; this.acc = this.TICK_MS; break; }
        this.stallSince = 0;
        const lin = this.localInput(this.tick);
        const ins = this.local === 0 ? [lin, rin] : [rin, lin];
        this.prev = snapshotPositions(this.state);
        const ev = this.sim.step(this.state, ins);
        this.tick++; this.acc -= this.TICK_MS; steps++; this.stats.steps++;
        if (this.tick % 20 === 0 && !this.solo) {
          const h = this.sim.hashState(this.state);
          this.hashes.set(this.tick, h); this.pendingHash = [this.tick, h];
          if (this.debug) { this.snaps = this.snaps || new Map(); this.snaps.set(this.tick, JSON.stringify(this.state)); for (const k of this.snaps.keys()) if (k < this.tick - 200) this.snaps.delete(k); }
          this.checkHash(this.tick);
        }
        if (ev.length) this.onEvents(ev);
        // prune
        if (this.tick % 60 === 0) {
          for (const m of this.inputs) for (const k of m.keys()) if (k < this.tick - 400) m.delete(k);
          for (const k of this.hashes.keys()) if (k < this.tick - 400) this.hashes.delete(k);
          for (const k of this.remoteHashes.keys()) if (k < this.tick - 400) this.remoteHashes.delete(k);
        }
      }
      this.alpha = this.stalled ? 1 : Math.min(1, this.acc / this.TICK_MS);
      this.stallMs = this.stalled && this.stallSince ? now - this.stallSince : 0;
    }
  }
  function snapshotPositions(s) {
    return { p: s.players.map(p => [p.x, p.y]), b: [s.ball.x, s.ball.y, s.ball.st], c: s.crowd.map(c => [c.x, c.y]), phase: s.phase };
  }
  return { Transport, Lockstep, makeCode };
})();
