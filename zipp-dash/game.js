/* =====================================================================
 * Zipp Dash — a small speed platformer.
 * Everything (art, sound, levels) is generated in code. No assets.
 *
 * File layout:
 *   1. Constants and the LEVELS table (edit levels here)
 *   2. Input and Sound helpers
 *   3. Level     – tile map, collision queries, tile + background drawing
 *   4. Camera    – smooth follow with look-ahead
 *   5. Player    – Zipp, momentum physics, loop riding, drawing
 *   6. Enemy     – Beetle and Drone
 *   7. HUD       – score / time / crystals / lives
 *   8. Game      – state machine, objects, fixed-timestep loop
 * ===================================================================== */

'use strict';

// ---------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------

const VIEW_W = 960;          // logical screen size in pixels
const VIEW_H = 540;
const TILE = 32;             // tile size in pixels
const STEP = 1000 / 60;      // fixed simulation step (60 updates / second)
const FONT = '"Bungee", "Arial Black", Impact, sans-serif';

// Physics values are in pixels per frame (at 60fps), in the style of
// classic 16-bit speed platformers.
const PHYS = {
  acc: 0.09,          // ground acceleration (slow build-up)
  dec: 0.5,           // braking when pressing against your motion
  frc: 0.09,          // friction with no input
  top: 9,             // top running speed from input alone
  maxSpeed: 16,       // absolute speed cap (slopes / spin-dash can exceed `top`)
  airAcc: 0.18,       // air control
  gravity: 0.35,
  jump: 7.6,          // jump impulse
  jumpCut: 4,         // upward speed kept when jump is released early
  slope: 0.125,       // slope gravity while running
  rollUp: 0.078,      // slope gravity rolling uphill
  rollDown: 0.3,      // slope gravity rolling downhill
  rollFrc: 0.045,     // rolling friction
  rollDec: 0.125,     // braking while rolling
  spring: 14.5,       // spring launch speed
  loopGravity: 0.125, // gravity along the loop track
  maxFall: 16,
};

/* ---------------------------------------------------------------------
 * LEVELS
 *
 * Each level is a list of equal-length strings, one per tile row
 * (17 rows fills the screen height). Legend:
 *
 *   .  empty                 #  solid ground
 *   /  45° slope rising →    \  45° slope falling →   (write '\\' in JS)
 *   a b  gentle rise (always as the pair "ab", climbs one tile over two)
 *   c d  gentle fall (always as the pair "cd")
 *   =  floating platform (jump up through it, land on top)
 *   ^  spikes (place on the tile just above the ground)
 *   *  energy crystal         S  spring (on the tile above the ground)
 *   B  beetle enemy          D  drone enemy
 *   C  checkpoint post       G  goal post
 *   O  360° loop (centre column, on the tile above flat ground;
 *      keep ~5 flat columns on each side and a run-up before it)
 *   P  player start
 * ------------------------------------------------------------------- */
const LEVELS = [
  {
    name: 'Voltage Valley',
    rows: [
      '............................................................................................................................................................................................................................................................................................................',
      '............................................................................................................................................................................................................................................................................................................',
      '.......................................................................................................................................................................D....................................................................................................................................',
      '....................................................................................*.......................................................................................................................................................................................................................',
      '...................................................................................===............................................................................**********................................................................................................................................',
      '................................................................................*******...B.......................................................................==========................................................................................................................................',
      '................................D............................................##################\\....................................................***..........................................................*..........................................................................................',
      '..............................................................*..............###################\\..................................................=====........................................................*.*.........................................................................................',
      '.................................................................*......D....####################\\..................................................^^^...B...............................................................................................B.................................................',
      '.............................******...............**............===..........#####################\\..................................D........ab############\\..........................*....................................................D....**................................D........................',
      '.........................../########cd...........*..*.......*................######################\\........................................ab###############\\....................*...==......................./##\\...................********..*..*........................................................',
      '........******............/###########cd...................===...............#######################\\.......................*******.......ab##################\\...................==.........*****../###\\...../####\\.......ab####cd.................../######\\....***********...............................',
      '...P..............B....../##################cd....^^...B.............C....S..########################\\.........O......C.........B.......ab#####################\\...S......B................C......./#####\\.../######\\....ab########cd...B........^^../########\\...................................G.........',
      '##########################################################..........############################################################################################################.........###################################################################################################################',
      '##########################################################..........############################################################################################################.........###################################################################################################################',
      '##########################################################..........############################################################################################################.........###################################################################################################################',
      '##########################################################..........############################################################################################################.........###################################################################################################################',
    ],
  },
];

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
// Deterministic pseudo-random number from an integer (for scenery).
const hash = n => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---------------------------------------------------------------------
// 2a. Input — tracks held keys and keys pressed since the last update
// ---------------------------------------------------------------------

class Input {
  constructor() {
    this.held = new Set();
    this.pressed = new Set();
    this.map = {
      ArrowLeft: 'left', KeyA: 'left',
      ArrowRight: 'right', KeyD: 'right',
      ArrowDown: 'down', KeyS: 'down',
      ArrowUp: 'up', KeyW: 'up',
      Space: 'jump',
      Enter: 'start',
      KeyP: 'pause', Escape: 'pause',
      KeyM: 'mute',
    };
    window.addEventListener('keydown', e => {
      const a = this.map[e.code];
      if (!a) return;
      e.preventDefault();
      if (!this.held.has(a)) this.pressed.add(a);
      this.held.add(a);
      // Up/W doubles as a jump key.
      if (a === 'up') { if (!this.held.has('jump')) this.pressed.add('jump'); this.held.add('jump'); }
      this.onAny && this.onAny();
    });
    window.addEventListener('keyup', e => {
      const a = this.map[e.code];
      if (!a) return;
      this.held.delete(a);
      if (a === 'up') this.held.delete('jump');
      if (a === 'jump' && this.held.has('up')) this.held.add('jump');
    });
    window.addEventListener('blur', () => this.held.clear());
  }
  down(a) { return this.held.has(a); }
  hit(a) { return this.pressed.has(a); }
  endStep() { this.pressed.clear(); }
}

// ---------------------------------------------------------------------
// 2b. Sound — tiny Web Audio synth, created on the first key press
// ---------------------------------------------------------------------

class Sound {
  constructor() { this.ctx = null; this.muted = false; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  // A single oscillator sweep from f1 to f2.
  tone(f1, f2, dur, type = 'square', vol = 0.15, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // A burst of white noise (impacts, dust).
  noise(dur, vol = 0.2, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.buffer = buf; src.connect(g); g.connect(this.master);
    src.start(t);
  }

  jump()    { this.tone(320, 720, 0.14, 'square', 0.1); }
  collect() { this.tone(1320, 1320, 0.07, 'sine', 0.18); this.tone(1980, 1980, 0.16, 'sine', 0.15, 0.06); }
  hit()     { this.tone(420, 70, 0.35, 'sawtooth', 0.16); this.noise(0.2, 0.15); }
  spring()  { this.tone(180, 980, 0.28, 'triangle', 0.25); this.tone(240, 1200, 0.2, 'sine', 0.08, 0.03); }
  roll()    { this.noise(0.12, 0.12); }
  rev(n)    { this.tone(220 + n * 40, 520 + n * 70, 0.16, 'sawtooth', 0.09); }
  launch()  { this.tone(900, 160, 0.25, 'sawtooth', 0.1); this.noise(0.18, 0.12); }
  pop()     { this.tone(700, 90, 0.18, 'square', 0.12); this.noise(0.15, 0.18); }
  scatter() { for (let i = 0; i < 5; i++) this.tone(1500 - i * 160, 1400 - i * 160, 0.08, 'sine', 0.12, i * 0.045); }
  check()   { [660, 880, 1320].forEach((f, i) => this.tone(f, f, 0.12, 'sine', 0.15, i * 0.08)); }
  goal()    { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.2, 'square', 0.08, i * 0.1)); }
  die()     { [494, 440, 392, 330, 262].forEach((f, i) => this.tone(f, f * 0.97, 0.18, 'triangle', 0.18, i * 0.12)); }
}

// ---------------------------------------------------------------------
// 3. Level — tile map, collision and drawing
// ---------------------------------------------------------------------

// Surface height (0..32) of a slope tile at local x (0..31); the solid
// part of a tile is everything below TILE - height.
const SLOPES = {
  '/': lx => lx + 1,
  '\\': lx => TILE - lx,
  a: lx => (lx + 1) / 2,
  b: lx => 16 + (lx + 1) / 2,
  c: lx => TILE - lx / 2,
  d: lx => 16 - lx / 2,
};
// Left/right edge heights of each slope, for drawing.
const SLOPE_EDGES = { '/': [0, 32], '\\': [32, 0], a: [0, 16], b: [16, 32], c: [32, 16], d: [16, 0] };

class Level {
  constructor(def) {
    this.name = def.name;
    this.rows = def.rows.length;
    this.cols = Math.max(...def.rows.map(r => r.length));
    this.w = this.cols * TILE;
    this.h = this.rows * TILE;
    this.grid = [];
    // Objects pulled out of the map; the Game turns them into entities.
    this.spawns = { player: { x: 3 * TILE, y: 13 * TILE }, crystals: [], enemies: [], springs: [], spikes: [], checkpoints: [], loops: [], goal: null };

    for (let r = 0; r < this.rows; r++) {
      const line = def.rows[r].padEnd(this.cols, '.');
      const row = [];
      for (let c = 0; c < this.cols; c++) {
        const ch = line[c];
        const cx = c * TILE + TILE / 2;   // tile centre x
        const by = (r + 1) * TILE;        // tile bottom y (= ground top below it)
        switch (ch) {
          case 'P': this.spawns.player = { x: cx, y: by }; row.push('.'); break;
          case '*': this.spawns.crystals.push({ x: cx, y: r * TILE + TILE / 2 }); row.push('.'); break;
          case 'B': this.spawns.enemies.push({ type: 'beetle', x: cx, y: by }); row.push('.'); break;
          case 'D': this.spawns.enemies.push({ type: 'drone', x: cx, y: r * TILE + TILE / 2 }); row.push('.'); break;
          case 'S': this.spawns.springs.push({ x: cx, y: by }); row.push('.'); break;
          case '^': this.spawns.spikes.push({ x: c * TILE, y: by }); row.push('.'); break;
          case 'C': this.spawns.checkpoints.push({ x: cx, y: by }); row.push('.'); break;
          case 'G': this.spawns.goal = { x: cx, y: by }; row.push('.'); break;
          case 'O': this.spawns.loops.push({ cx, groundY: by, r: 128 }); row.push('.'); break;
          default: row.push(ch);
        }
      }
      this.grid.push(row);
    }
    this.loops = this.spawns.loops.map(l => ({ ...l, cy: l.groundY - l.r }));
    this.buildPattern();
  }

  tile(c, r) {
    if (r < 0 || r >= this.rows) return '.';
    if (c < 0 || c >= this.cols) return '#';   // level edges are walls
    return this.grid[r][c];
  }

  isSolidTile(ch) { return ch === '#' || ch in SLOPES; }

  /**
   * Is world point (x, y) inside solid ground?
   * Floating platforms only count when y >= platMinY, which lets things
   * pass up through them and land on them from above.
   */
  solid(x, y, platMinY = Infinity) {
    if (y < 0) return false;
    if (y >= this.h) return false;               // bottomless pits
    if (x < 0 || x >= this.w) return true;
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE);
    const ch = this.grid[r][c];
    if (ch === '#') return true;
    const ly = y - r * TILE;
    if (ch === '=') return ly < 10 && y >= platMinY;
    const f = SLOPES[ch];
    if (f) return ly >= TILE - f(Math.floor(x - c * TILE));
    return false;
  }

  /** Top of the first ground surface found scanning from y-up to y+down at column x. */
  floorY(x, y, up, down, platMinY = Infinity) {
    const start = Math.floor(y - up), end = y + down;
    let above = this.solid(x, start - 1, platMinY);
    for (let yy = start; yy <= end; yy++) {
      const s = this.solid(x, yy, platMinY);
      if (s && !above) return yy;
      above = s;
    }
    return null;
  }

  /** A body-height wall check (ignores platforms; slopes are walkable). */
  wall(x, feetY, h) {
    return this.solid(x, feetY - 14) || this.solid(x, feetY - h + 3);
  }

  // A small soil texture used as a world-aligned pattern.
  buildPattern() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#9a5f34'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#86502a'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    g.fillStyle = 'rgba(255,220,170,0.18)';
    g.fillRect(5, 6, 3, 2); g.fillRect(22, 23, 3, 2); g.fillRect(24, 5, 2, 2); g.fillRect(7, 24, 2, 2);
    this.patternCanvas = c;
  }

  // ----- drawing -----

  drawBackground(ctx, cam, t) {
    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, '#3fa9e8');
    sky.addColorStop(0.6, '#9fdcf7');
    sky.addColorStop(1, '#e3f7ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Sun
    ctx.fillStyle = 'rgba(255,248,214,0.9)';
    ctx.beginPath(); ctx.arc(VIEW_W - 170 - cam.x * 0.02, 110, 46, 0, Math.PI * 2); ctx.fill();

    // Clouds (very slow)
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const cloudSpan = 760;
    const cOff = (cam.x * 0.1 + t * 0.15) % cloudSpan;
    for (let i = -1; i < 3; i++) {
      const bx = i * cloudSpan - cOff;
      for (let k = 0; k < 3; k++) {
        const x = bx + k * 260 + hash(k) * 80, y = 60 + hash(k + 7) * 90;
        ctx.beginPath();
        ctx.ellipse(x, y, 46, 16, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 30, y - 10, 30, 16, 0, 0, Math.PI * 2);
        ctx.ellipse(x - 26, y - 4, 24, 12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Distant hills
    const yShift = -cam.y * 0.15;
    this.hillLayer(ctx, cam.x * 0.2, 330 + yShift, 60, '#8fd0b2', 0.0035, 0.009);
    this.hillLayer(ctx, cam.x * 0.3, 380 + yShift, 45, '#6bbd94', 0.005, 0.013);

    // Near tree line
    const f = 0.5, ox = cam.x * f;
    const baseY = 440 - cam.y * 0.35;
    ctx.fillStyle = '#3f9a6a';
    ctx.fillRect(0, baseY, VIEW_W, VIEW_H - baseY);
    const spacing = 70;
    const first = Math.floor(ox / spacing) - 1;
    for (let i = first; i < first + VIEW_W / spacing + 3; i++) {
      const x = i * spacing - ox + hash(i) * 30;
      const hgt = 70 + hash(i + 3) * 70;
      ctx.fillStyle = '#5a3a26';
      ctx.fillRect(x - 4, baseY - hgt * 0.45, 8, hgt * 0.45 + 2);
      ctx.fillStyle = hash(i + 9) > 0.5 ? '#2f8a58' : '#358f5f';
      ctx.beginPath();
      ctx.moveTo(x, baseY - hgt);
      ctx.lineTo(x + 26, baseY - hgt * 0.35);
      ctx.lineTo(x - 26, baseY - hgt * 0.35);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, baseY - hgt * 0.8);
      ctx.lineTo(x + 32, baseY - hgt * 0.15);
      ctx.lineTo(x - 32, baseY - hgt * 0.15);
      ctx.closePath(); ctx.fill();
    }
  }

  hillLayer(ctx, ox, baseY, amp, color, f1, f2) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, VIEW_H);
    for (let x = 0; x <= VIEW_W; x += 8) {
      const wx = x + ox;
      ctx.lineTo(x, baseY - Math.abs(Math.sin(wx * f1)) * amp - Math.sin(wx * f2) * amp * 0.3);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.closePath(); ctx.fill();
  }

  drawLoops(ctx, cam) {
    for (const L of this.loops) {
      if (L.cx + L.r + 40 < cam.x || L.cx - L.r - 40 > cam.x + VIEW_W) continue;
      // Track band (outside the riding circle)
      ctx.lineWidth = 22;
      ctx.strokeStyle = '#86502a';
      ctx.beginPath(); ctx.arc(L.cx, L.cy, L.r + 11, 0, Math.PI * 2); ctx.stroke();
      // Checker band
      ctx.lineWidth = 10;
      ctx.setLineDash([16, 16]);
      ctx.strokeStyle = '#b07040';
      ctx.beginPath(); ctx.arc(L.cx, L.cy, L.r + 14, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // Grass running surface
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#4fc152';
      ctx.beginPath(); ctx.arc(L.cx, L.cy, L.r + 3, 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawTiles(ctx, cam) {
    if (!this.pattern) this.pattern = ctx.createPattern(this.patternCanvas, 'repeat');
    const c0 = Math.max(0, Math.floor(cam.x / TILE));
    const c1 = Math.min(this.cols - 1, Math.floor((cam.x + VIEW_W) / TILE));
    const r0 = Math.max(0, Math.floor(cam.y / TILE));
    const r1 = Math.min(this.rows - 1, Math.floor((cam.y + VIEW_H) / TILE));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ch = this.grid[r][c];
        const x = c * TILE, y = r * TILE;
        const exposed = !this.isSolidTile(this.tile(c, r - 1));
        if (ch === '#') {
          ctx.fillStyle = this.pattern;
          ctx.fillRect(x, y, TILE, TILE);
          if (exposed) this.grass(ctx, x, y, x + TILE, y);
        } else if (SLOPE_EDGES[ch]) {
          const [hl, hr] = SLOPE_EDGES[ch];
          ctx.fillStyle = this.pattern;
          ctx.beginPath();
          ctx.moveTo(x, y + TILE - hl);
          ctx.lineTo(x + TILE, y + TILE - hr);
          ctx.lineTo(x + TILE, y + TILE);
          ctx.lineTo(x, y + TILE);
          ctx.closePath(); ctx.fill();
          this.grass(ctx, x, y + TILE - hl, x + TILE, y + TILE - hr);
        } else if (ch === '=') {
          ctx.fillStyle = '#7b8496';
          ctx.fillRect(x, y + 2, TILE, 10);
          ctx.fillStyle = '#5c6476';
          ctx.fillRect(x, y + 10, TILE, 3);
          ctx.fillStyle = '#4fc152';
          ctx.fillRect(x, y, TILE, 4);
        }
      }
    }
  }

  // Grass strip along a surface line.
  grass(ctx, x1, y1, x2, y2) {
    ctx.fillStyle = '#2f8f3a';
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 + 8); ctx.lineTo(x1, y1 + 8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4fc152';
    ctx.beginPath();
    ctx.moveTo(x1, y1 - 1); ctx.lineTo(x2, y2 - 1); ctx.lineTo(x2, y2 + 5); ctx.lineTo(x1, y1 + 5);
    ctx.closePath(); ctx.fill();
  }
}

// ---------------------------------------------------------------------
// 4. Camera — smooth follow with look-ahead in the direction of travel
// ---------------------------------------------------------------------

class Camera {
  constructor() { this.x = 0; this.y = 0; this.lead = 0; }

  snap(target, level) {
    this.lead = 0;
    this.x = clamp(target.x - VIEW_W / 2, 0, level.w - VIEW_W);
    this.y = clamp(target.y - VIEW_H * 0.6, 0, Math.max(0, level.h - VIEW_H));
  }

  update(target, level) {
    // Look ahead up to 140px in the direction of motion, eased in.
    this.lead = lerp(this.lead, clamp(target.speedX() * 16, -140, 140), 0.04);
    const tx = target.x + this.lead - VIEW_W / 2;
    const ty = target.y - VIEW_H * 0.6;
    this.x = clamp(lerp(this.x, tx, 0.14), 0, level.w - VIEW_W);
    this.y = clamp(lerp(this.y, ty, 0.1), 0, Math.max(0, level.h - VIEW_H));
  }
}

// ---------------------------------------------------------------------
// 5. Player — "Zipp", the lightning-tailed fox
// ---------------------------------------------------------------------

class Player {
  constructor(x, y) { this.reset(x, y); }

  reset(x, y) {
    this.x = x; this.y = y;       // (x, y) is the point between Zipp's feet
    this.vx = 0; this.vy = 0;     // air velocity
    this.gsp = 0;                 // ground speed along the surface
    this.angle = 0;               // ground angle (radians, + = downhill to the right)
    this.grounded = true;
    this.facing = 1;
    this.rolling = false;         // curled into a ball (attacks enemies)
    this.crouching = false;
    this.spindash = false;
    this.charge = 0;
    this.jumping = false;         // in a player-initiated jump (for variable height)
    this.sprung = false;          // launched by a spring
    this.hurt = false;            // knocked back, no control until landing
    this.invuln = 0;              // frames of invincibility left
    this.dead = false;
    this.loop = null;             // the loop currently being ridden
    this.theta = 0;
    this.anim = 0;                // animation clock
    this.spin = 0;                // ball spin angle
    this.skid = 0;
  }

  get height() { return this.rolling || this.spindash || this.crouching ? 22 : 30; }
  get attacking() { return this.rolling || this.spindash; }
  speedX() { return this.loop ? this.gsp * Math.cos(this.theta) : this.grounded ? this.gsp * Math.cos(this.angle) : this.vx; }

  box() {
    const h = this.height;
    return { x: this.x - 9, y: this.y - h, w: 18, h };
  }

  update(input, level, game) {
    this.anim++;
    if (this.invuln > 0) this.invuln--;

    if (this.dead) {               // death pop: fall off the screen
      this.vy += PHYS.gravity;
      this.y += this.vy;
      return;
    }
    if (this.loop) { this.updateLoop(input, level, game); return; }

    const ctl = game.controlsLocked ? { down: () => false, hit: () => false } : input;
    if (this.grounded) this.updateGround(ctl, level, game);
    else this.updateAir(ctl, level, game);

    const spd = this.grounded ? this.gsp : this.vx;
    this.spin += (Math.abs(spd) * 0.06 + 0.25) * (this.facing);
  }

  // ----- on the ground -----
  updateGround(input, level, game) {
    const sin = Math.sin(this.angle), cos = Math.cos(this.angle);
    const L = input.down('left'), R = input.down('right'), D = input.down('down');

    if (this.spindash) {
      // Charging: every jump press revs harder; releasing Down launches.
      if (input.hit('jump')) { this.charge = Math.min(this.charge + 2, 8); game.sfx.rev(this.charge); }
      this.charge -= this.charge / 32;
      if (!D) {
        this.spindash = false;
        this.rolling = true;
        this.gsp = this.facing * (8 + Math.floor(this.charge) / 2);
        game.sfx.launch();
        game.dust(this.x - this.facing * 10, this.y, 8);
      } else if (this.anim % 4 === 0) {
        game.dust(this.x - this.facing * 12, this.y, 1);
      }
      this.follow(level, game);
      return;
    }

    // Jump (works from running, rolling or crouching-without-dash)
    if (input.hit('jump') && !(D && this.crouching)) {
      this.vx = this.gsp * cos + PHYS.jump * sin;
      this.vy = this.gsp * sin - PHYS.jump * cos;
      this.grounded = false;
      this.jumping = true;
      this.rolling = true;
      this.crouching = false;
      game.sfx.jump();
      return;
    }

    if (this.rolling) {
      // Rolling: no acceleration, low friction, strong downhill pull.
      const uphill = sign(this.gsp) !== sign(sin) && sin !== 0;
      this.gsp += (uphill ? PHYS.rollUp : PHYS.rollDown) * sin;
      if (L && this.gsp > 0) this.gsp -= PHYS.rollDec;
      if (R && this.gsp < 0) this.gsp += PHYS.rollDec;
      this.gsp -= Math.min(Math.abs(this.gsp), PHYS.rollFrc) * sign(this.gsp);
      if (Math.abs(this.gsp) < 0.5) this.rolling = false;
    } else {
      // Slope gravity (ignored when standing still on near-flat ground)
      if (Math.abs(sin) > 0.05 || Math.abs(this.gsp) > 0.05) this.gsp += PHYS.slope * sin;

      this.skid = 0;
      if (R && !this.crouching) {
        if (this.gsp < 0) { this.gsp += PHYS.dec; this.skid = 1; }
        else if (this.gsp < PHYS.top) this.gsp = Math.min(this.gsp + PHYS.acc, PHYS.top);
        this.facing = this.gsp >= 0 ? 1 : this.facing;
      } else if (L && !this.crouching) {
        if (this.gsp > 0) { this.gsp -= PHYS.dec; this.skid = 1; }
        else if (this.gsp > -PHYS.top) this.gsp = Math.max(this.gsp - PHYS.acc, -PHYS.top);
        this.facing = this.gsp <= 0 ? -1 : this.facing;
      } else {
        this.gsp -= Math.min(Math.abs(this.gsp), PHYS.frc) * sign(this.gsp);
      }
      if (this.skid && Math.abs(this.gsp) > 3 && this.anim % 3 === 0) game.dust(this.x, this.y, 1);

      // Down: roll when moving, crouch (ready to spin-dash) when still
      if (D && Math.abs(this.gsp) >= 1) { this.rolling = true; game.sfx.roll(); }
      this.crouching = D && Math.abs(this.gsp) < 1;
      if (this.crouching && input.hit('jump')) {
        this.spindash = true; this.charge = 0; this.gsp = 0;
        game.sfx.rev(0);
      }
    }

    this.gsp = clamp(this.gsp, -PHYS.maxSpeed, PHYS.maxSpeed);
    this.follow(level, game);
  }

  // Move along the ground, stick to the surface, detect walls and loops.
  follow(level, game) {
    const prevX = this.x;
    this.x += this.gsp * Math.cos(this.angle);

    // Walls
    const dir = sign(this.gsp);
    if (dir && level.wall(this.x + dir * 9, this.y, this.height)) {
      let n = 0;
      while (level.wall(this.x + dir * 9, this.y, this.height) && n++ < 20) this.x -= dir;
      this.gsp = 0;
    }

    // Loops: enter at the bottom when running right fast enough.
    for (const L of level.loops) {
      if (this.gsp >= 3 && prevX < L.cx && this.x >= L.cx && Math.abs(this.y - L.groundY) < 6) {
        this.loop = L; this.theta = 0; this.x = L.cx; this.y = L.groundY;
        return;
      }
    }

    // Stick to the floor using two foot sensors.
    const range = Math.max(20, Math.abs(this.gsp) + 8);
    const plat = this.y - 4;
    const a = level.floorY(this.x - 7, this.y, 20, range, plat);
    const b = level.floorY(this.x + 7, this.y, 20, range, plat);
    if (a === null && b === null) {
      // Ran off a ledge
      this.grounded = false;
      this.vx = this.gsp * Math.cos(this.angle);
      this.vy = this.gsp * Math.sin(this.angle);
      this.crouching = false; this.spindash = false;
      return;
    }
    this.y = Math.min(a ?? Infinity, b ?? Infinity);
    this.angle = a !== null && b !== null ? clamp(Math.atan2(b - a, 14), -1, 1) : 0;
  }

  // ----- in the air -----
  updateAir(input, level, game) {
    if (!this.hurt) {
      if (input.down('right') && this.vx < PHYS.top) { this.vx += PHYS.airAcc; this.facing = 1; }
      if (input.down('left') && this.vx > -PHYS.top) { this.vx -= PHYS.airAcc; this.facing = -1; }
      // Variable jump height: let go early for a short hop.
      if (this.jumping && !input.down('jump') && this.vy < -PHYS.jumpCut) this.vy = -PHYS.jumpCut;
      // Down in mid-air curls into an attack roll.
      if (input.hit('down') && !this.rolling) { this.rolling = true; this.sprung = false; game.sfx.roll(); }
    }
    // A little air drag at the top of a jump
    if (this.vy < 0 && this.vy > -4) this.vx -= this.vx / 32 * 0.125;

    this.vy = Math.min(this.vy + PHYS.gravity, PHYS.maxFall);

    // Horizontal move + walls
    this.x += this.vx;
    const dir = sign(this.vx);
    if (dir && level.wall(this.x + dir * 9, this.y, this.height)) {
      let n = 0;
      while (level.wall(this.x + dir * 9, this.y, this.height) && n++ < 20) this.x -= dir;
      this.vx = 0;
    }

    // Vertical move
    const prevY = this.y;
    this.y += this.vy;

    if (this.vy < 0) {
      // Ceiling bump
      const top = this.y - this.height;
      if (level.solid(this.x, top) || level.solid(this.x - 6, top) || level.solid(this.x + 6, top)) {
        let n = 0;
        while ((level.solid(this.x, this.y - this.height) || level.solid(this.x - 6, this.y - this.height) || level.solid(this.x + 6, this.y - this.height)) && n++ < 24) this.y++;
        this.vy = 0;
      }
      return;
    }

    // Landing
    const up = Math.abs(this.vx) + this.vy + 4;
    const plat = prevY - 1;
    const a = level.floorY(this.x - 7, this.y, up, 0, plat);
    const b = level.floorY(this.x + 7, this.y, up, 0, plat);
    if (a === null && b === null) return;
    this.y = Math.min(a ?? Infinity, b ?? Infinity);
    this.angle = a !== null && b !== null ? clamp(Math.atan2(b - a, 14), -1, 1) : 0;
    this.gsp = this.vx * Math.cos(this.angle) + this.vy * Math.sin(this.angle);
    this.grounded = true;
    this.jumping = false;
    this.sprung = false;
    this.hurt = false;
    // Landing uncurls unless Down is held.
    this.rolling = input.down('down') && Math.abs(this.gsp) >= 1;
  }

  // ----- riding the 360° loop -----
  updateLoop(input, level, game) {
    const L = this.loop;
    this.gsp -= PHYS.loopGravity * Math.sin(this.theta);
    if (input.down('right') && !this.rolling) this.gsp += PHYS.acc;
    this.theta += this.gsp / L.r;
    this.spin += this.gsp * 0.06;
    this.facing = 1;

    if (this.theta >= Math.PI * 2) {
      // Completed the loop: back on flat ground heading right.
      this.loop = null;
      this.x = L.cx + 1; this.y = L.groundY;
      this.angle = 0; this.grounded = true;
      return;
    }
    this.x = L.cx + L.r * Math.sin(this.theta);
    this.y = L.cy + L.r * Math.cos(this.theta);

    // Too slow: fall off the track.
    if (this.gsp < 2.2 && this.theta > 0.35) {
      this.vx = this.gsp * Math.cos(this.theta);
      this.vy = -this.gsp * Math.sin(this.theta);
      this.loop = null;
      this.grounded = false;
      this.angle = 0;
      // Move the feet off the circle so the body is not inside the track.
      this.y = Math.min(this.y, L.groundY - 1);
    }
  }

  // Knock back after a hit (crystals already handled by the Game).
  knockback(fromX) {
    this.loop = null;
    this.grounded = false;
    this.rolling = this.spindash = this.crouching = this.jumping = false;
    this.hurt = true;
    this.vx = this.x < fromX ? -2.5 : 2.5;
    this.vy = -4.5;
    this.y -= 2;
    this.invuln = 120;
  }

  // ----- drawing -----
  draw(ctx) {
    if (this.invuln > 0 && !this.dead && Math.floor(this.invuln / 4) % 2) return;  // blink
    ctx.save();
    ctx.translate(this.x, this.y);

    let rot = 0;
    if (this.loop) rot = -this.theta;
    else if (this.grounded && !this.rolling && !this.spindash) rot = this.angle * 0.9;
    ctx.rotate(rot);

    if (this.rolling || this.spindash) {
      this.drawBall(ctx);
    } else {
      ctx.scale(this.facing, 1);
      this.drawFox(ctx);
    }
    ctx.restore();
  }

  drawBall(ctx) {
    const squash = this.spindash ? 0.85 : 1;
    ctx.save();
    ctx.translate(0, -12 * squash);
    ctx.scale(1 / squash, squash);
    ctx.rotate(this.spin);
    ctx.fillStyle = '#f07a1a';
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b8510b'; ctx.lineWidth = 2.5;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.arc(0, 0, 8, i * 2.1, i * 2.1 + 1.2); ctx.stroke();
    }
    // Bolt tail curled into the ball
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.moveTo(-3, -11); ctx.lineTo(3, -4); ctx.lineTo(-1, -3); ctx.lineTo(4, 5); ctx.lineTo(-4, -2); ctx.lineTo(0, -3);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  drawFox(ctx) {
    const moving = this.grounded ? Math.abs(this.gsp) : 0;
    const air = !this.grounded;
    const crouch = this.crouching ? 6 : 0;
    const phase = this.anim * (0.15 + moving * 0.04);

    // Lightning-bolt tail
    const wag = Math.sin(this.anim * 0.2) * 2;
    ctx.save();
    ctx.translate(-6, -13 + crouch);
    ctx.rotate(moving > 6 ? 0.6 : 0.15 + wag * 0.05);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#d98a00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-11, -5); ctx.lineTo(-7, -7); ctx.lineTo(-17, -16);
    ctx.lineTo(-5, -10); ctx.lineTo(-9, -8); ctx.lineTo(2, -3);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    // Legs and shoes
    const legSwing = moving > 0.3 ? Math.sin(phase) : 0;
    const legs = air ? [[-4, -2], [4, -4]] : [[-3 + legSwing * 6, 0], [3 - legSwing * 6, 0]];
    for (const [lx, ly] of legs) {
      ctx.strokeStyle = '#c9600f'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lx * 0.3, -9 + crouch); ctx.lineTo(lx, ly - 4); ctx.stroke();
      ctx.fillStyle = '#1aa6a0';
      ctx.beginPath(); ctx.ellipse(lx + 2, ly - 2, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(lx, ly - 3, 4, 1.5);
    }

    // Body
    const lean = Math.min(moving * 0.03, 0.3);
    ctx.save();
    ctx.translate(0, crouch);
    ctx.rotate(lean);
    ctx.fillStyle = '#f07a1a';
    ctx.beginPath(); ctx.ellipse(0, -14, 8, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff3e0';
    ctx.beginPath(); ctx.ellipse(3, -12, 4.5, 5, 0, 0, Math.PI * 2); ctx.fill();

    // Arms
    ctx.strokeStyle = '#c9600f'; ctx.lineWidth = 3.5;
    const armUp = this.sprung || this.hurt;
    ctx.beginPath();
    ctx.moveTo(2, -16);
    if (armUp) ctx.lineTo(5, -27);
    else ctx.lineTo(4 - legSwing * 5, -9);
    ctx.stroke();

    // Head
    ctx.fillStyle = '#f07a1a';
    ctx.beginPath(); ctx.arc(4, -25, 8, 0, Math.PI * 2); ctx.fill();
    // Ears
    ctx.beginPath(); ctx.moveTo(-1, -29); ctx.lineTo(-2, -39); ctx.lineTo(5, -32); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(5, -32); ctx.lineTo(9, -41); ctx.lineTo(11, -30); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#5a2a10';
    ctx.beginPath(); ctx.moveTo(0, -31); ctx.lineTo(-1, -36); ctx.lineTo(3, -32); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(7, -32); ctx.lineTo(9, -38); ctx.lineTo(10, -31); ctx.closePath(); ctx.fill();
    // Muzzle, nose, eye
    ctx.fillStyle = '#fff3e0';
    ctx.beginPath(); ctx.ellipse(10, -22, 5, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath(); ctx.arc(14.5, -23, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(7, -27, 2.6, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.hurt ? '#c0392b' : '#1b1b1b';
    ctx.beginPath(); ctx.arc(8, -27, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------
// 6. Enemies
// ---------------------------------------------------------------------

class Enemy {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.alive = true;
    this.t = Math.random() * 100;
    this.w = 28; this.h = 20;
  }
  box() { return { x: this.x - this.w / 2, y: this.y - this.h, w: this.w, h: this.h }; }
  update() { this.t++; }
  draw() {}
}

/** Rolling beetle: walks along the ground, turning at walls and ledges. */
class Beetle extends Enemy {
  constructor(x, y) { super(x, y); this.dir = -1; this.speed = 0.8; this.w = 30; this.h = 20; }

  update(level) {
    super.update();
    const nx = this.x + this.dir * this.speed;
    const ahead = level.floorY(nx + this.dir * 14, this.y, 16, 16);
    if (ahead === null || level.wall(nx + this.dir * 15, this.y, this.h)) {
      this.dir *= -1;
      return;
    }
    this.x = nx;
    const f = level.floorY(this.x, this.y, 16, 16);
    if (f !== null) this.y = f;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(-this.dir, 1);
    // Legs
    ctx.strokeStyle = '#2b2140'; ctx.lineWidth = 2.5;
    for (let i = 0; i < 3; i++) {
      const s = Math.sin(this.t * 0.3 + i * 2) * 3;
      ctx.beginPath(); ctx.moveTo(-8 + i * 8, -6); ctx.lineTo(-10 + i * 8 + s, 0); ctx.stroke();
    }
    // Shell
    ctx.fillStyle = '#5b3fc4';
    ctx.beginPath(); ctx.ellipse(0, -9, 15, 11, 0, Math.PI, 0); ctx.lineTo(15, -6); ctx.lineTo(-15, -6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#37238f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(0, -6); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(-6, -15, 4, 2.5, -0.4, 0, Math.PI * 2); ctx.fill();
    // Head + horn
    ctx.fillStyle = '#2b2140';
    ctx.beginPath(); ctx.arc(-16, -9, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8e2ff';
    ctx.beginPath(); ctx.moveTo(-19, -12); ctx.lineTo(-25, -18); ctx.lineTo(-17, -15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff5a5a';
    ctx.beginPath(); ctx.arc(-18, -9, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

/** Hovering drone: bobs up and down around its spawn height. */
class Drone extends Enemy {
  constructor(x, y) { super(x, y); this.baseY = y + 10; this.w = 28; this.h = 22; }

  update() {
    super.update();
    this.y = this.baseY + Math.sin(this.t * 0.045) * 26;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y - 11);
    // Rotor
    const rw = Math.abs(Math.cos(this.t * 0.5)) * 16 + 4;
    ctx.fillStyle = '#4b5563';
    ctx.fillRect(-1.5, -16, 3, 6);
    ctx.fillStyle = 'rgba(60,70,90,0.8)';
    ctx.beginPath(); ctx.ellipse(0, -16, rw, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    // Body
    ctx.fillStyle = '#9aa5b8';
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b7487';
    ctx.fillRect(-14, 1, 28, 4);
    // Eye
    const blink = Math.floor(this.t / 20) % 2;
    ctx.fillStyle = '#1f2430';
    ctx.beginPath(); ctx.arc(0, -1, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = blink ? '#ff4040' : '#ff9a40';
    ctx.beginPath(); ctx.arc(0, -1, 3, 0, Math.PI * 2); ctx.fill();
    // Thruster glow
    ctx.fillStyle = 'rgba(120,220,255,0.6)';
    ctx.beginPath(); ctx.ellipse(0, 11, 5, 2 + Math.sin(this.t * 0.6), 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------
// 7. HUD
// ---------------------------------------------------------------------

class HUD {
  draw(ctx, game) {
    ctx.save();
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const secs = Math.floor(game.time / 60);
    const timeStr = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const flash = game.crystals === 0 && Math.floor(game.time / 20) % 2;
    const rows = [
      ['SCORE', String(game.score).padStart(6, '0'), '#ffd23f'],
      ['TIME', timeStr, '#ffd23f'],
      ['CRYSTALS', String(game.crystals), flash ? '#ff4d4d' : '#ffd23f'],
    ];
    rows.forEach(([label, val, col], i) => {
      const y = 18 + i * 28;
      this.shadowText(ctx, label, 22, y, col);
      this.shadowText(ctx, val, 172, y, '#ffffff');
    });

    // Lives: a little fox head per life
    const ly = VIEW_H - 46;
    this.foxHead(ctx, 36, ly + 14);
    this.shadowText(ctx, `ZIPP × ${game.lives}`, 58, ly + 2, '#ffffff');

    if (game.sfx.muted) this.shadowText(ctx, 'MUTED (M)', VIEW_W - 150, 18, '#ffffff');
    ctx.restore();
  }

  shadowText(ctx, s, x, y, col) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(s, x + 2, y + 2);
    ctx.fillStyle = col;
    ctx.fillText(s, x, y);
  }

  foxHead(ctx, x, y) {
    ctx.fillStyle = '#f07a1a';
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 10, y - 4); ctx.lineTo(x - 9, y - 18); ctx.lineTo(x - 2, y - 9); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 10, y - 4); ctx.lineTo(x + 9, y - 18); ctx.lineTo(x + 2, y - 9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff3e0';
    ctx.beginPath(); ctx.ellipse(x, y + 4, 6, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath(); ctx.arc(x - 4, y - 2, 1.6, 0, Math.PI * 2); ctx.arc(x + 4, y - 2, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y + 2, 1.6, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------------------------------------------------------------------
// 8. Game — state machine, entities, main loop
// ---------------------------------------------------------------------

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = new Input();
    this.sfx = new Sound();
    this.hud = new HUD();
    this.camera = new Camera();
    this.state = 'title';       // title | playing | paused | gameover | complete
    this.levelIndex = 0;
    this.tick = 0;

    this.input.onAny = () => this.sfx.unlock();
    canvas.addEventListener('pointerdown', () => {
      this.sfx.unlock();
      canvas.focus();
      if (this.state === 'title' || this.state === 'gameover' || this.state === 'complete') this.input.pressed.add('start');
    });
    window.addEventListener('blur', () => { if (this.state === 'playing') this.state = 'paused'; });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadLevel(0);
  }

  // Crisp rendering on high-DPI screens; CSS scales the canvas to fit.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = VIEW_W * dpr;
    this.canvas.height = VIEW_H * dpr;
    this.dpr = dpr;
  }

  // Build entities for a level. Keeps score/lives (call newGame to reset them).
  loadLevel(i) {
    this.levelIndex = i;
    this.level = new Level(LEVELS[i]);
    const s = this.level.spawns;
    this.crystalItems = s.crystals.map(c => ({ ...c, taken: false }));
    this.enemies = s.enemies.map(e => (e.type === 'beetle' ? new Beetle(e.x, e.y) : new Drone(e.x, e.y)));
    this.springs = s.springs.map(p => ({ ...p, squash: 0 }));
    this.spikes = s.spikes;
    this.checkpoints = s.checkpoints.map(p => ({ ...p, on: false }));
    this.goal = s.goal ? { ...s.goal, spin: 0, hit: false } : null;
    this.respawn = { ...s.player };
    this.loose = [];          // scattered crystals after a hit
    this.particles = [];
    this.popups = [];
    this.time = 0;
    this.crystals = 0;
    this.controlsLocked = false;
    this.finishTimer = 0;
    this.player = new Player(this.respawn.x, this.respawn.y);
    this.camera.snap(this.player, this.level);
  }

  newGame() {
    this.score = 0;
    this.lives = 3;
    this.loadLevel(0);
    this.state = 'playing';
  }

  // ----- update -----
  update() {
    this.tick++;
    const inp = this.input;
    if (inp.hit('mute')) this.sfx.muted = !this.sfx.muted;

    switch (this.state) {
      case 'title':
        this.camera.x = (this.tick * 1.5) % (this.level.w - VIEW_W);
        if (inp.hit('start') || inp.hit('jump')) this.newGame();
        break;
      case 'paused':
        if (inp.hit('pause') || inp.hit('start')) this.state = 'playing';
        break;
      case 'gameover':
        if (inp.hit('start')) this.newGame();
        break;
      case 'complete':
        if (inp.hit('start')) {
          if (this.levelIndex + 1 < LEVELS.length) { this.loadLevel(this.levelIndex + 1); this.state = 'playing'; }
          else this.newGame();
        }
        break;
      case 'playing':
        if (inp.hit('pause')) { this.state = 'paused'; break; }
        this.updatePlaying();
        break;
    }
    inp.endStep();
  }

  updatePlaying() {
    const p = this.player, lvl = this.level;
    if (!this.controlsLocked && !p.dead) this.time++;

    p.update(this.input, lvl, this);
    for (const e of this.enemies) e.update(lvl);

    if (p.dead) {
      if (p.y > this.camera.y + VIEW_H + 200) this.loseLife();
      this.updateEffects();
      return;
    }

    // Fell into a pit
    if (p.y > lvl.h + 40) { this.killPlayer(); return; }

    const pb = p.box();

    // Crystals
    for (const c of this.crystalItems) {
      if (!c.taken && Math.abs(c.x - p.x) < 22 && Math.abs(c.y - (p.y - p.height / 2)) < 30) {
        c.taken = true; this.collect(c.x, c.y);
      }
    }
    for (const c of this.loose) {
      if (c.age > 30 && Math.abs(c.x - p.x) < 20 && Math.abs(c.y - (p.y - p.height / 2)) < 24) {
        c.dead = true; this.collect(c.x, c.y);
      }
    }

    // Springs
    for (const s of this.springs) {
      const sb = { x: s.x - 14, y: s.y - 16, w: 28, h: 16 };
      if (rectsOverlap(pb, sb) && (p.grounded || p.vy >= 0) && !p.loop) {
        if (p.grounded) p.vx = p.gsp * Math.cos(p.angle);
        p.grounded = false; p.vy = -PHYS.spring;
        p.y = s.y - 16; p.jumping = false; p.rolling = false; p.spindash = false; p.crouching = false; p.sprung = true;
        s.squash = 12; this.sfx.spring();
      }
      if (s.squash > 0) s.squash--;
    }

    // Spikes
    for (const k of this.spikes) {
      if (rectsOverlap(pb, { x: k.x + 3, y: k.y - 14, w: TILE - 6, h: 14 })) this.hurtPlayer(k.x + TILE / 2);
    }

    // Enemies
    for (const e of this.enemies) {
      if (!e.alive || !rectsOverlap(pb, e.box())) continue;
      if (p.attacking) {
        e.alive = false;
        this.addScore(100, e.x, e.y - 20);
        this.explode(e.x, e.y - 10);
        this.sfx.pop();
        if (!p.grounded && !p.loop) p.vy = p.vy > 0 ? -Math.max(p.vy, 5) : p.vy - 1;
      } else {
        this.hurtPlayer(e.x);
      }
    }
    this.enemies = this.enemies.filter(e => e.alive);

    // Checkpoints
    for (const c of this.checkpoints) {
      if (!c.on && p.x > c.x) { c.on = true; this.respawn = { x: c.x, y: c.y }; this.sfx.check(); }
    }

    // Goal
    const g = this.goal;
    if (g) {
      if (!g.hit && p.x >= g.x) {
        g.hit = true; this.controlsLocked = true; this.sfx.goal();
        this.addScore(0, g.x, g.y - 80);
      }
      if (g.hit) {
        g.spin += 0.3 * Math.max(0, 1 - this.finishTimer / 90);
        this.finishTimer++;
        if (this.finishTimer === 120) this.finishLevel();
      }
    }

    this.updateEffects();
    this.camera.update(p, lvl);
  }

  updateEffects() {
    const lvl = this.level;
    for (const c of this.loose) {
      c.age++;
      c.vy += 0.19;
      c.x += c.vx; c.y += c.vy;
      if (c.vy > 0 && lvl.solid(c.x, c.y + 6, c.y)) { c.y -= c.vy; c.vy *= -0.7; }
      if (lvl.solid(c.x + sign(c.vx) * 6, c.y)) c.vx *= -1;
      if (c.age > 260) c.dead = true;
    }
    this.loose = this.loose.filter(c => !c.dead);
    for (const q of this.particles) { q.x += q.vx; q.y += q.vy; q.vy += q.g; q.life--; }
    this.particles = this.particles.filter(q => q.life > 0);
    for (const s of this.popups) { s.y -= 0.6; s.life--; }
    this.popups = this.popups.filter(s => s.life > 0);
  }

  collect(x, y) {
    this.crystals++;
    this.score += 10;
    this.sfx.collect();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.particles.push({ x, y, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, g: 0, life: 16, color: '#bff6ff', size: 3 });
    }
  }

  addScore(n, x, y) {
    this.score += n;
    this.popups.push({ text: n ? `+${n}` : 'GOAL!', x, y, life: 60 });
  }

  hurtPlayer(fromX) {
    const p = this.player;
    if (p.invuln > 0 || p.dead) return;
    if (this.crystals > 0) {
      // Drop crystals in a fan; they can be grabbed back for a few seconds.
      const n = Math.min(this.crystals, 20);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * (0.3 + Math.floor(i / 2) * 0.28);
        const sp = 4 - (i > 10 ? 1.5 : 0);
        this.loose.push({ x: p.x, y: p.y - 16, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0 });
      }
      this.crystals = 0;
      this.sfx.scatter();
      p.knockback(fromX);
    } else {
      this.killPlayer();
    }
  }

  killPlayer() {
    const p = this.player;
    if (p.dead) return;
    p.dead = true; p.loop = null; p.rolling = false; p.spindash = false; p.hurt = true;
    p.vy = -8; p.invuln = 0;
    this.sfx.hit(); this.sfx.die();
  }

  loseLife() {
    this.lives--;
    if (this.lives <= 0) { this.state = 'gameover'; return; }
    this.crystals = 0;
    this.loose = [];
    this.player.reset(this.respawn.x, this.respawn.y);
    this.camera.snap(this.player, this.level);
  }

  finishLevel() {
    const secs = Math.floor(this.time / 60);
    this.timeBonus = Math.max(0, 300 - secs) * 20;
    this.crystalBonus = this.crystals * 50;
    this.score += this.timeBonus + this.crystalBonus;
    this.state = 'complete';
  }

  dust(x, y, n) {
    for (let i = 0; i < n; i++) {
      this.particles.push({ x: x + (Math.random() - 0.5) * 8, y: y - 2, vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 1.5, g: 0.05, life: 20, color: 'rgba(240,230,210,0.9)', size: 3 + Math.random() * 2 });
    }
  }

  explode(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, g: 0.08, life: 28, color: i % 2 ? '#ffd23f' : '#ff7b3a', size: 3 + Math.random() * 3 });
    }
  }

  // ----- render -----
  render() {
    const ctx = this.ctx, cam = this.camera;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.level.drawBackground(ctx, cam, this.tick);

    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
    this.level.drawLoops(ctx, cam);
    this.level.drawTiles(ctx, cam);
    this.drawObjects(ctx);
    for (const e of this.enemies) e.draw(ctx);
    if (this.state !== 'title') this.player.draw(ctx);
    for (const q of this.particles) {
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.font = `16px ${FONT}`;
    ctx.textAlign = 'center';
    for (const s of this.popups) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(s.text, s.x + 1, s.y + 1);
      ctx.fillStyle = '#ffffff'; ctx.fillText(s.text, s.x, s.y);
    }
    ctx.restore();

    if (this.state !== 'title') this.hud.draw(ctx, this);
    this.drawScreens(ctx);
  }

  drawObjects(ctx) {
    const t = this.tick;
    const cam = this.camera;
    const visible = x => x > cam.x - 64 && x < cam.x + VIEW_W + 64;

    // Spikes
    for (const k of this.spikes) {
      if (!visible(k.x)) continue;
      for (let i = 0; i < 4; i++) {
        const x = k.x + i * 8;
        ctx.fillStyle = '#d7dde8';
        ctx.beginPath(); ctx.moveTo(x, k.y); ctx.lineTo(x + 4, k.y - 16); ctx.lineTo(x + 8, k.y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#8c95a6';
        ctx.beginPath(); ctx.moveTo(x + 4, k.y - 16); ctx.lineTo(x + 8, k.y); ctx.lineTo(x + 5, k.y); ctx.closePath(); ctx.fill();
      }
    }

    // Springs
    for (const s of this.springs) {
      if (!visible(s.x)) continue;
      const h = s.squash > 0 ? 6 + (12 - s.squash) : 14;
      ctx.fillStyle = '#9aa5b8';
      ctx.fillRect(s.x - 12, s.y - 4, 24, 4);
      ctx.strokeStyle = '#6b7487'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) ctx.lineTo(s.x + (i % 2 ? 7 : -7), s.y - 4 - (h - 6) * (i / 4));
      ctx.stroke();
      ctx.fillStyle = '#e0465a';
      ctx.fillRect(s.x - 14, s.y - h - 2, 28, 6);
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(s.x - 14, s.y - h - 2, 28, 2);
    }

    // Crystals (fixed and loose)
    const drawCrystal = (x, y, phase) => {
      const sx = Math.abs(Math.cos(t * 0.06 + phase)) * 0.8 + 0.2;
      ctx.save(); ctx.translate(x, y); ctx.scale(sx, 1);
      ctx.fillStyle = '#35d0f0';
      ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, -2); ctx.lineTo(0, 11); ctx.lineTo(-7, -2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c8f6ff';
      ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, -2); ctx.lineTo(0, -2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1a8fb0';
      ctx.beginPath(); ctx.moveTo(0, 11); ctx.lineTo(-7, -2); ctx.lineTo(0, -2); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    for (const c of this.crystalItems) if (!c.taken && visible(c.x)) drawCrystal(c.x, c.y, c.x * 0.01);
    for (const c of this.loose) {
      if (c.age > 200 && Math.floor(c.age / 4) % 2) continue;
      drawCrystal(c.x, c.y, c.age * 0.1);
    }

    // Checkpoints
    for (const c of this.checkpoints) {
      if (!visible(c.x)) continue;
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(c.x - 2, c.y - 46, 4, 46);
      ctx.fillStyle = c.on ? '#4fe07a' : '#3fa9e8';
      ctx.beginPath(); ctx.arc(c.x, c.y - 50, 7, 0, Math.PI * 2); ctx.fill();
      if (c.on) {
        ctx.strokeStyle = 'rgba(79,224,122,0.5)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y - 50, 10 + Math.sin(t * 0.2) * 2, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Goal post: a spinning sign showing a bolt
    const g = this.goal;
    if (g && visible(g.x)) {
      ctx.fillStyle = '#6b7487';
      ctx.fillRect(g.x - 3, g.y - 70, 6, 70);
      const sx = g.hit ? Math.cos(g.spin) : 1;
      ctx.save(); ctx.translate(g.x, g.y - 92); ctx.scale(sx, 1);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e0465a'; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = g.hit && Math.cos(g.spin) < 0 ? '#f07a1a' : '#ffd23f';
      ctx.beginPath();
      ctx.moveTo(4, -16); ctx.lineTo(-8, 2); ctx.lineTo(0, 2); ctx.lineTo(-4, 16); ctx.lineTo(8, -2); ctx.lineTo(0, -2);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  drawScreens(ctx) {
    ctx.save();
    const center = (s, y, size, col = '#ffffff') => {
      ctx.font = `${size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(s, VIEW_W / 2 + 3, y + 3);
      ctx.fillStyle = col;
      ctx.fillText(s, VIEW_W / 2, y);
    };
    const dim = a => { ctx.fillStyle = `rgba(10,20,40,${a})`; ctx.fillRect(0, 0, VIEW_W, VIEW_H); };
    const blink = Math.floor(this.tick / 30) % 2 === 0;

    if (this.state === 'title') {
      dim(0.25);
      center('ZIPP DASH', 150, 84, '#ffd23f');
      center(this.level.name.toUpperCase(), 215, 22, '#ffffff');
      // Zipp running in place
      const demo = this.player;
      demo.x = VIEW_W / 2; demo.y = 330; demo.grounded = true; demo.gsp = 7; demo.anim++; demo.facing = 1;
      ctx.save(); ctx.translate(VIEW_W / 2, 330); ctx.scale(2.2, 2.2); ctx.translate(-VIEW_W / 2, -330);
      demo.angle = 0; demo.rolling = false; demo.draw(ctx);
      ctx.restore();
      if (blink) center('PRESS ENTER OR SPACE', 400, 26);
      center('ARROWS / WASD MOVE   SPACE JUMP   DOWN ROLL   DOWN + JUMP SPIN-DASH   P PAUSE', 470, 13, '#e6f4ff');
    } else if (this.state === 'paused') {
      dim(0.5);
      center('PAUSED', VIEW_H / 2 - 20, 64);
      center('PRESS P TO RESUME', VIEW_H / 2 + 40, 20);
    } else if (this.state === 'gameover') {
      dim(0.65);
      center('GAME OVER', VIEW_H / 2 - 30, 72, '#e0465a');
      center(`SCORE ${this.score}`, VIEW_H / 2 + 30, 24);
      if (blink) center('PRESS ENTER TO TRY AGAIN', VIEW_H / 2 + 80, 20);
    } else if (this.state === 'complete') {
      dim(0.55);
      const secs = Math.floor(this.time / 60);
      center('LEVEL COMPLETE', 140, 60, '#ffd23f');
      center(`TIME ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, 220, 22);
      center(`TIME BONUS  ${this.timeBonus}`, 262, 22);
      center(`CRYSTAL BONUS  ${this.crystalBonus}`, 300, 22);
      center(`SCORE  ${this.score}`, 350, 30, '#ffd23f');
      const next = this.levelIndex + 1 < LEVELS.length ? 'PRESS ENTER FOR THE NEXT LEVEL' : 'PRESS ENTER TO PLAY AGAIN';
      if (blink) center(next, 430, 20);
    }
    ctx.restore();
  }

  // ----- fixed-timestep loop -----
  start() {
    let last = performance.now(), acc = 0;
    const frame = now => {
      acc += Math.min(now - last, 250);   // avoid a spiral after a long pause
      last = now;
      while (acc >= STEP) { this.update(); acc -= STEP; }
      this.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

window.addEventListener('load', () => {
  const canvas = document.getElementById('game');
  const game = new Game(canvas);
  canvas.focus();
  game.start();
  window.zippGame = game;   // handy for debugging in the console
});
