'use strict';
// ---------------------------------------------------------------------------
// main.js — UI, lobby protocol, input sampling, game loop, audio.
// ---------------------------------------------------------------------------
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  const SCREENS = ['menu', 'lobby'];
  function show(name) { for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name); canvas.classList.toggle('hidden', name !== 'game'); if (name !== 'game') $('endbtns').classList.add('hidden'); }
  function banner(text, ms) { const b = $('banner'); if (!text) { b.classList.add('hidden'); return; } b.textContent = text; b.classList.remove('hidden'); if (ms) setTimeout(() => b.classList.add('hidden'), ms); }

  // ---- persistent prefs --------------------------------------------------
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('lbsim') || '{}'); } catch (_) { return {}; } })();
  function savePrefs() { try { localStorage.setItem('lbsim', JSON.stringify(prefs)); } catch (_) {} }
  $('name').value = prefs.name || '';
  const myName = () => ($('name').value.trim() || 'Player').slice(0, 12);

  // ---- audio -------------------------------------------------------------
  const AUDIO = (() => {
    let ac = null;
    function ensure() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } if (ac && ac.state === 'suspended') ac.resume(); return ac; }
    function tone(f, dur, type, vol, slide) { const a = ensure(); if (!a) return; const o = a.createOscillator(), g = a.createGain(); o.type = type || 'square'; o.frequency.value = f; if (slide) o.frequency.exponentialRampToValueAtTime(slide, a.currentTime + dur); g.gain.value = vol || 0.08; g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + dur); }
    function noise(dur, vol) { const a = ensure(); if (!a) return; const n = a.sampleRate * dur, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n); const s = a.createBufferSource(); s.buffer = buf; const g = a.createGain(); g.gain.value = vol || 0.1; s.connect(g).connect(a.destination); s.start(); }
    return { ensure, snap: () => { noise(0.08, 0.2); tone(1800, 0.05, 'square', 0.05); }, focus: () => tone(900, 0.08, 'sine', 0.04), miss: () => tone(300, 0.15, 'sawtooth', 0.04, 150),
      throw: () => noise(0.12, 0.08), bonk: () => { tone(160, 0.25, 'square', 0.12, 60); noise(0.1, 0.1); }, crowd: () => { tone(220, 0.2, 'triangle', 0.1, 110); tone(440, 0.1, 'sine', 0.05); },
      dash: () => tone(500, 0.07, 'sine', 0.03, 900), swap: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'triangle', 0.1), i * 90)); },
      end: () => { [784, 659, 523, 392].forEach((f, i) => setTimeout(() => tone(f, 0.35, 'triangle', 0.1), i * 160)); }, catch: () => tone(700, 0.08, 'sine', 0.05, 1000) };
  })();

  // ---- lobby state -------------------------------------------------------
  let transport = null, isHost = false, myIdx = 0, solo = false;
  let lobby = { cfg: Object.assign({}, SIM.DEFAULT_CFG, { perks: [{ L: 0, P: 0 }, { L: 0, P: 0 }] }), names: ['Host', '…'], ready: [false, false], connected: false };
  let myPerks = { L: prefs.perkL | 0, P: prefs.perkP | 0 };
  let rtt = null, pingTimer = null;

  function readMenuCfg() { return { minutes: +$('cMinutes').value, crowd: +$('cCrowd').value, photos: +$('cPhotos').value, prHits: +$('cPr').value, startRole: +$('cStart').value }; }
  function renderPerkPickers() {
    for (const role of ['L', 'P']) {
      const box = $('perks' + role); box.innerHTML = '';
      SIM.PERKS[role].forEach((pk, k) => {
        const d = document.createElement('div'); d.className = 'perk' + (myPerks[role] === k ? ' sel' : '');
        d.innerHTML = '<div><b>' + pk.name + '</b><br><small>' + pk.desc + '</small></div>';
        d.onclick = () => { myPerks[role] = k; prefs.perkL = myPerks.L; prefs.perkP = myPerks.P; savePrefs(); renderPerkPickers(); sendPerks(); };
        box.appendChild(d);
      });
    }
  }
  function sendPerks() {
    lobby.cfg.perks[myIdx] = { L: myPerks.L, P: myPerks.P };
    if (isHost) broadcastLobby(); else if (transport) transport.send({ t: 'perks', L: myPerks.L, P: myPerks.P });
  }
  function broadcastLobby() { if (isHost && transport) transport.send({ t: 'lobby', cfg: lobby.cfg, names: lobby.names, ready: lobby.ready }); renderLobby(); }
  function renderLobby() {
    $('lobbyRole').textContent = isHost ? 'you are host' : 'you are guest';
    $('codeWrap').classList.toggle('hidden', !isHost);
    for (let i = 0; i < 2; i++) {
      const el = $('pl' + i); const present = i === 0 || lobby.connected;
      el.textContent = (i === 0 ? 'Host: ' : 'Guest: ') + (present ? lobby.names[i] : 'waiting for a player…') + (present ? (lobby.ready[i] ? ' ✓ ready' : ' (not ready)') : '') + (i === myIdx ? ' ← you' : '');
      el.classList.toggle('ready', !!lobby.ready[i] && present);
    }
    for (const sel of document.querySelectorAll('#lobby select')) { sel.value = String(lobby.cfg[sel.dataset.k]); sel.disabled = !isHost; }
    $('settingsNote').textContent = isHost ? '' : '(host decides)';
    $('btnReady').textContent = lobby.ready[myIdx] ? 'Not ready' : "I'm ready";
    $('btnStart').classList.toggle('hidden', !isHost);
    $('btnStart').disabled = !(isHost && lobby.connected && lobby.ready[0] && lobby.ready[1]);
    $('pingBox').textContent = rtt == null ? '' : 'ping: ' + rtt + ' ms · input delay will be ' + pickDelay() + ' ticks';
  }
  function pickDelay() { if (rtt == null) return 3; return Math.max(2, Math.min(8, Math.ceil((rtt / 2) / (1000 / SIM.TPS)) + 1)); }

  for (const sel of document.querySelectorAll('#lobby select')) sel.onchange = () => { if (!isHost) return; lobby.cfg[sel.dataset.k] = +sel.value; broadcastLobby(); };
  $('btnReady').onclick = () => { AUDIO.ensure(); lobby.ready[myIdx] = !lobby.ready[myIdx]; if (isHost) broadcastLobby(); else { transport.send({ t: 'ready', v: lobby.ready[myIdx] }); renderLobby(); } };
  $('btnStart').onclick = () => { if (!isHost) return; hostStart(); };
  $('btnLobbyLeave').onclick = leaveAll;
  $('btnLeave').onclick = leaveAll;
  $('btnRematch').onclick = () => { if (solo) { startGame(lobby.cfg, (Math.random() * 2 ** 32) >>> 0, 1); return; } if (isHost) hostStart(); else { transport.send({ t: 'rematch' }); banner('Rematch requested — waiting for host', 3000); } };

  function leaveAll() {
    if (transport) { try { transport.send({ t: 'leave' }); } catch (_) {} transport.destroy(); transport = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    game = null; solo = false; lobby.connected = false; lobby.ready = [false, false]; rtt = null; banner('');
    show('menu');
  }

  // ---- transport handlers ------------------------------------------------
  function transportHandlers() {
    return {
      onOpen() {
        lobby.connected = true;
        if (isHost) { lobby.ready = [false, false]; broadcastLobby(); pingTimer = setInterval(() => transport && transport.send({ t: 'ping', ts: performance.now() }), 1000); }
        else { transport.send({ t: 'hello', name: myName(), L: myPerks.L, P: myPerks.P }); }
        $('lobbyStatus').textContent = 'Connected!';
      },
      onData(msg) { try { handleMessage(msg); } catch (e) { console.error('bad message', msg, e); } },
      onClose() {
        if (game && game.state.phase !== 2) { banner('Opponent disconnected. Leaving in 4s…'); setTimeout(leaveAll, 4000); }
        else if (!game) { if (isHost) { lobby.connected = false; lobby.ready = [false, false]; $('lobbyStatus').textContent = 'Guest left.'; renderLobby(); } else { banner('Host closed the lobby', 3000); leaveAll(); } }
        else banner('Opponent left', 3000);
      },
      onError(e) { console.warn('peer error', e); const t = e && e.type; if (t === 'peer-unavailable') { $('joinStatus').innerHTML = '<span class="err">No lobby with that code.</span>'; } else if (t === 'unavailable-id') { $('createStatus').innerHTML = '<span class="err">Code collision, try again.</span>'; } else if (game) banner('Network error: ' + (e.message || t), 4000); }
    };
  }
  function handleMessage(msg) {
    switch (msg.t) {
      case 'hello': lobby.names[1] = String(msg.name || 'Guest').slice(0, 12); lobby.cfg.perks[1] = { L: msg.L | 0, P: msg.P | 0 }; broadcastLobby(); break;
      case 'perks': if (isHost) { lobby.cfg.perks[1] = { L: msg.L | 0, P: msg.P | 0 }; broadcastLobby(); } break;
      case 'ready': if (isHost) { lobby.ready[1] = !!msg.v; broadcastLobby(); } break;
      case 'lobby': if (!isHost) { lobby.cfg = msg.cfg; lobby.names = msg.names; lobby.ready = msg.ready; lobby.connected = true; renderLobby(); } break;
      case 'ping': transport.send({ t: 'pong', ts: msg.ts }); break;
      case 'pong': { const r = Math.round(performance.now() - msg.ts); rtt = rtt == null ? r : Math.round(rtt * 0.7 + r * 0.3); if (!game) renderLobby(); } break;
      case 'start': if (!isHost) { lobby.cfg = msg.cfg; lobby.names = msg.names; startGame(msg.cfg, msg.seed, msg.delay); } break;
      case 'rematch': if (isHost) banner('Guest wants a rematch — press Rematch', 4000); break;
      case 'leave': if (transport) transport.destroy(); transportHandlers().onClose(); break;
      case 'rtt': rtt = msg.v; break;
      default: if (game) game.ls.onMessage(msg);
    }
  }

  // ---- menu buttons ------------------------------------------------------
  $('btnCreate').onclick = async () => {
    AUDIO.ensure(); prefs.name = myName(); savePrefs();
    $('createStatus').textContent = 'Connecting to signaling server…';
    isHost = true; myIdx = 0; solo = false;
    lobby.cfg = Object.assign({}, SIM.DEFAULT_CFG, readMenuCfg(), { perks: [{ L: myPerks.L, P: myPerks.P }, { L: 0, P: 0 }] });
    lobby.names = [myName(), '…']; lobby.ready = [false, false]; lobby.connected = false;
    transport = new NET.Transport(transportHandlers());
    try {
      const code = await transport.host(NET.makeCode());
      $('codeBox').textContent = code; $('createStatus').textContent = '';
      $('lobbyStatus').textContent = 'Waiting for a friend to join…';
      renderPerkPickers(); renderLobby(); show('lobby');
    } catch (e) { $('createStatus').innerHTML = '<span class="err">Could not create lobby: ' + (e.message || e.type) + '</span>'; transport && transport.destroy(); transport = null; }
  };
  $('btnJoin').onclick = async () => {
    AUDIO.ensure(); prefs.name = myName(); savePrefs();
    const code = $('joinCode').value.trim().toUpperCase();
    if (code.length !== 5) { $('joinStatus').innerHTML = '<span class="err">Enter the 5-letter code.</span>'; return; }
    $('joinStatus').textContent = 'Connecting…';
    isHost = false; myIdx = 1; solo = false;
    lobby.names = ['Host', myName()]; lobby.ready = [false, false]; lobby.connected = false;
    transport = new NET.Transport(transportHandlers());
    try { await transport.join(code); $('joinStatus').textContent = ''; renderPerkPickers(); renderLobby(); show('lobby'); }
    catch (e) { $('joinStatus').innerHTML = '<span class="err">' + (e.message || 'Could not join (' + e.type + ')') + '</span>'; transport && transport.destroy(); transport = null; }
  };
  $('btnSolo').onclick = () => {
    AUDIO.ensure(); prefs.name = myName(); savePrefs();
    isHost = true; myIdx = 0; solo = true; transport = null;
    lobby.cfg = Object.assign({}, SIM.DEFAULT_CFG, readMenuCfg(), { bot: true, perks: [{ L: myPerks.L, P: myPerks.P }, { L: 0, P: 0 }] });
    lobby.names = [myName(), 'Bot'];
    startGame(lobby.cfg, (Math.random() * 2 ** 32) >>> 0, 1);
  };
  $('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });

  function hostStart() {
    const seed = (Math.random() * 2 ** 32) >>> 0, delay = pickDelay();
    lobby.cfg.perks[0] = { L: myPerks.L, P: myPerks.P };
    const cfg = Object.assign({}, lobby.cfg, { bot: false });
    transport.send({ t: 'start', seed, delay, cfg, names: lobby.names });
    startGame(cfg, seed, delay);
  }

  // ---- input -------------------------------------------------------------
  const keys = new Set(); let mouse = { x: 0, y: 0, down: false }; let perkKey = 0;
  window.addEventListener('keydown', e => { if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return; keys.add(e.code); if (e.code === 'Digit1') perkKey = SIM.A_PERK1; if (e.code === 'Digit2') perkKey = SIM.A_PERK2; if (e.code === 'Digit3') perkKey = SIM.A_PERK3; if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault(); });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); mouse.down = false; });
  canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', e => { if (e.button === 0) { mouse.down = true; AUDIO.ensure(); } });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('touchstart', e => { const t = e.touches[0]; mouse.x = t.clientX; mouse.y = t.clientY; mouse.down = true; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', e => { const t = e.touches[0]; mouse.x = t.clientX; mouse.y = t.clientY; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchend', () => { mouse.down = false; });

  function viewTransform() { const cw = canvas.clientWidth, ch = canvas.clientHeight; const scale = Math.min(cw / SIM.WPX, ch / SIM.HPX); return { scale, ox: (cw - SIM.WPX * scale) / 2, oy: (ch - SIM.HPX * scale) / 2 }; }
  function sampleInput() {
    const me = game.state.players[myIdx];
    let mx = 0, my = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1; if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1; if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    let a = 0;
    if (mouse.down || keys.has('Space')) a |= SIM.A_PRIMARY;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) a |= SIM.A_DASH;
    if (perkKey) { a |= perkKey; perkKey = 0; }
    const v = viewTransform();
    const wx = (mouse.x - v.ox) / v.scale * SIM.FP, wy = (mouse.y - v.oy) / v.scale * SIM.FP;
    const aim = SIM.norm(Math.round(wx - me.x), Math.round(wy - me.y));
    return [SIM.moveBits(mx, my), a, aim.x, aim.y];
  }

  // ---- game --------------------------------------------------------------
  let game = null, raf = 0;
  function startGame(cfg, seed, delay) {
    const state = SIM.createState(cfg, seed);
    const ls = new NET.Lockstep({ sim: SIM, state, local: myIdx, delay, solo, isHost,
      send: m => transport && transport.send(m), sample: sampleInput,
      onEvents: ev => onEvents(ev), onDesync: t => banner('Desync at tick ' + t + ' — resyncing from host', 2500) });
    ls.debug = new URLSearchParams(location.search).has('debug');
    game = { ls, state, names: lobby.names.slice(), delay };
    banner(''); $('endbtns').classList.add('hidden');
    show('game'); resize();
    if (!raf) raf = requestAnimationFrame(loop);
    if (!simTimer) simTimer = setInterval(tickSim, 8);
  }
  let simTimer = 0;
  function tickSim() {
    if (!game) { clearInterval(simTimer); simTimer = 0; return; }
    const ls = game.ls; ls.frame(performance.now()); game.state = ls.state;
  }
  function onEvents(ev) {
    RENDER.handleEvents(ev, myIdx, game.ls.state);
    for (const e of ev) {
      switch (e.t) {
        case 'snap': AUDIO.snap(); break; case 'focus': AUDIO.focus(); break; case 'miss': AUDIO.miss(); break;
        case 'throw': AUDIO.throw(); break; case 'papHit': AUDIO.bonk(); break; case 'crowdHit': AUDIO.crowd(); break;
        case 'dash': if (e.i === myIdx) AUDIO.dash(); break; case 'catch': AUDIO.catch(); break;
        case 'swapStart': AUDIO.swap(); break;
        case 'end': AUDIO.end(); $('endbtns').classList.remove('hidden'); $('btnRematch').classList.toggle('hidden', false); break;
      }
    }
  }
  function resize() { const dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.floor(window.innerWidth * dpr); canvas.height = Math.floor(window.innerHeight * dpr); canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  window.addEventListener('resize', () => { if (game) resize(); });
  function loop(now) {
    if (!game) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    const ls = game.ls;
    RENDER.draw(ctx, canvas.clientWidth, canvas.clientHeight, ls.state, ls.prev, ls.alpha, { myIdx, names: game.names, rtt: solo ? null : rtt, delay: game.delay, stallMs: ls.stallMs || 0 });
  }

  renderPerkPickers();
  // deep link: ?join=CODE
  const qp = new URLSearchParams(location.search).get('join'); if (qp) { $('joinCode').value = qp.toUpperCase(); }
  window.__game = () => game; // debug hook
})();
