(function(){
  "use strict";

  /* =========================================================
     Setup
     ========================================================= */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  // Logical game coordinates stay fixed; the canvas is resized to fit the screen
  const W = 1600, H = 900;
  const wrap = document.getElementById('canvas-wrap');

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
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    scaleX = dpr * (displayW / W);
    scaleY = dpr * (displayH / H);
  }
  let scaleX = 1, scaleY = 1;
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);
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
  const lenSeg      = document.getElementById('len-seg');

  /* =========================================================
     Pitch geometry
     ========================================================= */
  const FIELD_MARGIN      = 46;
  const GOAL_WIDTH        = 220;
  const GOAL_DEPTH        = 32;
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
  let audioCtx = null, soundOn = true;
  function ensureAudio(){
    if(!audioCtx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(AC) audioCtx = new AC();
    }
    if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function blip(freq, dur, type, gain){
    if(!soundOn || !audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(gain || 0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }
  const sfx = {
    kick(power){ blip(180 + power * 220, 0.10, 'square', 0.06); },
    pass(){ blip(420, 0.07, 'triangle', 0.05); },
    wall(){ blip(120, 0.06, 'sine', 0.04); },
    save(){ blip(300, 0.12, 'sawtooth', 0.05); },
    goal(){
      [0, 120, 240, 420].forEach((ms, i) => {
        setTimeout(() => blip([523, 659, 784, 1047][i], 0.28, 'square', 0.07), ms);
      });
    },
    whistle(){
      [0, 150, 300].forEach(ms => setTimeout(() => blip(1400, 0.16, 'sine', 0.05), ms));
    }
  };
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
  });

  /* =========================================================
     Teams — GK + 2 DEF + 2 FWD
     ========================================================= */
  const SQUAD = [
    { role:'DEF', slot:-1, number:4  },
    { role:'DEF', slot: 1, number:5  },
    { role:'FWD', slot:-1, number:9  },
    { role:'FWD', slot: 1, number:11 }
  ];

  // slot: -1 = upper lane, +1 = lower lane
  function formationHome(role, slot, side){
    let x, y;
    const lane = 165;
    switch(role){
      case 'GK':  x = FIELD_MARGIN + 30;                                  y = H/2; break;
      case 'DEF': x = FIELD_MARGIN + (halfW - FIELD_MARGIN) * 0.34;       y = H/2 + slot * lane; break;
      case 'FWD': x = FIELD_MARGIN + (halfW - FIELD_MARGIN) * 0.86;       y = H/2 + slot * (lane + 35); break;
    }
    if(side === 'right') x = W - x;
    return {x, y};
  }

  function makePlayer(role, slot, side, color, number){
    const home = formationHome(role, slot, side);
    return {
      x: home.x, y: home.y, vx:0, vy:0,
      color, side, role, slot, number,
      radius: role === 'GK' ? 16 : 18,
      speed:  role === 'GK' ? 2.6 : 2.95,
      sprintMult: 1.62,
      kickCooldown: 0,
      lungeTimer: 0,
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
  const HAIR_ENABLED = false;

  function assignHair(){   // called once below, after HAIR_STYLES exists
    if(!HAIR_ENABLED) return;   // leaves hairStyle null, so drawPlayer skips it
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

  function allPlayers(){
    return [team1.gk].concat(team1.outfield, [team2.gk], team2.outfield);
  }

  const ball = {
    x: W/2, y: H/2, vx:0, vy:0, radius:11,
    friction:0.986, spin:0, trail:[],
    // a real strike, as opposed to a dribble touch: this is what the keeper reads
    shotTimer:0, shotSide:null, shotId:0, heldBy:null, shotPower:0, shotSweet:false, shotFire:false, shotDist:0,
    releaseGuard:0, releaseSide:null, curve:0,
    z:0, vz:0, loftTeam:null
  };

  /* =========================================================
     Particles (grass, sparks, confetti)
     ========================================================= */
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
            sfx.goal();
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
        pl.slideTimer = 0; pl.downTimer = 0;
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
    lastTouchTeam = towardSide || null;
    ballOwner = null;
  }

  function goalCheck(){
    // left goal — red scores
    if(ball.x - ball.radius < FIELD_MARGIN - GOAL_DEPTH*0.5 && ball.y > topGoalY && ball.y < botGoalY){
      score2++; onGoal(team2); return true;
    }
    // right goal — blue scores
    if(ball.x + ball.radius > W - FIELD_MARGIN + GOAL_DEPTH*0.5 && ball.y > topGoalY && ball.y < botGoalY){
      score1++; onGoal(team1); return true;
    }
    return false;
  }

  function onGoal(team){
    updateScore(team.isP1 ? score1El : score2El);
    flashStatus('¡GOL del equipo ' + team.name + '!');
    celebration = { text:'¡GOOOL!', sub:'Equipo ' + team.name, color:team.color, t:0 };
    shake = 16;
    sfx.goal();
    // confetti burst from the goal mouth
    const gx = team.side === 'left' ? W - FIELD_MARGIN : FIELD_MARGIN;
    for(let i = 0; i < 70; i++){
      spawnParticles(gx, H/2, 1, {
        speed: 9, life: 1.4, size: 6, gravity: 0.09,
        color: ['#f2c14e', '#ffffff', team.color, '#9fd6ac'][i % 4]
      });
    }
    kickoffTimer = 1.8;
    resetPositions();
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
  function flashStatus(msg){
    statusEl.textContent = msg;
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      statusEl.textContent = running ? (paused ? 'Pausa' : '') : '¡A jugar!';
    }, 2000);
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
  function getGamepads(){
    return navigator.getGamepads ? navigator.getGamepads() : [];
  }
  function trimName(name){
    return name.length > 22 ? name.slice(0, 22) + '…' : name;
  }
  function updatePadChips(){
    const pads = getGamepads();
    const connected = [];
    for(const gp of pads){ if(gp) connected.push(gp); }
    if(connected[0]){
      chip1.textContent = 'Mando 1: conectado ✔ (' + trimName(connected[0].id) + ')';
      chip1.classList.add('on');
    } else {
      chip1.textContent = 'Mando 1: no conectado (usa WASD)';
      chip1.classList.remove('on');
    }
    if(connected[1]){
      chip2.textContent = 'Mando 2: conectado ✔ (' + trimName(connected[1].id) + ')';
      chip2.classList.add('on');
    } else {
      chip2.textContent = 'Mando 2: no conectado (usa flechas)';
      chip2.classList.remove('on');
    }
  }
  setInterval(updatePadChips, 1000);
  window.addEventListener('gamepadconnected', updatePadChips);
  window.addEventListener('gamepaddisconnected', updatePadChips);

  function readPadInput(index){
    const gp = getGamepads()[index];
    if(!gp) return null;
    let dx = 0, dy = 0;
    if(gp.axes.length >= 2){
      dx = Math.abs(gp.axes[0]) > 0.18 ? gp.axes[0] : 0;
      dy = Math.abs(gp.axes[1]) > 0.18 ? gp.axes[1] : 0;
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

  function rumble(padIndex, strong, weak, duration){
    if(!rumbleOn) return false;
    const gp = getGamepads()[padIndex];
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
    const ownHalf = team.side === 'left' ? ball.x < halfW : ball.x > halfW;
    return ownHalf ? 'DEF' : 'FWD';
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
  function getInputFor(team){
    const pad = readPadInput(team.isP1 ? 0 : 1);
    if(pad) return pad;
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
    return {dx, dy, kick, pass, sprint, power, contain, modifier};
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
  function registerTouch(team, player){
    lastTouchTeam = team;
    if(!player || ballOwner === player) return;   // same carrier: nothing changed hands
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
    // flag it as a genuine shot so goalkeepers only commit to real strikes
    ball.curve     = 0;
    ball.shotTimer = 1.3;
    ball.shotSide  = p.side;
    ball.shotPower = pw;
    ball.shotSweet = false;
    ball.shotFire  = fire;
    // how far out it was struck from: a keeper has time to set himself for a
    // long shot, so distance is part of whether it beats him
    const tgoal = opponentGoal(tm);
    ball.shotDist = Math.hypot(tgoal.x - p.x, tgoal.y - p.y);
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

  function passToTeammate(team, p){
    let best = null, bestScore = -Infinity;
    const fx = p.facing.x, fy = p.facing.y;
    const flen = Math.hypot(fx, fy) || 1;
    for(const mate of team.outfield){
      if(mate === p) continue;
      const vx = mate.x - p.x, vy = mate.y - p.y;
      const d = Math.hypot(vx, vy) || 1;
      const align = ((vx/d) * (fx/flen) + (vy/d) * (fy/flen));
      const score = align * 1.6 - d / 900;   // prefer mates ahead of the heading
      if(score > bestScore){ bestScore = score; best = mate; }
    }
    if(!best) return;
    const vx = best.x - p.x, vy = best.y - p.y;
    const d = Math.hypot(vx, vy) || 1;
    const power = Math.min(5.5 + d / 90, 13);
    ball.vx = (vx/d) * power;
    ball.vy = (vy/d) * power;
    ball.spin = 0.3;
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
    const frames = Math.max(12, gl / sp);
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
       ball.z <= REACH_JUMP){
      // knock it loose, away from the man who had it
      const power = 5.5;
      ball.vx = (bdx/bd) * power;
      ball.vy = (bdy/bd) * power;
      registerTouch(team, p);          // the steal makes you the owner -> you get control
      p.kickCooldown = 0.18;
      sfx.save();
      spawnParticles(ball.x, ball.y, 12, {
        speed: 3.2, life: 0.4, size: 3, color: 'rgba(255,235,170,0.9)'
      });
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
    sfx.wall();
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
    const input = getInputFor(team);

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

    // sprint: the human's sprint is what drags the whole team along (see updateTeamSprint)
    const sprinting = !!input.sprint && (nx !== 0 || ny !== 0);
    // RT runs, RB modifies. They are separate buttons, so holding the modifier
    // is unambiguous — running never turns a shot into a lofted ball.
    const modHeld = !!input.modifier;
    const containing = !!input.contain;
    const spd = p.speed * 1.1
              * (sprinting ? p.sprintMult : 1)
              * (p.lungeTimer > 0 ? 1.5 : 1)
              * (containing ? 1.12 : 1);       // close down a touch quicker
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
    if(team.passCooldown > 0) team.passCooldown -= dt;

    // pressing the shoot button is also how you go up for a high ball
    const touching = canTouch(p, !!input.kick || !!input.power) && !ballLocked(p);
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
      team.charge = Math.min(team.charge + dt / POWER_TIME, 1);
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
        ball.shotSweet = sweet;
        // B + a tap of RB curls it around the keeper
        if(team.modArmed || modHeld){
          applyCurl(team, p, c);
          flashStatus('¡Tiro con rosca!');
        }
        shotRumble(team, p, power);
        shotShake(team, p, power);
        if(sweet) flashStatus('¡Golpeo perfecto!');
      } else {
        p.lungeTimer = 0.22;
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
        p.lungeTimer = 0.22;   // no ball nearby: burst forward as a tackle/lunge
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
        passToTeammate(team, p);
      } else if(p.slideTimer <= 0 && p.downTimer <= 0){
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

  function clampToPitch(p){
    p.x = Math.max(FIELD_MARGIN + p.radius, Math.min(W - FIELD_MARGIN - p.radius, p.x));
    p.y = Math.max(FIELD_MARGIN + p.radius, Math.min(H - FIELD_MARGIN - p.radius, p.y));
  }

  /* =========================================================
     Team shape + "everybody runs when you run"
     ========================================================= */
  const AI_PULL       = { DEF:{x:0.20, y:0.34}, FWD:{x:0.40, y:0.46} };
  const ROLE_ADVANCE  = { DEF:0.62, FWD:1.25 };
  const MAX_ADVANCE   = 150;
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

      // AI ball interaction: shoot near goal, otherwise drive the ball forward
      if(canTouch(pl, true) && !ballLocked(pl)){
        registerTouch(team, pl);   // a change of owner hands you the controls
        const goal = opponentGoal(team);
        const distToGoal = Math.hypot(goal.x - pl.x, goal.y - pl.y);
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
        if(wasShot) flashStatus('¡Atajada del arquero ' + team.name + '!');
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

  function updateBall(dt){
    if(ball.shotTimer > 0) ball.shotTimer -= dt;
    if(ball.releaseGuard > 0) ball.releaseGuard -= dt;
    if(ball.heldBy){ ball.trail.length = 0; ball.z = 0; ball.vz = 0; return; }

    // vertical flight
    if(ball.z > 0 || ball.vz !== 0){
      ball.z  += ball.vz * dt * 60;
      ball.vz -= GRAVITY * dt * 60;
      if(ball.z <= 0){
        ball.z = 0;
        if(ball.vz < -1.1){
          ball.vz = -ball.vz * 0.28;   // one soft hop, then it settles
          ballLanded();
        } else {
          ball.vz = 0;
          if(ball.loftTeam) ballLanded();
        }
      }
    }
    ball.x += ball.vx * dt * 60;
    ball.y += ball.vy * dt * 60;
    const air = ball.z > 4;
    ball.vx *= air ? 0.997 : ball.friction;
    ball.vy *= air ? 0.997 : ball.friction;

    let speed = Math.hypot(ball.vx, ball.vy);
    // bend: a sideways push perpendicular to travel, fading as the ball slows
    if(ball.curve !== 0 && speed > 1.2){
      const nx = ball.vx / speed, ny = ball.vy / speed;
      ball.vx += -ny * ball.curve * dt * 60;
      ball.vy +=  nx * ball.curve * dt * 60;
      ball.curve *= 0.995;   // holds almost all the way, so the arc closes
      if(Math.abs(ball.curve) < 0.002) ball.curve = 0;
      speed = Math.hypot(ball.vx, ball.vy);
    }
    ball.spin += speed * 0.035;
    if(speed < 0.03){ ball.vx = 0; ball.vy = 0; }

    if(ball.shotFire && ball.shotTimer > 0 && speed > 2){
      spawnParticles(ball.x, ball.y, 2, {
        speed: 1.3, life: 0.42, size: 5,
        color: Math.random() < 0.5 ? 'rgba(255,170,50,0.95)' : 'rgba(255,70,20,0.9)'
      });
    }
    // trail for fast shots
    if(speed > 6){
      ball.trail.push({ x: ball.x, y: ball.y, life: 0.25 });
      if(ball.trail.length > 14) ball.trail.shift();
    }
    for(let i = ball.trail.length - 1; i >= 0; i--){
      ball.trail[i].life -= dt;
      if(ball.trail[i].life <= 0) ball.trail.splice(i, 1);
    }

    const bounced = () => {
      if(speed > 4){
        sfx.wall();
        spawnParticles(ball.x, ball.y, 5, { speed: 2, life: 0.3, size: 3, color: 'rgba(255,255,255,0.6)' });
      }
    };

    if(ball.y - ball.radius < FIELD_MARGIN){
      ball.y = FIELD_MARGIN + ball.radius; ball.vy *= -0.62; bounced();
    }
    if(ball.y + ball.radius > H - FIELD_MARGIN){
      ball.y = H - FIELD_MARGIN - ball.radius; ball.vy *= -0.62; bounced();
    }
    const inMouth = ball.y > topGoalY && ball.y < botGoalY;
    if(ball.x - ball.radius < FIELD_MARGIN && !inMouth){
      ball.x = FIELD_MARGIN + ball.radius; ball.vx *= -0.62; bounced();
    }
    if(ball.x + ball.radius > W - FIELD_MARGIN && !inMouth){
      ball.x = W - FIELD_MARGIN - ball.radius; ball.vx *= -0.62; bounced();
    }
    // inside the goal mouth, keep it from leaving the world before goalCheck fires
    ball.x = Math.max(FIELD_MARGIN - GOAL_DEPTH, Math.min(W - FIELD_MARGIN + GOAL_DEPTH, ball.x));
  }

  /* =========================================================
     Drawing — pitch
     ========================================================= */
  let fieldCache = null, fieldCacheKey = '';

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

    // mowed stripes
    const stripes = 14;
    const stripeW = (W - FIELD_MARGIN*2) / stripes;
    for(let i = 0; i < stripes; i++){
      c.fillStyle = i % 2 === 0 ? '#2f7343' : '#37854e';
      c.fillRect(FIELD_MARGIN + i*stripeW, FIELD_MARGIN, stripeW + 0.5, H - FIELD_MARGIN*2);
    }

    // soft lighting across the pitch
    const light = c.createRadialGradient(W/2, H/2, 120, W/2, H/2, W*0.72);
    light.addColorStop(0, 'rgba(255,255,255,0.10)');
    light.addColorStop(1, 'rgba(0,0,0,0.30)');
    c.fillStyle = light;
    c.fillRect(FIELD_MARGIN, FIELD_MARGIN, W - FIELD_MARGIN*2, H - FIELD_MARGIN*2);

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
    fieldCacheKey = off.width + 'x' + off.height;
  }

  function drawGoals(){
    [['left', FIELD_MARGIN], ['right', W - FIELD_MARGIN]].forEach(function(pair){
      const side = pair[0], gx = pair[1];
      const x0 = side === 'left' ? gx - GOAL_DEPTH : gx;

      // net backdrop
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x0, topGoalY, GOAL_DEPTH, GOAL_WIDTH);

      // net mesh
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, topGoalY, GOAL_DEPTH, GOAL_WIDTH);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      for(let x = x0; x <= x0 + GOAL_DEPTH; x += 8){
        ctx.beginPath(); ctx.moveTo(x, topGoalY); ctx.lineTo(x, topGoalY + GOAL_WIDTH); ctx.stroke();
      }
      for(let y = topGoalY; y <= topGoalY + GOAL_WIDTH; y += 8){
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + GOAL_DEPTH, y); ctx.stroke();
      }
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

    // hair, clipped to the head and turned to face the heading
    if(p.hairStyle){
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
     Loop
     ========================================================= */
  function formatTime(t){
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function endMatch(){
    running = false;
    sfx.whistle();
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
    setTimeout(showEndOverlay, 5200);
  }

  function showEndOverlay(){
    finalScoreEl.style.display = 'block';
    finalScoreEl.textContent = 'AZUL ' + score1 + '  —  ' + score2 + ' ROJO';
    startBtn.textContent = 'Jugar otra vez';
    overlay.classList.remove('hidden');
  }

  function togglePause(){
    if(!running) return;
    paused = !paused;
    pauseBtn.textContent = paused ? '▶' : '⏸';
    statusEl.textContent = paused ? 'Pausa' : '';
  }
  pauseBtn.addEventListener('click', togglePause);

  function step(dt){
    matchTime -= dt;
    if(matchTime <= 0){ matchTime = 0; endMatch(); }
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
    goalCheck();

    // control always sits with whoever has the ball
    enforcePossessionControl(team1);
    enforcePossessionControl(team2);

    if(lastTouchTeam === team1) possession[0] += dt;
    else if(lastTouchTeam === team2) possession[1] += dt;
  }

  let hudTimer = 0;
  function gameLoop(ts){
    if(!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    if(running && !paused){
      step(dt);
      hudTimer += dt;
      if(hudTimer > 0.5){ hudTimer = 0; updatePossessionHud(); }
    }
    updateParticles(dt);

    // ---- render ----
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    if(shake > 0){
      shake *= 0.9;
      if(shake < 0.4) shake = 0;
      ctx.translate((Math.random()-0.5) * shake, (Math.random()-0.5) * shake);
    }

    if(!fieldCache || fieldCacheKey !== canvas.width + 'x' + canvas.height) buildFieldCache();
    ctx.drawImage(fieldCache, 0, 0, W, H);
    drawGoals();
    drawTeam(team1);
    drawTeam(team2);
    drawBall();
    drawPowerups();
    drawKickoffCountdown();
    drawCelebration(paused ? 0 : dt);
    drawParticles();   // above the celebration panel, so confetti reads on top
    if(paused) drawPauseVeil();

    requestAnimationFrame(gameLoop);
  }

  /* =========================================================
     Start / options
     ========================================================= */
  lenSeg.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if(!btn) return;
    lenSeg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    matchLength = parseInt(btn.dataset.len, 10);
  });

  startBtn.addEventListener('click', () => {
    ensureAudio();
    overlay.classList.add('hidden');
    finalScoreEl.style.display = 'none';
    running = true;
    paused = false;
    pauseBtn.textContent = '⏸';
    matchTime = matchLength;
    score1 = 0; score2 = 0;
    possession = [0, 0];
    particles.length = 0;
    resetPowerups();
    celebration = null;
    kickoffTimer = 1.2;
    updateScore(null);
    resetPositions();
    poss1El.textContent = 'Posesión 50%';
    poss2El.textContent = 'Posesión 50%';
    timeEl.textContent = formatTime(matchTime);
    statusEl.textContent = '';
    sfx.whistle();
  });

  assignHair();
  requestAnimationFrame(gameLoop);
})();
