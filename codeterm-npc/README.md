# Dread NPCs (`codeterm-npc`)

A CodeTerm `chatBackend` plugin that turns one chat pane into a **multi-NPC
acting stage**. It owns its environment — a workspace plus a small LRU pool of
long-lived, in-character agent sessions (one per NPC) — routes the player's line
to the addressed NPC(s), injects a stay-in-character reminder on a per-NPC turn
cadence, and exposes `say`/`look`/`move`/`emote` verbs the NPC agents call back
through `onAgentCommand` to act on the game world.

This proves the **agent-driven-environment** pattern (Track F of the plugins
rethink) with the game **mocked**:

- own workspace + a team of keyed agent sessions (`host.workspace`/`host.agent`),
- agent-callable plugin verbs (`onAgentCommand`),
- stat-driven, in-character reminders.

## Build & test

```
npm install                 # links @codeterm/plugin-sdk (file: in dev)
npm run build               # esbuild src/plugin.ts → plugin.js (QuickJS CJS)
npm test                    # build + plugin.test.cjs (pure-logic oracle)
npm run typecheck           # tsc --noEmit
npm run demo                # scripted multi-NPC scene via the host stub
```

## Mock-first

The plugin is authored against `@codeterm/plugin-sdk` types only. Until the host
capabilities (`chatBackend`, `host.agent`, `onAgentCommand`) are merged, it runs
against a thin host stand-in — see [`../mock_game/`](../mock_game). The plugin
code is unchanged between the mock and real-daemon integration.

See [`AGENT.md`](AGENT.md) for the agent-facing setup/verb reference and
[`settings.schema.json`](settings.schema.json) for the settings (secret fields
marked).
