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
    cast: parseCast(raw.cast),
  };
}

// `cast` may arrive as a YAML/JSON array OR — as the config.yaml surface writes
// it — a single comma-separated string ("npc_morozov, npc_xenia"). Accept both
// so a configured cast is honored instead of silently falling back to defaults.
function parseCast(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const ids = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return ids.length ? ids : DEFAULTS.cast;
  }
  if (typeof raw === "string") {
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length ? ids : DEFAULTS.cast;
  }
  return DEFAULTS.cast;
}

// ── pure helpers (the unit-test oracle) ──

const VERBS = ["say", "look", "move", "emote"] as const;
type Verb = (typeof VERBS)[number];

// The spawn task is how an NPC agent learns WHO it is and WHAT it can do — no
// host-side prompt injection (spec: CodeTerm bakes nothing into prompts). The
// persona comes from npc_scripts/<id>.md; the verbs are taught as CLI calls the
// agent can make, which route back to this plugin via onAgentCommand.
//
// CRITICAL (the designed environment pattern): the agent ACTS through plugin
// verbs. An NPC is a one-shot agent turn — its raw transcript text is NOT heard
// by the player. To speak, it MUST run `codeterm plugin codeterm-npc say
// "<line>"`; the say verb routes through onAgentCommand → the pane outbox → the
// chat transcript. Prose typed without `say` is dropped, which is exactly the
// "(agent stopped) without speaking" gap this prompt closes.
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
    "You act on the world ONLY by running these commands (they reach the game):",
    ...verbs.map((v) =>
      v === "say"
        ? `  codeterm plugin codeterm-npc say "<your spoken line>"`
        : v === "move"
          ? `  codeterm plugin codeterm-npc move "<location>"`
          : v === "emote"
            ? `  codeterm plugin codeterm-npc emote "<gesture>"`
            : `  codeterm plugin codeterm-npc look`,
    ),
    "",
    "To SPEAK you MUST run the `say` command — text you merely type is NOT heard",
    "by the player and the turn is lost. Deliver your reply as a single `say`",
    "call (1–3 short sentences, in your own voice). Optionally precede or follow",
    "it with a `move`/`emote` action. Then end your turn.",
  );
  return lines.join("\n");
}

// The spawn turn only PRIMES the session: it establishes the persona but must
// not speak or act, because it has no player line yet and its callbacks route
// under the spawn session id (not a live pane) — they'd be dropped anyway. The
// real reply is the first `send` turn, which carries the full task + the line.
// Keeping the prime silent avoids a one-shot agent "acting into the void" and
// racing the send turn on first contact.
function buildPrimeTask(npcId: string, persona: string, scene?: string): string {
  const lines = [
    persona.trim(),
    "",
    `You are the character "${npcId}". Stay in character.`,
  ];
  if (scene && scene.trim()) lines.push("", `Scene: ${scene.trim()}`);
  lines.push(
    "",
    "Do not speak or act yet — the player has not addressed you. Reply with one",
    "short word to acknowledge you are ready, then end your turn. Your acting",
    "instructions and the player's line arrive in the next message.",
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
  // The persona + verb instructions. A fresh `host.agent.send` turn cannot rely
  // on the spawn turn's context being resumed on first contact (the provider
  // session isn't captured yet), so the first turn carries this verbatim — that
  // is what keeps the responding agent in character and aware it must `say`.
  spawnTask: string;
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
// `said` flips true once the agent delivered its line through the `say` verb
// (onAgentCommand → outbox); the harvest then skips the raw reply so we don't
// double-post (or surface a "(agent stopped)" placeholder over the spoken line).
interface PendingTurn {
  npcId: string;
  ticket: string;
  said: boolean;
}

// Module-level state: the QuickJS VM is a per-plugin singleton, so this is the
// plugin's whole runtime memory.
let workspaceId: string | null = null;
let pool: PoolEntry[] = [];
const bySession = new Map<string, string>(); // agent sessionId / turn ticket → npc_id
const turnPane = new Map<string, string>(); // turn ticket → owning chat paneId
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

  // The persona + verb instructions, built once and kept on the entry so the
  // first turn can carry it verbatim (resume can't guarantee context yet).
  const persona = readPersona(npcId, s.gameFolder);
  const spawnTask = buildSpawnTask(npcId, persona, { scene: s.scene, commands: VERBS });

  // Re-attach a stored session for this key if the host remembers one (R3),
  // else spawn a fresh one with the persona as its task.
  let sessionId: string | null = null;
  const found = host.agent.get(workspaceId, npcId);
  if (found) {
    const resumed = host.agent.resume(workspaceId, found.sessionId);
    sessionId = resumed ? resumed.sessionId : null;
  }
  if (sessionId == null) {
    // Spawn with a silent prime; the full persona+verb task rides the first send.
    const spawned = host.agent.spawn(workspaceId, {
      backend: { model: s.defaultModel },
      task: buildPrimeTask(npcId, persona, s.scene),
      key: npcId,
      commands: VERBS.slice(),
    });
    sessionId = spawned.sessionId;
  }

  reapIfNeeded(s.maxSessions);

  const entry: PoolEntry = { npcId, sessionId, lastActiveMs: nowMs(), turns: 0, spawnTask };
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
  let sent = applyReminder(line, entry.turns, s.reminderEvery, entry.npcId);
  // First contact: carry the persona + verb instructions, since the resumed
  // provider session isn't established yet and the bare line alone would reach
  // a context-free agent (out of character, unaware it must `say`).
  if (entry.turns === 1) {
    sent = `${entry.spawnTask}\n\n---\nThe player says to you:\n${sent}`;
  }
  const { ticket } = host.agent.send(entry.sessionId, sent);
  return ticket;
}

function pushMsg(pane: PaneSession, type: string, content: string): void {
  pane.msgSeq += 1;
  pane.outbox.push({ id: `${pane.paneId}-${pane.msgSeq}`, type, content });
}

// Resolve the pane that owns an in-flight turn ticket, so a verb callback knows
// which transcript to speak into. Null for a ticket with no live pane (e.g. the
// pure-unit onAgentCommand test, which never opened a pane).
function paneForTicket(ticket: string): PaneSession | undefined {
  const paneId = turnPane.get(ticket);
  return paneId ? panes.get(paneId) : undefined;
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

  // Phase 1 — kick sends for new player lines. The turn runs under a fresh
  // ticket worker id, so map that ticket → npc_id and → this pane: the agent's
  // own `codeterm plugin codeterm-npc say` callback arrives under the ticket as
  // ctx.sessionId, and onAgentCommand uses these maps to resolve the NPC and
  // the outbox to speak into.
  while (pane.inbox.length) {
    const text = pane.inbox.shift() as string;
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

  // Phase 2 — harvest any replies that have completed since the last tick.
  const stillPending: PendingTurn[] = [];
  for (const p of pane.pending) {
    const r = host.agent.poll(p.ticket);
    if (r.done) {
      // The spoken line normally arrives live via the `say` verb (p.said). If
      // the agent never spoke, fall back to its captured final line — but drop
      // bare "(agent stopped)"-style placeholders rather than voice them.
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
      stillPending.push(p); // not done yet — check again next tick
    }
  }
  pane.pending = stillPending;
}

// Drop the per-turn ticket maps once the turn is terminal. Only the ticket
// entries are removed — the NPC's long-lived spawn session mapping stays.
function clearTurn(ticket: string): void {
  bySession.delete(ticket);
  turnPane.delete(ticket);
}

// A one-shot agent that exits without speaking yields a host placeholder, not a
// line — never voice those as the NPC's reply.
function isPlaceholderReply(reply: string): boolean {
  return /^\((?:claude|codex|agent|opencode)[^)]*\)$/i.test(reply.trim());
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
  // This is how an NPC ACTS. `say` is also how it SPEAKS: the line is pushed to
  // the owning pane's outbox so it surfaces as the chat reply (live, mid-turn).
  onAgentCommand(ctx: AgentCommandCtx): { result: string } | { error: string } {
    const npcId = bySession.get(ctx.sessionId);
    if (!npcId) return { error: `unknown session ${ctx.sessionId}` };
    const verb = ctx.verb as Verb;
    const arg = ctx.args.join(" ");
    const pane = paneForTicket(ctx.sessionId);
    switch (verb) {
      case "say": {
        // The NPC's spoken line. Surface it in the chat transcript (the headline
        // path: say → onAgentCommand → outbox → chat), and mark the turn spoken
        // so the harvest won't double-post. Also log to the (mock) game world.
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
        world.log.push(`move ${npcId} → ${arg}`);
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
  __test_parseCast: parseCast,
  __test_world: (): World => world,
  __test_registerSession: (sessionId: string, npcId: string): void => {
    bySession.set(sessionId, npcId);
  },
  __test_reset: (): void => {
    workspaceId = null;
    pool = [];
    bySession.clear();
    turnPane.clear();
    panes.clear();
    world = { locations: {}, log: [] };
  },
};

export default plugin;
