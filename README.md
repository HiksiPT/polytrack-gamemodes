# Cup Gamemodes (PolyTrack 0.6.3, PolyModLoader)

Two gamemodes for multiplayer sessions, made to be played in PolyCup rounds. Needs the
**Car Collisions** mod, version 1.2.0 or newer. Every player needs both mods, in the same versions.

The host picks the mode in the game's settings, under **Cup Gamemodes**:

- **Gamemode (set by the host)**: Off, Last man standing, King of the hill.
- **Last man standing: anti-turtle**: Off / On.

Only the host's settings count; the other players' games follow them.

## Last man standing

- You are out when you cross a finish, fall more than 2 m below the lowest piece of the track,
  or reset your car after driving for more than 3 seconds.
- The respawn key is switched off during a round.
- The round ends when one player is left. Ranking: the survivor first, then the others by how
  long they lasted.
- Cars that are out are drawn faded and are no longer solid.
- Anti-turtle (if the host turned it on): a car that has been on its roof or side and nearly
  still for 5 seconds is thrown into the air with a roll. Never used in King of the hill.
- Arenas should stand at least one block above the ground, otherwise there is nothing to fall
  to. A round needs at least two players who have started.

## King of the hill

- Put several start blocks on the track. Each player is put on a random one, all different
  while there are enough. New starts are dealt after every race.
- Otherwise it is a normal race to the finish.
- A car only moves to its start when it is reset. PolyCup resets everybody at the start of a
  round; outside PolyCup, press restart (the screen says so).

## With PolyCup

PolyCup runs the rounds and the points as usual. King of the hill needs nothing special:
the first to finish wins. For last man standing, PolyCup is not told about anybody until the
round is over; then every player's place is handed to it as a finish time (the survivor the
lowest), so its points follow the survival order. The times PolyCup shows for such a round are
therefore placeholders; the real survival times are in this mod's own list on screen.

Without PolyCup both modes still work, with this mod's own on-screen result.

## Not tested

The rules, the messages between players and the start override are tested with stand-ins for
the game and inside the game's real simulation worker (`node test/gamemodes.test.js <game files
dir>`). Nothing has been tried in a real session, with or without PolyCup.

## Uploading

Double-click `Upload to GitHub.cmd` (own repository, separate from Car Collisions) and import
`https://<user>.github.io/<repo>/dist` in the loader.
