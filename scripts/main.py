"""sd_forge_lora_new — 自定义 LoRA 管理器后端
注入到 txt2img_extra_tabs / img2img_extra_tabs，替代原版 sd_forge_lora 的 Extra Networks 页面。
"""
from __future__ import annotations

import csv
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
from pathlib import Path
from typing import Any

import gradio as gr
from fastapi import FastAPI, File, UploadFile
from fastapi.staticfiles import StaticFiles

from modules import paths, script_callbacks

# ---------- 界面多语言（i18n） ----------
# 语言包与实现位于插件根目录的 lna_i18n 包（顶层可导入，与 lna_lora_engine 同机制）。
# 导入失败时 _i18n 为 None，_t() 退化为原样返回 key，界面回落为 key 文本，不影响功能。
try:
    from lna_i18n import core as _i18n
except Exception:
    _i18n = None


def _t(key: str, **vars) -> str:
    """后端文案多语言取值（实现见 lna_i18n.t）。"""
    return _i18n.t(key, **vars) if _i18n is not None else key


# ---------- 路径 ----------
EXT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = EXT_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
STATS_FILE = DATA_DIR / "stats.json"
# 标签翻译：两级对照
# 1) group_tags.zh_CN.csv  由 sd-webui-prompt-all-in-one 插件的 group_tags/zh_CN.yaml
#                          生成（按人物/服饰/表情等分类整理，译文干净；同义词串只取首段，
#                          不可信值不收录），命中即用
# 2) 未收录标签            → GGUF 模型实时翻译（结果缓存）
DICT_FILE = DATA_DIR / "group_tags.zh_CN.csv"
TRANSLATIONS_FILE = DATA_DIR / "translations.json"
# 卡片设置资料：按模型存 JSON（镜像 LoRA 目录结构，文件名加 _new 后缀）。
# 预览图像不进 JSON，仍与模型同目录同名存放（与旧版一致）。
JSON_DATA_DIR = EXT_DIR / "models_json_data"

# LLM（GGUF）模型目录：<models>/LLM，不存在则自动创建
try:
    from modules import paths as _paths
    LLM_DIR = Path(_paths.models_path) / "LLM"
except Exception:
    LLM_DIR = EXT_DIR / "models" / "LLM"
try:
    LLM_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

# 翻译运行时（llama-cpp-python）随插件分发的 CPU 轮子目录；
# wheels/cuda/ 存放用户在设置里按需下载的 CUDA 轮子（两处轮子文件名相同，靠目录区分）
WHEELS_DIR = EXT_DIR / "wheels"
CUDA_WHEELS_DIR = WHEELS_DIR / "cuda"
RUNTIME_VERSION = "0.3.36"  # 与随插件分发的 CPU 轮子保持一致
CUDA_WHEEL_NAME = f"llama_cpp_python-{RUNTIME_VERSION}-py3-none-win_amd64.whl"
CUDA_WHEEL_URL = (
    f"https://github.com/abetlen/llama-cpp-python/releases/download/"
    f"v{RUNTIME_VERSION}-cu124/{CUDA_WHEEL_NAME}"
)
MIN_CUDA_DRIVER = (527, 41)  # cu124 要求的最低 NVIDIA 驱动版本

# LoRA 目录
try:
    from modules import shared
    LORA_DIR = Path(getattr(shared.cmd_opts, "lora_dir", None) or (Path(paths.models_path) / "Lora"))
except Exception:
    LORA_DIR = Path(paths.models_path) / "Lora"

LORA_EXTS = {".safetensors", ".ckpt", ".pt"}

# ---------- 统计数据持久化 ----------
_stats: dict[str, Any] = {
    "usage_count": {},
    "last_viewed": {},
    "custom_previews": {},
    "user_metadata": {},
    "llm_model": "",   # 标签翻译选中的 GGUF 模型（LLM_DIR 下的相对路径）
    "llm_gpu": False,  # False=CPU 推理（默认，不与 SD 抢显存）；True=GPU 加速
    "llm_auto_unload": True,   # 空闲时自动卸载模型，释放显存/内存
    "llm_idle_minutes": 5,     # 空闲多久后卸载（分钟，范围见 IDLE_MIN/MAX）
    "translate_mode": "hybrid",  # 翻译方案：dict=仅用对照表 / llm=仅用模型 / hybrid=混合
    "prompt_presets": {},      # 翻译提示预设：{预设名: 提示文本}
    "active_prompt": "",       # 当前启用的提示预设名（空 = 内置默认预设）
}


def _load_stats() -> None:
    global _stats
    if STATS_FILE.exists():
        try:
            data = json.loads(STATS_FILE.read_text(encoding="utf-8"))
            for k in _stats:
                if k in data:
                    _stats[k] = data[k]
        except Exception:
            pass


def _save_stats() -> None:
    try:
        STATS_FILE.write_text(
            json.dumps(_stats, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass


_load_stats()


# ---------- 插件界面设置持久化 ----------
# 前端控件状态（卡片排序方式、各类显示开关、卡片尺寸等）存这里，位于插件目录内，
# 与 stats.json / translations.json 同级。前端启动时读取，改动时整包回写。
UI_SETTINGS_FILE = DATA_DIR / "ui_settings.json"
# 白名单 + 类型：只接受已知键，防止前端写入无关字段或非法类型
UI_SETTINGS_KEYS: dict[str, type] = {
    "searchSubfolders": bool,
    "onlyLora": bool,
    "showFolderCards": bool,
    "showAllModels": bool,
    "showPreviews": bool,
    "showTagZh": bool,
    "lockRatio": bool,
    "sortKey": str,
    "sortDir": str,
    "cardWidth": int,
    "cardHeight": int,
    "sidebarWidth": int,
    "bodyHeight": int,
    "uiLang": str,          # 界面语言代码（如 zh_CN / en_US），见 lna_i18n
}
_ui_settings: dict[str, Any] = {}
_ui_settings_lock = threading.RLock()


def _load_ui_settings() -> None:
    global _ui_settings
    if not UI_SETTINGS_FILE.exists():
        return
    try:
        data = json.loads(UI_SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _ui_settings = {k: v for k, v in data.items() if k in UI_SETTINGS_KEYS}
    except Exception:
        pass


def _save_ui_settings() -> None:
    """原子写（临时文件 + replace），避免并发读到半截 JSON。"""
    try:
        UI_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = UI_SETTINGS_FILE.with_suffix(UI_SETTINGS_FILE.suffix + ".tmp")
        with _ui_settings_lock:
            tmp.write_text(json.dumps(_ui_settings, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(UI_SETTINGS_FILE)
    except Exception:
        pass


def _update_ui_settings(patch: dict) -> dict:
    """按白名单合并前端提交的设置；未出现的键保持不变。返回合并后的全集。"""
    with _ui_settings_lock:
        for k, v in (patch or {}).items():
            t = UI_SETTINGS_KEYS.get(k)
            if t is None:
                continue
            if t is bool:
                if isinstance(v, bool):
                    _ui_settings[k] = v
            elif t is int:
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    _ui_settings[k] = int(round(float(v)))
            elif isinstance(v, str):
                _ui_settings[k] = v
        _save_ui_settings()
        return dict(_ui_settings)


_load_ui_settings()

# 界面语言：以持久化的 uiLang 为准初始化（缺失或非法时回落默认 zh_CN）
if _i18n is not None:
    _i18n.set_lang(_ui_settings.get("uiLang") or "")


# ---------- 文件扫描 ----------
def _find_preview(parent: Path, stem: str) -> str | None:
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = parent / (stem + ext)
        if p.exists():
            return str(p.relative_to(LORA_DIR)).replace("\\", "/")
    for ext in (".safetensors.jpeg", ".safetensors.jpg"):
        p = parent / (stem + ext)
        if p.exists():
            return str(p.relative_to(LORA_DIR)).replace("\\", "/")
    return None


def _read_trigger(parent: Path, stem: str) -> str:
    f = parent / (stem + ".txt")
    if f.exists():
        try:
            return f.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            return ""
    return ""


def _rel(p: Path) -> str:
    return str(p.relative_to(LORA_DIR)).replace("\\", "/")


def _preview_ver(rel: str | None) -> int:
    """预览图版本号（文件 mtime 纳秒）。前端把它拼到图片 URL 后，替换/重新生成预览图后
    浏览器不会再命中旧缓存；读取失败返回 0 表示「无版本」。"""
    if not rel:
        return 0
    try:
        return (LORA_DIR / rel).stat().st_mtime_ns
    except Exception:
        return 0


def _safe_rel(rel: str) -> str:
    """清洗相对路径，阻止 .. 目录穿越；非法则回退到根目录。"""
    if not rel:
        return ""
    parts = [seg for seg in str(rel).replace("\\", "/").split("/") if seg not in ("", ".")]
    if any(seg == ".." for seg in parts):
        return ""
    return "/".join(parts)


def _lora_entry(e: Path) -> dict | None:
    """构建单个 LoRA 文件的数据条目，失败返回 None"""
    try:
        st = e.stat()
    except Exception:
        return None
    rel_key = _rel(e)
    preview = _stats["custom_previews"].get(rel_key) or _find_preview(e.parent, e.stem)
    return {
        "name": e.stem,
        "filename": e.name,
        "rel": rel_key,
        "size": st.st_size,
        "created": st.st_ctime,
        "modified": st.st_mtime,
        "preview": preview,
        "preview_ver": _preview_ver(preview),
        "trigger": _read_trigger(e.parent, e.stem),
        "description": _get_card_desc(rel_key),
        "usage_count": _stats["usage_count"].get(rel_key, 0),
        "last_viewed": _stats["last_viewed"].get(rel_key, 0),
    }


def _count_loras(dir_path: Path) -> int:
    """统计该目录**直属**的 LoRA 文件数量（不含子文件夹里的）。"""
    try:
        return sum(
            1 for f in dir_path.iterdir()
            if f.is_file() and f.suffix.lower() in LORA_EXTS
        )
    except Exception:
        return 0


def _count_loras_recursive(dir_path: Path) -> int:
    """统计该目录（含所有子文件夹）下的 LoRA 文件总数。"""
    count = 0
    try:
        for _root, _dirs, files in os.walk(dir_path):
            for fn in files:
                if Path(fn).suffix.lower() in LORA_EXTS:
                    count += 1
    except Exception:
        pass
    return count


# 文件夹自定义封面文件名（无扩展名），与 LoRA 预览图一样保存在文件夹内
FOLDER_COVER_STEM = "_lora_new_cover"


def _find_folder_preview(dir_path: Path) -> str | None:
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = dir_path / (FOLDER_COVER_STEM + ext)
        if p.exists():
            return _rel(p)
    return None


def library_stats() -> dict:
    """统计整个 LoRA 目录（含所有子文件夹）的模型总数与总大小（字节）。"""
    count = 0
    size = 0
    try:
        for root, _dirs, files in os.walk(LORA_DIR):
            for fn in files:
                p = Path(root) / fn
                if p.suffix.lower() not in LORA_EXTS:
                    continue
                try:
                    size += p.stat().st_size
                    count += 1
                except Exception:
                    continue  # 单个文件读取失败则跳过，不影响汇总
    except Exception:
        pass
    return {"count": count, "size": size}


def build_tree(dir_path: Path) -> list[dict]:
    nodes = []
    try:
        entries = sorted(
            [e for e in dir_path.iterdir() if e.is_dir()],
            key=lambda x: x.name.lower(),
        )
    except Exception:
        return nodes
    for e in entries:
        children = build_tree(e)
        count = _count_loras(e)
        nodes.append({
            "name": e.name,
            "rel": _rel(e),
            "count": count,                                    # 直属模型数量
            "total": count + sum(c["total"] for c in children),  # 含所有子文件夹的总数
            "children": children,
        })
    return nodes


def list_dir(rel: str = "") -> dict:
    abs_dir = (LORA_DIR / rel) if rel else LORA_DIR
    folders: list[dict] = []
    loras: list[dict] = []
    if not abs_dir.exists():
        return {"folders": folders, "loras": loras}

    entries = sorted(abs_dir.iterdir(), key=lambda x: x.name.lower())
    for e in entries:
        if e.is_dir():
            pv = _find_folder_preview(e)
            folders.append({"name": e.name, "rel": _rel(e), "preview": pv, "preview_ver": _preview_ver(pv)})
        elif e.suffix.lower() in LORA_EXTS:
            item = _lora_entry(e)
            if item:
                loras.append(item)
    return {"folders": folders, "loras": loras}


def search_all(rel: str, query: str) -> dict:
    """在 rel 目录下递归收集子文件夹与 LoRA 文件。

    query 为空时不做名称过滤（返回整棵子树），非空时按名称模糊匹配。
    """
    folders: list[dict] = []
    loras: list[dict] = []
    q = (query or "").lower()
    abs_dir = (LORA_DIR / rel) if rel else LORA_DIR
    if not abs_dir.exists():
        return {"folders": folders, "loras": loras}
    try:
        for root, dirs, files in os.walk(abs_dir):
            dirs.sort(key=lambda x: x.lower())
            root_path = Path(root)
            # 子文件夹名匹配（不含基准目录自身）
            for d in dirs:
                if not q or q in d.lower():
                    d_path = root_path / d
                    pv = _find_folder_preview(d_path)
                    folders.append({"name": d, "rel": _rel(d_path), "preview": pv, "preview_ver": _preview_ver(pv)})
            # LoRA 文件名匹配
            for fn in sorted(files, key=lambda x: x.lower()):
                p = root_path / fn
                if p.suffix.lower() not in LORA_EXTS:
                    continue
                if q and q not in p.stem.lower():
                    continue
                item = _lora_entry(p)
                if item:
                    loras.append(item)
    except Exception:
        pass
    return {"folders": folders, "loras": loras}


def read_lora_metadata(rel: str) -> dict:
    """读取 safetensors 内部元数据（__metadata__ 头），带 mtime 缓存。

    复用 WebUI 的 sd_models.read_metadata_from_safetensors 与 cache.cached_data_for_file。
    """
    safe = _safe_rel(rel)
    if not safe:
        return {"ok": False, "error": _t("err.invalidPath")}
    path = LORA_DIR / safe
    if not path.is_file() or path.suffix.lower() not in LORA_EXTS:
        return {"ok": False, "error": _t("err.fileNotFound")}
    if path.suffix.lower() != ".safetensors":
        return {"ok": False, "error": _t("err.safetensorsOnly")}
    try:
        # 延迟导入，避免扩展加载时引入 sd_models 的重依赖
        from modules import cache, sd_models

        def _read() -> dict:
            return sd_models.read_metadata_from_safetensors(str(path))

        meta = cache.cached_data_for_file(
            "safetensors-metadata", "lora_new/" + safe, str(path), _read
        ) or {}
    except Exception as e:
        return {"ok": False, "error": _t("err.readFailed", msg=e)}

    # 与内置实现一致：封面字段过大，不适合在 UI 中以文本展示
    meta = {k: v for k, v in meta.items() if k != "ssmd_cover_images"}
    return {"ok": True, "metadata": meta}


# ---------- 卡片设置页数据 ----------
def _human_size(n: int) -> str:
    try:
        n = int(n)
    except Exception:
        return ""
    if n >= 1073741824:
        return f"{n / 1073741824:.2f}GB"
    if n >= 1048576:
        return f"{n / 1048576:.0f}MB"
    if n >= 1024:
        return f"{n / 1024:.0f}KB"
    return f"{n}B"


def build_tags(metadata: dict) -> list[list]:
    """从 ss_tag_frequency 汇总训练标签，按出现次数降序（移植自内置 sd_forge_lora）。"""
    tags: dict[str, int] = {}
    freq = metadata.get("ss_tag_frequency")
    if isinstance(freq, dict):
        for tag_map in freq.values():
            if not isinstance(tag_map, dict):
                continue
            for tag, cnt in tag_map.items():
                tag = str(tag).strip()
                try:
                    tags[tag] = tags.get(tag, 0) + int(cnt)
                except Exception:
                    continue
    if tags:
        # 平均标签长度 >= 16 视为自然语句型，按词拆分统计
        avg_len = sum(len(k) for k in tags) / len(tags)
        if avg_len >= 16:
            split: dict[str, int] = {}
            for text, cnt in tags.items():
                for word in re.findall(r"[-_\w']+", text):
                    if len(word) < 3:
                        continue
                    split[word] = split.get(word, 0) + cnt
            tags = split
    return [[t, tags[t]] for t in sorted(tags, key=tags.get, reverse=True)]


def _detect_sd_version(meta: dict) -> str:
    if str(meta.get("modelspec.implementation", "")) == "https://github.com/black-forest-labs/flux":
        return "Flux"
    arch = str(meta.get("modelspec.architecture", ""))
    if arch == "flux-1-dev/lora":
        return "Flux"
    if arch == "stable-diffusion-xl-v1-base/lora":
        return "SDXL"
    if str(meta.get("ss_base_model_version", "")).startswith("sdxl_"):
        return "SDXL"
    if str(meta.get("ss_v2", "")) == "True":
        return "SD2"
    if arch == "stable-diffusion-v1/lora":
        return "SD1"
    return "Unknown"


def _short_hash(path: Path, rel: str, meta: dict) -> str:
    """短哈希：优先用 safetensors 内记录的哈希，缺失才回退到 WebUI 的文件哈希缓存。"""
    h = str(meta.get("ss_new_sd_model_hash") or meta.get("sshs_model_hash") or "")
    if not h:
        try:
            from modules import hashes

            h = hashes.sha256_from_cache(
                str(path), "lora_new/" + rel,
                use_addnet_hash=path.suffix.lower() == ".safetensors",
            ) or ""
        except Exception:
            h = ""
    return str(h)[:10]


def card_info(rel: str) -> dict:
    """卡片设置弹窗所需的全部数据：文件信息、元数据表、训练标签、用户元数据。"""
    safe = _safe_rel(rel)
    if not safe:
        return {"ok": False, "error": _t("err.invalidPath")}
    path = LORA_DIR / safe
    if not path.is_file() or path.suffix.lower() not in LORA_EXTS:
        return {"ok": False, "error": _t("err.fileNotFound")}
    try:
        st = path.stat()
    except Exception:
        return {"ok": False, "error": _t("err.readFileInfo")}

    meta: dict = {}
    if path.suffix.lower() == ".safetensors":
        try:
            from modules import cache, sd_models

            meta = cache.cached_data_for_file(
                "safetensors-metadata", "lora_new/" + safe, str(path),
                lambda: sd_models.read_metadata_from_safetensors(str(path)),
            ) or {}
        except Exception:
            meta = {}
    meta.pop("ssmd_cover_images", None)

    table: list[dict] = [
        {"key": "filename", "label": _t("info.filename"), "value": safe},
        {"key": "size", "label": _t("info.size"), "value": _human_size(st.st_size)},
        {"key": "hash", "label": _t("info.hash"), "value": _short_hash(path, safe, meta)},
        {"key": "modified", "label": _t("info.modified"), "value": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))},
    ]
    for key, label in (
        ("ss_output_name", _t("info.outputName")),
        ("ss_sd_model_name", _t("info.model")),
        ("ss_clip_skip", _t("info.clipSkip")),
        ("ss_network_module", _t("info.kohyaModule")),
    ):
        val = meta.get(key)
        if val is not None and str(val) != "None":
            table.append({"label": label, "value": str(val)})

    started = meta.get("ss_training_started_at")
    if started:
        try:
            table.append({
                "label": _t("info.trainDate"),
                "value": time.strftime("%Y-%m-%d %H:%M", time.localtime(float(started))),
            })
        except Exception:
            pass

    bucket = meta.get("ss_bucket_info")
    if isinstance(bucket, dict) and isinstance(bucket.get("buckets"), dict):
        res: dict[str, int] = {}
        for b in bucket["buckets"].values():
            try:
                r = b["resolution"]
                key = f"{r[1]}x{r[0]}"
                res[key] = res.get(key, 0) + int(b.get("count", 0))
            except Exception:
                continue
        if res:
            ordered = sorted(res, key=res.get, reverse=True)
            table.append({
                "label": _t("info.resolution"),
                "value": ", ".join(ordered[:4]) + (", ..." if len(ordered) > 4 else ""),
                "title": ", ".join(ordered),
            })

    img_count = 0
    dataset_dirs = meta.get("ss_dataset_dirs")
    if isinstance(dataset_dirs, dict):
        for params in dataset_dirs.values():
            try:
                img_count += int(params.get("img_count", 0))
            except Exception:
                continue
    if img_count:
        table.append({"label": _t("info.datasetSize"), "value": str(img_count)})

    tags = build_tags(meta)[:24]
    # 卡片资料改从 models_json_data 的镜像 JSON 读取；首次访问时补齐重定向锚点
    user = _get_card_data(safe)
    if not user.get("hash") or not user.get("size"):
        if not user.get("hash"):
            hash_row = next((r for r in table if r.get("key") == "hash"), None)
            user["hash"] = hash_row["value"] if hash_row else ""
        user["size"] = st.st_size
        user["tags"] = [[t, c] for t, c in tags]
        _save_card_json(safe, user)

    zh_map = user.get("translations")
    zh_map = zh_map.get("zh", {}) if isinstance(zh_map, dict) else {}
    preview = _stats["custom_previews"].get(safe) or _find_preview(path.parent, path.stem)
    return {
        "ok": True,
        "rel": safe,
        "name": path.stem,
        "preview": preview,
        "preview_ver": _preview_ver(preview),
        "table": table,
        "tags": tags,
        "sd_version": _detect_sd_version(meta),
        "user": user,
        "tag_translations": zh_map,   # 已持久化的中文对照，前端据此显示/占位
    }


def folder_info(rel: str) -> dict:
    """文件夹卡片设置弹窗所需数据：路径、模型个数、封面、描述。"""
    safe = _safe_rel(rel)
    abs_dir = (LORA_DIR / safe) if safe else LORA_DIR
    if not abs_dir.is_dir():
        return {"ok": False, "error": _t("err.folderNotFound")}
    pv = _find_folder_preview(abs_dir)
    return {
        "ok": True,
        "rel": safe,
        "name": abs_dir.name,
        "path": str(abs_dir),
        "count": _count_loras_recursive(abs_dir),
        "preview": pv,
        "preview_ver": _preview_ver(pv),
        "description": str(_get_card_data(safe).get("description", "")),
    }


# ---------- 标签翻译（词典优先 + opus-mt 兜底） ----------
_tag_dict: dict[str, str] = {}   # 归一化英文标签 → 中文
_dict_loaded = False
_trans_cache: dict[str, dict[str, str]] = {}  # 模型名 → {标签: 译文}，避免重复推理
_trans_loaded = False
_llm = None          # 当前已加载的 llama_cpp.Llama 实例
_llm_path = ""       # 该实例对应的模型绝对路径
_llm_load_error = ""
_cuda_checked = False  # CUDA 后端探测结果缓存（进程内只查一次）
_cuda_ok = False
_llm_lock = threading.RLock()  # llama_cpp 非线程安全：加载/推理/卸载全程串行，防并发 segfault
_llm_last_used = 0.0           # 上次推理完成的时间戳；空闲卸载据此计时
_watchdog_started = False      # 守护线程只启动一次
# 全局翻译任务标记（跨浏览器标签页共享同一后端，防重复发起）
_translate_state: dict[str, Any] = {"busy": False}
_translate_state_lock = threading.Lock()

IDLE_MIN_DEFAULT = 5   # 空闲卸载默认时长（分钟）
IDLE_MIN = 3           # 下限
IDLE_MAX = 200         # 上限
IDLE_POLL_SECONDS = 10  # 守护线程检查间隔


def _clamp_idle_minutes(value: Any) -> int:
    """把空闲分钟数收敛到 [IDLE_MIN, IDLE_MAX]，非法值回退默认。"""
    try:
        n = int(round(float(value)))
    except Exception:
        return IDLE_MIN_DEFAULT
    return max(IDLE_MIN, min(IDLE_MAX, n))


def _normalize_tag(tag: str) -> str:
    """归一化标签：去空白、转小写、空格转下划线，便于与词表匹配。"""
    return str(tag).strip().lower().replace(" ", "_")


_ASCII_WORD_RE = re.compile(r"[A-Za-z]{2,}")   # 连续 2 个以上字母才算「残留英文词」
_REPEAT_CJK_RE = re.compile(r"([\u4e00-\u9fff]{2,})(?=.*\1)")
_PAREN_RE = re.compile(r"[（(][^）)]*[）)]")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 「英文名」形态：可含空格、数字、. ' - ! & +，其余字符（尤其中文）不算
_NAME_CHUNK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’.\-!&+ ]*")

DICT_MAX_LEN = 20   # 超过此长度视为多段串接


def _dict_value_questionable(value: str) -> bool:
    """对照表译文质量校验：命中任一特征即判为不可信，改由模型翻译。

    这份对照表源自机翻，第二列是「标签 + 全部别名」译文的串接，典型缺陷：
      - 串接重复：「蓝眼睛浅蓝色的眼睛」「女学生校服女学生 seifuku」
      - 残留英文词：「pov 目光接触」（括号外出现英文词，单个字母不算，
        如「V字眉」「哆啦A梦」属正常）
      - 超长串接：多个别名译文堆在一起（超过 DICT_MAX_LEN 字符）
    正常放行：
      - 括号内容（中英文均可）不参与英文残留与重复判定，如「玛修（cosplay）」；
      - 「英文名 + 中文括号内容」形态（danbooru 命名约定 name_(series) 的机翻结果），
        如「mash kyrielight（同一片天空下）」「mash kyrielight （cosplay）」。
        此时括号外只允许一整段连续英文名，出现第二段（如
        「ace（超级奥丁时间）ees（pixiv57894）」「akisoba （马戏团） isizuaki」）
        仍判为串接缺陷。
    """
    s = str(value or "").strip()
    if not s:
        return True
    outside = _PAREN_RE.sub("", s)        # 括号外文本（括号内容视为补充说明）
    if _REPEAT_CJK_RE.search(outside):    # 中文片段重复出现 → 串接痕迹
        return True
    parens = _PAREN_RE.findall(s)
    if parens and any(_CJK_RE.search(p) for p in parens):
        chunks = [c.strip() for c in _PAREN_RE.split(s) if c.strip()]
        if len(chunks) == 1 and _NAME_CHUNK_RE.fullmatch(chunks[0]):
            return False                  # 单一英文名 + 中文括号内容 → 正常命名
    if len(s) > DICT_MAX_LEN:
        return True
    if _ASCII_WORD_RE.search(outside):
        return True
    return False


def _load_tag_dict() -> None:
    global _dict_loaded
    if _dict_loaded:
        return
    _dict_loaded = True
    try:
        with DICT_FILE.open("r", encoding="utf-8", errors="ignore", newline="") as f:
            for row in csv.reader(f):
                if len(row) < 2:
                    continue
                key = _normalize_tag(row[0])
                val = " ".join(str(row[1]).split())  # 折叠多余空白
                if key and val:
                    _tag_dict[key] = val
    except Exception:
        pass


_dict_lock = threading.RLock()  # 词典 CSV 读-改-写串行，防并发损坏


def _dict_lookup(tag: str) -> dict:
    """按归一化标签查词典：返回是否命中及词典现有译文。"""
    _load_tag_dict()
    key = _normalize_tag(tag)
    return {"ok": True, "key": key, "found": key in _tag_dict, "dict_value": _tag_dict.get(key, "")}


def _dict_upsert(tag: str, value: str) -> dict:
    """把「标签 → 译文」写入词典 CSV：命中则替换该行译文，否则追加。
    原子写（临时文件 + replace），并同步更新内存 _tag_dict，使后续翻译立即生效。"""
    key = _normalize_tag(tag)
    val = " ".join(str(value or "").split())
    if not key or not val:
        return {"ok": False, "error": _t("err.tagOrZhEmpty")}
    with _dict_lock:
        rows: list[list[str]] = []
        try:
            if DICT_FILE.exists():
                with DICT_FILE.open("r", encoding="utf-8", errors="ignore", newline="") as f:
                    rows = [r for r in csv.reader(f) if r]
        except Exception as e:
            return {"ok": False, "error": _t("err.readDictFailed", msg=e)}
        replaced = False
        for r in rows:
            if r and _normalize_tag(r[0]) == key:
                while len(r) < 2:
                    r.append("")
                r[1] = val
                replaced = True
                break
        if not replaced:
            rows.append([key, val])
        try:
            tmp = DICT_FILE.with_suffix(DICT_FILE.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8", newline="") as f:
                csv.writer(f, lineterminator="\n").writerows(rows)
            tmp.replace(DICT_FILE)
        except Exception as e:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
            return {"ok": False, "error": _t("err.writeDictFailed", msg=e)}
        _tag_dict[key] = val  # 内存同步，立即对翻译生效
        return {"ok": True, "key": key, "value": val, "replaced": replaced}


def _load_trans_cache() -> None:
    global _trans_loaded
    if _trans_loaded:
        return
    _trans_loaded = True
    if not TRANSLATIONS_FILE.exists():
        return
    try:
        data = json.loads(TRANSLATIONS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for model, mapping in data.items():
                if isinstance(mapping, dict):
                    _trans_cache[str(model)] = {str(k): str(v) for k, v in mapping.items()}
    except Exception:
        pass


def _save_trans_cache() -> None:
    try:
        TRANSLATIONS_FILE.write_text(
            json.dumps(_trans_cache, ensure_ascii=False, indent=0), encoding="utf-8"
        )
    except Exception:
        pass


def _scan_llm_models() -> list[dict]:
    """递归扫描 LLM 目录下的所有 .gguf 模型。"""
    out: list[dict] = []
    try:
        LLM_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        return out
    try:
        for p in sorted(LLM_DIR.rglob("*.gguf")):
            try:
                if not p.is_file():
                    continue
                st = p.stat()
            except Exception:
                continue
            out.append({
                "name": p.name,
                "rel": str(p.relative_to(LLM_DIR)).replace("\\", "/"),
                "size": st.st_size,
                "modified": st.st_mtime,
            })
    except Exception:
        pass
    return out


def _resolve_llm_path(rel: str) -> Path | None:
    """把 LLM 目录下的相对路径解析为绝对路径，阻止目录穿越与越界。"""
    if not rel:
        return None
    parts = [s for s in str(rel).replace("\\", "/").split("/") if s not in ("", ".")]
    if not parts or any(s == ".." for s in parts):
        return None
    p = LLM_DIR.joinpath(*parts)
    try:
        if p.resolve().parent == LLM_DIR.resolve():
            pass
        # 必须位于 LLM_DIR 之内，且为 .gguf 文件
        p.resolve().relative_to(LLM_DIR.resolve())
    except Exception:
        return None
    if p.suffix.lower() != ".gguf":
        return None
    return p


_llama_dll_ready = False
_llm_import_error = ""   # 最近一次 import llama_cpp 的失败原因（供界面提示）
_llm_last_note = ""      # 最近一次模型推理为何没产出译文（供界面提示）


def _prepare_llama_dll_env() -> None:
    """把 CUDA 运行库所在目录并入 PATH，供 CUDA 版 llama.dll / ggml-cuda.dll 加载依赖（只做一次）。

    官方 CUDA 轮子**不自带** cudart/cublas，必须从外部找到它们，否则 import llama_cpp
    会因 llama.dll 加载失败抛 RuntimeError（表现为插件误报「未检测到 llama_cpp 模块」，
    或下载好的 CUDA 版被判为不可用）。搜索顺序：

    1) WebUI 自带 torch 的 lib 目录（含 CUDA 12 的 cudart64_12 / cublas64_12 / cublasLt64_12）
       —— 覆盖绝大多数用户，无需额外安装 CUDA Toolkit；
    2) CUDA_PATH / CUDA_HOME 指向的 bin；
    3) C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\* 的 bin（版本倒序）。

    这一步让插件不依赖启动环境（从桌面快捷方式启动、CUDA 未加入系统 PATH 都能正常工作）。
    """
    global _llama_dll_ready
    if _llama_dll_ready:
        return
    _llama_dll_ready = True
    if os.name != "nt":
        return
    dirs: list[str] = []
    # WebUI 自带的 torch 里带有 CUDA 12 运行库（cudart64_12 / cublas64_12 / cublasLt64_12），
    # 正是 llama-cpp-python 的 CUDA 轮子（cu124）所依赖的——官方轮子不自带这些 DLL。
    # 优先用它，用户就不必另外安装 CUDA Toolkit 也能加载 CUDA 版轮子。
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
        # 版本目录倒序：优先使用最新的 CUDA（如 v13.1 优先于 v12.4）
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


def _llm_engine_ready() -> bool:
    global _llm_import_error
    _prepare_llama_dll_env()
    try:
        import llama_cpp  # noqa: F401
        _llm_import_error = ""
        return True
    except Exception as e:
        _llm_import_error = str(e)
        return False


def _cuda_available() -> bool:
    """当前安装的 llama_cpp 是否带 CUDA 后端（CPU 构建返回 False）。"""
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
        # 导入失败不写死结论：可能是环境未就绪，留待后续重试
        _cuda_ok = False
    return _cuda_ok


def _llm_status() -> dict:
    """当前模型加载状态，供前端状态按钮使用。"""
    with _llm_lock:
        return {
            "loaded": _llm is not None,
            "model": os.path.basename(_llm_path) if _llm_path else "",
            "gpu": bool(_stats.get("llm_gpu")) and _cuda_available(),
            "auto_unload": bool(_stats.get("llm_auto_unload", True)),
            "idle_minutes": _clamp_idle_minutes(_stats.get("llm_idle_minutes", IDLE_MIN_DEFAULT)),
            "translate_mode": _translate_mode(),
            "last_used": _llm_last_used,
        }


def _unload_llm() -> bool:
    """释放模型实例；已卸载时直接返回 False（幂等，重复调用不报错）。"""
    global _llm, _llm_path
    with _llm_lock:  # 卸载同样持锁：不能在别的线程推理中途释放 C++ 对象
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
    """后台守护线程：翻译空闲超过阈值后自动卸载模型，释放显存/内存。"""
    while True:
        time.sleep(IDLE_POLL_SECONDS)
        try:
            if _llm is None:
                continue  # 已卸载，无需处理（避免重复卸载）
            if not bool(_stats.get("llm_auto_unload", True)):
                continue  # 用户选择永不卸载
            with _translate_state_lock:
                if _translate_state["busy"]:
                    continue  # 正在翻译（含其它标签页发起），不要抢占释放
            minutes = _clamp_idle_minutes(_stats.get("llm_idle_minutes", IDLE_MIN_DEFAULT))
            if _llm_last_used and (time.time() - _llm_last_used) >= minutes * 60:
                _unload_llm()
        except Exception:
            pass  # 守护线程绝不因单次异常退出


def _ensure_watchdog() -> None:
    global _watchdog_started
    if _watchdog_started:
        return
    _watchdog_started = True
    threading.Thread(target=_idle_watchdog, daemon=True, name="lna-idle-unload").start()


def _get_llm():
    """按当前选中的模型惰性加载 llama_cpp.Llama；失败返回 None（调用方回退词典）。"""
    global _llm, _llm_path, _llm_load_error, _llm_last_used
    rel = str(_stats.get("llm_model") or "")
    if not rel:
        return None
    path = _resolve_llm_path(rel)
    if path is None or not path.is_file():
        _llm_load_error = _t("llm.status.modelMissing")
        return None
    with _llm_lock:
        if _llm is not None and _llm_path == str(path):
            _llm_last_used = time.time()  # 命中已加载实例：刷新空闲计时
            return _llm
        _unload_llm()  # 切换了模型：先释放旧的，避免显存/内存堆积
        # GPU 开关：开且构建支持 CUDA 时全部层进显存；否则纯 CPU（n_gpu_layers=0）
        use_gpu = bool(_stats.get("llm_gpu")) and _cuda_available()
        _prepare_llama_dll_env()  # CUDA 运行时不在 PATH 时补上，否则加载 llama.dll 会失败
        try:
            from llama_cpp import Llama

            _llm = Llama(
                model_path=str(path),
                n_ctx=2048,
                n_threads=max(1, (os.cpu_count() or 4) // 2),
                n_batch=256,
                n_gpu_layers=999 if use_gpu else 0,
                verbose=False,
            )
            _llm_path = str(path)
            _llm_last_used = time.time()  # 加载成功即开始空闲计时
            _llm_load_error = ""
        except Exception as e:
            _llm = None
            _llm_path = ""
            _llm_load_error = _t("llm.status.loadFailed", msg=e)
            # GPU 加载失败（如显存被 SD 占满）时自动降级重试一次 CPU
            if use_gpu:
                try:
                    from llama_cpp import Llama
                    _llm = Llama(
                        model_path=str(path),
                        n_ctx=2048,
                        n_threads=max(1, (os.cpu_count() or 4) // 2),
                        n_batch=256,
                        n_gpu_layers=0,
                        verbose=False,
                    )
                    _llm_path = str(path)
                    _llm_last_used = time.time()
                    _llm_load_error = _t("llm.status.vramFallback")
                except Exception as e2:
                    _llm = None
                    _llm_path = ""
                    _llm_load_error = _t("llm.status.loadFailed", msg=e2)
            return None
        return _llm


def _parse_json_loose(text: str) -> dict:
    """从模型输出里宽松地取出 JSON 对象（容忍 ```json 包裹与前后废话）。"""
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

# 翻译提示预设：默认预设即内置提示词（只读，不可覆盖/删除）；用户预设存 stats.json
PROMPT_DEFAULT_NAME = "默认"
PROMPT_NAME_MAX = 30
PROMPT_TEXT_MAX = 4000


def _prompt_presets() -> dict[str, str]:
    """全部提示预设：内置默认预设 + 用户自定义（同名以内置为准）。"""
    presets = {PROMPT_DEFAULT_NAME: LLM_USER_PROMPT}
    raw = _stats.get("prompt_presets")
    if isinstance(raw, dict):
        for k, v in raw.items():
            name = str(k).strip()
            text = str(v)
            if name and name != PROMPT_DEFAULT_NAME and text.strip():
                presets[name] = text
    return presets


def _active_prompt() -> tuple[str, str]:
    """当前启用的预设 (名称, 提示文本)；名称失效时回退默认预设。"""
    presets = _prompt_presets()
    name = str(_stats.get("active_prompt") or PROMPT_DEFAULT_NAME)
    if name not in presets:
        name = PROMPT_DEFAULT_NAME
    return name, presets[name]


def _llm_translate_batch(tags: list[str]) -> dict[str, str]:
    """用选中的 GGUF 模型批量翻译；不可用时返回空 dict。

    全程持 _llm_lock：llama_cpp 的 C++ 实例非线程安全，并发调用
    create_chat_completion 或推理中途 close() 都会 segfault 拖垮整个 WebUI。
    """
    global _llm_load_error, _llm_last_used, _llm_last_note
    if not tags:
        return {}
    _llm_last_note = ""  # 每次重新判定，避免把上一次的原因带到本次
    prompt = _active_prompt()[1].replace("{tags}", json.dumps(tags, ensure_ascii=False))
    with _llm_lock:
        llm = _get_llm()
        if llm is None:
            return {}
        try:
            out = llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=1536,
                response_format={"type": "json_object"},
            )
            text = out["choices"][0]["message"]["content"]
        except Exception as e:
            _llm_load_error = _t("llm.status.inferFailed", msg=e)
            _llm_last_used = time.time()  # 失败也算使用过，避免立刻被卸载后马上重试
            return {}
        _llm_last_used = time.time()  # 推理完成：刷新空闲计时起点
    data = _parse_json_loose(text)
    result: dict[str, str] = {}
    for tag in tags:
        val = data.get(tag)
        if val is None:  # 模型可能改写了 key（大小写/下划线差异），做一次宽松匹配
            for k, v in data.items():
                if _normalize_tag(k) == _normalize_tag(tag):
                    val = v
                    break
        if isinstance(val, str) and val.strip():
            result[tag] = val.strip()
    if not result:
        # 模型确实跑完了但没给出可用译文：区分「没解析出 JSON」与「键名对不上」，
        # 否则上层只会看到空结果，无法定位是提示预设内容有问题
        _llm_last_note = (
            _t("llm.status.noJson")
            if not data else
            _t("llm.status.tagMismatch")
        )
    return result


def _cache_key() -> str:
    """译文缓存按模型分桶：换模型后自动重新翻译，不会串味。"""
    return os.path.basename(str(_stats.get("llm_model") or ""))


# 翻译方案：dict=仅用对照表（不调模型）/ llm=仅用模型翻译（跳过对照表）/ hybrid=混合
TRANS_MODES = ("dict", "llm", "hybrid")


def _translate_mode() -> str:
    m = str(_stats.get("translate_mode") or "hybrid")
    return m if m in TRANS_MODES else "hybrid"


def translate_tags(tags: list[str], force: bool = False) -> dict:
    """批量翻译标签，按「翻译方案」执行。

    方案（设置区可切换，存于 stats.json）：
      - hybrid 混合（默认）：1 对照表命中 → 采用；2 模型缓存；3 触发词原样保留；
        4 其余送 GGUF 模型
      - dict   仅用对照表：只查对照表，未收录的标签不翻译（前端显示「未完成翻译」）
      - llm    仅用模型翻译：跳过对照表，全部标签走模型（缓存与触发词保护仍生效）
    force=True 供【翻译所有标签】按钮使用：每次点击都重跑流程并覆盖旧对照。
    """
    _load_tag_dict()
    _load_trans_cache()
    mode = _translate_mode()
    translations: dict[str, str] = {}
    key = _cache_key()
    bucket = _trans_cache.setdefault(key, {}) if key else {}

    pending: list[str] = []
    seen: set[str] = set()
    dict_used = False
    llm_used = False
    fallback: dict[str, str] = {}   # 对照表存疑值：模型失败时回退用
    for raw in tags:
        tag = str(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        dv = None if mode == "llm" else _tag_dict.get(_normalize_tag(tag))
        if mode == "dict":
            # 仅用对照表：命中即用（不调模型）；未收录则跳过，保持「未完成翻译」
            if dv:
                translations[tag] = dv
                dict_used = True
            continue
        if dv and not _dict_value_questionable(dv):
            translations[tag] = dv                # 高质量对照表（通过校验）优先
            dict_used = True
        elif dv:
            # 对照表命中但质量存疑 → 交给模型重翻；模型不可用时回退该值
            fallback[tag] = dv
            if not force and tag in bucket:
                translations[tag] = bucket[tag]
                llm_used = True
            else:
                pending.append(tag)
        elif not force and tag in bucket:
            translations[tag] = bucket[tag]       # 模型缓存（强制重跑时跳过）
            llm_used = True
        elif " " not in tag and re.search(r"\d", tag):
            # 触发词判据：无空格 + 含数字 + 对照表未收录（如 kei1、style_v2）。
            # 这类词必须原样保留，绝不能交给模型音译
            # （实测 2B 模型会把 kei1 翻成「凯伊1」并污染缓存）。
            # 反例：1girl / 2girls 虽含数字但在对照表内 → 已走分支 1；
            #       thighhighs 无数字 → 送模型翻译。
            translations[tag] = tag
        else:
            pending.append(tag)

    # 2) 对照表未收录的走 GGUF 推理
    engine_note = ""
    if pending:
        got = _llm_translate_batch(pending)
        if not got:
            # 优先用「模型跑了但没产出可用译文」的具体原因，其次才是模型不可用
            engine_note = _llm_last_note or _llm_load_error or _t("llm.status.notEnabled")
        for tag, zh in got.items():
            if zh and zh != tag:          # 与原文相同视为「没翻出来」，不写缓存
                translations[tag] = zh
                bucket[tag] = zh          # 覆盖旧译文
                llm_used = True
        if got:
            _trans_cache[key] = bucket
            _save_trans_cache()

    # 3) 兜底：模型未给出结果时用对照表存疑值（仍优于原文），再否则保留原文
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


# ---------- GGUF 模型下载（官方站优先，失败自动回退 hf-mirror） ----------
HF_ENDPOINTS = ("https://huggingface.co", "https://hf-mirror.com")
_hf_endpoint_cache: str = ""
# 下载进度（后台线程写入，前端轮询读取）
_download_state: dict[str, Any] = {
    "active": False, "filename": "", "repo": "", "done": 0, "total": 0,
    "error": "", "ok": False, "endpoint": "", "attempt": 0,
}
_download_lock = threading.Lock()

DL_MAX_ATTEMPTS = 8          # 大文件在镜像上容易中途断流，允许多次续传重试
DL_READ_TIMEOUT = 60         # 单次 socket 读超时(秒)，过小会在慢速镜像上误判失败
DL_CHUNK = 1024 * 256


def _pick_hf_endpoint(force: bool = False) -> str:
    """探测可用的 HuggingFace 端点：先试官方站，超时/失败则回退镜像。"""
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
    _hf_endpoint_cache = HF_ENDPOINTS[-1]  # 都探测不到时兜底用镜像
    return _hf_endpoint_cache


def _normalize_repo(s: str) -> str:
    """把仓库 ID 或各种 HF/hf-mirror URL 统一成 owner/name 形式。"""
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
    """列出仓库中的 .gguf 文件（含大小），用于下载前选择量化版本。"""
    repo = _normalize_repo(repo)
    if not repo or "/" not in repo:
        return []
    base = _pick_hf_endpoint()
    # blobs=true 才会在 siblings 里带上每个文件的大小
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
        # 不同版本字段名不一致，逐个兜底
        size = item.get("size")
        if size is None:
            blob = item.get("blobId")
            size = item.get("lfs", {}).get("size") if isinstance(item.get("lfs"), dict) else None
            if size is None and isinstance(blob, dict):
                size = blob.get("size")
        out.append({"filename": fn, "size": int(size or 0)})
    return out


def _download_worker(repo: str, filename: str) -> None:
    """后台下载线程：流式写入 LLM_DIR，断流时用 Range 续传，实时更新进度。"""
    base = _pick_hf_endpoint()
    url = f"{base}/{repo}/resolve/main/{filename}"
    dest = LLM_DIR.joinpath(*[p for p in filename.split("/") if p])
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err = ""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(1, DL_MAX_ATTEMPTS + 1):
            got = tmp.stat().st_size if tmp.exists() else 0
            headers = {"User-Agent": "sd-forge-lora-new"}
            if got:
                headers["Range"] = f"bytes={got}-"   # 断点续传
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=DL_READ_TIMEOUT) as resp:
                    # 服务端不支持续传会回 200，此时必须从头写，否则文件会损坏
                    if got and resp.status != 206:
                        got = 0
                    clen = int(resp.headers.get("Content-Length") or 0)
                    total = (got + clen) if clen else got
                    with _download_lock:
                        _download_state.update(
                            total=total, endpoint=base, done=got, attempt=attempt,
                        )
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
                continue  # 断流：保留 .part，下一轮从断点继续
            size = tmp.stat().st_size if tmp.exists() else 0
            if total and size < total:
                last_err = _t("dl.incomplete", size=size, total=total)
                continue
            tmp.replace(dest)  # 完整落盘后才改名，避免半成品被当成可用模型
            with _download_lock:
                _download_state.update(active=False, ok=True, error="")
            return
        raise RuntimeError(last_err or _t("dl.retryExhausted"))
    except Exception as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        with _download_lock:
            _download_state.update(active=False, ok=False, error=_t("dl.failed", msg=e))


# ---------- 翻译运行时的构建探测与 CUDA 轮子下载 ----------
_runtime_probe_lock = threading.Lock()
_runtime_probe_cache: dict[str, Any] = {"at": 0.0, "value": None}
RUNTIME_PROBE_TTL = 60.0  # 探测结果缓存秒数：设置弹窗可能反复查询

_runtime_dl_lock = threading.Lock()
_runtime_dl_state: dict[str, Any] = {
    "active": False, "done": 0, "total": 0, "error": "", "ok": False, "attempt": 0,
}


def _probe_runtime(force: bool = False) -> dict:
    """探测当前 llama-cpp-python 的构建类型与可用性。

    必须放到子进程里执行：CUDA 版若缺少运行库，导入可能直接结束进程；
    同时也要能区分「装了但导不进来」（此时 CPU/GPU 都用不了）。
    """
    with _runtime_probe_lock:
        cached = _runtime_probe_cache["value"]
        if not force and cached is not None and (time.time() - _runtime_probe_cache["at"]) < RUNTIME_PROBE_TTL:
            return cached
    result = {"installed": False, "usable": False, "build": ""}
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
    except Exception:
        pass
    if not result["installed"]:
        try:
            result["installed"] = importlib.util.find_spec("llama_cpp") is not None
        except Exception:
            result["installed"] = False
    with _runtime_probe_lock:
        _runtime_probe_cache.update(at=time.time(), value=result)
    return result


def _nvidia_driver() -> str:
    """NVIDIA 驱动版本字符串；无 N 卡或没有 nvidia-smi 时返回空串。"""
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


def _nvidia_ok() -> tuple[bool, str]:
    """(驱动是否满足 cu124 的最低要求, 驱动版本字符串)。"""
    ver = _nvidia_driver()
    nums = re.findall(r"\d+", ver)
    ok = len(nums) >= 2 and (int(nums[0]), int(nums[1])) >= MIN_CUDA_DRIVER
    return ok, ver


def _cuda_wheel_path() -> Path:
    return CUDA_WHEELS_DIR / CUDA_WHEEL_NAME


def _cuda_wheel_downloaded() -> bool:
    try:
        return _cuda_wheel_path().is_file()
    except Exception:
        return False


def _cuda_wheel_partial_size() -> int:
    """未完成下载留下的 .part 大小（字节）；用于让进度条从中断处开始显示。"""
    p = _cuda_wheel_path()
    part = p.with_suffix(p.suffix + ".part")
    try:
        return part.stat().st_size if part.is_file() else 0
    except Exception:
        return 0


def _remote_file_size(url: str) -> int:
    """取远端文件总大小（字节）；失败返回 0（表示未知）。

    用 `Range: bytes=0-0` 读 Content-Range 里的总长度，而不用 HEAD：
    GitHub 的下载链接对 HEAD 会超时（实测），而带 Range 的 GET 稳定可用，
    且与真正的下载走同一条路径。用于校验断点续传的半成品是否与远端一致。
    """
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
    """后台下载 CUDA 轮子到 wheels/cuda/；断流用 Range 续传，实时更新进度。

    任务彻底失败时**保留 .part 半成品**，用户再点一次即可从断点继续，不必重下整个文件。
    """
    dest = _cuda_wheel_path()
    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err = ""
    total = 0
    try:
        CUDA_WHEELS_DIR.mkdir(parents=True, exist_ok=True)
        remote_size = _remote_file_size(CUDA_WHEEL_URL)

        # 半成品预检：比远端还大说明是过期/损坏的残留（远端已换文件），丢掉重下；
        # 正好等于远端大小说明上次其实已经下完，直接改名收尾。
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
                break  # 已下满，交给循环外的完整性确认收尾
            headers = {"User-Agent": "sd-forge-lora-new"}
            if got:
                headers["Range"] = f"bytes={got}-"
            try:
                req = urllib.request.Request(CUDA_WHEEL_URL, headers=headers)
                with urllib.request.urlopen(req, timeout=DL_READ_TIMEOUT) as resp:
                    # 服务端不支持续传会回 200，此时必须从头写，否则文件会损坏
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
                    # 断点位置超出远端文件（远端变小或换了文件）→ 丢掉半成品重来
                    tmp.unlink()
                    last_err = _t("dl.resumeInvalid")
                    continue
                last_err = f"{e}"
                continue  # 断流：保留 .part，下一轮从断点继续
            except Exception as e:
                last_err = f"{e}"
                continue
            size = tmp.stat().st_size if tmp.exists() else 0
            expected = remote_size or total
            if expected and size != expected:
                last_err = _t("dl.incomplete", size=size, total=expected)
                continue
            tmp.replace(dest)  # 完整落盘后才改名，避免半成品被当成可用轮子
            with _runtime_dl_lock:
                _runtime_dl_state.update(active=False, ok=True, error="")
            return

        # 走到这里：要么是「已下满」跳出，要么是重试次数用尽
        size = tmp.stat().st_size if tmp.exists() else 0
        if remote_size and size == remote_size:
            tmp.replace(dest)
            with _runtime_dl_lock:
                _runtime_dl_state.update(active=False, ok=True, error="")
            return
        raise RuntimeError(last_err or _t("dl.retryExhausted"))
    except Exception as e:
        # 保留 .part：下次点按钮可从断点续传，不必重下整个文件
        kept = 0
        try:
            kept = tmp.stat().st_size if tmp.exists() else 0
        except Exception:
            kept = 0
        hint = _t("dl.resumeKept", mb=kept // 1048576) if kept else ""
        with _runtime_dl_lock:
            _runtime_dl_state.update(active=False, ok=False, error=_t("dl.failed", msg=f"{e}{hint}"))


# ---------- 卡片设置资料 JSON（按模型镜像存储，文件名加 _new 后缀） ----------
# 结构：<models_json_data>/<LoRA相对路径同构目录>/<模型文件名>_new.json
# 内容：哈希/大小（重定向锚点）、描述、基础模型、训练标签、触发词、
#       反向提示词、推荐权重、注意事项、标签翻译键值对照（按语言分组，便于以后扩展）。
# 预览图像不在 JSON 内：仍与模型同目录同名存放（与旧版一致）。
_json_lock = threading.RLock()  # 可重入：读-改-写整体持锁，内层 _load/_save 复用同一把锁

CARD_JSON_KEYS = (
    "hash", "size", "description", "base_model", "activation_text",
    "preferred_weight", "negative_text", "notes", "tags", "translations",
)


def _card_json_path(rel: str) -> Path | None:
    """模型/文件夹相对路径 → models_json_data 下的镜像 JSON 路径。"""
    safe = _safe_rel(rel)
    if not safe:
        return None
    p = LORA_DIR / safe
    try:
        jrel = str(p.with_name(p.name + "_new.json").relative_to(LORA_DIR))
    except Exception:
        return None
    return JSON_DATA_DIR / jrel.replace("\\", "/")


def _load_card_json(rel: str) -> dict | None:
    path = _card_json_path(rel)
    if path is None or not path.is_file():
        return None
    try:
        with _json_lock:
            data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _save_card_json(rel: str, data: dict) -> bool:
    path = _card_json_path(rel)
    if path is None:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 原子写：先写临时文件再 replace，避免并发读到被截断的半截 JSON
        tmp = path.with_suffix(path.suffix + ".tmp")
        with _json_lock:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
        _card_desc_cache[_safe_rel(rel)] = str(data.get("description", ""))  # 同步描述缓存
        return True
    except Exception:
        try:
            tmp = path.with_suffix(path.suffix + ".tmp")
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        return False


_card_desc_cache: dict[str, str] = {}  # rel → 描述；列表渲染高频读取，保存 JSON 时同步失效


def _get_card_desc(rel: str) -> str:
    """卡片描述（列表悬停展示用）：优先读缓存，缺失时读镜像 JSON 一次。"""
    key = _safe_rel(rel)
    if not key:
        return ""
    if key in _card_desc_cache:
        return _card_desc_cache[key]
    desc = ""
    try:
        data = _load_card_json(key)
        if isinstance(data, dict):
            desc = str(data.get("description", ""))
    except Exception:
        desc = ""
    _card_desc_cache[key] = desc
    return desc


def _empty_card_data() -> dict:
    return {
        "hash": "", "size": 0, "description": "", "base_model": "Unknown",
        "activation_text": "", "preferred_weight": 0.0, "negative_text": "",
        "notes": "", "tags": [], "translations": {},
    }


def _get_card_data(rel: str) -> dict:
    """读取卡片资料：JSON 优先；缺失时从旧 stats.user_metadata 迁移一次。"""
    data = _load_card_json(rel)
    if data is not None:
        base = _empty_card_data()
        base.update({k: data[k] for k in CARD_JSON_KEYS if k in data})
        return base
    # 旧数据迁移（stats.json 的 user_metadata 按相对路径存过）
    legacy = _stats["user_metadata"].get(_safe_rel(rel) or "", None)
    base = _empty_card_data()
    if isinstance(legacy, dict):
        base.update({k: legacy[k] for k in CARD_JSON_KEYS if k in legacy})
        _save_card_json(rel, base)
        _stats["user_metadata"].pop(_safe_rel(rel) or "", None)
        _save_stats()
    return base


def _store_card_translations(rel: str, lang: str, mapping: dict) -> None:
    """把标签译文合并进该模型的 JSON（按语言分组，供以后多语言对照）。"""
    if not rel or not mapping:
        return
    # 读-改-写整体持锁：避免与「保存」按钮的并发写入互相覆盖或读到半截文件
    with _json_lock:
        data = _get_card_data(rel)
        tr = data.get("translations")
        if not isinstance(tr, dict):
            tr = {}
        bucket = tr.get(lang)
        if not isinstance(bucket, dict):
            bucket = {}
        bucket.update({str(k): str(v) for k, v in mapping.items()})
        tr[lang] = bucket
        data["translations"] = tr
        _save_card_json(rel, data)


# ---------- 自动匹配旧数据（模型移动/改名后找回卡片资料） ----------
# 场景：models/Lora 下的模型被移动或改名，但 models_json_data 里的镜像 JSON
# 仍留在旧相对路径，data/stats.json 里按旧路径记录的 usage_count / last_viewed /
# custom_previews 也一起失联 → 卡片信息"丢失"。
# 匹配优先级：① 哈希值（几乎等同于模型的身份证）；② 无哈希时 文件名 + 文件大小
# （同名且等大小≈同一模型）。两级都要求「唯一命中」才迁移，避免歧义误迁。
# 匹配成功：把 JSON 移到新路径（新路径已有 JSON 时保留新数据、删除旧文件），
# 并把 stats 三类记录同步改名；匹配失败的孤立 JSON 返回给前端展示，便于人工清理。

def _iter_model_files() -> list[dict]:
    """递归扫描 LoRA 库，返回 [{rel, size, hash}]。

    哈希优先读 JSON 里已存的锚点（零成本）；缺失时从 safetensors 元数据或
    WebUI 文件哈希缓存补齐（与 card_info 的补齐逻辑一致，不直接计算全文件哈希）。
    """
    out: list[dict] = []
    if not LORA_DIR.exists():
        return out
    for root, _dirs, files in os.walk(LORA_DIR):
        for fn in files:
            if Path(fn).suffix.lower() not in LORA_EXTS:
                continue
            p = Path(root) / fn
            try:
                rel = _rel(p)
                size = p.stat().st_size
            except Exception:
                continue
            h = ""
            cached = _load_card_json(rel)
            if isinstance(cached, dict):
                h = str(cached.get("hash") or "")
            if not h and p.suffix.lower() == ".safetensors":
                try:
                    from modules import cache, sd_models

                    meta = cache.cached_data_for_file(
                        "safetensors-metadata", "lora_new/" + rel, str(p),
                        lambda: sd_models.read_metadata_from_safetensors(str(p)),
                    ) or {}
                    h = _short_hash(p, rel, meta)
                except Exception:
                    h = ""
            out.append({"rel": rel, "size": size, "hash": h})
    return out


def _iter_orphan_jsons() -> list[dict]:
    """遍历 models_json_data 下所有镜像 JSON，返回模型文件已不存在的 [{rel, data}]。

    rel 为 JSON 相对 models_json_data 的路径去掉 _new.json 后缀还原出的旧模型相对路径。
    """
    orphans: list[dict] = []
    if not JSON_DATA_DIR.exists():
        return orphans
    suffix = "_new.json"
    for root, _dirs, files in os.walk(JSON_DATA_DIR):
        for fn in files:
            if not fn.endswith(suffix):
                continue
            jp = Path(root) / fn
            try:
                rel = str(jp.relative_to(JSON_DATA_DIR)).replace("\\", "/")
            except Exception:
                continue
            rel = rel[: -len(suffix)] if rel.endswith(suffix) else rel
            if not rel:
                continue
            target = LORA_DIR / rel
            if target.is_file() or target.is_dir():
                continue  # 模型/文件夹还在原位，不属于旧数据（文件夹说明 JSON 同规则）
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
            except Exception:
                data = None
            if isinstance(data, dict):
                orphans.append({"rel": rel, "data": data})
    return orphans


def _migrate_stats_keys(old_rel: str, new_rel: str) -> None:
    """把 usage_count / last_viewed / custom_previews 里的旧路径记录改到新路径。"""
    changed = False
    for bucket in ("usage_count", "last_viewed", "custom_previews"):
        if old_rel in _stats[bucket]:
            val = _stats[bucket].pop(old_rel)
            if new_rel not in _stats[bucket]:  # 新路径已有记录时保留新值
                _stats[bucket][new_rel] = val
            changed = True
    if changed:
        _save_stats()


def match_old_data() -> dict:
    """执行一次自动匹配，返回 {ok, matched, moved, merged, unmatched}。

    matched: 匹配成功条数；moved: 实际移动的 JSON 数；merged: 新路径已有 JSON、
    旧文件被清理合并的条数；unmatched: 未能匹配到任何现存模型的孤立 JSON 列表。
    """
    models = _iter_model_files()
    orphans = _iter_orphan_jsons()
    existing_rels = {m["rel"] for m in models}

    by_hash: dict[str, list[dict]] = {}
    by_name_size: dict[tuple[str, int], list[dict]] = {}
    for m in models:
        if m["hash"]:
            by_hash.setdefault(m["hash"].lower()[:10], []).append(m)
        stem = Path(m["rel"]).stem.lower()
        by_name_size.setdefault((stem, m["size"]), []).append(m)

    # 旧 JSON 之间先按特异性排序：有哈希的优先认领，其次 文件名+大小 齐全者
    def _specificity(o: dict) -> tuple:
        d = o["data"]
        return (
            0 if str(d.get("hash") or "") else 1,
            0 if d.get("size") else 1,
        )

    orphans.sort(key=_specificity)
    claimed: set[str] = set()  # 已被旧 JSON 认领的模型 rel
    matched = 0
    moved = 0
    merged = 0
    unmatched: list[dict] = []

    for o in orphans:
        d = o["data"]
        old_rel = o["rel"]
        old_hash = str(d.get("hash") or "").lower()[:10]
        old_size = d.get("size") or 0
        # 旧文件名：优先 JSON 内记录，缺失时从旧相对路径的文件名还原（去掉 _new.json）
        old_name = str(d.get("filename") or d.get("name") or Path(old_rel).name)
        if old_name.endswith("_new.json"):
            old_name = old_name[: -len("_new.json")]
        old_stem = Path(old_name).stem.lower()

        # 匹配规则：① 哈希值（模型的身份证，唯一命中才认）；
        # ② 无哈希或哈希未命中时，文件名 + 文件大小 同时相等（同名同大小≈同一模型）。
        target: dict | None = None
        if old_hash:
            cands = [m for m in by_hash.get(old_hash, []) if m["rel"] not in claimed]
            if len(cands) == 1:
                target = cands[0]
        if target is None and old_stem and old_size:
            try:
                cands = [m for m in by_name_size.get((old_stem, int(old_size)), []) if m["rel"] not in claimed]
            except Exception:
                cands = []
            if len(cands) == 1:
                target = cands[0]
        if target is None:
            unmatched.append({
                "rel": old_rel,
                "hash": old_hash,
                "size": old_size,
                "has_content": _card_data_has_content(d),
            })
            continue

        claimed.add(target["rel"])
        new_rel = target["rel"]
        with _json_lock:
            new_data = _load_card_json(new_rel)
            if new_data is None:
                # 新路径还没有 JSON：把旧文件整体搬过去，顺带补齐锚点
                if not d.get("hash") and target["hash"]:
                    d["hash"] = target["hash"]
                d["size"] = target["size"]
                ok = _save_card_json(new_rel, d)
                if ok:
                    _delete_card_json(old_rel)
                    moved += 1
            else:
                # 新路径已有 JSON（模型移动后打开过卡片、自动生成了空资料）：
                # 把旧 JSON 里填过的内容字段补进新数据（新值优先），再清理旧文件
                for k in CARD_JSON_KEYS:
                    if k in ("hash", "size"):
                        continue
                    if k not in new_data or new_data[k] in ("", [], {}, 0, 0.0, None):
                        if k in d and d[k] not in ("", [], {}, 0, 0.0, None):
                            new_data[k] = d[k]
                # 译文对照合并：旧 JSON 的译文不覆盖新 JSON 已有的键
                old_tr = d.get("translations")
                if isinstance(old_tr, dict) and old_tr:
                    new_tr = new_data.get("translations")
                    if not isinstance(new_tr, dict):
                        new_tr = {}
                    for lang, bucket in old_tr.items():
                        if not isinstance(bucket, dict):
                            continue
                        mb = new_tr.get(lang)
                        if not isinstance(mb, dict):
                            mb = {}
                        for tag, zh in bucket.items():
                            mb.setdefault(tag, zh)
                        new_tr[lang] = mb
                    new_data["translations"] = new_tr
                ok = _save_card_json(new_rel, new_data)
                if ok:
                    _delete_card_json(old_rel)
                    merged += 1
        if ok:
            _migrate_stats_keys(old_rel, new_rel)
            matched += 1
        else:
            unmatched.append({
                "rel": old_rel,
                "hash": old_hash,
                "size": old_size,
                "has_content": _card_data_has_content(d),
            })

    # 顺带迁移 stats.user_metadata 里仍按旧路径存着的遗留条目（同样按 哈希 → 文件名+大小 认领）
    legacy_moved = 0
    legacy_unmatched: list[dict] = []
    with _json_lock:
        for old_rel, legacy in list(_stats["user_metadata"].items()):
            if old_rel in existing_rels or not isinstance(legacy, dict):
                continue
            l_hash = str(legacy.get("hash") or "").lower()[:10]
            l_size = legacy.get("size") or 0
            l_stem = Path(old_rel).stem.lower()
            target = None
            if l_hash:
                cands = [m for m in by_hash.get(l_hash, []) if m["rel"] not in claimed]
                if len(cands) == 1:
                    target = cands[0]
            if target is None and l_stem and l_size:
                try:
                    cands = [m for m in by_name_size.get((l_stem, int(l_size)), []) if m["rel"] not in claimed]
                except Exception:
                    cands = []
                if len(cands) == 1:
                    target = cands[0]
            if target is not None:
                new_rel = target["rel"]
                base = _empty_card_data()
                base.update({k: legacy[k] for k in CARD_JSON_KEYS if k in legacy})
                if not base.get("hash") and target["hash"]:
                    base["hash"] = target["hash"]
                base["size"] = target["size"]
                if _save_card_json(new_rel, base):
                    claimed.add(new_rel)
                    _stats["user_metadata"].pop(old_rel, None)
                    _migrate_stats_keys(old_rel, new_rel)
                    legacy_moved += 1
                    matched += 1
            else:
                legacy_unmatched.append({
                    "rel": old_rel,
                    "hash": l_hash,
                    "size": l_size,
                    "has_content": _card_data_has_content(legacy),
                })
    if legacy_moved:
        _save_stats()
    unmatched.extend(legacy_unmatched)

    return {
        "ok": True,
        "matched": matched,
        "moved": moved,
        "merged": merged,
        "legacy_moved": legacy_moved,
        "model_count": len(models),
        "orphan_count": len(orphans) + len(_stats["user_metadata"]),
        "unmatched": sorted(unmatched, key=lambda x: x["rel"]),
    }


def _card_data_has_content(d: dict) -> bool:
    """判断旧 JSON 是否含实际填写过的资料（描述/触发词/标签/译文等），供前端区分展示。"""
    for k in ("description", "activation_text", "negative_text", "notes", "base_model"):
        v = d.get(k)
        if isinstance(v, str) and v.strip() and v.strip() != "Unknown":
            return True
    if d.get("tags"):
        return True
    tr = d.get("translations")
    if isinstance(tr, dict) and any(isinstance(b, dict) and b for b in tr.values()):
        return True
    try:
        if float(d.get("preferred_weight") or 0) != 0.0:
            return True
    except Exception:
        pass
    return False


def _delete_card_json(rel: str) -> bool:
    """删除 models_json_data 下的镜像 JSON（迁移完成后清理旧位置文件）。"""
    path = _card_json_path(rel)
    if path is None:
        return False
    try:
        if path.is_file():
            path.unlink()
        _card_desc_cache.pop(_safe_rel(rel), None)
        return True
    except Exception:
        return False


# ---------- 同步旧插件（sd_forge_lora）的 JSON 到本插件 ----------
# 旧插件把用户填写的资料写在模型同目录、同名（仅扩展名换成 .json）的文件里，
# 键名带空格且与本插件不同，需做一次字段映射。旧 JSON 只保留用户可编辑的
# 6 个字段；本插件镜像 JSON 里的 hash/size 锚点、训练标签、译文对照属于
# 本插件自动生成的内容，同步时不动它们。
SD_VERSIONS = ("SD1", "SD2", "SDXL", "Flux", "Unknown")

# 旧 JSON 键 → 本插件 JSON 键
OLD_JSON_KEYMAP = {
    "description": "description",
    "sd version": "base_model",
    "activation text": "activation_text",
    "preferred weight": "preferred_weight",
    "negative text": "negative_text",
    "notes": "notes",
}
# 反向映射：本插件 JSON 键 → 旧 JSON 键（数据统一化写回旧插件时用）
OLD_JSON_KEYMAP_REV = {v: k for k, v in OLD_JSON_KEYMAP.items()}
# 卡片资料里「由用户填写」的字段（tags/translations 为插件自动生成，不算冲突依据）
CARD_USER_KEYS = (
    "description", "base_model", "activation_text",
    "preferred_weight", "negative_text", "notes",
)


def _old_json_path(rel: str) -> Path | None:
    """模型相对路径 → 旧插件 JSON 路径（同目录、同名、扩展名换成 .json）。"""
    safe = _safe_rel(rel)
    if not safe:
        return None
    return (LORA_DIR / safe).with_suffix(".json")


def _old_json_to_card(old: dict) -> dict:
    """旧插件 JSON → 本插件卡片 JSON（只取用户可编辑字段，其余留默认值）。"""
    card = _empty_card_data()
    for src, dst in OLD_JSON_KEYMAP.items():
        if src not in old:
            continue
        val = old[src]
        if dst == "preferred_weight":
            try:
                card[dst] = float(val or 0)
            except Exception:
                card[dst] = 0.0
        elif dst == "base_model":
            v = str(val or "")
            card[dst] = v if v in SD_VERSIONS else "Unknown"
        else:
            card[dst] = str(val or "")
    return card


def _card_user_content(d: dict) -> bool:
    """是否含用户填写的资料（只看 6 个可编辑字段，不含自动生成的标签/译文）。"""
    for k in ("description", "activation_text", "negative_text", "notes"):
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return True
    if str(d.get("base_model") or "") not in ("", "Unknown"):
        return True
    try:
        if float(d.get("preferred_weight") or 0) != 0.0:
            return True
    except Exception:
        pass
    return False


def _iter_old_json_items() -> list[dict]:
    """遍历 LoRA 库中「同时存在旧插件同名 JSON」的模型，返回 [{rel, data}]。"""
    out: list[dict] = []
    if not LORA_DIR.exists():
        return out
    for root, _dirs, files in os.walk(LORA_DIR):
        for fn in files:
            if Path(fn).suffix.lower() not in LORA_EXTS:
                continue
            jp = (Path(root) / fn).with_suffix(".json")
            if not jp.is_file():
                continue
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            out.append({"rel": _rel(Path(root) / fn), "data": data})
    out.sort(key=lambda x: x["rel"])
    return out


def _merge_old_into_card(new_data: dict, old_card: dict) -> None:
    """把旧 JSON 的用户字段写进新 JSON（就地修改，保留新 JSON 的其余字段）。"""
    for k in CARD_USER_KEYS:
        if k in old_card:
            new_data[k] = old_card[k]


# 数据对比的字段与中文名（与卡片设置弹窗、旧插件 JSON 字段一一对应）
COMPARE_FIELDS = (
    ("description", _t("cf.description")),
    ("base_model", _t("cf.baseModel")),
    ("activation_text", _t("cf.activation")),
    ("preferred_weight", _t("cf.weight")),
    ("negative_text", _t("cf.negative")),
    ("notes", _t("cf.notes")),
)


def _cmp_display(key: str, val) -> str:
    """对比用展示值：未设置的统一为空串（权重 0、基础模型 Unknown 视为未设置）。"""
    if key == "preferred_weight":
        try:
            w = float(val or 0)
        except Exception:
            w = 0.0
        return "" if w == 0 else f"{w:g}"
    s = str(val or "").strip()
    if key == "base_model" and s == "Unknown":
        return ""
    return s


def _compare_rows(old_card: dict, new_data: dict) -> list[dict]:
    """逐字段对比，state：same=一致 / diff=都有值但不同 / empty=一边有值一边为空。"""
    rows = []
    for key, label in COMPARE_FIELDS:
        o = _cmp_display(key, old_card.get(key))
        n = _cmp_display(key, new_data.get(key))
        if o == n:
            state = "same"
        elif not o or not n:
            state = "empty"
        else:
            state = "diff"
        rows.append({"key": key, "label": label, "old": o, "new": n, "state": state})
    return rows


def sync_old_json() -> dict:
    """把旧插件（models/Lora 下同名 .json）的资料同步到本插件的镜像 JSON。

    规则：
      - 旧 JSON 无用户内容 → 跳过（没有可同步的数据）
      - 新 JSON 不存在      → 新建并写入旧资料
      - 新 JSON 存在但无内容 → 用旧资料补齐
      - 新旧内容已一致       → 跳过（此前同步过）
      - 新旧都有内容且不同   → 记为冲突，返回前端由用户点【覆盖】决定，不自动改
    每次调用都实时重扫磁盘，不使用缓存结果；旧 JSON 一律不删除。
    """
    created = 0
    filled = 0
    scanned = 0
    conflicts: list[dict] = []
    for item in _iter_old_json_items():
        rel = item["rel"]
        old_card = _old_json_to_card(item["data"])
        if not _card_user_content(old_card):
            continue
        scanned += 1
        with _json_lock:
            new_data = _load_card_json(rel)
            if new_data is None:
                try:
                    old_card["size"] = (LORA_DIR / rel).stat().st_size
                except Exception:
                    pass
                if _save_card_json(rel, old_card):
                    created += 1
                continue
            if not _card_user_content(new_data):
                _merge_old_into_card(new_data, old_card)
                if not new_data.get("size"):
                    try:
                        new_data["size"] = (LORA_DIR / rel).stat().st_size
                    except Exception:
                        pass
                if _save_card_json(rel, new_data):
                    filled += 1
                continue
            # 冲突判定与对比弹窗用同一套归一化结果，保证「冲突项一定有差异字段」
            changed = [
                {"label": r["label"], "state": r["state"]}
                for r in _compare_rows(old_card, new_data) if r["state"] != "same"
            ]
            if changed:
                conflicts.append({"rel": rel, "name": Path(rel).stem, "fields": changed})
    return {
        "ok": True,
        "scanned": scanned,
        "created": created,
        "filled": filled,
        "conflicts": sorted(conflicts, key=lambda x: x["rel"]),
    }


def overwrite_from_old_json(rel: str) -> dict:
    """冲突处理：用旧插件 JSON 的用户字段覆盖本插件镜像 JSON 的对应字段。"""
    safe = _safe_rel(rel)
    if not safe:
        return {"ok": False, "error": _t("err.invalidPath")}
    jp = _old_json_path(safe)
    if jp is None or not jp.is_file():
        return {"ok": False, "error": _t("err.oldJsonNotFound")}
    try:
        old = json.loads(jp.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": _t("err.readOldJsonFailed", msg=e)}
    if not isinstance(old, dict):
        return {"ok": False, "error": _t("err.badOldJson")}
    old_card = _old_json_to_card(old)
    with _json_lock:
        new_data = _load_card_json(safe)
        if new_data is None:
            new_data = old_card
        else:
            _merge_old_into_card(new_data, old_card)
        if not new_data.get("size"):
            try:
                new_data["size"] = (LORA_DIR / safe).stat().st_size
            except Exception:
                pass
        if not _save_card_json(safe, new_data):
            return {"ok": False, "error": _t("err.writeJsonFailed")}
    return {"ok": True}


def unify_old_json_field(rel: str, key: str, direction: str) -> dict:
    """数据统一化：用一侧的字段值覆盖另一侧的文件。

    direction = old_to_new：旧插件值 → 本插件 JSON
              = new_to_old：本插件值 → 旧插件 JSON（会写入 models/Lora 下的旧 JSON）
    """
    safe = _safe_rel(rel)
    if not safe:
        return {"ok": False, "error": _t("err.invalidPath")}
    if key not in CARD_USER_KEYS:
        return {"ok": False, "error": _t("err.fieldUnsupported")}
    jp = _old_json_path(safe)
    if jp is None or not jp.is_file():
        return {"ok": False, "error": _t("err.oldJsonNotFound")}

    if direction == "old_to_new":
        try:
            old = json.loads(jp.read_text(encoding="utf-8"))
        except Exception as e:
            return {"ok": False, "error": _t("err.readOldJsonFailed", msg=e)}
        if not isinstance(old, dict):
            return {"ok": False, "error": _t("err.badOldJson")}
        val = _old_json_to_card(old).get(key)
        with _json_lock:
            new_data = _load_card_json(safe)
            if not isinstance(new_data, dict):
                new_data = _empty_card_data()
            new_data[key] = val
            if not new_data.get("size"):
                try:
                    new_data["size"] = (LORA_DIR / safe).stat().st_size
                except Exception:
                    pass
            if not _save_card_json(safe, new_data):
                return {"ok": False, "error": _t("err.writePluginJsonFailed")}
        return {"ok": True, "key": key, "direction": direction}

    if direction == "new_to_old":
        new_data = _load_card_json(safe)
        if not isinstance(new_data, dict):
            new_data = _empty_card_data()
        val = new_data.get(key, _empty_card_data().get(key))
        if key == "preferred_weight":
            try:
                out = float(val or 0)
            except Exception:
                out = 0.0
        else:
            out = str(val or "")
        try:
            old = json.loads(jp.read_text(encoding="utf-8"))
        except Exception:
            old = {}
        if not isinstance(old, dict):
            old = {}
        old[OLD_JSON_KEYMAP_REV[key]] = out
        # 与旧插件写入保持一致：indent=4、ensure_ascii=False；原子写避免写坏旧文件
        try:
            tmp = jp.with_suffix(jp.suffix + ".tmp")
            tmp.write_text(json.dumps(old, ensure_ascii=False, indent=4), encoding="utf-8")
            tmp.replace(jp)
        except Exception as e:
            return {"ok": False, "error": _t("err.writeOldJsonFailed", msg=e)}
        return {"ok": True, "key": key, "direction": direction}

    return {"ok": False, "error": _t("err.badUnifyDirection")}


# 数据对比弹窗的字段与中文名（与卡片设置弹窗、旧插件 JSON 字段一一对应）
COMPARE_FIELDS = (
    ("description", _t("cf.description")),
    ("base_model", _t("cf.baseModel")),
    ("activation_text", _t("cf.activation")),
    ("preferred_weight", _t("cf.weight")),
    ("negative_text", _t("cf.negative")),
    ("notes", _t("cf.notes")),
)


def _cmp_display(key: str, val) -> str:
    """对比用展示值：未设置的统一为空串（权重 0、基础模型 Unknown 视为未设置）。"""
    if key == "preferred_weight":
        try:
            w = float(val or 0)
        except Exception:
            w = 0.0
        return "" if w == 0 else f"{w:g}"
    s = str(val or "").strip()
    if key == "base_model" and s == "Unknown":
        return ""
    return s


def compare_old_json(rel: str) -> dict:
    """冲突项字段级对比：左为旧插件 JSON，右为本插件镜像 JSON。

    每行附带 state：same=一致 / diff=都有值但不同 / empty=一边有值一边为空。
    """
    safe = _safe_rel(rel)
    if not safe:
        return {"ok": False, "error": _t("err.invalidPath")}
    jp = _old_json_path(safe)
    if jp is None or not jp.is_file():
        return {"ok": False, "error": _t("err.oldJsonNotFound")}
    try:
        old = json.loads(jp.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": _t("err.readOldJsonFailed", msg=e)}
    if not isinstance(old, dict):
        return {"ok": False, "error": _t("err.badOldJson")}
    old_card = _old_json_to_card(old)
    new_data = _load_card_json(safe)
    if not isinstance(new_data, dict):
        new_data = _empty_card_data()
    return {"ok": True, "rel": safe, "name": Path(safe).stem,
            "rows": _compare_rows(old_card, new_data)}


# ---------- FastAPI 路由 ----------
def _ensure_lora_engine() -> None:
    """sd_forge_lora 未启用时，由本插件自带的引擎接管 `<lora:...>`。

    必须在这里（on_app_started）判断而不能在 before_ui 里：所有扩展的 before_ui
    跑完之后注册表才是最终状态，而 before_ui 本身是反向遍历执行的，先后不可靠。

    两者同时启用时不注册——extra_network_registry 是按名字索引的 dict，
    后注册者会覆盖先注册者，重复注册会导致状态错乱。
    """
    try:
        from modules import extra_networks
    except Exception:
        return
    if "lora" in extra_networks.extra_network_registry:
        return
    try:
        from lna_lora_engine import register_extra_network_lora
    except Exception:
        from modules import errors
        errors.report("LoRA 管理器：加载自带 <lora:> 引擎失败，需与 sd_forge_lora 同时启用", exc_info=True)
        return
    if register_extra_network_lora():
        print("[LoRA 管理器] sd_forge_lora 未启用，已接管 <lora:...> 加载")


def _open_in_explorer(abs_dir: Path) -> str | None:
    """用系统资源管理器打开文件夹；成功返回 None，失败返回错误文案。"""
    try:
        if os.name == "nt":
            os.startfile(str(abs_dir))  # type: ignore[attr-defined]
        else:
            import subprocess
            import sys
            opener = "open" if sys.platform == "darwin" else "xdg-open"
            subprocess.Popen([opener, str(abs_dir)])
    except Exception as e:
        return _t("err.openFailed", msg=e)
    return None


def _reveal_in_explorer(abs_path: Path) -> str | None:
    """在系统文件管理器中打开所在文件夹并选中该文件；成功返回 None，失败返回错误文案。"""
    try:
        if os.name == "nt":
            # explorer 的 /select 参数要求逗号后紧跟目标路径；成功时也可能返回非 0，故不检查退出码
            subprocess.Popen(["explorer", "/select," + str(abs_path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(abs_path)])
        else:
            subprocess.Popen(["xdg-open", str(abs_path.parent)])
    except Exception as e:
        return _t("err.openFailed", msg=e)
    return None


def on_app_started(_: gr.Blocks, app: FastAPI) -> None:
    if LORA_DIR.exists():
        app.mount("/lora_new_files", StaticFiles(directory=str(LORA_DIR)), name="lora_new_files")
    _ensure_watchdog()  # 启动空闲自动卸载守护线程（只启动一次）
    _ensure_lora_engine()  # sd_forge_lora 未启用时自带 <lora:...> 引擎

    # ---------- 界面多语言（i18n） ----------
    @app.get("/lora_new/api/i18n")
    def api_i18n():
        """下发当前界面语言的语言包（前端唯一数据源）。"""
        if _i18n is None:
            return {"lang": "", "available": [], "dict": {}}
        cur = _i18n.get_lang()
        return {"lang": cur, "available": _i18n.available_langs(), "dict": _i18n.load_pack(cur)}

    @app.post("/lora_new/api/ui_lang")
    def api_ui_lang(payload: dict):
        """切换界面语言：更新全局语言 + 持久化到 ui_settings，返回新语言包。"""
        if _i18n is None:
            return {"ok": False, "lang": "", "available": [], "dict": {}}
        lang = _i18n.set_lang((payload or {}).get("lang", ""))
        _update_ui_settings({"uiLang": lang})
        return {"ok": True, "lang": lang, "available": _i18n.available_langs(), "dict": _i18n.load_pack(lang)}

    @app.get("/lora_new/api/tree")
    def api_tree():
        stats = library_stats()
        return {
            "root": str(LORA_DIR),
            "count": _count_loras(LORA_DIR),
            "total_count": stats["count"],
            "total_size": stats["size"],
            "children": build_tree(LORA_DIR),
        }

    @app.get("/lora_new/api/list")
    def api_list(path: str = ""):
        return list_dir(_safe_rel(path))

    @app.get("/lora_new/api/search")
    def api_search(path: str = "", q: str = ""):
        return search_all(_safe_rel(path), q)

    @app.get("/lora_new/api/metadata")
    def api_metadata(rel: str = ""):
        return read_lora_metadata(rel)

    @app.get("/lora_new/api/card_info")
    def api_card_info(rel: str = ""):
        return card_info(rel)

    @app.get("/lora_new/api/folder_info")
    def api_folder_info(rel: str = ""):
        return folder_info(rel)

    @app.post("/lora_new/api/open_folder")
    def api_open_folder(payload: dict):
        safe = _safe_rel(payload.get("rel", ""))
        abs_dir = (LORA_DIR / safe) if safe else LORA_DIR
        if not abs_dir.is_dir():
            return {"ok": False, "error": _t("err.folderNotFound")}
        err = _open_in_explorer(abs_dir)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": str(abs_dir)}

    @app.post("/lora_new/api/reveal")
    def api_reveal(payload: dict):
        """在资源管理器中打开模型所在文件夹，并自动选中该模型文件。"""
        safe = _safe_rel(payload.get("rel", ""))
        if not safe:
            return {"ok": False, "error": _t("err.invalidPath")}
        abs_path = LORA_DIR / safe
        if not abs_path.is_file():
            return {"ok": False, "error": _t("err.fileNotFound")}
        err = _reveal_in_explorer(abs_path)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": str(abs_path)}

    @app.post("/lora_new/api/llm_open_folder")
    def api_llm_open_folder():
        try:
            LLM_DIR.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return {"ok": False, "error": _t("err.modelDirUnavailable", msg=e)}
        err = _open_in_explorer(LLM_DIR)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": str(LLM_DIR)}

    @app.post("/lora_new/api/translate")
    def api_translate(payload: dict):
        tags = payload.get("tags", [])
        if not isinstance(tags, list):
            return {"ok": False, "error": _t("err.tagsNotArray")}
        # 全局「翻译正在进行」标记：多个浏览器标签页共用同一后端，
        # 已有任务在跑时直接拒绝（busy=true），前端据此显示忙碌态并轮询等待
        with _translate_state_lock:
            if _translate_state["busy"]:
                return {"ok": False, "busy": True, "error": _t("err.translateBusy")}
            _translate_state["busy"] = True
        try:
            # force=true（【翻译所有标签】按钮）：重跑流程并覆盖旧译文，不吃模型缓存
            res = translate_tags([str(t) for t in tags][:200], force=bool(payload.get("force")))
            # 译文同步持久化到该模型的镜像 JSON（按语言分组，供以后多语言对照）
            rel = _safe_rel(str(payload.get("rel") or ""))
            if rel and res.get("ok"):
                _store_card_translations(rel, "zh", res.get("translations") or {})
            return res
        finally:
            with _translate_state_lock:
                _translate_state["busy"] = False

    @app.get("/lora_new/api/translate_status")
    def api_translate_status():
        with _translate_state_lock:
            return {"ok": True, "busy": _translate_state["busy"]}

    @app.get("/lora_new/api/llm_models")
    def api_llm_models():
        return {
            "ok": True,
            "models": _scan_llm_models(),
            "selected": str(_stats.get("llm_model") or ""),
            "engine_ready": _llm_engine_ready(),
            "engine_error": _llm_import_error,
            "cuda_available": _cuda_available(),
            "gpu": bool(_stats.get("llm_gpu")),
            "loaded": _llm_path,
        }

    @app.post("/lora_new/api/llm_gpu")
    def api_llm_gpu(payload: dict):
        want = bool(payload.get("gpu"))
        if want and not _cuda_available():
            return {"ok": False, "error": _t("err.cpuBuildNoGpu")}
        if want == bool(_stats.get("llm_gpu")):
            return {"ok": True, "gpu": want}
        _stats["llm_gpu"] = want
        _save_stats()
        _unload_llm()  # 切换设备需重新加载模型
        return {"ok": True, "gpu": want}

    @app.post("/lora_new/api/llm_select")
    def api_llm_select(payload: dict):
        global _llm_load_error
        rel = str(payload.get("rel") or "")
        if rel and _resolve_llm_path(rel) is None:
            return {"ok": False, "error": _t("err.invalidModelPath")}
        if str(_stats.get("llm_model") or "") != rel:
            _unload_llm()  # 换模型：立即释放旧实例
        _stats["llm_model"] = rel
        _llm_load_error = ""
        _save_stats()
        return {"ok": True, "selected": rel}

    @app.post("/lora_new/api/llm_unload")
    def api_llm_unload():
        unloaded = _unload_llm()
        return {"ok": True, "unloaded": unloaded, **_llm_status()}

    @app.get("/lora_new/api/llm_status")
    def api_llm_status():
        return {"ok": True, **_llm_status()}

    @app.post("/lora_new/api/llm_idle_settings")
    def api_llm_idle_settings(payload: dict):
        if "auto_unload" in payload:
            _stats["llm_auto_unload"] = bool(payload.get("auto_unload"))
        if "minutes" in payload:
            _stats["llm_idle_minutes"] = _clamp_idle_minutes(payload.get("minutes"))
        _save_stats()
        return {"ok": True, **_llm_status()}

    @app.post("/lora_new/api/translate_mode")
    def api_translate_mode(payload: dict):
        mode = str((payload or {}).get("mode") or "")
        if mode not in TRANS_MODES:
            return {"ok": False, "error": _t("err.invalidTransMode")}
        _stats["translate_mode"] = mode
        _save_stats()
        return {"ok": True, "mode": mode}

    def _prompt_payload() -> dict:
        name, text = _active_prompt()
        return {
            "ok": True,
            "active": name,
            "text": text,
            "default_name": PROMPT_DEFAULT_NAME,
            "presets": [{"name": k, "text": v} for k, v in _prompt_presets().items()],
        }

    @app.get("/lora_new/api/prompt_presets")
    def api_prompt_presets_list():
        return _prompt_payload()

    @app.post("/lora_new/api/prompt_presets")
    def api_prompt_presets_edit(payload: dict):
        payload = payload or {}
        action = str(payload.get("action") or "save")
        name = str(payload.get("name") or "").strip()

        if action == "save":
            text = str(payload.get("text") or "")
            if not name:
                return {"ok": False, "error": _t("err.needPresetName")}
            if name == PROMPT_DEFAULT_NAME:
                return {"ok": False, "error": _t("err.presetNameReserved")}
            if len(name) > PROMPT_NAME_MAX:
                return {"ok": False, "error": _t("err.presetNameTooLong", n=PROMPT_NAME_MAX)}
            if not text.strip():
                return {"ok": False, "error": _t("err.promptEmpty")}
            if len(text) > PROMPT_TEXT_MAX:
                return {"ok": False, "error": _t("err.promptTooLong", n=PROMPT_TEXT_MAX)}
            if "{tags}" not in text:
                return {"ok": False, "error": _t("err.promptNeedPlaceholder")}
            presets = _stats.setdefault("prompt_presets", {})
            presets[name] = text
            _stats["active_prompt"] = name
            _save_stats()
            return _prompt_payload()

        if action == "delete":
            if name == PROMPT_DEFAULT_NAME:
                return {"ok": False, "error": _t("err.presetDefaultUndeletable")}
            presets = _stats.get("prompt_presets")
            if not isinstance(presets, dict) or name not in presets:
                return {"ok": False, "error": _t("err.presetNotFound")}
            del presets[name]
            if str(_stats.get("active_prompt") or "") == name:
                _stats["active_prompt"] = ""  # 删掉正在用的 → 回到默认预设
            _save_stats()
            return _prompt_payload()

        if action == "select":
            if name not in _prompt_presets():
                return {"ok": False, "error": _t("err.presetNotFound")}
            _stats["active_prompt"] = name
            _save_stats()
            return _prompt_payload()

        return {"ok": False, "error": _t("err.invalidAction")}

    @app.post("/lora_new/api/llm_repo_files")
    def api_llm_repo_files(payload: dict):
        repo = _normalize_repo(str(payload.get("repo") or ""))
        if not repo or "/" not in repo:
            return {"ok": False, "error": _t("err.repoFormat")}
        files = _hf_list_gguf(repo)
        if not files:
            return {"ok": False, "error": _t("err.repoNoGguf"), "repo": repo}
        files.sort(key=lambda x: x["filename"])
        return {"ok": True, "repo": repo, "files": files,
                "endpoint": _pick_hf_endpoint(), "dir": str(LLM_DIR)}

    @app.post("/lora_new/api/llm_download")
    def api_llm_download(payload: dict):
        repo = _normalize_repo(str(payload.get("repo") or ""))
        filename = str(payload.get("filename") or "")
        if not repo or "/" not in repo:
            return {"ok": False, "error": _t("err.invalidRepo")}
        if not filename.lower().endswith(".gguf") or ".." in filename:
            return {"ok": False, "error": _t("err.invalidFilename")}
        with _download_lock:
            if _download_state["active"]:
                return {"ok": False, "error": _t("err.downloadBusy")}
            _download_state.update(
                active=True, ok=False, error="", filename=filename,
                repo=repo, done=0, total=0, endpoint="",
            )
        threading.Thread(target=_download_worker, args=(repo, filename), daemon=True).start()
        return {"ok": True, "filename": filename}

    @app.get("/lora_new/api/llm_download_status")
    def api_llm_download_status():
        with _download_lock:
            return {"ok": True, **_download_state}

    @app.get("/lora_new/api/runtime_info")
    def api_runtime_info(force: bool = False):
        probe = _probe_runtime(force=bool(force))
        nv_ok, nv_ver = _nvidia_ok()
        return {
            "ok": True,
            "installed": probe["installed"],     # 是否装了 llama_cpp
            "usable": probe["usable"],           # 是否能正常导入（装了但导不进来时为 False）
            "build": probe["build"],             # "cuda" / "cpu" / ""
            "version": RUNTIME_VERSION,
            "cuda_wheel_ready": _cuda_wheel_downloaded(),
            "nvidia_ok": nv_ok,
            "driver": nv_ver,
            "min_driver": ".".join(str(x) for x in MIN_CUDA_DRIVER),
        }

    @app.post("/lora_new/api/runtime_download_cuda")
    def api_runtime_download_cuda():
        if _cuda_wheel_downloaded():
            return {"ok": True, "already": True}
        nv_ok, nv_ver = _nvidia_ok()
        if not nv_ok:
            min_ver = ".".join(str(x) for x in MIN_CUDA_DRIVER)
            hint = _t("err.driverHint", v=nv_ver) if nv_ver else ""
            return {"ok": False, "error": _t("err.noNvidia", min=min_ver, hint=hint)}
        with _runtime_dl_lock:
            if _runtime_dl_state["active"]:
                return {"ok": False, "error": _t("err.downloadBusy")}
            # done 从已有 .part 的大小起算：续传时进度条直接从中断处继续
            _runtime_dl_state.update(
                active=True, ok=False, error="", done=_cuda_wheel_partial_size(), total=0, attempt=0,
            )
        threading.Thread(target=_cuda_wheel_worker, daemon=True, name="lna-cuda-wheel").start()
        return {"ok": True}

    @app.get("/lora_new/api/runtime_download_status")
    def api_runtime_download_status():
        with _runtime_dl_lock:
            st = dict(_runtime_dl_state)
        return {
            "ok": True,
            "active": st["active"],
            "done": st["done"],
            "total": st["total"],
            "attempt": st["attempt"],
            "error": st["error"],
            "finished": st["ok"],           # 命名避开与请求状态 ok 冲突
            "cuda_wheel_ready": _cuda_wheel_downloaded(),
        }

    @app.post("/lora_new/api/match_old_data")
    def api_match_old_data():
        try:
            return match_old_data()
        except Exception as e:
            return {"ok": False, "error": _t("err.matchFailed", msg=e)}

    @app.post("/lora_new/api/sync_old_json")
    def api_sync_old_json():
        try:
            return sync_old_json()
        except Exception as e:
            return {"ok": False, "error": _t("err.syncFailed", msg=e)}

    @app.post("/lora_new/api/sync_old_json_overwrite")
    async def api_sync_old_json_overwrite(payload: dict):
        try:
            return overwrite_from_old_json(payload.get("rel", ""))
        except Exception as e:
            return {"ok": False, "error": _t("err.overwriteFailed", msg=e)}

    @app.post("/lora_new/api/sync_old_json_compare")
    async def api_sync_old_json_compare(payload: dict):
        try:
            return compare_old_json(payload.get("rel", ""))
        except Exception as e:
            return {"ok": False, "error": _t("err.compareFailed", msg=e)}

    @app.post("/lora_new/api/sync_old_json_unify")
    async def api_sync_old_json_unify(payload: dict):
        try:
            return unify_old_json_field(
                payload.get("rel", ""), payload.get("key", ""), payload.get("direction", "")
            )
        except Exception as e:
            return {"ok": False, "error": _t("err.unifyFailed", msg=e)}

    @app.post("/lora_new/api/user_metadata")
    async def api_user_metadata(payload: dict):
        rel = _safe_rel(payload.get("rel", ""))
        if not rel:
            return {"ok": False, "error": _t("err.invalidPath")}
        try:
            weight = float(payload.get("preferred_weight", 0) or 0)
        except Exception:
            weight = 0.0
        # 写入按模型镜像的 JSON（保留 hash/size/tags/translations 等既有字段）
        # 读-改-写整体持锁，避免与译文落盘并发互相覆盖
        with _json_lock:
            data = _get_card_data(rel)
            data["description"] = str(payload.get("description", ""))
            data["base_model"] = str(payload.get("base_model", "Unknown"))
            data["activation_text"] = str(payload.get("activation_text", ""))
            data["preferred_weight"] = weight
            data["negative_text"] = str(payload.get("negative_text", ""))
            data["notes"] = str(payload.get("notes", ""))
            saved = _save_card_json(rel, data)
        if not saved:
            return {"ok": False, "error": _t("err.writeJsonFailed")}
        # 同步清理旧存储中的遗留条目（迁移后不应再存在）
        if rel in _stats["user_metadata"]:
            _stats["user_metadata"].pop(rel, None)
            _save_stats()
        return {"ok": True}

    @app.post("/lora_new/api/preview")
    async def api_preview(rel: str = "", file: UploadFile = File(...)):
        safe = _safe_rel(rel)
        if not safe:
            return {"ok": False, "error": _t("err.invalidPath")}
        path = LORA_DIR / safe
        if not path.is_file():
            return {"ok": False, "error": _t("err.fileNotFound")}
        ctype = (file.content_type or "").lower()
        if "jpeg" in ctype or "jpg" in ctype:
            ext = ".jpg"
        elif "webp" in ctype:
            ext = ".webp"
        else:
            ext = ".png"
        try:
            data = await file.read()
            if not data:
                return {"ok": False, "error": _t("err.emptyUpload")}
            # 「替换」语义：先清掉同名旧预览，保证新图成为唯一预览
            for old_ext in (".png", ".jpg", ".jpeg", ".webp"):
                old = path.parent / (path.stem + old_ext)
                if old.is_file():
                    try:
                        old.unlink()
                    except Exception:
                        pass
            target = path.parent / (path.stem + ext)
            target.write_bytes(data)
        except Exception as e:
            return {"ok": False, "error": _t("err.writeFailed", msg=e)}
        _stats["custom_previews"].pop(safe, None)
        _save_stats()
        rel_out = _rel(target)
        return {"ok": True, "preview": rel_out, "preview_ver": _preview_ver(rel_out)}

    @app.post("/lora_new/api/folder_preview")
    async def api_folder_preview(rel: str = "", file: UploadFile = File(...)):
        safe = _safe_rel(rel)
        abs_dir = (LORA_DIR / safe) if safe else LORA_DIR
        if not abs_dir.is_dir():
            return {"ok": False, "error": _t("err.folderNotFound")}
        ctype = (file.content_type or "").lower()
        if "jpeg" in ctype or "jpg" in ctype:
            ext = ".jpg"
        elif "webp" in ctype:
            ext = ".webp"
        else:
            ext = ".png"
        try:
            data = await file.read()
            if not data:
                return {"ok": False, "error": _t("err.emptyUpload")}
            # 「替换」语义：先清掉旧封面，保证新图成为唯一封面
            for old_ext in (".png", ".jpg", ".jpeg", ".webp"):
                old = abs_dir / (FOLDER_COVER_STEM + old_ext)
                if old.is_file():
                    try:
                        old.unlink()
                    except Exception:
                        pass
            target = abs_dir / (FOLDER_COVER_STEM + ext)
            target.write_bytes(data)
        except Exception as e:
            return {"ok": False, "error": _t("err.writeFailed", msg=e)}
        return {"ok": True, "preview": _rel(target), "preview_ver": _preview_ver(_rel(target))}

    @app.get("/lora_new/api/dict_lookup")
    def api_dict_lookup(tag: str = ""):
        if not tag.strip():
            return {"ok": False, "error": _t("err.tagEmpty")}
        return _dict_lookup(tag)

    @app.post("/lora_new/api/dict_upsert")
    async def api_dict_upsert(payload: dict):
        return _dict_upsert(str(payload.get("tag", "")), str(payload.get("value", "")))

    @app.post("/lora_new/api/dict_check")
    async def api_dict_check(payload: dict):
        """批量查询多个标签的词典收录情况：返回是否命中及其现值，
        供「将译文加入词典」弹窗判断标签该显示绿/黄橙/红。"""
        tags = payload.get("tags") or []
        if not isinstance(tags, list):
            return {"ok": False, "error": _t("err.badParams")}
        _load_tag_dict()
        result = {}
        for t in tags:
            t = str(t)
            key = _normalize_tag(t)
            result[t] = {"found": key in _tag_dict, "value": _tag_dict.get(key, "")}
        return {"ok": True, "dict": result}

    @app.get("/lora_new/api/ui_settings")
    def api_ui_settings_get():
        with _ui_settings_lock:
            return {"ok": True, "settings": dict(_ui_settings)}

    @app.post("/lora_new/api/ui_settings")
    async def api_ui_settings_set(payload: dict):
        return {"ok": True, "settings": _update_ui_settings(payload.get("settings") or {})}

    @app.post("/lora_new/api/tag_translation")
    async def api_tag_translation(payload: dict):
        """人工修正单条标签译文：写入该模型的镜像 JSON + 全局译文缓存，重开卡片仍生效。"""
        rel = _safe_rel(str(payload.get("rel") or ""))
        tag = str(payload.get("tag") or "").strip()
        value = " ".join(str(payload.get("value") or "").split())
        if not rel:
            return {"ok": False, "error": _t("err.invalidPath")}
        if not tag or not value:
            return {"ok": False, "error": _t("err.tagOrZhEmpty")}
        # 随模型迁移：并入 translations.zh，供 card_info 读取显示
        _store_card_translations(rel, "zh", {tag: value})
        # 全局缓存按当前模型分桶：后续非强制的翻译直接复用人工译文
        with _json_lock:
            _load_trans_cache()
            key = _cache_key()
            if key:
                _trans_cache.setdefault(key, {})[tag] = value
                _save_trans_cache()
        return {"ok": True, "tag": tag, "value": value}

    @app.post("/lora_new/api/use")
    async def api_use(payload: dict):
        rel = payload.get("rel", "")
        if rel:
            _stats["usage_count"][rel] = _stats["usage_count"].get(rel, 0) + 1
            _save_stats()
        # 附带卡片资料，前端据此把触发词写入正提示词、反向提示词写入负提示词框
        user = _get_card_data(_safe_rel(rel))
        return {
            "ok": True,
            "count": _stats["usage_count"].get(rel, 0),
            "activation_text": str(user.get("activation_text", "")),
            "negative_text": str(user.get("negative_text", "")),
            "preferred_weight": float(user.get("preferred_weight", 0) or 0),
        }

    @app.post("/lora_new/api/view")
    async def api_view(payload: dict):
        rel = payload.get("rel", "")
        if rel:
            _stats["last_viewed"][rel] = time.time()
            _save_stats()
        return {"ok": True, "ts": _stats["last_viewed"].get(rel, 0)}


# ---------- Extra Networks 页面（注册成真实的 Gradio Tab） ----------
# 注册为 Extra Networks 下的一个页面后，tab 按钮与面板显隐全部由 Gradio 的
# Tabs/TabItem 组件管理，插件不再手动改写框架节点（旧实现会与框架状态冲突，
# 导致切回原生 tab 内容区空白、插件 tab 恒为选中态）。界面由前端脚本挂载。
LORA_NEW_TABNAME = "lora_new"   # 最终 elem_id 形如 txt2img_lora_new


def _build_lora_new_page():
    """构造 LoRA 管理器的 Extra Networks 页面实例。"""
    from modules import ui_extra_networks

    class ExtraNetworksPageLoraNew(ui_extra_networks.ExtraNetworksPage):
        def __init__(self):
            super().__init__(_t("page.title"))
            # title 是中文，派生出的 tab 名不可用；固定为 ASCII 以保证 elem_id 稳定
            self.name = LORA_NEW_TABNAME
            self.extra_networks_tabname = LORA_NEW_TABNAME
            # 不把提示词行搬进本页，保持插件原有布局
            self.allow_prompt = False
            self.allow_negative_prompt = False

        def refresh(self):
            pass

        def allowed_directories_for_previews(self):
            return []

        def create_card_view_html(self, tabname, *, none_message):
            # 本页不展示 Forge 的卡片；返回空串以免面板里出现默认的 "Loading..." 占位文案
            return ""

        def create_html(self, tabname, empty=False):
            """复用 Forge 的标准 pane 结构，再把本插件的挂载点附在后面。

            必须保留标准 pane 结构（关键是其中那个 {tabname}_lora_new_extra_search 搜索框）：
            javascript/extraNetworks.js 的就绪判定会把 [id$='_extra_search'] 的元素个数
            与 [id$='_extra_tabs'] > .tab-nav > button 的按钮数 − 2 作比较，成立后才执行
            setupExtraNetworks()——而它负责创建 tab 栏右侧控件容器、注册搜索过滤与提示词
            输入框，是嵌入式/模型/Lora 三页共同依赖的全局初始化。
            本页若不带搜索框，该判定永远不成立，三页会一起失效。
            """
            base = super().create_html(tabname, empty=True)
            return base + f'<div class="lna-mount" data-lna-tab="{tabname}"></div>'

        def create_user_metadata_editor(self, ui, tabname):
            # 本页不需要 Forge 的「用户元数据编辑」子系统，给一个空壳即可。
            # 注意必须同时提供 create_ui / setup_ui：create_ui() 里会调用
            # editor.create_ui()，随后 ui_extra_networks.setup_ui() 会对每个
            # editor 调 setup_ui(gallery)；缺任一方法都会让 UI 构建抛错、WebUI 起不来。
            class _NoopEditor:
                def create_ui(self):
                    pass

                def setup_ui(self, gallery):
                    pass

            return _NoopEditor()

    return ExtraNetworksPageLoraNew()


def _install_tab_order():
    """把「LoRA 管理器」排到「Lora」之后。

    页面顺序在 ui_extra_networks.create_ui() 里由 pages_in_preferred_order() 计算，
    那一刻所有页面都已注册完毕，所以在这里包一层最可靠。
    不去猜各扩展 before_ui 回调的执行先后：before_ui_callback() 是反向遍历
    （for c in reversed(...)），且扩展的启用/禁用会改变回调注册顺序，
    靠回调先后排位并不稳定。

    只做内存内的函数包装，不修改任何全局文件；包装或排序失败时静默降级，
    插件功能不受影响，只是 tab 位置回到默认注册顺序。
    """
    from modules import ui_extra_networks
    if getattr(ui_extra_networks.pages_in_preferred_order, "_lna_wrapped", False):
        return
    original = ui_extra_networks.pages_in_preferred_order

    def pages_in_preferred_order(pages):
        ordered = list(original(pages))
        try:
            lora_idx = next((i for i, p in enumerate(ordered)
                             if getattr(p, "extra_networks_tabname", "") == "lora"), None)
            mine_idx = next((i for i, p in enumerate(ordered)
                             if getattr(p, "extra_networks_tabname", "") == LORA_NEW_TABNAME), None)
            if lora_idx is not None and mine_idx is not None and mine_idx != lora_idx + 1:
                page = ordered.pop(mine_idx)
                if mine_idx < lora_idx:
                    lora_idx -= 1
                ordered.insert(lora_idx + 1, page)
        except Exception:
            pass
        return ordered

    pages_in_preferred_order._lna_wrapped = True
    ui_extra_networks.pages_in_preferred_order = pages_in_preferred_order


def _register_lora_new_page():
    """在 UI 构建前注册页面（幂等）。

    必须在 on_before_ui 里注册而不能在导入期注册：扩展脚本导入后，
    initialize_rest() 会调用 ui_extra_networks.initialize() 清空 extra_pages，
    导入期的注册会被抹掉；before_ui 回调则在清空之后、create_ui 之前执行，
    启动与「重载 UI」两条路径都能生效。
    """
    from modules import ui_extra_networks
    pages = ui_extra_networks.extra_pages
    if not any(getattr(p, "extra_networks_tabname", "") == LORA_NEW_TABNAME for p in pages):
        try:
            ui_extra_networks.register_page(_build_lora_new_page())
        except Exception:
            pass
    _install_tab_order()


script_callbacks.on_before_ui(_register_lora_new_page)
script_callbacks.on_app_started(on_app_started)
