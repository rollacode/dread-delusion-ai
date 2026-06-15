# Dread Delusion AI ↔ CodeTerm Connector — Plan

How the AI-NPC system connects to **CodeTerm** as an *external connector*, and
why CodeTerm is the runtime instead of a bespoke daemon.

> This is the consumer side of a CodeTerm feature being specced upstream.
> CodeTerm-side design (the connector/permission model, the Extensions UX, model
> tiers): **`rollacode/codeterm` branch `feat/external-connectors`** →
> `docs/plans/external-connectors.md`, tracked by the roadmap issue linked from
> that branch. This document does **not** restate the CodeTerm internals; it
> describes only what *we* build and what we depend on.

## 1. Why CodeTerm at all

The NPC system (see [`DESIGN.md`](DESIGN.md)) needs, per talking character:

- a **persistent LLM session** that survives across conversations (the NPC
  remembers the player),
- **agent-agnostic** model access (Claude / Codex / local — whatever the user
  has), with a **strength choice** per character (the Clockwork King deserves a
  strong model; a tavern drunk does not),
- **memory** keyed by `npc_id`,
- a place to **spawn, park, and reap** those sessions without bloating the
  game process or shipping our own model plumbing.

CodeTerm already *is* this: a multiplexer where agent sessions live, with
provider abstraction, persistent `mem`, per-pane session tracking, and a CLI/API
to spawn and drive agents. Re-implementing a session manager + provider
abstraction + memory inside the game would be rebuilding CodeTerm badly. So the
game becomes a **connector**: it asks CodeTerm to host the NPC agents and drives
them through a scoped grant.

There is a second, honest reason: **CodeTerm is rollacode's own project.** Using
it here is dogfooding — the NPC connector is the first real third-party consumer
of the external-connector feature, which is exactly the pressure that will shape
that feature well.

## 2. What we are (and are NOT) building

- **We build:** a small **connector client** embedded in the NPC server
  (`npc_server/`) that performs the CodeTerm handshake, holds the granted token,
  and drives CodeTerm (create workspace, spawn/resume NPC agents, write player
  input, read replies). Plus a **connector manifest** (`connector.toml`) and a
  **settings schema** so the integration shows up as a first-class card in
  CodeTerm's Extensions surface with its own config (provider, model tier per
  character class, workspace path).
- **We do NOT build:** a CodeTerm plugin that runs *inside* CodeTerm. The game is
  external; it stays external. We are a **connector**, not an in-process plugin.
  (The distinction matters: a plugin would run in CodeTerm's trust boundary; a
  connector runs in ours and gets a bounded, revocable grant.)
- **We do NOT build:** our own model/session/memory layer. That's the point of
  using CodeTerm.

## 3. How the existing `npc_server` maps onto the connector model

`npc_server/main.py` today already shells out to `codeterm` and assumes it can
spawn agents and read panes freely. The connector model formalizes that into a
*granted* relationship:

| `npc_server` action today | Capability it requires | Connector permission |
|---|---|---|
| `codeterm workspace create npc-agents` | create its workspace | `manage_workspaces` |
| `codeterm agent spawn <model> --task <npc script>` | spawn NPC agents | `spawn_agents` |
| `codeterm send "<player input>" --pane <id>` | type into NPC panes | `write_panes` / `send_input` |
| `codeterm get-output --pane <id>` | read NPC replies | `read_output` |
| `codeterm mem search "npc_session npc_id=…"` | persist/lookup sessions | (mem is read via our own pane/secret access; see §6) |

So our connector **requests exactly four capabilities**:
`manage_workspaces`, `spawn_agents`, `write_panes`, `read_output`. Nothing else —
no `admin`, no `manage_crons`, no access to panes we didn't spawn. The user sees
these four lines in the approval prompt and can withhold any of them (e.g. deny
`spawn_agents` to run the connector in a "text-only, no live agents" mode).

The refactor: replace `npc_server`'s raw `codeterm` shell-outs with calls through
the granted **connector token** (HTTP/socket), so the integration is bounded and
revocable instead of relying on ambient CLI access.

## 4. The connector manifest we ship

```toml
# connector.toml — the CodeTerm-side registration for the NPC system
[connector]
id          = "conn-dread-delusion-ai"
name        = "Dread Delusion — AI NPCs"
description = "Live LLM dialogue for Dread Delusion NPCs, hosted as CodeTerm agents."
icon        = "icon.png"
homepage    = "https://github.com/rollacode/dread-delusion-rus"
version     = "0.1.0"

[capabilities]
requested = ["manage_workspaces", "spawn_agents", "write_panes", "read_output"]

[workspace]
prefers_external_root = true     # the NPC workspace lives in the game folder
default_name          = "Dread Delusion AI"

[settings]
schema = "settings.schema.json"  # provider + per-class model tier + game path
```

We ship this as a `.cterm` bundle (curated install) **and** support the
zero-install handshake (the game's first run offers "Connect to CodeTerm"). Both
land on the same Extensions card.

## 5. Handshake from the game side

1. The NPC server (or the game's first-run helper) discovers a local CodeTerm
   daemon. If none, it tells the user: *"AI NPCs need CodeTerm — install it from
   <link>, then click Connect."* (This is the "I'm not connected yet" installer
   message.)
2. It calls CodeTerm's connect endpoint with our self-description (the
   `[connector]` + `requested` fields) and a workspace hint (the detected game
   folder).
3. CodeTerm shows the approval prompt; the user reviews the four capabilities,
   confirms the game-folder workspace path, and approves.
4. We receive the one-time scoped token, store it (in CodeTerm's secrets store
   under a connector-prefixed name, or our own config if simpler), and from then
   on drive CodeTerm with it.

If the user later removes the connector in CodeTerm's Extensions surface, our
token is revoked and the NPC server's calls 401 — the game falls back to the
static translated dialogue (the русификатор already ships that text), so the
worst case is "no live NPCs," never a broken game.

## 6. Workspace in the game folder

With `prefers_external_root`, CodeTerm parks the `npc-agents` workspace's working
directory inside the game install (next to `Dread Delusion_Data/`, or under
`windows_content/`). What we keep there:

- per-NPC session pointers (`npc_id → pane/session`), so a returning player meets
  an NPC that remembers them,
- generated TTS audio cache (see the ElevenLabs work),
- any connector-local state we don't want polluting the user's home dir.

**Game detection:** auto-detect the Steam install path (the русификcontainer build
already hardcodes `F:\SteamLibrary\...\Dread Delusion\windows_content` in
`scripts/build.py` over in the rus repo — same detection logic), with a manual
override in the connector's settings card if detection misses.

## 7. Provider / model tier per character class

We do **not** hardcode model names — models churn and CodeTerm deliberately ships
no strong/medium/weak map. Instead our settings schema lets the user pick a
**provider** and we declare a **tier preference per character class**, resolved by
CodeTerm's tier mechanism (user/connector-owned `tier→id` mapping; see the
upstream plan §5):

| Character class | Tier | Rationale |
|---|---|---|
| Clockwork King, High Confessor | strong | complex persona, long monologues, must stay coherent |
| Морозов, Ксения, Кулвич, named NPCs | medium | characterful but short replies |
| ambient crowd / one-liners | weak | cheap, fast, disposable |

The per-NPC script frontmatter (`npc_scripts/*.md`) already carries a `model:`
field; that becomes a **tier** (`strong`/`medium`/`weak`) plus an optional
explicit override, and the connector resolves tier→concrete-id through CodeTerm
at spawn. If the user's chosen provider can't express a tier, we fall back to its
default model. This keeps the NPC scripts churn-proof and provider-agnostic.

## 8. NPC session lifecycle over the connector

Unchanged in spirit from `DESIGN.md`, now expressed as connector calls:

1. Player approaches NPC → game posts `{npc_id, player_input}` to the NPC server.
2. NPC server looks up an existing session for `npc_id` (CodeTerm `mem` /
   workspace state). Found & alive → resume; else → `spawn_agents` a new agent in
   the game-folder workspace from `npc_scripts/<npc_id>.md` at the resolved model
   tier.
3. `write_panes` the player input (templated with game state).
4. `read_output` the reply, clean it, optionally pipe to TTS, return to the game.
5. Idle NPCs' panes are reaped after a TTL to free memory; their `mem` session
   pointer persists so the NPC still "remembers" on next contact.

## 9. Settings UI we expose in CodeTerm

Via `settings.schema.json`, schema-rendered on our Extensions card:

- **Provider** (Claude / Codex / …) — which agent backend hosts the NPCs.
- **Model tier mapping** per character class (strong/medium/weak → the user's
  pick), with sensible defaults from §7.
- **Game folder** (auto-detected, overridable).
- **TTS** on/off + voice mapping (ties into the ElevenLabs work; the API key
  lives in CodeTerm's secrets store, read by our connector, never hardcoded).
- **Live NPCs** master toggle (off → pure static dialogue).

## 10. Build / packaging

- The connector client is part of `npc_server/` (Python). It speaks CodeTerm's
  connector wire protocol (plain HTTP/JSON) directly, or via CodeTerm's
  **Connector SDK** once that ships (upstream Phase 4) — preferring the SDK so we
  track a small stable surface, not CodeTerm internals.
- The `.cterm` bundle (`connector.toml` + `icon.png` + `settings.schema.json`) is
  built and published alongside our releases.
- The BepInEx in-game plugin (the overlay/voice player from `DESIGN.md`) talks to
  `npc_server`, which talks to CodeTerm. The game never talks to CodeTerm
  directly — the NPC server is the single connector.

## 11. What we depend on from CodeTerm (upstream)

Blocked on the upstream feature landing (`feat/external-connectors`):

- scoped connector tokens routed through the capability policy (so our
  four-capability grant is enforced, not all-or-nothing),
- the connect + approval flow,
- workspace **origin tagging** (so CodeTerm visibly shows the NPC workspace was
  spawned by us — transparency the user asked for),
- the model **tier** mechanism (so our per-class tiers resolve without a
  hardcoded map),
- (nice-to-have) the Connector SDK and `.cterm` bundle install.

Until then, the current `npc_server` works against CodeTerm via raw CLI access (a
de-facto unscoped grant) — usable for prototyping, but **not** how we ship. The
scoped connector is the shipping target.

---

Status: design only. No connector code yet — the current `npc_server/` is the
prototype that this plan re-bases onto the scoped connector model once CodeTerm's
`feat/external-connectors` lands.
