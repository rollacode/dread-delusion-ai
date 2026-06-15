# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Dread Delusion (Unity IL2CPP)                              │
│                                                             │
│  BepInEx Plugin                                             │
│  ├── NPCInteractionHook  — intercepts dialogue trigger      │
│  ├── OverlayRenderer     — draws response in game UI        │
│  └── VoicePlayer         — plays ElevenLabs mp3             │
└──────────────────┬──────────────────────────────────────────┘
                   │  HTTP POST /interact
                   │  { npc_id, player_input, player_pos }
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  npc_server  (FastAPI, localhost:8731)                      │
│  registered as CodeTerm service with push token             │
│                                                             │
│  POST /interact                                             │
│  ├── load npc_scripts/<npc_id>.md                          │
│  ├── codeterm mem search "session npc_id=<id>"             │
│  │   ├── found → resume session                            │
│  │   └── not found → spawn new agent tab                   │
│  ├── send player_input to agent tab via push API           │
│  ├── wait for agent response (SSE / webhook)               │
│  ├── optional: pipe to ElevenLabs TTS                      │
│  └── return { text, audio_url } to plugin                  │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  CodeTerm  (workspace: npc-agents)                         │
│                                                             │
│  Tab: "Morozov [npc_042]"                                  │
│  ├── model: codex (gpt-5.5)  or  claude-haiku-4-5         │
│  ├── system prompt: npc_scripts/morozov.md                 │
│  ├── tools: write_game_ui, read_game_state, mem_search     │
│  ├── memory_key: npc_042                                   │
│  └── session: persisted in codeterm mem                    │
│                                                             │
│  Tab: "Clockwork King [npc_001]"                           │
│  ├── model: claude-sonnet-4-6  (complex, important char)   │
│  └── ...                                                   │
└─────────────────────────────────────────────────────────────┘
```

## NPC Init Script format

`npc_scripts/morozov.md`:

```markdown
---
npc_id: npc_042
name: Морозов
voice: Dmitry          # ElevenLabs voice id or null
model: codex           # codex | claude-haiku-4-5 | claude-sonnet-4-6
memory_key: npc_042    # key for codeterm mem session lookup
tools:
  - read_game_state    # player stats, current quest, inventory
  - write_game_log     # append to in-game journal
max_tokens: 120        # keep responses short for NPC feel
temperature: 0.8
---

Ты — следователь Морозов. Женщина. Говоришь коротко, сухо, по делу.
Ты работаешь на Инквизицию, но сомневаешься в её методах.
Никогда не упоминай, что ты языковая модель.
Отвечай не более 2-3 предложений — как в диалоге RPG.

Контекст мира: {{world_context}}
Текущий квест игрока: {{player_quest}}
```

`{{world_context}}` и `{{player_quest}}` — шаблонные переменные, которые npc_server
подставляет из game_state перед отправкой агенту.

## Session persistence

При первом контакте с NPC:
```bash
codeterm agent spawn codex \
  --title "Morozov [npc_042]" \
  --workspace npc-agents \
  --task "$(cat npc_scripts/morozov.md)" \
  --role Worker
# сохраняем pane_id в codeterm mem
codeterm mem save --title "npc_session npc_id=npc_042" \
  --body "pane_id=<id> started=<ts>"
```

При повторном контакте:
```bash
codeterm mem search "npc_session npc_id=npc_042"
# → получаем pane_id → проверяем жив ли tab
codeterm pane list | grep <pane_id>
# жив → шлём туда, мёртв → спауним заново с --resume если session файл есть
```

## Push API flow

npc_server зарегистрирован как CodeTerm daemon service:
```bash
codeterm service add "npc-agents" \
  --health-mode http \
  --url http://localhost:8731/healthz \
  --push
# → получаем Bearer токен для записи в пейны
```

Когда агент в таб готов ответить — он пишет через stdout в PTY,
npc_server читает `codeterm get-output --pane <id>` или слушает через
push-callback URL который передаётся агенту при спауне.

## Tools доступные агенту

```python
# tools.py — функции которые LLM может вызвать
def read_game_state(player_id: str) -> dict:
    """Читает текущие квесты, инвентарь, позицию игрока из shared state."""

def write_game_log(entry: str) -> None:
    """Добавляет запись в журнал игрока внутри игры."""

def recall_npc_memory(npc_id: str, query: str) -> str:
    """Ищет в codeterm mem по ключу персонажа — что NPC помнит об игроке."""

def trigger_game_event(event_id: str, params: dict) -> None:
    """Посылает игровое событие обратно в плагин (открыть дверь, дать предмет)."""
```

## Выбор модели по персонажу

| Персонаж | Модель | Почему |
|---|---|---|
| Случайные NPC (таверна) | codex / haiku | Дёшево, быстро, короткие реплики |
| Морозов, Ксения, Лав | haiku | Средний уровень сложности |
| Clockwork King | sonnet | Сложный персонаж, нужна coherence |
| Хор-Исповедник | sonnet | Теология, манипуляция, длинные монологи |

## BepInEx Plugin hooks

```csharp
// NPCInteractionHook.cs
[HarmonyPatch(typeof(DialogueController), "StartDialogue")]
class StartDialoguePatch {
    static bool Prefix(string npcId, ref string __result) {
        var response = NpcClient.Interact(npcId, "");  // open greeting
        OverlayUI.Show(response.text);
        if (response.audio_url != null)
            VoicePlayer.Play(response.audio_url);
        return false;  // skip original dialogue system
    }
}
```

Или — менее инвазивно — не заменять диалоговую систему, а добавить
параллельную панель с AI-ответом поверх оригинального текста.

## Roadmap

- [ ] npc_server: FastAPI skeleton + /interact endpoint
- [ ] codeterm service registration + push token
- [ ] session lookup/resume logic
- [ ] 3 тестовых NPC скрипта (Морозов, Ксения, Clockwork King)
- [ ] BepInEx plugin: overlay UI (без замены диалогов)
- [ ] ElevenLabs TTS интеграция
- [ ] tool: read_game_state из shared memory file
- [ ] tool: trigger_game_event → BepInEx
