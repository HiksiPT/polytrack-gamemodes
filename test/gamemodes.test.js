// Checks the rules, then the built mod against stand-ins for the loader and the game, then the
// start override inside the game's real simulation worker.
//
//   node test/gamemodes.test.js <folder with the game's simulation_worker.bundle.js> [Kacky Lab sim folder]
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const Logic = require("../src/logic.js");

const GAME = process.argv[2];
const LAB = process.argv[3] || "C:/Users/ottom/OneDrive/Documents/PT Mods/Kacky Lab/sim";
let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MixinType = { INSERT: 3, REPLACEBETWEEN: 5 };

(async () => {
  // ---- rules --------------------------------------------------------------
  {
    const round = Logic.newRound();
    const p = (id, started, frames, life = 1) => ({ id, started, frames, life });
    check("lms: nothing happens while everybody is still in", !Logic.lmsStep(round, [p(1, true, 500), p(2, true, 500), p(3, true, 500)]) && !round.result);
    Logic.lmsOut(round, 2, 4000);
    check("lms: one out of three does not end the round", !Logic.lmsStep(round, [p(1, true, 5000), p(2, true, 5000), p(3, true, 5000)]));
    check("lms: a second report from the same player is ignored", !Logic.lmsOut(round, 2, 9000) && round.out[2] === 4000);
    Logic.lmsOut(round, 3, 7000);
    Logic.lmsStep(round, [p(1, true, 7100), p(2, true, 7100), p(3, true, 7100)]);
    const order = round.result?.order.map((e) => e.id).join();
    check("lms: last one standing wins, the rest by how long they lasted", order === "1,3,2" && round.result.order[0].survived, order);
    const f = [1, 3, 2].map((id) => Logic.cupFrames(round.result, id));
    check("lms: times for PolyCup keep that order and stay within the round", f[0] < f[1] && f[1] < f[2] && f[2] <= round.result.elapsed && f[0] >= 1, f.join(" < "));
    check("lms: no reports once the round is decided", !Logic.lmsOut(round, 1, 8000));
    check("lms: result stays until somebody resets", !Logic.lmsStep(round, [p(1, true, 9000), p(2, true, 9000), p(3, true, 9000)]) && !!round.result);
    Logic.lmsStep(round, [p(1, false, 0, 2), p(2, false, 0, 2), p(3, false, 0, 2)]);
    check("lms: a reset starts the next round clean", !round.result && !Object.keys(round.out).length && round.seq === 1);

    const tie = Logic.newRound();
    Logic.lmsOut(tie, 1, 3000); Logic.lmsOut(tie, 2, 3000);
    Logic.lmsStep(tie, [p(1, true, 3100), p(2, true, 3100), p(3, true, 3100)]);
    check("lms: equal survival gets equal place", Logic.cupFrames(tie.result, 1) === Logic.cupFrames(tie.result, 2) && Logic.cupFrames(tie.result, 3) < Logic.cupFrames(tie.result, 1));
    const all = Logic.newRound();
    Logic.lmsOut(all, 1, 2000); Logic.lmsOut(all, 2, 2500);
    Logic.lmsStep(all, [p(1, true, 2600), p(2, true, 2600)]);
    check("lms: everybody out: longest survivor first", all.result?.order.map((e) => e.id).join() === "2,1");
    const solo = Logic.newRound();
    Logic.lmsOut(solo, 1, 2000);
    check("lms: a player alone is not a round", !Logic.lmsStep(solo, [p(1, true, 2100)]) && !solo.result);
    Logic.lmsStep(solo, [p(1, false, 0, 2)]);
    check("lms: leftovers are dropped when nobody is driving", !Object.keys(solo.out).length);

    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const spawns = Logic.rollSpawns([4, 9, 2], 5, random);
    check("koth: every player gets a different start", new Set(Object.values(spawns)).size === 3 && Object.values(spawns).every((i) => i >= 0 && i < 5), JSON.stringify(spawns));
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(Logic.rollSpawns([1], 4, random)[1]);
    check("koth: starts are random", seen.size === 4);
    check("koth: more players than starts still works", Object.keys(Logic.rollSpawns([1, 2, 3, 4, 5], 2, random)).length === 5);

    const good = { mode: "lms", turtle: true, seq: 3, out: { 2: 4000 }, result: null, spawns: {} };
    check("messages: a host's state is accepted, nonsense is not", Logic.validState(good) && !Logic.validState({ ...good, mode: "x" }) &&
      !Logic.validState({ ...good, out: { 2: "soon" } }) && !Logic.validState({ ...good, result: { order: [{ id: 1 }], elapsed: 5 } }) && !Logic.validState(null));
  }

  // ---- the built mod, with stand-ins --------------------------------------
  const version = Object.values(require("../dist/manifest.json").latest)[0];
  let modSource = fs.readFileSync(path.join(__dirname, "..", "dist", version, "main.mod.js"), "utf8");
  modSource = modSource
    .replace('await import(new URL("PolyTypes.js", document.baseURI).href)', "__types")
    .replace("export let polyMod =", "globalThis.__polyMod =");
  class PolyMod { constructor() { this.init = () => {}; } }
  globalThis.__types = { PolyMod, MixinType };
  const hud = { style: {}, textContent: "" };
  globalThis.document = { baseURI: "https://game.invalid/", createElement: () => hud, body: { appendChild() {} } };
  const keyListeners = [];
  globalThis.window = { addEventListener: (type, cb) => keyListeners.push(cb) };
  const frames = [];
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  const workerSource = GAME ? fs.readFileSync(path.join(GAME, "simulation_worker.bundle.js"), "utf8") : null;
  globalThis.fetch = async () => new Response(workerSource ?? "const r = i.data; const o = i.getStartTransform();");
  vm.runInThisContext("(async () => {" + modSource + "})()", { filename: "main.mod.js" });
  await sleep(0);
  const mod = globalThis.__polyMod;
  mod.modID = "ptgamemodes"; mod.modVersion = version;

  // a track with three start blocks, the lowest piece four blocks up
  const vec = (x, y, z) => ({ x, y, z, clone() { return vec(this.x, this.y, this.z); } });
  const quat = () => ({ x: 0, y: 0, z: 0, w: 1, clone: quat });
  class TrackData {
    constructor() { this.parts = []; }
    get environment() { return 0; }
    get sunDirection() { return vec(0, 1, 0); }
    addPart(x, y, z, type, rotation, axis, color, checkpoint, order) { this.parts.push([x, y, z, type, rotation, axis, color, checkpoint, order]); }
    forEachPart(cb) { for (const part of this.parts) cb(...part); }
    getStartTransform() {
      const starts = this.parts.filter((part) => part[8] !== null).sort((a, b) => b[8] - a[8]);
      return starts.length ? { position: vec(starts[0][0] * 5, starts[0][1] * 5 + 1, starts[0][2] * 5), quaternion: quat() } : null;
    }
  }
  const data = new TrackData();
  data.addPart(0, 4, 0, 5, 0, 0, 0, null, 0);
  data.addPart(10, 4, 0, 5, 0, 0, 0, null, 2);
  data.addPart(20, 6, 0, 5, 0, 0, 0, null, 1);
  data.addPart(3, 4, 3, 1, 0, 0, 0, null, null);
  const track = { getStartTransform: () => data.getStartTransform() };

  let cupCalls = [];
  function makeCar() {
    const car = {
      started: false, frames: 0, finish: null, pos: vec(50, 21, 0), q: { x: 0, y: 0, z: 0, w: 1 }, speed: 0, callbacks: [],
      hasStarted() { return this.started; }, hasFinished() { return this.finish !== null; },
      getTime() { return { numberOfFrames: this.frames }; }, getFinishTime() { return this.finish === null ? null : { numberOfFrames: this.finish }; },
      getPosition() { return this.pos; }, getQuaternion() { return this.q; }, getSpeedKmh() { return this.speed; },
    };
    Object.setPrototypeOf(car, carProto);
    car.addFinishCallback(() => {}); // the game's own
    return car;
  }
  const carProto = { addFinishCallback(cb) { this.callbacks.push(cb); } };
  const remoteState = (over) => ({ frames: 0, hasStarted: false, finishFrames: null, position: vec(0, 0, 0), quaternion: quat(), ...over });
  const remote = (id) => ({ resetCounter: 1, state: remoteState({}), opacity: 1,
    car: { getCarState() { return remotes.get(id).state; }, setOpacity(v) { remotes.get(id).opacity = v; }, setCarState(s) { remotes.get(id).state = s; } } });
  const remotes = new Map([[5, null], [6, null]]);
  remotes.set(5, remote(5)); remotes.set(6, remote(6));

  const sent = { 5: [], 6: [] }, channels = {};
  const peer = (id) => ({ id, pc: { connectionState: "connected", createDataChannel: (name, options) =>
    (channels[id] = { name, options, readyState: "open", send: (text) => sent[id].push(JSON.parse(text)), close() {} }) } });
  const connection = { host: true, peers: [peer(5), peer(6)],
    getPlayers: () => [{ id: 5, isSelf: false, nickname: "Five" }, { id: 6, isSelf: false, nickname: "Six" }, { id: 1, isSelf: true, nickname: "Me" }] };
  const sessions = new WeakMap(), game = {};
  const world = { car: null, life: 1, settings: { PtgMode: "off", PtgTurtle: "false" } };
  const simMessages = [], impulses = [];
  globalThis.__ptCollisions = { ghostIds: new Set(), ghostAll: false, postToSim: (m) => simMessages.push(m), impulse: (dv, dw) => impulses.push({ dv, dw }) };
  const workerMixins = [];
  const pml = {
    polyVersion: "0.6.3",
    registerSimWorkerMixin: (m) => workerMixins.push(m),
    registerSettingCategory() {}, registerSetting() {},
    getSetting: (id) => world.settings[id],
    getFromPolyTrack: () => ({
      watchGames: (cb) => cb(sessions), session: (g) => sessions.get(g), remotes: () => remotes, car: () => world.car, life: () => world.life,
      track: () => track, trackData: () => data, isHost: (c) => c.host, peers: (c) => c.peers, isRespawnKey: (g, e) => e.code === "KeyR",
    }),
  };
  await mod.init(pml);
  let clock = 1000;
  const frame = (ms = 16) => { clock += ms; frames.splice(0).forEach((cb) => cb(clock)); };
  const lastState = (id = 5) => sent[id][sent[id].length - 1];

  world.car = makeCar();
  sessions.set(game, { sessionId: 1, multiplayerConnection: connection });
  frame(); frame();
  check("mod: off by default, the others are told", lastState()?.mode === "off" && channels[5].options.id === 78);
  check("mod: off leaves the track's start alone", track.getStartTransform().position.x === 50);

  // ---- king of the hill ---------------------------------------------------
  world.settings.PtgMode = "koth";
  frame();
  const spawns = lastState().spawns;
  check("koth: host deals a different start to each of the three players", lastState().mode === "koth" && new Set([spawns[1], spawns[5], spawns[6]]).size === 3, JSON.stringify(spawns));
  const xs = [0, 100, 50]; // start blocks in placing order: x = 0, 20, 10 blocks
  simMessages.length = 0;
  const mine = track.getStartTransform();
  check("koth: our car is created on our start, in the game and in the simulation",
    mine.position.x === xs[spawns[1]] && simMessages.at(-1)?.messageType === "ptgSpawn" && simMessages.at(-1).spawn.position.x === xs[spawns[1]],
    `start ${spawns[1]} at x=${mine.position.x}`);
  check("koth: waiting players are shown on their own starts", remotes.get(5).state.position.x === xs[spawns[5]] && remotes.get(6).state.position.x === xs[spawns[6]]);
  check("koth: we are told to restart while still on the old start", hud.textContent.includes("KING OF THE HILL") && (mine.position.x === 50) !== hud.textContent.includes("Restart"));
  world.car.q = { x: 1, y: 0, z: 0, w: 0 }; world.car.started = true;
  for (let i = 0; i < 400; i++) frame();
  check("koth: no anti-turtle, no eliminations", impulses.length === 0 && Object.keys(lastState().out).length === 0);
  const beforeRoll = JSON.stringify(spawns);
  let rerolled = false;
  for (let i = 0; i < 12 && !rerolled; i++) {
    remotes.get(5).state = remoteState({ hasStarted: true, frames: 9000, finishFrames: i % 2 ? null : 9000 });
    frame(); frame();
    rerolled = JSON.stringify(lastState().spawns) !== beforeRoll;
  }
  check("koth: starts are dealt again after a race", rerolled);
  remotes.get(5).state = remoteState({});

  // ---- last man standing --------------------------------------------------
  world.settings.PtgMode = "lms";
  world.car = makeCar(); world.life++;
  world.car.addFinishCallback(function (car) { cupCalls.push(car.getTime().numberOfFrames); }); // as PolyCup hooks each car
  frame();
  check("lms: back on the track's own start", lastState().mode === "lms" && track.getStartTransform().position.x === 50 && simMessages.at(-1).spawn === null);
  world.car.started = true; world.car.frames = 1000;
  remotes.get(5).state = remoteState({ hasStarted: true, frames: 1000 });
  remotes.get(6).state = remoteState({ hasStarted: true, frames: 1000 });
  frame();
  const key = { code: "KeyR", stopped: false, stopImmediatePropagation() { this.stopped = true; }, preventDefault() {} };
  keyListeners.forEach((cb) => cb(key));
  check("lms: the respawn key is blocked during a round", key.stopped);
  channels[6].onmessage({ data: JSON.stringify({ out: 4000 }) });
  channels[6].onmessage({ data: JSON.stringify({ out: 9999 }) });
  channels[6].onmessage({ data: "{broken" });
  frame();
  check("lms: a player's report puts them out, once", lastState().out[6] === 4000 && !lastState().result);
  check("lms: their car is faded and no longer solid", remotes.get(6).opacity === 0.3 && globalThis.__ptCollisions.ghostIds.has(6) && !globalThis.__ptCollisions.ghostAll);
  // on our roof for five seconds
  world.car.q = { x: 1, y: 0, z: 0, w: 0 }; world.car.frames = 5000;
  for (let i = 0; i < 280; i++) frame();
  check("lms: anti-turtle is off unless the host turns it on", impulses.length === 0);
  world.settings.PtgTurtle = "true";
  for (let i = 0; i < 250; i++) frame();
  check("lms: not before five seconds upside down", impulses.length === 0);
  for (let i = 0; i < 80; i++) frame();
  check("lms: anti-turtle throws the stuck car into the air", impulses.length === 1 && impulses[0].dv[1] > 5, JSON.stringify(impulses[0]));
  world.car.q = { x: 0, y: 0, z: 0, w: 1 };
  // the real finish line: a loss, and PolyCup is not told yet
  world.car.finish = 6000; world.car.frames = 6000;
  world.car.callbacks.forEach((cb) => cb(world.car));
  frame();
  check("lms: crossing the finish puts us out, and PolyCup does not hear of a finish", lastState().out[1] === 6000 && !cupCalls.some((f) => f === 6000));
  check("lms: once out, no car is solid for us", globalThis.__ptCollisions.ghostAll === true);
  frame();
  const result = lastState().result;
  check("lms: last player standing wins the round", result?.order.map((e) => e.id).join() === "5,1,6", result && JSON.stringify(result.order));
  check("lms: PolyCup is given our place as a finish time, once", cupCalls.length === 1 && cupCalls[0] === Logic.cupFrames(result, 1) && cupCalls[0] > Logic.cupFrames(result, 5) && world.car.getTime().numberOfFrames === 6000,
    `reported ${cupCalls[0]} of ${result?.elapsed}`);
  check("lms: results are shown", hud.textContent.includes("1. Five") && hud.textContent.includes("2. Me") && hud.textContent.includes("0:06.000"));
  // next round: everybody is reset
  world.car = makeCar(); world.life++;
  remotes.get(5).resetCounter++; remotes.get(6).resetCounter++;
  remotes.get(5).state = remoteState({}); remotes.get(6).state = remoteState({});
  frame(); frame();
  check("lms: the next round starts clean", !lastState().result && !Object.keys(lastState().out).length && remotes.get(6).opacity === 1 && !globalThis.__ptCollisions.ghostAll);
  // falling off
  world.car.started = true; world.car.frames = 4000; world.car.pos = vec(50, 30, 0);
  remotes.get(5).state = remoteState({ hasStarted: true, frames: 4000 });
  remotes.get(6).state = remoteState({ hasStarted: true, frames: 4000 });
  frame();
  check("lms: driving on the arena is fine", !(1 in lastState().out));
  world.car.pos = vec(50, 17.5, 0); // lowest piece is at 20 m
  frame(); frame();
  check("lms: falling below the track puts us out", lastState().out[1] === 4000 && hud.textContent.includes("fell off"));

  // ---- as a player in somebody else's session ------------------------------
  connection.host = false;
  connection.peers = [{ id: null, pc: peer(0).pc }];
  sent[0] = [];
  world.car = makeCar(); world.life++;
  frame();
  channels[0].onmessage({ data: JSON.stringify({ mode: "lms", turtle: false, seq: 40, out: {}, result: null, spawns: {} }) });
  world.car.started = true; world.car.frames = 5000; world.car.pos = vec(50, 30, 0);
  frame();
  world.car.pos = vec(50, 10, 0);
  frame(); frame();
  check("player: our elimination is reported to the host, once", sent[0].length === 1 && sent[0][0].out === 5000, JSON.stringify(sent[0]));
  channels[0].onmessage({ data: JSON.stringify({ mode: "koth", turtle: false, seq: 41, out: {}, result: null, spawns: { 1: 0, 5: 1, 6: 2 } }) });
  frame();
  check("player: the host's mode and starts are followed", mod.mode === "koth" && track.getStartTransform().position.x === 0);
  channels[0].onmessage({ data: JSON.stringify({ mode: "koth", turtle: false, seq: 41, out: {}, result: null, spawns: { 1: "x" } }) });
  frame();
  check("player: a malformed state is ignored", track.getStartTransform().position.x === 0);

  // ---- the start override in the real simulation worker --------------------
  if (!GAME) { console.log("(no game files given: simulation worker part skipped)"); }
  else {
    const collisions = fs.readFileSync(path.join(__dirname, "..", "..", "polytrack-collisions", "src", "worker-runtime.js"), "utf8");
    const apply = (text, m) => {
      if (m.type === MixinType.INSERT) { const at = text.indexOf(m.token); if (at < 0) throw new Error("token"); return text.slice(0, at + m.token.length) + m.func + text.slice(at + m.token.length); }
      const a = text.indexOf(m.tokenStart); if (a < 0) throw new Error("token");
      return text.split(m.tokenStart).join(m.func);
    };
    let patched = workerSource;
    // Car Collisions' mixins first, as in the game, then ours
    patched = apply(patched, { type: MixinType.INSERT, token: "const $o = [];", func: collisions });
    patched = apply(patched, { type: MixinType.INSERT, token: "const r = i.data;", func: `if (r && r.messageType === "ptc") { self.__ptc.remote(r); return; }` });
    for (const m of workerMixins) patched = apply(patched, m);
    check("worker: both mods' mixins fit together", patched.includes("self.__ptgSpawn = r.spawn") && patched.includes("(null == a && self.__ptgSpawn) || i.getStartTransform()"));

    const tmp = path.join(__dirname, ".track.tmp");
    execFileSync(process.execPath, ["-e", `
      const path=require("path"),fs=require("fs");const LAB=${JSON.stringify(LAB)};
      const {boot}=require(path.join(LAB,"sim.js"));
      boot().then(pt=>{const t=pt.Ko.fromExportString(fs.readFileSync(path.join(LAB,"_tmp.code"),"utf8").trim()).trackData;
        const s=t.getStartTransform();
        fs.writeFileSync(${JSON.stringify(tmp)},JSON.stringify({save:t.toSaveString(),p:[s.position.x,s.position.y,s.position.z],q:[s.quaternion.x,s.quaternion.y,s.quaternion.z,s.quaternion.w]}));process.exit(0)});`],
      { stdio: ["ignore", "ignore", "ignore"] });
    const trackInfo = JSON.parse(fs.readFileSync(tmp, "utf8"));
    fs.unlinkSync(tmp);

    const out = [];
    globalThis.fetch = async (url) => new Response(fs.readFileSync(path.join(LAB, path.basename(String(url)))), { headers: { "content-type": "application/wasm" } });
    globalThis.self = globalThis;
    globalThis.location = { href: "file:///" + LAB.replace(/\\/g, "/") + "/" };
    globalThis.postMessage = (m) => out.push(m);
    globalThis.importScripts = (p) => vm.runInThisContext(fs.readFileSync(path.join(LAB, path.basename(p)), "utf8"), { filename: p });
    globalThis.addEventListener = () => {};
    globalThis.onmessage = null;
    globalThis.XMLHttpRequest = class {
      open(method, url) { this.url = url; }
      send() { const b = fs.readFileSync(path.join(LAB, path.basename(String(this.url)))); this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    };
    delete globalThis.requestAnimationFrame;
    globalThis.window = { JS_SHA256_NO_NODE_JS: true };
    const quiet = console.error;
    console.error = () => {};
    vm.runInThisContext(patched, { filename: "simulation_worker.patched.js" });
    delete globalThis.window;
    const send = (d) => globalThis.onmessage({ data: d });
    const f32 = (v) => (v && v.__f32 ? new Float32Array(v.__f32) : Array.isArray(v) ? new Float32Array(v) : v);
    const init = JSON.parse(fs.readFileSync(path.join(LAB, "init.json"), "utf8"));
    send({ ...init, messageType: 0, isRealtime: true, trackParts: init.trackParts.map((p) => ({ ...p, vertices: f32(p.vertices) })),
      carCollisionShapeVertices: f32(init.carCollisionShapeVertices) });
    const firstPosition = async (carId) => {
      out.length = 0;
      send({ messageType: 3, trackData: trackInfo.save, carId, carRecording: null, mountainVertices: new Float32Array(9), mountainOffset: { x: 0, y: -100000, z: 0 } });
      send({ messageType: 5, carId, targetSimulationTimeFrames: null });
      send({ messageType: 6, carId, up: true, right: false, down: false, left: false, reset: false });
      for (let i = 0; i < 400; i++) {
        await sleep(25);
        const m = out.find((x) => x.messageType === 10);
        if (!m) continue;
        const buf = m.carStateBuffers[0], d = new DataView(buf), u = new Uint8Array(buf), off = 12 + (u[11] & 2 ? 3 : 0) + 2;
        send({ messageType: 4, carId });
        return [d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true)];
      }
      return null;
    };
    const queued = globalThis.onmessage;
    for (let i = 0; i < 400 && globalThis.onmessage === queued; i++) await sleep(25); // until the physics has loaded
    await sleep(300);
    const near = (a, b) => a && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.5;
    const normal = await firstPosition(1);
    console.error = quiet;
    check("worker: without a start from us the car is on the track's start", near(normal, trackInfo.p), normal && normal.map((v) => v.toFixed(2)).join());
    const moved = [trackInfo.p[0] + 12, trackInfo.p[1] + 40, trackInfo.p[2] - 7];
    send({ messageType: "ptgSpawn", spawn: { position: { x: moved[0], y: moved[1], z: moved[2] }, quaternion: { x: trackInfo.q[0], y: trackInfo.q[1], z: trackInfo.q[2], w: trackInfo.q[3] } } });
    const shifted = await firstPosition(2);
    check("worker: with a start from us the car is created there", near(shifted, moved), shifted && shifted.map((v) => v.toFixed(2)).join());
    send({ messageType: "ptgSpawn", spawn: null });
    check("worker: and back on the track's start when it is cleared", near(await firstPosition(3), trackInfo.p));
  }

  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERROR", e); process.exit(1); });
