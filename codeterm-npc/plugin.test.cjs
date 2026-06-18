// Plugin-side tests for codeterm-npc (Track F, mock-first).
// Run: npx tsx codeterm-npc/plugin.test.cjs  (after `npm run build`).
//
// The oracle for the NPC chatBackend plugin's PURE logic: persona→spawn-task
// mapping, the per-NPC reminder cadence, and the onAgentCommand game-bound
// formatting. The async multi-NPC round-trip is proven separately by the
// host_stub demo + the mock_game Python test — here we keep the host untouched
// at load time (mirrors the codeterm-plugins test convention).

globalThis.host = new Proxy(
  {},
  { get: () => () => { throw new Error("host called at load time"); } },
);

const plugin = require("./plugin.js").default;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── persona → spawn-task mapping ──

test("buildSpawnTask embeds the persona, the verbs, and the scene", () => {
  const persona = "Ты — следователь Морозов. Говоришь коротко и сухо.";
  const task = plugin.__test_buildSpawnTask("npc_morozov", persona, {
    scene: "Феррополис. Зима затянулась.",
    commands: ["say", "look", "move", "emote"],
  });
  assert(task.includes(persona), "spawn task carries the persona verbatim");
  assert(task.includes("npc_morozov"), "spawn task names the npc_id");
  for (const verb of ["say", "look", "move", "emote"]) {
    assert(task.includes(verb), `spawn task teaches the verb '${verb}'`);
  }
  assert(task.includes("codeterm plugin"), "spawn task tells the agent HOW to call a verb");
  assert(task.includes("Феррополис"), "spawn task carries the scene");
});

// ── per-NPC stay-in-character reminder cadence ──

test("shouldRemind fires every Nth turn, never on turn 0", () => {
  assert(plugin.__test_shouldRemind(0, 3) === false, "no reminder before the first turn");
  assert(plugin.__test_shouldRemind(1, 3) === false, "turn 1, N=3 → no");
  assert(plugin.__test_shouldRemind(3, 3) === true, "turn 3, N=3 → yes");
  assert(plugin.__test_shouldRemind(6, 3) === true, "turn 6, N=3 → yes");
  assert(plugin.__test_shouldRemind(4, 3) === false, "turn 4, N=3 → no");
});

test("shouldRemind with N<=0 never fires (cadence disabled)", () => {
  assert(plugin.__test_shouldRemind(3, 0) === false, "N=0 disables the reminder");
  assert(plugin.__test_shouldRemind(9, -1) === false, "N<0 disables the reminder");
});

test("applyReminder prepends a stay-in-character note only when due", () => {
  const text = "Где ты была прошлой ночью?";
  const due = plugin.__test_applyReminder(text, 3, 3, "Морозов");
  assert(due !== text, "on the Nth turn the text is augmented");
  assert(due.endsWith(text), "the original player line is preserved at the end");
  assert(/character|character|роли|in character/i.test(due), "the reminder mentions staying in character");
  assert(due.includes("Морозов"), "the reminder names the character");

  const notDue = plugin.__test_applyReminder(text, 2, 3, "Морозов");
  assert(notDue === text, "off-cadence turns pass through unchanged");
});

// ── cast parsing: config.yaml writes a comma-separated string, not an array ──

test("parseCast accepts a comma-separated string and an array", () => {
  const fromString = plugin.__test_parseCast("npc_morozov, npc_xenia");
  assert(Array.isArray(fromString) && fromString.length === 2, "string → 2 ids");
  assert(fromString[0] === "npc_morozov" && fromString[1] === "npc_xenia", "ids trimmed in order");
  const fromArray = plugin.__test_parseCast(["npc_a", "npc_b"]);
  assert(fromArray.length === 2 && fromArray[1] === "npc_b", "array passes through");
  const fallback = plugin.__test_parseCast(undefined);
  assert(fallback.length >= 1, "missing cast falls back to defaults, not empty");
});

// ── onAgentCommand: the inverse seam (agent → game) ──

test("onAgentCommand('say') formats a game-bound line for the mapped NPC", () => {
  plugin.__test_reset();
  plugin.__test_registerSession("sess-abc", "npc_morozov");
  const out = plugin.onAgentCommand({
    sessionId: "sess-abc",
    verb: "say",
    args: ["Я видела достаточно."],
  });
  assert("result" in out, "say returns a result, not an error");
  assert(out.result === "say|npc_morozov|Я видела достаточно.", "game-bound line is pipe-delimited speaker+text, got: " + out.result);
});

test("onAgentCommand('move') mutates and returns mock world state", () => {
  plugin.__test_reset();
  plugin.__test_registerSession("sess-x", "npc_xenia");
  const out = plugin.onAgentCommand({ sessionId: "sess-x", verb: "move", args: ["чайная"] });
  assert("result" in out, "move returns a result");
  assert(out.result.includes("чайная"), "world state reflects the new location, got: " + out.result);
  const world = plugin.__test_world();
  assert(world.locations["npc_xenia"] === "чайная", "npc_xenia is now in чайная");
});

test("onAgentCommand on an unknown session is an error, not a crash", () => {
  plugin.__test_reset();
  const out = plugin.onAgentCommand({ sessionId: "ghost", verb: "say", args: ["hi"] });
  assert("error" in out, "unmapped session → error envelope");
});

test("onAgentCommand with an unknown verb is an error", () => {
  plugin.__test_reset();
  plugin.__test_registerSession("s", "npc_culwich");
  const out = plugin.onAgentCommand({ sessionId: "s", verb: "teleport", args: [] });
  assert("error" in out, "unknown verb → error envelope");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`codeterm-npc plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
