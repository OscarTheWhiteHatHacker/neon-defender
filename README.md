# Neon Defender

A tiny neon arena shooter that runs in a single browser tab. No build step, no dependencies, no image or audio assets — just three files.

**Play it:** https://oscarthewhitehathacker.github.io/neon-defender/

![Neon Defender](screenshot.png)

## How to play

| Action | Control |
| --- | --- |
| Move | `WASD` / arrow keys |
| Fire | Mouse (hold) or `Space` |
| Pause | `P` or `Esc` |
| Mute | `M` |

On touch screens: drag anywhere to move, the turret auto-fires at the nearest enemy.

## What's in it

- Three enemy types — chasers, strafing shooters, and tanks that split into grunts when destroyed
- Endless waves that scale in count, health and speed
- Combo multiplier for chained kills
- Pickups: rapid fire, triple shot, shield, extra life
- High score saved to `localStorage`
- Particles, screen shake, procedural WebAudio blips — zero asset files
- Responsive canvas with device-pixel-ratio scaling, works on phone and desktop

## Run locally

```bash
git clone https://github.com/OscarTheWhiteHatHacker/neon-defender.git
cd neon-defender
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` directly with `file://` also works.

## Structure

```
index.html   markup + HUD
style.css    neon UI, overlay panels, responsive layout
game.js      the whole game — loop, entities, waves, rendering, audio
```

## License

MIT
