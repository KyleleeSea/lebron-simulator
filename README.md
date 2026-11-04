# LeBron vs Paparazzi

A two-player, first-person, peer-to-peer browser game. One player is **LeBron**, the other is the **paparazzi**.
Whoever is LeBron when the clock hits zero wins.

**Play:** https://kyleleesea.github.io/lebron-simulator/

## Rules

- **Paparazzi** hold the snap button with LeBron inside their frame (range, viewing angle, and a clear
  line of sight past fans and planters) for half a second to take a photo. Three photos (configurable)
  steal the fame: the paparazzi becomes LeBron and LeBron becomes the paparazzi.
- **LeBron** throws a basketball. Hitting the paparazzi wipes every photo they have taken so far and
  stuns them. The ball bounces off walls and planters and can be caught on the rebound; a loose ball
  returns after a few seconds.
- **Fans** wander the arena and drift toward LeBron. They block the paparazzi's line of sight, but
  if LeBron's ball hits one he loses PR. At 0 PR the roles swap.
- Both players can **dash** (shift). Matches last 1 to 5 minutes, chosen by the host.

## Rebalancing choices

- **Lobby settings** (host): match length, crowd size, photos needed, crowd hits LeBron can afford,
  who starts as LeBron.
- **Perks** (each player, re-pickable with 1/2/3 during every role swap):
  - LeBron: Cannon Arm (faster ball), Thick Skin (cheaper crowd hits), Quick Hands (fast ball return, wide pickup)
  - Paparazzi: Zoom Lens (long, narrow frame), Autofocus (faster snaps), Wide Angle (wide, short frame, faster)

## Controls

Mouse looks (click the game to capture the pointer) · WASD move relative to where you look (Q/E or arrows also turn) ·
click or space throws / holds to snap · shift dashes · 1 2 3 pick a perk during a swap · minimap bottom-left shows everyone.

## Netcode

- WebRTC data channel via [PeerJS](https://peerjs.com) (its public signaling server is only used to
  exchange the handshake; gameplay traffic is direct).
- **Deterministic lockstep**: the simulation (`sim.js`) uses integer math only (positions in 1/16 px,
  mulberry32 RNG, integer square roots). Each peer sends its input for tick `N + delay` at tick `N`,
  and tick `N` only runs once both inputs are known. The delay is picked from the measured ping.
- Every 20 ticks each peer hashes its full state and sends it; a mismatch triggers an automatic
  snapshot resync from the host. Redundant input history is sent with every packet.
- Solo mode runs the same lockstep loop against a deterministic bot.
- The first-person view is drawn on a 2D canvas (projected walls and floor, depth-sorted billboard sprites); the
  deterministic simulation stays top-down 2D so rendering can never affect the game state.

## Run locally

Any static server works, for example:

```bash
python3 -m http.server 8765
```

then open http://localhost:8765/. Open it in two tabs to test a match with yourself.
