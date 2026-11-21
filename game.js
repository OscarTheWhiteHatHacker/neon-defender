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
  };

  const P = {
    x: 0, y: 0, vx: 0, vy: 0, r: 13,
    aim: -Math.PI / 2, fireCd: 0,
    lives: 3, invuln: 0, shield: 0, rapid: 0, triple: 0,
  };

  // r is measured in world units on the 960x600 reference canvas; every spawn
  // multiplies it by the live canvas scale (see enemySizeScale).
  const ENEMY = {
    grunt:   { hp: 2, r: 13, speed: 88,  score: 10, color: '#ff3d81' },
    shooter: { hp: 3, r: 14, speed: 74,  score: 25, color: '#ffb020' },
    tank:    { hp: 9, r: 24, speed: 54,  score: 40, color: '#a06bff' },
  };

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
  const touch = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };

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
      touch.active = true;
      touch.id = e.pointerId;
      touch.ox = e.clientX;
      touch.oy = e.clientY;
      touch.x = 0;
      touch.y = 0;
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
      const dx = e.clientX - touch.ox;
      const dy = e.clientY - touch.oy;
      const m = Math.hypot(dx, dy);
      const max = 62;
      if (m > 0.5) {
        const k = Math.min(1, m / max) / m;
        touch.x = dx * k;
        touch.y = dy * k;
      } else {
        touch.x = 0;
        touch.y = 0;
      }
      const tp = pointerPos(e);
      mouse.x = tp.x;
      mouse.y = tp.y;
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
        touch.x = 0;
        touch.y = 0;
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

    G.score = 0;
    G.wave = 0;
    G.streak = 0;
    G.streakT = 0;
    G.shake = 0;
    G.waveTimer = 1.0;
    G.spawnTimer = 0;
    G.banner = 0;
    G.bannerText = '';

    mouse.x = W / 2;
    mouse.y = H * 0.25;
    touch.x = 0;
    touch.y = 0;
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
      speed: base.speed * DIFFICULTY[G.difficulty].speed * waveSpeedScale(),
      score: base.score,
      color: base.color,
      fireCd: rand(0.6, 1.6),
      hurt: 0,
      age: 0,
      seed: rand(0, TAU),
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
    const speed = 780;
    for (const s of spread) {
      const a = P.aim + s;
      bullets.push({
        x: P.x + Math.cos(a) * muzzle,
        y: P.y + Math.sin(a) * muzzle,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: 4,
        dmg: 1,
        life: 1.05,
      });
    }
    burst(P.x + Math.cos(P.aim) * 20, P.y + Math.sin(P.aim) * 20, '#9ffcff', 2, 90, 0.18);
    blip(700, 0.045, 'square', 0.022, -180);
  }

  function enemyShoot(e, nx, ny) {
    const sp = 265;
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
      G.shake = Math.max(G.shake, 8);
      burst(P.x, P.y, '#38f5ff', 22, 280, 0.55);
      floater(P.x, P.y - 30, 'SHIELD DOWN', '#38f5ff', 13);
      blip(300, 0.18, 'sine', 0.06, -120);
      return;
    }

    P.lives--;
    P.invuln = 1.9;
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
    if (Math.random() < 0.12) dropPickup(e.x, e.y);
  }

  // ------------------------------------------------------------------ update
  function updatePlayer(dt) {
    if (P.invuln > 0) P.invuln -= dt;
    if (P.rapid > 0) P.rapid = Math.max(0, P.rapid - dt);
    if (P.triple > 0) P.triple = Math.max(0, P.triple - dt);

    let ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (touch.active) { ix += touch.x; iy += touch.y; }

    const m = Math.hypot(ix, iy);
    if (m > 1) { ix /= m; iy /= m; }

    const MAX = 345;
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
    if (isTouch || (!mouse.active && near)) {
      if (near) P.aim = Math.atan2(near.y - P.y, near.x - P.x);
    } else if (mouse.active) {
      P.aim = Math.atan2(mouse.y - P.y, mouse.x - P.x);
    }

    P.fireCd -= dt;
    const firing = isTouch ? !!near : (mouse.down || keys.fire);
    if (firing && P.fireCd <= 0) {
      shoot();
      P.fireCd = P.rapid > 0 ? 0.082 : 0.16;
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

      if (e.type === 'grunt') {
        e.vx = nx * e.speed;
        e.vy = ny * e.speed;
      } else if (e.type === 'shooter') {
        const want = 250;
        const radial = d > want + 40 ? 1 : d < want - 40 ? -1 : 0;
        const tang = Math.sin(e.age * 0.85 + e.seed) * 0.8;
        e.vx = nx * e.speed * radial - ny * e.speed * tang;
        e.vy = ny * e.speed * radial + nx * e.speed * tang;
        e.fireCd -= dt;
        if (e.fireCd <= 0 && d < 640) {
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
      b.life -= dt;
      if (b.life <= 0 || b.x < -40 || b.x > W + 40 || b.y < -40 || b.y > H + 40) {
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

  function drawEnemy(e) {
    const hit = e.hurt > 0;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.shadowColor = e.color;
    ctx.shadowBlur = hit ? 30 : 16;
    ctx.fillStyle = hit ? '#ffffff' : e.color;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;

    // every enemy is a single flat filled silhouette: no notched tails, no
    // inner outlines, nothing that reads as a folded or extruded surface.
    if (e.type === 'grunt') {
      ctx.rotate(Math.atan2(P.y - e.y, P.x - e.x));
      ctx.beginPath();
      ctx.moveTo(e.r, 0);
      ctx.lineTo(-e.r * 0.86, e.r * 0.74);
      ctx.lineTo(-e.r * 0.86, -e.r * 0.74);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (e.type === 'shooter') {
      ctx.rotate(e.age * 1.6);
      polygon(4, e.r, 0);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.rotate(e.age * 0.5);
      polygon(6, e.r, 0);
      ctx.fill();
      ctx.stroke();
    }
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

  function drawPlayer() {
    if (G.mode === 'dead') return;
    const blink = P.invuln > 0 && Math.floor(G.time * 16) % 2 === 0;
    ctx.save();
    ctx.translate(P.x, P.y);
    ctx.rotate(P.aim);
    ctx.globalAlpha = blink ? 0.32 : 1;
    ctx.shadowColor = '#38f5ff';
    ctx.shadowBlur = 22;
    // flat triangle: a straight-sided silhouette with a solid base, so the ship
    // reads as a 2D shape instead of a folded paper-plane style dart.
    ctx.fillStyle = '#c9feff';
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-11, 11);
    ctx.lineTo(-11, -11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
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
    if (isTouch || !mouse.active || G.mode !== 'play') return;
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
        '<div class="keys">' +
          '<span><b>WASD / ARROWS</b> move</span>' +
          '<span><b>MOUSE / SPACE</b> fire</span>' +
          '<span><b>1 2 3</b> difficulty</span>' +
          '<span><b>P</b> pause</span>' +
        '</div>' +
        '<p class="hint">' + (isTouch ? 'Drag anywhere to move — the turret fires itself.' : 'Aim with the mouse, hold to fire.') + '</p>' +
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
    get waveQueue() { return waveQueue; },
  };
})();
