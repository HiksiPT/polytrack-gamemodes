// Cup Gamemodes for PolyTrack 0.6.3 (PolyModLoader). Needs the Car Collisions mod.
//
// Two ways to play a multiplayer session, chosen by the host in the settings:
//   Last man standing: finishing, falling off the track or respawning puts you out;
//     whoever lasts longest wins.
//   King of the hill: a race to the finish in which every player is put on a random
//     one of the track's start blocks.
// The host's game keeps the round and tells the others. Inside a PolyCup round the result is
// passed to PolyCup as finish times, so that its own scoring ranks the round (see Logic.cupFrames).

const { PolyMod, MixinType } = await import(new URL("PolyTypes.js", document.baseURI).href);

const WORKER_MIXINS = [
  {
    type: MixinType.INSERT,
    token: "const r = i.data;",
    func: `if (r && r.messageType === "ptgSpawn") { self.__ptgSpawn = r.spawn; return; }`,
  },
  {
    // the start the player's own car is created at (replay ghosts keep the track's own)
    type: MixinType.REPLACEBETWEEN,
    tokenStart: "const o = i.getStartTransform();",
    tokenEnd: "const o = i.getStartTransform();",
    func: "const o = (null == a && self.__ptgSpawn) || i.getStartTransform();",
  },
];

// Next to the game's channels (0, 1), PolyCup's (42, 43) and Car Collisions' (77).
const CHANNEL = { negotiated: true, id: 78, ordered: true };
const TURTLE_SECONDS = 5;
const FALL_MARGIN = 2; // metres below the lowest track piece
const RESET_COUNTS_AFTER = 3000; // ms driven before a reset counts as giving up

class CupGamemodes extends PolyMod {
  // Everyone in the session needs this mod: Car Collisions refuses joins when the
  // physics-changing mods of the two sides differ.
  touchingPhysics = true;

  #pml;
  #native = null;
  #game = null;
  #failed = false;
  #channels = new Map(); // RTCPeerConnection -> { id, channel }
  #isHost = false;
  #selfId = null;

  // what the host decided, as last heard (the host's own copy when we host)
  #state = { mode: "off", turtle: false, seq: 0, out: {}, result: null, spawns: {} };
  #round = Logic.newRound(); // host only
  #sentText = "";
  #sentAt = 0;
  #rolledFor = "";
  #finished = new Set();

  // this player's car
  #car = null;
  #carFrames = 0;
  #carStarted = false;
  #reported = -1; // round in which our elimination was reported
  #reason = "";
  #cupDone = -1; // round whose result was handed to PolyCup
  #cupCallbacks = new WeakMap(); // car -> finish callbacks of other mods
  #registered = new WeakMap(); // car -> number of finish callbacks so far
  #turtle = 0;
  #lastTick = 0;

  // this track
  #track = null;
  #starts = []; // every start block, in the order they were placed
  #fallY = null;

  #hud = null;
  #hudText = "";

  constructor() {
    super();
    this.init = (pml) => this.#init(pml);
  }

  get mode() {
    return this.#state.mode;
  }

  async #init(pml) {
    this.#pml = pml;
    if (pml.polyVersion !== "0.6.3") throw new Error("Cup Gamemodes requires PolyTrack 0.6.3.");
    const source = await fetch(new URL("simulation_worker.bundle.js", document.baseURI)).then((r) => r.text());
    for (const mixin of WORKER_MIXINS) {
      const token = mixin.token ?? mixin.tokenStart;
      if (source.split(token).length !== 2) throw new Error(`Unsupported game build: "${token}" not found once in the simulation worker.`);
    }
    for (const mixin of WORKER_MIXINS) pml.registerSimWorkerMixin(mixin);

    pml.registerSettingCategory("Cup Gamemodes");
    pml.registerSetting("Gamemode (set by the host)", "PtgMode", "custom", "off", [
      { title: "Off", value: "off" },
      { title: "Last man standing", value: "lms" },
      { title: "King of the hill", value: "koth" },
    ]);
    pml.registerSetting("Last man standing: anti-turtle", "PtgTurtle", "boolean", false);

    // Za: game -> session, as: game -> other cars, Xa: game -> own car, os: game -> own reset
    // counter, ra: game -> track (start, checkpoints), Ta: game -> track data, ua: game -> settings.
    this.#native = pml.getFromPolyTrack(`({
      watchGames: callback => callback(Za),
      session: game => Za.get(game),
      remotes: game => as.get(game),
      car: game => Xa.get(game),
      life: game => os.get(game),
      track: game => ra.get(game),
      trackData: game => Ta.get(game),
      isHost: connection => connection instanceof ii,
      peers: connection => connection instanceof ii
        ? _n.get(connection).map(peer => ({ id: peer.id, pc: peer.peerConnection }))
        : (Vl.get(connection) ? [{ id: null, pc: Vl.get(connection) }] : []),
      isRespawnKey: (game, event) => ua.get(game).checkKeyBinding(event, ge.A.VehicleCheckpointReset)
    })`);
    this.#native.watchGames((sessions) => {
      const set = sessions.set, mod = this;
      sessions.set = function (game, session) {
        mod.#game = game;
        const result = set.call(this, game, session);
        try { mod.#adoptGame(); } catch {}
        return result;
      };
    });

    // In last man standing a respawn would be a way back onto the arena.
    window.addEventListener("keydown", (event) => {
      try {
        if (this.#state.mode !== "lms" || !this.#playing() || !this.#carStarted) return;
        if (!this.#native.isRespawnKey(this.#game, event)) return;
        event.stopImmediatePropagation();
        event.preventDefault();
      } catch {}
    }, true);

    const tick = (now) => {
      requestAnimationFrame(tick);
      if (this.#failed) return;
      try {
        this.#update(now);
      } catch (error) {
        this.#failed = true;
        console.error("[Cup Gamemodes] stopped:", error);
      }
    };
    requestAnimationFrame(tick);
    console.log(`[Cup Gamemodes] ${this.modID}:${this.modVersion} ready`);
  }

  #playing() {
    return !!this.#game && !!this.#native.session(this.#game);
  }

  #setting(id, fallback) {
    try {
      const value = this.#pml.getSetting(id);
      return value === undefined || value === null ? fallback : String(value);
    } catch {
      return fallback;
    }
  }

  // ---- the track: every start block, and how low the track goes -----------
  #adoptGame() {
    const game = this.#game, native = this.#native;
    const track = native.track(game), data = native.trackData(game);
    if (!track || !data || track === this.#track) return;
    this.#track = track;
    this.#starts = [];
    this.#fallY = null;

    const TrackData = data.constructor;
    const lone = (x, y, z, type, rotation, axis, color, checkpoint) => {
      const one = new TrackData(data.environment, data.sunDirection);
      one.addPart(x, y, z, type, rotation, axis, color, checkpoint, 0);
      return one.getStartTransform();
    };
    const found = [];
    let lowest = Infinity, size = null;
    data.forEachPart((x, y, z, type, rotation, axis, color, checkpoint, order) => {
      if (y < lowest) lowest = y;
      if (order === null || order === undefined) return;
      const transform = lone(x, y, z, type, rotation, axis, color, checkpoint);
      if (!transform) return;
      if (size === null) size = lone(x, y + 1, z, type, rotation, axis, color, checkpoint).position.y - transform.position.y;
      found.push({ order, transform });
    });
    this.#starts = found.sort((a, b) => a.order - b.order).map((entry) => entry.transform);
    if (size !== null && Number.isFinite(lowest) && lowest * size - FALL_MARGIN > 0.5) this.#fallY = lowest * size - FALL_MARGIN;

    // The game asks the track for its start whenever a car is (re)created.
    const original = track.getStartTransform, mod = this;
    track.getStartTransform = function () {
      // The simulation is reached through Car Collisions; without it the car stays on the track's start.
      const spawn = mod.#collisions() ? mod.#spawnFor(mod.#selfId) : null;
      mod.#collisions()?.postToSim({
        messageType: "ptgSpawn",
        spawn: spawn && {
          position: { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
          quaternion: { x: spawn.quaternion.x, y: spawn.quaternion.y, z: spawn.quaternion.z, w: spawn.quaternion.w },
        },
      });
      return spawn ? { position: spawn.position.clone(), quaternion: spawn.quaternion.clone() } : original.call(this);
    };
  }

  #spawnFor(id) {
    if (this.#state.mode !== "koth" || id === null || this.#starts.length < 2 || !this.#playing()) return null;
    const index = this.#state.spawns[id];
    return index === undefined ? null : this.#starts[index % this.#starts.length];
  }

  #collisions() {
    return globalThis.__ptCollisions;
  }

  // ---- talking to the other players ---------------------------------------
  #syncChannels(connection) {
    const peers = connection ? this.#native.peers(connection) : [];
    for (const [pc, entry] of this.#channels) {
      if (!peers.some((peer) => peer.pc === pc)) {
        try { entry.channel.close(); } catch {}
        this.#channels.delete(pc);
      }
    }
    for (const { id, pc } of peers) {
      if (this.#channels.has(pc) || pc.connectionState === "closed") continue;
      const entry = { id, channel: null };
      this.#channels.set(pc, entry);
      try {
        entry.channel = pc.createDataChannel("ptgamemodes", CHANNEL);
        entry.channel.onmessage = (event) => this.#receive(entry, event.data);
        entry.channel.onopen = () => { this.#sentText = ""; }; // newcomers get the state at once
      } catch (error) {
        console.error("[Cup Gamemodes] no channel:", error);
      }
    }
  }

  #send(message) {
    const text = JSON.stringify(message);
    for (const entry of this.#channels.values()) {
      if (entry.channel?.readyState !== "open") continue;
      try { entry.channel.send(text); } catch {}
    }
  }

  // Everything in here was written by another player's game.
  #receive(entry, text) {
    let message;
    if (typeof text !== "string" || text.length > 8000) return;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (this.#isHost) {
      if (entry.id !== null && this.#state.mode === "lms" && Logic.lmsOut(this.#round, entry.id, message.out)) this.#sentText = "";
    } else if (entry.id === null && Logic.validState(message)) {
      this.#state = message;
    }
  }

  // ---- the host's bookkeeping ---------------------------------------------
  #players(connection) {
    const native = this.#native, game = this.#game, list = [];
    const remotes = native.remotes(game) ?? new Map();
    for (const player of connection.getPlayers()) {
      if (player.isSelf) {
        list.push({ id: player.id, started: this.#carStarted, frames: this.#carFrames, life: native.life(game) ?? 0, finished: !!this.#car?.hasFinished() });
      } else {
        const remote = remotes.get(player.id), state = remote?.car.getCarState();
        list.push({ id: player.id, started: !!state?.hasStarted, frames: state?.frames ?? 0, life: remote?.resetCounter ?? 0, finished: state?.finishFrames != null });
      }
    }
    return list;
  }

  #host(connection, now) {
    const mode = Logic.MODES.includes(this.#setting("PtgMode", "off")) ? this.#setting("PtgMode", "off") : "off";
    const players = this.#players(connection), round = this.#round;
    if (mode !== this.#state.mode) {
      round.seq++;
      round.out = {};
      round.result = null;
      this.#rolledFor = "";
    }
    if (mode === "lms") Logic.lmsStep(round, players);

    let spawns = this.#state.spawns;
    if (mode === "koth") {
      // New starts when the players or the track change, and after each race (first finish).
      const finishedNow = players.filter((p) => p.finished).map((p) => p.id);
      const raceOver = finishedNow.some((id) => !this.#finished.has(id));
      this.#finished = new Set(finishedNow);
      const key = players.map((p) => p.id).sort((a, b) => a - b).join() + "/" + this.#starts.length;
      if (raceOver || key !== this.#rolledFor) {
        this.#rolledFor = key;
        spawns = Logic.rollSpawns(players.map((p) => p.id), this.#starts.length);
      }
    } else spawns = {};

    this.#state = {
      mode,
      turtle: this.#setting("PtgTurtle", "false") === "true",
      seq: round.seq,
      out: { ...round.out },
      result: round.result && { order: round.result.order, elapsed: round.result.elapsed },
      spawns,
    };
    const text = JSON.stringify(this.#state);
    if (text !== this.#sentText || now - this.#sentAt > 1000) {
      this.#sentText = text;
      this.#sentAt = now;
      this.#send(this.#state);
    }
  }

  // ---- this player's car --------------------------------------------------
  #eliminate(frames, reason) {
    const state = this.#state;
    if (this.#reported === state.seq || state.result || this.#selfId in state.out) return;
    this.#reported = state.seq;
    this.#reason = reason;
    frames = Math.max(0, Math.round(frames));
    if (this.#isHost) Logic.lmsOut(this.#round, this.#selfId, frames);
    else this.#send({ out: frames });
  }

  // Other mods' finish callbacks (PolyCup's among them) are held back in last man standing:
  // crossing the line there is a loss, and the round's result is reported when it is known.
  #watchFinishes(car) {
    const proto = Object.getPrototypeOf(car);
    if (Object.hasOwn(proto, "__ptgPatched")) return;
    const add = proto.addFinishCallback, mod = this;
    Object.defineProperty(proto, "__ptgPatched", { value: true });
    proto.addFinishCallback = function (callback) {
      const count = mod.#registered.get(this) ?? 0;
      mod.#registered.set(this, count + 1);
      if (count === 0) return add.call(this, callback); // the game's own, added as the car is made
      if (!mod.#cupCallbacks.has(this)) mod.#cupCallbacks.set(this, []);
      mod.#cupCallbacks.get(this).push(callback);
      return add.call(this, function (...args) {
        if (mod.#state.mode === "lms" && mod.#playing()) return;
        return callback.apply(this, args);
      });
    };
  }

  #reportToCup() {
    const result = this.#state.result, car = this.#car;
    if (!result || !car || this.#cupDone === this.#state.seq) return;
    this.#cupDone = this.#state.seq;
    const frames = Logic.cupFrames(result, this.#selfId), callbacks = this.#cupCallbacks.get(car) ?? [];
    if (frames === null || !callbacks.length) return;
    const real = car.getTime(), own = Object.getOwnPropertyDescriptor(car, "getTime");
    car.getTime = () => Object.create(real, { numberOfFrames: { value: frames } });
    try {
      for (const callback of callbacks) {
        try { callback(car); } catch (error) { console.error("[Cup Gamemodes]", error); }
      }
    } finally {
      if (own) Object.defineProperty(car, "getTime", own);
      else delete car.getTime;
    }
  }

  #drive(dt) {
    const native = this.#native, game = this.#game, state = this.#state;
    const car = native.car(game);
    if (!car) return;
    this.#watchFinishes(car);
    if (car !== this.#car) {
      // a new car: the old one was reset
      if (this.#car && state.mode === "lms" && this.#carStarted && this.#carFrames > RESET_COUNTS_AFTER) this.#eliminate(this.#carFrames, "reset");
      this.#car = car;
      this.#turtle = 0;
    }
    this.#carStarted = car.hasStarted();
    this.#carFrames = car.getTime().numberOfFrames;
    if (state.mode !== "lms" || !this.#carStarted) { this.#turtle = 0; return; }

    const out = this.#selfId in state.out || this.#reported === state.seq;
    if (!out && !state.result) {
      const position = car.getPosition();
      if (car.hasFinished()) this.#eliminate(car.getFinishTime()?.numberOfFrames ?? this.#carFrames, "finished");
      else if (this.#fallY !== null && position.y < this.#fallY) this.#eliminate(this.#carFrames, "fell");
    }

    // anti-turtle: on its roof or side and going nowhere
    if (!state.turtle || out || state.result || car.hasFinished()) { this.#turtle = 0; return; }
    const q = car.getQuaternion();
    const upright = 1 - 2 * (q.x * q.x + q.z * q.z);
    this.#turtle = upright < 0.25 && Math.abs(car.getSpeedKmh()) < 15 ? this.#turtle + dt : 0;
    if (this.#turtle >= TURTLE_SECONDS) {
      this.#turtle = 0;
      // up, with a roll about the car's length
      const fx = 2 * (q.x * q.z + q.w * q.y), fy = 2 * (q.y * q.z - q.w * q.x), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      this.#collisions()?.impulse([0, 9, 0], [fx * 5, fy * 5, fz * 5]);
    }
  }

  // Eliminated cars are not solid and are drawn faded; waiting cars stand on their own start.
  #showOthers() {
    const state = this.#state, collisions = this.#collisions(), remotes = this.#native.remotes(this.#game);
    const lms = state.mode === "lms";
    if (collisions) {
      collisions.ghostAll = lms && (this.#selfId in state.out || this.#reported === state.seq);
      collisions.ghostIds = new Set(lms ? Object.keys(state.out).map(Number) : []);
    }
    if (!remotes) return;
    for (const [id, remote] of remotes) {
      const faded = lms && id in state.out;
      if (remote.ptgFaded !== faded) {
        remote.ptgFaded = faded;
        try { remote.car.setOpacity(faded ? 0.3 : 1); } catch {}
      }
      const spawn = this.#spawnFor(id), car = remote.car.getCarState();
      if (!spawn || car.hasStarted) continue;
      const p = spawn.position, q = spawn.quaternion;
      if (Math.abs(car.position.x - p.x) + Math.abs(car.position.y - p.y) + Math.abs(car.position.z - p.z) < 0.01) continue;
      remote.car.setCarState({ ...car, position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } }, true);
    }
  }

  // ---- what the player sees -----------------------------------------------
  #draw(names) {
    const state = this.#state, lines = [];
    if (this.#playing() && state.mode === "lms") {
      const out = Object.keys(state.out).length;
      lines.push(`LAST MAN STANDING${state.turtle ? " · anti-turtle" : ""}`);
      if (state.result) {
        lines.push("Round over");
        state.result.order.forEach((entry, i) =>
          lines.push(`${i + 1}. ${names.get(entry.id) ?? "Player " + entry.id}  ${entry.survived ? "survived" : Logic.time(entry.t)}`));
      } else if (this.#selfId in state.out || this.#reported === state.seq) {
        const why = { finished: "crossed the finish", fell: "fell off", reset: "reset" }[this.#reason] ?? "out";
        lines.push(`You are out (${why})${this.#selfId in state.out ? " after " + Logic.time(state.out[this.#selfId]) : ""}`);
      } else if (out) lines.push(`${out} out`);
    } else if (this.#playing() && state.mode === "koth") {
      lines.push("KING OF THE HILL");
      const spawn = this.#spawnFor(this.#selfId), at = this.#car && !this.#carStarted ? this.#car.getPosition() : null;
      if (this.#starts.length < 2) lines.push("This track has one start: add more start blocks");
      else if (spawn && at && Math.abs(at.x - spawn.position.x) + Math.abs(at.y - spawn.position.y) + Math.abs(at.z - spawn.position.z) > 0.5)
        lines.push("Restart to move to your start");
    }
    const text = lines.join("\n");
    if (text === this.#hudText) return;
    this.#hudText = text;
    if (!this.#hud) {
      this.#hud = document.createElement("div");
      this.#hud.style.cssText = "position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:900;pointer-events:none;" +
        "white-space:pre;text-align:center;color:#fff;font:italic 20px ForcedSquare,Arial,sans-serif;line-height:1.25;" +
        "padding:6px 14px;background:rgba(25,32,66,.7);";
      document.body.appendChild(this.#hud);
    }
    this.#hud.textContent = text;
    this.#hud.style.display = text ? "block" : "none";
  }

  #update(now) {
    const dt = Math.min(0.25, Math.max(0, (now - this.#lastTick) / 1000));
    this.#lastTick = now;
    const native = this.#native, game = this.#game;
    const session = game ? native.session(game) : null, connection = session?.multiplayerConnection ?? null;
    this.#syncChannels(connection);
    if (!connection) {
      this.#state = { mode: "off", turtle: false, seq: 0, out: {}, result: null, spawns: {} };
      this.#draw(new Map());
      return;
    }
    this.#adoptGame();
    const players = connection.getPlayers();
    this.#isHost = native.isHost(connection);
    this.#selfId = players.find((player) => player.isSelf)?.id ?? null;
    if (this.#selfId === null) return;

    this.#drive(dt);
    if (this.#isHost) this.#host(connection, now);
    if (this.#state.mode === "lms") this.#reportToCup();
    this.#showOthers();
    this.#draw(new Map(players.map((player) => [player.id, player.nickname])));
  }
}

export let polyMod = new CupGamemodes();
