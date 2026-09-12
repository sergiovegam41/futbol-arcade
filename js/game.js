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
                        'KeyF','KeyR','Slash','Comma'];
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
      radius: role === 'GK' ? 20 : 18,
      speed:  role === 'GK' ? 2.6 : 2.95,
      sprintMult: 1.62,
      kickCooldown: 0,
      lungeTimer: 0,
      runPhase: Math.random() * 6.28,
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
      containing: false,
      powerHeld: false,
      advance: 0,        // smoothed team-wide push forward(+) / drop back(-)
      teamSprint: 0,     // 0..1 — how hard the WHOLE team is running right now
      charge: 0,         // charged-shot meter of the controlled player
      chargeHeld: false,
      passCooldown: 0,
      gk: makePlayer('GK', 0, side, color, 1),
      outfield: SQUAD.map(s => makePlayer(s.role, s.slot, side, color, s.number))
    };
  }

  const team1 = makeTeam('left',  cssVar('--p1'), true,  'Azul');
  const team2 = makeTeam('right', cssVar('--p2'), false, 'Rojo');
  const teams = [team1, team2];

  function allPlayers(){
    return [team1.gk].concat(team1.outfield, [team2.gk], team2.outfield);
  }

  const ball = {
    x: W/2, y: H/2, vx:0, vy:0, radius:11,
    friction:0.986, spin:0, trail:[]
  };

  /* =========================================================
     Particles (grass, sparks, confetti)
     ========================================================= */
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
      }
    }
    ball.x = W/2; ball.y = H/2; ball.vx = 0; ball.vy = 0; ball.spin = 0;
    ball.trail.length = 0;
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
      sprint:  btn(5) || btn(7),            // RB / RT
      switchBtn: btn(4),                    // LB
      rsx, rsy
    };
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

  // Button switch: always works down the squad from the man NEAREST the ball.
  // A fresh press gives you the closest player; keep tapping within
  // SWITCH_CHAIN seconds and you walk outwards from there. That way the nearest
  // player is never more than one press away.
  const SWITCH_CHAIN = 1.0;   // s a run of taps stays linked

  function manualSwitch(team){
    if(!running || paused) return;
    // rank the WHOLE line by distance to the ball and keep the cursor pointing
    // into that fixed ranking — filtering first would make the list shift under
    // the cursor on every press and scramble the order you walk through
    const ranked = team.outfield
      .map((pl, idx) => ({ idx, d: Math.hypot(ball.x - pl.x, ball.y - pl.y) }))
      .sort((a, b) => a.d - b.d);

    // a tap that follows another one continues down the list; otherwise restart
    team.switchCursor = team.chainTimer > 0 ? team.switchCursor + 1 : 0;
    team.chainTimer = SWITCH_CHAIN;

    for(let k = 0; k < ranked.length; k++){
      const at = (team.switchCursor + k) % ranked.length;
      if(ranked[at].idx === team.controlledIndex) continue;   // skip yourself
      team.switchCursor = at;
      setControlled(team, ranked[at].idx, MANUAL_LOCK);
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
        power = false, contain = false;
    if(team.isP1){
      if(keys['KeyA']) dx -= 1;
      if(keys['KeyD']) dx += 1;
      if(keys['KeyW']) dy -= 1;
      if(keys['KeyS']) dy += 1;
      kick    = !!keys['Space'];
      pass    = !!keys['KeyE'];
      power   = !!keys['KeyF'];
      contain = !!keys['KeyR'];
      sprint  = !!keys['ShiftLeft'] || !!keys['ShiftRight'];
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
    }
    return {dx, dy, kick, pass, sprint, power, contain};
  }

  /* =========================================================
     Ball contact helpers
     ========================================================= */
  function ballDist(p){ return Math.hypot(ball.x - p.x, ball.y - p.y); }
  function canTouch(p){ return ballDist(p) < p.radius + ball.radius + 6; }

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

  function shoot(p, power, spread){
    const kdx = p.facing.x || (p.side === 'left' ? 1 : -1);
    const kdy = p.facing.y;
    const klen = Math.hypot(kdx, kdy) || 1;
    const jitter = (Math.random() - 0.5) * (spread || 0);
    const ang = Math.atan2(kdy/klen, kdx/klen) + jitter;
    ball.vx = Math.cos(ang) * power;
    ball.vy = Math.sin(ang) * power;
    ball.spin = (Math.random() - 0.5) * 0.5 + power * 0.03;
    p.kickCooldown = 0.3;
    sfx.kick(Math.min(power / 16, 1));
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
  const CHARGE_TIME = 0.62;
  const MAX_SHOT    = 17.5;
  const MIN_SHOT    = 9.0;
  const POWER_SHOT  = 22.0;   // the B-button hammer

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
  const CONTAIN_REACH = 46;

  function containAndSteal(team, p){
    const bdx = ball.x - p.x, bdy = ball.y - p.y;
    const bd  = Math.hypot(bdx, bdy) || 1;
    p.facing.x = bdx/bd;
    p.facing.y = bdy/bd;

    const owner = ballOwner;
    const theirs = owner && owner.side !== p.side;
    if(bd < p.radius + ball.radius + CONTAIN_REACH && theirs){
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
      return true;
    }
    return false;
  }

  function updateControlledPlayer(team, dt){
    const p = getControlled(team);
    const input = getInputFor(team);

    const len = Math.hypot(input.dx, input.dy);
    let nx = len > 0.05 ? input.dx/len : 0;
    let ny = len > 0.05 ? input.dy/len : 0;

    // sprint: the human's sprint is what drags the whole team along (see updateTeamSprint)
    const sprinting = !!input.sprint && (nx !== 0 || ny !== 0);
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

    const touching = canTouch(p);
    if(touching) registerTouch(team, p);

    // you are carrying the ball if you own it and it is still at your feet
    const carrying = ballOwner === p && ballDist(p) < CARRY_RANGE && p.kickCooldown <= 0;

    // ----- face up and steal (hold) -----
    let stole = false;
    if(containing){
      stole = containAndSteal(team, p);
      team.containing = true;
    } else {
      team.containing = false;
    }

    // ----- hard shot on goal (B) -----
    if(input.power && !team.powerHeld && (carrying || touching) && p.kickCooldown <= 0){
      aimAtGoal(p, team, 0.75);          // this one really wants the goal
      shoot(p, POWER_SHOT, 0.02);
      shake = Math.max(shake, 7);
      team.charge = 0;
      team.chargeHeld = false;
      team.powerHeld = true;
      return;
    }
    team.powerHeld = !!input.power;

    // ----- charged shot (A) -----
    if(input.kick){
      team.charge = Math.min(team.charge + dt / CHARGE_TIME, 1);
      team.chargeHeld = true;
      if(carrying) carryBall(p, false);   // keep it glued while winding up
    } else if(team.chargeHeld){
      const power = MIN_SHOT + (MAX_SHOT - MIN_SHOT) * team.charge;
      if(carrying || (touching && p.kickCooldown <= 0)){
        // the harder you hit it, the more it counts as a shot on goal
        aimAtGoal(p, team, 0.30 + 0.32 * team.charge);
        shoot(p, power, 0.04);
      } else {
        p.lungeTimer = 0.22;   // no ball nearby: burst forward as a tackle/lunge
      }
      team.charge = 0;
      team.chargeHeld = false;
    } else if(carrying && !stole){
      carryBall(p, sprinting);            // close control: the ball stays on your feet
    } else if(touching && p.kickCooldown <= 0 && !stole){
      dribble(p, sprinting ? 0.55 : 0.4);
    }

    // ----- pass -----
    if(input.pass && (carrying || touching) && team.passCooldown <= 0 && p.kickCooldown <= 0){
      passToTeammate(team, p);
    }

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
      if(canTouch(pl)){
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
     Goalkeeper AI: idle -> diving -> recovering
     ========================================================= */
  const GK_IDLE_SPEED      = 3.9;
  const GK_DIVE_SPEED      = 9.0;
  const GK_DIVE_DURATION   = 0.30;
  const GK_RECOVER_DURATION= 1.4;

  function updateGoalkeeper(team, dt){
    const gk = team.gk;
    const topY = topGoalY + gk.radius + 4;
    const botY = botGoalY - gk.radius - 4;

    if(gk.state === undefined){ gk.state = 'idle'; gk.stateTimer = 0; gk.diveTarget = null; }

    const ballSpeed   = Math.hypot(ball.vx, ball.vy);
    const towardOwn   = gk.side === 'left' ? ball.vx < -3 : ball.vx > 3;
    const nearBox     = gk.side === 'left' ? ball.x < FIELD_MARGIN + 300 : ball.x > W - FIELD_MARGIN - 300;

    if(gk.state === 'idle' && ballSpeed > 4.5 && towardOwn && nearBox){
      const distToLine = gk.side === 'left' ? (ball.x - FIELD_MARGIN) : (W - FIELD_MARGIN - ball.x);
      const timeToLine = Math.max(distToLine / Math.max(Math.abs(ball.vx), 0.001), 0);
      let predictedY = ball.y + ball.vy * timeToLine * 0.9;
      predictedY = Math.max(topY - 34, Math.min(botY + 34, predictedY));
      gk.diveTarget = { x: gk.home.x + (gk.side === 'left' ? 24 : -24), y: predictedY };
      gk.state = 'diving';
      gk.stateTimer = 0;
    }

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
    } else {
      let targetY = Math.max(topY, Math.min(botY, ball.y));
      const ownGoalNear = gk.side === 'left' ? (ball.x < halfW * 0.55) : (ball.x > W - halfW * 0.55);
      const targetX = gk.home.x + (ownGoalNear ? (gk.side === 'left' ? 20 : -20) : 0);
      const dx = targetX - gk.x, dy = targetY - gk.y;
      const d = Math.hypot(dx, dy);
      if(d > 2){
        gk.vx = (dx/d) * GK_IDLE_SPEED;
        gk.vy = (dy/d) * GK_IDLE_SPEED;
        gk.facing.x = dx/d; gk.facing.y = dy/d;
      } else { gk.vx = 0; gk.vy = 0; }
    }

    gk.x += gk.vx * dt * 60;
    gk.y += gk.vy * dt * 60;
    clampToPitch(gk);

    if(gk.kickCooldown > 0) gk.kickCooldown -= dt;

    const inBox = gk.side === 'left'
      ? ball.x < FIELD_MARGIN + PENALTY_BOX_DEPTH + 20
      : ball.x > W - FIELD_MARGIN - PENALTY_BOX_DEPTH - 20;

    if(ballDist(gk) < gk.radius + ball.radius + 8){
      registerTouch(team, gk);
      if(inBox && gk.kickCooldown <= 0){
        const dirX = gk.side === 'left' ? 1 : -1;
        const dirY = (Math.random() - 0.5) * 1.2;
        const len  = Math.hypot(dirX, dirY) || 1;
        ball.vx = (dirX/len) * 10.5;
        ball.vy = (dirY/len) * 10.5;
        gk.kickCooldown = 0.6;
        sfx.save();
        spawnParticles(ball.x, ball.y, 12, { speed: 3, life: 0.45, size: 3, color: 'rgba(255,255,255,0.8)' });
        if(gk.state === 'diving'){ gk.state = 'recovering'; gk.stateTimer = 0; }
        flashStatus('¡Atajada del arquero ' + team.name + '!');
      } else {
        const pdx = ball.x - gk.x, pdy = ball.y - gk.y;
        const plen = Math.hypot(pdx, pdy) || 1;
        ball.vx += (pdx/plen) * 0.3;
        ball.vy += (pdy/plen) * 0.3;
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
    ball.x += ball.vx * dt * 60;
    ball.y += ball.vy * dt * 60;
    ball.vx *= ball.friction;
    ball.vy *= ball.friction;

    const speed = Math.hypot(ball.vx, ball.vy);
    ball.spin += speed * 0.035;
    if(speed < 0.03){ ball.vx = 0; ball.vy = 0; }

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
  let fieldCache = null;

  function buildFieldCache(){
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c = off.getContext('2d');

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
      // D arc
      c.beginPath();
      c.arc(spotX, H/2, 72,
            side === 'left' ? -Math.PI/2.6 : Math.PI - Math.PI/2.6,
            side === 'left' ?  Math.PI/2.6 : Math.PI + Math.PI/2.6);
      c.stroke();
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
        const bw = 42, bh = 5;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(-bw/2, p.radius + 12, bw, bh);
        const g = ctx.createLinearGradient(-bw/2, 0, bw/2, 0);
        g.addColorStop(0, '#9fe870'); g.addColorStop(1, '#ff5b3a');
        ctx.fillStyle = g;
        ctx.fillRect(-bw/2, p.radius + 12, bw * team.charge, bh);
      }
    }

    ctx.translate(0, bob);

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
    ctx.globalAlpha = (isGK && p.state === 'recovering') ? 0.6 : 1;
    ctx.beginPath();
    ctx.arc(0, 0, p.radius, 0, Math.PI*2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = isGK ? p.color : 'rgba(0,0,0,0.4)';
    ctx.stroke();
    ctx.globalAlpha = 1;

    // jersey number
    ctx.fillStyle = isGK ? p.color : 'rgba(255,255,255,0.95)';
    ctx.font = 'bold ' + (isGK ? 12 : 13) + 'px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isGK && p.state === 'recovering' ? '···' : String(p.number), 0, 1);

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

    // shadow
    ctx.beginPath();
    ctx.ellipse(ball.x + 2, ball.y + ball.radius*0.85, ball.radius*0.9, ball.radius*0.32, 0, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    ctx.save();
    ctx.translate(ball.x, ball.y);
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
    if(celebration.t > 2.0){ celebration = null; return; }
    const t = celebration.t;
    const pop = t < 0.3 ? t / 0.3 : 1;
    const fade = t > 1.6 ? 1 - (t - 1.6) / 0.4 : 1;
    const scale = 0.6 + pop * 0.4 + Math.sin(t * 7) * 0.02;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(5,12,8,0.45)';
    ctx.fillRect(0, H/2 - 110, W, 220);

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

    ctx.font = '700 30px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(celebration.sub, 0, 78);
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
      text: winner ? 'FINAL' : 'EMPATE',
      sub: winner ? 'Gana el equipo ' + winner.name : score1 + ' - ' + score2,
      color: winner ? winner.color : '#f2c14e',
      t: 0
    };
    setTimeout(showEndOverlay, 2200);
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

    if(!fieldCache) buildFieldCache();
    ctx.drawImage(fieldCache, 0, 0);
    drawGoals();
    drawTeam(team1);
    drawTeam(team2);
    drawBall();
    drawParticles();
    drawKickoffCountdown();
    drawCelebration(paused ? 0 : dt);
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

  requestAnimationFrame(gameLoop);
})();
