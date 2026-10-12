// Builds dist/ (the folder the mod loader imports): node build.js
const fs = require("fs");
const path = require("path");

const VERSION = "1.0.0";
const GAME = "0.6.3";
const root = __dirname;
const out = path.join(root, "dist", VERSION);
fs.mkdirSync(out, { recursive: true });

const read = (name) => fs.readFileSync(path.join(root, "src", name), "utf8");
fs.writeFileSync(path.join(out, "main.mod.js"), read("logic.js") + "\n" + read("main.js"));

const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
json(path.join(root, "dist", "manifest.json"), {
  name: "Cup Gamemodes",
  author: "Hiksi",
  id: "ptgamemodes",
  latest: { [GAME]: VERSION },
});
json(path.join(out, "version.json"), {
  main: "main.mod.js",
  targets: [GAME],
  dependencies: [{ id: "ptcollisions", version: ">=1.2.0" }],
});
const icon = path.join(root, "..", "polytrack-collisions", "dist");
for (const dir of fs.existsSync(icon) ? fs.readdirSync(icon) : []) {
  const file = path.join(icon, dir, "icon.png");
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(out, "icon.png"));
}
console.log("built", path.relative(root, out));
