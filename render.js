'use strict';
// ---------------------------------------------------------------------------
// render.js — canvas drawing. Reads state, never mutates it.
// ---------------------------------------------------------------------------
const RENDER = (() => {
  const FP = SIM.FP;
  const CROWD_COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8ab6d6', '#c77dff', '#f4a261', '#90be6d', '#f28482'];
  const GOLD = '#FDB927', PURPLE = '#552583';
  let flash = 0; // camera flash alpha
  const floats = []; // floating texts {x,y,text,color,life}
  const parts = [];  // particles
  let shake = 0;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function px(v) { return v / FP; }

  function addFloat(x, y, text, color, size) { floats.push({ x: px(x), y: px(y), text, color, life: 1, size: size || 20 }); }
  function burst(x, y, color, n) { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5; parts.push({ x: px(x), y: px(y), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color }); } }

  function handleEvents(ev, myIdx, state) {
    for (const e of ev) {
      switch (e.t) {
        case 'snap': flash = 0.9; shake = 6; addFloat(e.x, e.y - 30 * FP, 'SNAP! ' + e.photos + '/' + state.cfg.photos, '#fff', 26); break;
        case 'miss': addFloat(e.x, e.y - 30 * FP, 'out of frame', '#bbb', 16); break;
        case 'papHit': shake = 8; burst(e.x, e.y, '#fff', 18); addFloat(e.x, e.y - 30 * FP, e.lost > 0 ? 'PHOTOS LOST!' : 'BONK', '#ff6b6b', 24); break;
        case 'crowdHit': shake = 5; burst(e.x, e.y, '#ffb703', 12); addFloat(e.x, e.y - 30 * FP, '-' + e.pr + ' PR', '#ff4d4d', 24); break;
        case 'catch': addFloat(e.x, e.y - 20 * FP, 'rebound!', GOLD, 16); break;
        case 'pickup': if (e.auto) addFloat(e.x, e.y - 20 * FP, 'ball returned', '#ddd', 14); break;
        case 'swapStart': shake = 10; break;
        case 'bounce': burst(e.x, e.y, '#ffa94d', 3); break;
      }
    }
  }

  function fmtTime(ticks) { const s = Math.ceil(ticks / SIM.TPS); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function draw(ctx, cw, ch, state, prev, alpha, ui) {
    const scale = Math.min(cw / SIM.WPX, ch / SIM.HPX);
    const ox = (cw - SIM.WPX * scale) / 2, oy = (ch - SIM.HPX * scale) / 2;
    ctx.save();
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, cw, ch);
    ctx.translate(ox, oy); ctx.scale(scale, scale);
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.85; if (shake < 0.3) shake = 0; }
    const ip = (cur, pv) => prev && prev.phase === state.phase ? lerp(pv, cur, alpha) : cur;

    // arena
    ctx.fillStyle = '#2b2f3a'; ctx.fillRect(0, 0, SIM.WPX, SIM.HPX);
    ctx.fillStyle = '#8b1e2d'; ctx.fillRect(0, 330, SIM.WPX, 140); // red carpet
    ctx.fillStyle = '#a62537'; for (let x = 0; x < SIM.WPX; x += 80) ctx.fillRect(x, 330, 40, 140);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let x = 0; x <= SIM.WPX; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, SIM.HPX); ctx.stroke(); }
    for (let y = 0; y <= SIM.HPX; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(SIM.WPX, y); ctx.stroke(); }
    ctx.strokeStyle = GOLD; ctx.lineWidth = 4; ctx.strokeRect(2, 2, SIM.WPX - 4, SIM.HPX - 4);

    // obstacles (planters)
    for (const o of SIM.OBSTACLES) {
      const x = px(o.x), y = px(o.y), r = px(SIM.OBS_R);
      ctx.fillStyle = '#1d1f26'; ctx.beginPath(); ctx.arc(x, y + 4, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5a4634'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3f7d3a'; ctx.beginPath(); ctx.arc(x, y, r - 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5aa84f'; ctx.beginPath(); ctx.arc(x - 10, y - 8, r - 22, 0, Math.PI * 2); ctx.fill();
    }

    const L = state.players[state.lebron], P = state.players[1 - state.lebron];
    const pos = (i) => { const p = state.players[i]; return prev ? [ip(px(p.x), px(prev.p[i][0])), ip(px(p.y), px(prev.p[i][1]))] : [px(p.x), px(p.y)]; };

    // paparazzi view cone
    if (state.phase !== 2) {
      const pp = SIM.papParams(P);
      const [cx, cy] = pos(1 - state.lebron);
      const ang = Math.atan2(P.fy, P.fx), half = Math.acos(pp.cosHalf / 256), r = px(pp.range);
      const charging = P.charge > 0;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, ang - half, ang + half); ctx.closePath();
      ctx.fillStyle = charging ? 'rgba(255,60,60,0.22)' : P.snapCd > 0 ? 'rgba(120,120,120,0.08)' : 'rgba(255,255,255,0.10)';
      ctx.fill();
      ctx.strokeStyle = charging ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2; ctx.stroke();
      if (charging) {
        const frac = P.charge / pp.charge;
        ctx.beginPath(); ctx.arc(cx, cy, 30, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 5; ctx.stroke();
      }
    }

    // crowd
    state.crowd.forEach((c, i) => {
      const x = prev && prev.c[i] ? ip(px(c.x), px(prev.c[i][0])) : px(c.x);
      const y = prev && prev.c[i] ? ip(px(c.y), px(prev.c[i][1])) : px(c.y);
      const r = px(SIM.CROWD_R);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(x, y + r - 2, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      if (c.down > 0) {
        ctx.fillStyle = CROWD_COLORS[c.col]; ctx.beginPath(); ctx.ellipse(x, y + 4, r * 1.3, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#222'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('x_x', x, y + 8);
      } else {
        ctx.fillStyle = CROWD_COLORS[c.col]; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f1d3b3'; ctx.beginPath(); ctx.arc(x, y - 3, r * 0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x - 3, y - 4, 1.5, 0, Math.PI * 2); ctx.arc(x + 3, y - 4, 1.5, 0, Math.PI * 2); ctx.fill();
        if (c.face === 0) { ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y - 1, 3, 0.2, Math.PI - 0.2); ctx.stroke(); }
      }
    });

    // ball (on ground / flying)
    const b = state.ball;
    const bx = prev && prev.b[2] === b.st ? ip(px(b.x), px(prev.b[0])) : px(b.x);
    const by = prev && prev.b[2] === b.st ? ip(px(b.y), px(prev.b[1])) : px(b.y);
    const drawBall = (x, y) => {
      const r = px(SIM.BALL_R);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(x, y + r + 2, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8702a'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3a1d0d'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
    };
    if (b.st !== 0) {
      if (b.st === 2) { const lp = SIM.lebronParams(state, L); const t = 1 - b.ground / lp.returnTicks; ctx.strokeStyle = 'rgba(253,185,39,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bx, by, 16, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke(); }
      drawBall(bx, by);
    }

    // players
    for (let i = 0; i < 2; i++) {
      const p = state.players[i]; const [x, y] = pos(i); const r = px(SIM.PLAYER_R);
      const isL = state.lebron === i;
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(x, y + r, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      if (p.dashLeft > 0) { ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - p.ddx / 256 * 40, y - p.ddy / 256 * 40); ctx.lineTo(x, y); ctx.stroke(); }
      if (isL) {
        ctx.fillStyle = PURPLE; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(x, y, r - 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = PURPLE; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('23', x, y + 1);
        // headband
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r - 2, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
        if (b.st === 0 && b.holder === i) drawBall(x + p.fx / 256 * 22, y + p.fy / 256 * 22);
        else { ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + p.fx / 256 * r, y + p.fy / 256 * r); ctx.lineTo(x + p.fx / 256 * (r + 10), y + p.fy / 256 * (r + 10)); ctx.stroke(); }
      } else {
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#3a3a3a'; ctx.beginPath(); ctx.arc(x, y, r - 4, 0, Math.PI * 2); ctx.fill();
        // camera
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(p.fy, p.fx));
        ctx.fillStyle = '#222'; ctx.fillRect(4, -9, 20, 18);
        ctx.fillStyle = p.charge > 0 ? '#ff3b3b' : '#9ad'; ctx.beginPath(); ctx.arc(24, 0, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#eee'; ctx.fillRect(8, -13, 8, 4);
        ctx.restore();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (p.stun > 0) ctx.fillText('@_@', x, y);
      }
      // name + YOU marker
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = i === ui.myIdx ? '#fff' : '#bbb';
      ctx.fillText((i === ui.myIdx ? '▼ ' : '') + ui.names[i], x, y - r - 8);
      // dash cooldown pip
      if (p.dashCd > 0) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x - 14, y + r + 6, 28 * (1 - p.dashCd / 60), 3); }
      // stun stars
      if (p.stun > 0) { ctx.fillStyle = '#ffd60a'; ctx.font = '14px sans-serif'; ctx.fillText('✦ ✦ ✦', x, y - r - 22); }
    }

    // particles & floats
    for (let i = parts.length - 1; i >= 0; i--) { const q = parts[i]; q.x += q.vx; q.y += q.vy; q.vy += 0.15; q.life -= 0.04; if (q.life <= 0) { parts.splice(i, 1); continue; } ctx.globalAlpha = q.life; ctx.fillStyle = q.color; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
    for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.y -= 0.7; f.life -= 0.018; if (f.life <= 0) { floats.splice(i, 1); continue; } ctx.globalAlpha = Math.min(1, f.life * 2); ctx.fillStyle = f.color; ctx.font = 'bold ' + f.size + 'px sans-serif'; ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4; ctx.strokeText(f.text, f.x, f.y); ctx.fillText(f.text, f.x, f.y); }
    ctx.globalAlpha = 1;

    drawHUD(ctx, state, ui);
    // overlays
    if (state.phase === 1) drawSwapOverlay(ctx, state, ui);
    if (state.phase === 2) drawEndOverlay(ctx, state, ui);
    if (flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + flash + ')'; ctx.fillRect(-50, -50, SIM.WPX + 100, SIM.HPX + 100); flash -= 0.06; }
    ctx.restore();
    if (ui.stallMs > 250) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cw / 2 - 150, ch / 2 - 30, 300, 60); ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Waiting for opponent… ' + (ui.stallMs / 1000).toFixed(1) + 's', cw / 2, ch / 2); }
  }

  function drawHUD(ctx, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, SIM.WPX, 54);
    // timer
    ctx.fillStyle = state.timeLeft < 10 * SIM.TPS ? '#ff5252' : '#fff'; ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtTime(state.timeLeft), SIM.WPX / 2, 27);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#aaa'; ctx.fillText('LeBron at 0:00 wins', SIM.WPX / 2, 47);
    for (let i = 0; i < 2; i++) {
      const p = state.players[i], isL = state.lebron === i, left = i === 0;
      const x0 = left ? 16 : SIM.WPX - 16, dir = left ? 1 : -1;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillStyle = isL ? GOLD : '#ddd'; ctx.font = 'bold 18px sans-serif';
      ctx.fillText((i === ui.myIdx ? '(you) ' : '') + ui.names[i] + ' — ' + (isL ? 'LEBRON' : 'PAPARAZZI'), x0, 16);
      if (isL) {
        // PR bar
        const w = 220, h = 12, bx = left ? x0 : x0 - w;
        ctx.fillStyle = '#333'; ctx.fillRect(bx, 30, w, h);
        const frac = p.pr / SIM.PR_MAX;
        ctx.fillStyle = frac > 0.5 ? '#4caf50' : frac > 0.25 ? '#ffb300' : '#ff5252'; ctx.fillRect(bx, 30, w * frac, h);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('PR ' + p.pr, left ? bx + w + 8 : bx - 8, 36);
        ctx.fillStyle = '#ccc'; ctx.font = '11px sans-serif'; ctx.fillText('perk: ' + SIM.PERKS.L[p.perkL].name, x0, 50);
      } else {
        // photos
        for (let k = 0; k < state.cfg.photos; k++) {
          const fx = left ? x0 + k * 26 : x0 - 20 - k * 26;
          ctx.fillStyle = k < p.photos ? '#fff' : '#444'; ctx.fillRect(fx, 28, 20, 16);
          ctx.fillStyle = k < p.photos ? '#9ad' : '#333'; ctx.beginPath(); ctx.arc(fx + 10, 36, 5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(p.photos + '/' + state.cfg.photos + ' photos', left ? x0 + state.cfg.photos * 26 + 6 : x0 - state.cfg.photos * 26 - 6, 36);
        ctx.fillStyle = '#ccc'; ctx.font = '11px sans-serif'; ctx.fillText('perk: ' + SIM.PERKS.P[p.perkP].name, x0, 50);
      }
    }
    // bottom hint
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '12px sans-serif';
    const me = state.players[ui.myIdx], isLme = state.lebron === ui.myIdx;
    ctx.fillText(isLme ? 'WASD move · mouse aim · click/space THROW · shift DASH · Don\'t hit the crowd!' : 'WASD move · mouse aim · HOLD click/space to SNAP (keep him in frame) · shift DASH', SIM.WPX / 2, SIM.HPX - 12);
    if (ui.rtt != null) { ctx.textAlign = 'right'; ctx.fillText('ping ' + ui.rtt + 'ms · delay ' + ui.delay + 't', SIM.WPX - 8, SIM.HPX - 12); }
  }

  function drawSwapOverlay(ctx, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 0, SIM.WPX, SIM.HPX);
    const newL = 1 - state.lebron;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD; ctx.font = 'bold 54px sans-serif'; ctx.fillText('ROLE SWAP!', SIM.WPX / 2, 150);
    ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif';
    ctx.fillText(state.swapReason === 'photos' ? ui.names[newL] + ' got the shots — fame stolen!' : ui.names[state.lebron] + '\'s PR hit rock bottom!', SIM.WPX / 2, 200);
    ctx.fillText(ui.names[newL] + ' is now LEBRON · ' + ui.names[state.lebron] + ' is now PAPARAZZI', SIM.WPX / 2, 235);
    ctx.fillStyle = '#ff5252'; ctx.font = 'bold 40px monospace'; ctx.fillText(Math.ceil(state.freezeLeft / SIM.TPS), SIM.WPX / 2, 290);
    const me = state.players[ui.myIdx]; const willBeL = newL === ui.myIdx;
    const list = willBeL ? SIM.PERKS.L : SIM.PERKS.P; const cur = willBeL ? me.perkL : me.perkP;
    ctx.fillStyle = '#ccc'; ctx.font = '18px sans-serif'; ctx.fillText('Pick your ' + (willBeL ? 'LeBron' : 'Paparazzi') + ' perk with keys 1 / 2 / 3', SIM.WPX / 2, 350);
    list.forEach((pk, k) => {
      const y = 400 + k * 70, sel = k === cur;
      ctx.fillStyle = sel ? 'rgba(253,185,39,0.25)' : 'rgba(255,255,255,0.06)'; ctx.fillRect(SIM.WPX / 2 - 300, y - 26, 600, 56);
      ctx.strokeStyle = sel ? GOLD : '#555'; ctx.lineWidth = 2; ctx.strokeRect(SIM.WPX / 2 - 300, y - 26, 600, 56);
      ctx.fillStyle = sel ? GOLD : '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('[' + (k + 1) + '] ' + pk.name, SIM.WPX / 2 - 285, y - 6);
      ctx.fillStyle = '#bbb'; ctx.font = '14px sans-serif'; ctx.fillText(pk.desc, SIM.WPX / 2 - 285, y + 16);
    });
    ctx.textAlign = 'center';
  }

  function drawEndOverlay(ctx, state, ui) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, SIM.WPX, SIM.HPX);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = state.winner;
    ctx.fillStyle = GOLD; ctx.font = 'bold 60px sans-serif'; ctx.fillText(ui.names[w] + ' WINS', SIM.WPX / 2, 200);
    ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText(w === ui.myIdx ? 'You stayed LeBron to the buzzer. 👑' : 'You were the paparazzi when time ran out.', SIM.WPX / 2, 250);
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#ccc';
    const stat = (i, y) => { const p = state.players[i]; ctx.fillText(ui.names[i] + ' — time as LeBron ' + fmtTime(p.lebronTicks) + ' · photos taken ' + p.snaps + ' · paparazzi bonks ' + p.hits + ' · crowd hits ' + p.crowdHits, SIM.WPX / 2, y); };
    stat(0, 320); stat(1, 350);
    ctx.fillText('Role swaps: ' + state.swaps, SIM.WPX / 2, 390);
  }

  return { draw, handleEvents, fmtTime };
})();
