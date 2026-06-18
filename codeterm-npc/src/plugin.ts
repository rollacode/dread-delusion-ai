// codeterm-npc — a chatBackend plugin that turns one CodeTerm chat pane into a
// multi-NPC acting stage for Dread Delusion. (Track F, mock-first.)
//
// The pattern it proves: a plugin OWNS its environment. It ensures its own
// workspace, spawns + reaps a small LRU pool of long-lived agent sessions (one
// per NPC, keyed by npc_id — R2), routes the player's line to the addressed
// NPC(s) via the job-id/poll host.agent bridge (F4), injects a stay-in-character
// reminder on a per-NPC turn cadence, and exposes verbs (`say`/`look`/`move`/
// `emote`) that a spawned NPC agent calls back through `onAgentCommand` to act
// on the (mock) game world.
//
// Authored against @codeterm/plugin-sdk TYPES only. The whole surface is SYNC:
// openSession/sendMessage/poll/closeSession AND the `host.agent.*` job-id/poll
// binds (Item 6 — job-id/poll is sync per step). The async NPC work is driven by
// the host calling `pump()` on EACH poll-loop tick: pump kicks off `host.agent.send`
// for new player lines, then non-blockingly harvests any tickets that have since
// completed (NEVER block-waits for a turn — that would stall the VM). On the real
// daemon the host's chatBackend poll loop calls pump each tick; the mock host_stub
// calls it once per turn (its agent replies resolve immediately).

import type {
  ChatBackend,
  AgentCommandHandler,
  AgentCommandCtx,
  NormalizedChatMessage,
  Model,
} from "@codeterm/plugin-sdk";

// ── settings (host.settingsJson → config.plugins["codeterm-npc"]) ──

interface NpcSettings {
  scene: string;
  reminderEvery: number; // inject the stay-in-character reminder every Nth NPC turn
  gameFolder: string; // workspace externalRoot + where npc_scripts/<id>.md live
  maxSessions: number; // LRU cap on live NPC agent sessions (R2)
  defaultModel: string;
  cast: string[]; // npc_ids present in the scene (addressed when no @target is given)
  // elevenLabsKey is a SECRET (see settings.schema.json) — resolved via
  // host.secretGet, never read from settingsJson. Unused by the mock; declared
  // to exercise the secret-routing path of §1.7.
}

const DEFAULTS: NpcSettings = {
  scene: "",
  reminderEvery: 4,
  gameFolder: ".",
  maxSessions: 5,
  // Provider-relative model id (the claude provider exposes short ids:
  // haiku/sonnet/opus). A full id like "claude-haiku-4-5-..." is rejected by
  // the spawn-time model validation, so the NPC agent never starts.
  defaultModel: "haiku",
  cast: ["npc_morozov", "npc_xenia", "npc_culwich"],
};

function loadSettings(): NpcSettings {
  let raw: Partial<NpcSettings> = {};
  try {
    raw = JSON.parse(host.settingsJson() || "{}");
  } catch {
    raw = {};
  }
  return {
    scene: typeof raw.scene === "string" ? raw.scene : DEFAULTS.scene,
    reminderEvery:
      typeof raw.reminderEvery === "number" ? raw.reminderEvery : DEFAULTS.reminderEvery,
    gameFolder: typeof raw.gameFolder === "string" ? raw.gameFolder : DEFAULTS.gameFolder,
    maxSessions: typeof raw.maxSessions === "number" ? raw.maxSessions : DEFAULTS.maxSessions,
    defaultModel:
      typeof raw.defaultModel === "string" ? raw.defaultModel : DEFAULTS.defaultModel,
    cast: Array.isArray(raw.cast) && raw.cast.length ? raw.cast : DEFAULTS.cast,
  };
}

// ── pure helpers (the unit-test oracle) ──

const VERBS = ["say", "look", "move", "emote"] as const;
type Verb = (typeof VERBS)[number];

// The spawn task is how an NPC agent learns WHO it is and WHAT it can do — no
// host-side prompt injection (spec: CodeTerm bakes nothing into prompts). The
// persona comes from npc_scripts/<id>.md; the verbs are taught as CLI calls the
// agent can make, which route back to this plugin via onAgentCommand.
function buildSpawnTask(
  npcId: string,
  persona: string,
  opts: { scene?: string; commands?: readonly string[] } = {},
): string {
  const verbs = (opts.commands && opts.commands.length ? opts.commands : VERBS).slice();
  const lines = [
    persona.trim(),
    "",
    `You are the character "${npcId}". Stay in character at all times.`,
  ];
  if (opts.scene && opts.scene.trim()) {
    lines.push("", `Scene: ${opts.scene.trim()}`);
  }
  lines.push(
    "",
    "You can act in the world by running these commands (they reach the game):",
    ...verbs.map((v) => `  codeterm plugin codeterm-npc ${v} <args>`),
    "",
    "Speak only as your character. Keep replies to 1–3 short sentences.",
  );
  return lines.join("\n");
}

// Per-NPC cadence: fire on turn N, 2N, 3N… never on turn 0; N<=0 disables it.
function shouldRemind(turns: number, every: number): boolean {
  if (every <= 0) return false;
  return turns > 0 && turns % every === 0;
}

function buildReminder(npcName: string): string {
  return (
    `[Director's note — you are ${npcName}. Stay fully in character: ` +
    `your own voice, your own knowledge, no narration of the system. ` +
    `Answer the line below as ${npcName} would.]`
  );
}

// Prepend the stay-in-character reminder to the text we send the NPC, but only
// on a cadence turn — keeps the agent anchored over long sessions (R6).
function applyReminder(
  text: string,
  turns: number,
  every: number,
  npcName: string,
): string {
  if (!shouldRemind(turns, every)) return text;
  return `${buildReminder(npcName)}\n\n${text}`;
}

// ── LRU pool of NPC agent sessions (R2) ──

interface PoolEntry {
  npcId: string;
  sessionId: string;
  lastActiveMs: number;
  turns: number;
}

// ── mock world state (mutated by onAgentCommand: move/look/emote) ──

interface World {
  locations: Record<string, string>; // npc_id → location
  log: string[];
}

// ── pane (chatBackend) session: the player-facing transcript buffer ──

interface PaneSession {
  paneId: string;
  inbox: string[]; // player lines awaiting NPC routing (sendMessage enqueues)
  outbox: NormalizedChatMessage[]; // NPC replies + action echoes (poll drains)
  msgSeq: number;
  pending: PendingTurn[]; // NPC turns awaiting a reply (host.agent ticket in flight)
}

// An NPC turn kicked off via host.agent.send, awaiting its reply. pump harvests
// these non-blockingly: one host.agent.poll per tick, push the reply when done.
interface PendingTurn {
  npcId: string;
  ticket: string;
}

// Module-level state: the QuickJS VM is a per-plugin singleton, so this is the
// plugin's whole runtime memory.
let workspaceId: string | null = null;
let pool: PoolEntry[] = [];
const bySession = new Map<string, string>(); // agent sessionId → npc_id
const panes = new Map<string, PaneSession>();
let world: World = { locations: {}, log: [] };

function nowMs(): number {
  try {
    return host.unixNowMs();
  } catch {
    return 0;
  }
}

function readPersona(npcId: string, gameFolder: string): string {
  // npc_scripts/<id>.md, stripped of YAML frontmatter (the agent gets prose only).
  const path = `${gameFolder}/npc_scripts/${npcId}.md`;
  let raw: string | null = null;
  try {
    raw = host.readFile(path);
  } catch {
    raw = null;
  }
  if (!raw) return `You are ${npcId}.`;
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return (fm ? raw.slice(fm[0].length) : raw).trim();
}

// get-or-spawn the keyed session for an npc, reaping the oldest idle one when
// the pool is over its cap. Sync: the host.agent.* binds are sync per step (Item 6).
function ensureNpc(npcId: string, s: NpcSettings): PoolEntry {
  const existing = pool.find((e) => e.npcId === npcId);
  if (existing) {
    existing.lastActiveMs = nowMs();
    return existing;
  }

  if (workspaceId == null) {
    const ws = host.workspace.ensure({ name: "dread-npcs", externalRoot: s.gameFolder });
    workspaceId = ws.workspaceId;
  }

  // Re-attach a stored session for this key if the host remembers one (R3),
  // else spawn a fresh one with the persona as its task.
  let sessionId: string | null = null;
  const found = host.agent.get(workspaceId, npcId);
  if (found) {
    const resumed = host.agent.resume(workspaceId, found.sessionId);
    sessionId = resumed ? resumed.sessionId : null;
  }
  if (sessionId == null) {
    const persona = readPersona(npcId, s.gameFolder);
    const task = buildSpawnTask(npcId, persona, { scene: s.scene, commands: VERBS });
    const spawned = host.agent.spawn(workspaceId, {
      backend: { model: s.defaultModel },
      task,
      key: npcId,
      commands: VERBS.slice(),
    });
    sessionId = spawned.sessionId;
  }

  reapIfNeeded(s.maxSessions);

  const entry: PoolEntry = { npcId, sessionId, lastActiveMs: nowMs(), turns: 0 };
  pool.push(entry);
  bySession.set(sessionId, npcId);
  return entry;
}

function reapIfNeeded(cap: number): void {
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
      /* best-effort */
    }
  }
}

// Which NPCs does this player line address? "@npc_xenia ..." or "name: ..."
// targets one; otherwise the whole present cast replies (the multi-NPC demo).
function resolveTargets(text: string, cast: string[]): { targets: string[]; line: string } {
  const at = text.match(/^@(\S+)\s+([\s\S]*)$/);
  if (at && cast.includes(at[1])) return { targets: [at[1]], line: at[2] };
  return { targets: cast.slice(), line: text };
}

// Kick off one NPC's turn: bump its counter, apply the cadence reminder, send
// via the ticket bridge, and return the in-flight ticket. Does NOT wait for the
// reply — pump harvests it on a later tick (non-blocking, Item 6).
function kickNpcTurn(entry: PoolEntry, line: string, s: NpcSettings): string {
  entry.turns += 1;
  entry.lastActiveMs = nowMs();
  const sent = applyReminder(line, entry.turns, s.reminderEvery, entry.npcId);
  const { ticket } = host.agent.send(entry.sessionId, sent);
  return ticket;
}

function pushMsg(pane: PaneSession, type: string, content: string): void {
  pane.msgSeq += 1;
  pane.outbox.push({ id: `${pane.paneId}-${pane.msgSeq}`, type, content });
}

// The turn-advance the host drives, called on EACH poll-loop tick (Item 6).
// SYNCHRONOUS and NON-BLOCKING — one step per call:
//   Phase 1: for each newly-arrived player line, fan out to the addressed NPCs,
//            kicking each one's host.agent.send and recording the in-flight ticket.
//   Phase 2: poll every pending ticket ONCE; a completed reply is pushed to the
//            transcript, an unfinished one is left for the next tick.
// It never block-waits for an agent turn (that would stall the whole VM); the
// reply simply lands on whichever later tick the agent finishes.
function pump(paneId: string): void {
  const pane = panes.get(paneId);
  if (!pane) return;
  const s = loadSettings();

  // Phase 1 — kick sends for new player lines.
  while (pane.inbox.length) {
    const text = pane.inbox.shift() as string;
    pushMsg(pane, "user", text);
    const { targets, line } = resolveTargets(text, s.cast);
    for (const npcId of targets) {
      const entry = ensureNpc(npcId, s);
      const ticket = kickNpcTurn(entry, line, s);
      pane.pending.push({ npcId, ticket });
    }
  }

  // Phase 2 — harvest any replies that have completed since the last tick.
  const stillPending: PendingTurn[] = [];
  for (const p of pane.pending) {
    const r = host.agent.poll(p.ticket);
    if (r.done) {
      pushMsg(pane, "assistant", `${p.npcId}: ${r.reply ?? ""}`);
    } else if (r.error) {
      pushMsg(pane, "assistant", `${p.npcId}: [error: ${r.error}]`);
    } else {
      stillPending.push(p); // not done yet — check again next tick
    }
  }
  pane.pending = stillPending;
}

// ── the plugin module ──

interface NpcPlugin extends ChatBackend, AgentCommandHandler {
  pump(paneId: string): void;
  [key: string]: unknown;
}

const plugin: NpcPlugin = {
  // chatBackend: one session == one chat pane.
  openSession(ctx: { paneId: string; config: unknown }): { sessionId: string } {
    const sessionId = `npc-pane-${ctx.paneId}`;
    panes.set(sessionId, { paneId: sessionId, inbox: [], outbox: [], msgSeq: 0, pending: [] });
    return { sessionId };
  },

  // Sync per contract: enqueue the player's line; the host's pump processes it.
  sendMessage(sessionId: string, text: string): void {
    const pane = panes.get(sessionId);
    if (pane) pane.inbox.push(text);
  },

  // Sync per contract: drain the transcript from the client cursor. The cursor
  // is the count of messages already delivered (stable, client-mergeable — F2).
  poll(
    sessionId: string,
    cursor?: string | null,
  ): { messages: NormalizedChatMessage[]; cursor: string | null; done?: boolean } {
    const pane = panes.get(sessionId);
    if (!pane) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = cursor ? parseInt(cursor, 10) || 0 : 0;
    const messages = pane.outbox.slice(from);
    // The turn is complete only when nothing is queued AND no NPC reply is still
    // in flight — so the client keeps polling while pump harvests pending tickets.
    const done = pane.inbox.length === 0 && pane.pending.length === 0;
    return { messages, cursor: String(pane.outbox.length), done };
  },

  closeSession(sessionId: string): void {
    panes.delete(sessionId);
  },

  listModels(): Model[] {
    return [
      { id: "haiku", displayName: "Claude Haiku (fast NPCs)" },
      { id: "sonnet", displayName: "Claude Sonnet (balanced)" },
      { id: "opus", displayName: "Claude Opus (lead roles)" },
    ];
  },

  // The host calls this each poll-loop tick to advance async NPC work (Item 6).
  // Synchronous + non-blocking; the mock host_stub calls it once per turn too.
  pump(paneId: string): void {
    pump(paneId);
  },

  // The inverse seam: a spawned NPC agent ran `codeterm plugin codeterm-npc <verb>`.
  onAgentCommand(ctx: AgentCommandCtx): { result: string } | { error: string } {
    const npcId = bySession.get(ctx.sessionId);
    if (!npcId) return { error: `unknown session ${ctx.sessionId}` };
    const verb = ctx.verb as Verb;
    const arg = ctx.args.join(" ");
    switch (verb) {
      case "say": {
        // Forward the NPC's spoken line to the (mock) game, pipe-delimited so the
        // harness can route it: speaker | text.
        world.log.push(`say ${npcId}: ${arg}`);
        return { result: `say|${npcId}|${arg}` };
      }
      case "move": {
        world.locations[npcId] = arg;
        world.log.push(`move ${npcId} → ${arg}`);
        return { result: `${npcId} moved to ${arg}` };
      }
      case "emote": {
        world.log.push(`emote ${npcId}: ${arg}`);
        return { result: `emote|${npcId}|${arg}` };
      }
      case "look": {
        const here = world.locations[npcId] ?? "unknown";
        const others = Object.entries(world.locations)
          .filter(([id, loc]) => id !== npcId && loc === here)
          .map(([id]) => id);
        return {
          result: `${npcId} is at ${here}. Also here: ${others.length ? others.join(", ") : "no one"}.`,
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
  __test_world: (): World => world,
  __test_registerSession: (sessionId: string, npcId: string): void => {
    bySession.set(sessionId, npcId);
  },
  __test_reset: (): void => {
    workspaceId = null;
    pool = [];
    bySession.clear();
    panes.clear();
    world = { locations: {}, log: [] };
  },
};

export default plugin;
