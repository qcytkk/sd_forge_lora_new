"""sd_forge_lora_new — 界面多语言（i18n）核心。

语言包位于 lna_i18n/locales/<lang>.json，键为扁平字符串（域前缀 + 点分层，
如 settings.title / err.invalidPath），值为该语言的显示文本。

新增一种语言只需在 locales/ 下新增一个同结构的 JSON 文件，无需改动任何代码：
available_langs() 会扫描目录自动发现它。
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent / "locales"
DEFAULT_LANG = "zh_CN"

_lock = threading.RLock()
_lang = DEFAULT_LANG
# 语言包缓存：lang -> (文件 mtime_ns, 语言包)。按 mtime 失效，
# 使编辑 locales/*.json 后无需重启 WebUI，下一次请求即读到新内容。
_cache: dict[str, tuple[int, dict[str, str]]] = {}


def available_langs() -> list[str]:
    """扫描 locales 目录，返回可用语言代码（字典序）。"""
    try:
        langs = sorted(p.stem for p in LOCALES_DIR.glob("*.json"))
    except Exception:
        langs = []
    return langs or [DEFAULT_LANG]


def _pack_mtime(lang: str) -> int:
    try:
        return (LOCALES_DIR / f"{lang}.json").stat().st_mtime_ns
    except Exception:
        return -1


def _read_pack(lang: str) -> dict[str, str]:
    path = LOCALES_DIR / f"{lang}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        pass
    return {}


def load_pack(lang: str, *, reload: bool = False) -> dict[str, str]:
    """读取某语言的语言包（返回副本，避免外部改动污染缓存）。

    缓存以文件 mtime 为键：语言包文件被修改后自动重新读取，
    无需重启 WebUI（避免长期驻留进程一直沿用旧的、不完整的语言包）。
    """
    mtime = _pack_mtime(lang)
    with _lock:
        hit = _cache.get(lang)
        if not reload and hit is not None and hit[0] == mtime:
            return dict(hit[1])
    data = _read_pack(lang)
    with _lock:
        _cache[lang] = (mtime, data)
    return dict(data)


def get_lang() -> str:
    """当前界面语言。"""
    with _lock:
        return _lang


def set_lang(lang: str) -> str:
    """设置当前界面语言；未知语言回退默认。返回实际生效的语言代码。"""
    global _lang
    code = str(lang or "").strip()
    if code not in available_langs():
        code = DEFAULT_LANG
    with _lock:
        _lang = code
    return code


def t(key: str, **vars) -> str:
    """取当前语言下 key 的文本并做 {占位符} 插值。

    缺失回落：目标语言缺 key → 默认语言 zh_CN → 原样返回 key（便于暴露漏译）。
    插值失败时退化为未插值文本，绝不抛错（保护 API 不被 500）。
    """
    lang = get_lang()
    pack = load_pack(lang)
    text = pack.get(key)
    if text is None and lang != DEFAULT_LANG:
        text = load_pack(DEFAULT_LANG).get(key)
    if text is None:
        return key
    if vars:
        try:
            return text.format(**vars)
        except Exception:
            return text
    return text
