"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// codeterm-npc/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var DEFAULTS = {
  scene: "",
  reminderEvery: 4,
  gameFolder: ".",
  maxSessions: 5,
  defaultModel: "claude-haiku-4-5-20251001",
  cast: ["npc_morozov", "npc_xenia", "npc_culwich"]
};
function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(host.settingsJson() || "{}");
  } catch {
    raw = {};
  }
  return {
    scene: typeof raw.scene === "string" ? raw.scene : DEFAULTS.scene,
    reminderEvery: typeof raw.reminderEvery === "number" ? raw.reminderEvery : DEFAULTS.reminderEvery,
    gameFolder: typeof raw.gameFolder === "string" ? raw.gameFolder : DEFAULTS.gameFolder,
    maxSessions: typeof raw.maxSessions === "number" ? raw.maxSessions : DEFAULTS.maxSessions,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : DEFAULTS.defaultModel,
    cast: Array.isArray(raw.cast) && raw.cast.length ? raw.cast : DEFAULTS.cast
  };
}
var VERBS = ["say", "look", "move", "emote"];
function buildSpawnTask(npcId, persona, opts = {}) {
  const verbs = (opts.commands && opts.commands.length ? opts.commands : VERBS).slice();
  const lines = [
    persona.trim(),
    "",
    `You are the character "${npcId}". Stay in character at all times.`
  ];
  if (opts.scene && opts.scene.trim()) {
    lines.push("", `Scene: ${opts.scene.trim()}`);
  }
  lines.push(
    "",
    "You can act in the world by running these commands (they reach the game):",
    ...verbs.map((v) => `  codeterm plugin codeterm-npc ${v} <args>`),
    "",
    "Speak only as your character. Keep replies to 1\u20133 short sentences."
  );
  return lines.join("\n");
}
function shouldRemind(turns, every) {
  if (every <= 0) return false;
  return turns > 0 && turns % every === 0;
}
function buildReminder(npcName) {
  return `[Director's note \u2014 you are ${npcName}. Stay fully in character: your own voice, your own knowledge, no narration of the system. Answer the line below as ${npcName} would.]`;
}
function applyReminder(text, turns, every, npcName) {
  if (!shouldRemind(turns, every)) return text;
  return `${buildReminder(npcName)}

${text}`;
}
var workspaceId = null;
var pool = [];
var bySession = /* @__PURE__ */ new Map();
var panes = /* @__PURE__ */ new Map();
var world = { locations: {}, log: [] };
function nowMs() {
  try {
    return host.unixNowMs();
  } catch {
    return 0;
  }
}
function readPersona(npcId, gameFolder) {
  const path = `${gameFolder}/npc_scripts/${npcId}.md`;
  let raw = null;
  try {
    raw = host.readFile(path);
  } catch {
    raw = null;
  }
  if (!raw) return `You are ${npcId}.`;
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return (fm ? raw.slice(fm[0].length) : raw).trim();
}
async function ensureNpc(npcId, s) {
  const existing = pool.find((e) => e.npcId === npcId);
  if (existing) {
    existing.lastActiveMs = nowMs();
    return existing;
  }
  if (workspaceId == null) {
    const ws = await host.workspace.ensure({ name: "dread-npcs", externalRoot: s.gameFolder });
    workspaceId = ws.workspaceId;
  }
  let sessionId = null;
  const found = await host.agent.get(workspaceId, npcId);
  if (found) {
    const resumed = await host.agent.resume(workspaceId, found.sessionId);
    sessionId = resumed ? resumed.sessionId : null;
  }
  if (sessionId == null) {
    const persona = readPersona(npcId, s.gameFolder);
    const task = buildSpawnTask(npcId, persona, { scene: s.scene, commands: VERBS });
    const spawned = await host.agent.spawn(workspaceId, {
      backend: { model: s.defaultModel },
      task,
      key: npcId,
      commands: VERBS.slice()
    });
    sessionId = spawned.sessionId;
  }
  await reapIfNeeded(s.maxSessions);
  const entry = { npcId, sessionId, lastActiveMs: nowMs(), turns: 0 };
  pool.push(entry);
  bySession.set(sessionId, npcId);
  return entry;
}
async function reapIfNeeded(cap) {
  while (pool.length >= cap && pool.length > 0) {
    let oldestIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].lastActiveMs < pool[oldestIdx].lastActiveMs) oldestIdx = i;
    }
    const [victim] = pool.splice(oldestIdx, 1);
    bySession.delete(victim.sessionId);
    try {
      await host.agent.reap(victim.sessionId);
    } catch {
    }
  }
}
function resolveTargets(text, cast) {
  const at = text.match(/^@(\S+)\s+([\s\S]*)$/);
  if (at && cast.includes(at[1])) return { targets: [at[1]], line: at[2] };
  return { targets: cast.slice(), line: text };
}
async function runNpcTurn(entry, line, s) {
  entry.turns += 1;
  entry.lastActiveMs = nowMs();
  const sent = applyReminder(line, entry.turns, s.reminderEvery, entry.npcId);
  const { ticket } = await host.agent.send(entry.sessionId, sent);
  for (let i = 0; i < 600; i++) {
    const r = await host.agent.poll(ticket);
    if (r.done) return r.reply ?? "";
  }
  return "";
}
function pushMsg(pane, type, content) {
  pane.msgSeq += 1;
  pane.outbox.push({ id: `${pane.paneId}-${pane.msgSeq}`, type, content });
}
async function pump(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const s = loadSettings();
  while (pane.inbox.length) {
    const text = pane.inbox.shift();
    pushMsg(pane, "user", text);
    const { targets, line } = resolveTargets(text, s.cast);
    for (const npcId of targets) {
      const entry = await ensureNpc(npcId, s);
      const reply = await runNpcTurn(entry, line, s);
      pushMsg(pane, "assistant", `${npcId}: ${reply}`);
    }
  }
}
var plugin = {
  // chatBackend: one session == one chat pane.
  openSession(ctx) {
    const sessionId = `npc-pane-${ctx.paneId}`;
    panes.set(sessionId, { paneId: sessionId, inbox: [], outbox: [], msgSeq: 0 });
    return { sessionId };
  },
  // Sync per contract: enqueue the player's line; the host's pump processes it.
  sendMessage(sessionId, text) {
    const pane = panes.get(sessionId);
    if (pane) pane.inbox.push(text);
  },
  // Sync per contract: drain the transcript from the client cursor. The cursor
  // is the count of messages already delivered (stable, client-mergeable — F2).
  poll(sessionId, cursor) {
    const pane = panes.get(sessionId);
    if (!pane) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = cursor ? parseInt(cursor, 10) || 0 : 0;
    const messages = pane.outbox.slice(from);
    return { messages, cursor: String(pane.outbox.length), done: pane.inbox.length === 0 };
  },
  closeSession(sessionId) {
    panes.delete(sessionId);
  },
  listModels() {
    return [
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5 (fast NPCs)" },
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8 (lead roles)" }
    ];
  },
  // The async work the host drives (poll-pump). Exposed so the mock host_stub
  // can advance a turn without the real daemon loop.
  pump(paneId) {
    return pump(paneId);
  },
  // The inverse seam: a spawned NPC agent ran `codeterm plugin codeterm-npc <verb>`.
  onAgentCommand(ctx) {
    const npcId = bySession.get(ctx.sessionId);
    if (!npcId) return { error: `unknown session ${ctx.sessionId}` };
    const verb = ctx.verb;
    const arg = ctx.args.join(" ");
    switch (verb) {
      case "say": {
        world.log.push(`say ${npcId}: ${arg}`);
        return { result: `say|${npcId}|${arg}` };
      }
      case "move": {
        world.locations[npcId] = arg;
        world.log.push(`move ${npcId} \u2192 ${arg}`);
        return { result: `${npcId} moved to ${arg}` };
      }
      case "emote": {
        world.log.push(`emote ${npcId}: ${arg}`);
        return { result: `emote|${npcId}|${arg}` };
      }
      case "look": {
        const here = world.locations[npcId] ?? "unknown";
        const others = Object.entries(world.locations).filter(([id, loc]) => id !== npcId && loc === here).map(([id]) => id);
        return {
          result: `${npcId} is at ${here}. Also here: ${others.length ? others.join(", ") : "no one"}.`
        };
      }
      default:
        return { error: `unknown verb ${ctx.verb}` };
    }
  },
  // ── test-only hooks (stripped of meaning at runtime; exercised by plugin.test.cjs) ──
  __test_buildSpawnTask: buildSpawnTask,
  __test_shouldRemind: shouldRemind,
  __test_applyReminder: applyReminder,
  __test_world: () => world,
  __test_registerSession: (sessionId, npcId) => {
    bySession.set(sessionId, npcId);
  },
  __test_reset: () => {
    workspaceId = null;
    pool = [];
    bySession.clear();
    panes.clear();
    world = { locations: {}, log: [] };
  }
};
var plugin_default = plugin;
