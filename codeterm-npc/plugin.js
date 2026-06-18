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
  // Provider-relative model id (the claude provider exposes short ids:
  // haiku/sonnet/opus). A full id like "claude-haiku-4-5-..." is rejected by
  // the spawn-time model validation, so the NPC agent never starts.
  defaultModel: "haiku",
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
    cast: parseCast(raw.cast)
  };
}
function parseCast(raw) {
  if (Array.isArray(raw)) {
    const ids = raw.filter((x) => typeof x === "string" && x.trim().length > 0);
    return ids.length ? ids : DEFAULTS.cast;
  }
  if (typeof raw === "string") {
    const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return ids.length ? ids : DEFAULTS.cast;
  }
  return DEFAULTS.cast;
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
    "You act on the world ONLY by running these commands (they reach the game):",
    ...verbs.map(
      (v) => v === "say" ? `  codeterm plugin codeterm-npc say "<your spoken line>"` : v === "move" ? `  codeterm plugin codeterm-npc move "<location>"` : v === "emote" ? `  codeterm plugin codeterm-npc emote "<gesture>"` : `  codeterm plugin codeterm-npc look`
    ),
    "",
    "To SPEAK you MUST run the `say` command \u2014 text you merely type is NOT heard",
    "by the player and the turn is lost. Deliver your reply as a single `say`",
    "call (1\u20133 short sentences, in your own voice). Optionally precede or follow",
    "it with a `move`/`emote` action. Then end your turn."
  );
  return lines.join("\n");
}
function buildPrimeTask(npcId, persona, scene) {
  const lines = [
    persona.trim(),
    "",
    `You are the character "${npcId}". Stay in character.`
  ];
  if (scene && scene.trim()) lines.push("", `Scene: ${scene.trim()}`);
  lines.push(
    "",
    "Do not speak or act yet \u2014 the player has not addressed you. Reply with one",
    "short word to acknowledge you are ready, then end your turn. Your acting",
    "instructions and the player's line arrive in the next message."
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
var turnPane = /* @__PURE__ */ new Map();
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
function ensureNpc(npcId, s) {
  const existing = pool.find((e) => e.npcId === npcId);
  if (existing) {
    existing.lastActiveMs = nowMs();
    return existing;
  }
  if (workspaceId == null) {
    const ws = host.workspace.ensure({ name: "dread-npcs", externalRoot: s.gameFolder });
    workspaceId = ws.workspaceId;
  }
  const persona = readPersona(npcId, s.gameFolder);
  const spawnTask = buildSpawnTask(npcId, persona, { scene: s.scene, commands: VERBS });
  let sessionId = null;
  const found = host.agent.get(workspaceId, npcId);
  if (found) {
    const resumed = host.agent.resume(workspaceId, found.sessionId);
    sessionId = resumed ? resumed.sessionId : null;
  }
  if (sessionId == null) {
    const spawned = host.agent.spawn(workspaceId, {
      backend: { model: s.defaultModel },
      task: buildPrimeTask(npcId, persona, s.scene),
      key: npcId,
      commands: VERBS.slice()
    });
    sessionId = spawned.sessionId;
  }
  reapIfNeeded(s.maxSessions);
  const entry = { npcId, sessionId, lastActiveMs: nowMs(), turns: 0, spawnTask };
  pool.push(entry);
  bySession.set(sessionId, npcId);
  return entry;
}
function reapIfNeeded(cap) {
  while (pool.length >= cap && pool.length > 0) {
    let oldestIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].lastActiveMs < pool[oldestIdx].lastActiveMs) oldestIdx = i;
    }
    const [victim] = pool.splice(oldestIdx, 1);
    bySession.delete(victim.sessionId);
    try {
      host.agent.reap(victim.sessionId);
    } catch {
    }
  }
}
function resolveTargets(text, cast) {
  const at = text.match(/^@(\S+)\s+([\s\S]*)$/);
  if (at && cast.includes(at[1])) return { targets: [at[1]], line: at[2] };
  return { targets: cast.slice(), line: text };
}
function kickNpcTurn(entry, line, s) {
  entry.turns += 1;
  entry.lastActiveMs = nowMs();
  let sent = applyReminder(line, entry.turns, s.reminderEvery, entry.npcId);
  if (entry.turns === 1) {
    sent = `${entry.spawnTask}

---
The player says to you:
${sent}`;
  }
  const { ticket } = host.agent.send(entry.sessionId, sent);
  return ticket;
}
function pushMsg(pane, type, content) {
  pane.msgSeq += 1;
  pane.outbox.push({ id: `${pane.paneId}-${pane.msgSeq}`, type, content });
}
function paneForTicket(ticket) {
  const paneId = turnPane.get(ticket);
  return paneId ? panes.get(paneId) : void 0;
}
function pump(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const s = loadSettings();
  while (pane.inbox.length) {
    const text = pane.inbox.shift();
    pushMsg(pane, "user", text);
    const { targets, line } = resolveTargets(text, s.cast);
    for (const npcId of targets) {
      const entry = ensureNpc(npcId, s);
      const ticket = kickNpcTurn(entry, line, s);
      bySession.set(ticket, npcId);
      turnPane.set(ticket, pane.paneId);
      pane.pending.push({ npcId, ticket, said: false });
    }
  }
  const stillPending = [];
  for (const p of pane.pending) {
    const r = host.agent.poll(p.ticket);
    if (r.done) {
      if (!p.said) {
        const reply = (r.reply ?? "").trim();
        if (reply && !isPlaceholderReply(reply)) {
          pushMsg(pane, "assistant", `${p.npcId}: ${reply}`);
        }
      }
      clearTurn(p.ticket);
    } else if (r.error) {
      if (!p.said) pushMsg(pane, "assistant", `${p.npcId}: [error: ${r.error}]`);
      clearTurn(p.ticket);
    } else {
      stillPending.push(p);
    }
  }
  pane.pending = stillPending;
}
function clearTurn(ticket) {
  bySession.delete(ticket);
  turnPane.delete(ticket);
}
function isPlaceholderReply(reply) {
  return /^\((?:claude|codex|agent|opencode)[^)]*\)$/i.test(reply.trim());
}
var plugin = {
  // chatBackend: one session == one chat pane.
  openSession(ctx) {
    const sessionId = `npc-pane-${ctx.paneId}`;
    panes.set(sessionId, { paneId: sessionId, inbox: [], outbox: [], msgSeq: 0, pending: [] });
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
    const done = pane.inbox.length === 0 && pane.pending.length === 0;
    return { messages, cursor: String(pane.outbox.length), done };
  },
  closeSession(sessionId) {
    panes.delete(sessionId);
  },
  listModels() {
    return [
      { id: "haiku", displayName: "Claude Haiku (fast NPCs)" },
      { id: "sonnet", displayName: "Claude Sonnet (balanced)" },
      { id: "opus", displayName: "Claude Opus (lead roles)" }
    ];
  },
  // The host calls this each poll-loop tick to advance async NPC work (Item 6).
  // Synchronous + non-blocking; the mock host_stub calls it once per turn too.
  pump(paneId) {
    pump(paneId);
  },
  // The inverse seam: a spawned NPC agent ran `codeterm plugin codeterm-npc <verb>`.
  // This is how an NPC ACTS. `say` is also how it SPEAKS: the line is pushed to
  // the owning pane's outbox so it surfaces as the chat reply (live, mid-turn).
  onAgentCommand(ctx) {
    const npcId = bySession.get(ctx.sessionId);
    if (!npcId) return { error: `unknown session ${ctx.sessionId}` };
    const verb = ctx.verb;
    const arg = ctx.args.join(" ");
    const pane = paneForTicket(ctx.sessionId);
    switch (verb) {
      case "say": {
        if (pane && arg) {
          pushMsg(pane, "assistant", `${npcId}: ${arg}`);
          const turn = pane.pending.find((p) => p.ticket === ctx.sessionId);
          if (turn) turn.said = true;
        }
        world.log.push(`say ${npcId}: ${arg}`);
        return { result: `say|${npcId}|${arg}` };
      }
      case "move": {
        world.locations[npcId] = arg;
        world.log.push(`move ${npcId} \u2192 ${arg}`);
        if (pane) pushMsg(pane, "assistant", `*${npcId} moves to ${arg}*`);
        return { result: `${npcId} moved to ${arg}` };
      }
      case "emote": {
        world.log.push(`emote ${npcId}: ${arg}`);
        if (pane) pushMsg(pane, "assistant", `*${npcId} ${arg}*`);
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
  __test_parseCast: parseCast,
  __test_world: () => world,
  __test_registerSession: (sessionId, npcId) => {
    bySession.set(sessionId, npcId);
  },
  __test_reset: () => {
    workspaceId = null;
    pool = [];
    bySession.clear();
    turnPane.clear();
    panes.clear();
    world = { locations: {}, log: [] };
  }
};
var plugin_default = plugin;
