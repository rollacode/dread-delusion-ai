// host_stub.mjs — a thin stand-in for the CodeTerm host so the codeterm-npc
// chatBackend plugin runs WITHOUT the real daemon. (Track F, mock-first.)
//
// It implements just the slice of the `host` global the plugin touches
// (settingsJson, readFile, workspace.ensure, agent.spawn/get/resume/send/poll/
// reap) and feeds the agents SCRIPTED in-character replies — so the multi-NPC
// acting chat is demonstrable today. The job-id/poll bridge (host.agent.send →
// ticket, host.agent.poll → reply) is modelled faithfully; at integration this
// whole file is replaced by the real daemon and the plugin is unchanged.
//
//   node host_stub.mjs demo            # scripted multi-NPC scene → stdout
//   node host_stub.mjs serve           # line-delimited JSON bridge (for mock_game)
//
// serve protocol (one JSON object per line, stdin → stdout):
//   {"cmd":"send","text":"..."}  → {"messages":[{speaker,text}],"world":{...},"sent":{npc:textSentToAgent}}
//   {"cmd":"world"}              → {"world":{...}}

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const PLUGIN = resolve(repo, "codeterm-npc/plugin.js");
const SCRIPTS = resolve(repo, "npc_scripts");

// ── scripted NPC behaviour (stands in for a real LLM agent turn) ──
// Each NPC has a ring of in-character lines; some turns also fire an action the
// agent would take, which we replay through the plugin's onAgentCommand seam.
const SCRIPT = {
  npc_morozov: {
    lines: [
      "Инквизиция не платит за вопросы. Говори по делу.",
      "Я видела достаточно, чтобы не верить на слово.",
      "<<...>> Записано. Это всё?",
    ],
    actions: [null, { verb: "emote", args: ["скрещивает руки"] }, null],
  },
  npc_xenia: {
    lines: [
      "Заходи, дорогой, чай ещё горячий. Холода-то какие.",
      "Слыхала, граница закрыта. Дурные времена, дорогой.",
      "Посиди, погрейся. Стены тут слушают, говори тише.",
    ],
    actions: [{ verb: "move", args: ["чайная"] }, null, null],
  },
  npc_culwich: {
    lines: [
      "Этот скромный весовщик уже видел твои глифы, странник.",
      "Устав Союза не знает исключений. Почти.",
      "Прошлое не лжёт. Весы тем более.",
    ],
    actions: [null, { verb: "move", args: ["весовая"] }, null],
  },
};

function scriptFor(npcId) {
  return SCRIPT[npcId] || { lines: [`(${npcId} молчит)`], actions: [null] };
}

// ── host implementation ──

function makeHost(settings) {
  const settingsJson = JSON.stringify(settings);
  let wsSeq = 0;
  let sessionSeq = 0;
  const keyToSession = new Map(); // workspace+key → sessionId
  const sessionMeta = new Map(); // sessionId → { npcId, turn }
  const tickets = new Map(); // ticket → reply text
  let ticketSeq = 0;
  // Observability: every text actually sent to an agent (to SHOW the reminder).
  const sent = [];

  const host = {
    platform: () => process.platform,
    homeDir: () => process.env.HOME ?? null,
    expandHome: (p) => p,
    envGet: (n) => process.env[n] ?? null,
    unixNow: () => Math.floor(Date.now() / 1000),
    unixNowMs: () => Date.now(),
    md5: (s) => s,
    fileExists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: () => true,
    removeFile: () => true,
    makeDirs: () => true,
    readDirJson: () => null,
    walkDirJson: () => null,
    writeTempFile: () => null,
    sqliteQueryAllJson: () => null,
    shellQuote: (s) => s,
    shellQuoteFor: (s) => s,
    log: (_lvl, _msg) => {},
    settingsJson: () => settingsJson,
    exec: () => JSON.stringify({ error: "no subprocess in stub" }),
    fetch: () => JSON.stringify({ error: "no network in stub" }),
    secretGet: () => null,
    secretSet: () => true,
    secretDelete: () => true,
    manifestJson: () => null,
    manifest: () => ({}),
    fs: {},
    shell: {},
    path: {},
    // Item 6: host.worker / host.agent are SYNC per step (job-id/poll). The stub
    // mirrors that — methods return values directly, not Promises — so the
    // plugin's synchronous pump consumes them the same way it will on the real
    // daemon. The stub's agent replies resolve immediately (one pump per turn).
    worker: {
      start() {
        return { jobId: "noop" };
      },
      poll() {
        return { done: true };
      },
    },
    workspace: {
      ensure() {
        return { workspaceId: `ws-${++wsSeq}` };
      },
      panes() {
        return [];
      },
    },
    agent: {
      spawn(_ws, opts) {
        const sessionId = `sess-${++sessionSeq}`;
        sessionMeta.set(sessionId, { npcId: opts.key ?? sessionId, turn: 0 });
        if (opts.key) keyToSession.set(opts.key, sessionId);
        return { sessionId };
      },
      resume(_ws, sessionId) {
        return sessionMeta.has(sessionId) ? { sessionId } : null;
      },
      get(_ws, key) {
        const sid = keyToSession.get(key);
        return sid ? { sessionId: sid } : null;
      },
      send(sessionId, text) {
        const meta = sessionMeta.get(sessionId) ?? { npcId: sessionId, turn: 0 };
        meta.turn += 1;
        sessionMeta.set(sessionId, meta);
        const script = scriptFor(meta.npcId);
        const idx = (meta.turn - 1) % script.lines.length;
        sent.push({ npcId: meta.npcId, text });
        const ticket = `tk-${++ticketSeq}`;
        tickets.set(ticket, { reply: script.lines[idx], npcId: meta.npcId, sessionId, idx });
        return { ticket };
      },
      poll(ticket) {
        const t = tickets.get(ticket);
        if (!t) return { done: true, reply: "" };
        tickets.delete(ticket);
        return { done: true, reply: t.reply };
      },
      reap() {},
    },
    mem: {
      search() {
        return { hits: [] };
      },
    },
  };

  return { host, observe: { sent, sessionMeta, scriptFor } };
}

// ── load the real plugin against the stub host ──

function loadPlugin(settings) {
  if (!existsSync(PLUGIN)) {
    throw new Error(`plugin not built: ${PLUGIN} (run \`npm run build\`)`);
  }
  const { host, observe } = makeHost(settings);
  // Load the CJS plugin.js the way the real QuickJS loader does: run it in a
  // context that exposes `module`/`exports` and the `host` global, then read
  // module.exports.default. Avoids the ESM/CJS clash under "type":"module".
  const src = readFileSync(PLUGIN, "utf8");
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    host,
    Map,
    Set,
    JSON,
    Object,
    Array,
    Promise,
    parseInt,
    String,
    Number,
    Boolean,
    Error,
    Date,
    Math,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const plugin = moduleObj.exports.default;
  return { plugin, observe };
}

// After each NPC reply, replay any scripted action through the inverse seam, so
// move/emote actually mutate the plugin's world (proves onAgentCommand).
function replayActions(plugin, observe, npcId, replyIdx) {
  const sid = observe.sessionMeta && [...observe.sessionMeta.entries()].find(
    ([, m]) => m.npcId === npcId,
  );
  const sessionId = sid ? sid[0] : null;
  const script = observe.scriptFor(npcId);
  const action = script.actions ? script.actions[replyIdx % script.actions.length] : null;
  if (!action || !sessionId) return null;
  const out = plugin.onAgentCommand({ sessionId, verb: action.verb, args: action.args });
  return { action, out };
}

function defaultSettings() {
  return {
    scene: "Феррополис. Зима затянулась. Граница с Хэллоуширом закрыта.",
    reminderEvery: 3,
    gameFolder: resolve(SCRIPTS, ".."),
    maxSessions: 5,
    defaultModel: "claude-haiku-4-5-20251001",
    cast: ["npc_morozov", "npc_xenia", "npc_culwich"],
  };
}

// One turn: push the player line, pump, drain new messages, replay actions.
async function runTurn(plugin, observe, sessionId, text, cursorRef) {
  plugin.sendMessage(sessionId, text);
  await plugin.pump(sessionId);
  const polled = plugin.poll(sessionId, String(cursorRef.cursor));
  cursorRef.cursor = parseInt(polled.cursor ?? "0", 10);
  const out = [];
  for (const m of polled.messages) {
    if (m.type === "assistant") {
      const sep = m.content.indexOf(": ");
      const npcId = sep > 0 ? m.content.slice(0, sep) : "?";
      const reply = sep > 0 ? m.content.slice(sep + 2) : m.content;
      const script = observe.scriptFor(npcId);
      const meta = [...observe.sessionMeta.values()].find((mm) => mm.npcId === npcId);
      const replyIdx = meta ? (meta.turn - 1) % script.lines.length : 0;
      const acted = replayActions(plugin, observe, npcId, replyIdx);
      out.push({ kind: "npc", npcId, text: reply, action: acted ? acted.out : null });
    } else if (m.type === "user") {
      out.push({ kind: "player", text: m.content });
    }
  }
  return out;
}

async function demo() {
  const settings = defaultSettings();
  const { plugin, observe } = loadPlugin(settings);
  const { sessionId } = plugin.openSession({ paneId: "demo", config: {} });
  const cursorRef = { cursor: 0 };

  const lines = [
    "Здравствуйте. Я ищу пропавшего человека.",
    "@npc_morozov вы видели женщину в красном плаще?",
    "А вы что скажете?",
    "Спасибо. Я ещё вернусь.",
  ];

  console.log("=== Dread Delusion — mock multi-NPC scene ===");
  console.log(`scene: ${settings.scene}`);
  console.log(`cast: ${settings.cast.join(", ")}   reminderEvery=${settings.reminderEvery}\n`);

  for (const line of lines) {
    console.log(`PLAYER › ${line}`);
    const turn = await runTurn(plugin, observe, sessionId, line, cursorRef);
    for (const ev of turn) {
      if (ev.kind === "npc") {
        console.log(`  ${ev.npcId} » ${ev.text}`);
        if (ev.action && ev.action.result) console.log(`     ↳ action: ${ev.action.result}`);
      }
    }
    console.log("");
  }

  console.log("=== mock world state ===");
  console.log(JSON.stringify(plugin.__test_world(), null, 2));

  const reminders = observe.sent.filter((s) => s.text.includes("Director's note"));
  console.log(`\n=== reminders injected (every ${settings.reminderEvery} NPC turns): ${reminders.length} ===`);
  for (const r of reminders) console.log(`  → ${r.npcId} got a stay-in-character reminder`);
}

async function serve() {
  const settings = defaultSettings();
  const { plugin, observe } = loadPlugin(settings);
  const { sessionId } = plugin.openSession({ paneId: "serve", config: {} });
  const cursorRef = { cursor: 0 };
  const rl = createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ error: "bad json" }) + "\n");
      continue;
    }
    if (msg.cmd === "send") {
      const turn = await runTurn(plugin, observe, sessionId, msg.text ?? "", cursorRef);
      const npcs = turn.filter((e) => e.kind === "npc");
      process.stdout.write(
        JSON.stringify({
          messages: npcs.map((e) => ({ speaker: e.npcId, text: e.text, action: e.action })),
          world: plugin.__test_world(),
          sent: observe.sent.slice(),
        }) + "\n",
      );
    } else if (msg.cmd === "world") {
      process.stdout.write(JSON.stringify({ world: plugin.__test_world() }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ error: "unknown cmd" }) + "\n");
    }
  }
}

const mode = process.argv[2] ?? "demo";
if (mode === "demo") demo();
else if (mode === "serve") serve();
else {
  console.error("usage: node host_stub.mjs [demo|serve]");
  process.exit(1);
}
