'use strict';
// ---------------------------------------------------------------------------
// render.js — first-person view (projected walls/floor + depth-sorted billboard
// sprites on a 2D canvas) and HUD. Reads state, never mutates it.
// ---------------------------------------------------------------------------
const RENDER = (() => {
  const FP = SIM.FP;
  const CROWD_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab6d6', '#c77dff', '#f4a261', '#90be6d', '#f28482'];
  const PANTS = ['#2b2d42', '#3d405b', '#1f2a44', '#4a3b2a', '#2f3e46', '#263238', '#3a2f4b', '#1b1b2f'];
  const SKIN = ['#f1d3b3', '#d9a984', '#b07a52', '#8d5a3a', '#f3dcc4', '#c68e63'];
  const HAIR = ['#2b1b0e', '#000', '#5a3b1e', '#b08a5a', '#1a1a1a', '#6b2d1b'];
  const GOLD = '#FDB927', PURPLE = '#552583';
  const EYE_H = 46, WALL_H = 90, NEAR = 6, PLANTER_H = 34;
  const FOV = Math.PI / 2;
  let flash = 0, shake = 0, hurt = 0, hurtColor = '#f00', lastThrow = -1e9, lastSnapMe = -1e9;
  const floats = [];
  // deterministic decoration (render only)
  let seed = 1337; const r01 = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const STARS = []; for (let i = 0; i < 140; i++) STARS.push({ az: r01() * Math.PI * 2, y: r01(), s: 1 + Math.floor(r01() * 2.5), tw: r01() * 6 });
  const BUILDINGS = []; { let az = 0; while (az < Math.PI * 2) { const w = 0.05 + r01() * 0.12; BUILDINGS.push({ az, w, h: 0.18 + r01() * 0.42, win: r01() }); az += w + r01() * 0.02; } }
  const STANCHIONS = []; for (let x = 80; x < SIM.WPX; x += 160) { STANCHIONS.push([x, 322]); STANCHIONS.push([x, 478]); }

  function px(v) { return v / FP; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function addFloat(wx, wy, text, color, size) { floats.push({ wx: px(wx), wy: px(wy), h: 75, text, color, life: 1, size: size || 20 }); }

  function handleEvents(ev, myIdx, state) {
    for (const e of ev) {
      switch (e.t) {
        case 'snap': flash = e.i === myIdx ? 0.5 : 0.95; shake = 6; if (e.i === myIdx) lastSnapMe = performance.now(); addFloat(e.x, e.y, 'SNAP ' + e.photos + '/' + state.cfg.photos, '#fff', 26); break;
        case 'miss': addFloat(e.x, e.y, 'out of frame', '#bbb', 16); break;
        case 'papHit': shake = 10; addFloat(e.x, e.y, e.lost > 0 ? 'PHOTOS LOST!' : 'BONK', '#ff6b6b', 26); if (state.lebron !== myIdx) { hurt = 0.7; hurtColor = '#ff3b3b'; } break;
        case 'crowdHit': shake = 6; addFloat(e.x, e.y, '-' + e.pr + ' PR', '#ff4d4d', 26); if (state.lebron === myIdx) { hurt = 0.5; hurtColor = '#ff8c00'; } break;
        case 'catch': addFloat(e.x, e.y, 'rebound!', GOLD, 16); break;
        case 'pickup': if (e.auto) addFloat(e.x, e.y, 'ball returned', '#ddd', 14); break;
        case 'throw': if (state.lebron === myIdx) lastThrow = performance.now(); break;
        case 'swapStart': shake = 12; break;
      }
    }
  }
  function fmtTime(ticks) { const s = Math.ceil(ticks / SIM.TPS); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  // ---- camera / projection ----------------------------------------------
  const cam = { x: 0, y: 0, yaw: 0, fx: 1, fy: 0, rx: 0, ry: 1, focal: 1, W: 1, H: 1, hor: 1 };
  function toCam(wx, wy) { const dx = wx - cam.x, dy = wy - cam.y; return { x: dx * cam.rx + dy * cam.ry, z: dx * cam.fx + dy * cam.fy }; }
  function projX(c) { return cam.W / 2 + cam.focal * c.x / c.z; }
  function projY(c, h) { return cam.hor + cam.focal * (EYE_H - h) / c.z; }
  function clipSeg(a, b) {
    if (a.z < NEAR && b.z < NEAR) return null;
    if (a.z < NEAR) { const t = (NEAR - a.z) / (b.z - a.z); a = { x: a.x + (b.x - a.x) * t, z: NEAR }; }
    if (b.z < NEAR) { const t = (NEAR - b.z) / (a.z - b.z); b = { x: b.x + (a.x - b.x) * t, z: NEAR }; }
    return [a, b];
  }
  function clipPoly(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) { const t = (NEAR - a.z) / (b.z - a.z); out.push({ x: a.x + (b.x - a.x) * t, z: NEAR }); }
    }
    return out;
  }
  function floorPoly(ctx, worldPts, fill) {
    const c = clipPoly(worldPts.map(p => toCam(p[0], p[1])));
    if (c.length < 3) return;
    ctx.beginPath(); c.forEach((q, i) => { const sx = projX(q), sy = projY(q, 0); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }
  function floorLine(ctx, x0, y0, x1, y1) {
    const s = clipSeg(toCam(x0, y0), toCam(x1, y1)); if (!s) return;
    ctx.beginPath(); ctx.moveTo(projX(s[0]), projY(s[0], 0)); ctx.lineTo(projX(s[1]), projY(s[1], 0)); ctx.stroke();
  }
  function fogMix(z) { return Math.max(0, Math.min(0.85, (z - 250) / 1500)); }
  function shade(hex, f) { // darken a #rrggbb color toward the night fog
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r * (1 - f) + 12 * f); g = Math.round(g * (1 - f) + 14 * f); b = Math.round(b * (1 - f) + 24 * f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function wall(ctx, x0, y0, x1, y1) {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / 160));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const wa = [x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0], wb = [x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1];
      const s = clipSeg(toCam(wa[0], wa[1]), toCam(wb[0], wb[1])); if (!s) continue;
      const [a, b] = s, ax = projX(a), bx = projX(b), f = fogMix((a.z + b.z) / 2);
      const band = (h0, h1, color) => { ctx.beginPath(); ctx.moveTo(ax, projY(a, h0)); ctx.lineTo(bx, projY(b, h0)); ctx.lineTo(bx, projY(b, h1)); ctx.lineTo(ax, projY(a, h1)); ctx.closePath(); ctx.fillStyle = shade(color, f); ctx.fill(); };
      band(0, WALL_H, '#3a3f4d'); band(WALL_H - 6, WALL_H, '#20232b'); band(0, 8, '#1b1d24'); band(26, 33, '#FDB927');
      // framed poster in the middle of this segment
      const pa = toCam(wa[0] + (wb[0] - wa[0]) * 0.25, wa[1] + (wb[1] - wa[1]) * 0.25), pb = toCam(wa[0] + (wb[0] - wa[0]) * 0.75, wa[1] + (wb[1] - wa[1]) * 0.75);
      if (pa.z >= NEAR && pb.z >= NEAR) {
        const q = (h0, h1, color) => { ctx.beginPath(); ctx.moveTo(projX(pa), projY(pa, h0)); ctx.lineTo(projX(pb), projY(pb, h0)); ctx.lineTo(projX(pb), projY(pb, h1)); ctx.lineTo(projX(pa), projY(pa, h1)); ctx.closePath(); ctx.fillStyle = shade(color, f); ctx.fill(); };
        q(40, 82, '#e9e4d8'); q(43, 79, i % 3 === 0 ? '#552583' : i % 3 === 1 ? '#8b1e2d' : '#1d3557');
        q(56, 66, i % 3 === 0 ? '#FDB927' : '#f5f5f5');
      }
    }
  }

  // ---- sprites -----------------------------------------------------------
  function spriteBegin(ctx, c) {
    if (c.z < NEAR) return false;
    const k = cam.focal / c.z;
    ctx.save(); ctx.translate(projX(c), projY(c, 0)); ctx.scale(k, k);
    const f = fogMix(c.z); if (f > 0.02) ctx.filter = 'brightness(' + (1 - f * 0.75).toFixed(2) + ')';
    return true;
  }
  function shadow(ctx, r) { ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.35, 0, 0, Math.PI * 2); ctx.fill(); }
  // Generic person. o = {shirt, pants, skin, hair, front, phase, moving, pose, cap, lebron, ball, camera}
  function person(ctx, o) {
    const swing = o.moving ? Math.sin(o.phase) * 7 : 0;
    const bob = o.moving ? Math.abs(Math.cos(o.phase)) * 1.5 : 0;
    shadow(ctx, 17);
    ctx.save(); ctx.translate(0, -bob);
    // legs
    ctx.fillStyle = o.pants; ctx.fillRect(-10 + swing * 0.4, -27, 8, 27); ctx.fillRect(2 - swing * 0.4, -27, 8, 27);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(-11 + swing * 0.4, -4, 10, 4); ctx.fillRect(1 - swing * 0.4, -4, 10, 4);
    // torso
    ctx.fillStyle = o.shirt; ctx.beginPath(); ctx.moveTo(-15, -56); ctx.lineTo(15, -56); ctx.lineTo(13, -26); ctx.lineTo(-13, -26); ctx.closePath(); ctx.fill();
    if (o.lebron) { ctx.fillStyle = PURPLE; ctx.fillRect(-15, -56, 30, 4); ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = o.front ? PURPLE : '#fff'; ctx.fillText(o.front ? '23' : 'JAMES', 0, -42); }
    else if (o.front && o.logo) { ctx.fillStyle = '#fff'; ctx.fillRect(-8, -48, 16, 10); ctx.fillStyle = '#000'; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('KING', 0, -43); }
    // arms
    const armUp = o.pose === 'phone' || o.pose === 'cheer' || o.pose === 'camera-up';
    ctx.fillStyle = o.skin;
    if (o.pose === 'cheer') { ctx.fillRect(-23, -78, 6, 26); ctx.fillRect(17, -78, 6, 26); }
    else if (o.pose === 'phone') { ctx.fillRect(-20, -54, 6, 24); ctx.fillRect(12, -76, 6, 26); }
    else if (o.pose === 'camera-up') { ctx.fillRect(-16, -62, 6, 16); ctx.fillRect(10, -62, 6, 16); }
    else if (o.pose === 'throw') { ctx.fillRect(-20, -54, 6, 24); ctx.save(); ctx.translate(16, -52); ctx.rotate(-1.2); ctx.fillRect(0, 0, 6, 26); ctx.restore(); }
    else { ctx.fillRect(-20 - swing * 0.3, -54, 6, 24); ctx.fillRect(14 + swing * 0.3, -54, 6, 24); }
    // head
    ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(0, -66, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = o.hair;
    if (o.cap) { ctx.fillRect(-11, -78, 22, 7); if (o.front) ctx.fillRect(-11, -73, 26, 3); }
    else if (o.front) { ctx.beginPath(); ctx.arc(0, -68, 10.5, Math.PI * 1.05, Math.PI * 1.95); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(0, -66, 10.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(-6, -62, 2.5, 0, Math.PI * 2); ctx.arc(6, -62, 2.5, 0, Math.PI * 2); ctx.fill(); }
    if (o.lebron) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, -68, 9.5, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); if (o.front) { ctx.fillStyle = '#2b1b0e'; ctx.fillRect(-7, -62, 14, 4); } }
    if (o.front) { ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.arc(-3.5, -67, 1.6, 0, Math.PI * 2); ctx.arc(3.5, -67, 1.6, 0, Math.PI * 2); ctx.fill(); if (o.pose === 'cheer') { ctx.beginPath(); ctx.arc(0, -62, 3, 0, Math.PI); ctx.fill(); } }
    // held items
    if (o.pose === 'phone') { ctx.fillStyle = '#111'; ctx.fillRect(10, -84, 10, 16); ctx.fillStyle = '#9fd8ff'; ctx.fillRect(11.5, -82.5, 7, 13); }
    if (o.pose === 'camera-low' || o.strap) { ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(-10, -56); ctx.lineTo(8, -34); ctx.stroke(); }
    if (o.pose === 'camera-low') { ctx.fillStyle = '#151515'; ctx.fillRect(-4, -40, 18, 12); ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(5, -34, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#4a6a8a'; ctx.beginPath(); ctx.arc(5, -34, 4, 0, Math.PI * 2); ctx.fill(); }
    if (o.pose === 'camera-up') {
      ctx.fillStyle = '#151515'; ctx.fillRect(-13, -73, 26, 16);
      ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); ctx.arc(0, -65, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a6a8a'; ctx.beginPath(); ctx.arc(0, -65, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff2a2a'; ctx.beginPath(); ctx.arc(10, -71, 2, 0, Math.PI * 2); ctx.fill();
      // lens glint: bright star, visible from far
      const g = 0.6 + 0.4 * Math.sin(performance.now() / 60);
      ctx.fillStyle = 'rgba(255,255,255,' + g + ')'; ctx.beginPath(); ctx.moveTo(0, -72); ctx.lineTo(2, -67); ctx.lineTo(7, -65); ctx.lineTo(2, -63); ctx.lineTo(0, -58); ctx.lineTo(-2, -63); ctx.lineTo(-7, -65); ctx.lineTo(-2, -67); ctx.closePath(); ctx.fill();
    }
    if (o.ball) drawBallShape(ctx, 21, -40, 8);
    if (o.stun) { ctx.fillStyle = '#ffd60a'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✦ ✦ ✦', 0, -88); }
    ctx.restore();
  }
  function personDown(ctx, o) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 0, 28, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = o.pants; ctx.fillRect(-28, -10, 22, 9);
    ctx.fillStyle = o.shirt; ctx.fillRect(-8, -12, 24, 12);
    ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(24, -8, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222'; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('x_x', 24, -8);
    if (o.camera) { ctx.fillStyle = '#151515'; ctx.fillRect(-40, -8, 16, 9); ctx.fillStyle = '#4a6a8a'; ctx.beginPath(); ctx.arc(-26, -4, 3, 0, Math.PI * 2); ctx.fill(); }
  }
  function drawBallShape(ctx, x, y, r) {
    ctx.fillStyle = '#e8702a'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3a1d0d'; ctx.lineWidth = Math.max(1, r / 7); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
  }
  function drawPlanter(ctx) {
    const r = px(SIM.OBS_R);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, 0, r + 4, (r + 4) * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createLinearGradient(-r, 0, r, 0); g.addColorStop(0, '#3e2f22'); g.addColorStop(0.5, '#6b543f'); g.addColorStop(1, '#3e2f22');
    ctx.fillStyle = g; ctx.fillRect(-r, -PLANTER_H, 2 * r, PLANTER_H);
    ctx.fillStyle = '#8a7055'; ctx.fillRect(-r - 2, -PLANTER_H - 3, 2 * r + 4, 5);
    ctx.fillStyle = '#2f6b2c'; ctx.beginPath(); ctx.ellipse(0, -PLANTER_H - 6, r, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3f8a3a'; ctx.beginPath(); ctx.arc(-r * 0.35, -PLANTER_H - 20, r * 0.5, 0, Math.PI * 2); ctx.arc(r * 0.3, -PLANTER_H - 16, r * 0.45, 0, Math.PI * 2); ctx.arc(0, -PLANTER_H - 30, r * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6cc25f'; ctx.beginPath(); ctx.arc(-r * 0.45, -PLANTER_H - 26, r * 0.22, 0, Math.PI * 2); ctx.arc(r * 0.1, -PLANTER_H - 36, r * 0.18, 0, Math.PI * 2); ctx.fill();
  }
  function drawStanchion(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = GOLD; ctx.beginPath(); ctx.ellipse(0, -1, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(-1.5, -40, 3, 40); ctx.beginPath(); ctx.arc(0, -41, 3, 0, Math.PI * 2); ctx.fill();
  }

  // ---- main draw ---------------------------------------------------------
  let lastDraw = 0;
  function draw(ctx, cw, ch, state, prev, alpha, ui) {
    const now = performance.now(); const dt = lastDraw ? Math.min(3, (now - lastDraw) / 16.67) : 1; lastDraw = now;
    const me = state.players[ui.myIdx], isLme = state.lebron === ui.myIdx;
    const L = state.players[state.lebron], P = state.players[1 - state.lebron];
    const ip = (cur, pv) => prev && prev.phase === state.phase ? lerp(pv, cur, alpha) : cur;
    const pos = (i) => { const p = state.players[i]; return prev ? [ip(px(p.x), px(prev.p[i][0])), ip(px(p.y), px(prev.p[i][1]))] : [px(p.x), px(p.y)]; };
    const [mx, my] = pos(ui.myIdx);
    const moving = me.vx !== 0 || me.vy !== 0, tickF = state.tick + alpha;
    cam.W = cw; cam.H = ch; cam.hor = ch * 0.5 + (moving && state.phase === 0 ? Math.sin(now / 90) * 3 : 0);
    cam.focal = (cw / 2) / Math.tan(FOV / 2) * (me.dashLeft > 0 ? 0.9 : 1);
    cam.x = mx; cam.y = my; cam.yaw = ui.yaw; cam.fx = Math.cos(ui.yaw); cam.fy = Math.sin(ui.yaw); cam.rx = -cam.fy; cam.ry = cam.fx;
    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= Math.pow(0.85, dt); if (shake < 0.3) shake = 0; }

    drawSky(ctx, cw, ch, now);
    // floor
    const floor = ctx.createLinearGradient(0, cam.hor, 0, ch); floor.addColorStop(0, '#15171d'); floor.addColorStop(0.15, '#24272f'); floor.addColorStop(1, '#3b404c');
    ctx.fillStyle = floor; ctx.fillRect(-20, cam.hor, cw + 40, ch - cam.hor + 20);
    const Wp = SIM.WPX, Hp = SIM.HPX;
    wall(ctx, 0, 0, Wp, 0); wall(ctx, Wp, 0, Wp, Hp); wall(ctx, Wp, Hp, 0, Hp); wall(ctx, 0, Hp, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let x = 0; x <= Wp; x += 80) floorLine(ctx, x, 0, x, Hp);
    for (let y = 0; y <= Hp; y += 80) floorLine(ctx, 0, y, Wp, y);
    floorPoly(ctx, [[0, 330], [Wp, 330], [Wp, 470], [0, 470]], '#8b1e2d');
    for (let x = 0; x < Wp; x += 160) floorPoly(ctx, [[x, 330], [x + 80, 330], [x + 80, 470], [x, 470]], '#a12536');
    ctx.strokeStyle = 'rgba(253,185,39,0.55)'; ctx.lineWidth = 2; floorLine(ctx, 0, 330, Wp, 330); floorLine(ctx, 0, 470, Wp, 470);

    // sprites far -> near
    const items = [];
    for (const o of SIM.OBSTACLES) items.push({ c: toCam(px(o.x), px(o.y)), kind: 'planter' });
    for (const st of STANCHIONS) items.push({ c: toCam(st[0], st[1]), kind: 'stanchion' });
    const lx = px(L.x), ly = px(L.y);
    state.crowd.forEach((c, i) => {
      const x = prev && prev.c[i] ? ip(px(c.x), px(prev.c[i][0])) : px(c.x), y = prev && prev.c[i] ? ip(px(c.y), px(prev.c[i][1])) : px(c.y);
      items.push({ c: toCam(x, y), kind: 'crowd', c0: c, i, x, y });
    });
    const oi = 1 - ui.myIdx, other = state.players[oi]; { const [ox, oy] = pos(oi); items.push({ c: toCam(ox, oy), kind: 'player', p: other, i: oi, x: ox, y: oy }); }
    const b = state.ball;
    if (b.st !== 0) { const bx = prev && prev.b[2] === b.st ? ip(px(b.x), px(prev.b[0])) : px(b.x), by = prev && prev.b[2] === b.st ? ip(px(b.y), px(prev.b[1])) : px(b.y); items.push({ c: toCam(bx, by), kind: 'ball', h: b.st === 1 ? 34 + Math.sin(tickF * 0.6) * 4 : 9 }); }
    items.sort((a, b2) => b2.c.z - a.c.z);
    for (const it of items) {
      if (!spriteBegin(ctx, it.c)) continue;
      if (it.kind === 'planter') drawPlanter(ctx);
      else if (it.kind === 'stanchion') drawStanchion(ctx);
      else if (it.kind === 'ball') { shadow(ctx, 9); drawBallShape(ctx, 0, -it.h, px(SIM.BALL_R)); if (b.st === 2) { const lp = SIM.lebronParams(state, L); const t = 1 - b.ground / lp.returnTicks; ctx.strokeStyle = 'rgba(253,185,39,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -it.h, 15, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke(); } }
      else if (it.kind === 'crowd') {
        const c = it.c0;
        const look = { shirt: CROWD_COLORS[c.col], pants: PANTS[c.col], skin: SKIN[(c.col + c.face) % SKIN.length], hair: HAIR[(c.col * 3 + c.face) % HAIR.length], cap: c.face === 1 };
        if (c.down > 0) personDown(ctx, look);
        else {
          const dx = lx - it.x, dy = ly - it.y; // fans face LeBron
          const front = dx * (cam.x - it.x) + dy * (cam.y - it.y) > 0;
          const dL = Math.hypot(dx, dy);
          const pose = c.face === 2 && dL < 320 ? 'phone' : c.face === 0 && dL < 200 && ((it.i + Math.floor(tickF / 40)) % 3 === 0) ? 'cheer' : 'idle';
          person(ctx, Object.assign(look, { front, phase: tickF * 0.55 + it.i, moving: c.vx !== 0 || c.vy !== 0, pose, logo: c.face === 2 }));
        }
      } else if (it.kind === 'player') {
        const p = it.p; const front = p.fx * (cam.x - it.x) + p.fy * (cam.y - it.y) > 0;
        if (state.lebron === it.i) {
          const pose = (now - lastThrowRemote < 250) ? 'throw' : 'idle';
          person(ctx, { shirt: GOLD, pants: PURPLE, skin: '#8d5a3a', hair: '#1a1a1a', front, phase: tickF * 0.6, moving: p.vx !== 0 || p.vy !== 0, pose, lebron: true, ball: b.st === 0 && b.holder === it.i, stun: p.stun > 0 });
        } else {
          const look = { shirt: CROWD_COLORS[p.disg], pants: PANTS[p.disg], skin: SKIN[(p.disg + p.dface) % SKIN.length], hair: HAIR[(p.disg * 3 + p.dface) % HAIR.length], cap: p.dface === 1 };
          if (p.stun > 0) personDown(ctx, Object.assign(look, { camera: true }));
          else {
            const dL = Math.hypot(lx - it.x, ly - it.y);
            let pose = 'idle';
            if (p.charge > 0) pose = 'camera-up';
            else if (p.exp >= SIM.EXPOSED) pose = 'camera-low';
            else if (p.dface === 2 && dL < 320) pose = 'phone';
            const sprinting = Math.abs(p.vx) + Math.abs(p.vy) > 90;
            person(ctx, Object.assign(look, { front: pose === 'camera-up' ? true : front, phase: tickF * (sprinting ? 1.1 : 0.55) + 7, moving: p.vx !== 0 || p.vy !== 0, pose, logo: p.dface === 2, strap: p.exp >= 30 && p.exp < SIM.EXPOSED }));
          }
        }
      }
      ctx.restore();
    }
    // floating texts
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i]; f.h += 0.8 * dt; f.life -= 0.016 * dt; if (f.life <= 0) { floats.splice(i, 1); continue; }
      const c = toCam(f.wx, f.wy); if (c.z < NEAR) continue;
      const k = Math.min(1.6, Math.max(0.5, cam.focal / c.z * 1.2));
      ctx.globalAlpha = Math.min(1, f.life * 2); ctx.fillStyle = f.color; ctx.font = 'bold ' + Math.round(f.size * k) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4;
      ctx.strokeText(f.text, projX(c), projY(c, f.h)); ctx.fillText(f.text, projX(c), projY(c, f.h));
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // vignette
    const vg = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.45, cw / 2, ch / 2, ch * 0.95); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, cw, ch);
    if (hurt > 0) { ctx.globalAlpha = hurt * 0.3; ctx.fillStyle = hurtColor; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1; hurt -= 0.04 * dt; }

    drawFirstPersonHUD(ctx, cw, ch, state, ui, now);
    drawTopBar(ctx, cw, state, ui);
    drawMinimap(ctx, cw, ch, state, ui);
    if (state.phase === 1) drawSwapOverlay(ctx, cw, ch, state, ui);
    if (state.phase === 2) drawEndOverlay(ctx, cw, ch, state, ui);
    if (flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + flash + ')'; ctx.fillRect(0, 0, cw, ch); flash -= 0.06 * dt; }
    if (ui.stallMs > 250) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cw / 2 - 150, ch / 2 - 30, 300, 60); ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Waiting for opponent… ' + (ui.stallMs / 1000).toFixed(1) + 's', cw / 2, ch / 2); }
    if (!ui.locked && state.phase === 0 && !ui.touch) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(cw / 2 - 170, ch - 120, 340, 36); ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Click the screen to capture the mouse', cw / 2, ch - 102); }
  }
  let lastThrowRemote = -1e9;

  function drawSky(ctx, cw, ch, now) {
    const sky = ctx.createLinearGradient(0, 0, 0, cam.hor); sky.addColorStop(0, '#05060f'); sky.addColorStop(0.7, '#1b1538'); sky.addColorStop(1, '#3a2a5e');
    ctx.fillStyle = sky; ctx.fillRect(-20, -20, cw + 40, cam.hor + 20);
    const azX = (az) => { let d = az - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) < FOV / 2 + 0.15 ? cw / 2 + cam.focal * Math.tan(d) : null; };
    // stars
    for (const st of STARS) { const sx = azX(st.az); if (sx === null) continue; ctx.globalAlpha = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(now / 700 + st.tw)); ctx.fillStyle = '#fff'; ctx.fillRect(sx, st.y * cam.hor * 0.75, st.s, st.s); }
    ctx.globalAlpha = 1;
    // moon
    { const sx = azX(0.9); if (sx !== null) { const my = cam.hor * 0.22; const g = ctx.createRadialGradient(sx, my, 10, sx, my, 90); g.addColorStop(0, 'rgba(255,245,200,0.35)'); g.addColorStop(1, 'rgba(255,245,200,0)'); ctx.fillStyle = g; ctx.fillRect(sx - 90, my - 90, 180, 180); ctx.fillStyle = '#fff3c4'; ctx.beginPath(); ctx.arc(sx, my, 26, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#e8dcae'; ctx.beginPath(); ctx.arc(sx - 8, my - 6, 5, 0, Math.PI * 2); ctx.arc(sx + 9, my + 7, 7, 0, Math.PI * 2); ctx.fill(); } }
    // searchlights
    for (let i = 0; i < 2; i++) { const sx = azX(2.2 + i * 2.6); if (sx === null) continue; const ang = Math.sin(now / 1900 + i * 2) * 0.5; ctx.save(); ctx.translate(sx, cam.hor); ctx.rotate(ang); const g = ctx.createLinearGradient(0, 0, 0, -cam.hor * 1.4); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.lineTo(80, -cam.hor * 1.4); ctx.lineTo(-80, -cam.hor * 1.4); ctx.closePath(); ctx.fill(); ctx.restore(); }
    // skyline silhouettes
    for (const bd of BUILDINGS) {
      const x0 = azX(bd.az), x1 = azX(bd.az + bd.w); if (x0 === null && x1 === null) continue;
      const a = x0 === null ? -50 : x0, b = x1 === null ? cw + 50 : x1; if (b < a) continue;
      const top = cam.hor - bd.h * cam.hor * 0.9;
      ctx.fillStyle = '#0d0b1a'; ctx.fillRect(a, top, b - a, cam.hor - top + 2);
      ctx.fillStyle = 'rgba(255,230,150,0.55)';
      const cols = Math.max(1, Math.floor((b - a) / 14)), rows = Math.max(1, Math.floor((cam.hor - top) / 16));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (((r * 7 + c * 13 + Math.floor(bd.win * 97)) % 5) < 2) ctx.fillRect(a + 4 + c * 14, top + 6 + r * 16, 6, 8); }
    }
  }

  function drawFirstPersonHUD(ctx, cw, ch, state, ui, now) {
    const me = state.players[ui.myIdx], isL = state.lebron === ui.myIdx, b = state.ball, other = state.players[1 - ui.myIdx];
    const cx = cw / 2, cy = ch / 2;
    ctx.textBaseline = 'middle';
    if (isL) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12); ctx.stroke();
      // arms + ball, with throw animation
      const t = Math.min(1, (now - lastThrow) / 350), ext = lastThrow > 0 && t < 1 ? Math.sin(t * Math.PI) : 0;
      const hx = cw * 0.8 - ext * 120, hy = ch + 20 - ext * 140;
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(-0.35 - ext * 0.4);
      ctx.fillStyle = '#8d5a3a'; ctx.beginPath(); ctx.ellipse(0, 0, 60, 150, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = GOLD; ctx.beginPath(); ctx.ellipse(0, 120, 80, 70, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8d5a3a'; ctx.beginPath(); ctx.arc(0, -120, 42, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (b.st === 0 && b.holder === ui.myIdx) drawBallShape(ctx, hx - 10, hy - 170, 48);
      else { ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(b.st === 2 ? 'ball loose — walk over it or wait' : 'ball in flight', cx, cy + 40); }
      // alert when the paparazzi is focusing on you
      if (other.charge > 0 && state.phase === 0) {
        let d = Math.atan2(other.y - me.y, other.x - me.x) - ui.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        const pulse = 0.6 + 0.4 * Math.sin(now / 70);
        ctx.fillStyle = 'rgba(255,40,40,' + pulse + ')'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
        if (Math.abs(d) > FOV / 2) { const ex = d > 0 ? cw - 40 : 40; ctx.fillText(d > 0 ? '📸 ▶' : '◀ 📸', ex, cy); }
        else { ctx.fillText('📸 CAMERA UP!', cx, cy - 70); }
      }
    } else {
      const pp = SIM.papParams(me), leb = other;
      const framed = state.phase === 0 && SIM.inFrame(state, me, leb, pp);
      const half = Math.acos(pp.cosHalf / 256);
      const fx = Math.min(cw / 2 - 6, cam.focal * Math.tan(half)), fy = Math.min(ch / 2 - 60, fx * 0.62);
      const col = me.charge > 0 ? '#ff3b3b' : framed ? '#4cff7a' : me.snapCd > 0 ? '#777' : 'rgba(255,255,255,0.75)';
      ctx.strokeStyle = col; ctx.lineWidth = 3; const Lb = 28;
      const corner = (x, y, sx, sy) => { ctx.beginPath(); ctx.moveTo(x + sx * Lb, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * Lb); ctx.stroke(); };
      corner(cx - fx, cy - fy, 1, 1); corner(cx + fx, cy - fy, -1, 1); corner(cx - fx, cy + fy, 1, -1); corner(cx + fx, cy + fy, -1, -1);
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(me.charge > 0 ? 'FOCUSING…' : framed ? 'IN FRAME — hold to snap' : me.snapCd > 0 ? 'winding film' : 'find LeBron', cx, cy + fy + 22);
      if (me.charge > 0) { ctx.beginPath(); ctx.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + (me.charge / pp.charge) * Math.PI * 2); ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 5; ctx.stroke(); }
      const d = Math.hypot(leb.x - me.x, leb.y - me.y) / FP; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '12px sans-serif'; ctx.fillText(Math.round(d) + ' / ' + Math.round(pp.range / FP) + ' range', cx, cy + fy + 40);
      // hands: camera hidden under the jacket unless focusing
      const up = me.charge > 0 ? 1 : 0, sinceSnap = now - lastSnapMe;
      const camY = ch - 30 - up * 150 + (sinceSnap < 150 ? 8 : 0);
      ctx.fillStyle = CROWD_COLORS[me.disg]; ctx.fillRect(cw * 0.3, ch - 40, cw * 0.4, 60);
      ctx.fillStyle = '#151515'; ctx.fillRect(cx - 95, camY, 190, 70); ctx.fillStyle = '#2a2a2a'; ctx.fillRect(cx - 30, camY - 18, 60, 22);
      ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); ctx.arc(cx, camY + 35, 28, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#4a6a8a'; ctx.beginPath(); ctx.arc(cx, camY + 35, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = me.charge > 0 ? '#ff2a2a' : '#333'; ctx.beginPath(); ctx.arc(cx + 70, camY + 12, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = SKIN[(me.disg + me.dface) % SKIN.length]; ctx.beginPath(); ctx.ellipse(cx - 120, camY + 50, 40, 55, 0.3, 0, Math.PI * 2); ctx.ellipse(cx + 120, camY + 50, 40, 55, -0.3, 0, Math.PI * 2); ctx.fill();
      // cover meter
      const ex = me.exp, w = 240, x0 = cx - w / 2, y0 = 72;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x0 - 6, y0 - 6, w + 12, 30);
      ctx.fillStyle = '#333'; ctx.fillRect(x0, y0, w, 10);
      ctx.fillStyle = ex >= SIM.EXPOSED ? '#ff3b3b' : ex >= 30 ? '#ffb300' : '#4cff7a'; ctx.fillRect(x0, y0, w * ex / 100, 10);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + w * SIM.EXPOSED / 100, y0 - 3); ctx.lineTo(x0 + w * SIM.EXPOSED / 100, y0 + 13); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(ex >= SIM.EXPOSED ? 'EXPOSED — LeBron can see your camera' : ex >= 30 ? 'SUSPICIOUS' : 'BLENDING IN (walk, don\'t run)', cx, y0 + 19);
    }
    // dash cooldown
    const dmax = isL ? 54 : 42;
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(cx - 60, ch - 22, 120, 5);
    ctx.fillStyle = me.dashCd > 0 ? '#9ad' : '#4cff7a'; ctx.fillRect(cx - 60, ch - 22, 120 * (1 - me.dashCd / dmax), 5);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(isL ? 'DASH (space)' : 'DASH (space) · SPRINT (shift)', cx, ch - 26);
    if (me.stun > 0) { ctx.fillStyle = 'rgba(255,220,0,0.2)'; ctx.fillRect(0, 0, cw, ch); ctx.fillStyle = '#ffd60a'; ctx.font = 'bold 40px sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('STUNNED', cx, cy - 60); }
    if (isL && me.pr <= 25) { const g = ctx.createRadialGradient(cx, cy, ch * 0.3, cx, cy, ch * 0.8); g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, 'rgba(255,0,0,0.35)'); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch); }
  }

  function drawTopBar(ctx, cw, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cw, 54);
    ctx.fillStyle = state.timeLeft < 10 * SIM.TPS ? '#ff5252' : '#fff'; ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtTime(state.timeLeft), cw / 2, 27);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#aaa'; ctx.fillText('LeBron at 0:00 wins', cw / 2, 47);
    for (let i = 0; i < 2; i++) {
      const p = state.players[i], isL = state.lebron === i, left = i === 0;
      const x0 = left ? 16 : cw - 16;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillStyle = isL ? GOLD : '#ddd'; ctx.font = 'bold 18px sans-serif';
      ctx.fillText((i === ui.myIdx ? '(you) ' : '') + ui.names[i] + ' — ' + (isL ? 'LEBRON' : 'PAPARAZZI'), x0, 16);
      if (isL) {
        const w = Math.min(220, cw * 0.2), h = 12, bx = left ? x0 : x0 - w;
        ctx.fillStyle = '#333'; ctx.fillRect(bx, 30, w, h);
        const frac = p.pr / SIM.PR_MAX;
        ctx.fillStyle = frac > 0.5 ? '#4caf50' : frac > 0.25 ? '#ffb300' : '#ff5252'; ctx.fillRect(bx, 30, w * frac, h);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('PR ' + p.pr, left ? bx + w + 8 : bx - 8, 36);
        ctx.fillStyle = '#ccc'; ctx.font = '11px sans-serif'; ctx.fillText('perk: ' + SIM.PERKS.L[p.perkL].name, x0, 50);
      } else {
        for (let k = 0; k < state.cfg.photos; k++) {
          const fx = left ? x0 + k * 26 : x0 - 20 - k * 26;
          ctx.fillStyle = k < p.photos ? '#fff' : '#444'; ctx.fillRect(fx, 28, 20, 16);
          ctx.fillStyle = k < p.photos ? '#9ad' : '#333'; ctx.beginPath(); ctx.arc(fx + 10, 36, 5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(p.photos + '/' + state.cfg.photos + ' photos', left ? x0 + state.cfg.photos * 26 + 6 : x0 - state.cfg.photos * 26 - 6, 36);
        ctx.fillStyle = '#ccc'; ctx.font = '11px sans-serif'; ctx.fillText('perk: ' + SIM.PERKS.P[p.perkP].name, x0, 50);
      }
    }
    if (ui.rtt != null) { ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '11px sans-serif'; ctx.fillText('ping ' + ui.rtt + 'ms · delay ' + ui.delay + 't', cw - 8, 66); }
  }

  function drawMinimap(ctx, cw, ch, state, ui) {
    const mw = Math.min(260, cw * 0.22), mh = mw * SIM.HPX / SIM.WPX, k = mw / SIM.WPX;
    const x0 = 14, y0 = ch - mh - 14, isLme = state.lebron === ui.myIdx;
    ctx.save(); ctx.translate(x0, y0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(-4, -4, mw + 8, mh + 8);
    ctx.fillStyle = 'rgba(60,64,80,0.8)'; ctx.fillRect(0, 0, mw, mh);
    ctx.fillStyle = 'rgba(139,30,45,0.7)'; ctx.fillRect(0, 330 * k, mw, 140 * k);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.strokeRect(0, 0, mw, mh);
    ctx.fillStyle = '#3f7d3a'; for (const o of SIM.OBSTACLES) { ctx.beginPath(); ctx.arc(px(o.x) * k, px(o.y) * k, px(SIM.OBS_R) * k, 0, Math.PI * 2); ctx.fill(); }
    for (const c of state.crowd) { ctx.fillStyle = c.down > 0 ? '#666' : CROWD_COLORS[c.col]; ctx.beginPath(); ctx.arc(px(c.x) * k, px(c.y) * k, 2.5, 0, Math.PI * 2); ctx.fill(); }
    const b = state.ball; if (b.st !== 0) { ctx.fillStyle = '#e8702a'; ctx.beginPath(); ctx.arc(px(b.x) * k, px(b.y) * k, 3, 0, Math.PI * 2); ctx.fill(); }
    for (let i = 0; i < 2; i++) {
      const p = state.players[i], isL = state.lebron === i, x = px(p.x) * k, y = px(p.y) * k, mine = i === ui.myIdx;
      if (!isL && !mine) { // the paparazzi hides among the fans unless exposed
        if (p.charge > 0 || p.exp >= SIM.EXPOSED || p.stun > 0) { ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('📷', x, y); }
        else { ctx.fillStyle = CROWD_COLORS[p.disg]; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); }
        continue;
      }
      if (!isL && mine) { const pp = SIM.papParams(p), ang = Math.atan2(p.fy, p.fx), half = Math.acos(pp.cosHalf / 256); ctx.fillStyle = p.charge > 0 ? 'rgba(255,60,60,0.35)' : 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, px(pp.range) * k, ang - half, ang + half); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = isL ? GOLD : CROWD_COLORS[p.disg]; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isL ? PURPLE : '#fff'; ctx.lineWidth = 2; ctx.stroke();
      const yaw = mine ? ui.yaw : Math.atan2(p.fy, p.fx);
      ctx.strokeStyle = mine ? '#4cff7a' : '#fff'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(yaw) * 11, y + Math.sin(yaw) * 11); ctx.stroke();
      if (mine) { ctx.fillStyle = '#4cff7a'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('YOU', x, y - 8); }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(isLme ? 'the paparazzi is one of these fans' : 'LeBron is the gold dot', 2, mh - 3);
    ctx.restore();
  }

  function drawSwapOverlay(ctx, cw, ch, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0, 0, cw, ch);
    const newL = 1 - state.lebron, cx = cw / 2; const s = Math.min(1, ch / 800);
    ctx.save(); ctx.translate(cx, 0); ctx.scale(s, s);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD; ctx.font = 'bold 54px sans-serif'; ctx.fillText('ROLE SWAP!', 0, 120);
    ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif';
    ctx.fillText(state.swapReason === 'photos' ? ui.names[newL] + ' got the shots — fame stolen!' : ui.names[state.lebron] + '\'s PR hit rock bottom!', 0, 170);
    ctx.fillText(ui.names[newL] + ' is now LEBRON · ' + ui.names[state.lebron] + ' is now PAPARAZZI', 0, 205);
    ctx.fillStyle = '#ff5252'; ctx.font = 'bold 40px monospace'; ctx.fillText(Math.ceil(state.freezeLeft / SIM.TPS), 0, 260);
    const me = state.players[ui.myIdx]; const willBeL = newL === ui.myIdx;
    const list = willBeL ? SIM.PERKS.L : SIM.PERKS.P; const cur = willBeL ? me.perkL : me.perkP;
    ctx.fillStyle = '#ccc'; ctx.font = '18px sans-serif'; ctx.fillText('Pick your ' + (willBeL ? 'LeBron' : 'Paparazzi') + ' perk with keys 1 / 2 / 3', 0, 320);
    list.forEach((pk, k) => {
      const y = 370 + k * 70, sel = k === cur;
      ctx.fillStyle = sel ? 'rgba(253,185,39,0.25)' : 'rgba(255,255,255,0.06)'; ctx.fillRect(-300, y - 26, 600, 56);
      ctx.strokeStyle = sel ? GOLD : '#555'; ctx.lineWidth = 2; ctx.strokeRect(-300, y - 26, 600, 56);
      ctx.fillStyle = sel ? GOLD : '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('[' + (k + 1) + '] ' + pk.name, -285, y - 6);
      ctx.fillStyle = '#bbb'; ctx.font = '14px sans-serif'; ctx.fillText(pk.desc, -285, y + 16);
      ctx.textAlign = 'center';
    });
    if (!willBeL) { ctx.fillStyle = '#9ad'; ctx.font = '15px sans-serif'; ctx.fillText('You get a fresh disguise. Walk like a fan; sprinting, dashing and focusing blow your cover.', 0, 600); }
    ctx.restore();
  }

  function drawEndOverlay(ctx, cw, ch, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect(0, 0, cw, ch);
    const cx = cw / 2; const s = Math.min(1, cw / 1100);
    ctx.save(); ctx.translate(cx, 0); ctx.scale(s, s);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = state.winner;
    ctx.fillStyle = GOLD; ctx.font = 'bold 60px sans-serif'; ctx.fillText(ui.names[w] + ' WINS', 0, 200);
    ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText(w === ui.myIdx ? 'You stayed LeBron to the buzzer. 👑' : 'You were the paparazzi when time ran out.', 0, 250);
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#ccc';
    const stat = (i, y) => { const p = state.players[i]; ctx.fillText(ui.names[i] + ' — time as LeBron ' + fmtTime(p.lebronTicks) + ' · photos taken ' + p.snaps + ' · paparazzi bonks ' + p.hits + ' · crowd hits ' + p.crowdHits, 0, y); };
    stat(0, 320); stat(1, 350);
    ctx.fillText('Role swaps: ' + state.swaps, 0, 390);
    ctx.restore();
  }

  function noteRemoteThrow() { lastThrowRemote = performance.now(); }
  return { draw, handleEvents, fmtTime, noteRemoteThrow };
})();
