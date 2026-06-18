"""mock_game — the "other side" of the Dread Delusion NPC environment.

Stands in for the real game (Track F, F2). It is just a chat: the player types a
line, the codeterm-npc plugin routes it to several in-character NPC agents, and
their replies + world-mutating actions (say/move/emote) come back. The plugin
runs for real via mock_game/host_stub.mjs (no daemon needed); at integration the
backend is re-pointed at `codeterm send` / `get-output`.

  python mock_game/server.py            # interactive CLI chat
  python mock_game/server.py --rest     # FastAPI REST endpoint (if installed)

Reuses npc_server scaffolding (persona frontmatter loading).
"""
from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Protocol

ROOT = Path(__file__).resolve().parent.parent
HOST_STUB = Path(__file__).resolve().parent / "host_stub.mjs"
DEFAULT_CAST = ["npc_morozov", "npc_xenia", "npc_culwich"]
DEFAULT_SCENE = "Феррополис. Зима затянулась. Граница с Хэллоуширом закрыта."


@dataclass
class NpcReply:
    speaker: str
    text: str
    action: Optional[str] = None  # the onAgentCommand result, if the NPC acted


@dataclass
class TurnResult:
    replies: list[NpcReply] = field(default_factory=list)
    world: dict = field(default_factory=dict)


class Backend(Protocol):
    """The seam between the game and the NPC plugin."""

    def send(self, text: str) -> TurnResult: ...

    def close(self) -> None: ...


class NodePluginBackend:
    """Drives the REAL codeterm-npc plugin through host_stub.mjs (serve mode).

    A persistent `node host_stub.mjs serve` subprocess speaks line-delimited JSON.
    This is the mock-first stand-in for the daemon; the plugin code is unchanged
    between this and real-daemon integration.
    """

    def __init__(self, host_stub: Path = HOST_STUB, node: str = "node"):
        self.proc = subprocess.Popen(
            [node, str(host_stub), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(ROOT),
        )

    def send(self, text: str) -> TurnResult:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps({"cmd": "send", "text": text}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"host_stub produced no output. stderr:\n{err}")
        data = json.loads(line)
        replies = [
            NpcReply(
                speaker=m["speaker"],
                text=m["text"],
                action=(m.get("action") or {}).get("result") if m.get("action") else None,
            )
            for m in data.get("messages", [])
        ]
        return TurnResult(replies=replies, world=data.get("world", {}))

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class GameSession:
    """Seeds a scene with a cast of NPCs and relays player turns to the backend."""

    def __init__(self, backend: Backend, cast: Optional[list[str]] = None, scene: str = DEFAULT_SCENE):
        self.backend = backend
        self.cast = cast or DEFAULT_CAST
        self.scene = scene
        self.world: dict = {}

    def player_say(self, text: str) -> TurnResult:
        result = self.backend.send(text)
        self.world = result.world
        return result


def _render(turn: TurnResult) -> None:
    for r in turn.replies:
        print(f"  {r.speaker} » {r.text}")
        if r.action:
            print(f"     ↳ {r.action}")


def run_cli() -> None:
    print("=== Dread Delusion — mock game (CLI) ===")
    print(f"scene: {DEFAULT_SCENE}")
    print(f"cast:  {', '.join(DEFAULT_CAST)}")
    print("Type a line (prefix @npc_id to address one NPC). Ctrl-D to quit.\n")
    backend = NodePluginBackend()
    session = GameSession(backend)
    try:
        while True:
            try:
                line = input("PLAYER › ").strip()
            except EOFError:
                break
            if not line:
                continue
            _render(session.player_say(line))
            print("")
    finally:
        backend.close()
        print("\n=== final world state ===")
        print(json.dumps(session.world, ensure_ascii=False, indent=2))


def run_rest() -> None:
    from fastapi import FastAPI  # type: ignore
    from pydantic import BaseModel  # type: ignore
    import uvicorn  # type: ignore

    app = FastAPI(title="dread mock_game")
    backend = NodePluginBackend()
    session = GameSession(backend)

    class Say(BaseModel):
        text: str

    @app.get("/healthz")
    def health():
        return {"status": "ok", "cast": session.cast}

    @app.post("/say")
    def say(req: Say):
        turn = session.player_say(req.text)
        return {
            "replies": [r.__dict__ for r in turn.replies],
            "world": turn.world,
        }

    uvicorn.run(app, host="127.0.0.1", port=8732)


if __name__ == "__main__":
    if "--rest" in sys.argv:
        run_rest()
    else:
        run_cli()
