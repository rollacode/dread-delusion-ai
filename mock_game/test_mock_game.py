"""Round-trip test for the mock game (Track F, F2).

Drives the REAL codeterm-npc plugin through host_stub.mjs and asserts the
headline proof: a player line fans out to multiple in-character NPCs, addressing
one NPC narrows to that NPC, and an NPC `move` action mutates the mock world.

Runnable two ways (no pytest required):
    python mock_game/test_mock_game.py
    pytest mock_game/test_mock_game.py

Requires `node` and a built plugin (`npm run build`). If node is missing the
test SKIPS loudly rather than passing silently.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from server import GameSession, NodePluginBackend  # noqa: E402

PLUGIN_JS = Path(__file__).resolve().parent.parent / "codeterm-npc" / "plugin.js"


def _require_env() -> None:
    if shutil.which("node") is None:
        raise RuntimeError("SKIP: `node` not found on PATH")
    if not PLUGIN_JS.exists():
        raise RuntimeError(f"SKIP: plugin not built ({PLUGIN_JS}); run `npm run build`")


def test_scripted_two_npc_exchange_round_trips() -> None:
    """Player line → multiple NPCs reply in character → a move updates the world."""
    _require_env()
    backend = NodePluginBackend()
    session = GameSession(backend)
    try:
        turn = session.player_say("Здравствуйте. Я ищу пропавшего человека.")

        # multi-NPC: at least two distinct NPCs answered, each in character.
        speakers = [r.speaker for r in turn.replies]
        assert len(turn.replies) >= 2, f"expected 2+ NPCs to reply, got {speakers}"
        assert len(set(speakers)) == len(speakers), f"speakers must be distinct, got {speakers}"
        for r in turn.replies:
            assert r.text.strip(), f"{r.speaker} replied with empty text"

        # an NPC took a world-mutating action (Баба Ксения moves to the tea house).
        locations = turn.world.get("locations", {})
        assert locations, f"expected a move to have updated the world, world={turn.world}"
        assert any(loc for loc in locations.values()), "a location should be set"
    finally:
        backend.close()


def test_addressing_one_npc_narrows_the_reply() -> None:
    """`@npc_morozov ...` routes to exactly that NPC, not the whole cast."""
    _require_env()
    backend = NodePluginBackend()
    session = GameSession(backend)
    try:
        turn = session.player_say("@npc_morozov вы видели женщину в красном плаще?")
        speakers = [r.speaker for r in turn.replies]
        assert speakers == ["npc_morozov"], f"addressing should narrow to one NPC, got {speakers}"
    finally:
        backend.close()


def test_move_action_is_reported_to_the_game() -> None:
    """The `move`/`emote` action echo reaches the game side as a rendered action."""
    _require_env()
    backend = NodePluginBackend()
    session = GameSession(backend)
    try:
        turn = session.player_say("Здравствуйте всем.")
        actions = [r.action for r in turn.replies if r.action]
        assert actions, f"expected at least one NPC action echo, got {[r.__dict__ for r in turn.replies]}"
    finally:
        backend.close()


def _main() -> int:
    tests = [
        test_scripted_two_npc_exchange_round_trips,
        test_addressing_one_npc_narrows_the_reply,
        test_move_action_is_reported_to_the_game,
    ]
    failed = 0
    skipped = 0
    for t in tests:
        try:
            t()
            print(f"✓ {t.__name__}")
        except RuntimeError as e:
            if str(e).startswith("SKIP"):
                skipped += 1
                print(f"⚠ {t.__name__}: {e}")
                continue
            failed += 1
            print(f"✗ {t.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"✗ {t.__name__}: {e}")
    print(f"mock_game: {len(tests) - failed - skipped}/{len(tests)} passed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_main())
