# codeterm-npc — agent doc

This plugin lets an agent set up and run a **multi-NPC acting chat** for Dread
Delusion. It is a `chatBackend`: one chat pane becomes a stage where a player
talks to several NPCs at once, each backed by its own long-lived agent session.

## What it does

- On `openSession` it ensures a workspace (`dread-npcs`, rooted at the configured
  game folder) and lazily spawns one agent session per NPC, keyed by `npc_id`.
- The player's line is routed to the addressed NPC(s): prefix `@npc_id` to talk to
  one; otherwise the whole present cast replies.
- It keeps a small **LRU pool** (default 5) of live NPC sessions and reaps the
  oldest idle one when over the cap.
- Every Nth turn (per NPC) it injects a **stay-in-character reminder** before the
  player's line, to keep long sessions anchored.
- NPC agents act on the world by calling back: `codeterm plugin codeterm-npc <verb> …`.

## Configuring it (no UI, no restart)

```
codeterm get plugin codeterm-npc                 # schema + current (secrets redacted) + state
codeterm plugin install codeterm-npc
codeterm plugin config codeterm-npc --json '{
  "scene": "Феррополис. Зима затянулась.",
  "gameFolder": "/path/to/dread-delusion-ai",
  "cast": "npc_morozov, npc_xenia, npc_culwich",
  "reminderEvery": 4,
  "defaultModel": "claude-haiku-4-5-20251001"
}'
```

Secret fields (`elevenLabsKey`) are prompted and routed to the plugin's secret
bucket — never written plaintext into config. See `settings.schema.json` for the
full field set and which fields are `secret`.

## Verbs an NPC agent can call

| Verb | Args | Effect |
|---|---|---|
| `say` | `<text>` | Speak a line to the game (forwarded as `say\|<npc_id>\|<text>`). |
| `move` | `<location>` | Move this NPC; updates mock world state. |
| `emote` | `<text>` | Perform a gesture (forwarded as `emote\|<npc_id>\|<text>`). |
| `look` | — | Report this NPC's location and who else is there. |

Each verb returns `{ result }` on success or `{ error }` if the calling session
isn't a known NPC or the verb is unknown.

## Settings

| Key | Secret | Meaning |
|---|---|---|
| `scene` | no | Shared setting prepended to each NPC's spawn task. |
| `gameFolder` | no | Workspace root + where `npc_scripts/<id>.md` personas live. |
| `cast` | no | Comma-separated `npc_id`s present in the scene. |
| `reminderEvery` | no | Per-NPC stay-in-character cadence (0 disables). |
| `maxSessions` | no | LRU cap on live NPC sessions. |
| `defaultModel` | no | Model tier NPC sessions spawn with. |
| `elevenLabsKey` | **yes** | ElevenLabs TTS key — secret bucket only. |

## Mock-first note

The NPC logic runs today without the real daemon via `mock_game/host_stub.mjs`
(a thin `host` stand-in feeding scripted in-character replies) and the
`mock_game/` Python chat harness. At integration the same plugin runs unchanged
against the real `host.workspace`/`host.agent`/`onAgentCommand` capabilities.
