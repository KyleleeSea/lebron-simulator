'use strict';
// ---------------------------------------------------------------------------
// sim.js — fully deterministic game simulation.
// Rules for determinism: integer math only (positions in 1/16 px), no
// Math.random, no floats stored in state, no iteration over object keys with
// unstable order. Both peers run this identically on identical inputs.
// ---------------------------------------------------------------------------
const SIM = (() => {
  const FP = 16;                 // sub-units per pixel
  const TPS = 30;                // simulation ticks per second
  const WPX = 1280, HPX = 800;   // arena size in px
  const W = WPX * FP, H = HPX * FP;
  const PLAYER_R = 18 * FP, CROWD_R = 15 * FP, BALL_R = 9 * FP, OBS_R = 42 * FP;
  const PR_MAX = 100;
  const FREEZE_TICKS = 90;       // 3 s role-swap freeze
  const OBSTACLES = [
    { x: 300 * FP, y: 210 * FP }, { x: 980 * FP, y: 210 * FP },
    { x: 300 * FP, y: 590 * FP }, { x: 980 * FP, y: 590 * FP },
    { x: 640 * FP, y: 400 * FP },
  ];
  // Spawn pairs [lebron, paparazzi]; chosen by rng on each swap.
  const SPAWNS = [
    [{ x: 640, y: 640 }, { x: 640, y: 160 }],
    [{ x: 640, y: 160 }, { x: 640, y: 640 }],
    [{ x: 150, y: 400 }, { x: 1130, y: 400 }],
    [{ x: 1130, y: 400 }, { x: 150, y: 400 }],
  ];
  const PERKS = {
    L: [
      { name: 'Cannon Arm', desc: 'Ball flies 35% faster' },
      { name: 'Thick Skin', desc: 'Crowd hits cost 40% less PR' },
      { name: 'Quick Hands', desc: 'Loose ball comes back in 1.5s, wide pickup' },
    ],
    P: [
      { name: 'Zoom Lens', desc: '+40% snap range, narrow frame' },
      { name: 'Autofocus', desc: 'Photos charge 40% faster' },
      { name: 'Wide Angle', desc: 'Very wide frame, short range, +8% speed' },
    ],
  };
  const DEFAULT_CFG = { minutes: 3, crowd: 14, photos: 3, prHits: 4, startRole: 0, bot: false,
    perks: [{ L: 0, P: 0 }, { L: 0, P: 0 }] };
  const EMPTY_INPUT = [0, 0, 0, 0]; // [moveBits, actionBits, aimX, aimY]
  // action bits
  const A_PRIMARY = 1, A_DASH = 2, A_PERK1 = 4, A_PERK2 = 8, A_PERK3 = 16;

  // ---- deterministic helpers -------------------------------------------
  function rnd(s) { // mulberry32 step, returns uint32
    s.rng = (s.rng + 0x6D2B79F5) | 0;
    let t = s.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  function rndRange(s, lo, hi) { return lo + (rnd(s) % (hi - lo + 1)); }
  function isqrt(n) {
    if (n <= 0) return 0;
    let x = Math.floor(Math.sqrt(n));
    while (x * x > n) x--;
    while ((x + 1) * (x + 1) <= n) x++;
    return x;
  }
  function norm(dx, dy) { // unit vector scaled by 256
    const len = isqrt(dx * dx + dy * dy);
    if (len === 0) return { x: 0, y: 0 };
    return { x: Math.trunc(dx * 256 / len), y: Math.trunc(dy * 256 / len) };
  }
  function sgn(v, dead) { return v > dead ? 1 : v < -dead ? -1 : 0; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function segCircleHit(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let px = ax, py = ay;
    if (len2 > 0) {
      let t = (cx - ax) * dx + (cy - ay) * dy;
      t = clamp(t, 0, len2);
      px = ax + Math.trunc(dx * t / len2);
      py = ay + Math.trunc(dy * t / len2);
    }
    const ex = cx - px, ey = cy - py;
    return ex * ex + ey * ey <= r * r;
  }
  function moveBits(mx, my) { return (my < 0 ? 1 : 0) | (my > 0 ? 2 : 0) | (mx < 0 ? 4 : 0) | (mx > 0 ? 8 : 0); }

  // ---- perk-derived parameters -------------------------------------------
  function lebronParams(s, p) {
    const k = p.perkL;
    const baseHit = Math.ceil(PR_MAX / s.cfg.prHits);
    return {
      speed: 100,
      ballSpeed: k === 0 ? 480 : 352,
      prHit: k === 1 ? Math.trunc(baseHit * 3 / 5) : baseHit,
      returnTicks: k === 2 ? 45 : 120,
      pickupR: k === 2 ? 28 * FP : 8 * FP,
      dashCd: 54,
    };
  }
  function papParams(p) {
    const k = p.perkP;
    return {
      speed: k === 2 ? 117 : 108,
      range: k === 0 ? 330 * FP : k === 2 ? 180 * FP : 235 * FP,
      cosHalf: k === 0 ? 241 : k === 2 ? 147 : 210, // cos 20°, 55°, 35° (x256)
      charge: k === 1 ? 9 : 15,
      snapCd: 36,
      dashCd: 42,
    };
  }

  // ---- state construction ---------------------------------------------
  function makePlayer(i, cfg) {
    return { x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: -256, dashCd: 0, dashLeft: 0, ddx: 0, ddy: 0,
      stun: 0, pr: PR_MAX, photos: 0, charge: 0, snapCd: 0,
      perkL: cfg.perks[i].L | 0, perkP: cfg.perks[i].P | 0, prevA: 0,
      lebronTicks: 0, hits: 0, snaps: 0, crowdHits: 0, bd: 1 };
  }
  function overlapsAny(s, x, y, r) {
    for (const o of OBSTACLES) { const dx = x - o.x, dy = y - o.y; if (dx * dx + dy * dy < (r + OBS_R + 10 * FP) ** 2) return true; }
    for (const p of s.players) { const dx = x - p.x, dy = y - p.y; if (dx * dx + dy * dy < (r + PLAYER_R + 60 * FP) ** 2) return true; }
    return false;
  }
  function placePlayers(s) {
    const pair = SPAWNS[rnd(s) % SPAWNS.length];
    const L = s.players[s.lebron], P = s.players[1 - s.lebron];
    L.x = pair[0].x * FP; L.y = pair[0].y * FP; L.vx = L.vy = 0;
    P.x = pair[1].x * FP; P.y = pair[1].y * FP; P.vx = P.vy = 0;
    const f = norm(P.x - L.x, P.y - L.y);
    L.fx = f.x; L.fy = f.y; P.fx = -f.x; P.fy = -f.y;
    s.ball.st = 0; s.ball.holder = s.lebron; s.ball.vx = s.ball.vy = 0; s.ball.bounces = 0; s.ball.ground = 0; s.ball.grace = 0;
    s.ball.x = L.x; s.ball.y = L.y;
  }
  function createState(cfgIn, seed) {
    const cfg = Object.assign({}, DEFAULT_CFG, cfgIn || {});
    cfg.perks = [Object.assign({ L: 0, P: 0 }, (cfgIn && cfgIn.perks && cfgIn.perks[0]) || {}),
                 Object.assign({ L: 0, P: 0 }, (cfgIn && cfgIn.perks && cfgIn.perks[1]) || {})];
    const s = { tick: 0, rng: seed | 0, cfg, timeLeft: cfg.minutes * 60 * TPS, phase: 0, freezeLeft: 0,
      lebron: 0, swaps: 0, winner: -1, swapReason: '', players: [makePlayer(0, cfg), makePlayer(1, cfg)],
      ball: { st: 0, x: 0, y: 0, vx: 0, vy: 0, holder: 0, grace: 0, bounces: 0, ground: 0 }, crowd: [] };
    s.lebron = cfg.startRole === 1 ? 0 : cfg.startRole === 2 ? 1 : (rnd(s) & 1);
    placePlayers(s);
    for (let n = 0; n < cfg.crowd; n++) {
      let x = 0, y = 0;
      for (let tries = 0; tries < 30; tries++) {
        x = rndRange(s, 40 * FP, W - 40 * FP); y = rndRange(s, 40 * FP, H - 40 * FP);
        if (!overlapsAny(s, x, y, CROWD_R)) break;
      }
      s.crowd.push({ x, y, vx: 0, vy: 0, tx: x, ty: y, timer: rndRange(s, 10, 60), down: 0, col: rnd(s) % 8, face: rnd(s) % 3 });
    }
    return s;
  }

  // ---- line of sight -----------------------------------------------------
  function losClear(s, ax, ay, bx, by) {
    for (const o of OBSTACLES) if (segCircleHit(ax, ay, bx, by, o.x, o.y, OBS_R)) return false;
    for (const c of s.crowd) if (c.down === 0 && segCircleHit(ax, ay, bx, by, c.x, c.y, CROWD_R)) return false;
    return true;
  }
  function inFrame(s, pap, leb, pp) {
    const dx = leb.x - pap.x, dy = leb.y - pap.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > pp.range * pp.range) return false;
    const dist = isqrt(d2);
    const dot = pap.fx * dx + pap.fy * dy;      // = 256*dist*cos
    if (dot < pp.cosHalf * dist) return false;
    return losClear(s, pap.x, pap.y, leb.x, leb.y);
  }

  // ---- swaps -------------------------------------------------------------
  function startSwap(s, reason, ev) {
    s.phase = 1; s.freezeLeft = FREEZE_TICKS; s.swapReason = reason;
    for (const p of s.players) { p.charge = 0; p.stun = 0; p.dashLeft = 0; p.vx = p.vy = 0; }
    ev.push({ t: 'swapStart', reason, newLebron: 1 - s.lebron });
  }
  function applySwap(s, ev) {
    s.lebron = 1 - s.lebron; s.swaps++;
    for (const p of s.players) { p.pr = PR_MAX; p.photos = 0; p.snapCd = 0; p.charge = 0; p.dashCd = 0; p.dashLeft = 0; p.stun = 0; p.prevA = A_PRIMARY; }
    placePlayers(s);
    ev.push({ t: 'swapDone', lebron: s.lebron });
  }

  // ---- bot (deterministic, used in solo mode) ----------------------------
  function botInput(s, i) {
    const p = s.players[i], o = s.players[1 - i];
    if (s.phase !== 0) return EMPTY_INPUT;
    const isL = s.lebron === i;
    const dx = o.x - p.x, dy = o.y - p.y;
    const dist = isqrt(dx * dx + dy * dy);
    const aim = norm(dx, dy);
    let mx = 0, my = 0, a = 0;
    const DZ = 6 * FP;
    if (isL) {
      const b = s.ball;
      if (b.st === 2) { mx = sgn(b.x - p.x, DZ); my = sgn(b.y - p.y, DZ); }
      else {
        if (dist < 300 * FP) { mx = -sgn(dx, DZ); my = -sgn(dy, DZ); }
        else if (dist > 460 * FP) { mx = sgn(dx, DZ); my = sgn(dy, DZ); }
        else { mx = sgn(-dy * p.bd, DZ); my = sgn(dx * p.bd, DZ); }
        if ((rnd(s) % 90) === 0) p.bd = -p.bd;
        if (b.st === 0 && dist < 430 * FP && o.stun === 0 && losClear(s, p.x, p.y, o.x, o.y) && (rnd(s) & 7) === 0) a |= A_PRIMARY;
        if (o.charge > 0 && p.dashCd === 0) a |= A_DASH;
      }
    } else {
      if (dist > 140 * FP) { mx = sgn(dx, DZ); my = sgn(dy, DZ); }
      else { mx = sgn(-dy * p.bd, DZ); my = sgn(dx * p.bd, DZ); if ((rnd(s) % 60) === 0) p.bd = -p.bd; }
      const pp = papParams(p);
      if (dist < Math.trunc(pp.range * 9 / 10) && losClear(s, p.x, p.y, o.x, o.y)) a |= A_PRIMARY;
      if (dist > 480 * FP && p.dashCd === 0) a |= A_DASH;
      const b = s.ball;
      if (b.st === 1) {
        const bx = p.x - b.x, by = p.y - b.y;
        if (bx * b.vx + by * b.vy > 0 && bx * bx + by * by < (240 * FP) ** 2 && p.dashCd === 0) {
          mx = sgn(-b.vy, 0); my = sgn(b.vx, 0); a |= A_DASH;
        }
      }
    }
    // steer away from walls
    if (p.x < 90 * FP) mx = 1; else if (p.x > W - 90 * FP) mx = -1;
    if (p.y < 90 * FP) my = 1; else if (p.y > H - 90 * FP) my = -1;
    // slide around planters instead of pushing into them
    if (mx !== 0 || my !== 0) {
      for (const o of OBSTACLES) {
        const ox = o.x - p.x, oy = o.y - p.y;
        const od2 = ox * ox + oy * oy, lim = OBS_R + PLAYER_R + 40 * FP;
        if (od2 < lim * lim && ox * mx + oy * my > 0) {
          const side = (ox * my - oy * mx) >= 0 ? 1 : -1; // which side we are on
          mx = sgn(-oy * side, 0); my = sgn(ox * side, 0);
          break;
        }
      }
    }
    return [moveBits(mx, my), a, aim.x, aim.y];
  }

  // ---- player update -----------------------------------------------------
  function updatePlayer(s, i, inp, ev) {
    const p = s.players[i];
    const isL = s.lebron === i;
    const m = inp[0] | 0, a = inp[1] | 0;
    let ax = clamp(inp[2] | 0, -256, 256), ay = clamp(inp[3] | 0, -256, 256);
    const lp = isL ? lebronParams(s, p) : null;
    const pp = isL ? null : papParams(p);
    if (p.dashCd > 0) p.dashCd--;
    if (p.snapCd > 0) p.snapCd--;
    if (p.stun > 0) { p.stun--; }
    const canAct = p.stun === 0;
    let mx = ((m & 8) ? 1 : 0) - ((m & 4) ? 1 : 0);
    let my = ((m & 2) ? 1 : 0) - ((m & 1) ? 1 : 0);
    if (!canAct) { mx = 0; my = 0; }
    // facing
    if (ax !== 0 || ay !== 0) { const f = norm(ax, ay); p.fx = f.x; p.fy = f.y; }
    else if (mx !== 0 || my !== 0) { const f = norm(mx, my); p.fx = f.x; p.fy = f.y; }
    // dash
    if (canAct && (a & A_DASH) && p.dashCd === 0 && p.dashLeft === 0) {
      let d;
      if (mx !== 0 || my !== 0) d = norm(mx, my); else d = { x: p.fx, y: p.fy };
      p.ddx = d.x; p.ddy = d.y; p.dashLeft = 6; p.dashCd = isL ? lp.dashCd : pp.dashCd;
      p.charge = 0;
      ev.push({ t: 'dash', i });
    }
    // movement
    if (p.dashLeft > 0) {
      p.dashLeft--;
      p.vx = p.ddx; p.vy = p.ddy; // 256 units = 16 px/tick
    } else {
      let speed = isL ? lp.speed : pp.speed;
      if (!isL && p.charge > 0) speed = (speed * 154) >> 8;
      if (p.stun > 0) speed = 0;
      let vx = mx * speed, vy = my * speed;
      if (mx !== 0 && my !== 0) { vx = (vx * 181) >> 8; vy = (vy * 181) >> 8; }
      p.vx = vx; p.vy = vy;
    }
    p.x += p.vx; p.y += p.vy;
    p.x = clamp(p.x, PLAYER_R, W - PLAYER_R); p.y = clamp(p.y, PLAYER_R, H - PLAYER_R);
    // primary action
    const pressed = (a & A_PRIMARY) !== 0, edge = pressed && !(p.prevA & A_PRIMARY);
    if (isL) {
      const b = s.ball;
      if (canAct && edge && b.st === 0 && b.holder === i) {
        b.st = 1; b.holder = -1; b.bounces = 0; b.grace = 5; b.ground = 0;
        b.x = p.x + ((p.fx * (PLAYER_R + BALL_R)) >> 8); b.y = p.y + ((p.fy * (PLAYER_R + BALL_R)) >> 8);
        b.vx = (p.fx * lp.ballSpeed) >> 8; b.vy = (p.fy * lp.ballSpeed) >> 8;
        ev.push({ t: 'throw', x: b.x, y: b.y });
      }
    } else {
      const leb = s.players[1 - i];
      if (canAct && pressed && p.snapCd === 0 && p.dashLeft === 0) {
        if (inFrame(s, p, leb, pp)) {
          if (p.charge === 0) ev.push({ t: 'focus', i });
          p.charge++;
          if (p.charge >= pp.charge) {
            p.charge = 0; p.snapCd = pp.snapCd; p.photos++; p.snaps++;
            ev.push({ t: 'snap', x: p.x, y: p.y, i, photos: p.photos });
            if (p.photos >= s.cfg.photos) startSwap(s, 'photos', ev);
          }
        } else if (p.charge > 0) {
          p.charge = 0; p.snapCd = 12; ev.push({ t: 'miss', x: p.x, y: p.y, i });
        }
      } else if (p.charge > 0) { p.charge = 0; }
    }
    p.prevA = a;
  }

  // ---- ball --------------------------------------------------------------
  function dropBall(b) { b.st = 2; b.vx = Math.trunc(b.vx / 3); b.vy = Math.trunc(b.vy / 3); b.ground = 0; }
  function updateBall(s, ev) {
    const b = s.ball;
    const L = s.players[s.lebron], P = s.players[1 - s.lebron];
    const lp = lebronParams(s, L);
    if (b.st === 0) {
      const h = s.players[b.holder];
      b.x = h.x + ((h.fx * 14 * FP) >> 8); b.y = h.y + ((h.fy * 14 * FP) >> 8);
      return;
    }
    if (b.st === 1) {
      if (b.grace > 0) b.grace--;
      const SUB = 4;
      for (let k = 0; k < SUB && b.st === 1; k++) {
        b.x += Math.trunc(b.vx / SUB); b.y += Math.trunc(b.vy / SUB);
        // walls
        if (b.x < BALL_R) { b.x = BALL_R; b.vx = -b.vx; b.bounces++; ev.push({ t: 'bounce', x: b.x, y: b.y }); }
        else if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -b.vx; b.bounces++; ev.push({ t: 'bounce', x: b.x, y: b.y }); }
        if (b.y < BALL_R) { b.y = BALL_R; b.vy = -b.vy; b.bounces++; ev.push({ t: 'bounce', x: b.x, y: b.y }); }
        else if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy = -b.vy; b.bounces++; ev.push({ t: 'bounce', x: b.x, y: b.y }); }
        // obstacles
        for (const o of OBSTACLES) {
          const dx = b.x - o.x, dy = b.y - o.y, rr = OBS_R + BALL_R;
          if (dx * dx + dy * dy < rr * rr) {
            const n = norm(dx, dy);
            b.x = o.x + ((n.x * rr) >> 8); b.y = o.y + ((n.y * rr) >> 8);
            const vd = (b.vx * n.x + b.vy * n.y) >> 8;
            if (vd < 0) { b.vx -= (2 * vd * n.x) >> 8; b.vy -= (2 * vd * n.y) >> 8; b.bounces++; ev.push({ t: 'bounce', x: b.x, y: b.y }); }
          }
        }
        // paparazzi hit
        { const dx = b.x - P.x, dy = b.y - P.y, rr = PLAYER_R + BALL_R;
          if (dx * dx + dy * dy <= rr * rr) {
            const lost = P.photos;
            P.photos = 0; P.stun = 24; P.charge = 0; L.hits++;
            ev.push({ t: 'papHit', x: P.x, y: P.y, lost });
            dropBall(b); break;
          } }
        // crowd hit
        for (const c of s.crowd) {
          if (c.down > 0) continue;
          const dx = b.x - c.x, dy = b.y - c.y, rr = CROWD_R + BALL_R;
          if (dx * dx + dy * dy <= rr * rr) {
            c.down = 75; c.vx = Math.trunc(b.vx / 4); c.vy = Math.trunc(b.vy / 4);
            L.pr -= lp.prHit; L.crowdHits++;
            ev.push({ t: 'crowdHit', x: c.x, y: c.y, pr: lp.prHit });
            dropBall(b);
            if (L.pr <= 0) { L.pr = 0; startSwap(s, 'pr', ev); }
            break;
          }
        }
        if (b.st !== 1) break;
        // catch by lebron after rebound
        if (b.grace === 0) {
          const dx = b.x - L.x, dy = b.y - L.y, rr = PLAYER_R + BALL_R + 4 * FP;
          if (dx * dx + dy * dy <= rr * rr) { b.st = 0; b.holder = s.lebron; ev.push({ t: 'catch', x: b.x, y: b.y }); break; }
        }
        if (b.bounces > 2) { dropBall(b); break; }
      }
      return;
    }
    // ground
    b.x += b.vx; b.y += b.vy;
    b.vx = Math.trunc(b.vx * 29 / 32); b.vy = Math.trunc(b.vy * 29 / 32);
    b.x = clamp(b.x, BALL_R, W - BALL_R); b.y = clamp(b.y, BALL_R, H - BALL_R);
    for (const o of OBSTACLES) {
      const dx = b.x - o.x, dy = b.y - o.y, rr = OBS_R + BALL_R;
      if (dx * dx + dy * dy < rr * rr) { const n = norm(dx, dy); b.x = o.x + ((n.x * rr) >> 8); b.y = o.y + ((n.y * rr) >> 8); }
    }
    b.ground++;
    const dx = b.x - L.x, dy = b.y - L.y, rr = PLAYER_R + BALL_R + lp.pickupR;
    if (dx * dx + dy * dy <= rr * rr || b.ground >= lp.returnTicks) {
      b.st = 0; b.holder = s.lebron; ev.push({ t: 'pickup', x: b.x, y: b.y, auto: b.ground >= lp.returnTicks });
    }
  }

  // ---- crowd -------------------------------------------------------------
  function updateCrowd(s) {
    const L = s.players[s.lebron];
    for (const c of s.crowd) {
      if (c.down > 0) {
        c.down--; c.x += c.vx; c.y += c.vy; c.vx = Math.trunc(c.vx * 3 / 4); c.vy = Math.trunc(c.vy * 3 / 4);
        c.x = clamp(c.x, CROWD_R, W - CROWD_R); c.y = clamp(c.y, CROWD_R, H - CROWD_R);
        continue;
      }
      c.timer--;
      if (c.timer <= 0) {
        if ((rnd(s) & 1) === 0) {
          c.tx = clamp(L.x + rndRange(s, -220 * FP, 220 * FP), 30 * FP, W - 30 * FP);
          c.ty = clamp(L.y + rndRange(s, -220 * FP, 220 * FP), 30 * FP, H - 30 * FP);
        } else {
          c.tx = rndRange(s, 30 * FP, W - 30 * FP); c.ty = rndRange(s, 30 * FP, H - 30 * FP);
        }
        c.timer = rndRange(s, 50, 140);
      }
      const dx = c.tx - c.x, dy = c.ty - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < (12 * FP) ** 2) { c.vx = c.vy = 0; c.timer = 0; }
      else { const n = norm(dx, dy); c.vx = (n.x * 40) >> 8; c.vy = (n.y * 40) >> 8; }
      c.x += c.vx; c.y += c.vy;
      c.x = clamp(c.x, CROWD_R, W - CROWD_R); c.y = clamp(c.y, CROWD_R, H - CROWD_R);
    }
  }

  // ---- collision resolution ---------------------------------------------
  function separate(a, b, ra, rb, wa, wb) { // wa+wb = 256
    const dx = b.x - a.x, dy = b.y - a.y, rr = ra + rb;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return;
    let n;
    if (d2 === 0) n = { x: 256, y: 0 }; else n = norm(dx, dy);
    const pen = rr - isqrt(d2);
    a.x -= (n.x * pen * wa) >> 16; a.y -= (n.y * pen * wa) >> 16;
    b.x += (n.x * pen * wb) >> 16; b.y += (n.y * pen * wb) >> 16;
  }
  function pushOut(e, r) {
    for (const o of OBSTACLES) {
      const dx = e.x - o.x, dy = e.y - o.y, rr = OBS_R + r;
      if (dx * dx + dy * dy < rr * rr) {
        const n = d2zero(dx, dy);
        e.x = o.x + ((n.x * rr) >> 8); e.y = o.y + ((n.y * rr) >> 8);
      }
    }
  }
  function d2zero(dx, dy) { return (dx === 0 && dy === 0) ? { x: 256, y: 0 } : norm(dx, dy); }
  function resolveCollisions(s) {
    const [p0, p1] = s.players;
    separate(p0, p1, PLAYER_R, PLAYER_R, 128, 128);
    for (const p of s.players) {
      for (const c of s.crowd) { if (c.down === 0) separate(p, c, PLAYER_R, CROWD_R, 40, 216); }
    }
    for (let i = 0; i < s.crowd.length; i++) {
      const a = s.crowd[i]; if (a.down > 0) continue;
      for (let j = i + 1; j < s.crowd.length; j++) { const b = s.crowd[j]; if (b.down > 0) continue; separate(a, b, CROWD_R, CROWD_R, 128, 128); }
    }
    for (const p of s.players) { pushOut(p, PLAYER_R); p.x = clamp(p.x, PLAYER_R, W - PLAYER_R); p.y = clamp(p.y, PLAYER_R, H - PLAYER_R); }
    for (const c of s.crowd) { pushOut(c, CROWD_R); c.x = clamp(c.x, CROWD_R, W - CROWD_R); c.y = clamp(c.y, CROWD_R, H - CROWD_R); }
  }

  // ---- main step ---------------------------------------------------------
  function step(s, inputs) {
    const ev = [];
    if (s.phase === 2) { s.tick++; return ev; }
    const in0 = inputs[0] || EMPTY_INPUT;
    const in1 = s.cfg.bot ? botInput(s, 1) : (inputs[1] || EMPTY_INPUT);
    const ins = [in0, in1];
    s.tick++;
    if (s.phase === 1) {
      const newL = 1 - s.lebron;
      for (let i = 0; i < 2; i++) {
        const a = ins[i][1] | 0, p = s.players[i];
        const pick = (a & A_PERK1) ? 0 : (a & A_PERK2) ? 1 : (a & A_PERK3) ? 2 : -1;
        if (pick >= 0) { if (i === newL) p.perkL = pick; else p.perkP = pick; }
        p.prevA = a;
      }
      s.freezeLeft--;
      if (s.freezeLeft <= 0) { applySwap(s, ev); s.phase = 0; }
    } else {
      updatePlayer(s, 0, ins[0], ev);
      if (s.phase === 0) updatePlayer(s, 1, ins[1], ev);
      if (s.phase === 0) updateBall(s, ev);
      updateCrowd(s);
      resolveCollisions(s);
      s.players[s.lebron].lebronTicks++;
    }
    s.timeLeft--;
    if (s.timeLeft <= 0) {
      s.timeLeft = 0;
      if (s.phase === 1) applySwap(s, ev);
      s.phase = 2; s.winner = s.lebron;
      ev.push({ t: 'end', winner: s.winner });
    }
    return ev;
  }

  // ---- hashing -----------------------------------------------------------
  function hashState(s) {
    let h = 0x811c9dc5 | 0;
    const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619); };
    mix(s.tick); mix(s.rng); mix(s.timeLeft); mix(s.phase); mix(s.lebron); mix(s.freezeLeft); mix(s.swaps);
    for (const p of s.players) {
      mix(p.x); mix(p.y); mix(p.vx); mix(p.vy); mix(p.fx); mix(p.fy); mix(p.dashCd); mix(p.dashLeft);
      mix(p.stun); mix(p.pr); mix(p.photos); mix(p.charge); mix(p.snapCd); mix(p.perkL); mix(p.perkP); mix(p.prevA); mix(p.bd);
    }
    const b = s.ball; mix(b.st); mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); mix(b.holder); mix(b.grace); mix(b.bounces); mix(b.ground);
    for (const c of s.crowd) { mix(c.x); mix(c.y); mix(c.vx); mix(c.vy); mix(c.tx); mix(c.ty); mix(c.timer); mix(c.down); }
    return h >>> 0;
  }

  return { FP, TPS, WPX, HPX, W, H, PLAYER_R, CROWD_R, BALL_R, OBS_R, OBSTACLES, PERKS, DEFAULT_CFG, EMPTY_INPUT,
    A_PRIMARY, A_DASH, A_PERK1, A_PERK2, A_PERK3, PR_MAX, FREEZE_TICKS,
    createState, step, hashState, lebronParams, papParams, inFrame, losClear, norm, isqrt, moveBits, botInput };
})();
if (typeof module !== 'undefined') module.exports = SIM;
