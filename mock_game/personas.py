"""Persona loading — reused from npc_server scaffolding (Track F).

Reads npc_scripts/<id>.md, splitting YAML frontmatter (name/model/voice) from
the character prose. Falls back to a hand parser if python-frontmatter is not
installed, so the harness and its tests run with zero hard deps.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "npc_scripts"


class Persona:
    def __init__(self, npc_id: str, name: str, model: str, prose: str, meta: dict):
        self.npc_id = npc_id
        self.name = name
        self.model = model
        self.prose = prose
        self.meta = meta


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Tiny YAML-ish frontmatter splitter (key: value only) — no PyYAML needed."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    head = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")
    meta: dict = {}
    for line in head.splitlines():
        if ":" in line and not line.strip().startswith("-"):
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()
    return meta, body


def load_persona(npc_id: str, scripts_dir: Optional[Path] = None) -> Persona:
    scripts_dir = scripts_dir or SCRIPTS_DIR
    path = scripts_dir / f"{npc_id}.md"
    if not path.exists():
        return Persona(npc_id, npc_id, "claude-haiku-4-5-20251001", f"You are {npc_id}.", {})
    raw = path.read_text(encoding="utf-8")
    try:
        import frontmatter  # type: ignore

        post = frontmatter.loads(raw)
        meta, prose = dict(post.metadata), post.content
    except Exception:
        meta, prose = _split_frontmatter(raw)
    return Persona(
        npc_id=npc_id,
        name=str(meta.get("name", npc_id)),
        model=str(meta.get("model", "claude-haiku-4-5-20251001")),
        prose=prose.strip(),
        meta=meta,
    )
