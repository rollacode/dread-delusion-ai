# dread-delusion-ai

AI-powered NPC dialogue for Dread Delusion — each NPC gets a live LLM session with persistent memory, voice, and tool access. Runs on top of [CodeTerm](https://codeterm.app) as the agent runtime.

## Components

```
npc_server/     — FastAPI daemon (CodeTerm service, push API)
plugin/         — BepInEx IL2CPP plugin (intercepts NPC interaction, renders overlay)
npc_scripts/    — Per-NPC init scripts (system prompt + model + tools + voice)
codeterm/       — CodeTerm workspace/service setup scripts
```

## How it works

1. Player walks up to an NPC → BepInEx plugin intercepts the trigger
2. Plugin calls `npc_server` with `{npc_id, player_input}`
3. Server checks CodeTerm for an existing session for that NPC
4. If none — spawns a new agent tab in the `npc-agents` workspace using the NPC's init script
5. If found — resumes the session (NPC remembers previous conversations)
6. LLM responds (Codex for speed, Claude for complex characters)
7. Response → back to plugin → rendered in game UI overlay
8. Optionally → ElevenLabs TTS → voice

## Setup

```bash
pip install -r npc_server/requirements.txt
python npc_server/main.py --register   # registers as CodeTerm service, prints token
# copy token to .env
```

See [DESIGN.md](DESIGN.md) for full architecture.
