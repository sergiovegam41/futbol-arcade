(function(){
  "use strict";

  /* =========================================================
     Setup
     ========================================================= */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  // Logical game coordinates stay fixed; the canvas is resized to fit the screen
  const W = 1600, H = 900;
  const wrap     = document.getElementById('canvas-wrap');
  const stageEl  = document.getElementById('stage');
  const canvas3d = document.getElementById('game3d');
  let viewW = 0, viewH = 0;   // css px the stage currently occupies

  // Declared up here on purpose: resizeCanvas() runs during start-up and calls
  // resize3d(), which would hit the temporal dead zone if these lived further
  // down with the rest of the 3D code.
  let view3d = false;
  const g3 = { ready:false, renderer:null, scene:null, camera:null,
               players:[], ball:null, camX:0, camZ:0,
               nets3d:[], crowd:null, flags:null };

  // The stage gets an EXPLICIT pixel size. Letting it size itself from the
  // canvas while the canvas sized itself from the stage was circular, and the
  // box collapsed to nothing — which is what blanked the pitch.
  function resizeCanvas(){
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    const aspect = W / H;
    let displayW = availW;
    let displayH = displayW / aspect;
    if(displayH > availH){
      displayH = availH;
      displayW = displayH * aspect;
    }
    if(!(displayW > 0) || !(displayH > 0)) return;
    viewW = displayW; viewH = displayH;

    if(stageEl){
      stageEl.style.width  = displayW + 'px';
      stageEl.style.height = displayH + 'px';
    }
    // capped like the WebGL side already was: a 4K laptop at dpr 3 was giving
    // the overlay canvas a 5760x3240 backing store, composited every frame
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    scaleX = dpr * (displayW / W);
    scaleY = dpr * (displayH / H);

    if(typeof resize3d === 'function') resize3d();
  }
  let scaleX = 1, scaleY = 1;
  // one layout per frame at most: dragging a window edge fires dozens of
  // resize events a second, and each one used to rebuild the grass cache
  let resizeRaf = 0;
  function queueResize(){
    if(resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; resizeCanvas(); });
  }
  window.addEventListener('resize', queueResize);
  window.addEventListener('orientationchange', queueResize);
  if(document.addEventListener) document.addEventListener('fullscreenchange', queueResize);
  resizeCanvas();
  setTimeout(resizeCanvas, 0);

  const overlay     = document.getElementById('overlay');
  const startBtn    = document.getElementById('start-btn');
  const score1El    = document.getElementById('score1');
  const score2El    = document.getElementById('score2');
  const timeEl      = document.getElementById('time');
  const statusEl    = document.getElementById('status');
  const chip1       = document.getElementById('chip1');
  const chip2       = document.getElementById('chip2');
  const poss1El     = document.getElementById('poss1');
  const poss2El     = document.getElementById('poss2');
  const finalScoreEl= document.getElementById('final-score');
  const soundBtn    = document.getElementById('sound-btn');
  const pauseBtn    = document.getElementById('pause-btn');
  const fsBtn       = document.getElementById('fs-btn');
  const lenSeg      = document.getElementById('len-seg');
  const pauseMenu   = document.getElementById('pause-menu');
  const pauseViewBtn  = document.getElementById('pause-view');
  const pauseSoundBtn = document.getElementById('pause-sound');
  const settingsBtn = document.getElementById('settings-btn');
  const mobileNote  = document.getElementById('mobile-note');
  // honour the OS "reduce motion" preference: no shake, no confetti
  const REDUCE_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* =========================================================
     Pitch geometry
     ========================================================= */
  const FIELD_MARGIN      = 46;
  const GOAL_WIDTH        = 220;
  const GOAL_DEPTH        = 62;   // ~2 m against a 7.3 m mouth, like a real goal
  const PENALTY_BOX_DEPTH = 150;
  const PENALTY_BOX_WIDTH = GOAL_WIDTH + 200;
  const GOAL_AREA_DEPTH   = 62;
  const GOAL_AREA_WIDTH   = GOAL_WIDTH + 70;
  const halfW = W / 2;
  const topGoalY = H/2 - GOAL_WIDTH/2;
  const botGoalY = H/2 + GOAL_WIDTH/2;

  /* =========================================================
     Match state
     ========================================================= */
  let matchLength = 180;
  let matchTime   = matchLength;
  let running     = false;
  let paused      = false;
  let lastTs      = null;
  let kickoffTimer = 0;          // brief freeze after a goal / at kickoff
  let celebration  = null;       // {text, color, t}
  let shake        = 0;
  let score1 = 0, score2 = 0;
  // match statistics for the result card; index 0 = team1, 1 = team2
  const stats = { shots:[0,0], onTarget:[0,0], saves:[0,0], steals:[0,0], posts:[0,0], goals:[] };
  function resetStats(){
    for(const k of ['shots','onTarget','saves','steals','posts']){ stats[k][0] = 0; stats[k][1] = 0; }
    stats.goals.length = 0;
  }
  let possession = [0, 0];       // accumulated seconds of possession
  let lastTouchTeam = null;
  let ballOwner     = null;   // the player who currently owns the ball

  /* =========================================================
     Input
     ========================================================= */
  const keys = {};
  const capturedKeys = ['Space','Enter','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
                        'KeyQ','KeyM','KeyE','Period','KeyP',
                        'KeyF','KeyR','Slash','Comma','KeyC'];
  window.addEventListener('keydown', e => {
    if(capturedKeys.includes(e.code)) e.preventDefault();
    if(e.repeat){ keys[e.code] = true; return; }
    keys[e.code] = true;
    if(e.code === 'KeyN'){ ensureAudio(); toggleMute(); if(paused) refreshPauseLabels(); return; }
    // the pause keys work with the pause menu up (they close it)
    if(running && (e.code === 'KeyP' || e.code === 'Escape')){ togglePause(); return; }
    // with a menu up the keys drive the menu and nothing else
    if(uiOpen()){
      if(e.code === 'ArrowUp')    { uiMove(-1,  0); return; }
      if(e.code === 'ArrowDown')  { uiMove( 1,  0); return; }
      if(e.code === 'ArrowLeft')  { uiMove( 0, -1); return; }
      if(e.code === 'ArrowRight') { uiMove( 0,  1); return; }
      if(e.code === 'Enter' || e.code === 'Space'){ uiActivate(); return; }
      return;
    }
    if(skipEnding()) return;
    if(intro.active){ skipIntro(); sfx.whistle(); return; }
    if(replay.active || goalAction > 0){ if(skipCelebration()) return; }
    if(e.code === 'KeyQ') manualSwitch(team1);
    if(e.code === 'KeyM') manualSwitch(team2);
    if(e.code === 'KeyP' || e.code === 'Escape') togglePause();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  function cssVar(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* =========================================================
     Audio (tiny WebAudio blips, no assets)
     ========================================================= */
  // Everything goes through one master gain, split into an effects bus and a
  // crowd bus. That is what makes mute a fade instead of a cut, lets the crowd
  // duck under a whistle, and gives the whole mix one knob.
  let audioCtx = null, soundOn = true;
  let master = null, sfxBus = null, ambBus = null, noiseBuf = null;
  function ensureAudio(){
    if(!audioCtx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      audioCtx = new AC();
      master = audioCtx.createGain(); master.gain.value = soundOn ? 1 : 0;
      master.connect(audioCtx.destination);
      sfxBus = audioCtx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
      ambBus = audioCtx.createGain(); ambBus.gain.value = 1.0; ambBus.connect(master);
      noiseBuf = makeNoiseBuffer(audioCtx, 4);   // shared by every noise voice
    }
    if(audioCtx.state === 'suspended') audioCtx.resume();
  }
  // browsers only let audio start from a gesture; any of these counts
  ['pointerdown', 'keydown', 'gamepadconnected'].forEach(ev =>
    window.addEventListener(ev, ensureAudio, { passive: true }));

  // A tone. The 6 ms attack is the whole difference between a note and a
  // click: a gain stepping straight to 0.06 on a square wave IS a click, and
  // every kick used to have one. `when` is an offset on the AUDIO clock, so
  // arpeggios never drift the way setTimeout ones did under load.
  function blip(freq, dur, type, gain, when, bus){
    if(!soundOn || !audioCtx) return;
    const t = audioCtx.currentTime + (when || 0);
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.08, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus || sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  // A filtered burst of noise: the transient layer every impact was missing.
  // A boot on a ball is not a tone, it is a thud with a bit of scuff on it.
  function noise(dur, freq, q, gain, when, type, bus){
    if(!soundOn || !audioCtx || !noiseBuf) return;
    const t = audioCtx.currentTime + (when || 0);
    const s = audioCtx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const f = audioCtx.createBiquadFilter();
    f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(bus || sfxBus);
    s.start(t, Math.random() * 3);
    s.stop(t + dur + 0.02);
  }
  const jit = (k) => 1 - k + Math.random() * 2 * k;   // ±k pitch jitter: no two alike

  const sfx = {
    // boot transient + body thump, both scaled by power and slightly detuned
    kick(power){
      const p = clamp01((power || 8) / 24), j = jit(0.06);
      noise(0.045, (900 + p * 1400) * j, 1.2, 0.05 + p * 0.05);
      blip((70 + p * 55) * j, 0.11 + p * 0.05, 'sine', 0.07 + p * 0.06);
    },
    pass(){
      noise(0.03, 1100 * jit(0.05), 1.4, 0.035);
      blip(300 * jit(0.03), 0.06, 'triangle', 0.04);
    },
    wall(){ blip(120 * jit(0.04), 0.06, 'sine', 0.04); noise(0.03, 700, 1, 0.03); },
    // the woodwork: two ringing partials, a scuff, and the crowd's groan
    post(){
      blip(1180, 0.5, 'sine', 0.12); blip(1790, 0.35, 'sine', 0.05);
      noise(0.04, 3000, 2, 0.05);
      crowdOoh();
    },
    slide(){ noise(0.34, 520, 0.8, 0.075, 0, 'lowpass'); },   // grass scrape
    save(){ noise(0.07, 1500, 0.9, 0.08); blip(240, 0.10, 'sawtooth', 0.04); },
    goal(){
      [0, 0.12, 0.24, 0.42].forEach((d, i) => blip([523, 659, 784, 1047][i], 0.28, 'square', 0.07, d));
      duckCrowd(0.35, 0.6);
    },
    // three short peeps for a kick-off, one long one for the end
    whistle(kind){
      const n = kind === 'full' ? 1 : 3, len = kind === 'full' ? 0.9 : 0.16;
      for(let i = 0; i < n; i++){
        blip(1400, len, 'sine', 0.05, i * 0.15);
        blip(2090, len, 'sine', 0.02, i * 0.15);
      }
      duckCrowd(0.4, n * 0.15 + len);
    },
    // picking up a power used to play the GOAL fanfare — an outright mis-cue
    pickup(){ [0, 0.05, 0.10].forEach((d, i) => blip([784, 1047, 1319][i], 0.12, 'triangle', 0.05, d)); },
    sweetIn(){  blip(880, 0.05, 'square', 0.028); },
    sweetOut(){ blip(300, 0.06, 'square', 0.022); },
    uiMove(){ blip(660, 0.035, 'square', 0.022); },
    uiOk(){   blip(520, 0.05, 'square', 0.03); blip(780, 0.07, 'square', 0.028, 0.045); }
  };

  // pull the crowd down for a moment so a whistle or a fanfare sits on top
  function duckCrowd(amount, secs){
    if(!audioCtx || !ambBus) return;
    const t = audioCtx.currentTime;
    ambBus.gain.cancelScheduledValues(t);
    ambBus.gain.setTargetAtTime(amount, t, 0.03);
    ambBus.gain.setTargetAtTime(1, t + secs, 0.25);
  }
  // the near-miss groan: a band swept up and back down over half a second
  function crowdOoh(){
    if(!soundOn || !audioCtx || !noiseBuf) return;
    const t = audioCtx.currentTime;
    const s = audioCtx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1100, t + 0.22);
    f.frequency.exponentialRampToValueAtTime(600, t + 0.6);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    s.connect(f).connect(g).connect(ambBus);
    s.start(t, Math.random() * 3); s.stop(t + 0.7);
  }

  function toggleMute(){
    soundOn = !soundOn;
    if(master) master.gain.setTargetAtTime(soundOn ? 1 : 0, audioCtx.currentTime, 0.04);
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.title = soundOn ? 'Silenciar (N o Back)' : 'Activar sonido (N o Back)';
    soundBtn.setAttribute('aria-label', soundBtn.title);
    flashStatus(soundOn ? 'Sonido activado' : 'Silencio');
    saveSettings();
  }
  soundBtn.title = 'Silenciar (N o Back)';
  soundBtn.addEventListener('click', () => { ensureAudio(); toggleMute(); });

  /* =========================================================
     Crowd ambience
     Synthesised, not sampled. A recorded crowd would be a megabyte of audio to
     download, licence and cache, and it would loop audibly; this is a few lines
     of Web Audio that never repeats and weighs nothing.

     Two layers: a low murmur that is always there, and a brighter "oooh" layer
     that only opens up as the ball gets near a goal. Excitement drives the gain
     and the filter, so the ground lifts when an attack builds and settles back
     when it breaks down.
     ========================================================= */
  const amb = { on:false, noise:null, murmur:null, murmurGain:null,
                cheer:null, cheerGain:null, excite:0, target:0 };

  function makeNoiseBuffer(ctx, secs){
    const len = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // brown-ish noise: closer to a crowd than white, which hisses
    let last = 0;
    for(let i = 0; i < len; i++){
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  function startAmbience(){
    if(amb.on || !audioCtx) return;
    const buf = noiseBuf;

    // layer 1: the constant murmur
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.6;
    const g1 = audioCtx.createGain();
    g1.gain.value = 0;
    src.connect(lp).connect(g1).connect(ambBus);
    src.start();

    // layer 2: the excited one, brighter and only audible when something is on
    const src2 = audioCtx.createBufferSource();
    src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 1.27;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.9;
    const g2 = audioCtx.createGain();
    g2.gain.value = 0;
    src2.connect(bp).connect(g2).connect(ambBus);
    src2.start();

    amb.on = true;
    amb.murmur = lp; amb.murmurGain = g1;
    amb.cheer = bp;  amb.cheerGain = g2;
  }

  // How interesting is the game right now? Mostly: how close is the ball to
  // either goal, plus a kick whenever something actually happens.
  function ambienceTarget(){
    if(!running || paused) return 0.12;
    const dLeft  = Math.hypot(ball.x - FIELD_MARGIN, ball.y - H/2);
    const dRight = Math.hypot(ball.x - (W - FIELD_MARGIN), ball.y - H/2);
    const near   = Math.min(dLeft, dRight);
    // 0 out by the halfway line, 1 in the six-yard box
    const prox = clamp01((760 - near) / 620);
    const shot = ball.shotTimer > 0 ? 0.25 : 0;
    return Math.min(1, 0.18 + prox * 0.75 + shot);
  }

  const AMB_DUCK = 0.20;   // how loud the crowd is while the ball is in play

  // The ground is background, not a soundtrack. While the ball is in play it
  // ducks right down under the kicks and the whistle — you should barely notice
  // it is there. It only opens up when there is something to open up for: a
  // goal, the replay of it, the celebration.
  function ambienceVolume(){
    const loud = goalAction > 0 || replay.active || celebration || crowdCheerT > 0;
    return loud ? 1 : AMB_DUCK;
  }

  function updateAmbience(dt){
    if(!amb.on || !audioCtx) return;
    if(!soundOn){
      amb.murmurGain.gain.value = 0;
      amb.cheerGain.gain.value = 0;
      return;
    }
    amb.target = Math.max(ambienceTarget(), crowdCheerT > 0 ? 1 : 0);
    // rises quickly, falls slowly — a crowd goes up fast and takes its time
    const rate = amb.target > amb.excite ? 2.6 : 0.7;
    amb.excite += (amb.target - amb.excite) * Math.min(1, dt * rate);

    const vol = ambienceVolume();
    const e   = amb.excite;
    amb.murmurGain.gain.value = (0.035 + e * 0.05) * vol;
    amb.cheerGain.gain.value  = Math.max(0, e - 0.35) * 0.115 * vol;
    amb.murmur.frequency.value = 480 + e * 340;
    amb.cheer.frequency.value  = 820 + e * 620;
  }

  // the roar when one goes in
  function crowdRoar(){
    if(!soundOn || !audioCtx) return;
    const t = audioCtx.currentTime;
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;   // no 125k-sample synth on the goal frame
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
    bp.Q.value = 0.8;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30, t + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    src.connect(bp).connect(g).connect(ambBus);
    src.start(t, Math.random() * 1.2);
    src.stop(t + 2.6);
  }

  /* =========================================================
     Teams — GK + 2 DEF + 2 FWD
     ========================================================= */
  const SQUAD = [
    { role:'DEF', slot:-1, number:4  },
    { role:'DEF', slot: 1, number:5  },
    { role:'MID', slot:-1, number:8  },
    { role:'MID', slot: 1, number:6  },
    { role:'FWD', slot:-1, number:9  },
    { role:'FWD', slot: 1, number:11 }
  ];
  const SQUAD_TOTAL = 2 * (SQUAD.length + 1);   // both sides, keepers included

  // slot: -1 = upper lane, +1 = lower lane
  function formationHome(role, slot, side){
    let x, y;
    const lane = 165;
    switch(role){
      case 'GK':  x = FIELD_MARGIN + 30;                                  y = H/2; break;
      case 'DEF': x = FIELD_MARGIN + (halfW - FIELD_MARGIN) * 0.30;       y = H/2 + slot * lane; break;
      case 'MID': x = FIELD_MARGIN + (halfW - FIELD_MARGIN) * 0.62;       y = H/2 + slot * (lane + 60); break;
      case 'FWD': x = FIELD_MARGIN + (halfW - FIELD_MARGIN) * 0.92;       y = H/2 + slot * (lane - 20); break;
    }
    if(side === 'right') x = W - x;
    return {x, y};
  }

  function makePlayer(role, slot, side, color, number){
    const home = formationHome(role, slot, side);
    return {
      x: home.x, y: home.y, vx:0, vy:0,
      color, side, role, slot, number,
      radius: role === 'GK' ? 15 : 16,
      speed:  role === 'GK' ? 2.6 : 2.95,
      sprintMult: 1.62,
      kickCooldown: 0,
      lungeTimer: 0,
      lungeCd: 0,
      beatenTimer: 0,
      slideTimer: 0,
      downTimer: 0,
      slideDir: null,
      runPhase: Math.random() * 6.28,
      hairStyle: null, hairColor: null,   // assigned once the squad is built
      home,
      facing: { x: side === 'left' ? 1 : -1, y: 0 }
    };
  }

  function makeTeam(side, color, isP1, name){
    return {
      side, color, isP1, name,
      controlledIndex: 0,
      manualLock: 0,
      switchHold: 0,
      claimHold: 0,
      switchCursor: 0,
      chainTimer: 0,
      powerup: null,
      powerupTimer: 0,
      curveAim: 0,
      cpu: null,
      modArmed: false,
      chargeKind: null,
      containing: false,
      powerHeld: false,
      advance: 0,        // smoothed team-wide push forward(+) / drop back(-)
      teamSprint: 0,     // 0..1 — how hard the WHOLE team is running right now
      charge: 0,         // charged-shot meter of the controlled player
      chargeHeld: false,
      passCooldown: 0,
      passHeld: false,
      gk: makePlayer('GK', 0, side, color, 1),
      outfield: SQUAD.map(s => makePlayer(s.role, s.slot, side, color, s.number))
    };
  }

  const team1 = makeTeam('left',  cssVar('--p1'), true,  'Azul');
  const team2 = makeTeam('right', cssVar('--p2'), false, 'Rojo');
  const teams = [team1, team2];

  // Give every player a look of their own. Styles are dealt out so no two
  // players in the same side share one, and the pairing is fixed per match.
  // Hairstyles are off until real art replaces the drawn shapes. Flip this to
  // true to bring the placeholder styles back.
  const HAIR_ENABLED = true;    // styles are assigned; only the 3D view draws them

  function assignHair(){   // called once below, after HAIR_STYLES exists
    if(!HAIR_ENABLED) return;
    teams.forEach((team, ti) => {
      const styles = HAIR_STYLES.slice();
      const squad = [team.gk].concat(team.outfield);
      squad.forEach((pl, i) => {
        const pick = (i * 3 + ti * 5) % styles.length;
        pl.hairStyle = styles.splice(pick, 1)[0];
        pl.hairColor = HAIR_COLORS[(i * 2 + ti * 3) % HAIR_COLORS.length];
      });
    });
  }

  let rosterCache = null;   // the roster never changes after startup
  function allPlayers(){
    if(!rosterCache) rosterCache = [team1.gk].concat(team1.outfield, [team2.gk], team2.outfield);
    return rosterCache;
  }

  const ball = {
    x: W/2, y: H/2, vx:0, vy:0, radius:10,
    friction:0.986, spin:0, trail:[],
    // a real strike, as opposed to a dribble touch: this is what the keeper reads
    shotTimer:0, shotSide:null, shotId:0, heldBy:null, shotPower:0, shotSweet:false, shotFire:false, shotDist:0,
    releaseGuard:0, releaseSide:null, curve:0, ownerLock:0, stealGuard:0,
    z:0, vz:0, loftTeam:null
  };

  /* =========================================================
     Particles (grass, sparks, confetti)
     ========================================================= */
  /* =========================================================
     Squad names
     Deliberately daft. They are what turns "el 9" into somebody you shout at,
     and they are what the goal banner announces.
     ========================================================= */
  const NAME_POOL = [
    'KK', 'Penélope', 'Chuchito', 'El Tanque', 'Nacho', 'Bigotes',
    'Tofu', 'La Foca', 'Pepe Botella', 'Mamá Luchi', 'Cucho', 'Tuti',
    'Chespirito', 'Lomito', 'Pelusa', 'Don Cangrejo', 'Rocío', 'Pantufla',
    'Bombón', 'El Pulpo', 'Moco', 'Yiyo', 'Chancla', 'Pipo'
  ];
  const GK_NAMES = ['Manotas', 'El Muro', 'Guantes', 'Palomita', 'Tapón', 'Cocodrilo'];

  function assignNames(){
    const pool = NAME_POOL.slice();
    const gkPool = GK_NAMES.slice();
    for(const team of teams){
      team.gk.name = gkPool.splice(Math.floor(Math.random() * gkPool.length), 1)[0] || 'Arquero';
      for(const pl of team.outfield){
        pl.name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] || ('#' + pl.number);
      }
    }
  }

  /* =========================================================
     Goal nets — Verlet cloth
     The first version could only slide along one axis, never hung under its own
     weight and the ball passed straight through it. This is a real cloth, the
     same technique as three.js's own cloth example: particles integrated with
     Verlet, held together by distance constraints, plus gravity and a sphere
     collision against the ball.

     Deliberately NOT a physics engine. Ammo.js soft bodies would do this too,
     but it is ~1.5 MB of wasm for one net on a game that currently ships zero
     dependencies beyond three.js itself.

     The grid is one sheet wrapped in a U: columns walk in along the left side
     net, across the back, and out along the right side, so a single cloth
     covers all three panels and the corners stay stitched. It is simulated in
     PITCH units in the goal's own space, so both views can read it:
        u = depth into the goal (0 at the line)
        v = height (0 on the grass)
        w = across the mouth (0 at the top post)
     ========================================================= */
  const GOAL_H_PX   = 73;              // goal height, in pitch units (3:1 like a real one)
  const NET_SIDE_C  = 4;               // columns down each side panel
  const NET_BACK_C  = 15;              // columns across the back
  const NET_COLS    = NET_SIDE_C * 2 + NET_BACK_C;
  const NET_ROWS    = 9;
  const NET_GRAV    = 520;             // px/s^2, heavier than air so it hangs
  const NET_DAMP    = 0.986;
  const NET_ITERS   = 4;               // constraint relaxation passes
  const NET_SLACK   = 1.06;            // nets are not taut; a little slack sags nicely

  // rest position of node (c, r) in goal space
  function netRest(c, r){
    const v = GOAL_H_PX * (1 - r / (NET_ROWS - 1));
    let u, w;
    if(c < NET_SIDE_C){                                   // left side panel
      u = GOAL_DEPTH * (c / NET_SIDE_C);
      w = 0;
    } else if(c < NET_SIDE_C + NET_BACK_C){               // the back
      u = GOAL_DEPTH;
      w = GOAL_WIDTH * ((c - NET_SIDE_C) / (NET_BACK_C - 1));
    } else {                                              // right side panel
      u = GOAL_DEPTH * (1 - (c - NET_SIDE_C - NET_BACK_C + 1) / NET_SIDE_C);
      w = GOAL_WIDTH;
    }
    return { u, v, w };
  }

  function makeNet(){
    const n = NET_COLS * NET_ROWS;
    const net = {
      u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n),
      pu: new Float32Array(n), pv: new Float32Array(n), pw: new Float32Array(n),
      ru: new Float32Array(n), rv: new Float32Array(n), rw: new Float32Array(n),
      pin: new Uint8Array(n),
      restH: new Float32Array(n), restV: new Float32Array(n),
      energy: 0
    };
    for(let r = 0; r < NET_ROWS; r++){
      for(let c = 0; c < NET_COLS; c++){
        const i = r * NET_COLS + c;
        const p = netRest(c, r);
        net.u[i] = net.pu[i] = net.ru[i] = p.u;
        net.v[i] = net.pv[i] = net.rv[i] = p.v;
        net.w[i] = net.pw[i] = net.rw[i] = p.w;
        // pinned to the frame: the crossbar, the two posts, and the ground line
        net.pin[i] = (r === 0 || r === NET_ROWS - 1 ||
                      c === 0 || c === NET_COLS - 1) ? 1 : 0;
      }
    }
    // rest lengths, with slack so the sheet hangs instead of being a drum skin
    for(let r = 0; r < NET_ROWS; r++){
      for(let c = 0; c < NET_COLS; c++){
        const i = r * NET_COLS + c;
        if(c + 1 < NET_COLS) net.restH[i] = dist3(net, i, i + 1) * NET_SLACK;
        if(r + 1 < NET_ROWS) net.restV[i] = dist3(net, i, i + NET_COLS) * NET_SLACK;
      }
    }
    return net;
  }

  function dist3(net, a, b){
    return Math.hypot(net.u[a] - net.u[b], net.v[a] - net.v[b], net.w[a] - net.w[b]);
  }

  const nets = { left: makeNet(), right: makeNet() };

  function relaxPair(net, a, b, rest){
    if(!rest) return;
    let du = net.u[b] - net.u[a], dv = net.v[b] - net.v[a], dw = net.w[b] - net.w[a];
    const d = Math.hypot(du, dv, dw) || 1e-6;
    // only pull when stretched: a net can go slack but not stretch like rubber
    if(d <= rest) return;
    const k = ((d - rest) / d) * 0.5;
    du *= k; dv *= k; dw *= k;
    const pa = net.pin[a], pb = net.pin[b];
    if(!pa && !pb){
      net.u[a] += du; net.v[a] += dv; net.w[a] += dw;
      net.u[b] -= du; net.v[b] -= dv; net.w[b] -= dw;
    } else if(!pa){
      net.u[a] += du * 2; net.v[a] += dv * 2; net.w[a] += dw * 2;
    } else if(!pb){
      net.u[b] -= du * 2; net.v[b] -= dv * 2; net.w[b] -= dw * 2;
    }
  }

  // where the ball is, in this goal's own space
  function ballInGoalSpace(side){
    const u = side === 'left' ? (FIELD_MARGIN - ball.x) : (ball.x - (W - FIELD_MARGIN));
    return { u, v: Math.max(0, ball.z), w: ball.y - topGoalY };
  }

  function updateNets(dt){
    const step = Math.min(dt, 1/40);
    for(const side of ['left', 'right']){
      const net = nets[side];
      const b = ballInGoalSpace(side);
      // the ball only matters while it is in or around the goal
      const touching = b.u > -ball.radius * 2 && b.u < GOAL_DEPTH + 40 &&
                       b.w > -40 && b.w < GOAL_WIDTH + 40 && b.v < GOAL_H_PX + 30;
      if(net.energy <= 0 && !touching) continue;

      const g = NET_GRAV * step * step;
      for(let i = 0; i < net.u.length; i++){
        if(net.pin[i]) continue;
        const nu = net.u[i] + (net.u[i] - net.pu[i]) * NET_DAMP;
        const nv = net.v[i] + (net.v[i] - net.pv[i]) * NET_DAMP - g;
        const nw = net.w[i] + (net.w[i] - net.pw[i]) * NET_DAMP;
        net.pu[i] = net.u[i]; net.pv[i] = net.v[i]; net.pw[i] = net.w[i];
        net.u[i] = nu; net.v[i] = nv; net.w[i] = nw;
      }

      for(let it = 0; it < NET_ITERS; it++){
        for(let r = 0; r < NET_ROWS; r++){
          for(let c = 0; c < NET_COLS; c++){
            const i = r * NET_COLS + c;
            if(c + 1 < NET_COLS) relaxPair(net, i, i + 1, net.restH[i]);
            if(r + 1 < NET_ROWS) relaxPair(net, i, i + NET_COLS, net.restV[i]);
          }
        }
        // the ball is a hard sphere: push every node out of it
        if(touching){
          const rad = ball.radius + 2;
          for(let i = 0; i < net.u.length; i++){
            if(net.pin[i]) continue;
            const du = net.u[i] - b.u, dv = net.v[i] - b.v, dw = net.w[i] - b.w;
            const d = Math.hypot(du, dv, dw);
            if(d < rad && d > 1e-4){
              const k = (rad - d) / d;
              net.u[i] += du * k; net.v[i] += dv * k; net.w[i] += dw * k;
            }
          }
        }
        // and it can never be pushed back out through the goal line
        for(let i = 0; i < net.u.length; i++){
          if(!net.pin[i] && net.u[i] < 0) net.u[i] = 0;
        }
      }

      // Per-node, because the threshold has to mean the same thing whatever the
      // grid size. Below this the cloth is visually still, so we stop paying for
      // it and freeze the velocity to kill the last of the drift.
      let moving = 0;
      for(let i = 0; i < net.u.length; i++){
        moving += Math.abs(net.u[i] - net.pu[i]) + Math.abs(net.v[i] - net.pv[i]) +
                  Math.abs(net.w[i] - net.pw[i]);
      }
      if(!touching && moving / net.u.length < 0.02){
        for(let i = 0; i < net.u.length; i++){
          net.pu[i] = net.u[i]; net.pv[i] = net.v[i]; net.pw[i] = net.w[i];
        }
        net.energy = 0;
      } else {
        net.energy = 1;
      }
    }
  }

  // an impulse straight into the cloth, used the moment a goal is given
  function netImpulse(side, y, z, power){
    const net = nets[side];
    if(!net) return;
    const tw = y - topGoalY, tv = Math.max(0, z);
    const hit = Math.max(0.5, Math.min(power / 11, 2.6));
    for(let i = 0; i < net.u.length; i++){
      if(net.pin[i]) continue;
      const d = Math.hypot(net.w[i] - tw, net.v[i] - tv);
      const falloff = Math.exp(-(d * d) / 5200);
      net.pu[i] -= hit * 9 * falloff;        // Verlet: move the PREVIOUS point back
    }
    net.energy = 1;
  }

  function resetNets(){
    for(const side of ['left', 'right']){
      const net = nets[side];
      for(let i = 0; i < net.u.length; i++){
        net.u[i] = net.pu[i] = net.ru[i];
        net.v[i] = net.pv[i] = net.rv[i];
        net.w[i] = net.pw[i] = net.rw[i];
      }
      net.energy = 0;
    }
    if(g3.nets3d) for(const n of g3.nets3d) n.uploaded = false;
  }

  // how far the back of the net is pushed out at a given point across the mouth,
  // in pitch px — this is all the top-down view needs
  function netBulgeAt(side, yPitch){
    const net = nets[side];
    const f = Math.max(0, Math.min(1, (yPitch - topGoalY) / GOAL_WIDTH));
    const cf = NET_SIDE_C + f * (NET_BACK_C - 1);
    const c0 = Math.floor(cf), c1 = Math.min(NET_SIDE_C + NET_BACK_C - 1, c0 + 1);
    const t = cf - c0;
    const row = Math.floor(NET_ROWS / 2);
    const i0 = row * NET_COLS + c0, i1 = row * NET_COLS + c1;
    const d0 = net.u[i0] - net.ru[i0], d1 = net.u[i1] - net.ru[i1];
    return d0 + (d1 - d0) * t;
  }

  /* =========================================================
     Power-ups
     Rare pickups that drop on the pitch. Deliberately scarce: one on the
     grass at a time and a hard cap per match, so they stay a moment rather
     than a mechanic you can farm.
     ========================================================= */
  const PU_MAX_ON_PITCH   = 1;
  const PU_MAX_PER_MATCH  = 3;
  const PU_FIRST_DELAY    = 35;   // s before the first one can appear
  const PU_INTERVAL_MIN   = 30;   // s between attempts afterwards
  const PU_INTERVAL_MAX   = 55;
  const PU_LIFETIME       = 14;   // s it waits on the pitch before fading
  const PU_HOLD_TIME      = 15;   // s you may hold it before it burns out

  const powerups = [];
  let puSpawned = 0;
  let puTimer   = PU_FIRST_DELAY;

  function resetPowerups(){
    powerups.length = 0;
    puSpawned = 0;
    puTimer = PU_FIRST_DELAY;
    for(const t of teams){ t.powerup = null; t.powerupTimer = 0; }
  }

  function updatePowerups(dt){
    // a stored power does not keep forever
    for(const t of teams){
      if(t.powerup && t.powerupTimer > 0){
        t.powerupTimer -= dt;
        if(t.powerupTimer <= 0){
          t.powerup = null;
          t.powerupTimer = 0;
          flashStatus('El poder de ' + t.name + ' se apagó');
        }
      }
    }
    puTimer -= dt;
    if(puTimer <= 0 && powerups.length < PU_MAX_ON_PITCH && puSpawned < PU_MAX_PER_MATCH){
      // drop it around the middle third so neither side simply owns it
      powerups.push({
        kind: 'fire',
        x: W/2 + (Math.random() - 0.5) * (W * 0.38),
        y: FIELD_MARGIN + 90 + Math.random() * (H - FIELD_MARGIN*2 - 180),
        life: PU_LIFETIME,
        phase: Math.random() * 6.28,
        radius: 21
      });
      puSpawned++;
      puTimer = PU_INTERVAL_MIN + Math.random() * (PU_INTERVAL_MAX - PU_INTERVAL_MIN);
      flashStatus('¡Apareció un poder en el campo!');
    }

    for(let i = powerups.length - 1; i >= 0; i--){
      const pu = powerups[i];
      pu.life -= dt;
      pu.phase += dt * 3;
      if(pu.life <= 0){ powerups.splice(i, 1); continue; }
      if(Math.random() < 0.5){
        spawnParticles(pu.x + (Math.random()-0.5)*16, pu.y + 6, 1, {
          angle: -Math.PI/2, spread: 0.8, speed: 1.1, life: 0.5, size: 3,
          color: Math.random() < 0.5 ? 'rgba(255,170,60,0.9)' : 'rgba(255,90,40,0.85)'
        });
      }
      // first player to reach it takes it for their team
      for(const team of teams){
        for(const pl of team.outfield){
          if(Math.hypot(pl.x - pu.x, pl.y - pu.y) < pl.radius + pu.radius){
            team.powerup = pu.kind;
            team.powerupTimer = PU_HOLD_TIME;
            powerups.splice(i, 1);
            sfx.pickup();
            shake = Math.max(shake, 8);
            spawnParticles(pu.x, pu.y, 26, {
              speed: 4, life: 0.7, size: 4, gravity: 0.03,
              color: 'rgba(255,150,50,0.95)'
            });
            flashStatus('¡' + team.name + ' tiene TIRO DE FUEGO!');
            return;
          }
        }
      }
    }
  }

  function drawPowerups(){
    for(const pu of powerups){
      const pulse = 1 + Math.sin(pu.phase) * 0.12;
      const fade  = pu.life < 3 ? (0.35 + 0.65 * Math.abs(Math.sin(pu.life * 8))) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(pu.x, pu.y);

      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, pu.radius * 1.5 * pulse);
      g.addColorStop(0, 'rgba(255,240,190,0.95)');
      g.addColorStop(0.45, 'rgba(255,150,40,0.75)');
      g.addColorStop(1, 'rgba(255,60,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, pu.radius * 1.5 * pulse, 0, Math.PI*2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, pu.radius * 0.62 * pulse, 0, Math.PI*2);
      ctx.fillStyle = '#ffcf66';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,90,30,0.9)';
      ctx.stroke();

      ctx.font = 'bold 15px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#7a2800';
      ctx.fillText('🔥', 0, 1);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  const particles = [];
  function spawnParticles(x, y, count, opts){
    const o = opts || {};
    for(let i = 0; i < count; i++){
      const a = o.angle !== undefined ? o.angle + (Math.random()-0.5)*(o.spread||Math.PI*2)
                                      : Math.random()*Math.PI*2;
      const sp = (o.speed || 2) * (0.4 + Math.random()*0.9);
      particles.push({
        x, y,
        vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
        life: o.life || 0.5,
        maxLife: o.life || 0.5,
        size: (o.size || 3) * (0.5 + Math.random()),
        color: o.color || 'rgba(190,230,190,0.9)',
        gravity: o.gravity || 0
      });
    }
  }
  function updateParticles(dt){
    for(let i = particles.length - 1; i >= 0; i--){
      const p = particles[i];
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy += p.gravity * dt * 60;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life -= dt;
      if(p.life <= 0) particles.splice(i, 1);
    }
  }
  function drawParticles(){
    for(const p of particles){
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  /* =========================================================
     Reset / scoring
     ========================================================= */
  function resetPositions(towardSide){
    for(const team of teams){
      team.controlledIndex = team.outfield.findIndex(p => p.role === 'FWD');
      if(team.controlledIndex < 0) team.controlledIndex = 0;
      team.manualLock = 0;
      team.switchHold = 0;
      team.claimHold = 0;
      team.switchCursor = 0;
      team.chainTimer = 0;
      team.modArmed = false;
      if(team.cpu) team.cpu = makeCpuState();
      team.containing = false;
      team.powerHeld = false;
      team.advance = 0;
      team.teamSprint = 0;
      team.charge = 0;
      team.chargeHeld = false;
      team.gk.x = team.gk.home.x; team.gk.y = team.gk.home.y;
      team.gk.vx = 0; team.gk.vy = 0;
      team.gk.state = 'idle'; team.gk.stateTimer = 0;
      for(const pl of team.outfield){
        pl.x = pl.home.x; pl.y = pl.home.y; pl.vx = 0; pl.vy = 0; pl.lungeTimer = 0;
        pl.slideTimer = 0; pl.downTimer = 0; pl.lungeCd = 0;
      }
    }
    ball.x = W/2; ball.y = H/2; ball.vx = 0; ball.vy = 0; ball.spin = 0;
    ball.trail.length = 0;
    ball.heldBy = null; ball.shotTimer = 0; ball.shotSide = null;
    ball.releaseGuard = 0; ball.releaseSide = null; ball.curve = 0;
    ball.z = 0; ball.vz = 0; ball.loftTeam = null;
    for(const t of teams){
      t.gk.state = "idle"; t.gk.stateTimer = 0; t.gk.readShot = -1;
      t.gk.reactTimer = 0; t.gk.reactShot = -1; t.gk.beatenTimer = 0;
    }
    ball.ownerLock = 0; ball.stealGuard = 0;
    lastTouchTeam = null;
    ballOwner = null;

    // A restart belongs to somebody. After a goal the conceding side kicks off:
    // their forward stands on the ball with the controls, and the other side is
    // kept off it for the first moments of play. Without this, every restart
    // was a perfectly symmetric scrum — both forwards 60px from the ball, and
    // whoever mashed the stick first won it (against the CPU: deterministic).
    if(towardSide){
      const idx = towardSide.outfield.findIndex(p => p.role === 'FWD');
      if(idx >= 0){
        const taker = towardSide.outfield[idx];
        const back  = towardSide.side === 'left' ? -1 : 1;
        taker.x = W/2 + back * 24; taker.y = H/2;
        taker.facing.x = -back; taker.facing.y = 0;
        towardSide.controlledIndex = idx;
        ballOwner = taker;
        lastTouchTeam = towardSide;
        ball.releaseGuard = KICKOFF_GUARD;     // opponents cannot poach the restart
        ball.releaseSide  = towardSide.side;
      }
    }
  }
  const KICKOFF_GUARD = 0.7;   // s after the whistle the restart is protected
  let restartTeam = null;      // who kicks off next (the side that just conceded)

  function goalCheck(){
    // Not while one is already being resolved. Without the replay half of
    // this, finishGoal() cleared pendingGoal with the ball still sitting in
    // the net, and the very same frame counted it as a second goal.
    if(pendingGoal || replay.active) return false;
    // left goal — red scores
    // under the bar and between the posts, or it is not a goal
    const underBar = ball.z < GOAL_H_PX;
    if(underBar && ball.x - ball.radius < FIELD_MARGIN - GOAL_DEPTH*0.5 && ball.y > topGoalY && ball.y < botGoalY){
      score2++; onGoal(team2, 'left'); return true;
    }
    // right goal — blue scores
    if(underBar && ball.x + ball.radius > W - FIELD_MARGIN + GOAL_DEPTH*0.5 && ball.y > topGoalY && ball.y < botGoalY){
      score1++; onGoal(team1, 'right'); return true;
    }
    return false;
  }

  /* ---- the goal itself ----
     Crossing the line used to end the play instantly: the ball vanished mid-air
     and the celebration cut over it. Now the whistle is held for a moment while
     the ball keeps living inside the goal — it carries on into the net, punches
     the cloth, drops and rolls — and only then does the celebration and the
     replay take over. The clock is stopped for the whole of it. */
  const GOAL_ACTION = 1.35;      // seconds the ball is allowed to live in the net
  let goalAction = 0;
  let pendingGoal = null;

  function onGoal(team, netSide){
    updateScore(team.isP1 ? score1El : score2El);

    // whoever touched it last gets the credit — or the blame
    const toucher = ballOwner;
    const own  = toucher && toucher.side !== team.side;
    const who  = toucher ? (toucher.name || ('#' + toucher.number)) : null;

    pendingGoal = {
      team, netSide, own, who,
      speed: Math.hypot(ball.vx, ball.vy),
      hitY: ball.y, hitZ: ball.z
    };
    stats.goals.push({ team, who, own, minute: Math.ceil((matchLength - matchTime) / 60) });
    if(!own) stats.onTarget[team.isP1 ? 0 : 1]++;
    goalAction = GOAL_ACTION;
    restartTeam = team.isP1 ? team2 : team1;   // the side that conceded kicks off

    // the crowd and the shake go off NOW — they are reacting to the ball
    // crossing, not to the replay
    shake = 16;
    sfx.goal();
    crowdRoar();
    crowdCheer(3.2);
    flashStatus(own ? ('¡Gol en propia de ' + who + '!')
                    : ('¡GOL ' + (who ? 'de ' + who : 'del equipo ' + team.name) + '!'), 'goal');
  }

  // called once the ball has finished its business inside the net
  function finishGoal(){
    const g = pendingGoal;
    pendingGoal = null;
    if(!g) return;

    const line = !g.who ? ('Equipo ' + g.team.name)
               : g.own  ? ('en propia de ' + g.who)
                        : ('de ' + g.who);
    celebration = { text: g.own ? '¡EN PROPIA!' : '¡GOOOL!', sub: line,
                    color: g.team.color, t: 0 };
    if(g3.ready) throwCheerBits();
    const gx = g.team.side === 'left' ? W - FIELD_MARGIN : FIELD_MARGIN;
    for(let i = 0; i < 70; i++){
      spawnParticles(gx, H/2, 1, {
        speed: 9, life: 1.4, size: 6, gravity: 0.09,
        color: ['#f2c14e', '#ffffff', g.team.color, '#9fd6ac'][i % 4]
      });
    }

    const scorerName = g.who ? (g.own ? g.who + ' (en propia)' : g.who) : null;
    if(startReplay(g.netSide, scorerName, g.speed, g.hitY, g.hitZ)){
      // the net is punched when the REPLAY reaches the moment of impact, not
      // when the goal is given — otherwise it has finished bouncing by then
      resetNets();
      resetPositions(restartTeam);   // out of the net before anything else looks at it
      kickoffTimer = 0;
    } else {
      kickoffTimer = 1.8;
      resetPositions(restartTeam);
    }
  }



  function updateScore(bumpEl){
    score1El.textContent = score1;
    score2El.textContent = score2;
    if(bumpEl){
      bumpEl.classList.remove('bump');
      void bumpEl.offsetWidth;
      bumpEl.classList.add('bump');
    }
  }

  let statusTimeout = null;
  // Fifteen different things write to this one line, and the last one used to
  // win: a routine "saque del arquero" would wipe "¡GOL de Tuti!" half a second
  // after it appeared. Now a message carries a priority and a lesser one
  // cannot replace a greater one while it is showing.
  const STATUS_PRIO = { info: 0, play: 1, goal: 2 };
  let statusPrio = -1;
  function flashStatus(msg, kind){
    const p = STATUS_PRIO[kind || 'info'];
    if(p < statusPrio) return;
    statusPrio = p;
    statusEl.textContent = msg;
    statusEl.classList.toggle('goal', p === STATUS_PRIO.goal);
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      statusPrio = -1;
      statusEl.classList.remove('goal');
      statusEl.textContent = running ? (paused ? 'Pausa' : '') : '¡A jugar!';
    }, p === STATUS_PRIO.goal ? 3200 : 2000);
  }

  function updatePossessionHud(){
    const total = possession[0] + possession[1];
    if(total < 1){ return; }
    const p1 = Math.round(possession[0] / total * 100);
    poss1El.textContent = 'Posesión ' + p1 + '%';
    poss2El.textContent = 'Posesión ' + (100 - p1) + '%';
  }

  /* =========================================================
     Gamepads
     ========================================================= */
  // navigator.getGamepads() copies every pad's state on each call; it was
  // being called three to five times a frame. One snapshot per frame instead.
  let padSnap = null;
  function getGamepads(){
    if(padSnap) return padSnap;
    padSnap = navigator.getGamepads ? navigator.getGamepads() : [];
    return padSnap;
  }
  function dropPadSnapshot(){ padSnap = null; padSlotsCache = null; }

  /* ---- which pad belongs to which player ----
     The browser list has HOLES. Bluetooth pads reconnect into whatever slot is
     free, and a dropped pad can linger as a stale entry, so a single live
     controller is often at index 1, 2 or 3 with index 0 empty or dead. The old
     code compacted the list for the CHIPS ("Mando 1: conectado") and then read
     getGamepads()[0] for the actual input — null — so the pad was visibly
     connected and completely deaf. That is the "it worked and then it just
     stopped" report: a Bluetooth reconnection moved it. Everything now goes
     through padFor(player): the connected pads compacted in order, with an
     optional swap and a per-player input mode. */
  let padSlotsCache = null;
  function padSlots(){
    if(padSlotsCache) return padSlotsCache;
    const list = getGamepads(), out = [];
    for(let i = 0; i < list.length; i++){
      const gp = list[i];
      if(gp && gp.connected !== false && gp.buttons && gp.buttons.length) out.push(gp);
    }
    padSlotsCache = out;
    return out;
  }
  // 'auto': pad when it is being used, keyboard otherwise. 'pad' / 'keyboard': forced.
  const inputMode = ['auto', 'auto'];
  let swapPads = false;
  function padFor(player){
    if(inputMode[player] === 'keyboard') return null;
    const slots = padSlots();
    const idx = swapPads ? 1 - player : player;
    return slots[idx] || null;
  }
  // the last moment any input arrived from each player's pad — for the chips
  const padSeen = [0, 0];
  function trimName(name){
    return name.length > 22 ? name.slice(0, 22) + '…' : name;
  }
  function updatePadChips(){
    const slots = padSlots();
    const now = performance.now();
    const label = (player, keysHint) => {
      const chip = player ? chip2 : chip1;
      const who  = player ? 'Rojo' : 'Azul';
      const mode = inputMode[player];
      const gp   = padFor(player);
      const live = now - padSeen[player] < 400;
      chip.classList.toggle('live', live);
      if(mode === 'keyboard'){
        chip.textContent = who + ': teclado (' + keysHint + ')';
        chip.classList.remove('on');
      } else if(gp){
        chip.textContent = who + ': mando ✔ ' + trimName(gp.id) + (live ? ' · recibiendo' : ' · pulsa un botón para probarlo');
        chip.classList.add('on');
      } else if(mode === 'pad'){
        chip.textContent = who + ': esperando mando… pulsa un botón en él con esta pestaña enfocada';
        chip.classList.remove('on');
      } else {
        chip.textContent = who + ': sin mando, teclado (' + keysHint + ')';
        chip.classList.remove('on');
      }
    };
    label(0, 'WASD');
    if(cpuMode){
      chip2.textContent = '🤖 Rojo: la máquina';
      chip2.classList.add('on'); chip2.classList.remove('live');
    } else {
      label(1, 'flechas');
    }
    if(swapBtn) swapBtn.hidden = slots.length < 2 || cpuMode;
    if(padDiagEl){
      padDiagEl.textContent = (chip1.textContent + (cpuMode ? '' : '\n' + chip2.textContent)) + '\n\n' + padDiagText();
    }
    if(slots.length === 0 && inputMode[0] !== 'keyboard'){
      chip1.textContent += ' · el navegador solo muestra un mando tras pulsar un botón en él';
    }
  }

  setInterval(() => { if(uiOpen()) updatePadChips(); }, 250);
  // diagnostics: how many connect/disconnect events the browser has actually
  // delivered, and the last raw view of the list — shown in the menu so a
  // "the game does not hear my pad" report can say what the BROWSER sees
  const padEvents = { connected: 0, disconnected: 0, lastId: '' };
  window.addEventListener('gamepadconnected', e => {
    padEvents.connected++; padEvents.lastId = e && e.gamepad ? e.gamepad.id : '';
    const gp = e && e.gamepad;
    console.info('[FC27 mandos] CONECTADO → índice ' + (gp ? gp.index : '?') + ' · "' + (gp ? gp.id : '?') + '" · ' +
                 (gp && gp.buttons ? gp.buttons.length : '?') + ' botones · mapping "' + (gp ? (gp.mapping || 'no estándar') : '?') + '"');
    dropPadSnapshot(); updatePadChips();
  });
  window.addEventListener('gamepaddisconnected', e => {
    padEvents.disconnected++;
    console.info('[FC27 mandos] DESCONECTADO → índice ' + (e && e.gamepad ? e.gamepad.index : '?'));
    dropPadSnapshot(); updatePadChips();
  });
  console.info('[FC27] API de mandos: ' + (navigator.getGamepads ? 'disponible' : 'NO DISPONIBLE') +
               ' · contexto seguro: ' + (window.isSecureContext ? 'sí' : 'no') +
               ' · en iframe: ' + (window.top !== window.self ? 'SÍ' : 'no') +
               '. Escribe fc27.mandos() en esta consola para ver los mandos.');
  // console helper: a table of what the browser reports, plus live input
  window.fc27 = window.fc27 || {};
  window.fc27.mandos = function(){
    dropPadSnapshot();
    const raw = navigator.getGamepads ? navigator.getGamepads() : [];
    const rows = [];
    for(let i = 0; i < raw.length; i++){
      const gp = raw[i];
      rows.push(gp ? { indice: i, id: gp.id, conectado: gp.connected, botones: gp.buttons.length, ejes: gp.axes.length,
                       mapping: gp.mapping || 'no estándar',
                       pulsado: gp.buttons.map((b, k) => b.pressed ? k : -1).filter(k => k >= 0).join(',') || '-',
                       stick: gp.axes.slice(0, 2).map(v => v.toFixed(2)).join(',') }
                   : { indice: i, id: '(vacío)' });
    }
    if(!rows.length) console.warn('[FC27 mandos] la lista está VACÍA: el navegador no ha entregado ningún mando a esta página.');
    else console.table(rows);
    console.info('[FC27 mandos] eventos conectado=' + padEvents.connected + ' desconectado=' + padEvents.disconnected +
                 ' · asignación: Azul → ' + (padFor(0) ? padFor(0).id : 'ninguno') + ' · Rojo → ' + (padFor(1) ? padFor(1).id : 'ninguno') +
                 ' · modo Azul=' + inputMode[0] + ' Rojo=' + inputMode[1]);
    return rows;
  };

  const padDiagEl = document.getElementById('pad-diag');
  function padDiagText(){
    const hasApi = !!(navigator.getGamepads);
    const raw = hasApi ? (getGamepads() || []) : [];
    const lines = [];
    if(!hasApi){
      lines.push('❌ Este navegador no expone la API de mandos (navigator.getGamepads).');
    } else {
      let n = 0;
      for(let i = 0; i < raw.length; i++){
        const gp = raw[i];
        if(!gp) continue;
        n++;
        lines.push('• Índice ' + i + ': ' + gp.id + ' — ' + (gp.connected === false ? 'DESCONECTADO' : 'conectado') +
                   ' · ' + (gp.buttons ? gp.buttons.length : 0) + ' botones · ' + (gp.axes ? gp.axes.length : 0) +
                   ' ejes · mapping "' + (gp.mapping || 'no estándar') + '"');
      }
      if(!n) lines.push('El navegador devuelve la lista vacía: no ha entregado ningún mando a esta página.');
    }
    lines.push('Eventos de conexión recibidos: ' + padEvents.connected + ' · desconexión: ' + padEvents.disconnected +
               (padEvents.lastId ? ' · último: ' + padEvents.lastId : ''));
    let policy = '';
    try{
      if(document.featurePolicy && document.featurePolicy.allowsFeature)
        policy = document.featurePolicy.allowsFeature('gamepad') ? 'permitida' : 'BLOQUEADA';
    }catch(e){}
    lines.push('Pestaña con foco: ' + (document.hasFocus ? (document.hasFocus() ? 'sí' : 'NO') : '?') +
               ' · contexto seguro: ' + (window.isSecureContext ? 'sí' : 'NO') +
               (policy ? ' · política "gamepad": ' + policy : '') +
               (window.top !== window.self ? ' · ⚠ dentro de un iframe' : ''));
    lines.push(navigator.userAgent);
    return lines.join('\n');
  }

  const STICK_DZ  = 0.15;   // radial deadzone
  const STICK_MAX = 0.95;   // where the stick counts as fully pushed
  const WALK_MIN  = 0.45;   // fraction of top speed at the deadzone edge

  function readPadInput(player){
    const gp = padFor(player);
    if(!gp) return null;
    let dx = 0, dy = 0;
    if(gp.axes.length >= 2){
      // Radial deadzone, not per-axis. Per-axis zeroed any shallow component
      // near a cardinal, so pushing right-and-a-bit-up travelled dead flat —
      // the "8-way / notchy stick" feel. The magnitude is rescaled from the
      // deadzone edge to 1 and KEPT: it becomes walking speed downstream.
      const ax = gp.axes[0], ay = gp.axes[1];
      const m  = Math.hypot(ax, ay);
      if(m > STICK_DZ){
        const s = Math.min(1, (m - STICK_DZ) / (STICK_MAX - STICK_DZ)) / m;
        dx = ax * s; dy = ay * s;
      }
    }
    if(gp.buttons.length >= 16){
      if(gp.buttons[14] && gp.buttons[14].pressed) dx = -1;
      if(gp.buttons[15] && gp.buttons[15].pressed) dx =  1;
      if(gp.buttons[12] && gp.buttons[12].pressed) dy = -1;
      if(gp.buttons[13] && gp.buttons[13].pressed) dy =  1;
    }
    const btn = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let rsx = 0, rsy = 0;
    if(gp.axes.length >= 4){ rsx = gp.axes[2]; rsy = gp.axes[3]; }
    if(dx || dy || gp.buttons.some(b => b && b.pressed)) padSeen[player] = performance.now();
    return {
      dx, dy,
      kick:    btn(0),                      // A  — shot (hold to charge)
      power:   btn(1),                      // B  — hard shot on goal
      pass:    btn(2),                      // X  — pass
      contain: btn(3) || btn(6),            // Y / LT — face up and steal
      sprint:  btn(7),                      // RT — run
      modifier: btn(5),                     // RB — shot modifier (loft / curl)
      switchBtn: btn(4),                    // LB
      rsx, rsy
    };
  }

  /* ---------- Rumble ----------
     Controller haptics. The modern path is vibrationActuator.playEffect; older
     builds only expose hapticActuators[].pulse, so both are handled and a pad
     with neither simply does nothing. */
  let rumbleOn = true;
  const clamp01 = v => Math.max(0, Math.min(1, v));

  function rumble(player, strong, weak, duration){
    if(!rumbleOn) return false;
    const gp = padFor(player);
    if(!gp) return false;
    const ms = Math.round(duration);
    const act = gp.vibrationActuator;
    if(act && typeof act.playEffect === 'function'){
      try {
        const r = act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: ms,
          strongMagnitude: clamp01(strong),
          weakMagnitude:   clamp01(weak)
        });
        if(r && typeof r.catch === 'function') r.catch(() => {});
        return true;
      } catch(e){ /* fall through to the legacy path */ }
    }
    if(gp.hapticActuators && gp.hapticActuators.length){
      try {
        const a = gp.hapticActuators[0];
        if(typeof a.pulse === 'function'){ a.pulse(clamp01(strong), ms); return true; }
      } catch(e){}
    }
    return false;
  }

  // Being closed down buzzes the pad of the player ON the ball, throttled so it
  // reads as steady pressure rather than a machine gun.
  const rumbleCooldown = [0, 0];
  function pressureRumble(victimTeam, strength){
    const i = victimTeam.isP1 ? 0 : 1;
    if(rumbleCooldown[i] > 0) return;
    rumbleCooldown[i] = 0.18;
    rumble(i, strength, strength * 0.85, 150);
  }

  const padPrevSwitch = [false, false];
  const padPrevRStick = [false, false];
  function pollGamepadSwitch(){
    teams.forEach((team, i) => {
      const pad = readPadInput(i);
      if(pad){
        // NOTE: skipping the intro and the goal sequence used to live here, and
        // it could not work — step() does not run during either of them, so the
        // pad was never read. It is in pollUiPad() now, off the render loop.
        if(pad.switchBtn && !padPrevSwitch[i]) manualSwitch(team);
        padPrevSwitch[i] = pad.switchBtn;
        const rMag = Math.hypot(pad.rsx, pad.rsy);
        if(rMag > 0.6 && !padPrevRStick[i]) directionalSwitch(team, pad.rsx, pad.rsy);
        padPrevRStick[i] = rMag > 0.6;
      } else {
        padPrevSwitch[i] = false;
        padPrevRStick[i] = false;
      }
    });
  }

  /* =========================================================
     UI input — menu navigation, mute, and skipping the cinematics
     Everything here has one thing in common: it has to work when the match loop
     is NOT running. pollGamepadSwitch() lives inside step(), and step() is
     skipped during the intro, the goal action and the replay — so the pad could
     never get you out of any of them. This is polled from the render loop, so
     it always answers, and every press is edge-triggered: holding a button down
     does one thing once, instead of blowing through the whole goal sequence in
     two frames.
     ========================================================= */
  const uiPrev = { any:false, up:false, down:false, left:false, right:false,
                   ok:false, mute:false, start:false };

  function padUiState(){
    const pads = padSlots();
    const st = { any:false, up:false, down:false, left:false, right:false,
                 ok:false, mute:false, start:false };
    for(let i = 0; i < pads.length; i++){
      const gp = pads[i];
      if(inputMode[0] === 'keyboard' && inputMode[1] === 'keyboard') break;
      const btn = n => !!(gp.buttons[n] && gp.buttons[n].pressed);
      const ax  = gp.axes.length >= 2 ? gp.axes[0] : 0;
      const ay  = gp.axes.length >= 2 ? gp.axes[1] : 0;
      st.up    = st.up    || btn(12) || ay < -0.55;
      st.down  = st.down  || btn(13) || ay >  0.55;
      st.left  = st.left  || btn(14) || ax < -0.55;
      st.right = st.right || btn(15) || ax >  0.55;
      st.ok    = st.ok    || btn(0)  || btn(9);        // A or Start
      st.mute  = st.mute  || btn(8);                   // Back / Select
      st.start = st.start || btn(9);                   // Start: pause
      // the face buttons and LB skip a cinematic; the triggers do not, because
      // you hold sprint permanently and that is not a request to skip anything
      st.any   = st.any || btn(0) || btn(1) || btn(2) || btn(3) || btn(4) || btn(9);
    }
    return st;
  }

  // ---- the start overlay, driven by keys or by a pad ----
  let uiRow = 0, uiCol = 0;

  // Which panel is up: the start menu, the pause menu, or nothing. Each has
  // its own grid of buttons for the cursor to walk.
  function uiPanel(){
    if(overlay && !overlay.classList.contains('hidden')) return 'menu';
    if(pauseMenu && running && paused) return 'pause';
    return null;
  }
  function uiRows(){
    const rows = [];
    const panel = uiPanel();
    if(panel === 'pause'){
      Array.prototype.forEach.call(pauseMenu.querySelectorAll('button'), b => { if(!b.disabled) rows.push([b]); });
      return rows;
    }
    if(overlay && overlay.classList.contains('result')){
      // the result card: one row, "Revancha" and "Cambiar ajustes"
      const r = [startBtn]; if(settingsBtn && !settingsBtn.hidden) r.push(settingsBtn);
      rows.push(r);
      return rows;
    }
    for(const id of ['view-seg', 'mode-seg', 'level-seg', 'len-seg', 'in1-seg', 'in2-seg']){
      const el = document.getElementById(id);
      if(!el) continue;
      const row = el.closest ? el.closest('.option-row') : null;
      if(row && row.hidden) continue;          // the difficulty row comes and goes
      const bs = Array.prototype.slice.call(el.querySelectorAll('button'));
      if(bs.length) rows.push(bs);
    }
    if(startBtn) rows.push([startBtn]);
    return rows;
  }

  function uiOpen(){ return uiPanel() !== null; }

  function uiPaint(){
    const all = document.querySelectorAll('#overlay button, #pause-menu button');
    Array.prototype.forEach.call(all, b => b.classList.remove('ui-focus'));
    if(!uiOpen()) return;
    const rows = uiRows();
    if(!rows.length) return;
    uiRow = Math.max(0, Math.min(rows.length - 1, uiRow));
    uiCol = Math.max(0, Math.min(rows[uiRow].length - 1, uiCol));
    const f = rows[uiRow][uiCol];
    f.classList.add('ui-focus');
    if(f.scrollIntoView) f.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if(f.focus) f.focus({ preventScroll: true });
  }

  // put the cursor on a given button (after a mouse click, or a restored setting)
  function uiSyncTo(btn){
    const rows = uiRows();
    for(let r = 0; r < rows.length; r++){
      const c = rows[r].indexOf(btn);
      if(c >= 0){ uiRow = r; uiCol = c; uiPaint(); return; }
    }
  }

  function uiMove(dr, dc){
    const rows = uiRows();
    if(!rows.length) return;
    sfx.uiMove();
    if(dr){
      uiRow = (uiRow + dr + rows.length) % rows.length;
      uiCol = Math.min(uiCol, rows[uiRow].length - 1);
    }
    if(dc){
      const n = rows[uiRow].length;
      uiCol = (uiCol + dc + n) % n;
    }
    uiPaint();
  }

  function uiActivate(){
    const rows = uiRows();
    if(!rows.length) return;
    const btn = rows[uiRow][uiCol];
    if(btn && btn.disabled) return;
    sfx.uiOk();
    if(btn) btn.click();
    uiPaint();          // picking "la máquina" adds a row, so redraw the cursor
  }

  // Called every frame from the render loop, whatever else is going on.
  function pollUiPad(){
    const st = padUiState();

    if(st.mute && !uiPrev.mute){ ensureAudio(); toggleMute(); if(paused) refreshPauseLabels(); }

    // Start: pause and unpause during a match (in the menus it is "ok")
    const startEdge = st.start && !uiPrev.start;
    if(startEdge && running && (paused || (!intro.active && !replay.active && goalAction <= 0))){
      togglePause();
    } else if(uiOpen()){
      if(st.up    && !uiPrev.up)    uiMove(-1,  0);
      if(st.down  && !uiPrev.down)  uiMove( 1,  0);
      if(st.left  && !uiPrev.left)  uiMove( 0, -1);
      if(st.right && !uiPrev.right) uiMove( 0,  1);
      if(st.ok    && !uiPrev.ok)    uiActivate();
    } else if(st.any && !uiPrev.any){
      if(skipEnding()){ /* the final confetti */ }
      else if(!running || paused){ /* nothing to skip */ }
      else if(intro.active){ skipIntro(); sfx.whistle(); }
      else if(replay.active || goalAction > 0) skipCelebration();
    }
    uiPrev.start = st.start;

    uiPrev.any  = st.any;  uiPrev.up   = st.up;   uiPrev.down = st.down;
    uiPrev.left = st.left; uiPrev.right = st.right;
    uiPrev.ok   = st.ok;   uiPrev.mute = st.mute;
  }

  /* =========================================================
     Player switching
     ========================================================= */
  function getControlled(team){ return team.outfield[team.controlledIndex]; }

  // Switching is MANUAL only: the button and the right stick. Nothing reassigns
  // control on its own except the possession hand-off in claimControl().
  const SWITCH_HOLD     = 0.25; // s of settle time after any switch
  const MANUAL_LOCK     = 1.2;  // s your deliberate pick is protected for
  const KEEP_BALL_RANGE = 62;   // this close to the ball you count as in possession

  function setControlled(team, idx, lock){
    if(idx === team.controlledIndex) return;
    const prev = team.outfield[team.controlledIndex];
    if(prev){ prev.vx = 0; prev.vy = 0; }   // don't leave it drifting on the last input
    team.controlledIndex = idx;
    team.manualLock = lock || 0;
    team.switchHold = SWITCH_HOLD;
    team.charge = 0;
    team.chargeHeld = false;
  }

  // Button switch: cycles ONLY among the men actually near the ball. Anyone
  // parked on the far side of the pitch is not a useful thing to be handed in
  // the middle of a move, so they are never offered — use the right stick to
  // reach them deliberately.
  const SWITCH_CHAIN  = 1.0;   // s a run of taps stays linked
  const SWITCH_POOL   = 2;     // how many of the nearest the button rotates between
  const SWITCH_RADIUS = 480;   // px from the ball beyond which a player is "far"

  // Which line the button offers you, decided by where the ball is: with play in
  // the opponent's half you are cycling strikers, and once it comes back into
  // your own half you are cycling defenders. It matches what you are trying to
  // do in each phase instead of handing you whoever happens to be closest.
  function switchLine(team){
    // three bands now: your own third defends, the middle belongs to the
    // midfielders, the last third is for the strikers
    const f = team.side === 'left' ? (ball.x - FIELD_MARGIN) / (W - FIELD_MARGIN*2)
                                   : 1 - (ball.x - FIELD_MARGIN) / (W - FIELD_MARGIN*2);
    if(f < 0.36) return 'DEF';
    if(f < 0.68) return 'MID';
    return 'FWD';
  }

  function switchPool(team){
    const available = team.outfield
      .map((pl, idx) => ({ idx, d: Math.hypot(ball.x - pl.x, ball.y - pl.y), pl }))
      .filter(r => r.pl.slideTimer <= 0 && r.pl.downTimer <= 0)   // not on the floor
      .sort((a, b) => a.d - b.d);
    if(!available.length) return available;

    const line = available.filter(r => r.pl.role === switchLine(team));
    if(line.length) return line;

    // that whole line is unavailable: fall back to whoever is near the ball,
    // and if nobody is, to the closest men, so the button always does something
    const near = available.filter(r => r.d <= SWITCH_RADIUS);
    return near.length ? near : available.slice(0, SWITCH_POOL);
  }

  function manualSwitch(team){
    if(!running || paused) return;
    const pool = switchPool(team);
    if(!pool.length) return;

    // a tap that follows another one steps along the pool; otherwise restart at
    // the nearest man, so he is never more than one press away
    team.switchCursor = team.chainTimer > 0 ? team.switchCursor + 1 : 0;
    team.chainTimer = SWITCH_CHAIN;

    for(let k = 0; k < pool.length; k++){
      const at = (team.switchCursor + k) % pool.length;
      if(pool[at].idx === team.controlledIndex) continue;   // skip yourself
      team.switchCursor = at;
      setControlled(team, pool[at].idx, MANUAL_LOCK);
      sfx.pass();
      return;
    }
  }

  // The ONLY automatic switch left: when the ball changes hands, whoever won it
  // becomes the player you control. It fires on the change of possession, not
  // every frame someone is near the ball, so a carrier keeps the controls while
  // they dribble and your deliberate picks are not fought over.
  function claimControl(team, idx){
    if(idx === team.controlledIndex) return;
    const cand = team.outfield[idx];
    if(cand && (cand.slideTimer > 0 || cand.downTimer > 0)) return;
    setControlled(team, idx, 0);
  }

  // ...and it is enforced every frame, not just on the touch that won the ball:
  // whoever on your side actually has the ball at their feet is who you control.
  // A manual pick therefore only sticks while your team does NOT have the ball,
  // which is exactly when you need it (pressing, covering, intercepting).
  function enforcePossessionControl(team){
    const owner = ballOwner;
    if(!owner || owner.side !== team.side) return;
    if(owner.role === 'GK') return;                 // keepers are never user-controlled
    const idx = team.outfield.indexOf(owner);
    if(idx < 0 || idx === team.controlledIndex) return;
    if(owner.slideTimer > 0 || owner.downTimer > 0) return;   // he is on the floor
    // they must still HAVE it, not merely have been the last to touch it
    if(Math.hypot(ball.x - owner.x, ball.y - owner.y) > CARRY_RANGE) return;
    setControlled(team, idx, 0);
  }

  // Right-stick switch: pick the teammate lying in the direction you pushed,
  // weighing BOTH how well they line up with the stick and how far away they
  // are. Candidates outside a cone around the pushed direction are ignored, so
  // flicking the stick never grabs somebody behind you.
  const CONE_RATIO   = 1.35;  // max lateral offset as a multiple of forward distance (~53 deg)
  const PERP_WEIGHT  = 1.8;   // how much being off-axis costs
  const ALONG_WEIGHT = 0.55;  // how much raw distance costs

  function directionalSwitch(team, dx, dy){
    const current = getControlled(team);
    const dirLen = Math.hypot(dx, dy);
    if(dirLen < 0.3) return;
    const ndx = dx / dirLen, ndy = dy / dirLen;

    let bestIdx = -1, bestCost = Infinity;
    team.outfield.forEach((pl, idx) => {
      if(idx === team.controlledIndex) return;
      if(pl.slideTimer > 0 || pl.downTimer > 0) return;   // not on the floor
      const vx = pl.x - current.x, vy = pl.y - current.y;
      const along = vx * ndx + vy * ndy;             // distance along the pushed direction
      if(along < 25) return;                         // behind you: never a candidate
      const perp = Math.abs(vx * -ndy + vy * ndx);   // distance off that axis
      if(perp > along * CONE_RATIO) return;          // outside the cone
      const cost = perp * PERP_WEIGHT + along * ALONG_WEIGHT;
      if(cost < bestCost){ bestCost = cost; bestIdx = idx; }
    });

    if(bestIdx >= 0){
      setControlled(team, bestIdx, MANUAL_LOCK);
      sfx.pass();
    }
  }

  function tickSwitchTimers(team, dt){
    if(team.switchHold > 0) team.switchHold -= dt;
    if(team.claimHold  > 0) team.claimHold  -= dt;
    if(team.manualLock > 0) team.manualLock -= dt;
    if(team.chainTimer > 0) team.chainTimer -= dt;
  }



  /* =========================================================
     Human input resolution
     ========================================================= */
  /* =========================================================
     Machine opponent
     The bot gets no privileged access to the simulation: it fills in the same
     controller struct a human does, and everything downstream — close control,
     the charge bar, contain, slides — treats it exactly like a player. If a
     mechanic works for you it works for the machine, and vice versa.
     ========================================================= */
  let cpuMode  = false;   // is team 2 the machine?
  let cpuLevel = 1;

  const CPU_LEVELS = [
    { name:'Fácil',   think:0.42, range:340, aim:0.50, sprint:0.30, charge:0.55,
      contain:0.30, switchGap:240, pass:0.22, slide:0.03 },
    { name:'Normal',  think:0.17, range:520, aim:0.81, sprint:0.74, charge:0.70,
      contain:0.62, switchGap:150, pass:0.40, slide:0.08 },
    { name:'Difícil', think:0.11, range:560, aim:0.90, sprint:0.88, charge:0.68,
      contain:0.80, switchGap:115, pass:0.52, slide:0.12 }
  ];

  function makeCpuState(){
    return { think:0, aimX:W/2, aimY:H/2, holdKind:null, holdLeft:0, sprint:false,
             switchCd:0, jitterX:0, jitterY:0, jitterT:0, actCd:0 };
  }

  function isCpu(team){ return cpuMode && !team.isP1; }

  function neutralInput(){
    return { dx:0, dy:0, kick:false, pass:false, sprint:false,
             power:false, contain:false, modifier:false };
  }

  function steer(out, p, tx, ty){
    const dx = tx - p.x, dy = ty - p.y;
    const d = Math.hypot(dx, dy) || 1;
    out.dx = dx/d; out.dy = dy/d;
  }

  function nearestOpponent(team, x, y){
    const foes = team === team1 ? team2 : team1;
    let best = null, bd = Infinity;
    for(const f of foes.outfield){
      const d = Math.hypot(f.x - x, f.y - y);
      if(d < bd){ bd = d; best = f; }
    }
    return best;
  }

  // the open teammate the bot would rather give it to
  function cpuBestMate(team, p){
    let best = null, bestScore = -Infinity;
    const fwd = team.side === 'left' ? 1 : -1;
    for(const mate of team.outfield){
      if(mate === p || mate.downTimer > 0 || mate.slideTimer > 0) continue;
      const d = Math.hypot(mate.x - p.x, mate.y - p.y);
      if(d < 90 || d > 620) continue;
      const score = nearestOpponentDist(team, mate.x, mate.y) + (mate.x - p.x) * fwd * 0.45;
      if(score > bestScore){ bestScore = score; best = mate; }
    }
    return best;
  }

  function cpuInput(team, dt){
    const cfg = CPU_LEVELS[cpuLevel] || CPU_LEVELS[1];
    const st  = team.cpu || (team.cpu = makeCpuState());
    const out = neutralInput();
    const p   = getControlled(team);
    if(!p) return out;

    st.switchCd -= dt;
    st.actCd    -= dt;
    st.jitterT  -= dt;
    if(st.jitterT <= 0){
      // aiming error: weaker levels miss rather than being handicapped by cheats
      st.jitterT = 0.45 + Math.random() * 0.6;
      st.sprint  = Math.random() < cfg.sprint;   // sticky, not re-rolled every frame
      const spread = (1 - cfg.aim) * 190;
      st.jitterX = (Math.random() - 0.5) * spread;
      st.jitterY = (Math.random() - 0.5) * spread;
    }

    const goal   = opponentGoal(team);
    // A loose ball is nobody's: treating the last toucher as the owner made
    // the bot stand around supporting a team-mate who no longer had it.
    const ownerOnBall = ballOwner &&
      Math.hypot(ball.x - ballOwner.x, ball.y - ballOwner.y) <= CARRY_RANGE;
    const mine   = ownerOnBall && ballOwner.side === team.side;
    const onBall = ballOwner === p && ballDist(p) < CARRY_RANGE && ball.z <= REACH_LOW;
    const dGoal  = Math.hypot(goal.x - p.x, goal.y - p.y);
    const dBall  = ballDist(p);

    // ---- mid wind-up: hold the button down and keep running in ----
    if(st.holdLeft > 0){
      st.holdLeft -= dt;
      if(st.holdKind === 'power') out.power = true; else out.kick = true;
      steer(out, p, goal.x + st.jitterX, goal.y + st.jitterY);
      if(st.holdLeft <= 0) st.holdKind = null;   // let go on the next frame
      return out;
    }

    // decisions are only refreshed every `think` seconds, so the easy levels
    // genuinely react late instead of being artificially slowed down
    if(st.think > 0) st.think -= dt;

    if(onBall){
      const pressure = nearestOpponentDist(team, p.x, p.y);
      const facing   = ((goal.x - p.x) * p.facing.x + (goal.y - p.y) * p.facing.y) / (dGoal || 1);

      if(st.actCd <= 0 && dGoal < cfg.range && facing > 0.35){
        const usePower = Math.random() < 0.55;
        st.holdKind = usePower ? 'power' : 'kick';
        const full  = usePower ? POWER_TIME : CHARGE_TIME;
        st.holdLeft = full * cfg.charge * (0.75 + Math.random() * 0.35);
        st.actCd    = 0.8;
        if(usePower) out.power = true; else out.kick = true;
        steer(out, p, goal.x + st.jitterX, goal.y + st.jitterY);
        return out;
      }

      // Do not try to dribble out of your own third under pressure: that is
      // where giving it away costs a goal, so play it away instead.
      const ownGoal = { x: team.side === 'left' ? FIELD_MARGIN : W - FIELD_MARGIN, y: H/2 };
      const dOwn = Math.hypot(ownGoal.x - p.x, ownGoal.y - p.y);
      const mate = cpuBestMate(team, p);
      if(st.actCd <= 0 && dOwn < 360 && pressure < 105){
        out.pass = true;
        st.actCd = 0.45;
        steer(out, p, mate ? mate.x : goal.x, mate ? mate.y : goal.y);
        return out;
      }
      if(st.actCd <= 0 && mate && pressure < 150 && Math.random() < cfg.pass){
        out.pass = true;
        st.actCd = 0.5;
        steer(out, p, mate.x, mate.y);
        return out;
      }

      // carry it at goal, drifting around whoever is closest
      if(st.think <= 0){
        st.think = cfg.think;
        let ty = goal.y + st.jitterY * 0.5;
        const foe = nearestOpponent(team, p.x, p.y);
        if(foe && Math.hypot(foe.x - p.x, foe.y - p.y) < 140){
          ty += (p.y < foe.y ? -1 : 1) * 150;      // sidestep the defender
        }
        st.aimX = goal.x;
        st.aimY = Math.max(FIELD_MARGIN + 60, Math.min(H - FIELD_MARGIN - 60, ty));
      }
      steer(out, p, st.aimX, st.aimY);
      out.sprint = st.sprint;
      return out;
    }

    if(mine){
      // if I am the closest of my side, go and get it rather than support
      let closest = true;
      for(const mate of team.outfield){
        if(mate === p || mate.downTimer > 0) continue;
        if(Math.hypot(ball.x - mate.x, ball.y - mate.y) < dBall - 20){ closest = false; break; }
      }
      if(closest && dBall > 60){
        steer(out, p, ball.x, ball.y);
        out.sprint = st.sprint;
        return out;
      }
      // a teammate has it: get up the pitch and offer a target
      if(st.think <= 0){
        st.think = cfg.think;
        const fwd = team.side === 'left' ? 1 : -1;
        st.aimX = Math.max(FIELD_MARGIN + 60, Math.min(W - FIELD_MARGIN - 60, ball.x + fwd * 240));
        st.aimY = Math.max(FIELD_MARGIN + 60, Math.min(H - FIELD_MARGIN - 60, ball.y + st.jitterY));
      }
      steer(out, p, st.aimX, st.aimY);
      out.sprint = st.sprint;
      return out;
    }

    // ---- defending: go and win it back ----
    if(st.switchCd <= 0 && dBall > cfg.switchGap){
      manualSwitch(team);               // take someone closer to the play
      st.switchCd = 0.9;
      return out;
    }
    if(st.think <= 0){
      st.think = cfg.think;
      // stand goal-side of the ball rather than running at it head-on
      const own = { x: team.side === 'left' ? FIELD_MARGIN : W - FIELD_MARGIN, y: H/2 };
      const gx = own.x - ball.x, gy = own.y - ball.y;
      const gl = Math.hypot(gx, gy) || 1;
      st.aimX = ball.x + (gx/gl) * 26 + st.jitterX * 0.4;
      st.aimY = ball.y + (gy/gl) * 26 + st.jitterY * 0.4;
    }
    steer(out, p, st.aimX, st.aimY);
    out.sprint = dBall > 130 && st.sprint;
    if(dBall < 110) out.contain = Math.random() < cfg.contain;
    if(st.actCd <= 0 && dBall < 70 && ballOwner && ballOwner.side !== team.side &&
       Math.random() < cfg.slide){
      out.pass = true;                  // X with no ball is a slide tackle
      st.actCd = 1.6;
    }
    return out;
  }

  const NEUTRAL_INPUT = {dx:0, dy:0, kick:false, pass:false, sprint:false, power:false, contain:false, modifier:false, switchBtn:false, rsx:0, rsy:0};
  function getInputFor(team, dt){
    if(isCpu(team)) return cpuInput(team, dt || 1/60);
    const player = team.isP1 ? 0 : 1;
    const mode = inputMode[player];
    const pad = readPadInput(player);
    // forced pad: the keyboard is ignored even if the pad is missing (it would
    // otherwise let the other player's keys leak in)
    if(mode === 'pad') return pad || NEUTRAL_INPUT;
    // 'auto': a connected pad used to make the keyboard dead. Now the keyboard
    // still works whenever the pad is idle, so a plugged-in controller nobody
    // is holding does not lock a keyboard player out.
    if(pad && (pad.dx || pad.dy || pad.kick || pad.power || pad.pass || pad.contain ||
               pad.sprint || pad.modifier || pad.switchBtn ||
               Math.abs(pad.rsx) > 0.3 || Math.abs(pad.rsy) > 0.3)) return pad;
    let dx = 0, dy = 0, kick = false, sprint = false, pass = false,
        power = false, contain = false, modifier = false;
    if(team.isP1){
      if(keys['KeyA']) dx -= 1;
      if(keys['KeyD']) dx += 1;
      if(keys['KeyW']) dy -= 1;
      if(keys['KeyS']) dy += 1;
      kick    = !!keys['Space'];
      pass    = !!keys['KeyE'];
      power   = !!keys['KeyF'];
      contain = !!keys['KeyR'];
      sprint  = !!keys['ShiftLeft'];
      modifier = !!keys['KeyC'];
    } else {
      if(keys['ArrowLeft'])  dx -= 1;
      if(keys['ArrowRight']) dx += 1;
      if(keys['ArrowUp'])    dy -= 1;
      if(keys['ArrowDown'])  dy += 1;
      kick    = !!keys['Enter'];
      pass    = !!keys['Period'];
      power   = !!keys['Slash'];
      contain = !!keys['Comma'];
      sprint  = !!keys['ControlRight'];
      modifier = !!keys['ShiftRight'];
    }
    const kb = {dx, dy, kick, pass, sprint, power, contain, modifier, switchBtn:false, rsx:0, rsy:0};
    if(pad && !(dx || dy || kick || pass || sprint || power || contain || modifier)) return pad;
    return kb;
  }

  /* =========================================================
     Ball contact helpers
     ========================================================= */
  function ballDist(p){ return Math.hypot(ball.x - p.x, ball.y - p.y); }
  // A ball in the air is only reachable up to a point: on the deck anyone can
  // play it, a bit higher you have to go up for it (hold the shoot button),
  // and a proper cross sails over everybody.
  const REACH_LOW    = 9;    // height you can play without going up for it
  const REACH_JUMP   = 32;   // height you reach when you challenge for it
  const REACH_KEEPER = 46;   // keepers claim crosses higher than anyone

  function canTouch(p, jumping){
    if(ballDist(p) >= p.radius + ball.radius + 3) return false;
    return ball.z <= (jumping ? REACH_JUMP : REACH_LOW);
  }

  // The ball is off-limits to a player when the keeper has it in his hands,
  // and briefly afterwards for the opposition: you cannot rob a keeper who is
  // holding it, nor stand on his toes and take the release off him.
  function ballLocked(p){
    if(ball.heldBy) return ball.heldBy !== p;
    if(ball.releaseGuard > 0 && ball.releaseSide && ball.releaseSide !== p.side) return true;
    return false;
  }

  // Every touch is routed through here, so a change of ball owner is detected in
  // exactly one place — and that change is what hands the player the controls.
  // Possession has a little inertia. Two opponents standing on the same ball
  // used to swap ownership every frame — each one's carry magnet dragging it
  // 30px back across, the control ring flickering on both pads, nothing ever
  // resolving until somebody slid. Taking the ball off the other side now
  // holds it for a beat, during which a mere touch cannot take it back; a
  // deliberate steal (contain, slide) still can.
  const OWNER_DWELL = 0.22;
  const STEAL_GUARD = 0.5;    // s a freshly won ball cannot be stolen straight back
  function canPoach(p){
    if(!ballOwner || ballOwner.side === p.side) return true;
    if(ball.ownerLock > 0) return false;
    // A ball at a man's feet is HIS: brushing past it does not take it. That
    // is what contain (Y) and the slide (X) are for — and what the AI chaser
    // does below. A loose ball (a heavy touch, a pass, a rebound) is anyone's.
    const carried = ballDist(ballOwner) < CARRY_RANGE && ball.z <= REACH_LOW;
    return !carried;
  }

  function registerTouch(team, player){
    lastTouchTeam = team;
    if(!player || ballOwner === player) return;   // same carrier: nothing changed hands
    if(ballOwner && ballOwner.side !== player.side) ball.ownerLock = OWNER_DWELL;
    ballOwner = player;
    if(player.role === 'GK') return;              // keepers are never user-controlled
    const idx = team.outfield.indexOf(player);
    if(idx >= 0) claimControl(team, idx);
  }

  function dribble(p, strength){
    const pdx = ball.x - p.x, pdy = ball.y - p.y;
    const plen = Math.hypot(pdx, pdy) || 1;
    // nudge the ball along the player's heading, so dribbling feels directional
    const fx = p.facing.x, fy = p.facing.y;
    ball.vx += (pdx/plen) * 0.22 + fx * (strength || 0.42);
    ball.vy += (pdy/plen) * 0.22 + fy * (strength || 0.42);
    const bs = Math.hypot(ball.vx, ball.vy);
    const cap = 6.2;
    if(bs > cap){ ball.vx = ball.vx/bs*cap; ball.vy = ball.vy/bs*cap; }
  }

  function teamOf(p){ return p.side === team1.side ? team1 : team2; }

  // `allowFire` is only true for the hard shot on B: a stored fire shot is a
  // shooting power, so passing, clearing or a tap finish never burns it.
  function shoot(p, power, spread, allowFire){
    const tm = teamOf(p);
    let pw = power, sp = spread;
    const fire = allowFire === true && tm.powerup === 'fire';
    if(fire){
      tm.powerup = null;
      tm.powerupTimer = 0;
      pw = power * 1.35;
      sp = (spread || 0) * 0.3;
      shake = Math.max(shake, 14);
      flashStatus('🔥 ¡TIRO DE FUEGO!');
    }
    const kdx = p.facing.x || (p.side === 'left' ? 1 : -1);
    const kdy = p.facing.y;
    const klen = Math.hypot(kdx, kdy) || 1;
    const jitter = (Math.random() - 0.5) * (sp || 0);
    const ang = Math.atan2(kdy/klen, kdx/klen) + jitter;
    ball.vx = Math.cos(ang) * pw;
    ball.vy = Math.sin(ang) * pw;
    ball.spin = (Math.random() - 0.5) * 0.5 + pw * 0.03;
    // A struck ball takes its vertical speed FROM the strike. Leaving whatever
    // vz it happened to have meant a ground shot could inherit a bounce and
    // sail away upwards, which then made the next touch miss entirely.
    // A really hard strike does get under it and climb: harmless at range, but
    // from close in it is what puts a rocket over the bar.
    ball.vz = pw > 14 ? (pw - 14) * 0.17 : 0;
    if(ball.vz > 0) ball.z = Math.max(ball.z, 1);
    // flag it as a genuine shot so goalkeepers only commit to real strikes
    ball.curve     = 0;
    ball.shotTimer = 1.3;
    ball.shotSide  = p.side;
    ball.shotPower = pw;
    ball.shotSweet  = false;
    ball.shotCharge = 0;
    ball.shotFire   = fire;
    // how far out it was struck from: a keeper has time to set himself for a
    // long shot, so distance is part of whether it beats him
    const tgoal = opponentGoal(tm);
    ball.shotDist = Math.hypot(tgoal.x - p.x, tgoal.y - p.y);
    stats.shots[tm.isP1 ? 0 : 1]++;
    ball.shotId++;
    ball.heldBy = null;
    p.kickCooldown = 0.3;
    sfx.kick(Math.min(pw / 16, 1));
    spawnParticles(ball.x, ball.y, 10, {
      angle: ang + Math.PI, spread: 1.3, speed: 3, life: 0.35, size: 3,
      color: 'rgba(220,245,220,0.85)'
    });
  }

  // Nudge a shot toward the goal mouth. You still aim with your heading — this
  // only closes part of the gap, and only when you're already facing that way.
  function aimAtGoal(p, team, strength){
    const goal = opponentGoal(team);
    const gdx = goal.x - p.x, gdy = goal.y - p.y;
    const glen = Math.hypot(gdx, gdy) || 1;
    if(glen > 760) return;                       // too far out to assist
    const flen = Math.hypot(p.facing.x, p.facing.y) || 1;
    const nfx = p.facing.x/flen, nfy = p.facing.y/flen;
    const ngx = gdx/glen,        ngy = gdy/glen;
    const align = nfx*ngx + nfy*ngy;
    if(align < 0.3) return;                      // not facing the goal: your call, not mine
    const k = strength * align;
    const ax = nfx + (ngx - nfx) * k;
    const ay = nfy + (ngy - nfy) * k;
    const alen = Math.hypot(ax, ay) || 1;
    p.facing.x = ax/alen;
    p.facing.y = ay/alen;
  }

  /* ---- lofted pass / cross ----
     Hold sprint while you release the shoot button and you clip it into the
     air instead of along the floor. The charge sets how high it goes, and the
     horizontal speed is solved so it still lands on your target: a light one
     is a fast flat ball anyone can cut out, a full one hangs above everybody
     and drops on the far post. */
  const GRAVITY     = 0.085;   // px per frame squared
  const LOFT_MIN_VZ = 1.45;
  const LOFT_MAX_VZ = 3.65;
  const LOFT_MAX_HS = 15;      // cap on horizontal speed

  function pickPassTarget(team, p){
    let best = null, bestScore = -Infinity;
    const fx = p.facing.x, fy = p.facing.y;
    const flen = Math.hypot(fx, fy) || 1;
    for(const mate of team.outfield){
      if(mate === p) continue;
      if(mate.downTimer > 0 || mate.slideTimer > 0) continue;
      const vx = mate.x - p.x, vy = mate.y - p.y;
      const d = Math.hypot(vx, vy) || 1;
      const align = ((vx/d) * (fx/flen) + (vy/d) * (fy/flen));
      const score = align * 1.6 - d / 900;   // prefer mates ahead of the heading
      if(score > bestScore){ bestScore = score; best = mate; }
    }
    return best;
  }

  function loftedPass(team, p, charge){
    const best = pickPassTarget(team, p);
    let dx, dy, d;
    if(best){
      dx = best.x - p.x; dy = best.y - p.y;
      d = Math.hypot(dx, dy) || 1;
    } else {
      const fl = Math.hypot(p.facing.x, p.facing.y) || 1;
      dx = (p.facing.x/fl) * 360; dy = (p.facing.y/fl) * 360;
      d = 360;
    }
    const vz0    = LOFT_MIN_VZ + (LOFT_MAX_VZ - LOFT_MIN_VZ) * charge;
    const frames = (2 * vz0) / GRAVITY;               // time until it lands
    const hs     = Math.min(d / frames, LOFT_MAX_HS); // solved to land on target

    ball.vx = (dx/d) * hs;
    ball.vy = (dy/d) * hs;
    ball.z  = 2;
    ball.vz = vz0;
    ball.loftTeam = team;
    ball.curve = 0;
    ball.spin = 0.25;
    ball.shotTimer = 0;          // a cross is not a shot: keepers must not read it
    ball.heldBy = null;
    p.kickCooldown = 0.3;
    team.passCooldown = 0.3;
    sfx.pass();
    spawnParticles(ball.x, ball.y, 8, { speed: 2, life: 0.3, size: 3 });
    flashStatus(charge > 0.55 ? '¡Centro colgado!' : 'Pase alto');
  }

  function ballLanded(){
    // a soft feedback beat so it reads as having hit the grass
    spawnParticles(ball.x, ball.y + 4, 10, {
      angle: -Math.PI/2, spread: 2.4, speed: 1.6, life: 0.4, size: 3,
      color: 'rgba(170,215,175,0.8)'
    });
    sfx.wall();
    if(ball.loftTeam){
      const i = ball.loftTeam.isP1 ? 0 : 1;
      rumbleCooldown[i] = 0;
      pressureRumble(ball.loftTeam, 0.5);
    }
    ball.loftTeam = null;
  }

  // A ground pass to where the man WILL be. Aimed at his feet, a 300px pass
  // took ~0.7 s to arrive and a running receiver had moved ~110px by then —
  // every pass to a moving teammate landed behind him.
  const PASS_LEAD = 11;   // frames of the receiver's motion to lead by
  function passToTeammate(team, p){
    const best = pickPassTarget(team, p);
    if(!best) return;
    const lead = { x: best.x + best.vx * PASS_LEAD, y: best.y + best.vy * PASS_LEAD };
    const vx = lead.x - p.x, vy = lead.y - p.y;
    const d = Math.hypot(vx, vy) || 1;
    const power = Math.min(5.8 + d / 85, 13.5);
    ball.vx = (vx/d) * power;
    ball.vy = (vy/d) * power;
    ball.spin = 0.3;
    ball.vz = 0;              // a ground pass is a ground pass
    p.kickCooldown = 0.28;
    team.passCooldown = 0.3;
    sfx.pass();
    spawnParticles(ball.x, ball.y, 6, { speed: 2, life: 0.3, size: 3 });
  }

  /* =========================================================
     Controlled player
     ========================================================= */
  /* ---- curled shot (B + sprint) ----
     A first attempt tied the bend to which way you were leaning, but leaning
     also turns the player, so the two cancelled out and nothing ever curled.
     This instead does what the shot is for: it leaves wide of the keeper and
     bends back in, wrapping around him towards goal.  */
  const CURVE_OPEN = 0.26;    // rad the ball starts off-line before bending back

  function applyCurl(team, p, charge){
    const sp = Math.hypot(ball.vx, ball.vy);
    if(sp < 0.001) return;
    const goal = opponentGoal(team);

    // 1. lean the shot towards the mouth so the curl has something to wrap onto
    const gx = goal.x - ball.x, gy = goal.y - ball.y;
    const gl = Math.hypot(gx, gy) || 1;
    const bias = 0.7;
    let vx = ball.vx / sp * (1 - bias) + (gx/gl) * bias;
    let vy = ball.vy / sp * (1 - bias) + (gy/gl) * bias;
    const vl = Math.hypot(vx, vy) || 1;
    vx /= vl; vy /= vl;

    // 2. open it up to one side — the side the keeper is not expecting
    let dir = Math.sign(goal.y - p.y);
    if(dir === 0) dir = Math.random() < 0.5 ? -1 : 1;
    const open = CURVE_OPEN * (0.7 + 0.3 * charge);
    const ang  = Math.atan2(vy, vx) - dir * open;
    ball.vx = Math.cos(ang) * sp;
    ball.vy = Math.sin(ang) * sp;

    // 3. bend it back by exactly as much as it takes to close on the mouth
    //    again by the time it gets there — hence solving for the flight time
    //    instead of using a fixed strength that only works at one range.
    //    With quadratic drag the ball is still slowing all the way there, so
    //    a constant-speed estimate under-counts the flight by ~40% and the
    //    shot over-bends. This is the closed form for v(t) = v0/(1+k·v0·t).
    const frames = Math.max(12, (Math.exp(DRAG * gl) - 1) / (DRAG * sp));
    ball.curve = dir * (2 * sp * Math.sin(open)) / frames;
    ball.spin  = dir * 0.9;
  }

  const CHARGE_TIME = 0.62;
  const MAX_SHOT    = 17.5;
  const MIN_SHOT    = 9.0;
  // B is a charged hammer: the bar fills slower, and there is an ideal band
  // in the middle of it. Struck inside that band the ball is accurate AND the
  // hardest for a keeper to hold; past it you get more pace but less control.
  const POWER_TIME  = 0.95;   // seconds to fill the B bar
  const POWER_MIN   = 11.0;
  const POWER_MAX   = 24.0;
  const SWEET_MIN   = 0.56;   // ideal band, as a fraction of the bar
  const SWEET_MAX   = 0.74;

  // ---- shot rumble -------------------------------------------------------
  // Kicks near the opponent's goal kick back through the pad. The closer to
  // goal and the harder the strike, the stronger and longer the jolt; shots
  // from outside RUMBLE_RANGE do nothing, so it stays a "this one matters" cue
  // rather than buzzing on every touch.
  const RUMBLE_RANGE = 560;   // px from goal where a shot starts to rumble
  const RUMBLE_PEAK  = 130;   // px from goal at which it is at full strength

  // Kicks near the box also kick the CAMERA, so a shot on goal lands even
  // without a controller attached.
  function shotShake(team, p, power){
    const goal = opponentGoal(team);
    const d = Math.hypot(goal.x - p.x, goal.y - p.y);
    if(d > RUMBLE_RANGE) return;
    const near = clamp01((RUMBLE_RANGE - d) / (RUMBLE_RANGE - RUMBLE_PEAK));
    const hit  = clamp01((power - MIN_SHOT) / (POWER_MAX - MIN_SHOT));
    shake = Math.max(shake, 4 + 11 * (near * 0.65 + hit * 0.35));
  }

  function shotRumble(team, p, power){
    const goal = opponentGoal(team);
    const d = Math.hypot(goal.x - p.x, goal.y - p.y);
    if(d > RUMBLE_RANGE) return false;

    const near  = clamp01((RUMBLE_RANGE - d) / (RUMBLE_RANGE - RUMBLE_PEAK));
    const hit   = clamp01((power - MIN_SHOT) / (POWER_MAX - MIN_SHOT));
    const mix   = near * 0.7 + hit * 0.3;
    const strong = 0.30 + 0.70 * mix;
    return rumble(team.isP1 ? 0 : 1, strong, strong * 0.55, 110 + 150 * mix);
  }

  // ---- close control ----------------------------------------------------
  // While you have the ball it is carried at a fixed point just ahead of your
  // feet instead of being nudged with impulses, so it cannot squirt away on its
  // own. Turning drags it around you; only a kick, a pass or a tackle frees it.
  const CARRY_RANGE  = 58;    // how close the ball must be to be picked up into a carry
  const CARRY_AHEAD  = 15;    // how far in front of the body it sits
  const CARRY_GRIP   = 0.55;  // 0..1 — how tightly it tracks that spot per frame

  function carryBall(p, sprinting){
    const flen = Math.hypot(p.facing.x, p.facing.y) || 1;
    const ahead = p.radius + ball.radius + CARRY_AHEAD + (sprinting ? 10 : 0);
    const tx = p.x + (p.facing.x/flen) * ahead;
    const ty = p.y + (p.facing.y/flen) * ahead;
    const nx = ball.x + (tx - ball.x) * CARRY_GRIP;
    const ny = ball.y + (ty - ball.y) * CARRY_GRIP;
    // drive it by velocity so the rest of the physics (bounds, spin) still applies
    ball.vx = (nx - ball.x);
    ball.vy = (ny - ball.y);
    ball.spin += Math.hypot(ball.vx, ball.vy) * 0.03;
  }

  // ---- face up and steal -------------------------------------------------
  // Hold the contain button to lock your heading onto the ball and close it
  // down. Reach it and you strip it off whoever had it.
  const CONTAIN_REACH = 24;

  function containAndSteal(team, p){
    const bdx = ball.x - p.x, bdy = ball.y - p.y;
    const bd  = Math.hypot(bdx, bdy) || 1;
    p.facing.x = bdx/bd;
    p.facing.y = bdy/bd;

    const owner = ballOwner;
    const theirs = owner && owner.side !== p.side;
    const victim = team === team1 ? team2 : team1;

    // the man being closed down feels it building in his pad before contact
    if(theirs && bd < 190 && !ballLocked(p)){
      const close = 1 - (bd - 40) / 150;
      pressureRumble(victim, 0.18 + 0.42 * Math.max(0, Math.min(1, close)));
    }

    if(bd < p.radius + ball.radius + CONTAIN_REACH && theirs && !ballLocked(p) &&
       ball.z <= REACH_JUMP && ball.stealGuard <= 0){
      // knock it loose, away from the man who had it
      const power = 5.5;
      ball.vx = (bdx/bd) * power;
      ball.vy = (bdy/bd) * power;
      registerTouch(team, p);          // the steal makes you the owner -> you get control
      // and the ball is yours for a beat: without this two men facing up on the
      // same ball traded it four times a second and nobody ever got a shot off
      ball.stealGuard = STEAL_GUARD;
      p.kickCooldown = 0.18;
      sfx.save();
      spawnParticles(ball.x, ball.y, 12, {
        speed: 3.2, life: 0.4, size: 3, color: 'rgba(255,235,170,0.9)'
      });
      stats.steals[team.isP1 ? 0 : 1]++;
      flashStatus('¡Robo del equipo ' + team.name + '!');
      // a sharp jolt for the man robbed, a short one for the man who robbed him
      rumbleCooldown[victim.isP1 ? 0 : 1] = 0;
      pressureRumble(victim, 0.95);
      rumbleCooldown[team.isP1 ? 0 : 1] = 0;
      pressureRumble(team, 0.45);
      return true;
    }
    return false;
  }

  /* ---- slide tackle ----
     A committed, last-ditch challenge: you launch along your heading and win
     anything you touch, but you end up on the floor and out of the game for
     well over a second. That downtime IS the cost — go to ground and miss, and
     the attacker simply runs past the space you used to occupy. */
  const SLIDE_DURATION = 0.34;
  const SLIDE_SPEED    = 9.2;
  const SLIDE_DOWN     = 1.45;   // seconds face-down before you can play again
  const SLIDE_REACH    = 20;

  function startSlide(team, p){
    p.slideTimer = SLIDE_DURATION;
    p.downTimer  = 0;
    p.slideDir   = { x: p.facing.x, y: p.facing.y };
    team.charge = 0;
    team.chargeHeld = false;
    team.powerHeld = false;
    sfx.slide();
    spawnParticles(p.x, p.y + 6, 14, {
      angle: Math.atan2(-p.facing.y, -p.facing.x), spread: 1.2,
      speed: 2.6, life: 0.5, size: 4, color: 'rgba(150,205,155,0.8)'
    });
  }

  // Runs for every player, controlled or not, before anything else moves them.
  // Returns true when the player is mid-slide or on the floor, i.e. not
  // available for normal movement.
  function updateSlide(team, p, dt){
    if(p.slideTimer > 0){
      p.slideTimer -= dt;
      const d = p.slideDir || p.facing;
      const dl = Math.hypot(d.x, d.y) || 1;
      const decay = Math.max(0, p.slideTimer / SLIDE_DURATION);
      p.vx = (d.x/dl) * SLIDE_SPEED * (0.45 + 0.55 * decay);
      p.vy = (d.y/dl) * SLIDE_SPEED * (0.45 + 0.55 * decay);
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      clampToPitch(p);

      // anything you reach on the way through, you win
      if(!ballLocked(p) && ball.z <= REACH_LOW &&
         ballDist(p) < p.radius + ball.radius + SLIDE_REACH){
        const owner = ballOwner;
        if(!owner || owner.side !== p.side){
          const bdx = ball.x - p.x, bdy = ball.y - p.y;
          const bl = Math.hypot(bdx, bdy) || 1;
          ball.vx = (bdx/bl) * 6.5;
          ball.vy = (bdy/bl) * 6.5;
          ball.shotTimer = 0;
          registerTouch(team, p);
          spawnParticles(ball.x, ball.y, 12, {
            speed: 3, life: 0.4, size: 3, color: 'rgba(255,235,170,0.9)'
          });
          stats.steals[team.isP1 ? 0 : 1]++;
          flashStatus('¡Barrida de ' + team.name + '!');
        }
      }

      if(p.slideTimer <= 0){
        p.slideTimer = 0;
        p.downTimer = SLIDE_DOWN;
        p.vx = 0; p.vy = 0;
        // you are on the floor: hand the controls to someone still standing
        if(getControlled(team) === p) switchOffDownedPlayer(team);
      }
      return true;
    }

    if(p.downTimer > 0){
      p.downTimer -= dt;
      p.vx = 0; p.vy = 0;
      if(p.downTimer <= 0) p.downTimer = 0;
      return true;
    }
    return false;
  }

  function switchOffDownedPlayer(team){
    let best = -1, bestD = Infinity;
    team.outfield.forEach((pl, idx) => {
      if(pl.slideTimer > 0 || pl.downTimer > 0) return;
      const d = Math.hypot(ball.x - pl.x, ball.y - pl.y);
      if(d < bestD){ bestD = d; best = idx; }
    });
    if(best >= 0) setControlled(team, best, 0);
  }

  function updateControlledPlayer(team, dt){
    const p = getControlled(team);
    const input = getInputFor(team, dt);

    // on the floor (or committed to a slide): no input gets through
    if(updateSlide(team, p, dt)){
      team.sprintInput = false;
      if(p.kickCooldown > 0) p.kickCooldown -= dt;
      if(team.passCooldown > 0) team.passCooldown -= dt;
      team.passHeld = !!input.pass;
      return;
    }

    const len = Math.hypot(input.dx, input.dy);
    let nx = len > 0.05 ? input.dx/len : 0;
    let ny = len > 0.05 ? input.dy/len : 0;
    // how far the stick is pushed: a nudge is a walk, full is a run. The
    // keyboard and the d-pad give ±1, so they are always at full.
    const mag  = Math.min(1, len);
    const walk = nx || ny ? WALK_MIN + (1 - WALK_MIN) * mag : 0;

    // sprint: the human's sprint is what drags the whole team along (see updateTeamSprint)
    const sprinting = !!input.sprint && (nx !== 0 || ny !== 0);
    // RT runs, RB modifies. They are separate buttons, so holding the modifier
    // is unambiguous — running never turns a shot into a lofted ball.
    const modHeld = !!input.modifier;
    // Containing is a defensive button. With the ball at your own feet it used
    // to lock your heading onto the ball and let you strafe-dribble at +12%
    // with the ball glued, so it is simply ignored while you are the carrier.
    const ownBall = ballOwner === p && ballDist(p) < CARRY_RANGE;
    const containing = !!input.contain && !ownBall;
    // Every burst is an ALTERNATIVE, never a bonus on top of another: the
    // lunge used to multiply with sprint (2.4x), and contain used to multiply
    // with both (sprint+contain was the fastest thing in the game).
    const burst = Math.max(sprinting ? p.sprintMult : 1,
                           p.lungeTimer > 0 ? 1.5 : 1,
                           containing ? 1.12 : 1);
    const spd = p.speed * 1.1 * burst * walk;
    team.sprintInput = sprinting;

    p.vx = nx * spd;
    p.vy = ny * spd;
    // while containing, your heading is locked onto the ball, not your stick
    if((nx !== 0 || ny !== 0) && !containing){ p.facing.x = nx; p.facing.y = ny; }

    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    clampToPitch(p);

    if(p.kickCooldown > 0) p.kickCooldown -= dt;
    if(p.lungeTimer   > 0) p.lungeTimer   -= dt;
    if(p.lungeCd      > 0) p.lungeCd      -= dt;
    if(team.passCooldown > 0) team.passCooldown -= dt;

    // pressing the shoot button is also how you go up for a high ball
    const touching = canTouch(p, !!input.kick || !!input.power) && !ballLocked(p) && canPoach(p);
    if(touching) registerTouch(team, p);

    // you are carrying the ball if you own it and it is still at your feet
    const carrying = ballOwner === p && ballDist(p) < CARRY_RANGE &&
                     p.kickCooldown <= 0 && ball.z <= REACH_LOW;

    // ----- face up and steal (hold) -----
    let stole = false;
    if(containing){
      stole = containAndSteal(team, p);
      team.containing = true;
    } else {
      team.containing = false;
    }

    // ----- shooting: B fills a power bar, A is the placed shot -----
    // B takes priority so holding both does not fight over the same meter.
    const wantPower  = !!input.power;
    const wantPlaced = !!input.kick && !wantPower;
    const canStrike  = carrying || (touching && p.kickCooldown <= 0);

    if(wantPower){
      if(!team.chargeHeld) team.modArmed = false;   // new wind-up: clear the modifier
      const before = team.charge;
      team.charge = Math.min(team.charge + dt / POWER_TIME, 1);
      // The sweet band is ten frames wide and drawn under a moving 16px man,
      // which nobody can watch while lining up a keeper. So it ticks: a bright
      // click and a tap of rumble on the way in, a dull one on the way out.
      if(before < SWEET_MIN && team.charge >= SWEET_MIN){
        sfx.sweetIn(); rumble(team.isP1 ? 0 : 1, 0.25, 0.12, 45);
      } else if(before <= SWEET_MAX && team.charge > SWEET_MAX){
        sfx.sweetOut();
      }
      team.chargeKind = 'power';
      team.chargeHeld = true;
      team.powerHeld  = true;
      if(modHeld) team.modArmed = true;
      if(carrying) carryBall(p, false);          // glued while winding up

    } else if(team.powerHeld){
      const c = team.charge;
      if(canStrike){
        const power   = POWER_MIN + (POWER_MAX - POWER_MIN) * c;
        const sweet   = c >= SWEET_MIN && c <= SWEET_MAX;
        // past the sweet spot you are leaning back on it: more power, less control
        const overhit = Math.max(0, c - SWEET_MAX) / (1 - SWEET_MAX);
        const spread  = sweet ? 0.015 : 0.055 + overhit * 0.11;
        aimAtGoal(p, team, sweet ? 0.80 : 0.55);
        shoot(p, power, spread, true);   // B is the only thing that spends a fire shot
        ball.shotSweet  = sweet;
        ball.shotCharge = c;             // the keeper reads an overhit (see keeperBeatChance)
        // B + a tap of RB curls it around the keeper
        if(team.modArmed || modHeld){
          applyCurl(team, p, c);
          flashStatus('¡Tiro con rosca!');
        }
        shotRumble(team, p, power);
        shotShake(team, p, power);
        if(sweet) flashStatus('¡Golpeo perfecto!');
      } else {
        startLunge(p);
      }
      team.charge = 0;
      team.chargeHeld = false;
      team.powerHeld  = false;
      team.chargeKind = null;
      team.modArmed = false;

    } else if(wantPlaced){
      if(!team.chargeHeld) team.modArmed = false;   // new wind-up: clear the modifier
      team.charge = Math.min(team.charge + dt / CHARGE_TIME, 1);
      team.chargeKind = 'placed';
      team.chargeHeld = true;
      if(modHeld) team.modArmed = true;
      if(carrying) carryBall(p, false);

    } else if(team.chargeHeld){
      const power = MIN_SHOT + (MAX_SHOT - MIN_SHOT) * team.charge;
      if(canStrike && (team.modArmed || modHeld)){
        loftedPass(team, p, team.charge);     // A + a tap of RB clips it into the air
        shotRumble(team, p, power * 0.6);
      } else if(canStrike){
        // the harder you hit it, the more it counts as a shot on goal
        aimAtGoal(p, team, 0.30 + 0.32 * team.charge);
        shoot(p, power, 0.04);
        shotRumble(team, p, power);
        shotShake(team, p, power);
      } else {
        startLunge(p);   // no ball nearby: burst forward as a tackle/lunge
      }
      team.charge = 0;
      team.chargeHeld = false;
      team.chargeKind = null;
      team.modArmed = false;

    } else if(carrying && !stole){
      carryBall(p, sprinting);            // close control: the ball stays on your feet
    } else if(touching && p.kickCooldown <= 0 && !stole){
      dribble(p, sprinting ? 0.55 : 0.4);
    }

    // ----- X: pass with the ball, slide tackle without it -----
    if(input.pass && !team.passHeld){
      if((carrying || touching) && team.passCooldown <= 0 && p.kickCooldown <= 0){
        if(modHeld){
          // X + the modifier chips it: a lofted pass on the pass button, with
          // the arc worked out from how far it actually has to travel
          const mate = pickPassTarget(team, p);
          const far  = mate ? Math.hypot(mate.x - p.x, mate.y - p.y) : 360;
          loftedPass(team, p, Math.max(0.25, Math.min(far / 620, 1)));
        } else {
          passToTeammate(team, p);
        }
      } else if(p.slideTimer <= 0 && p.downTimer <= 0 &&
                !(ballOwner && ballOwner.side === p.side && ballDist(p) < CARRY_RANGE * 1.4)){
        // pressing X next to a TEAMMATE's ball is asking for it, not a tackle:
        // it used to commit you to a 1.45 s slide at your own man's feet
        startSlide(team, p);
      }
    }
    team.passHeld = !!input.pass;

    // running dust
    if((sprinting || p.lungeTimer > 0) && Math.random() < 0.4){
      spawnParticles(p.x - p.facing.x * p.radius, p.y - p.facing.y * p.radius + 6, 1, {
        speed: 0.8, life: 0.35, size: 3, color: 'rgba(160,210,165,0.55)'
      });
    }
  }

  // A burst you can spam is just a speed boost, so it has to cost something:
  // once used it is locked out for LUNGE_COOLDOWN seconds.
  const LUNGE_TIME     = 0.22;
  const LUNGE_COOLDOWN = 0.85;

  function startLunge(p){
    if(p.lungeCd > 0) return;
    p.lungeTimer = LUNGE_TIME;
    p.lungeCd    = LUNGE_COOLDOWN;
  }

  function clampToPitch(p){
    p.x = Math.max(FIELD_MARGIN + p.radius, Math.min(W - FIELD_MARGIN - p.radius, p.x));
    p.y = Math.max(FIELD_MARGIN + p.radius, Math.min(H - FIELD_MARGIN - p.radius, p.y));
  }

  /* =========================================================
     Team shape + "everybody runs when you run"
     ========================================================= */
  const AI_PULL       = { DEF:{x:0.20, y:0.34}, MID:{x:0.34, y:0.44}, FWD:{x:0.42, y:0.46} };
  const ROLE_ADVANCE  = { DEF:0.62, MID:0.95, FWD:1.28 };
  const MAX_ADVANCE   = 150;
  const AI_FINISH_RANGE  = 380;   // px from goal inside which a teammate finishes first time instead of handing you the ball
  const AI_CONTAIN_RANGE = 80;    // px from the ball at which a chaser starts to close a carrier down
  const AI_CONTAIN_DELAY = 0.75;  // s of pressure before he actually takes it: a B wind-up is ~0.8 s, so you can still get a shot away if you are quick
  const ADVANCE_SMOOTH= 1.7;
  const SPRINT_RAMP   = 4.5;   // how fast teammates pick up the pace
  const SPRINT_DECAY  = 2.4;   // how fast they settle back down

  function updateTeamAdvance(team, dt){
    const normBallX = (ball.x - FIELD_MARGIN) / (W - FIELD_MARGIN*2);
    const target = team.side === 'left'
      ? (normBallX - 0.5) * 2 * MAX_ADVANCE
      : (0.5 - normBallX) * 2 * MAX_ADVANCE;
    team.advance += (target - team.advance) * Math.min(1, dt * ADVANCE_SMOOTH);
  }

  // The controlled player's sprint (or a lunge, or a teammate chasing a loose
  // ball) pulls the entire team into a run — teammates accelerate together.
  function updateTeamSprint(team, dt){
    const controlled = getControlled(team);
    const chasingLoose = lastTouchTeam !== team &&
                         Math.hypot(ball.vx, ball.vy) > 5 &&
                         ballIsInHalf(team, 'own');
    const wantRun = team.sprintInput || controlled.lungeTimer > 0 || chasingLoose;
    const rate = wantRun ? SPRINT_RAMP : -SPRINT_DECAY;
    team.teamSprint = Math.max(0, Math.min(1, team.teamSprint + rate * dt));
  }

  function ballIsInHalf(team, which){
    const ownSide = team.side === 'left' ? ball.x < halfW : ball.x > halfW;
    return which === 'own' ? ownSide : !ownSide;
  }

  function opponentGoal(team){
    return { x: team.side === 'left' ? W - FIELD_MARGIN : FIELD_MARGIN, y: H/2 };
  }

  /* =========================================================
     Outfield AI
     ========================================================= */
  function updateAiOutfield(team, dt){
    // one AI teammate is nominated to actually chase the ball, so the team
    // doesn't either swarm it or ignore it completely
    let chaserIdx = -1, chaserDist = Infinity;
    team.outfield.forEach((pl, idx) => {
      if(idx === team.controlledIndex) return;
      const d = Math.hypot(ball.x - pl.x, ball.y - pl.y);
      if(d < chaserDist){ chaserDist = d; chaserIdx = idx; }
    });
    // Teammates contest any loose ball, but back off the moment the human is
    // actually on it — otherwise they crowd you and you fight your own side.
    const controlledDist = Math.hypot(ball.x - getControlled(team).x, ball.y - getControlled(team).y);
    // They stand down only when the human is BOTH near the ball and nearer than
    // they are; without that second half the team can deadlock, all deferring to
    // a controlled player who is close to the ball but not actually on it.
    const humanOnBall = controlledDist < KEEP_BALL_RANGE + 10;
    const chaseAllowed = chaserDist < controlledDist + 110 &&
                         !(humanOnBall && controlledDist < chaserDist);
    // shape depends on phase: with the ball in their half, we push men forward
    const attacking = lastTouchTeam === team && ballIsInHalf(team, 'opp');
    const fwdDir    = team.side === 'left' ? 1 : -1;
    const boxEdge   = team.side === 'left' ? W - FIELD_MARGIN - 48 : FIELD_MARGIN + 48;

    team.outfield.forEach((pl, idx) => {
      if(idx === team.controlledIndex) return;
      if(updateSlide(team, pl, dt)) return;   // sliding or face-down

      if(pl.kickCooldown > 0) pl.kickCooldown -= dt;

      const pull = AI_PULL[pl.role];
      const advanceX = team.advance * ROLE_ADVANCE[pl.role] * (team.side === 'left' ? 1 : -1);
      const dynamicHomeX = pl.home.x + advanceX;

      let targetX, targetY, urgency = 0.86;

      if(idx === chaserIdx && chaseAllowed){
        // go get the ball, slightly on the goal side of it
        const goal = opponentGoal(team);
        const gdx = goal.x - ball.x, gdy = goal.y - ball.y;
        const glen = Math.hypot(gdx, gdy) || 1;
        targetX = ball.x - (gdx/glen) * 16;
        targetY = ball.y - (gdy/glen) * 16;
        urgency = 1.0;
      } else if(attacking && pl.role === 'FWD'){
        // Get in the box. The ball-following shape could never put a forward
        // past the 18-yard line (a left FWD topped out at x≈1193 against a box
        // edge of 1404), so every attack was a solo run with nobody to cross to.
        // The two forwards split the goal mouth: one near post, one far.
        targetX = ball.x + fwdDir * 190;
        targetX = fwdDir > 0 ? Math.min(targetX, boxEdge) : Math.max(targetX, boxEdge);
        targetY = H/2 + (pl.slot >= 0 ? 1 : -1) * GOAL_WIDTH * 0.42;
        urgency = 0.95;
      } else if(attacking && pl.role === 'MID'){
        // square support, holding width for the cut-back
        targetX = ball.x - fwdDir * 70;
        targetY = pl.home.y + (ball.y - pl.home.y) * 0.30;
      } else {
        targetX = dynamicHomeX + (ball.x - dynamicHomeX) * pull.x;
        targetY = pl.home.y   + (ball.y - pl.home.y)   * pull.y;
        // keep the two players of a line from stacking on the same spot
        const mate = team.outfield.find(o => o !== pl && o.role === pl.role);
        if(mate){
          const dy = pl.y - mate.y;
          if(Math.abs(dy) < 90) targetY += (pl.slot >= 0 ? 1 : -1) * 70;
        }
      }

      targetX = Math.max(FIELD_MARGIN + pl.radius, Math.min(W - FIELD_MARGIN - pl.radius, targetX));
      targetY = Math.max(FIELD_MARGIN + pl.radius, Math.min(H - FIELD_MARGIN - pl.radius, targetY));

      const dx = targetX - pl.x, dy = targetY - pl.y;
      const d  = Math.hypot(dx, dy);

      // >>> teammates run when the human runs <<<
      const sprintBoost = 1 + (pl.sprintMult - 1) * team.teamSprint;
      const spd = pl.speed * urgency * sprintBoost;

      if(d > 3){
        pl.vx = (dx/d) * spd;
        pl.vy = (dy/d) * spd;
        pl.facing.x = dx/d;
        pl.facing.y = dy/d;
      } else { pl.vx = 0; pl.vy = 0; }

      pl.x += pl.vx * dt * 60;
      pl.y += pl.vy * dt * 60;
      clampToPitch(pl);

      // A defender closing down a carrier does what a human does: faces up
      // and takes it — but not instantly. The dribbler gets a window to move
      // it on, which is what makes the pressure readable instead of a wall.
      const foeCarrying = ballOwner && ballOwner.side !== team.side &&
                          ballDist(ballOwner) < CARRY_RANGE && ball.z <= REACH_LOW;
      if(idx === chaserIdx && foeCarrying && ballDist(pl) < AI_CONTAIN_RANGE && ball.stealGuard <= 0){
        pl.containT = (pl.containT || 0) + dt;
        if(pl.containT > AI_CONTAIN_DELAY && containAndSteal(team, pl)) return;
      } else {
        pl.containT = 0;
      }

      // AI ball interaction: shoot near goal, otherwise drive the ball forward
      if(canTouch(pl, true) && !ballLocked(pl) && canPoach(pl)){
        registerTouch(team, pl);   // a change of owner hands you the controls
        // ...and if it just did, this is YOUR man now. He used to fire a shot
        // on the very frame he became yours — "I got the ball and it just
        // booted it away" — because the controlled check ran before the touch.
        const goal = opponentGoal(team);
        const distToGoal = Math.hypot(goal.x - pl.x, goal.y - pl.y);
        // ...but a striker meeting a cross or a rebound in front of goal still
        // finishes first time: that is the one boot you DO want him to take.
        // The machine has no "me" to annoy, so it keeps the whole old behaviour.
        const finishing = distToGoal < AI_FINISH_RANGE && ballIsInHalf(team, 'opp');
        if(getControlled(team) === pl && !isCpu(team) && !finishing) return;
        if(pl.kickCooldown <= 0 && distToGoal < 470 && ballIsInHalf(team, 'opp')){
          const gdx = goal.x - pl.x, gdy = (goal.y + (Math.random()-0.5)*GOAL_WIDTH*0.55) - pl.y;
          const glen = Math.hypot(gdx, gdy) || 1;
          pl.facing.x = gdx/glen; pl.facing.y = gdy/glen;
          shoot(pl, 13 + Math.random()*3, 0.09);
        } else if(pl.kickCooldown <= 0){
          const gdx = goal.x - pl.x, gdy = goal.y - pl.y;
          const glen = Math.hypot(gdx, gdy) || 1;
          pl.facing.x = gdx/glen; pl.facing.y = gdy/glen;
          dribble(pl, 0.45);
        }
      }

      if(team.teamSprint > 0.5 && Math.random() < 0.12){
        spawnParticles(pl.x, pl.y + 6, 1, {
          speed: 0.7, life: 0.3, size: 2.5, color: 'rgba(160,210,165,0.45)'
        });
      }
    });
  }

  /* =========================================================
     Goalkeeper AI
     States: idle -> (shuffle | diving | rushing) -> holding -> recovering

     The old keeper dove at anything moving quickly towards goal, which made it
     trivial to beat: walk in, wait for the dive, roll it into the empty side.
     This one only leaves its feet for a genuine SHOT that is genuinely out of
     reach, and otherwise stays up and shuffles across — so the dive can no
     longer be baited, and beating it means actually placing the ball.
     ========================================================= */
  const GK_IDLE_SPEED       = 2.9;
  const GK_SHUFFLE_SPEED    = 4.3;   // fast on-feet sidestep: no recovery cost
  const GK_DIVE_SPEED       = 8.4;
  const GK_RUSH_SPEED       = 4.1;   // coming off the line to claim a loose ball
  const GK_DIVE_DURATION    = 0.30;
  const GK_RECOVER_DURATION = 1.15;
  const GK_HOLD_DURATION    = 0.7;   // time spent holding it before distributing
  const GK_HOLD_SPACE       = 62;    // px of room opponents must give him while he holds
  const GK_RUSH_RANGE       = 340;   // how far off the line it will come
  const GK_REACH            = 70;    // lateral gap that actually justifies a dive
  const GK_READ_ACCURACY    = 0.74;  // how often he reads the shot instead of guessing
  const GK_REACTION_MIN     = 0.11;  // s of reaction time before he commits to anything
  const GK_REACTION_MAX     = 0.27;

  function ownGoalCentre(gk){
    return { x: gk.side === 'left' ? FIELD_MARGIN : W - FIELD_MARGIN, y: H/2 };
  }

  // Where the ball will cross the goal line, and how far the keeper must travel
  // sideways to be there. This is the number the dive decision is made on.
  function predictAtLine(gk){
    const lineX = gk.side === 'left' ? FIELD_MARGIN + 26 : W - FIELD_MARGIN - 26;
    const vx = ball.vx;
    const closing = gk.side === 'left' ? vx < -0.5 : vx > 0.5;
    if(!closing) return null;
    // velocities are per-frame, so this is a count of FRAMES, not seconds
    const frames = (lineX - ball.x) / vx;
    if(frames < 0 || frames > 170) return null;      // ~2.8 s away: too early to read
    // friction scales vx and vy equally, so the straight-line path is exact;
    // the 0.94 is a deliberate slight under-read to keep the keeper beatable
    return { y: ball.y + ball.vy * frames * 0.94, frames };
  }

  function nearestOpponentDist(team, x, y){
    let best = Infinity;
    const foes = team === team1 ? team2 : team1;
    for(const f of foes.outfield){
      const d = Math.hypot(f.x - x, f.y - y);
      if(d < best) best = d;
    }
    return best;
  }

  // Throw/roll it to the teammate with the most space, favouring someone who is
  // ahead of the keeper rather than square with it.
  function goalkeeperDistribute(team, gk){
    let best = null, bestScore = -Infinity;
    const fwd = gk.side === 'left' ? 1 : -1;
    for(const mate of team.outfield){
      const space   = nearestOpponentDist(team, mate.x, mate.y);
      const advance = (mate.x - gk.x) * fwd;
      const reach   = Math.hypot(mate.x - gk.x, mate.y - gk.y);
      if(reach < 60) continue;
      const score = space * 1.0 + advance * 0.35 - Math.max(0, reach - 520) * 0.8;
      if(score > bestScore){ bestScore = score; best = mate; }
    }
    ball.heldBy = null;
    ball.releaseGuard = 0.4;      // nobody challenges a keeper's release
    ball.releaseSide = gk.side;
    if(!best){
      // nobody to aim at: just clear it upfield
      const dirY = (Math.random() - 0.5) * 1.1;
      const len  = Math.hypot(fwd, dirY) || 1;
      ball.vx = (fwd/len) * 11;
      ball.vy = (dirY/len) * 11;
    } else {
      const vx = best.x - gk.x, vy = best.y - gk.y;
      const d  = Math.hypot(vx, vy) || 1;
      const power = Math.min(6.5 + d / 75, 14);
      ball.vx = (vx/d) * power;
      ball.vy = (vy/d) * power;
      flashStatus('Saque del arquero ' + team.name);
    }
    ball.spin = 0.3;
    ball.shotTimer = 0;
    gk.kickCooldown = 0.5;
    sfx.pass();
    spawnParticles(ball.x, ball.y, 8, { speed: 2.4, life: 0.35, size: 3 });
  }

  // How likely the ball is to get past a keeper who reaches it. Pure power
  // helps, a clean strike (the sweet spot on the B bar) helps more, and a fire
  // shot is very hard to stop. Nothing here models hands or legs — the keeper
  // simply fades out for a moment and the ball goes through.
  const BEAT_CAP   = 0.62;
  const BEAT_CLOSE = 210;   // px from goal: inside this, distance costs nothing
  const BEAT_FAR   = 780;   // px from goal: at or past this, the keeper is set
  const BEAT_FAR_MULT = 0.20;

  // Distance is the strongest damper of all: from range the keeper simply has
  // time to get across and set himself, so even a perfectly struck shot into
  // his chest is very unlikely to squirm through.
  function beatDistanceMult(){
    const d = ball.shotDist || 0;
    const near = clamp01((BEAT_FAR - d) / (BEAT_FAR - BEAT_CLOSE));
    return BEAT_FAR_MULT + (1 - BEAT_FAR_MULT) * near;
  }

  function keeperBeatChance(){
    const dm = beatDistanceMult();
    // a fire shot still loses some of its edge from distance, but not all
    if(ball.shotFire) return 0.80 * Math.max(dm, 0.55);
    const n = clamp01((ball.shotPower - MIN_SHOT) / (POWER_MAX - MIN_SHOT));
    let c = 0.06 + 0.30 * n;
    if(ball.shotSweet) c += 0.12;   // helps, but never a guarantee
    // Leaning back on it past the sweet band is the easy option — you just
    // hold the button — and it used to be nearly as good (36% vs 41%). Now an
    // overhit goes at the keeper harder but is much easier for him to hold.
    const overhit = clamp01(((ball.shotCharge || 0) - SWEET_MAX) / (1 - SWEET_MAX));
    c *= 1 - overhit * 0.45;
    return Math.min(c, BEAT_CAP) * dm;
  }

  const BEATEN_FLAVOURS = [
    'Se le escapa de las manos',
    'Se le cuela por debajo',
    'Le pasa por encima',
    'No la puede sujetar'
  ];

  function keeperBeaten(team, gk){
    // push the ball just past him so it does not re-collide next frame
    const sp = Math.hypot(ball.vx, ball.vy) || 1;
    ball.x += (ball.vx / sp) * (gk.radius + ball.radius + 6);
    ball.y += (ball.vy / sp) * (gk.radius + ball.radius + 6);
    ball.vx *= 0.78;
    ball.vy *= 0.78;
    gk.beatenTimer = 0.85;          // drawn faded while this runs
    gk.kickCooldown = 0.55;         // cannot grab it again on the way through
    gk.state = 'recovering';
    gk.stateTimer = 0;
    sfx.wall();
    spawnParticles(ball.x, ball.y, 14, {
      speed: 2.6, life: 0.45, size: 3, color: 'rgba(255,255,255,0.7)'
    });
    flashStatus(BEATEN_FLAVOURS[Math.floor(Math.random() * BEATEN_FLAVOURS.length)] + '…');
  }

  function updateGoalkeeper(team, dt){
    const gk = team.gk;
    const topY = topGoalY + gk.radius + 4;
    const botY = botGoalY - gk.radius - 4;
    const goal = ownGoalCentre(gk);

    if(gk.state === undefined){
      gk.state = 'idle'; gk.stateTimer = 0; gk.diveTarget = null;
      gk.readShot = -1; gk.shuffleY = H/2;
      gk.reactTimer = 0; gk.reactShot = -1;
    }
    if(gk.kickCooldown > 0) gk.kickCooldown -= dt;
    if(gk.beatenTimer > 0) gk.beatenTimer -= dt;
    if(gk.reactTimer === undefined){ gk.reactTimer = 0; gk.reactShot = -1; }

    const liveShot = ball.shotTimer > 0 && ball.shotSide !== gk.side;
    const ballFromGoal = Math.hypot(ball.x - goal.x, ball.y - goal.y);

    /* ---------- holding: it has the ball, then plays it out ---------- */
    if(gk.state === 'holding'){
      gk.stateTimer += dt;
      ball.heldBy = gk;
      // opponents have to give him room: they cannot camp on his toes waiting
      // for the release, exactly as they must back off in the real game
      const foes = team === team1 ? team2 : team1;
      let pressed = false;
      for(const f of foes.outfield){
        const dx = f.x - gk.x, dy = f.y - gk.y;
        const d = Math.hypot(dx, dy);
        if(d < GK_HOLD_SPACE && d > 0.001){
          pressed = true;
          const push = (GK_HOLD_SPACE - d);
          f.x += (dx/d) * push;
          f.y += (dy/d) * push;
          clampToPitch(f);
        }
      }
      // if he is still being closed down, he holds on a little longer
      if(pressed && gk.stateTimer > GK_HOLD_DURATION * 0.5){
        gk.stateTimer -= dt * 0.6;
      }
      ball.vx = 0; ball.vy = 0;
      const fx = gk.side === 'left' ? 1 : -1;
      ball.x = gk.x + fx * (gk.radius + ball.radius + 2);
      ball.y = gk.y;
      // walk back towards the line while holding it
      const dx = gk.home.x - gk.x, dy = gk.home.y - gk.y;
      const d = Math.hypot(dx, dy);
      if(d > 6){ gk.vx = (dx/d) * 2.6; gk.vy = (dy/d) * 2.6; }
      else { gk.vx = 0; gk.vy = 0; }
      gk.x += gk.vx * dt * 60;
      gk.y += gk.vy * dt * 60;
      clampToPitch(gk);
      if(gk.stateTimer >= GK_HOLD_DURATION){
        goalkeeperDistribute(team, gk);
        gk.state = 'idle'; gk.stateTimer = 0;
      }
      return;
    }

    /* ---------- see the shot, then react to it ----------
       He never moves before the ball is struck. On the strike he starts a
       reaction clock, and only when that runs out does he commit — and the way
       he commits is a guess: most of the time he reads it right, sometimes he
       picks a side and goes the wrong way. That is what makes him beatable
       without being bait-able. */
    if((gk.state === 'idle' || gk.state === 'shuffle' || gk.state === 'rushing') &&
       liveShot && ball.shotId !== gk.readShot && gk.reactTimer <= 0){
      gk.readShot = ball.shotId;
      gk.reactTimer = GK_REACTION_MIN + Math.random() * (GK_REACTION_MAX - GK_REACTION_MIN);
      gk.reactShot = ball.shotId;
    }

    if(gk.reactTimer > 0){
      gk.reactTimer -= dt;
      if(gk.reactTimer <= 0 && ball.shotTimer > 0 && ball.shotId === gk.reactShot &&
         (gk.state === 'idle' || gk.state === 'shuffle' || gk.state === 'rushing')){
        const pred = predictAtLine(gk);
        let targetY;
        if(pred && Math.random() < GK_READ_ACCURACY){
          targetY = pred.y;                       // read it correctly
        } else {
          // guessed: commits to a side, which may well be the wrong one
          const side = Math.random() < 0.5 ? -1 : 1;
          targetY = H/2 + side * (GOAL_WIDTH * (0.28 + Math.random() * 0.26));
        }
        targetY = Math.max(topY - 40, Math.min(botY + 40, targetY));
        const gap = Math.abs(targetY - gk.y);
        if(gap > GK_REACH){
          gk.diveTarget = { x: gk.home.x + (gk.side === 'left' ? 26 : -26), y: targetY };
          gk.state = 'diving';
          gk.stateTimer = 0;
        } else {
          gk.shuffleY = targetY;
          gk.state = 'shuffle';
          gk.stateTimer = 0;
        }
      }
    }

    /* ---------- come off the line for a loose ball ---------- */
    if(gk.state === 'idle' && !liveShot && ballFromGoal < GK_RUSH_RANGE){
      const owner = ballOwner;
      const mine  = owner && owner.side === gk.side;
      const gkDist = ballDist(gk);
      const foeDist = nearestOpponentDist(team, ball.x, ball.y);
      // only if it is not a teammate's ball and the keeper genuinely gets there first
      if(!mine && gkDist < foeDist - 25 && gkDist < GK_RUSH_RANGE){
        gk.state = 'rushing';
        gk.stateTimer = 0;
      }
    }

    /* ---------- movement per state ---------- */
    if(gk.state === 'diving'){
      gk.stateTimer += dt;
      const dx = gk.diveTarget.x - gk.x, dy = gk.diveTarget.y - gk.y;
      const d = Math.hypot(dx, dy);
      if(d > 2){
        gk.vx = (dx/d) * GK_DIVE_SPEED;
        gk.vy = (dy/d) * GK_DIVE_SPEED;
        gk.facing.x = dx/d; gk.facing.y = dy/d;
      } else { gk.vx = 0; gk.vy = 0; }
      if(gk.stateTimer >= GK_DIVE_DURATION || d <= 2){
        gk.state = 'recovering'; gk.stateTimer = 0;
      }

    } else if(gk.state === 'recovering'){
      gk.stateTimer += dt;
      gk.vx *= 0.8; gk.vy *= 0.8;
      if(gk.stateTimer >= GK_RECOVER_DURATION){ gk.state = 'idle'; gk.stateTimer = 0; }

    } else if(gk.state === 'shuffle'){
      // stays on its feet and steps across: quick, and with no recovery penalty
      gk.stateTimer += dt;
      const targetY = Math.max(topY, Math.min(botY, gk.shuffleY));
      const targetX = gk.home.x + (gk.side === 'left' ? 22 : -22);
      const dx = targetX - gk.x, dy = targetY - gk.y;
      const d = Math.hypot(dx, dy);
      if(d > 2){
        gk.vx = (dx/d) * GK_SHUFFLE_SPEED;
        gk.vy = (dy/d) * GK_SHUFFLE_SPEED;
        gk.facing.x = dx/d; gk.facing.y = dy/d;
      } else { gk.vx = 0; gk.vy = 0; }
      if(!liveShot || gk.stateTimer > 1.6){ gk.state = 'idle'; gk.stateTimer = 0; }

    } else if(gk.state === 'rushing'){
      gk.stateTimer += dt;
      const dx = ball.x - gk.x, dy = ball.y - gk.y;
      const d = Math.hypot(dx, dy) || 1;
      gk.vx = (dx/d) * GK_RUSH_SPEED;
      gk.vy = (dy/d) * GK_RUSH_SPEED;
      gk.facing.x = dx/d; gk.facing.y = dy/d;
      const foeDist = nearestOpponentDist(team, ball.x, ball.y);
      const owner = ballOwner;
      // give up if it was a bad idea after all
      if(gk.stateTimer > 2.2 || ballFromGoal > GK_RUSH_RANGE + 90 ||
         foeDist < d - 30 || (owner && owner.side === gk.side) || liveShot){
        gk.state = 'idle'; gk.stateTimer = 0;
      }

    } else { // idle: hold the line, tracking the ball across the mouth
      const shrink = Math.max(0, Math.min(1, (520 - ballFromGoal) / 520));
      let targetY = Math.max(topY, Math.min(botY, H/2 + (ball.y - H/2) * (0.55 + 0.45*shrink)));
      const targetX = gk.home.x + (gk.side === 'left' ? 1 : -1) * (8 + 22 * shrink);
      const dx = targetX - gk.x, dy = targetY - gk.y;
      const d = Math.hypot(dx, dy);
      if(d > 2){
        const spd = GK_IDLE_SPEED * (1 + shrink * 0.55);
        gk.vx = (dx/d) * spd;
        gk.vy = (dy/d) * spd;
        gk.facing.x = dx/d; gk.facing.y = dy/d;
      } else { gk.vx = 0; gk.vy = 0; }
    }

    gk.x += gk.vx * dt * 60;
    gk.y += gk.vy * dt * 60;
    clampToPitch(gk);

    /* ---------- contact with the ball ---------- */
    const inBox = gk.side === 'left'
      ? ball.x < FIELD_MARGIN + PENALTY_BOX_DEPTH + 20
      : ball.x > W - FIELD_MARGIN - PENALTY_BOX_DEPTH - 20;

    if(ballDist(gk) < gk.radius + ball.radius + 8 && ball.z <= REACH_KEEPER &&
        gk.kickCooldown <= 0){
      const wasShot = liveShot;

      // A keeper getting a hand to it is not the same as holding it. The harder
      // and cleaner the strike, the likelier it squirms through — so shooting
      // straight at him is no longer an automatic save.
      if(wasShot && Math.random() < keeperBeatChance()){
        keeperBeaten(team, gk);
        return;
      }

      registerTouch(team, gk);
      if(inBox){
        // inside the area it can pick the ball up and play it out properly
        gk.state = 'holding';
        gk.stateTimer = 0;
        ball.heldBy = gk;
        ball.vx = 0; ball.vy = 0;
        ball.shotTimer = 0;
        sfx.save();
        spawnParticles(ball.x, ball.y, 14, {
          speed: 3, life: 0.45, size: 3, color: 'rgba(255,255,255,0.85)'
        });
        if(wasShot){
          stats.saves[team.isP1 ? 0 : 1]++;
          stats.onTarget[team.isP1 ? 1 : 0]++;   // the OTHER side put it on target
          flashStatus('¡Atajada del arquero ' + team.name + '!', 'play');
        }
      } else {
        // outside the area it cannot handle it, so it plays it away with its
        // feet — still aimed at a teammate where there is one, just less precise
        let target = null, bestScore = -Infinity;
        const fwd = gk.side === 'left' ? 1 : -1;
        for(const mate of team.outfield){
          const reach = Math.hypot(mate.x - gk.x, mate.y - gk.y);
          if(reach < 80 || reach > 700) continue;
          const score = nearestOpponentDist(team, mate.x, mate.y) + (mate.x - gk.x) * fwd * 0.3;
          if(score > bestScore){ bestScore = score; target = mate; }
        }
        let ax, ay;
        if(target){
          ax = target.x - gk.x; ay = target.y - gk.y;
        } else {
          ax = fwd; ay = (Math.random() - 0.5) * 1.2;
        }
        const alen = Math.hypot(ax, ay) || 1;
        const jitter = (Math.random() - 0.5) * 0.25;    // hurried clearance
        const ang = Math.atan2(ay/alen, ax/alen) + jitter;
        ball.vx = Math.cos(ang) * 12;
        ball.vy = Math.sin(ang) * 12;
        ball.shotTimer = 0;
        gk.kickCooldown = 0.5;
        sfx.kick(0.7);
        if(gk.state === 'rushing'){ gk.state = 'idle'; gk.stateTimer = 0; }
      }
    }
  }

  /* =========================================================
     Physics
     ========================================================= */
  function resolveAllCollisions(){
    const list = allPlayers();
    for(let i = 0; i < list.length; i++){
      for(let j = i + 1; j < list.length; j++){
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius;
        if(dist < minDist && dist > 0){
          const overlap = (minDist - dist) / 2;
          const nx = dx/dist, ny = dy/dist;
          a.x -= nx*overlap; a.y -= ny*overlap;
          b.x += nx*overlap; b.y += ny*overlap;
          clampToPitch(a); clampToPitch(b);
        }
      }
    }
  }

  /* =========================================================
     Ball physics
     Three things the old model got wrong and this one does not:

     1. Drag was a flat multiply per frame, so a rocket and a roller lost the
        same FRACTION of speed. Real drag grows with the square of speed, so a
        hard shot bleeds pace fast and then coasts, while a gentle pass keeps
        trickling. Rolling resistance is separate and only applies on the deck.
     2. It bounced once and died. Now it has restitution and will bounce a few
        times, losing height each time, and the ground bite turns some of the
        spin into roll.
     3. Posts and the crossbar did not exist — shots went straight through the
        woodwork and a ball 200px in the air still counted as a goal. Both are
        now solid, and a goal has to pass under the bar.

     Everything is integrated in substeps, because at 24 px/frame the ball used
     to skip clean through a post between one frame and the next.
     ========================================================= */
  const DRAG        = 0.00075;  // quadratic air drag
  const ROLL_FRIC   = 0.045;    // rolling resistance, ground only, px/frame^2
  const BOUNCE_Z    = 0.55;     // how much height it keeps per bounce
  const BOUNCE_BITE = 0.82;     // ground grabbing the ball on impact
  const BOUNCE_STOP = 0.55;     // below this vertical speed it settles
  const POST_R      = 4.5;
  const POST_REST   = 0.72;     // woodwork gives almost nothing back
  const WALL_REST   = 0.62;

  function woodwork(side){
    const gx = side === 'left' ? FIELD_MARGIN : W - FIELD_MARGIN;
    return { gx, top: topGoalY, bot: botGoalY };
  }

  // vertical posts, one at each end of the mouth
  function hitPosts(){
    for(const side of ['left', 'right']){
      const g = woodwork(side);
      for(const py of [g.top, g.bot]){
        const dx = ball.x - g.gx, dy = ball.y - py;
        const d  = Math.hypot(dx, dy);
        const min = ball.radius + POST_R;
        if(d < min && d > 1e-6 && ball.z < GOAL_H_PX + POST_R){
          const nx = dx / d, ny = dy / d;
          ball.x = g.gx + nx * min;
          ball.y = py   + ny * min;
          const vn = ball.vx * nx + ball.vy * ny;
          if(vn < 0){
            ball.vx -= (1 + POST_REST) * vn * nx;
            ball.vy -= (1 + POST_REST) * vn * ny;
            clang();
          }
          return true;
        }
      }
    }
    return false;
  }

  // the crossbar: a horizontal bar across the mouth at goal height
  function hitCrossbar(){
    for(const side of ['left', 'right']){
      const g = woodwork(side);
      if(ball.y < g.top || ball.y > g.bot) continue;
      const dx = ball.x - g.gx, dz = ball.z - GOAL_H_PX;
      const d  = Math.hypot(dx, dz);
      const min = ball.radius + POST_R;
      if(d < min && d > 1e-6){
        const nx = dx / d, nz = dz / d;
        ball.x = g.gx     + nx * min;
        ball.z = GOAL_H_PX + nz * min;
        const vn = ball.vx * nx + ball.vz * nz;
        if(vn < 0){
          ball.vx -= (1 + POST_REST) * vn * nx;
          ball.vz -= (1 + POST_REST) * vn * nz;
          clang();
        }
        return true;
      }
    }
    return false;
  }

  let clangCooldown = 0;
  function clang(){
    if(clangCooldown > 0) return;
    clangCooldown = 0.35;
    if(ball.shotSide) stats.posts[ball.shotSide === team1.side ? 0 : 1]++;
    sfx.post();
    sfx.kick(0.9);
    shake = Math.max(shake, 9);
    flashStatus('¡Al palo!');
    spawnParticles(ball.x, ball.y, 12, {
      speed: 3, life: 0.4, size: 3, color: 'rgba(255,240,200,0.9)'
    });
  }

  function updateBall(dt){
    if(ball.shotTimer > 0) ball.shotTimer -= dt;
    if(ball.releaseGuard > 0) ball.releaseGuard -= dt;
    if(ball.ownerLock    > 0) ball.ownerLock    -= dt;
    if(ball.stealGuard   > 0) ball.stealGuard   -= dt;
    if(clangCooldown > 0) clangCooldown -= dt;
    if(ball.heldBy){ ball.trail.length = 0; ball.z = 0; ball.vz = 0; return; }

    // Substep fast balls. One 24 px hop per frame is wider than a goalpost, so
    // without this the ball simply teleports past the woodwork.
    const speed0 = Math.hypot(ball.vx, ball.vy, ball.vz);
    const steps = Math.max(1, Math.min(6, Math.ceil(speed0 / 5)));
    const h = (dt * 60) / steps;

    for(let s = 0; s < steps; s++){
      const grounded = ball.z <= 0.01;

      // ---- vertical ----
      if(!grounded || ball.vz > 0){
        ball.z  += ball.vz * h;
        ball.vz -= GRAVITY * h;
        if(ball.z <= 0){
          ball.z = 0;
          if(-ball.vz > BOUNCE_STOP){
            ball.vz = -ball.vz * BOUNCE_Z;     // it keeps bouncing, lower each time
            ball.vx *= BOUNCE_BITE;
            ball.vy *= BOUNCE_BITE;
            ballLanded();
          } else {
            ball.vz = 0;
            if(ball.loftTeam) ballLanded();
          }
        }
      }

      // ---- horizontal ----
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;

      let sp = Math.hypot(ball.vx, ball.vy);
      if(sp > 0.0001){
        // quadratic drag, always; rolling resistance only on the grass
        let dec = DRAG * sp * sp * h;
        if(ball.z <= 2) dec += ROLL_FRIC * h;
        const keep = Math.max(0, 1 - dec / sp);
        ball.vx *= keep;
        ball.vy *= keep;
        sp *= keep;
      }

      // ---- bend ----
      if(ball.curve !== 0 && sp > 1.2){
        const nx = ball.vx / sp, ny = ball.vy / sp;
        ball.vx += -ny * ball.curve * h;
        ball.vy +=  nx * ball.curve * h;
        ball.curve *= Math.pow(0.995, h);
        if(Math.abs(ball.curve) < 0.002) ball.curve = 0;
      }

      // ---- woodwork and walls ----
      hitPosts();
      hitCrossbar();

      const loud = Math.hypot(ball.vx, ball.vy) > 4;
      const bounced = () => {
        if(loud){
          sfx.wall();
          spawnParticles(ball.x, ball.y, 5, { speed: 2, life: 0.3, size: 3,
                                              color: 'rgba(255,255,255,0.6)' });
        }
      };
      if(ball.y - ball.radius < FIELD_MARGIN){
        ball.y = FIELD_MARGIN + ball.radius; ball.vy *= -WALL_REST; bounced();
      }
      if(ball.y + ball.radius > H - FIELD_MARGIN){
        ball.y = H - FIELD_MARGIN - ball.radius; ball.vy *= -WALL_REST; bounced();
      }
      // the mouth is only open below the bar; above it the ball hits the stand
      const inMouth = ball.y > topGoalY && ball.y < botGoalY && ball.z < GOAL_H_PX;
      if(ball.x - ball.radius < FIELD_MARGIN && !inMouth){
        ball.x = FIELD_MARGIN + ball.radius; ball.vx *= -WALL_REST; bounced();
      }
      if(ball.x + ball.radius > W - FIELD_MARGIN && !inMouth){
        ball.x = W - FIELD_MARGIN - ball.radius; ball.vx *= -WALL_REST; bounced();
      }
      ball.x = Math.max(FIELD_MARGIN - GOAL_DEPTH, Math.min(W - FIELD_MARGIN + GOAL_DEPTH, ball.x));
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    ball.spin += speed * 0.035;
    if(speed < 0.03 && ball.z <= 0){ ball.vx = 0; ball.vy = 0; }

    if(ball.shotFire && ball.shotTimer > 0 && speed > 2){
      spawnParticles(ball.x, ball.y, 2, {
        speed: 1.3, life: 0.42, size: 5,
        color: Math.random() < 0.5 ? 'rgba(255,170,50,0.95)' : 'rgba(255,70,20,0.9)'
      });
    }
    if(speed > 6){
      ball.trail.push({ x: ball.x, y: ball.y, life: 0.25 });
      if(ball.trail.length > 14) ball.trail.shift();
    }
    for(let i = ball.trail.length - 1; i >= 0; i--){
      ball.trail[i].life -= dt;
      if(ball.trail[i].life <= 0) ball.trail.splice(i, 1);
    }
  }


  /* =========================================================
     Drawing — pitch
     ========================================================= */
  let fieldCache = null, fieldCacheW = 0, fieldCacheH = 0;

  function buildFieldCache(){
    // Built at the REAL pixel size of the canvas, not at 1600x900, so the
    // pitch lines are drawn crisp instead of being resampled when scaled up.
    const off = document.createElement('canvas');
    off.width  = Math.max(1, canvas.width);
    off.height = Math.max(1, canvas.height);
    const c = off.getContext('2d');
    c.setTransform(off.width / W, 0, 0, off.height / H, 0, 0);

    // outside the touchline
    const outer = c.createLinearGradient(0, 0, 0, H);
    outer.addColorStop(0, '#153726');
    outer.addColorStop(1, '#0d2517');
    c.fillStyle = outer;
    c.fillRect(0, 0, W, H);

    // ---- mowed stripes, with the roller's sheen across each band ----
    const stripes = 14;
    const stripeW = (W - FIELD_MARGIN*2) / stripes;
    const pitchH  = H - FIELD_MARGIN*2;
    for(let i = 0; i < stripes; i++){
      const x0 = FIELD_MARGIN + i*stripeW;
      const dark = i % 2 === 0;
      const band = c.createLinearGradient(x0, 0, x0 + stripeW, 0);
      // a mown stripe is brighter where the grass leans away from you
      band.addColorStop(0,    dark ? '#2b6c3d' : '#357f4a');
      band.addColorStop(0.45, dark ? '#317845' : '#3c8b53');
      band.addColorStop(1,    dark ? '#2a6a3b' : '#337c47');
      c.fillStyle = band;
      c.fillRect(x0, FIELD_MARGIN, stripeW + 0.5, pitchH);
    }

    // ---- blade speckle: a lot of tiny marks so it stops looking like paper ----
    c.save();
    c.beginPath();
    c.rect(FIELD_MARGIN, FIELD_MARGIN, W - FIELD_MARGIN*2, pitchH);
    c.clip();
    for(let i = 0; i < 2600; i++){
      const gx = FIELD_MARGIN + Math.random() * (W - FIELD_MARGIN*2);
      const gy = FIELD_MARGIN + Math.random() * pitchH;
      const light = Math.random() < 0.5;
      c.strokeStyle = light ? 'rgba(190,230,175,0.10)' : 'rgba(18,54,30,0.12)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(gx, gy);
      c.lineTo(gx + (Math.random() - 0.5) * 3, gy - 2 - Math.random() * 3);
      c.stroke();
    }

    // ---- worn patches where a pitch actually wears: mouths, spots, centre ----
    function wear(x, y, rx, ry, strength){
      const g = c.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
      g.addColorStop(0, 'rgba(120,98,62,' + strength + ')');
      g.addColorStop(0.6, 'rgba(110,95,60,' + (strength * 0.4) + ')');
      g.addColorStop(1, 'rgba(110,95,60,0)');
      c.save();
      c.translate(x, y);
      c.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, Math.max(rx, ry), 0, Math.PI*2);
      c.fill();
      c.restore();
    }
    wear(FIELD_MARGIN + 34, H/2, 60, 150, 0.30);           // goalmouths
    wear(W - FIELD_MARGIN - 34, H/2, 60, 150, 0.30);
    wear(FIELD_MARGIN + 104, H/2, 40, 40, 0.22);           // penalty spots
    wear(W - FIELD_MARGIN - 104, H/2, 40, 40, 0.22);
    wear(W/2, H/2, 70, 70, 0.16);                          // kick-off circle
    c.restore();

    // soft lighting across the pitch
    const light = c.createRadialGradient(W/2, H/2, 120, W/2, H/2, W*0.72);
    light.addColorStop(0, 'rgba(255,255,255,0.05)');
    light.addColorStop(1, 'rgba(0,0,0,0.14)');
    c.fillStyle = light;
    c.fillRect(FIELD_MARGIN, FIELD_MARGIN, W - FIELD_MARGIN*2, pitchH);

    c.strokeStyle = 'rgba(240,250,240,0.82)';
    c.lineWidth = 3;
    c.lineCap = 'round';

    // touchlines
    c.strokeRect(FIELD_MARGIN, FIELD_MARGIN, W - FIELD_MARGIN*2, H - FIELD_MARGIN*2);

    // halfway line + circle + spots
    c.beginPath();
    c.moveTo(W/2, FIELD_MARGIN);
    c.lineTo(W/2, H - FIELD_MARGIN);
    c.stroke();
    c.beginPath(); c.arc(W/2, H/2, 90, 0, Math.PI*2); c.stroke();
    c.fillStyle = 'rgba(240,250,240,0.85)';
    c.beginPath(); c.arc(W/2, H/2, 5, 0, Math.PI*2); c.fill();

    // boxes on both ends
    [['left', FIELD_MARGIN], ['right', W - FIELD_MARGIN]].forEach(function(pair){
      const side = pair[0], gx = pair[1];
      const dir = side === 'left' ? 1 : -1;

      // penalty box
      c.strokeRect(
        side === 'left' ? gx : gx - PENALTY_BOX_DEPTH,
        H/2 - PENALTY_BOX_WIDTH/2,
        PENALTY_BOX_DEPTH, PENALTY_BOX_WIDTH
      );
      // six-yard box
      c.strokeRect(
        side === 'left' ? gx : gx - GOAL_AREA_DEPTH,
        H/2 - GOAL_AREA_WIDTH/2,
        GOAL_AREA_DEPTH, GOAL_AREA_WIDTH
      );
      // penalty spot
      const spotX = gx + dir * (PENALTY_BOX_DEPTH - 46);
      c.fillStyle = 'rgba(240,250,240,0.85)';
      c.beginPath(); c.arc(spotX, H/2, 4, 0, Math.PI*2); c.fill();
      // D arc — only the part that pokes OUT of the penalty box. The angle is
      // derived from where the circle actually crosses the box line, so the two
      // meet exactly instead of the arc cutting a chord through the box.
      const arcR   = 84;
      const edgeX  = side === 'left' ? gx + PENALTY_BOX_DEPTH : gx - PENALTY_BOX_DEPTH;
      const reach  = Math.abs(edgeX - spotX);
      if(reach < arcR){
        const half = Math.acos(reach / arcR);
        c.beginPath();
        c.arc(spotX, H/2, arcR,
              side === 'left' ? -half : Math.PI - half,
              side === 'left' ?  half : Math.PI + half);
        c.stroke();
      }
    });

    // corner arcs
    [[FIELD_MARGIN, FIELD_MARGIN, 0], [W-FIELD_MARGIN, FIELD_MARGIN, Math.PI/2],
     [W-FIELD_MARGIN, H-FIELD_MARGIN, Math.PI], [FIELD_MARGIN, H-FIELD_MARGIN, -Math.PI/2]
    ].forEach(function(cnr){
      c.beginPath();
      c.arc(cnr[0], cnr[1], 20, cnr[2], cnr[2] + Math.PI/2);
      c.stroke();
    });

    fieldCache = off;
    fieldCacheW = off.width; fieldCacheH = off.height;
  }

  function drawGoals(){
    [['left', FIELD_MARGIN], ['right', W - FIELD_MARGIN]].forEach(function(pair){
      const side = pair[0], gx = pair[1];
      const x0 = side === 'left' ? gx - GOAL_DEPTH : gx;

      // net backdrop
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x0, topGoalY, GOAL_DEPTH, GOAL_WIDTH);

      // ---- net mesh, bulging with whatever just hit it ----
      // Seen from above only the sideways give of the cloth is visible, so the
      // back line of the net is drawn displaced by the simulation.
      // the cloth reports how far the back panel has been pushed out
      const bulgeAt = (yy) => netBulgeAt(side, yy) * (side === 'left' ? -1 : 1);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 - 26, topGoalY - 4, GOAL_DEPTH + 52, GOAL_WIDTH + 8);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 1;
      // strands running back from the line, each ending on the stretched net
      for(let y = topGoalY; y <= topGoalY + GOAL_WIDTH; y += 7){
        const back = x0 + (side === 'left' ? 0 : GOAL_DEPTH) + bulgeAt(y);
        ctx.beginPath();
        ctx.moveTo(side === 'left' ? x0 + GOAL_DEPTH : x0, y);
        ctx.lineTo(back, y);
        ctx.stroke();
      }
      // and the back face itself, as a curve through the displaced points
      ctx.beginPath();
      for(let y = topGoalY; y <= topGoalY + GOAL_WIDTH; y += 5){
        const bx = x0 + (side === 'left' ? 0 : GOAL_DEPTH) + bulgeAt(y);
        if(y === topGoalY) ctx.moveTo(bx, y); else ctx.lineTo(bx, y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // posts
      ctx.strokeStyle = '#f7f7f2';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(gx, topGoalY); ctx.lineTo(gx, botGoalY);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(242,193,78,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, topGoalY, GOAL_DEPTH, GOAL_WIDTH);
    });
  }

  /* =========================================================
     Drawing — players
     ========================================================= */
  // what the keeper shows on its shirt, so its state is readable at a glance
  function gkGlyph(p){
    switch(p.state){
      case 'recovering': return '···';
      case 'holding':    return '●';   // has the ball in its hands
      case 'rushing':    return '»';
      case 'diving':     return '';
      default:           return String(p.number);
    }
  }

  /* ---- hair ----
     Seen from above a player is mostly hair, so this is where they get to look
     like individuals. Drawn in head space (already rotated to the heading), so
     the parting, the bun and the ponytail all sit at the back of the head and
     swing round as the player turns. */
  const HAIR_2D = false;        // the flat drawing stays off
  const HAIR_STYLES = ['buzz', 'afro', 'mohawk', 'ponytail', 'bun', 'curls', 'bald', 'long'];
  const HAIR_COLORS = ['#2b2119', '#0f0d0c', '#6b4a2a', '#d8b36a', '#a8501f', '#c9c4bd'];

  function drawHair(p){
    const r = p.radius;
    const col = p.hairColor;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;

    switch(p.hairStyle){
      case 'bald':
        ctx.beginPath();                       // just a little fringe at the back
        ctx.arc(0, 0, r * 0.92, Math.PI * 0.72, Math.PI * 1.28);
        ctx.lineWidth = r * 0.26;
        ctx.stroke();
        break;

      case 'buzz':
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.globalAlpha = 1;
        break;

      case 'afro':
        ctx.beginPath();
        ctx.arc(-r * 0.12, 0, r * 1.12, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'mohawk':
        ctx.beginPath();                       // a strip running front to back
        ctx.ellipse(-r * 0.05, 0, r * 0.95, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'ponytail':
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();                       // tail trailing behind the head
        ctx.ellipse(-r * 1.25, 0, r * 0.5, r * 0.26, 0, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'bun':
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(-r * 0.95, 0, r * 0.36, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'curls':
        for(let i = 0; i < 7; i++){
          const a = Math.PI * 0.42 + (i / 6) * Math.PI * 1.16;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
        break;

      case 'long':
      default:
        ctx.beginPath();                       // wide fall of hair around the back
        ctx.ellipse(-r * 0.35, 0, r * 0.95, r * 1.02, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
  }

  function drawPlayer(p, isControlled, team){
    const speed = Math.hypot(p.vx, p.vy);
    p.runPhase += speed * 0.09;
    const bob = Math.sin(p.runPhase) * Math.min(speed, 5) * 0.5;

    ctx.save();
    ctx.translate(p.x, p.y);

    // shadow (stays on the ground, doesn't bob)
    ctx.beginPath();
    ctx.ellipse(0, p.radius*0.85, p.radius*0.95, p.radius*0.34, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fill();

    // controlled highlight: pulsing arc + arrow marker
    if(isControlled){
      const pulse = 1 + Math.sin(performance.now()/220) * 0.07;
      ctx.beginPath();
      ctx.arc(0, 0, (p.radius + 9) * pulse, 0, Math.PI*2);
      ctx.strokeStyle = team && team.containing ? 'rgba(255,120,90,0.95)' : 'rgba(242,193,78,0.95)';
      ctx.lineWidth = 3;
      ctx.stroke();

      // containing: a wedge showing the lane you're shutting down
      if(team && team.containing){
        const ang = Math.atan2(p.facing.y, p.facing.x);
        ctx.beginPath();
        ctx.arc(0, 0, p.radius + 20, ang - 0.6, ang + 0.6);
        ctx.strokeStyle = 'rgba(255,120,90,0.7)';
        ctx.lineWidth = 4;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(0, -p.radius - 20);
      ctx.lineTo(-7, -p.radius - 31);
      ctx.lineTo( 7, -p.radius - 31);
      ctx.closePath();
      ctx.fillStyle = '#f2c14e';
      ctx.fill();

      // charge meter
      if(team && team.charge > 0.02){
        const bw = 52, bh = 6, by = p.radius + 13;
        const isPower = team.chargeKind === 'power';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-bw/2, by, bw, bh);

        // the ideal band on the power bar: aim to release inside it
        if(isPower){
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.fillRect(-bw/2 + bw*SWEET_MIN, by, bw*(SWEET_MAX - SWEET_MIN), bh);
        }

        const inSweet = isPower && team.charge >= SWEET_MIN && team.charge <= SWEET_MAX;
        if(inSweet){
          ctx.fillStyle = '#ffe066';
        } else {
          const g = ctx.createLinearGradient(-bw/2, 0, bw/2, 0);
          g.addColorStop(0, '#9fe870'); g.addColorStop(1, '#ff5b3a');
          ctx.fillStyle = g;
        }
        ctx.fillRect(-bw/2, by, bw * team.charge, bh);

        if(isPower){
          ctx.strokeStyle = inSweet ? '#ffe066' : 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.strokeRect(-bw/2 + bw*SWEET_MIN, by - 1, bw*(SWEET_MAX - SWEET_MIN), bh + 2);
        }
      }

      // holding a fire shot
      if(team && team.powerup === 'fire'){
        const t = performance.now() / 180;
        const r = p.radius + 13 + Math.sin(t)*2;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,140,40,0.35)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // the bright part of the ring is how much of the 15 s window is left
        const left = Math.max(0, Math.min(1, team.powerupTimer / PU_HOLD_TIME));
        ctx.beginPath();
        ctx.arc(0, 0, r, -Math.PI/2, -Math.PI/2 + Math.PI*2*left);
        ctx.strokeStyle = team.powerupTimer < 4 ? 'rgba(255,80,40,0.95)' : 'rgba(255,175,60,0.95)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    ctx.translate(0, bob);

    // sliding: stretched out along the direction of the challenge
    if(p.slideTimer > 0){
      const d = p.slideDir || p.facing;
      const ang = Math.atan2(d.y, d.x);
      const st = 1 + (p.slideTimer / SLIDE_DURATION) * 0.85;
      ctx.rotate(ang);
      ctx.scale(st, 1 / Math.sqrt(st));
      ctx.rotate(-ang);
    } else if(p.downTimer > 0){
      // face-down and out of the game for a moment
      ctx.scale(1.14, 0.72);   // the fade is applied with the body alpha below
    }

    // GK dive stretch
    if(p.role === 'GK' && p.state === 'diving'){
      const stretch = 1 + Math.min(p.stateTimer / GK_DIVE_DURATION, 1) * 0.9;
      const angle = Math.atan2(p.facing.y, p.facing.x);
      ctx.rotate(angle);
      ctx.scale(stretch, 1 / Math.sqrt(stretch));
      ctx.rotate(-angle);
    }

    const isGK = p.role === 'GK';
    const base = isGK ? '#f3f5f0' : p.color;

    // body with a lit top edge
    const grad = ctx.createRadialGradient(-p.radius*0.35, -p.radius*0.45, p.radius*0.2, 0, 0, p.radius*1.15);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, shade(base, -0.35));
    ctx.globalAlpha = (isGK && p.beatenTimer > 0) ? 0.25
                    : (p.downTimer > 0) ? 0.45
                    : (isGK && p.state === 'recovering') ? 0.6 : 1;
    ctx.beginPath();
    ctx.arc(0, 0, p.radius, 0, Math.PI*2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = isGK ? p.color : 'rgba(0,0,0,0.4)';
    ctx.stroke();

    // The flat version of this looked wrong, so the top-down view leaves it
    // out; the hair lives in 3D now.
    if(HAIR_2D && p.hairStyle){
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, p.radius - 1.5, 0, Math.PI*2);
      ctx.clip();
      ctx.rotate(Math.atan2(p.facing.y, p.facing.x));
      drawHair(p);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // jersey number
    ctx.fillStyle = isGK ? p.color : 'rgba(255,255,255,0.95)';
    ctx.font = 'bold ' + (isGK ? 12 : 13) + 'px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isGK ? gkGlyph(p) : String(p.number), 0, 1);

    // his name, so the squad stops being a set of numbers
    if(p.name){
      ctx.font = '600 11px "Segoe UI", sans-serif';
      ctx.fillStyle = isControlled ? 'rgba(255,240,190,0.98)' : 'rgba(255,255,255,0.55)';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeText(p.name, 0, -p.radius - 9);
      ctx.fillText(p.name, 0, -p.radius - 9);
    }

    // facing wedge
    const fx = p.facing.x || (p.side === 'left' ? 1 : -1);
    const fy = p.facing.y || 0;
    const flen = Math.hypot(fx, fy) || 1;
    ctx.beginPath();
    ctx.moveTo((fx/flen)*p.radius*0.75, (fy/flen)*p.radius*0.75);
    ctx.lineTo((fx/flen)*p.radius*1.5,  (fy/flen)*p.radius*1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    // how long until this player is back up
    if(p.downTimer > 0){
      ctx.globalAlpha = 1;
      const frac = p.downTimer / SLIDE_DOWN;
      ctx.beginPath();
      ctx.arc(0, 0, p.radius + 7, -Math.PI/2, -Math.PI/2 + Math.PI*2*(1 - frac));
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  // lighten (amount > 0) or darken (amount < 0) a hex colour
  function shade(hex, amount){
    let h = hex.replace('#', '');
    if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const num = parseInt(h, 16);
    let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    const t = amount < 0 ? 0 : 255;
    const a = Math.abs(amount);
    r = Math.round(r + (t - r) * a);
    g = Math.round(g + (t - g) * a);
    b = Math.round(b + (t - b) * a);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawTeam(team){
    drawPlayer(team.gk, false, team);
    team.outfield.forEach((pl, idx) => {
      drawPlayer(pl, idx === team.controlledIndex, team);
    });
  }

  function drawBall(){
    // trail
    for(const t of ball.trail){
      ctx.globalAlpha = Math.max(0, t.life / 0.25) * 0.35;
      ctx.beginPath();
      ctx.arc(t.x, t.y, ball.radius * 0.8, 0, Math.PI*2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Height is read two ways at once: the ball grows, and it pulls away from
    // its shadow. The shadow stays on the grass, so it always tells you where
    // the ball is actually going to come down.
    const h      = Math.max(0, ball.z);
    const lift   = h * 0.42;
    const grow   = 1 + Math.min(h / 70, 1) * 0.85;
    const shrink = 1 - Math.min(h / 90, 1) * 0.45;

    ctx.beginPath();
    ctx.ellipse(ball.x + 2, ball.y + ball.radius*0.85, ball.radius*0.9*shrink,
                ball.radius*0.32*shrink, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.3 - Math.min(h/90,1)*0.14).toFixed(3) + ')';
    ctx.fill();

    ctx.save();
    ctx.translate(ball.x, ball.y - lift);
    ctx.scale(grow, grow);
    ctx.rotate(ball.spin);

    const g = ctx.createRadialGradient(-ball.radius*0.4, -ball.radius*0.4, 1, 0, 0, ball.radius*1.2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.7, '#f4efdd');
    g.addColorStop(1, '#c9c2ae');
    ctx.beginPath();
    ctx.arc(0, 0, ball.radius, 0, Math.PI*2);
    ctx.fillStyle = g;
    ctx.fill();

    // classic panel pattern
    ctx.fillStyle = '#23301f';
    ctx.beginPath();
    for(let i = 0; i < 5; i++){
      const a = (i / 5) * Math.PI * 2;
      const px = Math.cos(a) * ball.radius * 0.42;
      const py = Math.sin(a) * ball.radius * 0.42;
      if(i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    for(let i = 0; i < 5; i++){
      const a = (i / 5) * Math.PI * 2 + Math.PI/5;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * ball.radius * 0.78, Math.sin(a) * ball.radius * 0.78, ball.radius * 0.2, 0, Math.PI*2);
      ctx.fill();
    }

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(60,60,50,0.5)';
    ctx.beginPath();
    ctx.arc(0, 0, ball.radius, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  function drawCelebration(dt){
    if(!celebration) return;
    celebration.t += dt;
    const dur = celebration.duration || 2.0;
    if(celebration.t > dur){ celebration = null; return; }
    const t = celebration.t;
    const pop = t < 0.3 ? t / 0.3 : 1;
    const fade = t > dur - 0.4 ? 1 - (t - (dur - 0.4)) / 0.4 : 1;
    const big = !!celebration.big;
    const base = big ? 0.75 : 0.6;
    const scale = (base + pop * 0.4 + Math.sin(t * 7) * 0.02) * (big ? 1.45 : 1);

    // confetti rains for the winner
    if(celebration.confetti > 0){
      celebration.confetti -= dt;
      for(let i = 0; i < 3; i++){
        particles.push({
          x: Math.random() * W, y: -12,
          vx: (Math.random() - 0.5) * 1.6, vy: 1.4 + Math.random() * 2.2,
          life: 4.5, maxLife: 4.5,
          size: 5 + Math.random() * 6,
          gravity: 0.012,
          color: ['#f2c14e', '#ffffff', '#3aa0ff', '#ff5b3a', '#9fe870'][i % 5]
        });
      }
    }

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = big ? 'rgba(5,12,8,0.72)' : 'rgba(5,12,8,0.45)';
    ctx.fillRect(0, big ? 0 : H/2 - 110, W, big ? H : 220);

    ctx.translate(W/2, H/2 - 12);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.font = '900 110px "Segoe UI", sans-serif';
    ctx.strokeText(celebration.text, 0, 0);
    const g = ctx.createLinearGradient(0, -60, 0, 60);
    g.addColorStop(0, '#fff3cf');
    g.addColorStop(1, celebration.color);
    ctx.fillStyle = g;
    ctx.fillText(celebration.text, 0, 0);

    ctx.font = (big ? '900 46px' : '700 30px') + ' "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(celebration.sub, 0, big ? 96 : 78);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawPauseVeil(){
    ctx.fillStyle = 'rgba(5,12,8,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f2c14e';
    ctx.font = '900 76px "Segoe UI", sans-serif';
    ctx.fillText('PAUSA', W/2, H/2 - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 24px "Segoe UI", sans-serif';
    ctx.fillText('P o Esc para continuar', W/2, H/2 + 52);
  }

  function drawKickoffCountdown(){
    if(kickoffTimer <= 0 || celebration) return;
    const n = Math.ceil(kickoffTimer);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const frac = kickoffTimer - Math.floor(kickoffTimer);
    ctx.globalAlpha = 0.25 + frac * 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 130px "Segoe UI", sans-serif';
    ctx.fillText(String(n), W/2, H/2);
    ctx.restore();
  }

  /* =========================================================
     Instant replay
     Every frame of play is written into a ring buffer — just the positions,
     nothing else. When somebody scores, the match freezes and the last few
     seconds are played back in slow motion with a camera that swings around
     the goal. The clock is paused while it runs, so a replay never eats match
     time; it only costs you real seconds.
     ========================================================= */
  const REPLAY_SECS   = 5.0;    // how much history we keep
  const REPLAY_SHOW   = 3.4;    // how much of it we show
  const REPLAY_SPEED  = 0.42;   // slow motion factor
  const REPLAY_FPS    = 60;
  const REPLAY_FRAMES = Math.ceil(REPLAY_SECS * REPLAY_FPS);
  const REPLAY_STRIDE = SQUAD_TOTAL * 4 + 4;   // players (x,y,fx,fy) + ball (x,y,z,spin)

  const replay = {
    buf: new Float32Array(REPLAY_FRAMES * REPLAY_STRIDE),
    count: 0, head: 0,
    active: false, t: 0, span: 0, side: null, scorer: null,
    power: 0, hitY: 0, hitZ: 0, punched: false
  };

  function recordFrame(){
    const list = allPlayers();
    let k = replay.head * REPLAY_STRIDE;
    const b = replay.buf;
    for(let i = 0; i < SQUAD_TOTAL; i++){
      const p = list[i];
      b[k++] = p.x; b[k++] = p.y; b[k++] = p.facing.x; b[k++] = p.facing.y;
    }
    b[k++] = ball.x; b[k++] = ball.y; b[k++] = ball.z; b[k++] = ball.spin;
    replay.head = (replay.head + 1) % REPLAY_FRAMES;
    if(replay.count < REPLAY_FRAMES) replay.count++;
  }

  // age 0 = the newest frame, age N = N frames ago
  function applyFrame(age){
    const n = replay.count;
    if(!n) return;
    const a = Math.max(0, Math.min(n - 1, age));
    const i0 = Math.floor(a), i1 = Math.min(n - 1, i0 + 1);
    const f = a - i0;
    const idx = (o) => ((replay.head - 1 - o) % REPLAY_FRAMES + REPLAY_FRAMES) % REPLAY_FRAMES;
    const b = replay.buf;
    const p0 = idx(i0) * REPLAY_STRIDE, p1 = idx(i1) * REPLAY_STRIDE;
    const mix = (o) => b[p0 + o] + (b[p1 + o] - b[p0 + o]) * f;

    const list = allPlayers();
    for(let i = 0; i < SQUAD_TOTAL; i++){
      const p = list[i], o = i * 4;
      p.x = mix(o); p.y = mix(o + 1);
      p.facing.x = mix(o + 2); p.facing.y = mix(o + 3);
      p.vx = 0; p.vy = 0;
    }
    const bo = SQUAD_TOTAL * 4;
    ball.x = mix(bo); ball.y = mix(bo+1); ball.z = mix(bo+2); ball.spin = mix(bo+3);
    ball.vx = 0; ball.vy = 0; ball.vz = 0;
  }

  const REPLAY_HOLD = 1.5;   // seconds held on the net after the ball arrives

  function startReplay(side, scorer, power, hitY, hitZ){
    if(replay.count < 30) return false;
    replay.active = true;
    replay.punched = false;
    replay.power = power || 12;
    replay.hitY = hitY || H/2;
    replay.hitZ = hitZ || 0;
    replay.t = 0;
    replay.span = Math.min(REPLAY_SHOW, replay.count / REPLAY_FPS);
    replay.side = side;
    replay.scorer = scorer;
    return true;
  }

  function updateReplay(dt){
    replay.t += dt * REPLAY_SPEED;

    if(replay.t >= replay.span){
      // hold on the last frame: the ball sits in the net and the cloth
      // finishes its bounce, which is the shot worth watching
      applyFrame(0);
      if(!replay.punched){
        netImpulse(replay.side, replay.hitY, replay.hitZ, replay.power);
        replay.punched = true;
      }
      if(replay.t >= replay.span + REPLAY_HOLD){
        replay.active = false;
        resetPositions(restartTeam);
        kickoffTimer = 1.2;
      }
      return;
    }
    // walk from the oldest shown frame towards the newest
    const age = (replay.span - replay.t) * REPLAY_FPS;
    applyFrame(age);
  }

  function drawReplayFrame(){
    // letterbox and a label, so nobody mistakes it for live play
    const bar = H * 0.085;
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);

    const blink = 0.55 + 0.45 * Math.abs(Math.sin(replay.t * 4));
    ctx.save();
    ctx.globalAlpha = blink;
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.arc(62, bar / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '800 26px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('REPETICIÓN', 84, bar / 2);

    if(replay.scorer){
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,225,150,0.95)';
      ctx.fillText(replay.scorer, W - 40, bar / 2);
    }
    {
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(replay.t * 5);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 17px "Segoe UI", sans-serif';
      ctx.fillText('pulsa para saltar', W/2, bar / 2);
      ctx.restore();
    }

    // a progress bar along the bottom letterbox
    const pw = W * 0.4, px = (W - pw) / 2, py = H - bar / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(px, py - 2, pw, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(px, py - 2, pw * Math.min(1, replay.t / (replay.span + REPLAY_HOLD)), 4);
    ctx.textAlign = 'center';
  }

  /* =========================================================
     Kick-off fly-in
     A camera move before the whistle: it comes in low behind one goal, skims
     down the pitch past the halfway line and then climbs into the match
     position, which is where it hands over. The clock does not start until it
     is done, and any button skips it.
     ========================================================= */
  const intro = { active: false, t: 0, dur: 5.2 };

  function startIntro(){
    if(!view3d || !g3.ready){ intro.active = false; return; }
    intro.active = true;
    intro.t = 0;
  }

  // Skipping the whole goal sequence: the ball still in the net, the replay,
  // or both. One gesture, so you never have to sit through a celebration you
  // have already seen.
  function skipCelebration(){
    if(replay.active){
      replay.active = false;
      resetPositions(restartTeam);
      kickoffTimer = 1.2;
      restoreMatchCamera();
      return true;
    }
    if(goalAction > 0){
      // Skipping the ball-in-the-net beat must NOT throw the goal away. It used
      // to drop pendingGoal on the floor, which is why the replay "sometimes"
      // never appeared: anyone holding a button through the celebration was
      // silently cancelling it. Cut straight to the replay instead — a second
      // press then takes you to the kick-off.
      goalAction = 0;
      finishGoal();
      return true;
    }
    return false;
  }

  function skipIntro(){
    if(!intro.active) return;
    intro.active = false;
    kickoffTimer = 1.2;
  }

  function updateIntro(dt){
    intro.t += dt;
    if(intro.t >= intro.dur){
      intro.active = false;
      kickoffTimer = 1.2;
    }
  }

  const easeInOut = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;
  const lerp3 = (a, b, t) => [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t];

  function introCamera(){
    const halfW3 = (W * S3) / 2;
    // three beats: behind the goal, along the pitch, up into match position
    const legs = [
      { pos: [-halfW3 - 26, 3.4,  10], look: [-halfW3 + 6, 2.2, 0] },
      { pos: [-6,           9,    34], look: [ 12,        1.5, 0] },
      { pos: [ halfW3 * 0.35, 30, 52], look: [ 0,         0.5, -2] },
      { pos: [ 0,           62,   58], look: [ 0,         0,   -4] }
    ];
    const p = Math.min(1, intro.t / intro.dur);
    const seg = Math.min(legs.length - 2, Math.floor(p * (legs.length - 1)));
    const local = easeInOut(p * (legs.length - 1) - seg);

    const pos  = lerp3(legs[seg].pos,  legs[seg + 1].pos,  local);
    const look = lerp3(legs[seg].look, legs[seg + 1].look, local);
    g3.camera.position.set(pos[0], pos[1], pos[2]);
    g3.camera.lookAt(look[0], look[1], look[2]);

    // a longer lens at the start that opens up as it pulls back
    const fov = 34 + p * 8;
    if(Math.abs(g3.camera.fov - fov) > 0.01){
      g3.camera.fov = fov;
      g3.camera.updateProjectionMatrix();
    }
  }

  function drawIntroFrame(){
    const p = Math.min(1, intro.t / intro.dur);
    // cinema bars that slide away at the end
    const close = p > 0.82 ? (p - 0.82) / 0.18 : 0;
    const bar = H * 0.11 * (1 - close);
    if(bar > 1){
      ctx.fillStyle = 'rgba(0,0,0,0.88)';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
    }

    // the two sides announced, sliding in and fading out before kick-off
    const nameIn = Math.min(1, p / 0.25);
    const nameOut = p > 0.62 ? 1 - (p - 0.62) / 0.2 : 1;
    const a = Math.max(0, Math.min(1, nameIn)) * Math.max(0, Math.min(1, nameOut));
    if(a > 0.01){
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textBaseline = 'middle';
      ctx.font = '900 62px "Segoe UI", sans-serif';

      const slide = (1 - easeInOut(Math.min(1, p / 0.25))) * 260;
      ctx.textAlign = 'right';
      ctx.fillStyle = team1.color;
      ctx.fillText(team1.name.toUpperCase(), W/2 - 46 - slide, H/2 - 10);
      ctx.textAlign = 'left';
      ctx.fillStyle = team2.color;
      ctx.fillText(team2.name.toUpperCase(), W/2 + 46 + slide, H/2 - 10);

      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '700 30px "Segoe UI", sans-serif';
      ctx.fillText('vs', W/2, H/2 - 8);
      ctx.font = '600 22px "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillText(cpuMode ? ('CONTRA LA MÁQUINA · ' + CPU_LEVELS[cpuLevel].name)
                           : 'DOS JUGADORES', W/2, H/2 + 44);
      ctx.restore();
    }

    if(p < 0.9){
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.25 * Math.sin(intro.t * 4);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 18px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('pulsa cualquier botón para saltar', W/2, H - bar/2);
      ctx.restore();
    }
  }

  /* =========================================================
     3D view
     The simulation is untouched: it keeps running in its own 1600x900 pitch
     coordinates and this is purely a second way of LOOKING at it. Game (x, y)
     maps to world (x, z) and the ball's existing height becomes real Y, so
     crosses arc through the air for free.

     If three.js fails to load the flag simply never turns on and the game
     stays in 2D, so the page never depends on the CDN to be playable.
     ========================================================= */
  const S3 = 0.085;                       // game px -> world units

  function has3d(){ return typeof THREE !== 'undefined' && !!canvas3d; }

  const GOAL_H3 = GOAL_H_PX * S3;            // goal height in world units (3:1, like a real goal)
  function wx(x){ return (x - W/2) * S3; }   // pitch x  -> world x
  function wz(y){ return (y - H/2) * S3; }   // pitch y  -> world z

  /* ---- the stands ----
     The first attempt was people hovering over a flat slab, which read as
     nothing at all. A stand is a staircase: each row sits on its own step, one
     higher and further back than the last, with a wall at the front, a rail
     along the top and a roof over it. Build the steps and the crowd falls into
     place on them.
     ========================================================= */
  const CROWD_COLORS = ['#d94f3d','#3f7fd1','#e8c04a','#59a86b','#b060c0',
                        '#e07f3a','#5ec7c7','#d8d8d8','#8a5a3b','#e36fa0',
                        '#4a5fbf','#c0392b','#16a085','#f0f0c0'];
  const STAND_ROWS  = 7;
  const STEP_RISE   = 1.5;     // how much each row climbs
  const STEP_DEPTH  = 2.2;     // and how far back it sits
  let crowdCheerT = 0;
  function crowdCheer(secs){ crowdCheerT = Math.max(crowdCheerT, secs); }

  function buildStands(){
    const people = [];
    const halfW3 = (W * S3) / 2;
    const halfH3 = (H * S3) / 2;

    // one material per colour, shared by everybody: this used to allocate a
    // fresh material per person, twice — 1344 materials and as many program
    // switches per frame, before a single player was drawn
    const crowdBodyMats = CROWD_COLORS.map(c => new THREE.MeshLambertMaterial({ color: new THREE.Color(c) }));
    const crowdHeadMats = [new THREE.MeshLambertMaterial({ color: 0xd8a87a }),
                           new THREE.MeshLambertMaterial({ color: 0x6b4a33 })];
    const concrete = new THREE.MeshLambertMaterial({ color: 0x5b6570 });
    const concreteDark = new THREE.MeshLambertMaterial({ color: 0x424b55 });
    const railMat  = new THREE.MeshLambertMaterial({ color: 0x8d99a6 });
    const roofMat  = new THREE.MeshLambertMaterial({ color: 0x2c343d });
    const geoBody  = new THREE.CylinderGeometry(0.34, 0.44, 1.05, 6);
    const geoHead  = new THREE.SphereGeometry(0.30, 7, 6);

    // one stand: `len` long, starting `gap` back from the touchline.
    // dir is the outward direction (which way the terrace climbs away).
    function stand(cx, cz, dirX, dirZ, len, gap, perRow){
      const alongX = dirZ, alongZ = dirX;   // perpendicular to the outward dir

      // front wall, so the terrace does not float over the grass
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(Math.abs(alongX) * len + Math.abs(dirX) * 1.2,
                              2.2,
                              Math.abs(alongZ) * len + Math.abs(dirZ) * 1.2),
        concreteDark);
      wall.position.set(cx + dirX * gap, 1.1, cz + dirZ * gap);
      wall.receiveShadow = true;
      g3.scene.add(wall);

      for(let r = 0; r < STAND_ROWS; r++){
        const back = gap + 1.0 + r * STEP_DEPTH;
        const lift = 2.0 + r * STEP_RISE;

        // the step itself
        const step = new THREE.Mesh(
          new THREE.BoxGeometry(Math.abs(alongX) * len + Math.abs(dirX) * STEP_DEPTH,
                                STEP_RISE,
                                Math.abs(alongZ) * len + Math.abs(dirZ) * STEP_DEPTH),
          r % 2 ? concrete : concreteDark);
        step.position.set(cx + dirX * back, lift - STEP_RISE / 2, cz + dirZ * back);
        g3.scene.add(step);

        // and the row of people standing on it
        for(let i = 0; i < perRow; i++){
          const t = (i / (perRow - 1) - 0.5) * len * 0.94;
          const g = new THREE.Group();
          const body = new THREE.Mesh(geoBody, crowdBodyMats[(i * 5 + r * 3) % crowdBodyMats.length]);
          body.position.y = 0.52;
          g.add(body);
          const head = new THREE.Mesh(geoHead,
            crowdHeadMats[(i + r) % 4 ? 0 : 1]);
          head.position.y = 1.28;
          g.add(head);
          g.position.set(cx + alongX * t + dirX * (back - 0.4), lift,
                         cz + alongZ * t + dirZ * (back - 0.4));
          g.rotation.y = Math.atan2(-dirX, -dirZ);
          g3.scene.add(g);
          people.push({ g, base: lift, phase: Math.random() * 6.28,
                        speed: 0.6 + Math.random() * 0.9 });
        }
      }

      // rail along the front and a roof over the back
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(Math.abs(alongX) * len + 0.3, 0.16, Math.abs(alongZ) * len + 0.3),
        railMat);
      rail.position.set(cx + dirX * (gap - 0.5), 2.5, cz + dirZ * (gap - 0.5));
      g3.scene.add(rail);

      const roofBack = gap + STAND_ROWS * STEP_DEPTH;
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(Math.abs(alongX) * len + Math.abs(dirX) * (roofBack - gap),
                              0.5,
                              Math.abs(alongZ) * len + Math.abs(dirZ) * (roofBack - gap)),
        roofMat);
      roof.position.set(cx + dirX * (gap + (roofBack - gap) / 2), 2.0 + STAND_ROWS * STEP_RISE + 3.2,
                        cz + dirZ * (gap + (roofBack - gap) / 2));
      g3.scene.add(roof);

      // pillars holding the roof up
      for(let i = 0; i < 5; i++){
        const t = (i / 4 - 0.5) * len * 0.9;
        const col = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 2.0 + STAND_ROWS * STEP_RISE + 3.2, 6), railMat);
        col.position.set(cx + alongX * t + dirX * roofBack,
                         (2.0 + STAND_ROWS * STEP_RISE + 3.2) / 2,
                         cz + alongZ * t + dirZ * roofBack);
        g3.scene.add(col);
      }
    }

    stand(0,  halfH3, 0,  1, W * S3 * 1.02, 5, 30);
    stand(0, -halfH3, 0, -1, W * S3 * 1.02, 5, 30);
    stand( halfW3, 0, 1, 0, H * S3 * 0.98, 6, 18);
    stand(-halfW3, 0,-1, 0, H * S3 * 0.98, 6, 18);

    g3.crowd = people;
  }

  function updateCrowd(dt, now){
    if(!g3.crowd) return;
    if(crowdCheerT > 0) crowdCheerT -= dt;
    const hype = crowdCheerT > 0 ? 1 : 0;
    for(const c of g3.crowd){
      const t = now * 0.001 * c.speed + c.phase;
      const bob  = Math.sin(t) * 0.09;
      const jump = hype ? Math.max(0, Math.sin(t * 6)) * 1.3 : 0;
      c.g.position.y = c.base + bob + jump;
      c.g.rotation.z = Math.sin(t * 0.7) * 0.08;
    }
  }

  /* ---- pride flag ----
     A proper little cloth: a grid of points held by distance constraints, with
     the top edge pinned to the pole and a wind force blowing through it. */
  const FLAG_COLS = 14, FLAG_ROWS = 9;
  const FLAG_W = 11, FLAG_H = 7;
  const PRIDE = [0xe40303, 0xff8c00, 0xffed00, 0x008026, 0x004dff, 0x750787];
  const PRIDE_C = (typeof THREE !== 'undefined') ? PRIDE.map(h => new THREE.Color(h)) : [];   // built once, not 16 times a frame

  function buildFlag(x, z){
    const pts = [];
    const dx = FLAG_W / (FLAG_COLS - 1), dy = FLAG_H / (FLAG_ROWS - 1);
    for(let r = 0; r < FLAG_ROWS; r++){
      for(let c = 0; c < FLAG_COLS; c++){
        pts.push({ x: c * dx, y: -r * dy, z: 0, px: c * dx, py: -r * dy, pz: 0,
                   pin: c === 0 });
      }
    }
    const geo = new THREE.BufferGeometry();
    const tri = (FLAG_COLS - 1) * (FLAG_ROWS - 1) * 2;
    const pos = new Float32Array(tri * 3 * 3);
    const col = new Float32Array(tri * 3 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.position.set(x, 0, z);
    g3.scene.add(mesh);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, FLAG_H + 9, 8),
      new THREE.MeshLambertMaterial({ color: 0x8d8d8d })
    );
    pole.position.set(x, (FLAG_H + 9) / 2, z);
    g3.scene.add(pole);

    return { pts, geo, mesh, pos, col, dx, dy, top: FLAG_H + 8 };
  }

  function updateFlag(f, dt, now){
    const step = Math.min(dt, 1/40);
    const wind = 9 + Math.sin(now * 0.0011) * 5;
    for(let i = 0; i < f.pts.length; i++){
      const p = f.pts[i];
      // (was an indexOf inside the hot loop: a linear scan per pinned point per frame)
      if(p.pin){ p.x = 0; p.y = -((i / FLAG_COLS) | 0) * f.dy; p.z = 0; continue; }
      // verlet: the previous position carries the velocity
      const vx = (p.x - p.px) * 0.985, vy = (p.y - p.py) * 0.985, vz = (p.z - p.pz) * 0.985;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx;
      p.y += vy - 16 * step * step * 60;
      p.z += vz + (wind * step * step * 60) * (0.6 + 0.4 * Math.sin(p.y * 0.7 + now * 0.004));
    }
    // hold the weave together
    for(let it = 0; it < 3; it++){
      for(let r = 0; r < FLAG_ROWS; r++){
        for(let c = 0; c < FLAG_COLS; c++){
          const i = r * FLAG_COLS + c;
          if(c + 1 < FLAG_COLS) relax(f.pts[i], f.pts[i + 1], f.dx);
          if(r + 1 < FLAG_ROWS) relax(f.pts[i], f.pts[i + FLAG_COLS], f.dy);
        }
      }
    }
    // rebuild the triangles — no per-quad arrays or closures, no per-row Colors
    let k = 0, kc = 0;
    const pos = f.pos, col = f.col, top = f.top;
    const put = (p, band) => {
      pos[k++] = p.x; pos[k++] = p.y + top; pos[k++] = p.z;
      col[kc++] = band.r; col[kc++] = band.g; col[kc++] = band.b;
    };
    for(let r = 0; r < FLAG_ROWS - 1; r++){
      const band = PRIDE_C[Math.min(PRIDE_C.length - 1, Math.floor(r / (FLAG_ROWS - 1) * PRIDE_C.length))];
      for(let c = 0; c < FLAG_COLS - 1; c++){
        const a = f.pts[r * FLAG_COLS + c],     b = f.pts[r * FLAG_COLS + c + 1];
        const d = f.pts[(r+1) * FLAG_COLS + c], e = f.pts[(r+1) * FLAG_COLS + c + 1];
        put(a, band); put(b, band); put(d, band);
        put(b, band); put(e, band); put(d, band);
      }
    }
    f.geo.attributes.position.needsUpdate = true;
    f.geo.attributes.color.needsUpdate = true;
  }

  function relax(a, b, rest){
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const k = ((d - rest) / d) * 0.5;
    const mx = dx * k, my = dy * k, mz = dz * k;
    if(!a.pin){ a.x += mx; a.y += my; a.z += mz; }
    if(!b.pin){ b.x -= mx; b.y -= my; b.z -= mz; }
  }

  /* ---- goal nets in 3D ---- */
  function buildNet3d(side, gx, dir){
    const halfW3 = (GOAL_WIDTH / 2) * S3;
    const hgt = GOAL_H3;
    const segs = [];
    const geo = new THREE.BufferGeometry();
    // one line per row and per column of the cloth grid
    const lines = (NET_ROWS * (NET_COLS - 1) + NET_COLS * (NET_ROWS - 1));
    const pos = new Float32Array(lines * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // brighter and a touch blue, so the mesh separates from the white posts —
    // at one device pixel and 45% alpha it barely read at all
    const mesh = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0xdde9ff, transparent: true, opacity: 0.66 }));
    g3.scene.add(mesh);
    return { side, gx, dir, halfW3, hgt, geo, pos, mesh };
  }

  // Zero allocations, and nothing at all while the cloth is asleep. This used
  // to build ~1500 throwaway arrays per frame and re-upload both nets every
  // frame whether or not a single knot had moved — the main GC spike source.
  function updateNet3d(n){
    const net = nets[n.side];
    if(net.energy <= 0 && n.uploaded) return;
    const p = n.pos, gx = n.gx, dir = n.dir, halfW = GOAL_WIDTH / 2;
    const u = net.u, v = net.v, w = net.w;
    let k = 0;
    // goal space (u = depth in, v = height, w = across) -> world
    for(let r = 0; r < NET_ROWS; r++){
      for(let c = 0; c < NET_COLS - 1; c++){
        const i = r * NET_COLS + c, j = i + 1;
        p[k++] = gx - dir * u[i] * S3; p[k++] = v[i] * S3; p[k++] = (w[i] - halfW) * S3;
        p[k++] = gx - dir * u[j] * S3; p[k++] = v[j] * S3; p[k++] = (w[j] - halfW) * S3;
      }
    }
    for(let c = 0; c < NET_COLS; c++){
      for(let r = 0; r < NET_ROWS - 1; r++){
        const i = r * NET_COLS + c, j = i + NET_COLS;
        p[k++] = gx - dir * u[i] * S3; p[k++] = v[i] * S3; p[k++] = (w[i] - halfW) * S3;
        p[k++] = gx - dir * u[j] * S3; p[k++] = v[j] * S3; p[k++] = (w[j] - halfW) * S3;
      }
    }
    n.geo.attributes.position.needsUpdate = true;
    n.uploaded = true;
  }


  /* ---- a proper football skin for the 3D ball ---- */
  function ballTexture(){
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#fffdf4';
    x.fillRect(0, 0, 256, 128);
    x.fillStyle = '#20301c';
    for(let i = 0; i < 7; i++){
      const cx = 18 + i * 36, cy = i % 2 ? 40 : 88;
      x.beginPath();
      for(let k = 0; k < 5; k++){
        const a = -Math.PI/2 + k * Math.PI*2/5;
        const px = cx + Math.cos(a) * 15, py = cy + Math.sin(a) * 15;
        if(k === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.closePath();
      x.fill();
    }
    x.strokeStyle = 'rgba(60,60,50,0.35)';
    x.lineWidth = 2;
    for(let i = 0; i < 8; i++){
      x.beginPath(); x.moveTo(i * 32, 0); x.lineTo(i * 32 + 16, 128); x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    if(THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    return t;
  }

  /* ---- name tags in 3D ----
     A little canvas per player turned into a sprite that always faces you. */
  function nameSprite(text, colour){
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.font = 'bold 34px "Segoe UI", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineWidth = 7;
    x.strokeStyle = 'rgba(0,0,0,0.75)';
    x.strokeText(text, 128, 34);
    x.fillStyle = colour || '#ffffff';
    x.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    if(THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(5.2, 1.3, 1);
    return spr;
  }

  /* ---- the crowd throwing things when someone scores ---- */
  function buildCheerBits(){
    const n = 260;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffd76a, size: 1.1,
                                           transparent: true, opacity: 0.95 });
    const pts = new THREE.Points(geo, mat);
    pts.visible = false;
    g3.scene.add(pts);
    return { pts, geo, pos, n, bits: new Array(n).fill(null), live: 0 };
  }

  // launched from the stands, so they rain in over the pitch
  function throwCheerBits(){
    const cb = g3.cheer;
    if(!cb) return;
    const halfW3 = (W * S3) / 2, halfH3 = (H * S3) / 2;
    for(let i = 0; i < cb.n; i++){
      const side = i % 4;
      let x, z;
      if(side === 0){ x = (Math.random()-0.5) * halfW3 * 2; z =  halfH3 + 4; }
      else if(side === 1){ x = (Math.random()-0.5) * halfW3 * 2; z = -halfH3 - 4; }
      else if(side === 2){ x =  halfW3 + 4; z = (Math.random()-0.5) * halfH3 * 2; }
      else { x = -halfW3 - 4; z = (Math.random()-0.5) * halfH3 * 2; }
      cb.bits[i] = {
        x, y: 6 + Math.random() * 4, z,
        vx: -Math.sign(x) * (0.15 + Math.random() * 0.35),
        vy: 0.9 + Math.random() * 0.7,
        vz: -Math.sign(z) * (0.15 + Math.random() * 0.35),
        life: 2.6 + Math.random() * 1.4
      };
    }
    cb.live = cb.n;
    cb.pts.visible = true;
  }

  function updateCheerBits(dt){
    const f = dt * 60;
    const cb = g3.cheer;
    if(!cb || !cb.live) return;
    let alive = 0;
    for(let i = 0; i < cb.n; i++){
      const b = cb.bits[i];
      if(!b){ cb.pos[i*3+1] = -999; continue; }
      b.life -= dt;
      if(b.life <= 0){ cb.bits[i] = null; cb.pos[i*3+1] = -999; continue; }
      b.vy -= 2.2 * dt;
      b.x += b.vx * f; b.y += b.vy * f; b.z += b.vz * f;   // was per-frame: confetti fell 2.4x faster at 144 Hz
      if(b.y < 0.2){ b.y = 0.2; b.vy = 0; b.vx *= 0.9; b.vz *= 0.9; }
      cb.pos[i*3] = b.x; cb.pos[i*3+1] = b.y; cb.pos[i*3+2] = b.z;
      alive++;
    }
    cb.live = alive;
    cb.pts.visible = alive > 0;
    cb.geo.attributes.position.needsUpdate = true;
  }

  /* ---- stadium lighting ----
     A night match: four masts throwing warm pools onto the grass, one of them
     doubling as the key light that actually casts the shadows, and a dim cool
     ambient so nothing ever goes pure black. Shadows are what sell it — without
     them the players look pasted onto the pitch instead of standing on it. */
  function buildLighting(){
    // base fill: cool sky bounce, dark ground bounce
    const hemi = new THREE.HemisphereLight(0xa8cfe6, 0x16321f, 0.42);
    g3.scene.add(hemi);

    // the key light: one shadow map for the whole pitch
    const key = new THREE.DirectionalLight(0xfff3da, 0.78);
    key.position.set(34, 74, 44);
    key.castShadow = true;
    key.shadow.mapSize.width  = 2048;
    key.shadow.mapSize.height = 2048;
    const span = (W * S3) * 0.62;
    key.shadow.camera.left   = -span;
    key.shadow.camera.right  =  span;
    key.shadow.camera.top    =  span;
    key.shadow.camera.bottom = -span;
    key.shadow.camera.near   = 10;
    key.shadow.camera.far    = 190;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.03;
    g3.scene.add(key);
    g3.keyLight = key;

    // a soft bounce from the opposite side so shadowed faces are not flat black
    const fill = new THREE.DirectionalLight(0xc3dcff, 0.24);
    fill.position.set(-40, 42, -50);
    g3.scene.add(fill);

    return { hemi, key, fill };
  }

  /* ---- floodlight masts ----
     Four towers with lit heads and a warm pool of light under each, so the
     pitch has bright corners and a slightly dimmer middle, like a real ground. */
  function buildFloodlights(){
    const halfW3 = (W * S3) / 2 + 14;
    const halfH3 = (H * S3) / 2 + 11;
    const corners = [[ halfW3, halfH3], [-halfW3, halfH3],
                     [ halfW3,-halfH3], [-halfW3,-halfH3]];
    const mastMat = new THREE.MeshLambertMaterial({ color: 0x38434c });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });

    for(const c of corners){
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.8, 36, 8), mastMat);
      mast.position.set(c[0], 18, c[1]);
      mast.castShadow = false;
      g3.scene.add(mast);

      // the rig of lamps at the top
      const rig = new THREE.Group();
      for(let i = 0; i < 6; i++){
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 0.7), lampMat);
        lamp.position.set((i % 3 - 1) * 2.3, Math.floor(i / 3) * 1.8, 0);
        rig.add(lamp);
      }
      rig.position.set(c[0], 35, c[1]);
      rig.lookAt(0, 0, 0);
      g3.scene.add(rig);

      // halo so the rig reads as lit from across the pitch
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(4.6, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xfff0b8, transparent: true, opacity: 0.13 })
      );
      halo.position.set(c[0], 35.5, c[1]);
      g3.scene.add(halo);

      // the pool of light it throws — no shadow map, just colour and falloff
      const spot = new THREE.SpotLight(0xfff4de, 0.42, 230, Math.PI / 4.8, 0.5, 1.3);
      spot.position.set(c[0], 35, c[1]);
      spot.target.position.set(c[0] * 0.28, 0, c[1] * 0.28);
      g3.scene.add(spot);
      g3.scene.add(spot.target);
    }
  }

  // shadows are only worth their cost on the things you actually watch
  function enableShadows(obj, cast, receive){
    if(!obj) return;
    obj.castShadow = !!cast;
    obj.receiveShadow = !!receive;
    if(obj.children) for(const c of obj.children) enableShadows(c, cast, receive);
  }

  /* ---- replay camera ----
     The wide match camera is useless for this: the net moving a couple of world
     units is invisible from up there. So the replay gets its own camera that
     starts behind the shot, swings round the goal and closes right in, framing
     the point where the ball meets the net. */
  function replayCamera(dt){
    const goalX = wx(replay.side === 'left' ? FIELD_MARGIN : W - FIELD_MARGIN);
    const inward = replay.side === 'left' ? 1 : -1;
    const bx = wx(ball.x), bz = wz(ball.y), by = Math.max(0, ball.z) * S3;

    // progress through the replay, including the hold at the end
    const total = replay.span + REPLAY_HOLD;
    const prog  = Math.min(1, replay.t / total);

    // orbit round the goal mouth, tightening and dropping as it goes
    const swing  = -inward * (0.55 + prog * 1.25);
    const radius = 30 - prog * 17;            // 30 -> 13 world units
    const height = 11 - prog * 6.5;           // 11 -> 4.5

    const cx = goalX + inward * radius * Math.cos(swing) * 0.85;
    const cz = bz * 0.55 + radius * Math.sin(swing);
    g3.camera.position.set(cx, height, cz);

    // look at the ball, but drift towards the goal line so the net stays framed
    const lx = bx + (goalX - bx) * 0.55;
    g3.camera.lookAt(lx, by + 1.4, bz * 0.7);

    // a tighter lens as it closes in
    const fov = 42 - prog * 12;
    if(Math.abs(g3.camera.fov - fov) > 0.01){
      g3.camera.fov = fov;
      g3.camera.updateProjectionMatrix();
    }
  }

  // Back to the match lens. Per frame (with dt) it eases from wherever the
  // replay left the FOV instead of snapping 30 -> 42 in one frame; a skip
  // (no dt) still snaps, because the cut is the point of a skip.
  function restoreMatchCamera(dt){
    if(!g3.ready) return;
    const cur = g3.camera.fov;
    if(cur === 42) return;
    const next = dt ? cur + (42 - cur) * Math.min(1, dt * 5) : 42;
    g3.camera.fov = Math.abs(42 - next) < 0.3 ? 42 : next;
    g3.camera.updateProjectionMatrix();
  }

  /* ---- shot power, above the player ----
     The 2D view has had a charge bar under the player's feet for a while; in 3D
     there was nothing, so you were winding up a shot blind. This is the same
     meter as a billboard sprite: the ideal band is marked, and the fill turns
     gold the moment you are inside it. */
  function buildPowerBar(){
    const c = document.createElement('canvas');
    c.width = 200; c.height = 44;
    const tex = new THREE.CanvasTexture(c);
    if(THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true,
                                                            depthTest: false }));
    spr.scale.set(7.2, 1.6, 1);
    spr.visible = false;
    g3.scene.add(spr);
    return { canvas: c, ctx: c.getContext('2d'), tex, spr, last: -1, kind: null };
  }

  function drawPowerBar(bar, charge, isPower){
    const x = bar.ctx, w = 200, h = 44;
    x.clearRect(0, 0, w, h);
    const bx = 8, by = 12, bw = w - 16, bh = 20;

    x.fillStyle = 'rgba(0,0,0,0.72)';
    x.fillRect(bx - 3, by - 3, bw + 6, bh + 6);

    if(isPower){
      x.fillStyle = 'rgba(255,255,255,0.22)';
      x.fillRect(bx + bw * SWEET_MIN, by, bw * (SWEET_MAX - SWEET_MIN), bh);
    }

    const sweet = isPower && charge >= SWEET_MIN && charge <= SWEET_MAX;
    if(sweet){
      x.fillStyle = '#ffe066';
    } else {
      const g = x.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, '#9fe870');
      g.addColorStop(1, '#ff5b3a');
      x.fillStyle = g;
    }
    x.fillRect(bx, by, bw * charge, bh);

    if(isPower){
      x.strokeStyle = sweet ? '#ffe066' : 'rgba(255,255,255,0.65)';
      x.lineWidth = 2;
      x.strokeRect(bx + bw * SWEET_MIN, by - 2, bw * (SWEET_MAX - SWEET_MIN), bh + 4);
    }
    x.strokeStyle = 'rgba(0,0,0,0.8)';
    x.lineWidth = 2;
    x.strokeRect(bx, by, bw, bh);
    bar.tex.needsUpdate = true;
  }

  function updatePowerBars(){
    if(!g3.bars) return;
    for(const team of teams){
      const bar = g3.bars[team.isP1 ? 0 : 1];
      const show = team.charge > 0.02;
      bar.spr.visible = show;
      if(!show){ bar.last = -1; continue; }
      const p = getControlled(team);
      const r = p.radius * S3;
      bar.spr.position.set(wx(p.x), r * 7.4, wz(p.y));
      const kind = team.chargeKind;
      // only repaint when it actually changed, canvas uploads are not free
      if(Math.abs(team.charge - bar.last) > 0.01 || kind !== bar.kind){
        drawPowerBar(bar, team.charge, kind === 'power');
        bar.last = team.charge;
        bar.kind = kind;
      }
    }
  }

  /* ---- hair, in 3D ----
     The flat top-down version of this looked odd and got switched off. In 3D it
     is just geometry sitting on the head, so it reads properly: the parting, the
     bun and the ponytail sit at the back and swing round as the player turns,
     because the whole player group is already rotated to his heading.
     Front is +z (that is where the nose is), so back is -z. */
  function addHair(group, p, r){
    if(!p.hairStyle) return;
    const h = makeHair3d(p.hairStyle, p.hairColor, r);
    if(h) group.add(h);
  }

  function makeHair3d(style, colour, r){
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(colour) });
    const head = r * 0.72;
    const top  = r * 3.5;          // head centre height, matching makePlayerMesh

    const cap = (scale, lift) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(head * (scale || 1.06), 12, 9), mat);
      m.position.y = top + (lift || head * 0.12);
      m.scale.y = 0.82;
      return m;
    };

    switch(style){
      case 'bald':
        return null;                                  // nothing to see

      case 'buzz':
        g.add(cap(1.04, head * 0.10));
        break;

      case 'afro': {
        const a = new THREE.Mesh(new THREE.SphereGeometry(head * 1.55, 12, 10), mat);
        a.position.y = top + head * 0.20;
        g.add(a);
        break;
      }

      case 'mohawk': {
        g.add(cap(1.02, head * 0.06));
        const ridge = new THREE.Mesh(
          new THREE.BoxGeometry(head * 0.34, head * 1.15, head * 2.0), mat);
        ridge.position.y = top + head * 0.85;
        g.add(ridge);
        break;
      }

      case 'ponytail': {
        g.add(cap(1.08, head * 0.12));
        const tail = new THREE.Mesh(
          new THREE.CylinderGeometry(head * 0.30, head * 0.16, head * 2.1, 8), mat);
        tail.position.set(0, top - head * 0.25, -head * 1.15);
        tail.rotation.x = -0.75;                      // hanging down the back
        g.add(tail);
        break;
      }

      case 'bun': {
        g.add(cap(1.06, head * 0.12));
        const knot = new THREE.Mesh(new THREE.SphereGeometry(head * 0.55, 10, 8), mat);
        knot.position.set(0, top + head * 0.75, -head * 0.75);
        g.add(knot);
        break;
      }

      case 'curls': {
        for(let i = 0; i < 9; i++){
          const a = (i / 9) * Math.PI * 2;
          const c = new THREE.Mesh(new THREE.SphereGeometry(head * 0.44, 8, 6), mat);
          c.position.set(Math.cos(a) * head * 0.72,
                         top + head * 0.35 + (i % 2) * head * 0.28,
                         Math.sin(a) * head * 0.72);
          g.add(c);
        }
        break;
      }

      case 'long':
      default: {
        g.add(cap(1.08, head * 0.12));
        const fall = new THREE.Mesh(
          new THREE.BoxGeometry(head * 1.75, head * 2.4, head * 0.55), mat);
        fall.position.set(0, top - head * 0.85, -head * 0.80);
        g.add(fall);
        break;
      }
    }
    return g;
  }

  /* ---- ball trail ----
     A comet tail behind the ball: a string of ghosts that shrink and fade the
     further back they are, sampled from where the ball actually was rather than
     smeared along its current heading, so a curled shot leaves a curved tail.
     Only shows when the ball is genuinely moving or in the air — a ball being
     dribbled should not have a tail. */
  /* ---- small textures and props for the 3D scene ---- */
  function skyGradTex(){
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0,    '#04070d');
    g.addColorStop(0.55, '#0e1828');
    g.addColorStop(1,    '#1c2c42');
    x.fillStyle = g; x.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    if(THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    return t;
  }
  // a radial blob: shared by the ball shadow and every player's contact shadow
  function softShadowTex(){
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  // LED hoardings: self-lit panels with the sponsors this league deserves
  const SPONSORS = ['PASTOS AL PESTO', 'KK SPORTS', 'PENÉLOPE TV', 'CHANCLA AIR',
                    'DON CANGREJO SEGUROS', 'PELUSA COLA', 'FC 27', 'LA FOCA BANK'];
  function hoardingTex(){
    const c = document.createElement('canvas'); c.width = 2048; c.height = 96;
    const x = c.getContext('2d');
    const cols = ['#1e3a8a', '#b91c1c', '#f2c14e', '#065f46', '#4c1d95', '#0e7490', '#111827', '#9a3412'];
    const n = SPONSORS.length, w = c.width / n;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for(let i = 0; i < n; i++){
      x.fillStyle = cols[i % cols.length]; x.fillRect(i * w, 0, w, c.height);
      x.fillStyle = i === 2 ? '#08150e' : '#ffffff';
      x.font = '900 40px "Segoe UI", sans-serif';
      x.fillText(SPONSORS[i], i * w + w / 2, c.height / 2 + 2);
    }
    const t = new THREE.CanvasTexture(c);
    if(THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }
  function buildHoardings(){
    const tex = hoardingTex();
    const halfX = (W * S3) / 2 + 6, halfZ = (H * S3) / 2 + 4;
    const hgt = 1.5;
    const mk = (len, x, z, rotY, repeat, offset) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(len, hgt, 0.3),
        [null, null, null, null, new THREE.MeshBasicMaterial({ map: tex }), new THREE.MeshBasicMaterial({ color: 0x111827 })]
          .map(mm => mm || new THREE.MeshBasicMaterial({ color: 0x111827 }))
      );
      m.position.set(x, hgt / 2, z);
      m.rotation.y = rotY;
      g3.scene.add(m);
      return m;
    };
    // one texture strip, repeated along each board so the panels stay square
    if(tex.repeat) tex.repeat.set(2.4, 1);
    mk(halfX * 2, 0, -halfZ, 0);            // far touchline (faces the camera)
    mk(halfX * 2, 0,  halfZ, Math.PI);      // near touchline
    mk(halfZ * 2, -halfX, 0,  Math.PI / 2); // behind the left goal
    mk(halfZ * 2,  halfX, 0, -Math.PI / 2); // behind the right goal
  }

  /* ---- ground particles ----
     Kick dust, slide spray, tackle bursts, the goal burst: seventeen call sites
     spawn them and every one was drawn on the 2D canvas only, so the 3D view
     had no impact feedback at all. One THREE.Points reads the same array. */
  const GB_MAX = 160;
  function buildGroundBits(){
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(GB_MAX * 3);
    for(let i = 0; i < GB_MAX; i++) pos[i*3+1] = -999;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xe6f3da, size: 0.6, transparent: true, opacity: 0.75, depthWrite: false }));
    pts.frustumCulled = false;
    g3.scene.add(pts);
    return { geo, pos, pts };
  }
  function updateGroundBits(){
    const gb = g3.bits;
    if(!gb) return;
    const n = Math.min(particles.length, GB_MAX), pos = gb.pos;
    for(let i = 0; i < GB_MAX; i++){
      if(i >= n){ pos[i*3+1] = -999; continue; }
      const p = particles[i];
      const age = 1 - p.life / p.maxLife;
      pos[i*3]   = wx(p.x);
      pos[i*3+1] = 0.25 + age * 1.1;       // lifts off the grass as it fades
      pos[i*3+2] = wz(p.y);
    }
    gb.geo.attributes.position.needsUpdate = true;
    gb.pts.visible = n > 0;
  }

  const TRAIL_N = 16;
  function buildBallTrail(){
    const ghosts = [];
    for(let i = 0; i < TRAIL_N; i++){
      const k = i / TRAIL_N;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(ball.radius * S3 * (1 - k * 0.72), 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
                                      opacity: 0.42 * (1 - k), depthWrite: false })
      );
      m.visible = false;
      g3.scene.add(m);
      ghosts.push(m);
    }
    return { ghosts, hist: [] };
  }

  function updateBallTrail(){
    const t = g3.trail;
    if(!t) return;
    const speed = Math.hypot(ball.vx, ball.vy);
    const show  = speed > 5.5 || ball.z > 8;

    t.hist.unshift({ x: wx(ball.x),
                     y: Math.max(0, ball.z) * S3 + ball.radius * S3,
                     z: wz(ball.y) });
    if(t.hist.length > TRAIL_N * 2 + 2) t.hist.pop();

    const fire = ball.shotFire && ball.shotTimer > 0;
    for(let i = 0; i < TRAIL_N; i++){
      const g = t.ghosts[i];
      const h = t.hist[i * 2 + 1];
      if(!show || !h){ g.visible = false; continue; }
      g.visible = true;
      g.position.set(h.x, h.y, h.z);
      // a fire shot burns from white at the ball to deep orange at the tail
      const k = i / TRAIL_N;
      g.material.color.setRGB(fire ? 1 : 1,
                              fire ? 1 - k * 0.45 : 1,
                              fire ? 0.55 - k * 0.5 : 1);
      g.material.opacity = (fire ? 0.6 : 0.42) * (1 - k);
    }
  }

  /* ---- containing, shown on the grass ----
     The top-down view has had a red wedge for this for a while. In 3D there was
     nothing, so you could not tell whether the button had taken. */
  function buildContainMark(){
    const m = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.4, 26, 1, -0.75, 1.5),
      new THREE.MeshBasicMaterial({ color: 0xff6a4a, side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.85,
                                    depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    g3.scene.add(m);
    return m;
  }

  /* ---- the fire power, in 3D ----
     This only ever existed on the top-down canvas. In the 3D view the orb was
     literally invisible: it sat somewhere on the pitch, you picked it up by
     accident, and your only clue was the shot coming out orange afterwards.
     Here it is a real object — a burning core inside a halo, turning and
     bobbing and throwing light onto the grass — plus a ring under whoever is
     carrying it that closes up as the fifteen seconds run out. */
  function buildPowerOrb(){
    const g = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.5, 1),
      new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true })
    );
    g.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff7a22, transparent: true,
                                    opacity: 0.32, depthWrite: false })
    );
    g.add(halo);

    // a flat ring on the grass: from a low camera the orb can hide behind a
    // player, and this still tells you where it is
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.7, 28),
      new THREE.MeshBasicMaterial({ color: 0xff9a3c, side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.5,
                                    depthWrite: false })
    );
    pad.rotation.x = -Math.PI / 2;
    g.add(pad);

    const lamp = new THREE.PointLight(0xff8a33, 1.6, 30, 2);
    g.add(lamp);

    g.visible = false;
    g3.scene.add(g);
    return { g, core, halo, pad, lamp };
  }

  function updatePowerOrb(){
    const o = g3.orb;
    if(!o) return;
    const pu = powerups[0];
    if(!pu){ o.g.visible = false; return; }

    o.g.visible = true;
    const pulse = 1 + Math.sin(pu.phase) * 0.14;
    // blinks out its last three seconds, the same tell the 2D version gives
    const fade = pu.life < 3 ? (0.35 + 0.65 * Math.abs(Math.sin(pu.life * 8))) : 1;
    const y = 2.2 + Math.sin(pu.phase * 0.7) * 0.5;

    o.g.position.set(wx(pu.x), y, wz(pu.y));
    o.core.rotation.y += 0.05;
    o.core.rotation.x += 0.02;
    o.core.scale.setScalar(pulse);
    o.core.material.opacity = fade;
    o.halo.scale.setScalar(pulse);
    o.halo.material.opacity = 0.32 * fade;
    o.pad.position.y = 0.06 - y;                 // cancels the bob: stays on the grass
    o.pad.material.opacity = 0.5 * fade;
    o.lamp.intensity = 1.6 * fade * pulse;
  }

  function buildFireRing(){
    const m = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.3, 30),
      new THREE.MeshBasicMaterial({ color: 0xffae3c, side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.9,
                                    depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    g3.scene.add(m);
    return m;
  }

  function updateFireRings(){
    if(!g3.fireRings) return;
    for(const team of teams){
      const ring = g3.fireRings[team.isP1 ? 0 : 1];
      if(team.powerup !== 'fire'){ ring.visible = false; continue; }
      const p = getControlled(team);
      ring.visible = true;
      ring.position.set(wx(p.x), 0.07, wz(p.y));
      const left = Math.max(0, Math.min(1, team.powerupTimer / PU_HOLD_TIME));
      ring.scale.setScalar(0.72 + left * 0.38);      // shrinks as the window closes
      const hot = team.powerupTimer < 4;             // last seconds: red and flashing
      ring.material.color.setRGB(1, hot ? 0.30 : 0.68, hot ? 0.14 : 0.24);
      ring.material.opacity = hot
        ? 0.55 + 0.40 * Math.abs(Math.sin(performance.now() / 110))
        : 0.9;
    }
  }

  function updateContainMarks(){
    if(!g3.contain) return;
    for(const team of teams){
      const mark = g3.contain[team.isP1 ? 0 : 1];
      if(!team.containing){ mark.visible = false; continue; }
      const p = getControlled(team);
      mark.visible = true;
      mark.position.set(wx(p.x), 0.06, wz(p.y));
      // the arc opens towards the ball, which is where he is facing
      mark.rotation.z = -Math.atan2(wz(ball.y) - wz(p.y), wx(ball.x) - wx(p.x));
    }
  }

  // The player is two groups. `rig` holds everything that animates — torso,
  // head, legs, hair — and is what tilts for a slide or a fall. The root
  // holds the selection ring and the name tag, which must NOT tilt: the old
  // single group took the ring edge-on and dropped the tag to the grass at
  // exactly the moment you were sliding and most needed to know who you had.
  function makePlayerMesh(p){
    const group = new THREE.Group();
    const rig   = new THREE.Group();
    rig.rotation.order = 'YXZ';
    group.add(rig);
    const col   = new THREE.Color(p.role === 'GK' ? '#f3f5f0' : p.color);
    const r     = p.radius * S3;

    // torso sits on top of the legs instead of reaching the ground
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.78, r * 0.92, r * 1.95, 14),
      new THREE.MeshLambertMaterial({ color: col })
    );
    body.position.y = r * 2.12;
    rig.add(body);

    // legs: two boxes that swing while he runs (see draw3d)
    const legMat = new THREE.MeshLambertMaterial({ color: 0x26303a });
    const legL = new THREE.Mesh(new THREE.BoxGeometry(r * 0.36, r * 1.3, r * 0.34), legMat);
    const legR = new THREE.Mesh(new THREE.BoxGeometry(r * 0.36, r * 1.3, r * 0.34), legMat);
    legL.position.set(-r * 0.34, r * 0.65, 0);
    legR.position.set( r * 0.34, r * 0.65, 0);
    rig.add(legL); rig.add(legR);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.72, 14, 10),
      new THREE.MeshLambertMaterial({ color: '#e8b98c' })
    );
    head.position.y = r * 3.5;
    rig.add(head);

    // a small wedge so you can read which way he is facing
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(r * 0.30, r * 0.9, 8),
      new THREE.MeshLambertMaterial({ color: '#ffffff' })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, r * 2.2, r * 1.0);
    rig.add(nose);

    // keepers wear white for both sides; a band in the team colour tells them apart
    if(p.role === 'GK'){
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.86, r * 0.92, r * 0.5, 14),
        new THREE.MeshLambertMaterial({ color: new THREE.Color(p.color) })
      );
      band.position.y = r * 2.45;
      rig.add(band);
    }

    // ring under the player you are controlling
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.35, r * 1.75, 22),
      new THREE.MeshBasicMaterial({ color: '#f2c14e', side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.95 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.visible = false;
    group.add(ring);

    // a soft contact shadow at his feet: the key light throws the real shadow
    // a few units away, so without this he reads as slightly hovering
    if(g3.softShadow){
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(r * 3.2, r * 3.2),
        new THREE.MeshBasicMaterial({ map: g3.softShadow, transparent: true, opacity: 0.32, depthWrite: false })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.03;
      group.add(blob);
    }

    let tag = null;
    if(p.name){
      tag = nameSprite(p.name, p.role === 'GK' ? '#cfe9d4' : '#ffffff');
      tag.position.y = r * 5.4;
      // never let a label punch through a post or the near stand
      tag.material.depthTest = false; tag.material.depthWrite = false;
      tag.renderOrder = 5;
      group.add(tag);
    }
    group.userData = { rig, body, head, nose, ring, tag, legL, legR, base:r };
    addHair(rig, p, r);
    return group;
  }

  function init3d(){
    if(g3.ready || !has3d()) return;

    g3.renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
    g3.renderer.setClearColor(0x0d1624, 1);
    g3.renderer.shadowMap.enabled = true;
    g3.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if(THREE.sRGBEncoding !== undefined) g3.renderer.outputEncoding = THREE.sRGBEncoding;
    if(THREE.ACESFilmicToneMapping !== undefined){
      g3.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      g3.renderer.toneMappingExposure = 1.08;
    }

    g3.scene = new THREE.Scene();
    g3.scene.fog = new THREE.Fog(0x14202f, 150, 330);

    g3.camera = new THREE.PerspectiveCamera(42, 16/9, 1, 500);

    g3.lights = buildLighting();

    // the pitch: the very same canvas the 2D view draws its lines on
    if(!fieldCache) buildFieldCache();
    const tex = new THREE.CanvasTexture(fieldCache);
    tex.anisotropy = g3.renderer.capabilities ? g3.renderer.capabilities.getMaxAnisotropy() : 4;
    // A canvas is sRGB data. Without saying so it gets treated as linear and
    // the grass comes out dark and muddy — which was most of why the lighting
    // looked wrong.
    if(THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    // Lambert in r128 is lit PER VERTEX. On a 4-vertex plane that meant the
    // four floodlight pools and the fire orb's glow were sampled at exactly
    // four points — i.e. never seen. ~1300 verts is still one draw call.
    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(W * S3, H * S3, 48, 27),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    g3.scene.add(pitch);
    g3.pitchTex = tex;

    // a bit of ground around the touchlines so the pitch is not floating
    const surround = new THREE.Mesh(
      new THREE.PlaneGeometry(W * S3 * 2.1, H * S3 * 2.6, 12, 12),
      new THREE.MeshLambertMaterial({ color: 0x1b3626 })
    );
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.15;
    surround.receiveShadow = true;
    g3.scene.add(surround);

    // The sky: a gradient sphere seen from inside. There was nothing behind
    // the stands but the clear colour, and the fog started at 150 units when
    // nothing in the scene is ever that far from the camera — so it never
    // touched a single pixel. Now it starts on the far stand.
    g3.scene.fog = new THREE.Fog(0x101a2a, 70, 230);
    g3.renderer.setClearColor(0x101a2a, 1);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 16, 10),
      new THREE.MeshBasicMaterial({ map: skyGradTex(), side: THREE.BackSide, fog: false, depthWrite: false })
    );
    g3.scene.add(sky);

    // advertising hoardings round the pitch: the cheapest "real stadium" cue
    // there is, and they hide the seam where the grass meets the surround
    buildHoardings();
    g3.bits = buildGroundBits();
    g3.axis = new THREE.Vector3();
    g3.softShadow = softShadowTex();

    // goal frames
    const postMat = new THREE.MeshLambertMaterial({ color: 0xf7f7f2 });
    [[FIELD_MARGIN, 1], [W - FIELD_MARGIN, -1]].forEach(function(pair){
      const gx = pair[0], dir = pair[1];
      const halfW3 = (GOAL_WIDTH / 2) * S3;
      const hgt = GOAL_H3, depth = GOAL_DEPTH * S3, pr = 0.14;
      const frame = new THREE.Group();
      // round posts and bar, like real ones — the square 0.22 boxes read as
      // flat sticks — plus the back frame so the goal has a silhouette from
      // behind: two stanchions leaning back to a ground bar
      [-halfW3, halfW3].forEach(function(zz){
        const post = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, hgt, 10), postMat);
        post.position.set(0, hgt/2, zz);
        frame.add(post);
        const stLen = Math.hypot(depth, hgt);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(pr * 0.7, pr * 0.7, stLen, 8), postMat);
        st.position.set(-dir * depth / 2, hgt / 2, zz);
        st.rotation.z = -dir * Math.atan2(depth, hgt);
        frame.add(st);
      });
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, halfW3 * 2, 10), postMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(0, hgt, 0);
      frame.add(bar);
      const ground = new THREE.Mesh(new THREE.CylinderGeometry(pr * 0.7, pr * 0.7, halfW3 * 2, 8), postMat);
      ground.rotation.x = Math.PI / 2;
      ground.position.set(-dir * depth, 0.1, 0);
      frame.add(ground);
      frame.position.x = wx(gx);
      enableShadows(frame, true, false);   // posts and bar drop shadows on the grass
      g3.scene.add(frame);
      // the back of the net is simulated cloth, built in world space
      g3.nets3d.push(buildNet3d(gx === FIELD_MARGIN ? 'left' : 'right', wx(gx), dir));
    });

    // players and ball
    g3.players = allPlayers().map(p => {
      const m = makePlayerMesh(p);
      enableShadows(m, true, false);
      g3.scene.add(m);
      return { p, m };
    });

    g3.ball = new THREE.Mesh(
      new THREE.SphereGeometry(ball.radius * S3, 20, 16),
      new THREE.MeshLambertMaterial({ map: ballTexture() })
    );
    g3.ball.castShadow = true;
    g3.scene.add(g3.ball);

    // a soft blob on the grass under the ball, so height stays readable: it
    // was a hard black coin that only shrank, never softened, as the ball rose
    g3.ballShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(ball.radius * S3 * 2.6, ball.radius * S3 * 2.6),
      new THREE.MeshBasicMaterial({ map: g3.softShadow, transparent: true, opacity: 0.4, depthWrite: false })
    );
    g3.ballShadow.rotation.x = -Math.PI / 2;
    g3.scene.add(g3.ballShadow);

    g3.bars = [buildPowerBar(), buildPowerBar()];
    g3.trail = buildBallTrail();
    g3.contain = [buildContainMark(), buildContainMark()];
    g3.orb = buildPowerOrb();
    g3.fireRings = [buildFireRing(), buildFireRing()];
    buildFloodlights();
    buildStands();
    g3.cheer = buildCheerBits();
    g3.flags = [
      buildFlag(-(W * S3) / 2 - 9, -(H * S3) / 2 - 4),
      buildFlag( (W * S3) / 2 + 9,  (H * S3) / 2 + 4)
    ];

    g3.ready = true;
    resize3d();
  }

  function resize3d(){
    if(!g3.ready) return;
    // use the size resizeCanvas already worked out, not a measurement of an
    // absolutely-positioned canvas that may still report zero
    const wpx = viewW, hpx = viewH;
    if(!(wpx > 1) || !(hpx > 1)) return;
    g3.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    g3.renderer.setSize(wpx, hpx, false);
    canvas3d.style.width  = wpx + 'px';
    canvas3d.style.height = hpx + 'px';
    g3.camera.aspect = wpx / hpx;
    g3.camera.updateProjectionMatrix();
  }

  function draw3d(dt){
    if(!g3.ready) return;

    // The match camera keeps tracking the ball even while the intro or the
    // replay own the view, so the hand-back starts from the right place
    // instead of cutting to wherever it was frozen.
    const bsp = Math.hypot(ball.vx, ball.vy);
    {
      // a medium-high angle that drifts with the play instead of following it
      // tightly, leading the ball a little along its travel
      const lead = 9;
      const tx = (wx(ball.x) + ball.vx * S3 * lead) * 0.45;
      const tz = (wz(ball.y) + ball.vy * S3 * lead) * 0.30;
      const k = Math.min(1, dt * 2.4);
      g3.camX += (tx - g3.camX) * k;
      g3.camZ += (tz - g3.camZ) * k;
      // and it rises a touch when the ball is really moving
      const wantH = 62 + Math.min(bsp, 22) * 0.45;
      if(g3.camH === undefined) g3.camH = 62;
      g3.camH += (wantH - g3.camH) * Math.min(1, dt * 1.1);
    }

    if(intro.active){
      introCamera();
    } else if(replay.active){
      replayCamera(dt);
    } else {
      restoreMatchCamera(dt);
      g3.camera.position.set(g3.camX, g3.camH, g3.camZ + 58);
      g3.camera.lookAt(g3.camX * 0.6, 0, g3.camZ - 4);
      // the impact shake moves the CAMERA here; the 2D overlay barely moves.
      // Before, the world stood rock still on a goal while the text jittered.
      if(shake > 0.4 && !REDUCE_MOTION){
        const s = shake * 0.03;
        g3.camera.position.x += (Math.random() - 0.5) * s;
        g3.camera.position.y += (Math.random() - 0.5) * s;
        g3.camera.rotateZ((Math.random() - 0.5) * 0.0016 * shake);
      }
    }

    for(const it of g3.players){
      const p = it.p, m = it.m, ud = m.userData;
      m.position.set(wx(p.x), 0, wz(p.y));
      const ang = Math.atan2(p.facing.x, p.facing.y);
      m.rotation.y = ang;

      const down  = p.downTimer > 0;
      const slide = p.slideTimer > 0;
      // a run cycle: legs swing, body bobs. The 2D view advanced runPhase in
      // its own draw; in 3D nobody did, so fourteen capsules glided about.
      const speed = Math.hypot(p.vx, p.vy);
      p.runPhase += speed * 0.09 * dt * 60;
      const swing = Math.sin(p.runPhase) * Math.min(speed, 5) * 0.16;
      if(ud.legL){ ud.legL.rotation.x = swing; ud.legR.rotation.x = -swing; }
      const rig = ud.rig || m;
      rig.position.y = (down || slide) ? 0 : Math.abs(Math.sin(p.runPhase)) * Math.min(speed, 5) * 0.03 * ud.base;
      // lie him down for a slide or while he is on the floor — about HIS own
      // axis, now that the tilt is on the rig and under the yaw
      let lean = (down || slide) ? -Math.PI / 2.4 : 0;
      // winding up a shot: he leans back and cocks the kicking leg
      const tm = teamOf(p);
      if(!lean && tm.outfield[tm.controlledIndex] === p && tm.charge > 0.02){
        lean = -tm.charge * 0.22;
        if(ud.legR) ud.legR.rotation.x = -tm.charge * 0.9;
      }
      rig.rotation.x = lean;
      ud.ring.visible = (p.role !== 'GK') && (tm.outfield[tm.controlledIndex] === p);
      const beaten = p.role === 'GK' && p.beatenTimer > 0;
      ud.body.material.opacity = beaten ? 0.3 : 1;
      ud.body.material.transparent = beaten;
    }

    const bz = Math.max(0, ball.z) * S3;
    g3.ball.position.set(wx(ball.x), bz + ball.radius * S3, wz(ball.y));
    // roll about the axis perpendicular to travel: it used to spin about world
    // X regardless, so a shot down the pitch turned sideways like a top
    if(bsp > 0.01 && g3.axis){
      g3.axis.set(ball.vy, 0, -ball.vx).normalize();
      g3.ball.rotateOnWorldAxis(g3.axis, bsp * dt * 60 / ball.radius);
    }
    g3.ballShadow.position.set(wx(ball.x), 0.04, wz(ball.y));
    const up = Math.min(ball.z / 110, 1);
    g3.ballShadow.scale.setScalar(Math.max(0.35, 1 - up * 0.45));
    g3.ballShadow.material.opacity = 0.4 * (1 - up * 0.6);   // fainter the higher it is

    const now = performance.now();
    for(const n of g3.nets3d) updateNet3d(n);
    updateCrowd(dt, now);
    updatePowerBars();
    updateBallTrail();
    updateContainMarks();
    updatePowerOrb();
    updateFireRings();
    updateGroundBits();
    updateCheerBits(dt);
    if(g3.flags) for(const fl of g3.flags) updateFlag(fl, dt, now);

    g3.renderer.render(g3.scene, g3.camera);
  }

  function setView(is3d){
    const want = is3d && has3d();
    if(want && !g3.ready) init3d();
    view3d = want && g3.ready;
    if(canvas3d) canvas3d.hidden = !view3d;
    if(stageEl) stageEl.classList.toggle('mode3d', view3d);
    if(view3d) resize3d();
  }

  /* =========================================================
     Loop
     ========================================================= */
  function formatTime(t){
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function endMatch(){
    running = false;
    sfx.whistle('full');
    const winner = score1 === score2 ? null : (score1 > score2 ? team1 : team2);
    flashStatus(winner ? '¡Gana el equipo ' + winner.name + '!' : '¡Empate!');
    celebration = {
      text: winner ? '¡GANA ' + winner.name.toUpperCase() + '!' : '¡EMPATE!',
      sub: score1 + '  -  ' + score2,
      color: winner ? winner.color : '#f2c14e',
      t: 0,
      big: true,          // full-screen finish
      confetti: 4.2,      // seconds of falling confetti
      duration: 5.0
    };
    shake = Math.max(shake, 14);
    endPending = true;
    endTimer = setTimeout(showEndOverlay, 5200);
  }
  let endTimer = null, endPending = false;
  // any key or button cuts the final confetti short
  function skipEnding(){
    if(!endPending) return false;
    clearTimeout(endTimer);
    showEndOverlay();
    return true;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  // The result card. The old end screen was one line — "AZUL 3 — 1 ROJO" —
  // dropped on top of the full controls table. Everything here was already
  // being counted somewhere; it just never reached the player.
  function showEndOverlay(){
    endPending = false;
    const winner = score1 === score2 ? null : (score1 > score2 ? team1 : team2);
    const total = possession[0] + possession[1] || 1;
    const p1 = Math.round(possession[0] / total * 100);

    // player of the match: most goals (own goals do not count), then the busiest keeper
    const tally = {};
    for(const g of stats.goals){ if(g.own || !g.who) continue; tally[g.who] = (tally[g.who] || 0) + 1; }
    let mvp = null, mvpN = 0;
    for(const k in tally) if(tally[k] > mvpN){ mvp = k; mvpN = tally[k]; }
    let mvpLine = '';
    if(mvp){
      mvpLine = '🏅 Jugador del partido: <b>' + esc(mvp) + '</b> (' + mvpN + (mvpN === 1 ? ' gol' : ' goles') + ')';
    } else {
      const s1 = stats.saves[0], s2 = stats.saves[1];
      if(s1 + s2 > 0){
        const gk = s1 >= s2 ? team1.gk : team2.gk;
        mvpLine = '🧤 Jugador del partido: <b>' + esc(gk.name || 'el arquero') + '</b> (' + Math.max(s1, s2) + ' atajadas)';
      }
    }
    const goalList = stats.goals.map(g =>
      '<span style="color:' + g.team.color + '">●</span> ' + esc(g.who || g.team.name) +
      (g.own ? ' (p.p.)' : '') + " " + g.minute + "'").join(' &nbsp;·&nbsp; ');

    const row = (k, a, b) => '<tr><td>' + a + '</td><td class="k">' + k + '</td><td>' + b + '</td></tr>';
    finalScoreEl.innerHTML =
      '<div class="res-line"><span class="n1">' + score1 + '</span><span class="dash">—</span><span class="n2">' + score2 + '</span></div>' +
      '<div class="res-teams"><span class="res-team">' + esc(team1.name) + '</span><span class="res-team">' + esc(team2.name) + '</span></div>' +
      '<div class="res-winner">' + (winner ? '¡Gana ' + esc(winner.name) + '!' : 'Empate') + '</div>' +
      '<div class="res-poss" title="Posesión"><i style="width:' + p1 + '%"></i></div>' +
      '<table class="res-stats">' +
        row('Posesión', p1 + '%', (100 - p1) + '%') +
        row('Tiros', stats.shots[0], stats.shots[1]) +
        row('A puerta', stats.onTarget[0], stats.onTarget[1]) +
        row('Atajadas', stats.saves[0], stats.saves[1]) +
        row('Robos', stats.steals[0], stats.steals[1]) +
        row('Al palo', stats.posts[0], stats.posts[1]) +
      '</table>' +
      (mvpLine ? '<div class="res-mvp">' + mvpLine + '</div>' : '') +
      (goalList ? '<div class="res-goals">' + goalList + '</div>' : '');
    finalScoreEl.hidden = false;
    finalScoreEl.style.display = '';
    overlay.classList.add('result');
    startBtn.textContent = '↺ Revancha';
    if(settingsBtn) settingsBtn.hidden = false;
    overlay.classList.remove('hidden');
    uiRow = 0; uiCol = 0; uiPaint();   // cursor on "Revancha"
  }
  if(settingsBtn) settingsBtn.addEventListener('click', () => {
    // back to the full menu, keeping the card visible above it
    overlay.classList.remove('result');
    settingsBtn.hidden = true;
    startBtn.textContent = 'Empezar partido';
    uiRow = 0; uiCol = 0; uiPaint();
  });

  /* ---- pause: a menu, not a veil ----
     Once a match had started there was no way to restart, change view, mute
     or get back to the menu without reloading the page. */
  function togglePause(){
    if(!running) return;
    paused = !paused;
    pauseBtn.textContent = paused ? '▶' : '⏸';
    statusEl.textContent = paused ? 'Pausa' : '';
    if(pauseMenu){
      pauseMenu.hidden = !paused;
      if(paused){
        refreshPauseLabels();
        uiRow = 0; uiCol = 0; uiPaint();
      } else {
        lastTs = null;          // do not integrate the time we were away
        uiPaint();
      }
    }
  }
  function refreshPauseLabels(){
    if(pauseViewBtn){
      pauseViewBtn.textContent = view3d ? '▦ Vista: cambiar a 2D' : '🎥 Vista: cambiar a 3D';
      pauseViewBtn.disabled = !has3d();
    }
    if(pauseSoundBtn) pauseSoundBtn.textContent = soundOn ? '🔊 Sonido: activado' : '🔇 Sonido: silenciado';
  }
  function goToMenu(){
    running = false; paused = false;
    pauseBtn.textContent = '⏸';
    if(pauseMenu) pauseMenu.hidden = true;
    celebration = null; replay.active = false; intro.active = false;
    goalAction = 0; pendingGoal = null;
    overlay.classList.remove('hidden', 'result');
    finalScoreEl.hidden = true;
    if(settingsBtn) settingsBtn.hidden = true;
    startBtn.textContent = 'Empezar partido';
    restoreMatchCamera();
    uiRow = 0; uiCol = 0; uiPaint();
  }
  if(pauseMenu) pauseMenu.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if(!btn) return;
    const act = btn.dataset.act;
    if(act === 'resume')  togglePause();
    else if(act === 'restart'){ togglePause(); startMatch(); }
    else if(act === 'view'){
      if(!has3d()) return;
      setView(!view3d);
      const b = viewSeg && viewSeg.querySelector('[data-view="' + (view3d ? '3d' : '2d') + '"]');
      if(b && viewSeg) pickSeg(viewSeg, b);
      saveSettings();
      refreshPauseLabels();
    }
    else if(act === 'sound'){ ensureAudio(); toggleMute(); refreshPauseLabels(); }
    else if(act === 'menu'){ goToMenu(); }
  });

  // Losing the tab should not keep the clock running, nor the crowd droning
  // out of a background tab: the Web Audio graph is not tied to rAF.
  if(document.addEventListener) document.addEventListener('visibilitychange', () => {
    if(document.hidden){
      if(running && !paused) togglePause();
      if(master && audioCtx) master.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    } else {
      lastTs = null;
      if(master && audioCtx) master.gain.setTargetAtTime(soundOn ? 1 : 0, audioCtx.currentTime, 0.08);
    }
  });
  // a pad dropping out mid-attack left your man standing there with no explanation
  window.addEventListener('gamepaddisconnected', () => {
    if(running && !paused){ togglePause(); flashStatus('Mando desconectado', 'play'); }
  });

  // fullscreen: F11 is fine on a desktop; laptops with touch and tablets need a button
  if(fsBtn) fsBtn.addEventListener('click', () => {
    const el = document.getElementById('app') || document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if(isFs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if(el.requestFullscreen || el.webkitRequestFullscreen)
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  });
  // a phone cannot play this, and it should say so instead of showing a match
  // that plays itself
  if(mobileNote && window.matchMedia && window.matchMedia('(pointer:coarse)').matches &&
     !window.matchMedia('(pointer:fine)').matches){
    mobileNote.hidden = false;
  }
  pauseBtn.addEventListener('click', togglePause);

  function step(dt){
    // the ball is still in the net: keep simulating it, but stop the clock
    if(goalAction > 0){
      goalAction -= dt;
      if(goalAction <= 0) finishGoal();
    } else {
      matchTime -= dt;
    }
    if(matchTime <= 0 && goalAction <= 0){ matchTime = 0; endMatch(); }
    timeEl.textContent = formatTime(matchTime);
    timeEl.classList.toggle('low', matchTime <= 15 && matchTime > 0);

    pollGamepadSwitch();

    if(kickoffTimer > 0){
      kickoffTimer -= dt;
      // players still settle into their positions, but nobody moves the ball
      teams.forEach(t => { updateTeamAdvance(t, dt); });
      return;
    }

    tickSwitchTimers(team1, dt);
    tickSwitchTimers(team2, dt);
    updatePowerups(dt);
    if(rumbleCooldown[0] > 0) rumbleCooldown[0] -= dt;
    if(rumbleCooldown[1] > 0) rumbleCooldown[1] -= dt;

    teams.forEach(t => {
      t.sprintInput = false;
      updateTeamAdvance(t, dt);
    });

    updateControlledPlayer(team1, dt);
    updateControlledPlayer(team2, dt);

    // sprint state is computed after human input so teammates react the same frame
    teams.forEach(t => updateTeamSprint(t, dt));

    updateAiOutfield(team1, dt);
    updateAiOutfield(team2, dt);
    updateGoalkeeper(team1, dt);
    updateGoalkeeper(team2, dt);

    resolveAllCollisions();
    updateBall(dt);
    recordFrame();
    goalCheck();

    // control always sits with whoever has the ball
    enforcePossessionControl(team1);
    enforcePossessionControl(team2);

    if(lastTouchTeam === team1) possession[0] += dt;
    else if(lastTouchTeam === team2) possession[1] += dt;
  }

  let hudTimer = 0;
  let overlayDirty = true;   // the 2D overlay has something on it that needs clearing
  function gameLoop(ts){
    if(!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    dropPadSnapshot();
    pollUiPad();   // menu, mute and skips: works whether or not the match ticks

    if(running && !paused && intro.active){
      updateIntro(dt);
    } else if(running && !paused && replay.active){
      updateReplay(dt);
    } else if(running && !paused){
      step(dt);
      hudTimer += dt;
      if(hudTimer > 0.5){ hudTimer = 0; updatePossessionHud(); }
    }
    updateParticles(dt);
    updateAmbience(dt);
    updateNets(dt);

    // ---- render ----
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    if(REDUCE_MOTION) shake = 0;
    if(shake > 0){
      shake *= Math.pow(0.9, dt * 60);     // decays per second, not per frame
      if(shake < 0.4) shake = 0;
      // in 3D the camera itself shakes (draw3d); the overlay only follows a little
      const k = view3d ? 0.3 : 1;
      ctx.translate((Math.random()-0.5) * shake * k, (Math.random()-0.5) * shake * k);
    }

    if(!fieldCache || fieldCacheW !== canvas.width || fieldCacheH !== canvas.height){
      buildFieldCache();
      if(g3.pitchTex) g3.pitchTex.needsUpdate = true;
    }

    if(view3d){
      // three.js draws the match; the 2D canvas stays on top for the overlays.
      // Most frames there is nothing to overlay, and clearing + compositing a
      // full-size transparent canvas for nothing was 20-40% of the frame on a
      // hidpi laptop — so it is only touched when something is actually on it.
      draw3d(dt);
      const needs2d = kickoffTimer > 0 || celebration || replay.active || intro.active ||
                      paused || shake > 0;
      if(needs2d || overlayDirty){
        ctx.clearRect(0, 0, W, H);
        overlayDirty = !!needs2d;
      }
      if(needs2d){
        drawKickoffCountdown();
        drawCelebration(paused ? 0 : dt);
        if(celebration && celebration.big) drawParticles();   // final confetti
        if(replay.active) drawReplayFrame();
        if(intro.active) drawIntroFrame();
        if(paused) drawPauseVeil();
      }
    } else {
      ctx.drawImage(fieldCache, 0, 0, W, H);
      drawGoals();
      drawTeam(team1);
      drawTeam(team2);
      drawBall();
      drawPowerups();
      drawKickoffCountdown();
      drawCelebration(paused ? 0 : dt);
      drawParticles();   // above the celebration panel, so confetti reads on top
      if(replay.active) drawReplayFrame();
      if(paused) drawPauseVeil();
    }

    requestAnimationFrame(gameLoop);
  }

  /* =========================================================
     Start / options
     ========================================================= */
  // ---- 2D or 3D ----
  const viewSeg = document.getElementById('view-seg');
  if(viewSeg){
    viewSeg.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if(!btn) return;
      const want3d = btn.dataset.view === '3d';
      if(want3d && !has3d()) return;   // the button is disabled below; belt and braces
      pickSeg(viewSeg, btn);
      setView(want3d);
      saveSettings();
    });
    // three.js did not load (offline, CDN blocked): say so ON the button. The
    // old status-line message was written underneath the menu, where nobody
    // could see it, so pressing 3D appeared to do nothing at all.
    if(!has3d()){
      const b3 = viewSeg.querySelector('[data-view="3d"]');
      if(b3){ b3.disabled = true; b3.textContent = '🎥 3D — sin conexión'; b3.title = 'El modo 3D necesita descargar three.js. El 2D funciona siempre.'; }
    }
  }

  // ---- who is player 2: a friend on the couch, or the machine ----
  const modeSeg  = document.getElementById('mode-seg');
  const levelSeg = document.getElementById('level-seg');
  const levelRow = document.getElementById('level-row');
  const p2Col    = document.querySelector('.controls-col.p2');
  const crest2   = document.querySelector('.team-tag.p2 .crest');
  const name2    = document.querySelector('.team-tag.p2 .team-name');

  function applyMode(){
    if(levelRow) levelRow.hidden = !cpuMode;
    if(in2Row) in2Row.hidden = cpuMode;
    uiPaint();
    if(p2Col)  p2Col.style.display = cpuMode ? 'none' : '';
    if(crest2) crest2.textContent = cpuMode ? 'CPU' : 'ROJ';
    if(name2)  name2.textContent  = cpuMode ? ('Máquina · ' + CPU_LEVELS[cpuLevel].name) : 'Jugador 2';
    // the HUD said "Máquina" but every message still said "equipo Rojo"
    team2.name = cpuMode ? 'Máquina' : 'Rojo';
    team2.cpu = cpuMode ? makeCpuState() : null;
    updatePadChips();
    saveSettings();
  }

  // Segments: mark the picked button for the eyes, for assistive tech and for
  // the pad cursor — a mouse click used to leave the arrow cursor wherever it
  // was, so the next arrow press jumped somewhere arbitrary.
  function pickSeg(seg, btn){
    seg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    uiSyncTo(btn);
  }

  /* ---- settings that survive a reload ----
     View, rival, difficulty, length and mute. A couch game gets replayed a
     lot; reconfiguring four segments every time the tab opens is friction
     nobody asked for. Private windows and file:// may refuse storage, hence
     the try/catch — the game must not care. */
  const SETTINGS_KEY = 'fa27.settings.v1';
  let settingsReady = false;
  function saveSettings(){
    if(!settingsReady) return;
    try{
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(
        { v: view3d, m: cpuMode, l: cpuLevel, d: matchLength, s: soundOn,
          i1: inputMode[0], i2: inputMode[1], sw: swapPads }));
    }catch(e){}
  }
  function loadSettings(){
    let s = null;
    try{ s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); }catch(e){}
    if(s){
      const click = sel => { const b = document.querySelector(sel); if(b && b.click) b.click(); };
      if(s.d)          click('#len-seg [data-len="' + s.d + '"]');
      if(s.m)          click('#mode-seg [data-mode="cpu"]');
      if(s.l != null)  click('#level-seg [data-level="' + s.l + '"]');
      if(s.v && has3d()) click('#view-seg [data-view="3d"]');
      if(s.s === false && soundOn) toggleMute();
      if(s.i1) click('#in1-seg [data-input="' + s.i1 + '"]');
      if(s.i2) click('#in2-seg [data-input="' + s.i2 + '"]');
      if(s.sw) swapPads = true;
    }
    settingsReady = true;
  }

  if(modeSeg){
    modeSeg.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if(!btn) return;
      pickSeg(modeSeg, btn);
      cpuMode = btn.dataset.mode === 'cpu';
      applyMode();
    });
  }

  if(levelSeg){
    levelSeg.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if(!btn) return;
      pickSeg(levelSeg, btn);
      cpuLevel = parseInt(btn.dataset.level, 10);
      applyMode();
    });
  }

  // ---- keyboard or pad, per player ----
  const in1Seg = document.getElementById('in1-seg');
  const in2Seg = document.getElementById('in2-seg');
  const in2Row = document.getElementById('in2-row');
  const swapBtn = document.getElementById('swap-btn');
  [in1Seg, in2Seg].forEach((seg, player) => {
    if(!seg) return;
    seg.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if(!btn) return;
      pickSeg(seg, btn);
      inputMode[player] = btn.dataset.input || 'auto';
      updatePadChips();
      saveSettings();
    });
  });
  if(swapBtn) swapBtn.addEventListener('click', () => {
    swapPads = !swapPads;
    flashStatus(swapPads ? 'Mandos intercambiados' : 'Mandos en orden');
    updatePadChips();
    saveSettings();
  });

  lenSeg.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if(!btn) return;
    pickSeg(lenSeg, btn);
    matchLength = parseInt(btn.dataset.len, 10);
    saveSettings();
  });

  startBtn.addEventListener('click', startMatch);
  function startMatch(){
    ensureAudio();
    if(endPending){ clearTimeout(endTimer); endPending = false; }
    overlay.classList.add('hidden');
    overlay.classList.remove('result');
    finalScoreEl.hidden = true;
    if(settingsBtn) settingsBtn.hidden = true;
    if(pauseMenu) pauseMenu.hidden = true;
    startBtn.textContent = 'Empezar partido';
    resetStats();
    restartTeam = null;
    statusPrio = -1;
    // Enter or Space started the match from the menu, and that same press is
    // still held — without this it reads as "charge a shot" on the first frame.
    for(const k in keys) keys[k] = false;
    running = true;
    paused = false;
    pauseBtn.textContent = '⏸';
    matchTime = matchLength;
    score1 = 0; score2 = 0;
    possession = [0, 0];
    particles.length = 0;
    resetPowerups();
    resetNets();
    replay.count = 0; replay.head = 0; replay.active = false;
    goalAction = 0; pendingGoal = null;
    celebration = null;
    kickoffTimer = 1.2;
    updateScore(null);
    resetPositions();
    poss1El.textContent = 'Posesión 50%';
    poss2El.textContent = 'Posesión 50%';
    timeEl.textContent = formatTime(matchTime);
    statusEl.textContent = '';
    startAmbience();
    startIntro();
    if(!intro.active) sfx.whistle();
  }

  assignHair();
  assignNames();
  applyMode();
  loadSettings();
  uiPaint();
  // installable + playable offline (2D always; 3D once three.js has been cached)
  if(typeof navigator !== 'undefined' && navigator.serviceWorker && typeof location !== 'undefined' &&
     String(location.protocol).startsWith('http')){
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  requestAnimationFrame(gameLoop);
})();
