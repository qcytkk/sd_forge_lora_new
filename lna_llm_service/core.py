"""lna_llm_service — 本地 LLM 翻译服务（sd_forge_lora_new 与 sd-webui-prompt-all-in-one-forge 共用）

两个插件各自独立，但本地大模型翻译共用这一份实现：
  - 模型目录共用 <WebUI>/models/LLM；
  - 推理运行时（llama-cpp-python / CUDA 轮子）共用一套；
  - 进程内**只有一个** Llama 实例、**一把**全局 RLock、**一个**空闲卸载守护线程。

导入方式：两个插件都把 <extensions>/sd_forge_lora_new 插入 sys.path，再
`import lna_llm_service`。Python 的模块缓存保证无论谁先导入，拿到的都是同一个模块对象，
因此上面的单例/锁/watchdog 天然全局唯一——这就是「共享而不冲突」的实现基础。

并发策略：串行排队。所有推理都持 `lock`()，llama_cpp 的 C++ 实例非线程安全，
并发调用会 segfault 拖垮整个 WebUI；排队后第二个任务只是等待，不会失败。

空闲卸载：watchdog 只有一个，读取「归属方」的配置（见 `set_owner`）。
prompt-all-in-one 侧在 sd_forge_lora_new 启用时冻结自己的卸载设置，改用本服务的配置。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from fractions import Fraction
from math import gcd
from pathlib import Path
from typing import Any

__all__ = [
    "llm_dir", "scan_models", "resolve_path",
    "status", "unload", "busy", "ensure_watchdog", "set_owner",
    "translate", "last_note", "last_error",
    "translate_mode", "set_translate_mode", "TRANS_MODES",
    "translate_tags", "cache_key", "set_translation_cache_file",
    "prompt_presets", "active_prompt", "save_preset", "delete_preset", "select_preset",
    "idle_settings", "set_idle_settings",
    "select_model", "set_gpu", "get_config", "set_config_listeners",
    "probe_runtime", "nvidia_ok", "cuda_wheel_downloaded",
    "repo_files", "start_download", "download_status",
    "start_cuda_download", "runtime_download_status", "runtime_info",
    "RUNTIME_VERSION", "MIN_CUDA_DRIVER", "PROMPT_DEFAULT_NAME",
    "PROMPT_NAME_MAX", "PROMPT_TEXT_MAX",
]

# ---------- 路径 ----------
# 本文件位于 <extensions>/sd_forge_lora_new/lna_llm_service/core.py
EXT_DIR = Path(__file__).resolve().parent.parent
LLM_SERVICE_DIR = EXT_DIR / "lna_llm_service"
DATA_DIR = EXT_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
# 共享配置：模型/设备/空闲卸载/提示预设。首次读取时从 lora_new 的 stats.json 迁移。
CONFIG_FILE = DATA_DIR / "llm_shared.json"
# 译文缓存：{模型名: {标签: 译文}}。prompt 插件可改用自己的缓存文件（set_translation_cache_file）
CACHE_FILE = DATA_DIR / "llm_translations.json"

try:
    from modules import paths as _paths
    LLM_DIR = Path(_paths.models_path) / "LLM"
except Exception:
    LLM_DIR = EXT_DIR / "models" / "LLM"

# 运行时轮子：CPU 轮子随 lora_new 插件分发；CUDA 轮子按需下载到 wheels/cuda/
WHEELS_DIR = EXT_DIR / "wheels"
CUDA_WHEELS_DIR = WHEELS_DIR / "cuda"
RUNTIME_VERSION = "0.3.36"
CUDA_WHEEL_NAME = f"llama_cpp_python-{RUNTIME_VERSION}-py3-none-win_amd64.whl"
CUDA_WHEEL_URL = (
    f"https://github.com/abetlen/llama-cpp-python/releases/download/"
    f"v{RUNTIME_VERSION}-cu124/{CUDA_WHEEL_NAME}"
)
MIN_CUDA_DRIVER = (527, 41)

IDLE_MIN_DEFAULT = 5
IDLE_MIN = 3
IDLE_MAX = 200
IDLE_POLL_SECONDS = 10

PROMPT_DEFAULT_NAME = "默认"
PROMPT_NAME_MAX = 30
PROMPT_TEXT_MAX = 4000

TRANS_MODES = ("dict", "llm", "hybrid")

LLM_SYSTEM_PROMPT = "你是 AI 绘画提示词翻译专家，只输出 JSON，不输出任何多余文字。"

LLM_USER_PROMPT = """把下面的英文 danbooru 标签逐个翻译成简体中文。

规则：
1. 输出一个 JSON 对象：key 必须与给出的英文原文完全一致，value 为简体中文译文。
2. 使用 AI 绘画圈的通用译法，例如 "looking at viewer" 译为"看向观者"，"thighhighs" 译为"过膝袜"。
3. 只有「不含空格且含数字」的自造触发词（如 kei1、my_style_v2）才原样返回英文；
   其余标签都要翻译，用下划线连接的常见 danbooru 标签（如 open_mouth、long_hair、tentacle_sex）也要译成中文。
4. 不要输出 JSON 以外的任何内容。

标签列表：
{tags}"""


# ---------- 共享配置 ----------
_cfg_lock = threading.RLock()
_cfg: dict[str, Any] | None = None
# 配置变更回调（归属插件用来同步自己的 UI 状态，可选）
_on_config_changed = None


def _config_defaults() -> dict[str, Any]:
    return {
        "llm_model": "",          # LLM_DIR 下的相对路径
        "llm_gpu": False,         # False=CPU（默认，不与 SD 抢显存）/ True=GPU
        "llm_auto_unload": True,
        "llm_idle_minutes": IDLE_MIN_DEFAULT,
        "translate_mode": "hybrid",
        "prompt_presets": {},
        "active_prompt": "",
        "owner": "",              # 最近一次写入配置的插件（诊断用）
    }


def _migrate_from_stats(data: dict[str, Any]) -> None:
    """首次创建共享配置时，沿用 lora_new 已有的 stats.json 设置，用户无感。"""
    stats_file = DATA_DIR / "stats.json"
    if not stats_file.is_file():
        return
    try:
        old = json.loads(stats_file.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(old, dict):
        return
    # 旧 stats.json 里的 LLM 配置可能带此前缀，统一去掉后再迁移
    for key in list(old):
        if key.startswith("lora_new_"):
            bare = key[len("lora_new_"):]
            old.setdefault(bare, old[key])
    for key in ("llm_model", "llm_gpu", "llm_auto_unload", "llm_idle_minutes",
                "translate_mode", "prompt_presets", "active_prompt"):
        if key in old:
            data[key] = old[key]


def _load_cfg() -> dict[str, Any]:
    global _cfg
    with _cfg_lock:
        if _cfg is not None:
            return _cfg
        data = _config_defaults()
        if CONFIG_FILE.is_file():
            try:
                raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    for k in data:
                        if k in raw:
                            data[k] = raw[k]
            except Exception:
                pass
        else:
            _migrate_from_stats(data)
            _save_cfg(data)
        if not isinstance(data.get("prompt_presets"), dict):
            data["prompt_presets"] = {}
        _cfg = data
        return _cfg


def _save_cfg(data: dict[str, Any] | None = None) -> None:
    with _cfg_lock:
        payload = data if data is not None else _cfg
        if payload is None:
            return
        try:
            tmp = CONFIG_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(CONFIG_FILE)
        except Exception:
            pass


def get_config() -> dict[str, Any]:
    return dict(_load_cfg())


def _set_config(key: str, value: Any, owner: str = "") -> None:
    cfg = _load_cfg()
    with _cfg_lock:
        cfg[key] = value
        if owner:
            cfg["owner"] = owner
        _save_cfg(cfg)
    if _on_config_changed is not None:
        try:
            _on_config_changed()
        except Exception:
            pass


def set_config_listeners(on_change=None) -> None:
    """归属插件注册回调：共享配置变更时同步自己的持久化/UI 状态。"""
    global _on_config_changed
    _on_config_changed = on_change


def set_owner(owner: str) -> None:
    """标记空闲卸载计时归属：'lora_new' / 'prompt'。"""
    _set_config("owner", owner)


def idle_settings() -> dict:
    cfg = _load_cfg()
    return {
        "auto_unload": bool(cfg.get("llm_auto_unload", True)),
        "idle_minutes": _clamp_idle_minutes(cfg.get("llm_idle_minutes", IDLE_MIN_DEFAULT)),
        "idle_min": IDLE_MIN,
        "idle_max": IDLE_MAX,
        "owner": str(cfg.get("owner") or ""),
    }


def set_idle_settings(auto_unload=None, minutes=None, owner: str = "") -> dict:
    cfg = _load_cfg()
    with _cfg_lock:
        if auto_unload is not None:
            cfg["llm_auto_unload"] = bool(auto_unload)
        if minutes is not None:
            cfg["llm_idle_minutes"] = _clamp_idle_minutes(minutes)
        if owner:
            cfg["owner"] = owner
        _save_cfg(cfg)
    if _on_config_changed is not None:
        try:
            _on_config_changed()
        except Exception:
            pass
    return idle_settings()


def _clamp_idle_minutes(value: Any) -> int:
    try:
        n = int(round(float(value)))
    except Exception:
        return IDLE_MIN_DEFAULT
    return max(IDLE_MIN, min(IDLE_MAX, int(n)))


# ---------- 模型目录 ----------
def llm_dir() -> Path:
    try:
        LLM_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return LLM_DIR


def scan_models() -> list[dict]:
    out: list[dict] = []
    base = llm_dir()
    try:
        for p in sorted(base.rglob("*.gguf")):
            try:
                if not p.is_file():
                    continue
                st = p.stat()
            except Exception:
                continue
            out.append({
                "name": p.name,
                "rel": str(p.relative_to(base)).replace("\\", "/"),
                "size": st.st_size,
                "modified": st.st_mtime,
            })
    except Exception:
        pass
    return out


def resolve_path(rel: str) -> Path | None:
    if not rel:
        return None
    parts = [s for s in str(rel).replace("\\", "/").split("/") if s not in ("", ".")]
    if not parts or any(s == ".." for s in parts):
        return None
    base = llm_dir()
    p = base.joinpath(*parts)
    try:
        p.resolve().relative_to(base.resolve())
    except Exception:
        return None
    if p.suffix.lower() != ".gguf":
        return None
    return p


def select_model(rel: str, owner: str = "") -> dict:
    rel = str(rel or "")
    if rel and resolve_path(rel) is None:
        return {"ok": False, "error": "Invalid model path"}
    if str(_load_cfg().get("llm_model") or "") != rel:
        unload()
    global _llm_load_error
    _llm_load_error = ""
    _set_config("llm_model", rel, owner=owner)
    return {"ok": True, "selected": rel}


def set_gpu(want: bool, owner: str = "") -> dict:
    want = bool(want)
    if want and not _cuda_available():
        return {"ok": False, "error": "cpuBuildNoGpu"}
    if want == bool(_load_cfg().get("llm_gpu")):
        return {"ok": True, "gpu": want}
    unload()
    _set_config("llm_gpu", want, owner=owner)
    return {"ok": True, "gpu": want}


# ---------- 模型实例（单实例 + 全局串行锁） ----------
_llm = None
_llm_path = ""
_llm_load_error = ""
_llm_last_note = ""
_cuda_checked = False
_cuda_ok = False
_llm_lock = threading.RLock()   # 加载/推理/卸载全程串行
_llm_last_used = 0.0
_watchdog_started = False
_llama_dll_ready = False

# 有任务时 busy=True：watchdog 不会在翻译过程中卸载模型
_busy_state: dict[str, Any] = {"busy": False, "count": 0}
_busy_lock = threading.Lock()


def lock() -> threading.RLock:
    """跨插件共用的推理锁：外部如需「排队 + 原子」地做多步推理，可自行 with 它。"""
    return _llm_lock


def busy() -> bool:
    with _busy_lock:
        return bool(_busy_state["busy"])


def _set_busy(delta: int) -> None:
    """任务计数：嵌套/排队时只有计数归零才算空闲。"""
    with _busy_lock:
        n = max(0, int(_busy_state["count"]) + delta)
        _busy_state["count"] = n
        _busy_state["busy"] = n > 0


class translate_task:
    """标记「翻译任务进行中」，期间自动卸载不会触发。可嵌套。"""

    def __enter__(self):
        _set_busy(+1)
        return self

    def __exit__(self, *exc):
        _set_busy(-1)
        return False


def last_note() -> str:
    return _llm_last_note


def last_error() -> str:
    return _llm_load_error


def reason() -> str:
    """模型没能产出译文的可读原因（先看「跑了但没结果」，再看加载/推理错误）。"""
    return _llm_last_note or _llm_load_error


def _prepare_llama_dll_env() -> None:
    """把 CUDA 运行库目录并入 PATH（官方 CUDA 轮子不自带 cudart/cublas）。只做一次。"""
    global _llama_dll_ready
    if _llama_dll_ready:
        return
    _llama_dll_ready = True
    if os.name != "nt":
        return
    dirs: list[str] = []
    try:
        import torch
        tlib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(tlib):
            dirs.append(tlib)
    except Exception:
        pass
    for env in ("CUDA_PATH", "CUDA_HOME"):
        base = os.environ.get(env)
        if base:
            dirs += [os.path.join(base, "bin", "x64"), os.path.join(base, "bin")]
    root = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    try:
        def _ver_key(name: str):
            return tuple(int(x) for x in re.findall(r"\d+", name)) or (0,)

        for ver in sorted(os.listdir(root), key=_ver_key, reverse=True):
            dirs += [os.path.join(root, ver, "bin", "x64"), os.path.join(root, ver, "bin")]
    except Exception:
        pass
    dirs = [d for d in dirs if os.path.isdir(d)]
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
        for d in dirs:
            try:
                os.add_dll_directory(d)
            except Exception:
                pass


def _cuda_available() -> bool:
    """本进程内探测 llama_cpp 是否带 CUDA（会初始化后端，只在主动路径调用）。"""
    global _cuda_checked, _cuda_ok
    if _cuda_checked:
        return _cuda_ok
    _prepare_llama_dll_env()
    try:
        import llama_cpp
        info = llama_cpp.llama_print_system_info()
        if isinstance(info, bytes):
            info = info.decode("utf-8", errors="ignore")
        _cuda_ok = "CUDA" in str(info)
        _cuda_checked = True
    except Exception:
        _cuda_ok = False
    return _cuda_ok


def _get_llm():
    global _llm, _llm_path, _llm_load_error, _llm_last_used
    rel = str(_load_cfg().get("llm_model") or "")
    if not rel:
        return None
    path = resolve_path(rel)
    if path is None or not path.is_file():
        _llm_load_error = "Model file missing"
        return None
    with _llm_lock:
        if _llm is not None and _llm_path == str(path):
            _llm_last_used = time.time()
            return _llm
        unload()
        use_gpu = bool(_load_cfg().get("llm_gpu")) and _cuda_available()
        _prepare_llama_dll_env()
        threads = max(1, (os.cpu_count() or 4) // 2)
        try:
            from llama_cpp import Llama
            _llm = Llama(model_path=str(path), n_ctx=2048, n_threads=threads, n_batch=256,
                         n_gpu_layers=999 if use_gpu else 0, op_offload=use_gpu, verbose=False)
            _llm_path = str(path)
            _llm_last_used = time.time()
            _llm_load_error = ""
        except Exception as e:
            _llm = None
            _llm_path = ""
            _llm_load_error = f"Failed to load model: {e}"
            if use_gpu:  # 显存不足等 GPU 失败 → 自动降级 CPU 重试一次
                try:
                    from llama_cpp import Llama
                    _llm = Llama(model_path=str(path), n_ctx=2048, n_threads=threads, n_batch=256,
                                 n_gpu_layers=0, op_offload=False, verbose=False)
                    _llm_path = str(path)
                    _llm_last_used = time.time()
                    _llm_load_error = "GPU load failed, fell back to CPU"
                except Exception as e2:
                    _llm = None
                    _llm_path = ""
                    _llm_load_error = f"Failed to load model: {e2}"
            return None
        return _llm


def unload() -> bool:
    global _llm, _llm_path
    with _llm_lock:
        if _llm is None:
            _llm_path = ""
            return False
        try:
            _llm.close()
        except Exception:
            pass
        _llm = None
        _llm_path = ""
        return True


def _idle_watchdog() -> None:
    """唯一的守护线程：空闲超过阈值后卸载模型。配置来自共享配置（归属方维护）。"""
    while True:
        time.sleep(IDLE_POLL_SECONDS)
        try:
            if _llm is None:
                continue
            cfg = _load_cfg()
            if not bool(cfg.get("llm_auto_unload", True)):
                continue
            if busy():
                continue
            minutes = _clamp_idle_minutes(cfg.get("llm_idle_minutes", IDLE_MIN_DEFAULT))
            if _llm_last_used and (time.time() - _llm_last_used) >= minutes * 60:
                unload()
        except Exception:
            pass


def ensure_watchdog() -> None:
    global _watchdog_started
    if _watchdog_started:
        return
    _watchdog_started = True
    threading.Thread(target=_idle_watchdog, daemon=True, name="lna-idle-unload").start()


def status() -> dict:
    cfg = _load_cfg()
    with _llm_lock:
        return {
            "loaded": _llm is not None,
            "model": os.path.basename(_llm_path) if _llm_path else "",
            "loaded_path": _llm_path,
            "gpu": bool(cfg.get("llm_gpu")),
            "auto_unload": bool(cfg.get("llm_auto_unload", True)),
            "idle_minutes": _clamp_idle_minutes(cfg.get("llm_idle_minutes", IDLE_MIN_DEFAULT)),
            "translate_mode": translate_mode(),
            "busy": busy(),
            "last_used": _llm_last_used,
            "load_error": _llm_load_error,
            "note": _llm_last_note,
            "selected": str(cfg.get("llm_model") or ""),
            "owner": str(cfg.get("owner") or ""),
        }


# ---------- 推理 ----------
def _normalize_tag(tag: str) -> str:
    return str(tag).strip().lower().replace(" ", "_")


def _parse_json_loose(text: str) -> dict:
    if not text:
        return {}
    s = str(text).strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        data = json.loads(s)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(s[start:end + 1])
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _prompt_for(prompt: str | None, texts: list[str]) -> str:
    if prompt and str(prompt).strip() and "{tags}" in str(prompt):
        return str(prompt).replace("{tags}", json.dumps(texts, ensure_ascii=False))
    return active_prompt()[1].replace("{tags}", json.dumps(texts, ensure_ascii=False))


def _infer(texts: list[str], prompt: str | None = None, max_tokens: int = 1536) -> str:
    """原子执行一次推理（持全局锁），返回模型原始输出；失败返回空串。

    调用方无需自行加锁；多个插件/浏览器标签页同时请求时在这里**串行排队**。
    """
    global _llm_load_error, _llm_last_used, _llm_last_note
    _llm_last_note = ""
    user_prompt = _prompt_for(prompt, texts)
    with _llm_lock:
        llm = _get_llm()
        if llm is None:
            return ""
        try:
            with translate_task():
                out = llm.create_chat_completion(
                    messages=[
                        {"role": "system", "content": LLM_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.2,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                )
                text = out["choices"][0]["message"]["content"]
        except Exception as e:
            _llm_load_error = f"Inference failed: {e}"
            _llm_last_used = time.time()
            return ""
        _llm_last_used = time.time()
    data = _parse_json_loose(text)
    if not data:
        _llm_last_note = "Model returned no JSON"
    return text


def translate(texts: list[str], prompt: str | None = None, max_tokens: int = 1536) -> dict[str, str]:
    """把 texts 交给模型翻译，返回 {原文: 译文}（键名做了宽松匹配）。"""
    texts = [str(t) for t in (texts or []) if str(t).strip()]
    if not texts:
        return {}
    raw = _infer(texts, prompt=prompt, max_tokens=max_tokens)
    data = _parse_json_loose(raw)
    result: dict[str, str] = {}
    for tag in texts:
        val = data.get(tag)
        if val is None:
            for k, v in data.items():
                if _normalize_tag(k) == _normalize_tag(tag):
                    val = v
                    break
        if isinstance(val, str) and val.strip():
            result[tag] = val.strip()
    if raw and data and not result:
        global _llm_last_note
        _llm_last_note = "Model output keys do not match input tags"
    return result


def run_inference(user_prompt: str, system_prompt: str = "", json_mode: bool = False) -> dict:
    """通用单次推理（供其它插件自定义提示词使用）。

    与 translate() 一样持全局锁串行执行；返回 {'ok', 'text', 'error'}，
    调用方自行解析输出，不依赖本模块的标签约定。
    json_mode=True 时与 translate() 一致，向 llama.cpp 声明 JSON 输出约束
    （Qwen 系列在无该约束时可能先输出思考过程，导致调用方解析失败）。
    """
    global _llm_load_error, _llm_last_used
    _llm_load_error = ""
    with _llm_lock:
        llm = _get_llm()
        if llm is None:
            return {"ok": False, "text": "", "error": _llm_load_error or "Local LLM is not available"}
        kwargs = {"temperature": 0.2, "max_tokens": 1536}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            with translate_task():
                out = llm.create_chat_completion(
                    messages=[
                        {"role": "system", "content": system_prompt or LLM_SYSTEM_PROMPT},
                        {"role": "user", "content": str(user_prompt)},
                    ],
                    **kwargs,
                )
                text = out["choices"][0]["message"]["content"]
        except Exception as e:
            _llm_load_error = f"Inference failed: {e}"
            _llm_last_used = time.time()
            return {"ok": False, "text": "", "error": _llm_load_error}
        _llm_last_used = time.time()
    return {"ok": True, "text": text or "", "error": ""}


# ---------- 提示预设 ----------
def prompt_presets() -> dict[str, str]:
    presets = {PROMPT_DEFAULT_NAME: LLM_USER_PROMPT}
    raw = _load_cfg().get("prompt_presets")
    if isinstance(raw, dict):
        for k, v in raw.items():
            name = str(k).strip()
            text = str(v)
            if name and name != PROMPT_DEFAULT_NAME and text.strip():
                presets[name] = text
    return presets


def active_prompt() -> tuple[str, str]:
    presets = prompt_presets()
    name = str(_load_cfg().get("active_prompt") or PROMPT_DEFAULT_NAME)
    if name not in presets:
        name = PROMPT_DEFAULT_NAME
    return name, presets[name]


def prompt_payload(owner: str = "") -> dict:
    name, text = active_prompt()
    return {
        "ok": True,
        "active": name,
        "text": text,
        "default_name": PROMPT_DEFAULT_NAME,
        "presets": [{"name": k, "text": v} for k, v in prompt_presets().items()],
        "name_max": PROMPT_NAME_MAX,
        "text_max": PROMPT_TEXT_MAX,
        "owner": owner or str(_load_cfg().get("owner") or ""),
    }


def save_preset(name: str, text: str, owner: str = "") -> dict:
    name = str(name or "").strip()
    text = str(text or "")
    if not name:
        return {"ok": False, "error": "Need preset name"}
    if name == PROMPT_DEFAULT_NAME:
        return {"ok": False, "error": "Preset name reserved"}
    if len(name) > PROMPT_NAME_MAX:
        return {"ok": False, "error": "Preset name too long"}
    if not text.strip():
        return {"ok": False, "error": "Prompt is empty"}
    if len(text) > PROMPT_TEXT_MAX:
        return {"ok": False, "error": "Prompt too long"}
    if "{tags}" not in text:
        return {"ok": False, "error": "Prompt needs {tags}"}
    cfg = _load_cfg()
    with _cfg_lock:
        presets = cfg.setdefault("prompt_presets", {})
        if not isinstance(presets, dict):
            presets = {}
            cfg["prompt_presets"] = presets
        presets[name] = text
        cfg["active_prompt"] = name
        if owner:
            cfg["owner"] = owner
        _save_cfg(cfg)
    return prompt_payload(owner)


def delete_preset(name: str, owner: str = "") -> dict:
    name = str(name or "").strip()
    if name == PROMPT_DEFAULT_NAME:
        return {"ok": False, "error": "Default preset is not deletable"}
    cfg = _load_cfg()
    presets = cfg.get("prompt_presets")
    if not isinstance(presets, dict) or name not in presets:
        return {"ok": False, "error": "Preset not found"}
    with _cfg_lock:
        del presets[name]
        if str(cfg.get("active_prompt") or "") == name:
            cfg["active_prompt"] = ""
        if owner:
            cfg["owner"] = owner
        _save_cfg(cfg)
    return prompt_payload(owner)


def select_preset(name: str, owner: str = "") -> dict:
    name = str(name or "").strip()
    if name not in prompt_presets():
        return {"ok": False, "error": "Preset not found"}
    cfg = _load_cfg()
    with _cfg_lock:
        cfg["active_prompt"] = name
        if owner:
            cfg["owner"] = owner
        _save_cfg(cfg)
    return prompt_payload(owner)


# ---------- 翻译方案（对照表 / 模型 / 混合） ----------
def translate_mode() -> str:
    m = str(_load_cfg().get("translate_mode") or "hybrid")
    return m if m in TRANS_MODES else "hybrid"


def set_translate_mode(mode: str, owner: str = "") -> dict:
    if mode not in TRANS_MODES:
        return {"ok": False, "error": "Invalid translate mode"}
    _set_config("translate_mode", mode, owner=owner)
    return {"ok": True, "mode": mode}


# ---------- 标签词典 / 译文缓存（lora_new 的标签翻译用；prompt 插件可指向自己的缓存） ----------
_tag_dict: dict[str, str] = {}
_trans_cache: dict[str, dict[str, str]] = {}
_trans_loaded = False
_cache_file: Path = CACHE_FILE
_cache_lock = threading.RLock()

DICT_MAX_LEN = 20
_ASCII_WORD_RE = re.compile(r"[A-Za-z]{2,}")
_REPEAT_CJK_RE = re.compile(r"([\u4e00-\u9fff]{2,})(?=.*\1)")
_PAREN_RE = re.compile(r"[（(][^）)]*[）)]")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_NAME_CHUNK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’.\-!&+ ]*")


def set_translation_cache_file(path) -> None:
    """切换译文缓存文件（prompt 插件用自己的缓存，避免与 lora_new 的标签缓存混用）。"""
    global _cache_file, _trans_loaded
    with _cache_lock:
        _cache_file = Path(path)
        _trans_loaded = False
        _trans_cache.clear()


def cache_key() -> str:
    return os.path.basename(str(_load_cfg().get("llm_model") or ""))


def _dict_value_questionable(value: str) -> bool:
    s = str(value or "").strip()
    if not s:
        return True
    outside = _PAREN_RE.sub("", s)
    if _REPEAT_CJK_RE.search(outside):
        return True
    parens = _PAREN_RE.findall(s)
    if parens and any(_CJK_RE.search(p) for p in parens):
        chunks = [c.strip() for c in _PAREN_RE.split(s) if c.strip()]
        if len(chunks) == 1 and _NAME_CHUNK_RE.fullmatch(chunks[0]):
            return False
    if len(s) > DICT_MAX_LEN:
        return True
    if _ASCII_WORD_RE.search(outside):
        return True
    return False


def _is_dict_header(row: list) -> bool:
    if len(row) < 2:
        return False
    a, b = row[0].strip(), row[1].strip()
    return a in ("英文", "English", "en", "tag", "标签") and b in ("中文", "Chinese", "zh", "译文")


def _load_tag_dict() -> None:
    """每次翻译都全量重读词典 CSV。

    通过「加入词典」写入的新词条只落盘、不会通知本模块，缓存一次就会过期；
    因此这里不做加载标记，直接重建。用局部字典整体替换而非原地修改，避免
    并发读取时看到半成品；读失败时保留上一次的词典。
    """
    global _tag_dict
    import csv
    loaded: dict[str, str] = {}
    try:
        with (DATA_DIR / "sd_forge_lora_new_en_zh_dictionary.csv").open(
            "r", encoding="utf-8-sig", errors="ignore", newline=""
        ) as f:
            for row in csv.reader(f):
                if len(row) < 2 or _is_dict_header(row):
                    continue
                key = _normalize_tag(row[0])
                val = " ".join(str(row[1]).split())
                if key and val:
                    loaded[key] = val
    except Exception:
        return
    _tag_dict = loaded


def _load_trans_cache() -> None:
    global _trans_loaded
    with _cache_lock:
        if _trans_loaded:
            return
        _trans_loaded = True
        if not _cache_file.exists():
            return
        try:
            data = json.loads(_cache_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for model, mapping in data.items():
                    if isinstance(mapping, dict):
                        _trans_cache[str(model)] = {str(k): str(v) for k, v in mapping.items()}
        except Exception:
            pass


def _save_trans_cache() -> None:
    with _cache_lock:
        try:
            _cache_file.parent.mkdir(parents=True, exist_ok=True)
            _cache_file.write_text(
                json.dumps(_trans_cache, ensure_ascii=False, indent=0), encoding="utf-8"
            )
        except Exception:
            pass


def set_cached_translation(tag: str, value: str) -> None:
    """人工修正的译文写入当前模型的缓存桶（后续非强制翻译直接复用）。"""
    with _cache_lock:
        _load_trans_cache()
        key = cache_key()
        if key:
            _trans_cache.setdefault(key, {})[tag] = value
            _save_trans_cache()


def translate_tags(tags: list[str], force: bool = False) -> dict:
    """lora_new 的标签批量翻译（词典优先 + 模型兜底，按翻译方案执行）。"""
    _load_tag_dict()
    tag_dict = _tag_dict   # 本次请求固定用同一份快照，避免重载时新旧混用
    _load_trans_cache()
    mode = translate_mode()
    translations: dict[str, str] = {}
    key = cache_key()
    with _cache_lock:
        bucket = _trans_cache.setdefault(key, {}) if key else {}

    pending: list[str] = []
    seen: set[str] = set()
    dict_used = False
    llm_used = False
    fallback: dict[str, str] = {}
    for raw in tags:
        tag = str(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        dv = None if mode == "llm" else tag_dict.get(_normalize_tag(tag))
        if mode == "dict":
            if dv:
                translations[tag] = dv
                dict_used = True
            continue
        if dv and not _dict_value_questionable(dv):
            translations[tag] = dv
            dict_used = True
        elif dv:
            fallback[tag] = dv
            if not force and tag in bucket:
                translations[tag] = bucket[tag]
                llm_used = True
            else:
                pending.append(tag)
        elif not force and tag in bucket:
            translations[tag] = bucket[tag]
            llm_used = True
        elif " " not in tag and re.search(r"\d", tag):
            translations[tag] = tag
        else:
            pending.append(tag)

    engine_note = ""
    if pending:
        got = translate(pending)
        if not got:
            engine_note = _llm_last_note or _llm_load_error or "Local LLM is not available"
        for tag, zh in got.items():
            if zh and zh != tag:
                translations[tag] = zh
                with _cache_lock:
                    bucket[tag] = zh
                llm_used = True
        if got:
            with _cache_lock:
                _trans_cache[key] = bucket
                _save_trans_cache()

    for tag in pending:
        cur = translations.get(tag)
        if not cur or cur == tag:
            translations[tag] = fallback.get(tag, tag)

    return {
        "ok": True,
        "translations": translations,
        "engine": "llm" if llm_used else ("dict" if dict_used else "none"),
        "note": engine_note,
        "forced": bool(force),
    }


# ---------- GGUF 模型下载（官方站优先，失败回退 hf-mirror） ----------
HF_ENDPOINTS = ("https://huggingface.co", "https://hf-mirror.com")
_hf_endpoint_cache: str = ""
_download_state: dict[str, Any] = {
    "active": False, "filename": "", "repo": "", "done": 0, "total": 0,
    "error": "", "ok": False, "endpoint": "", "attempt": 0,
}
_download_lock = threading.Lock()

DL_MAX_ATTEMPTS = 8
DL_READ_TIMEOUT = 60
DL_CHUNK = 1024 * 256


def _pick_hf_endpoint(force: bool = False) -> str:
    global _hf_endpoint_cache
    if _hf_endpoint_cache and not force:
        return _hf_endpoint_cache
    for base in HF_ENDPOINTS:
        try:
            req = urllib.request.Request(base, method="HEAD")
            with urllib.request.urlopen(req, timeout=6) as resp:
                if resp.status < 500:
                    _hf_endpoint_cache = base
                    return base
        except Exception:
            continue
    _hf_endpoint_cache = HF_ENDPOINTS[-1]
    return _hf_endpoint_cache


def _normalize_repo(s: str) -> str:
    s = (s or "").strip()
    for host in ("https://huggingface.co/", "http://huggingface.co/",
                 "https://hf-mirror.com/", "http://hf-mirror.com/"):
        if s.lower().startswith(host):
            s = s[len(host):]
            break
    for marker in ("/tree/main", "/tree/master", "/tree/", "/resolve/main/",
                   "/blob/main/", "/blob/"):
        if marker in s:
            s = s.split(marker)[0]
            break
    return s.strip("/ ")


def _hf_list_gguf(repo: str) -> list[dict]:
    repo = _normalize_repo(repo)
    if not repo or "/" not in repo:
        return []
    base = _pick_hf_endpoint()
    url = f"{base}/api/models/{repo}?blobs=true"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sd-forge-lora-new"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except Exception:
        return []
    out: list[dict] = []
    for item in data.get("siblings", []) or []:
        fn = str(item.get("rfilename") or "")
        if not fn.lower().endswith(".gguf"):
            continue
        size = item.get("size")
        if size is None:
            blob = item.get("blobId")
            size = item.get("lfs", {}).get("size") if isinstance(item.get("lfs"), dict) else None
            if size is None and isinstance(blob, dict):
                size = blob.get("size")
        out.append({"filename": fn, "size": int(size or 0)})
    return out


def repo_files(repo: str) -> dict:
    repo = _normalize_repo(repo)
    if not repo or "/" not in repo:
        return {"ok": False, "error": "Repository must be in owner/name form"}
    files = _hf_list_gguf(repo)
    if not files:
        return {"ok": False, "error": "No GGUF files found in this repository", "repo": repo}
    files.sort(key=lambda x: x["filename"])
    return {"ok": True, "repo": repo, "files": files,
            "endpoint": _pick_hf_endpoint(), "dir": str(llm_dir())}


def _download_worker(repo: str, filename: str) -> None:
    base = _pick_hf_endpoint()
    url = f"{base}/{repo}/resolve/main/{filename}"
    dest = llm_dir().joinpath(*[p for p in filename.split("/") if p])
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err = ""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(1, DL_MAX_ATTEMPTS + 1):
            got = tmp.stat().st_size if tmp.exists() else 0
            headers = {"User-Agent": "sd-forge-lora-new"}
            if got:
                headers["Range"] = f"bytes={got}-"
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=DL_READ_TIMEOUT) as resp:
                    if got and resp.status != 206:
                        got = 0
                    clen = int(resp.headers.get("Content-Length") or 0)
                    total = (got + clen) if clen else got
                    with _download_lock:
                        _download_state.update(total=total, endpoint=base, done=got, attempt=attempt)
                    with tmp.open("ab" if got else "wb") as fh:
                        while True:
                            chunk = resp.read(DL_CHUNK)
                            if not chunk:
                                break
                            fh.write(chunk)
                            with _download_lock:
                                _download_state["done"] += len(chunk)
            except Exception as e:
                last_err = f"{e}"
                continue
            size = tmp.stat().st_size if tmp.exists() else 0
            if total and size < total:
                last_err = f"Incomplete download ({size}/{total} bytes)"
                continue
            tmp.replace(dest)
            with _download_lock:
                _download_state.update(active=False, ok=True, error="")
            return
        raise RuntimeError(last_err or "Download retries exhausted")
    except Exception as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        with _download_lock:
            _download_state.update(active=False, ok=False, error=f"Download failed: {e}")


def start_download(repo: str, filename: str) -> dict:
    repo = _normalize_repo(repo)
    filename = str(filename or "")
    if not repo or "/" not in repo:
        return {"ok": False, "error": "Invalid repo"}
    if not filename.lower().endswith(".gguf") or ".." in filename:
        return {"ok": False, "error": "Invalid filename"}
    with _download_lock:
        if _download_state["active"]:
            return {"ok": False, "error": "Download busy"}
        _download_state.update(active=True, ok=False, error="", filename=filename,
                               repo=repo, done=0, total=0, endpoint="")
    threading.Thread(target=_download_worker, args=(repo, filename), daemon=True).start()
    return {"ok": True, "filename": filename}


def download_status() -> dict:
    with _download_lock:
        return dict(_download_state)


# ---------- 运行时探测与 CUDA 轮子 ----------
_runtime_probe_lock = threading.Lock()
_runtime_probe_cache: dict[str, Any] = {"at": 0.0, "value": None}
RUNTIME_PROBE_TTL = 60.0

_runtime_dl_lock = threading.Lock()
_runtime_dl_state: dict[str, Any] = {
    "active": False, "done": 0, "total": 0, "error": "", "ok": False, "attempt": 0,
}


def probe_runtime(force: bool = False) -> dict:
    """子进程探测 llama-cpp-python 的构建类型（CUDA 版导入失败可能直接杀进程）。"""
    with _runtime_probe_lock:
        cached = _runtime_probe_cache["value"]
        if not force and cached is not None and (time.time() - _runtime_probe_cache["at"]) < RUNTIME_PROBE_TTL:
            return cached
    _prepare_llama_dll_env()
    result = {"installed": False, "usable": False, "build": "", "error": ""}
    code = (
        "import llama_cpp;"
        "info=llama_cpp.llama_print_system_info();"
        "info=info.decode('utf-8','ignore') if isinstance(info,bytes) else str(info);"
        "print('__LNA_CUDA__' if 'CUDA' in info else '__LNA_CPU__')"
    )
    try:
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
        if p.returncode == 0:
            out = p.stdout or ""
            result["installed"] = True
            result["usable"] = True
            result["build"] = "cuda" if "__LNA_CUDA__" in out else ("cpu" if "__LNA_CPU__" in out else "")
        else:
            result["error"] = (p.stderr or "").strip()[-300:]
    except Exception as e:
        result["error"] = str(e)
    if not result["installed"]:
        try:
            result["installed"] = importlib.util.find_spec("llama_cpp") is not None
        except Exception:
            result["installed"] = False
    with _runtime_probe_lock:
        _runtime_probe_cache.update(at=time.time(), value=result)
    return result


def _nvidia_driver() -> str:
    try:
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15,
        )
    except Exception:
        return ""
    if p.returncode != 0:
        return ""
    lines = [ln.strip() for ln in (p.stdout or "").splitlines() if ln.strip()]
    return lines[0] if lines else ""


def nvidia_ok() -> tuple[bool, str]:
    ver = _nvidia_driver()
    nums = re.findall(r"\d+", ver)
    ok = len(nums) >= 2 and (int(nums[0]), int(nums[1])) >= MIN_CUDA_DRIVER
    return ok, ver


def _cuda_wheel_path() -> Path:
    return CUDA_WHEELS_DIR / CUDA_WHEEL_NAME


def cuda_wheel_downloaded() -> bool:
    try:
        return _cuda_wheel_path().is_file()
    except Exception:
        return False


def _cuda_wheel_partial_size() -> int:
    p = _cuda_wheel_path()
    part = p.with_suffix(p.suffix + ".part")
    try:
        return part.stat().st_size if part.is_file() else 0
    except Exception:
        return 0


def _remote_file_size(url: str) -> int:
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "sd-forge-lora-new", "Range": "bytes=0-0"}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            content_range = resp.headers.get("Content-Range") or ""
            if "/" in content_range:
                tail = content_range.rsplit("/", 1)[-1].strip()
                if tail.isdigit():
                    return int(tail)
            return int(resp.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def _cuda_wheel_worker() -> None:
    dest = _cuda_wheel_path()
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err = ""
    total = 0
    try:
        CUDA_WHEELS_DIR.mkdir(parents=True, exist_ok=True)
        remote_size = _remote_file_size(CUDA_WHEEL_URL)
        if tmp.exists() and remote_size:
            have = tmp.stat().st_size
            if have > remote_size:
                tmp.unlink()
            elif have == remote_size:
                tmp.replace(dest)
                with _runtime_dl_lock:
                    _runtime_dl_state.update(active=False, ok=True, error="")
                return
        for attempt in range(1, DL_MAX_ATTEMPTS + 1):
            got = tmp.stat().st_size if tmp.exists() else 0
            if remote_size and got >= remote_size:
                break
            headers = {"User-Agent": "sd-forge-lora-new"}
            if got:
                headers["Range"] = f"bytes={got}-"
            try:
                req = urllib.request.Request(CUDA_WHEEL_URL, headers=headers)
                with urllib.request.urlopen(req, timeout=DL_READ_TIMEOUT) as resp:
                    if got and resp.status != 206:
                        got = 0
                    clen = int(resp.headers.get("Content-Length") or 0)
                    total = (got + clen) if clen else (remote_size or got)
                    with _runtime_dl_lock:
                        _runtime_dl_state.update(done=got, total=total, attempt=attempt)
                    with tmp.open("ab" if got else "wb") as fh:
                        while True:
                            chunk = resp.read(DL_CHUNK)
                            if not chunk:
                                break
                            fh.write(chunk)
                            with _runtime_dl_lock:
                                _runtime_dl_state["done"] += len(chunk)
            except urllib.error.HTTPError as e:
                if e.code == 416 and tmp.exists():
                    tmp.unlink()
                    last_err = "Resume offset invalid, restarting"
                    continue
                last_err = f"{e}"
                continue
            except Exception as e:
                last_err = f"{e}"
                continue
            size = tmp.stat().st_size if tmp.exists() else 0
            expected = remote_size or total
            if expected and size != expected:
                last_err = f"Incomplete download ({size}/{expected} bytes)"
                continue
            tmp.replace(dest)
            with _runtime_dl_lock:
                _runtime_dl_state.update(active=False, ok=True, error="")
            return
        size = tmp.stat().st_size if tmp.exists() else 0
        if remote_size and size == remote_size:
            tmp.replace(dest)
            with _runtime_dl_lock:
                _runtime_dl_state.update(active=False, ok=True, error="")
            return
        raise RuntimeError(last_err or "Download retries exhausted")
    except Exception as e:
        kept = 0
        try:
            kept = tmp.stat().st_size if tmp.exists() else 0
        except Exception:
            kept = 0
        hint = f" Partial file kept ({kept // 1048576} MB), retry to resume." if kept else ""
        with _runtime_dl_lock:
            _runtime_dl_state.update(active=False, ok=False, error=f"Download failed: {e}{hint}")


def runtime_info(force: bool = False) -> dict:
    probe = probe_runtime(force=bool(force))
    nv_ok, nv_ver = nvidia_ok()
    return {
        "ok": True,
        "installed": probe["installed"],
        "usable": probe["usable"],
        "build": probe["build"],
        "version": RUNTIME_VERSION,
        "cuda_wheel_ready": cuda_wheel_downloaded(),
        "nvidia_ok": nv_ok,
        "driver": nv_ver,
        "min_driver": ".".join(str(x) for x in MIN_CUDA_DRIVER),
        "error": probe.get("error", ""),
    }


def start_cuda_download() -> dict:
    if cuda_wheel_downloaded():
        return {"ok": True, "already": True}
    nv_ok, nv_ver = nvidia_ok()
    if not nv_ok:
        return {"ok": False, "error": "No NVIDIA GPU", "driver": nv_ver}
    with _runtime_dl_lock:
        if _runtime_dl_state["active"]:
            return {"ok": False, "error": "Download busy"}
        _runtime_dl_state.update(active=True, ok=False, error="",
                                 done=_cuda_wheel_partial_size(), total=0, attempt=0)
    threading.Thread(target=_cuda_wheel_worker, daemon=True, name="lna-cuda-wheel").start()
    return {"ok": True}


def runtime_download_status() -> dict:
    with _runtime_dl_lock:
        st = dict(_runtime_dl_state)
    return {
        "ok": True,
        "active": st["active"],
        "done": st["done"],
        "total": st["total"],
        "attempt": st["attempt"],
        "error": st["error"],
        "finished": st["ok"],
        "cuda_wheel_ready": cuda_wheel_downloaded(),
    }
