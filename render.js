'use strict';
// ---------------------------------------------------------------------------
// render.js — first-person view (billboard sprites on a 2D canvas) + minimap.
// Reads state, never mutates it.
// ---------------------------------------------------------------------------
const RENDER = (() => {
  const FP = SIM.FP;
  const CROWD_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab6d6', '#c77dff', '#f4a261', '#90be6d', '#f28482'];
  const GOLD = '#FDB927', PURPLE = '#552583';
  const EYE_H = 46, WALL_H = 90, PLAYER_H = 60, CROWD_H = 50, PLANTER_H = 34, NEAR = 6;
  const FOV = Math.PI / 2; // 90° horizontal
  let flash = 0, shake = 0;
  const floats = []; // {wx,wy,h,text,color,life,size}
  const STARS = []; for (let i = 0; i < 90; i++) STARS.push({ az: (i * 2.399) % (Math.PI * 2), y: (Math.sin(i * 12.9898) * 0.5 + 0.5), s: 1 + (i % 3) });

  function px(v) { return v / FP; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function addFloat(wx, wy, text, color, size) { floats.push({ wx: px(wx), wy: px(wy), h: 70, text, color, life: 1, size: size || 20 }); }

  function handleEvents(ev, myIdx, state) {
    for (const e of ev) {
      switch (e.t) {
        case 'snap': flash = e.i === myIdx ? 0.6 : 0.9; shake = 6; addFloat(e.x, e.y, 'SNAP! ' + e.photos + '/' + state.cfg.photos, '#fff', 26); break;
        case 'miss': addFloat(e.x, e.y, 'out of frame', '#bbb', 16); break;
        case 'papHit': shake = 10; addFloat(e.x, e.y, e.lost > 0 ? 'PHOTOS LOST!' : 'BONK', '#ff6b6b', 26); break;
        case 'crowdHit': shake = 6; addFloat(e.x, e.y, '-' + e.pr + ' PR', '#ff4d4d', 26); break;
        case 'catch': addFloat(e.x, e.y, 'rebound!', GOLD, 16); break;
        case 'pickup': if (e.auto) addFloat(e.x, e.y, 'ball returned', '#ddd', 14); break;
        case 'swapStart': shake = 12; break;
      }
    }
  }
  function fmtTime(ticks) { const s = Math.ceil(ticks / SIM.TPS); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  // ---- camera / projection ----------------------------------------------
  let cam = { x: 0, y: 0, yaw: 0, fx: 1, fy: 0, rx: 0, ry: 1, focal: 1, W: 1, H: 1, hor: 1 };
  function toCam(wx, wy) { const dx = wx - cam.x, dy = wy - cam.y; return { x: dx * cam.rx + dy * cam.ry, z: dx * cam.fx + dy * cam.fy }; }
  function projX(c) { return cam.W / 2 + cam.focal * c.x / c.z; }
  function projY(c, h) { return cam.hor + cam.focal * (EYE_H - h) / c.z; }
  function clipPoly(pts) { // Sutherland-Hodgman against z >= NEAR (camera space)
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) { const t = (NEAR - a.z) / (b.z - a.z); out.push({ x: a.x + (b.x - a.x) * t, z: NEAR }); }
    }
    return out;
  }
  function floorPoly(ctx, worldPts, fill, stroke) {
    const c = clipPoly(worldPts.map(p => toCam(p[0], p[1])));
    if (c.length < 3) return;
    ctx.beginPath(); c.forEach((q, i) => { const sx = projX(q), sy = projY(q, 0); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function floorLine(ctx, x0, y0, x1, y1) {
    let a = toCam(x0, y0), b = toCam(x1, y1);
    if (a.z < NEAR && b.z < NEAR) return;
    if (a.z < NEAR) { const t = (NEAR - a.z) / (b.z - a.z); a = { x: a.x + (b.x - a.x) * t, z: NEAR }; }
    if (b.z < NEAR) { const t = (NEAR - b.z) / (a.z - b.z); b = { x: b.x + (a.x - b.x) * t, z: NEAR }; }
    ctx.beginPath(); ctx.moveTo(projX(a), projY(a, 0)); ctx.lineTo(projX(b), projY(b, 0)); ctx.stroke();
  }
  function wall(ctx, x0, y0, x1, y1) {
    let a = toCam(x0, y0), b = toCam(x1, y1);
    if (a.z < NEAR && b.z < NEAR) return;
    if (a.z < NEAR) { const t = (NEAR - a.z) / (b.z - a.z); a = { x: a.x + (b.x - a.x) * t, z: NEAR }; }
    if (b.z < NEAR) { const t = (NEAR - b.z) / (a.z - b.z); b = { x: b.x + (a.x - b.x) * t, z: NEAR }; }
    const ax = projX(a), bx = projX(b);
    const band = (h0, h1, color) => { ctx.beginPath(); ctx.moveTo(ax, projY(a, h0)); ctx.lineTo(bx, projY(b, h0)); ctx.lineTo(bx, projY(b, h1)); ctx.lineTo(ax, projY(a, h1)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); };
    band(0, WALL_H, '#3a3f4d'); band(WALL_H - 6, WALL_H, '#20232b'); band(26, 34, GOLD); band(0, 8, '#1b1d24');
    // posters along the wall
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 160));
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.3) / n, t1 = (i + 0.7) / n;
      let p = toCam(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0), q = toCam(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
      if (p.z < NEAR || q.z < NEAR) continue;
      ctx.beginPath(); ctx.moveTo(projX(p), projY(p, 42)); ctx.lineTo(projX(q), projY(q, 42)); ctx.lineTo(projX(q), projY(q, 78)); ctx.lineTo(projX(p), projY(p, 78)); ctx.closePath();
      ctx.fillStyle = i % 2 ? '#6b2a7a' : '#8b1e2d'; ctx.fill();
    }
  }

  // ---- sprites -----------------------------------------------------------
  function spriteBegin(ctx, c, fogOut) { // sets up a feet-origin coordinate system in world px; returns false if behind camera
    if (c.z < NEAR) return false;
    const k = cam.focal / c.z;
    ctx.save(); ctx.translate(projX(c), projY(c, 0)); ctx.scale(k, k);
    return true;
  }
  function shadow(ctx, r) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.35, 0, 0, Math.PI * 2); ctx.fill(); }
  function drawLebron(ctx, p, holdingBall, rel) {
    shadow(ctx, 20);
    // legs/shorts
    ctx.fillStyle = PURPLE; ctx.fillRect(-13, -28, 26, 28);
    ctx.fillStyle = '#3b2616'; ctx.fillRect(-11, -8, 8, 8); ctx.fillRect(3, -8, 8, 8);
    // jersey
    ctx.fillStyle = GOLD; ctx.beginPath(); ctx.moveTo(-16, -52); ctx.lineTo(16, -52); ctx.lineTo(14, -26); ctx.lineTo(-14, -26); ctx.closePath(); ctx.fill();
    ctx.fillStyle = PURPLE; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('23', 0, -40);
    // arms
    ctx.fillStyle = '#5c3a21'; ctx.fillRect(-21, -50, 6, 22); ctx.fillRect(15, -50, 6, 22);
    // head + headband
    ctx.fillStyle = '#5c3a21'; ctx.beginPath(); ctx.arc(0, -62, 10, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, -64, 9, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    // facing hint: eyes if looking at camera
    if (rel > 0.3) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-3.5, -63, 1.8, 0, Math.PI * 2); ctx.arc(3.5, -63, 1.8, 0, Math.PI * 2); ctx.fill(); }
    if (holdingBall) drawBallShape(ctx, 20, -38, 8);
    if (p.stun > 0) { ctx.fillStyle = '#ffd60a'; ctx.font = '12px sans-serif'; ctx.fillText('✦ ✦ ✦', 0, -80); }
  }
  function drawPaparazzi(ctx, p, rel) {
    shadow(ctx, 20);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(-12, -30, 24, 30);
    ctx.fillStyle = '#2b2b2b'; ctx.beginPath(); ctx.moveTo(-15, -54); ctx.lineTo(15, -54); ctx.lineTo(13, -28); ctx.lineTo(-13, -28); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c9a27e'; ctx.beginPath(); ctx.arc(0, -62, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillRect(-11, -73, 22, 6); // cap
    if (rel > -0.2) { // camera facing us
      ctx.fillStyle = '#222'; ctx.fillRect(-9, -66, 18, 12);
      ctx.fillStyle = p.charge > 0 ? '#ff3b3b' : '#9ad'; ctx.beginPath(); ctx.arc(0, -60, 5, 0, Math.PI * 2); ctx.fill();
      if (p.charge > 0) { ctx.fillStyle = 'rgba(255,60,60,0.35)'; ctx.beginPath(); ctx.arc(0, -60, 10, 0, Math.PI * 2); ctx.fill(); }
    } else { ctx.fillStyle = '#222'; ctx.fillRect(-9, -60, 18, 5); }
    if (p.stun > 0) { ctx.fillStyle = '#ffd60a'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✦ ✦ ✦', 0, -82); }
  }
  function drawCrowd(ctx, c) {
    if (c.down > 0) {
      ctx.fillStyle = CROWD_COLORS[c.col]; ctx.beginPath(); ctx.ellipse(0, -6, 24, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f1d3b3'; ctx.beginPath(); ctx.arc(22, -8, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222'; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('x_x', 22, -8);
      return;
    }
    shadow(ctx, 16);
    ctx.fillStyle = '#334'; ctx.fillRect(-9, -22, 18, 22);
    ctx.fillStyle = CROWD_COLORS[c.col]; ctx.fillRect(-13, -44, 26, 24);
    ctx.fillStyle = '#f1d3b3'; ctx.beginPath(); ctx.arc(0, -52, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(-3, -53, 1.5, 0, Math.PI * 2); ctx.arc(3, -53, 1.5, 0, Math.PI * 2); ctx.fill();
    if (c.face === 1) { ctx.fillStyle = '#333'; ctx.fillRect(-9, -62, 18, 5); }
    if (c.face === 2) { ctx.fillStyle = '#fff'; ctx.fillRect(-8, -40, 16, 10); ctx.fillStyle = '#000'; ctx.font = 'bold 6px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('KING', 0, -35); }
  }
  function drawBallShape(ctx, x, y, r) {
    ctx.fillStyle = '#e8702a'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3a1d0d'; ctx.lineWidth = r / 6; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
  }
  function drawPlanter(ctx) {
    const r = px(SIM.OBS_R);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 0, r + 4, (r + 4) * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5a4634'; ctx.fillRect(-r, -PLANTER_H, 2 * r, PLANTER_H);
    ctx.fillStyle = '#4a3828'; ctx.fillRect(-r, -PLANTER_H, 2 * r, 5);
    ctx.fillStyle = '#3f7d3a'; ctx.beginPath(); ctx.ellipse(0, -PLANTER_H - 8, r, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5aa84f'; ctx.beginPath(); ctx.arc(-r * 0.3, -PLANTER_H - 22, r * 0.5, 0, Math.PI * 2); ctx.arc(r * 0.35, -PLANTER_H - 18, r * 0.42, 0, Math.PI * 2); ctx.fill();
  }

  // ---- main draw ---------------------------------------------------------
  let lastDraw = 0;
  function draw(ctx, cw, ch, state, prev, alpha, ui) {
    const now = performance.now(); const dt = lastDraw ? Math.min(3, (now - lastDraw) / 16.67) : 1; lastDraw = now; // in 60fps-frames
    const me = state.players[ui.myIdx];
    const ip = (cur, pv) => prev && prev.phase === state.phase ? lerp(pv, cur, alpha) : cur;
    const pos = (i) => { const p = state.players[i]; return prev ? [ip(px(p.x), px(prev.p[i][0])), ip(px(p.y), px(prev.p[i][1]))] : [px(p.x), px(p.y)]; };
    const [mx, my] = pos(ui.myIdx);
    cam.W = cw; cam.H = ch; cam.hor = ch * 0.5; cam.focal = (cw / 2) / Math.tan(FOV / 2);
    cam.x = mx; cam.y = my; cam.yaw = ui.yaw; cam.fx = Math.cos(ui.yaw); cam.fy = Math.sin(ui.yaw); cam.rx = -cam.fy; cam.ry = cam.fx;
    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= Math.pow(0.85, dt); if (shake < 0.3) shake = 0; }

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, cam.hor); sky.addColorStop(0, '#070912'); sky.addColorStop(1, '#2a1d4d');
    ctx.fillStyle = sky; ctx.fillRect(-20, -20, cw + 40, cam.hor + 20);
    ctx.fillStyle = '#fff';
    for (const st of STARS) { let d = st.az - ui.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); if (Math.abs(d) < FOV / 2 + 0.1) { const sx = cw / 2 + cam.focal * Math.tan(d); ctx.globalAlpha = 0.5 + 0.5 * (st.s / 3); ctx.fillRect(sx, st.y * cam.hor * 0.8, st.s, st.s); } }
    ctx.globalAlpha = 1;
    // floor
    const floor = ctx.createLinearGradient(0, cam.hor, 0, ch); floor.addColorStop(0, '#20232b'); floor.addColorStop(1, '#3a3f4b');
    ctx.fillStyle = floor; ctx.fillRect(-20, cam.hor, cw + 40, ch - cam.hor + 20);
    // walls (always behind everything inside the arena)
    const Wp = SIM.WPX, Hp = SIM.HPX;
    wall(ctx, 0, 0, Wp, 0); wall(ctx, Wp, 0, Wp, Hp); wall(ctx, Wp, Hp, 0, Hp); wall(ctx, 0, Hp, 0, 0);
    // floor details
    floorPoly(ctx, [[0, 330], [Wp, 330], [Wp, 470], [0, 470]], '#8b1e2d');
    for (let x = 0; x < Wp; x += 80) floorPoly(ctx, [[x, 330], [x + 40, 330], [x + 40, 470], [x, 470]], '#a62537');
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    for (let x = 0; x <= Wp; x += 80) floorLine(ctx, x, 0, x, Hp);
    for (let y = 0; y <= Hp; y += 80) floorLine(ctx, 0, y, Wp, y);

    // sprites sorted far -> near
    const items = [];
    for (const o of SIM.OBSTACLES) items.push({ c: toCam(px(o.x), px(o.y)), kind: 'planter' });
    state.crowd.forEach((c, i) => { const x = prev && prev.c[i] ? ip(px(c.x), px(prev.c[i][0])) : px(c.x), y = prev && prev.c[i] ? ip(px(c.y), px(prev.c[i][1])) : px(c.y); items.push({ c: toCam(x, y), kind: 'crowd', c0: c }); });
    const oi = 1 - ui.myIdx, other = state.players[oi]; { const [ox, oy] = pos(oi); items.push({ c: toCam(ox, oy), kind: 'player', p: other, i: oi }); }
    const b = state.ball;
    if (b.st !== 0) { const bx = prev && prev.b[2] === b.st ? ip(px(b.x), px(prev.b[0])) : px(b.x), by = prev && prev.b[2] === b.st ? ip(px(b.y), px(prev.b[1])) : px(b.y); items.push({ c: toCam(bx, by), kind: 'ball', h: b.st === 1 ? 34 : 9 }); }
    items.sort((a, b2) => b2.c.z - a.c.z);
    for (const it of items) {
      if (!spriteBegin(ctx, it.c)) continue;
      if (it.kind === 'planter') drawPlanter(ctx);
      else if (it.kind === 'crowd') drawCrowd(ctx, it.c0);
      else if (it.kind === 'ball') { shadow(ctx, 9); drawBallShape(ctx, 0, -it.h, px(SIM.BALL_R)); if (b.st === 2) { const lp = SIM.lebronParams(state, state.players[state.lebron]); const t = 1 - b.ground / lp.returnTicks; ctx.strokeStyle = 'rgba(253,185,39,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -it.h, 15, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke(); } }
      else if (it.kind === 'player') {
        const p = it.p; const rel = -(p.fx * cam.fx + p.fy * cam.fy) / 256; // >0 when facing us
        if (state.lebron === it.i) drawLebron(ctx, p, b.st === 0 && b.holder === it.i, rel); else drawPaparazzi(ctx, p, rel);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3; ctx.strokeText(ui.names[it.i], 0, -84); ctx.fillText(ui.names[it.i], 0, -84);
      }
      ctx.restore();
    }
    // floating texts (world anchored)
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i]; f.h += 0.8 * dt; f.life -= 0.016 * dt; if (f.life <= 0) { floats.splice(i, 1); continue; }
      const c = toCam(f.wx, f.wy); if (c.z < NEAR) continue;
      const k = Math.min(1.6, Math.max(0.5, cam.focal / c.z * 1.2));
      ctx.globalAlpha = Math.min(1, f.life * 2); ctx.fillStyle = f.color; ctx.font = 'bold ' + Math.round(f.size * k) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4;
      ctx.strokeText(f.text, projX(c), projY(c, f.h)); ctx.fillText(f.text, projX(c), projY(c, f.h));
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    drawFirstPersonHUD(ctx, cw, ch, state, ui);
    drawTopBar(ctx, cw, state, ui);
    drawMinimap(ctx, cw, ch, state, ui);
    if (state.phase === 1) drawSwapOverlay(ctx, cw, ch, state, ui);
    if (state.phase === 2) drawEndOverlay(ctx, cw, ch, state, ui);
    if (flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + flash + ')'; ctx.fillRect(0, 0, cw, ch); flash -= 0.06 * dt; }
    if (ui.stallMs > 250) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cw / 2 - 150, ch / 2 - 30, 300, 60); ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Waiting for opponent… ' + (ui.stallMs / 1000).toFixed(1) + 's', cw / 2, ch / 2); }
    if (!ui.locked && state.phase === 0 && !ui.touch) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(cw / 2 - 170, ch - 110, 340, 36); ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Click the screen to capture the mouse', cw / 2, ch - 92); }
  }

  function drawFirstPersonHUD(ctx, cw, ch, state, ui) {
    const me = state.players[ui.myIdx], isL = state.lebron === ui.myIdx, b = state.ball;
    const cx = cw / 2, cy = ch / 2;
    if (isL) {
      // crosshair
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12); ctx.stroke();
      // hands + ball
      const hx = cw * 0.78, hy = ch + 10;
      ctx.fillStyle = '#5c3a21'; ctx.beginPath(); ctx.ellipse(hx, hy, 70, 50, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = GOLD; ctx.beginPath(); ctx.ellipse(hx + 40, hy + 30, 60, 40, -0.3, 0, Math.PI * 2); ctx.fill();
      if (b.st === 0 && b.holder === ui.myIdx) drawBallShape(ctx, hx - 20, hy - 70, 46);
      else { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(b.st === 2 ? 'ball loose — walk over it (or wait)' : 'ball in the air', hx - 20, hy - 70); }
    } else {
      const pp = SIM.papParams(me);
      const leb = state.players[1 - ui.myIdx];
      const framed = state.phase === 0 && SIM.inFrame(state, me, leb, pp);
      const half = Math.acos(pp.cosHalf / 256);
      const fx = Math.min(cw / 2 - 6, cam.focal * Math.tan(half));
      const fy = Math.min(ch / 2 - 40, fx * 0.62);
      const col = me.charge > 0 ? '#ff3b3b' : framed ? '#4cff7a' : me.snapCd > 0 ? '#777' : 'rgba(255,255,255,0.8)';
      ctx.strokeStyle = col; ctx.lineWidth = 3; const L = 28;
      const corner = (x, y, sx, sy) => { ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke(); };
      corner(cx - fx, cy - fy, 1, 1); corner(cx + fx, cy - fy, -1, 1); corner(cx - fx, cy + fy, 1, -1); corner(cx + fx, cy + fy, -1, -1);
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(me.charge > 0 ? 'FOCUSING…' : framed ? 'IN FRAME — hold to snap' : me.snapCd > 0 ? 'reloading' : 'find LeBron', cx, cy + fy + 22);
      if (me.charge > 0) { ctx.beginPath(); ctx.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + (me.charge / pp.charge) * Math.PI * 2); ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 5; ctx.stroke(); }
      // distance readout
      const d = Math.hypot(leb.x - me.x, leb.y - me.y) / FP; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '12px sans-serif'; ctx.fillText(Math.round(d) + ' / ' + Math.round(pp.range / FP) + ' range', cx, cy + fy + 40);
      // camera body at bottom
      ctx.fillStyle = '#151515'; ctx.fillRect(cw / 2 - 90, ch - 46, 180, 60); ctx.fillStyle = '#333'; ctx.fillRect(cw / 2 - 30, ch - 62, 60, 20); ctx.fillStyle = me.charge > 0 ? '#ff3b3b' : '#9ad'; ctx.beginPath(); ctx.arc(cw / 2, ch - 52, 7, 0, Math.PI * 2); ctx.fill();
    }
    // dash cooldown + stun
    const dmax = isL ? 54 : 42;
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(cx - 60, ch - 24, 120, 5);
    ctx.fillStyle = me.dashCd > 0 ? '#9ad' : '#4cff7a'; ctx.fillRect(cx - 60, ch - 24, 120 * (1 - me.dashCd / dmax), 5);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('DASH (shift)', cx, ch - 28);
    if (me.stun > 0) { ctx.fillStyle = 'rgba(255,220,0,0.25)'; ctx.fillRect(0, 0, cw, ch); ctx.fillStyle = '#ffd60a'; ctx.font = 'bold 40px sans-serif'; ctx.fillText('STUNNED', cx, cy - 60); }
    // damage vignette when PR low
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
    const x0 = 14, y0 = ch - mh - 14;
    ctx.save(); ctx.translate(x0, y0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(-4, -4, mw + 8, mh + 8);
    ctx.fillStyle = 'rgba(60,64,80,0.8)'; ctx.fillRect(0, 0, mw, mh);
    ctx.fillStyle = 'rgba(139,30,45,0.7)'; ctx.fillRect(0, 330 * k, mw, 140 * k);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.strokeRect(0, 0, mw, mh);
    ctx.fillStyle = '#3f7d3a'; for (const o of SIM.OBSTACLES) { ctx.beginPath(); ctx.arc(px(o.x) * k, px(o.y) * k, px(SIM.OBS_R) * k, 0, Math.PI * 2); ctx.fill(); }
    for (const c of state.crowd) { ctx.fillStyle = c.down > 0 ? '#666' : CROWD_COLORS[c.col]; ctx.beginPath(); ctx.arc(px(c.x) * k, px(c.y) * k, 2.5, 0, Math.PI * 2); ctx.fill(); }
    const b = state.ball; if (b.st !== 0) { ctx.fillStyle = '#e8702a'; ctx.beginPath(); ctx.arc(px(b.x) * k, px(b.y) * k, 3, 0, Math.PI * 2); ctx.fill(); }
    for (let i = 0; i < 2; i++) {
      const p = state.players[i], isL = state.lebron === i, x = px(p.x) * k, y = px(p.y) * k;
      if (!isL) { // paparazzi frame wedge
        const pp = SIM.papParams(p), ang = Math.atan2(p.fy, p.fx), half = Math.acos(pp.cosHalf / 256);
        ctx.fillStyle = p.charge > 0 ? 'rgba(255,60,60,0.35)' : 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, px(pp.range) * k, ang - half, ang + half); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = isL ? GOLD : '#fff'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isL ? PURPLE : '#000'; ctx.lineWidth = 2; ctx.stroke();
      const yaw = i === ui.myIdx ? ui.yaw : Math.atan2(p.fy, p.fx);
      ctx.strokeStyle = i === ui.myIdx ? '#4cff7a' : '#fff'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(yaw) * 11, y + Math.sin(yaw) * 11); ctx.stroke();
      if (i === ui.myIdx) { ctx.fillStyle = '#4cff7a'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('YOU', x, y - 8); }
    }
    ctx.restore();
  }

  function drawSwapOverlay(ctx, cw, ch, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, cw, ch);
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

  return { draw, handleEvents, fmtTime };
})();
