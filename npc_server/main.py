"""
NPC Agent Server — принимает запросы от BepInEx плагина,
маршрутизирует через CodeTerm к LLM-агенту персонажа.
"""
import asyncio
import os
import subprocess
import re
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import frontmatter  # python-frontmatter

ROOT = Path(__file__).parent.parent
SCRIPTS_DIR = ROOT / "npc_scripts"
CODETERM_API = "http://localhost:7685/api"

app = FastAPI()


class InteractRequest(BaseModel):
    npc_id: str
    player_input: str
    game_state: dict = {}


class InteractResponse(BaseModel):
    text: str
    audio_url: Optional[str] = None
    npc_name: str


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/interact", response_model=InteractResponse)
async def interact(req: InteractRequest):
    script_path = SCRIPTS_DIR / f"{req.npc_id}.md"
    if not script_path.exists():
        raise HTTPException(404, f"No script for npc_id={req.npc_id}")

    post = frontmatter.load(str(script_path))
    meta = post.metadata
    npc_name = meta.get("name", req.npc_id)

    # Ищем или создаём сессию агента в CodeTerm
    pane_id = await _get_or_spawn_agent(req.npc_id, post, meta)

    # Подставляем game_state в промпт и шлём агенту
    message = _build_message(req.player_input, req.game_state)
    await _send_to_agent(pane_id, message)

    # Ждём ответа (polling get-output)
    response_text = await _wait_for_response(pane_id, timeout=15)

    # Опционально: TTS
    audio_url = None
    if meta.get("voice") and os.getenv("ELEVENLABS_KEY"):
        audio_url = await _tts(response_text, meta["voice"])

    return InteractResponse(text=response_text, audio_url=audio_url, npc_name=npc_name)


async def _get_or_spawn_agent(npc_id: str, post, meta: dict) -> str:
    """Ищет существующий pane агента в codeterm mem, спаунит если нет."""
    search = _codeterm(["mem", "search", f"npc_session npc_id={npc_id}", "--limit", "1"])
    pane_id = _extract_pane_id(search)

    if pane_id and _pane_alive(pane_id):
        return pane_id

    # Спауним новый агент
    model = meta.get("model", "codex")
    name = meta.get("name", npc_id)
    system_prompt = post.content

    result = _codeterm([
        "agent", "spawn", model,
        "--title", f"{name} [{npc_id}]",
        "--workspace", _ensure_workspace(),
        "--role", "Worker",
        "--task", system_prompt,
    ])
    new_pane_id = _extract_spawned_pane(result)

    # Сохраняем в mem
    _codeterm([
        "mem", "save",
        "--title", f"npc_session npc_id={npc_id}",
        "--body", f"pane_id={new_pane_id} model={model}",
    ])

    return new_pane_id


def _ensure_workspace() -> str:
    """Возвращает id воркспейса npc-agents, создаёт если нет."""
    out = _codeterm(["workspace", "list", "--json"])
    for line in out.splitlines():
        if "npc-agents" in line:
            # простой парсинг — в реале использовать json
            ws_id = re.search(r'"id"\s*:\s*"([^"]+)"', line)
            if ws_id:
                return ws_id.group(1)
    out = _codeterm(["workspace", "create", "npc-agents", "--json"])
    ws_id = re.search(r'"id"\s*:\s*"([^"]+)"', out)
    return ws_id.group(1) if ws_id else "npc-agents"


async def _send_to_agent(pane_id: str, message: str):
    _codeterm(["send", message, "--pane", pane_id])


async def _wait_for_response(pane_id: str, timeout: int = 15) -> str:
    """Polling get-output пока не появится новый текст от агента."""
    prev = _codeterm(["get-output", "--pane", pane_id])
    for _ in range(timeout * 2):
        await asyncio.sleep(0.5)
        curr = _codeterm(["get-output", "--pane", pane_id])
        if curr != prev:
            # берём только новый хвост
            new_text = curr[len(prev):].strip()
            if new_text:
                return _clean_response(new_text)
    return "(нет ответа)"


def _build_message(player_input: str, game_state: dict) -> str:
    if not player_input:
        return "[GREETING]"
    return player_input


def _clean_response(text: str) -> str:
    """Убирает ANSI escape, служебные строки CodeTerm."""
    text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)
    text = re.sub(r'\[Report from.*?\]', '', text)
    return text.strip()


def _codeterm(args: list) -> str:
    result = subprocess.run(
        ["codeterm"] + args,
        capture_output=True, text=True, timeout=10
    )
    return result.stdout + result.stderr


def _extract_pane_id(text: str) -> Optional[str]:
    m = re.search(r'pane_id=([a-f0-9]{8})', text)
    return m.group(1) if m else None


def _extract_spawned_pane(text: str) -> str:
    m = re.search(r'([a-f0-9]{8})', text)
    return m.group(1) if m else "unknown"


def _pane_alive(pane_id: str) -> bool:
    out = _codeterm(["pane", "list"])
    return pane_id in out


async def _tts(text: str, voice_id: str) -> Optional[str]:
    key = os.getenv("ELEVENLABS_KEY")
    if not key:
        return None
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json={"text": text, "model_id": "eleven_multilingual_v2",
                  "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
        )
        if r.status_code == 200:
            audio_path = Path(os.getenv("TEMP", "/tmp")) / f"npc_{voice_id}.mp3"
            audio_path.write_bytes(r.content)
            return str(audio_path)
    return None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8731)
