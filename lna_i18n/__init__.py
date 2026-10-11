"""sd_forge_lora_new — 界面多语言（i18n）包。

对外只暴露 t() 及语言管理函数，供 scripts/main.py 与各语言包使用。
"""
from __future__ import annotations

from .core import available_langs, get_lang, load_pack, set_lang, t

__all__ = ["t", "get_lang", "set_lang", "available_langs", "load_pack"]
