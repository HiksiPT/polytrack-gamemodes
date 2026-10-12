// Cup Gamemodes: the rules, kept free of anything from the game so they can be tested alone.
const Logic = {
  MODES: ["off", "lms", "koth"],

  newRound() {
    return { seq: 0, out: {}, result: null };
  },

  // Last man standing, run by the host every frame.
  // players: [{ id, started, frames, life }], where `life` changes whenever that player's car is reset.
  // Returns true when the round changed (and should be sent to everyone).
  lmsStep(round, players) {
    if (round.result) {
      // The next round begins when somebody who took part resets their car.
      const lives = round.result.lives;
      if (!players.some((p) => p.id in lives && lives[p.id] !== p.life)) return false;
      round.seq++;
      round.out = {};
      round.result = null;
      return true;
    }
    // Nobody driving: whatever was left over from an abandoned round is forgotten.
    if (Object.keys(round.out).length && !players.some((p) => p.started)) {
      round.seq++;
      round.out = {};
      return true;
    }
    const taking = players.filter((p) => p.started || p.id in round.out);
    const alive = taking.filter((p) => !(p.id in round.out));
    if (taking.length < 2 || alive.length > 1 || !Object.keys(round.out).length) return false;
    const elapsed = Math.max(1, ...alive.map((p) => p.frames), ...taking.filter((p) => p.id in round.out).map((p) => round.out[p.id]));
    const order = [
      ...alive.map((p) => ({ id: p.id, t: elapsed, survived: true })),
      ...taking.filter((p) => p.id in round.out).map((p) => ({ id: p.id, t: round.out[p.id], survived: false })).sort((a, b) => b.t - a.t),
    ];
    round.result = { order, elapsed, lives: Object.fromEntries(players.map((p) => [p.id, p.life])) };
    return true;
  },

  // A player reports being eliminated after surviving `frames` ms.
  lmsOut(round, id, frames) {
    if (round.result || id in round.out || !Number.isSafeInteger(frames) || frames < 0 || frames > 36e5) return false;
    round.out[id] = frames;
    return true;
  },

  // PolyCup ranks a round by finish time, lowest first. A last-man-standing result is handed to
  // it as finish times that keep the survival order: the survivor gets the lowest time, and all
  // of them stay at or below the round's length, which is the most PolyCup accepts.
  cupFrames(result, id) {
    const order = result.order, at = order.findIndex((entry) => entry.id === id);
    if (at < 0) return null;
    // out at the same moment: equal place (but never equal to the one who was still standing)
    const place = order.findIndex((entry) => entry.t === order[at].t && entry.survived === order[at].survived);
    const gap = Math.max(1, Math.min(1000, Math.floor(result.elapsed / (order.length + 1))));
    return Math.max(1, result.elapsed - gap * (order.length - 1 - place));
  },

  // King of the hill: a random start for every player, all different while there are enough.
  rollSpawns(ids, count, random = Math.random) {
    if (count < 1) return {};
    const slots = Array.from({ length: count }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    return Object.fromEntries([...ids].sort((a, b) => a - b).map((id, i) => [id, slots[i % count]]));
  },

  // What a host sent, checked before it is used.
  validState(s) {
    const int = (n) => Number.isSafeInteger(n) && n >= 0;
    const map = (m, max) => !!m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length <= 64 &&
      Object.values(m).every((v) => int(v) && v <= max);
    return !!s && typeof s === "object" && Logic.MODES.includes(s.mode) && typeof s.turtle === "boolean" && int(s.seq) &&
      map(s.out, 36e5) && map(s.spawns, 4096) &&
      (s.result === null || (typeof s.result === "object" && int(s.result.elapsed) && s.result.elapsed <= 36e5 &&
        Array.isArray(s.result.order) && s.result.order.length <= 64 &&
        s.result.order.every((e) => e && int(e.id) && int(e.t) && e.t <= 36e5 && typeof e.survived === "boolean")));
  },

  time(frames) {
    const s = Math.floor(frames / 1000), ms = String(frames % 1000).padStart(3, "0");
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${ms}`;
  },
};
if (typeof module !== "undefined") module.exports = Logic;
