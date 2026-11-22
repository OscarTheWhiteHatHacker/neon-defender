'use strict';
/* Neon Defender — a tiny neon arena shooter. No dependencies, no assets. */
(() => {
  // ------------------------------------------------------------------ setup
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const dom = {
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    combo: document.getElementById('combo'),
    wave: document.getElementById('wave'),
    diff: document.getElementById('diff'),
    lives: document.getElementById('lives'),
    power: document.getElementById('powerups'),
    overlay: document.getElementById('overlay'),
  };

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist2 = (a, b) => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  };
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const BEST_KEY = 'neon-defender-best';
  const DIFF_KEY = 'neon-defender-difficulty';

  let W = 960, H = 600, DPR = 1;
  let bgGrad = null;
  const stars = [];

  // Enemy bodies are sized against the arena, not the display. Radii in ENEMY
  // are authored for this reference canvas; enemySizeScale() stretches them so a
  // grunt covers the same share of the screen on a phone and on a 4K monitor.
  const REF_W = 960, REF_H = 600;
  const SIZE_SCALE_MIN = 0.75, SIZE_SCALE_MAX = 1.5;
  let sizeScale = 1;

  function enemySizeScale() {
    return clamp(Math.sqrt((W * H) / (REF_W * REF_H)), SIZE_SCALE_MIN, SIZE_SCALE_MAX);
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    // world units == CSS pixels, so pointer input maps 1:1 even after a resize
    W = Math.max(1, Math.round(rect.width || window.innerWidth));
    H = Math.max(1, Math.round(rect.height || window.innerHeight));
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    sizeScale = enemySizeScale();
    applyEnemySizes();

    bgGrad = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    bgGrad.addColorStop(0, 'rgba(56,245,255,0.075)');
    bgGrad.addColorStop(0.55, 'rgba(56,245,255,0.018)');
    bgGrad.addColorStop(1, 'rgba(4,5,12,0)');

    stars.length = 0;
    const n = Math.round((W * H) / 14000);
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: rand(0.6, 2.1),
        a: rand(0.25, 0.85),
        p: Math.random() * TAU,
      });
    }
  }

  // ------------------------------------------------------------------ audio
  let actx = null;
  let muted = false;
  function initAudio() {
    if (!actx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) actx = new AC();
      } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  function blip(freq, dur, type, vol, slide) {
    if (!actx || muted) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.04, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // ------------------------------------------------------------------ state
  // Difficulty only changes how fast enemies close in; wave count, health and
  // spawn pacing stay the same so the three modes are directly comparable.
  const DIFFICULTY = {
    easy:   { label: 'EASY',   speed: 1.15, note: 'ENEMY SPEED x1.15 - SLIGHTLY FASTER THAN THE ORIGINAL' },
    medium: { label: 'MEDIUM', speed: 1.55, note: 'ENEMY SPEED x1.55 - QUITE FAST' },
    hard:   { label: 'HARD',   speed: 2.05, note: 'ENEMY SPEED x2.05 - VERY FAST' },
  };
  const DIFF_ORDER = ['easy', 'medium', 'hard'];

  // Every cleared wave makes the swarm 125% as fast as the wave before it, so a
  // grunt that closes at 88 u/s in wave 1 is at 110 u/s in wave 2 and 172 u/s by
  // wave 4. The ramp compounds with the difficulty multiplier.
  const WAVE_SPEED_STEP = 1.25;
  function waveSpeedScale() {
    return Math.pow(WAVE_SPEED_STEP, Math.max(0, G.wave - 1));
  }

  const G = {
    mode: 'menu',          // menu | play | pause | dead
    difficulty: 'easy',
    score: 0,
    best: 0,
    wave: 0,
    streak: 0,
    streakT: 0,
    shake: 0,
    time: 0,
    waveTimer: 0,
    spawnTimer: 0,
    banner: 0,
    bannerText: '',
    dryKills: 0,
  };

  const P = {
    x: 0, y: 0, vx: 0, vy: 0, r: 13,
    aim: -Math.PI / 2, fireCd: 0,
    lives: 3, invuln: 0, shield: 0, rapid: 0, triple: 0, flash: 0,
  };

  // r is measured in world units on the 960x600 reference canvas; every spawn
  // multiplies it by the live canvas scale (see enemySizeScale).
  const ENEMY = {
    grunt:   { hp: 2, r: 13, speed: 88,  score: 10, color: '#ff3d81' },
    shooter: { hp: 3, r: 14, speed: 74,  score: 25, color: '#ffb020' },
    tank:    { hp: 9, r: 24, speed: 54,  score: 40, color: '#a06bff' },
  };

  // Issue #14: the ship is deliberately sluggish. Its top speed is pegged just
  // above the chaser it has to escape, so the swarm is always on your tail and
  // the only way to open a gap is to keep moving. Fire rate is slow too: every
  // shot has to count.
  const PLAYER_SPEED_EDGE = 1.2;   // just 20% faster than a same-wave grunt
  const PLAYER_FIRE_CD = 0.5;      // seconds between shots (~2 shots/s)
  const PLAYER_RAPID_CD = 0.22;    // the rapid-fire pickup is still a real upgrade

  const waveQueue = [];
  const enemies = [];

  // Live enemies keep the radius they were authored with (rBase) so a resize or
  // orientation change re-fits them to the new arena without drifting.
  function applyEnemySizes() {
    for (const e of enemies) e.r = e.rBase * sizeScale;
  }
  const bullets = [];
  const ebullets = [];
  const particles = [];
  const pickups = [];
  const floaters = [];

  const keys = { left: false, right: false, up: false, down: false, fire: false };
  const mouse = { x: 0, y: 0, down: false, active: false };
  // One-finger control (issue #21): hold anywhere and the ship flies toward
  // that point, firing along its heading. No auto-aim, no separate fire button.
  // The touch is stored in world units so it survives a resize or rotation.
  const touch = { active: false, id: null, x: 0, y: 0 };
  const TOUCH_DEADZONE = 10;  // world px around the ship that mean "hold still"
  const TOUCH_RAMP = 70;      // extra distance travelled to reach full speed

  try { G.best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { G.best = 0; }
  try {
    const savedDiff = localStorage.getItem(DIFF_KEY);
    if (savedDiff && DIFFICULTY[savedDiff]) G.difficulty = savedDiff;
  } catch (e) { /* noop */ }

  // ------------------------------------------------------------------ input
  // Pointer events arrive in CSS pixels; the world is drawn in world units.
  // Map through the live canvas rect so aim stays under the cursor whenever the
  // CSS box and the backing store disagree (resize, zoom, DPR change).
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? W / rect.width : 1;
    const sy = rect.height > 0 ? H / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  let resizeQueued = false;
  function queueResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
    });
  }
  window.addEventListener('resize', queueResize);
  window.addEventListener('orientationchange', queueResize);
  // Mobile browsers report the new viewport a beat after the rotation starts,
  // and iOS moves the visual viewport when the URL bar collapses: re-fit both.
  window.addEventListener('orientationchange', () => {
    setTimeout(queueResize, 120);
    setTimeout(queueResize, 320);
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueResize);

  const KEYMAP = {
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
  };

  window.addEventListener('keydown', (e) => {
    initAudio();
    const dir = KEYMAP[e.code];
    if (dir) { keys[dir] = true; e.preventDefault(); }

    if (e.code === 'Space') {
      keys.fire = true;
      e.preventDefault();
      if (G.mode === 'menu' || G.mode === 'dead') startGame();
    }
    const diffIdx = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (diffIdx >= 0 && G.mode === 'menu') {
      setDifficulty(DIFF_ORDER[diffIdx]);
      e.preventDefault();
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      e.preventDefault();
      if (G.mode === 'play') pauseGame();
      else if (G.mode === 'pause') resumeGame();
    }
    if (e.code === 'KeyM') {
      muted = !muted;
      floater(W / 2, H - 70, muted ? 'MUTED' : 'SOUND ON', '#8fe9ff', 18);
    }
  }, { passive: false });

  window.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) keys[dir] = false;
    if (e.code === 'Space') keys.fire = false;
  });

  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (e.pointerType === 'touch') {
      const p = pointerPos(e);
      touch.active = true;
      touch.id = e.pointerId;
      touch.x = p.x;
      touch.y = p.y;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    } else {
      const p = pointerPos(e);
      mouse.x = p.x;
      mouse.y = p.y;
      mouse.down = true;
      mouse.active = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touch.active && e.pointerId === touch.id) {
      // Dragging slides the steer point; the ship keeps chasing it.
      const tp = pointerPos(e);
      touch.x = tp.x;
      touch.y = tp.y;
    } else {
      const p = pointerPos(e);
      mouse.x = p.x;
      mouse.y = p.y;
      mouse.active = true;
    }
  });

  function endPointer(e) {
    if (e.pointerType === 'touch') {
      if (e.pointerId === touch.id) {
        touch.active = false;
        touch.id = null;
      }
    } else {
      mouse.down = false;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  window.addEventListener('pointerup', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', () => { if (G.mode === 'play') pauseGame(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.mode === 'play') pauseGame();
  });

  // ------------------------------------------------------------------ fx
  function burst(x, y, color, n, spd, life) {
    if (particles.length > 800) return;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const v = rand(spd * 0.22, spd || 200);
      particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        r: rand(1.3, 3.4),
        life: rand((life || 0.6) * 0.55, life || 0.6),
        max: life || 0.6,
        color,
      });
    }
  }

  function floater(x, y, text, color, size) {
    floaters.push({ x, y, text, color: color || '#dff6ff', size: size || 14, life: 1.1, max: 1.1 });
  }

  // ------------------------------------------------------------------ game flow
  function resetGame() {
    enemies.length = 0;
    bullets.length = 0;
    ebullets.length = 0;
    particles.length = 0;
    pickups.length = 0;
    floaters.length = 0;
    waveQueue.length = 0;

    P.x = W / 2;
    P.y = H * 0.62;
    P.vx = 0;
    P.vy = 0;
    P.aim = -Math.PI / 2;
    P.fireCd = 0;
    P.lives = 3;
    P.invuln = 2.2;
    P.shield = 0;
    P.rapid = 0;
    P.triple = 0;
    P.flash = 0;

    G.score = 0;
    G.wave = 0;
    G.streak = 0;
    G.streakT = 0;
    G.shake = 0;
    G.waveTimer = 1.0;
    G.spawnTimer = 0;
    G.banner = 0;
    G.bannerText = '';
    G.dryKills = 0;

    mouse.x = W / 2;
    mouse.y = H * 0.25;
    touch.active = false;
    touch.id = null;
    touch.x = P.x;
    touch.y = P.y;
  }

  function startGame() {
    initAudio();
    resetGame();
    G.mode = 'play';
    hideOverlay();
    blip(520, 0.12, 'triangle', 0.05, 320);
  }

  function setDifficulty(key) {
    if (!DIFFICULTY[key]) return;
    G.difficulty = key;
    try { localStorage.setItem(DIFF_KEY, key); } catch (e) { /* noop */ }
    syncDiffUI();
    blip(480 + DIFF_ORDER.indexOf(key) * 110, 0.07, 'square', 0.03, 60);
  }

  // Called after the menu is rendered so the pills always mirror G.difficulty.
  function syncDiffUI() {
    const d = DIFFICULTY[G.difficulty];
    const btns = dom.overlay.querySelectorAll('[data-diff]');
    for (const b of btns) {
      const on = b.dataset.diff === G.difficulty;
      if (on) b.classList.add('sel'); else b.classList.remove('sel');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const note = dom.overlay.querySelector('.diff-note');
    if (note) note.textContent = d.note;
  }

  function pauseGame() {
    if (G.mode !== 'play') return;
    G.mode = 'pause';
    mouse.down = false;
    keys.fire = false;
    touch.active = false;
    showPaused();
  }

  function resumeGame() {
    if (G.mode !== 'pause') return;
    G.mode = 'play';
    hideOverlay();
    blip(420, 0.08, 'triangle', 0.04, 180);
  }

  function gameOver() {
    G.mode = 'dead';
    mouse.down = false;
    touch.active = false;
    if (G.score > G.best) {
      G.best = G.score;
      try { localStorage.setItem(BEST_KEY, String(G.best)); } catch (e) { /* noop */ }
    }
    G.shake = 26;
    burst(P.x, P.y, '#38f5ff', 46, 420, 1.0);
    burst(P.x, P.y, '#ffffff', 18, 260, 0.7);
    blip(140, 0.5, 'sawtooth', 0.07, -100);
    showGameOver();
  }

  // ------------------------------------------------------------------ waves
  function startWave() {
    G.wave++;
    const n = G.wave;
    const grunts = n === 1 ? 4 : 4 + Math.floor(n * 1.4);
    const shooters = n >= 2 ? Math.min(1 + Math.floor(n * 0.6), 9) : 0;
    const tanks = n >= 4 ? Math.min(1 + Math.floor((n - 3) * 0.5), 5) : 0;

    for (let i = 0; i < grunts; i++) waveQueue.push('grunt');
    for (let i = 0; i < shooters; i++) waveQueue.push('shooter');
    for (let i = 0; i < tanks; i++) waveQueue.push('tank');
    for (let i = waveQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = waveQueue[i]; waveQueue[i] = waveQueue[j]; waveQueue[j] = t;
    }

    G.spawnTimer = 0.45;
    G.banner = 2.4;
    G.bannerText = 'WAVE ' + n;
    blip(300 + n * 18, 0.18, 'triangle', 0.05, 220);
    if (n % 5 === 0) {
      floater(W / 2, H / 2 + 60, 'INTENSITY UP', '#ff3d81', 14);
      blip(660, 0.22, 'square', 0.05, 220);
    }
  }

  function spawnEnemy(type, sx, sy) {
    const base = ENEMY[type];
    // The wave ramp grows the hull and the throttle: bodies get bigger and every
    // wave compounds the closing speed by 125% of the previous wave. The radius
    // is fitted to the live canvas rather than the enemy being made faster.
    const waveScale = 1 + Math.min(0.45, (G.wave - 1) * 0.045);
    const rBase = base.r * waveScale;
    const r = rBase * sizeScale;
    let x = sx, y = sy;

    if (x === undefined) {
      const m = 70 + r;
      const side = Math.floor(Math.random() * 4);
      if (side === 0) { x = rand(-m, W + m); y = -m; }
      else if (side === 1) { x = W + m; y = rand(-m, H + m); }
      else if (side === 2) { x = rand(-m, W + m); y = H + m; }
      else { x = -m; y = rand(-m, H + m); }
    }

    const hp = Math.max(1, Math.round(base.hp * waveScale));
    const e = {
      type, x, y, vx: 0, vy: 0,
      r, rBase,
      hp, maxhp: hp,
      // Issue #6: closing speed is expressed per-arena, so a 4K canvas plays at
      // the same tempo as the 960x600 reference instead of feeling sluggish.
      speed: base.speed * sizeScale * DIFFICULTY[G.difficulty].speed * waveSpeedScale(),
      score: base.score,
      color: base.color,
      fireCd: rand(0.6, 1.6),
      hurt: 0,
      age: 0,
      seed: rand(0, TAU),
      face: rand(0, TAU),
    };
    enemies.push(e);
    burst(x, y, base.color, 5, 110, 0.4);
    return e;
  }

  // ------------------------------------------------------------------ helpers
  function nearestEnemy(x, y) {
    let best = null, bd = Infinity;
    for (const e of enemies) {
      const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function comboMult() {
    return 1 + Math.min(4, G.streak * 0.15);
  }

  function shoot() {
    const spread = P.triple > 0 ? [-0.13, 0, 0.13] : [0];
    const muzzle = 18;
    const speed = 780 * sizeScale;
    for (const s of spread) {
      const a = P.aim + s;
      bullets.push({
        x: P.x + Math.cos(a) * muzzle,
        y: P.y + Math.sin(a) * muzzle,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: 4,
        dmg: 1,
      });
    }
    burst(P.x + Math.cos(P.aim) * 20, P.y + Math.sin(P.aim) * 20, '#9ffcff', 2, 90, 0.18);
    blip(700, 0.045, 'square', 0.022, -180);
  }

  function enemyShoot(e, nx, ny) {
    const sp = 265 * sizeScale;
    ebullets.push({
      x: e.x + nx * (e.r + 4),
      y: e.y + ny * (e.r + 4),
      vx: nx * sp,
      vy: ny * sp,
      r: 6,
      life: 5.5,
    });
    blip(190, 0.07, 'sawtooth', 0.022, -50);
  }

  function hurtPlayer() {
    if (P.invuln > 0 || G.mode !== 'play') return;

    if (P.shield > 0) {
      P.shield = 0;
      P.invuln = 0.9;
      P.flash = 0.12;
      G.shake = Math.max(G.shake, 8);
      burst(P.x, P.y, '#38f5ff', 22, 280, 0.55);
      floater(P.x, P.y - 30, 'SHIELD DOWN', '#38f5ff', 13);
      blip(300, 0.18, 'sine', 0.06, -120);
      return;
    }

    P.lives--;
    P.invuln = 1.9;
    P.flash = 0.12;
    G.shake = 16;
    G.streak = 0;
    burst(P.x, P.y, '#ff3d81', 26, 320, 0.7);
    blip(150, 0.25, 'square', 0.07, -90);
    if (P.lives <= 0) gameOver();
  }

  function dropPickup(x, y) {
    const roll = Math.random();
    let type = 'rapid';
    if (roll > 0.72) type = 'shield';
    else if (roll > 0.45) type = 'triple';
    else if (roll > 0.40) type = 'life';
    pickups.push({ x, y, vx: 0, vy: 0, r: 12, type, age: 0, life: 15 });
  }

  function applyPickup(p) {
    if (p.type === 'rapid') { P.rapid = 9; floater(P.x, P.y - 34, 'RAPID FIRE', '#ffb020', 14); }
    if (p.type === 'triple') { P.triple = 11; floater(P.x, P.y - 34, 'TRIPLE SHOT', '#a06bff', 14); }
    if (p.type === 'shield') { P.shield = 1; floater(P.x, P.y - 34, 'SHIELD', '#38f5ff', 14); }
    if (p.type === 'life') {
      P.lives = Math.min(5, P.lives + 1);
      floater(P.x, P.y - 34, '+1 LIFE', '#ff3d81', 14);
    }
    burst(p.x, p.y, '#ffffff', 12, 200, 0.5);
    blip(880, 0.14, 'triangle', 0.05, 240);
  }

  function killEnemy(e) {
    const idx = enemies.indexOf(e);
    if (idx >= 0) enemies.splice(idx, 1);

    G.streak++;
    G.streakT = 2.3;
    const gain = Math.round(e.score * comboMult());
    G.score += gain;

    floater(e.x, e.y - e.r - 4, '+' + gain, e.color, e.type === 'tank' ? 18 : 14);
    burst(e.x, e.y, e.color, e.type === 'tank' ? 30 : 15, e.type === 'tank' ? 340 : 240, 0.65);
    G.shake = Math.max(G.shake, e.type === 'tank' ? 10 : 4);
    blip(e.type === 'tank' ? 120 : 240, 0.1, 'sawtooth', 0.035, -120);

    if (e.type === 'tank') {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + rand(-0.3, 0.3);
        spawnEnemy('grunt', e.x + Math.cos(a) * 26, e.y + Math.sin(a) * 26);
      }
    }
    // Issue #9: far more generous drops - 45% per kill, plus a guaranteed drop
    // after six dry kills so a run never starves.
    G.dryKills += 1;
    if (Math.random() < 0.45 || G.dryKills >= 6) {
      dropPickup(e.x, e.y);
      G.dryKills = 0;
    }
  }

  // A grunt in this wave, at this difficulty, is the yardstick for how fast the
  // ship may go: it stays a fixed 20% ahead of the chasers at every wave, so the
  // wave ramp closes in on the player instead of being outrun.
  function playerTopSpeed() {
    return ENEMY.grunt.speed * sizeScale * DIFFICULTY[G.difficulty].speed *
      waveSpeedScale() * PLAYER_SPEED_EDGE;
  }

  // ------------------------------------------------------------------ update
  function updatePlayer(dt) {
    if (P.invuln > 0) P.invuln -= dt;
    if (P.flash > 0) P.flash = Math.max(0, P.flash - dt);
    if (P.rapid > 0) P.rapid = Math.max(0, P.rapid - dt);
    if (P.triple > 0) P.triple = Math.max(0, P.triple - dt);

    let ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);

    // Issue #21: one finger does everything. The ship heads straight for the
    // point being held and shoots along that heading - no auto-target, no
    // second button. Speed ramps in with distance so a small nudge is gentle.
    let steer = 0;
    let touchAim = null;
    if (touch.active) {
      const tdx = touch.x - P.x;
      const tdy = touch.y - P.y;
      const td = Math.hypot(tdx, tdy);
      if (td > TOUCH_DEADZONE) {
        steer = clamp((td - TOUCH_DEADZONE) / TOUCH_RAMP, 0, 1);
        ix = (tdx / td) * steer;
        iy = (tdy / td) * steer;
        touchAim = Math.atan2(tdy, tdx);
      } else {
        ix = 0;
        iy = 0;
      }
    }

    const m = Math.hypot(ix, iy);
    if (m > 1) { ix /= m; iy /= m; }

    const MAX = playerTopSpeed();   // barely faster than a chaser, on purpose
    const k = 1 - Math.exp(-dt * 14);
    P.vx += (ix * MAX - P.vx) * k;
    P.vy += (iy * MAX - P.vy) * k;
    P.x += P.vx * dt;
    P.y += P.vy * dt;

    const pad = P.r + 4;
    if (P.x < pad) { P.x = pad; P.vx = Math.max(0, P.vx); }
    if (P.x > W - pad) { P.x = W - pad; P.vx = Math.min(0, P.vx); }
    if (P.y < pad) { P.y = pad; P.vy = Math.max(0, P.vy); }
    if (P.y > H - pad) { P.y = H - pad; P.vy = Math.min(0, P.vy); }

    const near = nearestEnemy(P.x, P.y);
    if (touch.active) {
      // Heading follows the finger, never the nearest enemy. Inside the
      // deadzone the last heading is kept so a held finger keeps shooting straight.
      if (touchAim !== null) P.aim = touchAim;
    } else if (mouse.active) {
      P.aim = Math.atan2(mouse.y - P.y, mouse.x - P.x);
    } else if (!isTouch && near) {
      // Keyboard-only desktop fallback. Touch devices never auto-target: that
      // was the "strange auto target" feel this issue is about.
      P.aim = Math.atan2(near.y - P.y, near.x - P.x);
    }

    P.fireCd -= dt;
    const firing = touch.active || mouse.down || keys.fire;
    if (firing && P.fireCd <= 0) {
      shoot();
      P.fireCd = P.rapid > 0 ? PLAYER_RAPID_CD : PLAYER_FIRE_CD;
    }
  }

  function updateEnemies(dt) {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.age += dt;
      if (e.hurt > 0) e.hurt -= dt;

      const dx = P.x - e.x;
      const dy = P.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d;
      const ny = dy / d;

      // Hulls steer toward the player instead of snapping: keeps the pixel art
      // readable as it turns.
      const faceTarget = Math.atan2(ny, nx);
      let turn = faceTarget - e.face;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      e.face += turn * Math.min(1, dt * 9);

      if (e.type === 'grunt') {
        e.vx = nx * e.speed;
        e.vy = ny * e.speed;
      } else if (e.type === 'shooter') {
        const want = 250 * sizeScale;
        const radial = d > want + 40 ? 1 : d < want - 40 ? -1 : 0;
        const tang = Math.sin(e.age * 0.85 + e.seed) * 0.8;
        e.vx = nx * e.speed * radial - ny * e.speed * tang;
        e.vy = ny * e.speed * radial + nx * e.speed * tang;
        e.fireCd -= dt;
        if (e.fireCd <= 0 && d < 640 * sizeScale) {
          enemyShoot(e, nx, ny);
          e.fireCd = rand(1.4, 2.2) * Math.max(0.55, 1 - G.wave * 0.02);
        }
      } else {
        e.vx = nx * e.speed;
        e.vy = ny * e.speed;
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;

      if (dist2(e, P) < (e.r + P.r) * (e.r + P.r)) hurtPlayer();
    }

    // light separation so the swarm doesn't stack into one blob
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      for (let j = i + 1; j < enemies.length; j++) {
        const b = enemies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < min * min) {
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.45;
          const px = (dx / d) * push;
          const py = (dy / d) * push;
          a.x -= px; a.y -= py;
          b.x += px; b.y += py;
        }
      }
    }
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // Issue #6: shots live until they leave the arena - no mid-screen expiry.
      if (b.x < -40 || b.x > W + 40 || b.y < -40 || b.y > H + 40) {
        bullets.splice(i, 1);
        continue;
      }
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        const rr = b.r + e.r;
        if (dist2(b, e) < rr * rr) {
          e.hp -= b.dmg;
          e.hurt = 0.09;
          burst(b.x, b.y, '#9ffcff', 3, 130, 0.25);
          bullets.splice(i, 1);
          if (e.hp <= 0) killEnemy(e);
          break;
        }
      }
    }

    for (let i = ebullets.length - 1; i >= 0; i--) {
      const b = ebullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -60 || b.x > W + 60 || b.y < -60 || b.y > H + 60) {
        ebullets.splice(i, 1);
        continue;
      }
      const rr = b.r + P.r;
      if (dist2(b, P) < rr * rr) {
        ebullets.splice(i, 1);
        hurtPlayer();
      }
    }
  }

  function updatePickups(dt) {
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      p.age += dt;
      p.life -= dt;
      const dx = P.x - p.x;
      const dy = P.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 170) {
        const pull = (1 - d / 170) * 620;
        p.vx += (dx / d) * pull * dt;
        p.vy += (dy / d) * pull * dt;
      }
      p.vx *= 1 - Math.min(1, dt * 2.2);
      p.vy *= 1 - Math.min(1, dt * 2.2);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (d < p.r + P.r) {
        applyPickup(p);
        pickups.splice(i, 1);
        continue;
      }
      if (p.life <= 0) pickups.splice(i, 1);
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = 1 - Math.min(1, dt * 2.6);
      p.vx *= drag;
      p.vy *= drag;
    }
  }

  function updateFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      f.y -= 34 * dt;
      if (f.life <= 0) floaters.splice(i, 1);
    }
  }

  function update(dt) {
    if (G.banner > 0) G.banner -= dt;
    if (G.streakT > 0) {
      G.streakT -= dt;
      if (G.streakT <= 0) G.streak = 0;
    }

    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updatePickups(dt);
    updateParticles(dt);
    updateFloaters(dt);

    if (waveQueue.length === 0 && enemies.length === 0) {
      G.waveTimer -= dt;
      if (G.waveTimer <= 0) {
        startWave();
        G.waveTimer = 2.4;
      }
    } else {
      G.spawnTimer -= dt;
      if (G.spawnTimer <= 0 && waveQueue.length > 0) {
        spawnEnemy(waveQueue.shift());
        G.spawnTimer = Math.max(0.14, 0.44 - G.wave * 0.013);
      }
    }
  }

  // ------------------------------------------------------------------ render
  function drawBackground() {
    ctx.fillStyle = '#04050c';
    ctx.fillRect(-60, -60, W + 120, H + 120);

    for (const s of stars) {
      ctx.globalAlpha = (0.3 + 0.35 * Math.sin(G.time * 1.5 + s.p)) * s.a;
      ctx.fillStyle = '#8fe9ff';
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    const g = 64;
    ctx.strokeStyle = 'rgba(56,245,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += g) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += g) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    if (bgGrad) {
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function polygon(n, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // ---- pixel-art enemy hulls -------------------------------------------
  // Issue #3: every enemy type is a hand-authored pixel sprite instead of a
  // plain polygon. Each grid is rasterised once into offscreen canvases (a body
  // copy plus a white hit-flash copy) and blitted with nearest-neighbour
  // scaling so the pixels stay crisp at any arena size.
  const SPRITE_ART = {
    grunt: {
      palette: { a: '#e01b63', b: '#ff5c95', c: '#ffffff', d: '#ffa8c6' },
      rows: [
        '....a....',
        '...aba...',
        '...aba...',
        '..aabaa..',
        '..aabaa..',
        '.aaabaaa.',
        'aabbbbbaa',
        'aa.bbb.aa',
        '...d.d...',
      ],
    },
    shooter: {
      palette: { a: '#e06a00', b: '#ffb020', c: '#fff3d6', d: '#ff5a00' },
      rows: [
        '.....a.....',
        '....aaa....',
        '...aabaa...',
        '..aabbbaa..',
        '.aabbbbbaa.',
        'aabbbcbbbaa',
        'aabbbbbbbaa',
        'aaabbbbbaaa',
        '..aaabaaa..',
        '...aa.aa...',
        '...d...d...',
      ],
    },
    tank: {
      palette: { a: '#6a2fd6', b: '#a06bff', c: '#ffffff', d: '#4a17a8' },
      rows: [
        '......a......',
        '.....aaa.....',
        '....aabaa....',
        '...aabbbaa...',
        '..aabbbbbaa..',
        '.aabbbbbbbaa.',
        'aabbbbcbbbbaa',
        'aabbbbbbbbbaa',
        'aaabbbbbbbaaa',
        '.aabbbbbbbaa.',
        '..aabbcbbaa..',
        '...aa...aa...',
        '..dd.....dd..',
      ],
    },
  };

  const OUTLINE = '#070911';
  function rasteriseSprite(rows, palette) {
    const h = rows.length;
    const w = rows[0].length;
    const solid = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== '.';
    const paint = (colours) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      // 1px dark outline around every lit cell - the thing that makes a grid of
      // squares read as a sprite instead of a glowing blob.
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (solid(x, y)) continue;
          if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) {
            g.fillStyle = OUTLINE;
            g.fillRect(x, y, 1, 1);
          }
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ch = rows[y][x];
          if (ch === '.' || !colours[ch]) continue;
          g.fillStyle = colours[ch];
          g.fillRect(x, y, 1, 1);
        }
      }
      return c;
    };
    const white = {};
    for (const k of Object.keys(palette)) white[k] = '#ffffff';
    return { w, h, body: paint(palette), flash: paint(white) };
  }

  const SPRITES = {};
  for (const type of Object.keys(SPRITE_ART)) {
    const art = SPRITE_ART[type];
    SPRITES[type] = rasteriseSprite(art.rows, art.palette);
  }

  function drawEnemy(e) {
    const spr = SPRITES[e.type];
    if (!spr) return;
    const hit = e.hurt > 0;
    // Hull width tracks the enemy radius, which is already canvas-fitted. The
    // scale snaps to whole pixels and the origin snaps to the pixel grid so the
    // sprite is never half-smeared.
    const s = Math.max(1, Math.round((e.r * 2.6) / spr.w));

    ctx.save();
    // soft bloom behind the hull, so it still pops without blurring the pixels
    ctx.globalAlpha = hit ? 0.32 : 0.16;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r * 1.55, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.translate(Math.round(e.x), Math.round(e.y));
    ctx.rotate(e.face + Math.PI / 2);   // art points up, e.face points at the player
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      hit ? spr.flash : spr.body,
      -(spr.w * s) / 2,
      -(spr.h * s) / 2,
      spr.w * s,
      spr.h * s
    );
    ctx.restore();

    // health pip for damaged heavies
    if (e.hp < e.maxhp && e.type !== 'grunt') {
      const w = e.r * 1.8;
      const frac = clamp(e.hp / e.maxhp, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(e.x - w / 2, e.y + e.r + 8, w, 3);
      ctx.fillStyle = e.color;
      ctx.fillRect(e.x - w / 2, e.y + e.r + 8, w * frac, 3);
    }
  }

  // ---- player hull -----------------------------------------------------
  // Issue #16: the ship used to be a bare triangle. It is now a hand-authored
  // pixel sprite in the same grid -> offscreen-canvas pipeline as the enemy
  // hulls: pointed nose, white canopy strip, swept wing with a lit leading
  // edge, a notched trailing edge and a twin-nozzle engine block. The art
  // points up, so the sprite is rotated a quarter turn onto P.aim.
  const PLAYER_ART = {
    palette: { a: '#0f7f96', b: '#38f5ff', c: '#d6fdff', w: '#ffffff', d: '#07222c' },
    rows: [
      '.......c.......',
      '......cbc......',
      '......cbc......',
      '.....cbwbc.....',
      '.....cbwbc.....',
      '....cbwwwbc....',
      '....cbwwwbc....',
      '...cabbcbbac...',
      '..cabbbcbbbac..',
      '.cabbbbcbbbbac.',
      'cabbbbbbbbbbbac',
      'cabbbbbbbbbbbac',
      '..cabbbbbbbac..',
      '....cddaddc....',
      '....cddaddc....',
      '....cddaddc....',
      '.....caaac.....',
    ],
  };
  const PLAYER_SPRITE = rasteriseSprite(PLAYER_ART.rows, PLAYER_ART.palette);

  function drawPlayer() {
    if (G.mode === 'dead') return;
    const spr = PLAYER_SPRITE;
    // Hull size is derived from the collision radius, so the art and the hitbox
    // can never drift apart. Cells snap to whole pixels like the enemy sprites.
    const s = Math.max(1, Math.round((P.r * 2.5) / spr.w));
    const blink = P.invuln > 0 && Math.floor(G.time * 16) % 2 === 0;
    // the plume grows with how hard the hull is actually thrusting
    const throttle = clamp(Math.hypot(P.vx, P.vy) / playerTopSpeed(), 0, 1);

    ctx.save();
    ctx.translate(Math.round(P.x), Math.round(P.y));
    ctx.rotate(P.aim + Math.PI / 2);
    ctx.globalAlpha = blink ? 0.32 : 1;
    ctx.imageSmoothingEnabled = false;

    // twin engine plumes out of the nozzles, jittered so they read as fire
    const flick = 0.78 + 0.22 * Math.sin(G.time * 34) + rand(-0.1, 0.1);
    const top = (spr.h / 2 - 0.4) * s;
    const len = (5 + 11 * throttle) * flick * s;
    ctx.globalCompositeOperation = 'lighter';
    for (const dx of [-2 * s, 2 * s]) {
      ctx.fillStyle = 'rgba(56,245,255,0.42)';
      ctx.beginPath();
      ctx.moveTo(dx - 1.5 * s, top);
      ctx.lineTo(dx + 1.5 * s, top);
      ctx.lineTo(dx, top + len);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(214,253,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(dx - 0.75 * s, top);
      ctx.lineTo(dx + 0.75 * s, top);
      ctx.lineTo(dx, top + len * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    ctx.shadowColor = '#38f5ff';
    ctx.shadowBlur = 18;
    ctx.drawImage(
      P.flash > 0 ? spr.flash : spr.body,
      -(spr.w * s) / 2,
      -(spr.h * s) / 2,
      spr.w * s,
      spr.h * s
    );
    ctx.restore();

    if (P.shield > 0) {
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(G.time * 6);
      ctx.strokeStyle = '#38f5ff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#38f5ff';
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(P.x, P.y, P.r + 10, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBullets() {
    ctx.save();
    ctx.shadowColor = '#9ffcff';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#d7feff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const b of bullets) {
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.014, b.y - b.vy * 0.014);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.shadowColor = '#ffb020';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffd489';
    for (const b of ebullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPickups() {
    for (const p of pickups) {
      const color = p.type === 'rapid' ? '#ffb020'
        : p.type === 'triple' ? '#a06bff'
        : p.type === 'life' ? '#ff3d81'
        : '#38f5ff';
      const fading = p.life < 3 && Math.floor(p.life * 8) % 2 === 0;
      if (fading) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.age * 1.4);
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(4,5,12,0.7)';
      polygon(4, p.r, 0);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = color;
      ctx.font = '700 11px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.type === 'rapid' ? 'R' : p.type === 'triple' ? 'T' : p.type === 'life' ? '+' : 'S', p.x, p.y + 0.5);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.r * (0.5 + a * 0.8);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font = '700 ' + f.size + 'px ui-monospace,monospace';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawBanner() {
    if (G.banner <= 0) return;
    const t = G.banner;
    const a = t > 1.9 ? (2.4 - t) / 0.5 : Math.min(1, t / 0.6);
    ctx.save();
    ctx.globalAlpha = clamp(a, 0, 1) * 0.9;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dff6ff';
    ctx.shadowColor = '#38f5ff';
    ctx.shadowBlur = 26;
    ctx.font = '800 ' + (W < 520 ? 30 : 44) + 'px ui-monospace,monospace';
    ctx.fillText(G.bannerText, W / 2, H * 0.32);
    ctx.restore();
  }

  function drawCrosshair() {
    if (!mouse.active || G.mode !== 'play') return;
    ctx.save();
    ctx.strokeStyle = 'rgba(56,245,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 9, 0, TAU);
    ctx.moveTo(mouse.x - 15, mouse.y);
    ctx.lineTo(mouse.x - 5, mouse.y);
    ctx.moveTo(mouse.x + 5, mouse.y);
    ctx.lineTo(mouse.x + 15, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 15);
    ctx.lineTo(mouse.x, mouse.y - 5);
    ctx.moveTo(mouse.x, mouse.y + 5);
    ctx.lineTo(mouse.x, mouse.y + 15);
    ctx.stroke();
    ctx.restore();
  }

  // The one-finger control needs to show where it is aimed: a ring under the
  // thumb plus a faint tether to the ship so the heading is never a guess.
  function drawSteerTarget() {
    if (!touch.active || G.mode !== 'play') return;
    ctx.save();
    ctx.strokeStyle = 'rgba(56,245,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(P.x, P.y);
    ctx.lineTo(touch.x, touch.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(touch.x, touch.y, 16, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(touch.x, touch.y, 3, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.save();
    if (G.shake > 0.4 && G.mode !== 'menu') {
      ctx.translate(rand(-G.shake, G.shake) * 0.6, rand(-G.shake, G.shake) * 0.6);
    }
    drawBackground();
    drawPickups();
    drawParticles();
    for (const e of enemies) drawEnemy(e);
    drawBullets();
    drawPlayer();
    drawFloaters();
    drawBanner();
    drawCrosshair();
    drawSteerTarget();
    ctx.restore();
  }

  // ------------------------------------------------------------------ hud
  let lastChips = '';
  function updateHud() {
    dom.score.textContent = G.score.toLocaleString();
    dom.best.textContent = 'BEST ' + Math.max(G.best, G.score).toLocaleString();
    dom.wave.textContent = 'WAVE ' + Math.max(1, G.wave);
    dom.diff.textContent = DIFFICULTY[G.difficulty].label;
    dom.lives.textContent = P.lives > 0 ? '\u2665'.repeat(P.lives) : '';
    dom.combo.textContent = G.streak > 2 ? 'x' + comboMult().toFixed(1) + ' COMBO' : '';

    const chips = [];
    if (P.rapid > 0) chips.push('<span class="chip rapid">RAPID ' + P.rapid.toFixed(1) + 's</span>');
    if (P.triple > 0) chips.push('<span class="chip triple">TRIPLE ' + P.triple.toFixed(1) + 's</span>');
    if (P.shield > 0) chips.push('<span class="chip shield">SHIELD</span>');
    const html = chips.join('');
    if (html !== lastChips) { dom.power.innerHTML = html; lastChips = html; }
  }

  // ------------------------------------------------------------------ overlay
  function hideOverlay() {
    dom.overlay.className = 'overlay';
    dom.overlay.innerHTML = '';
  }

  function showMenu() {
    G.mode = 'menu';
    dom.overlay.className = 'overlay show';
    dom.overlay.innerHTML =
      '<div class="panel">' +
        '<p class="eyebrow">ARCADE // SECTOR 01</p>' +
        '<h1 class="title">NEON<span>DEFENDER</span></h1>' +
        '<p class="tag">Survive endless waves of neon swarm.<br>Chain kills for a score multiplier.</p>' +
        '<div class="diffs">' +
          DIFF_ORDER.map((key) =>
            '<button class="diff-btn" data-diff="' + key + '" aria-pressed="false">' +
              DIFFICULTY[key].label +
            '</button>'
          ).join('') +
        '</div>' +
        '<p class="diff-note">' + DIFFICULTY[G.difficulty].note + '</p>' +
        '<button class="btn" data-act="start">PLAY</button>' +
        (isTouch
          ? '<p class="hint">Hold anywhere on the arena to fly that way and fire.</p>'
          : '<div class="keys">' +
              '<span><b>WASD / ARROWS</b> move</span>' +
              '<span><b>MOUSE / SPACE</b> fire</span>' +
              '<span><b>1 2 3</b> difficulty</span>' +
              '<span><b>P</b> pause</span>' +
            '</div>' +
            '<p class="hint">Aim with the mouse, hold to fire.</p>') +
      '</div>';
    syncDiffUI();
  }

  function showGameOver() {
    dom.overlay.className = 'overlay show';
    dom.overlay.innerHTML =
      '<div class="panel">' +
        '<p class="eyebrow">SIGNAL LOST // ' + DIFFICULTY[G.difficulty].label + '</p>' +
        '<h2 class="title small">GAME OVER</h2>' +
        '<div class="stats">' +
          '<div><span>SCORE</span><b>' + G.score.toLocaleString() + '</b></div>' +
          '<div><span>BEST</span><b>' + G.best.toLocaleString() + '</b></div>' +
          '<div><span>WAVE</span><b>' + G.wave + '</b></div>' +
        '</div>' +
        '<button class="btn" data-act="start">RETRY</button>' +
        '<p class="hint">PRESS SPACE OR CLICK RETRY</p>' +
      '</div>';
  }

  function showPaused() {
    dom.overlay.className = 'overlay show';
    dom.overlay.innerHTML =
      '<div class="panel">' +
        '<p class="eyebrow">STANDBY</p>' +
        '<h2 class="title small">PAUSED</h2>' +
        '<button class="btn" data-act="resume">RESUME</button>' +
        '<p class="hint">PRESS P TO CONTINUE</p>' +
      '</div>';
  }

  dom.overlay.addEventListener('click', (e) => {
    const diffBtn = e.target.closest('[data-diff]');
    if (diffBtn) {
      initAudio();
      setDifficulty(diffBtn.dataset.diff);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    initAudio();
    if (btn.dataset.act === 'start') startGame();
    if (btn.dataset.act === 'resume') resumeGame();
  });

  // ------------------------------------------------------------------ loop
  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    G.time += dt;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 70);

    if (G.mode === 'play') {
      update(dt);
    } else if (G.mode !== 'pause') {
      updateParticles(dt);
      updateFloaters(dt);
    }

    render();
    updateHud();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ boot
  resize();
  resetGame();
  showMenu();
  updateHud();
  requestAnimationFrame((t) => { last = t; frame(t); });

  // small debug surface (used by automated smoke tests)
  window.__NEON__ = {
    G, P, enemies, bullets, ebullets, particles, pickups, DIFFICULTY,
    startGame, spawnEnemy, killEnemy, resetGame, gameOver, hurtPlayer, setDifficulty,
    PLAYER_ART,
    get waveQueue() { return waveQueue; },
  };
})();
