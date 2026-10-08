"""sd_forge_lora_new — 自定义 LoRA 管理器后端
注入到 txt2img_extra_tabs / img2img_extra_tabs，替代原版 sd_forge_lora 的 Extra Networks 页面。
"""
from __future__ import annotations

import csv
import json
import os
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import gradio as gr
from fastapi import FastAPI, File, UploadFile
from fastapi.staticfiles import StaticFiles

from modules import paths, script_callbacks

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
        return {"ok": False, "error": "无效的文件路径"}
    path = LORA_DIR / safe
    if not path.is_file() or path.suffix.lower() not in LORA_EXTS:
        return {"ok": False, "error": "文件不存在"}
    if path.suffix.lower() != ".safetensors":
        return {"ok": False, "error": "仅 .safetensors 支持读取内部元数据"}
    try:
        # 延迟导入，避免扩展加载时引入 sd_models 的重依赖
        from modules import cache, sd_models

        def _read() -> dict:
            return sd_models.read_metadata_from_safetensors(str(path))

        meta = cache.cached_data_for_file(
            "safetensors-metadata", "lora_new/" + safe, str(path), _read
        ) or {}
    except Exception as e:
        return {"ok": False, "error": f"读取失败：{e}"}

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
        return {"ok": False, "error": "无效的文件路径"}
    path = LORA_DIR / safe
    if not path.is_file() or path.suffix.lower() not in LORA_EXTS:
        return {"ok": False, "error": "文件不存在"}
    try:
        st = path.stat()
    except Exception:
        return {"ok": False, "error": "无法读取文件信息"}

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
        {"label": "文件名", "value": safe},
        {"label": "文件大小", "value": _human_size(st.st_size)},
        {"label": "哈希值", "value": _short_hash(path, safe, meta)},
        {"label": "最后修改日期", "value": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))},
    ]
    for key, label in (
        ("ss_output_name", "输出名称"),
        ("ss_sd_model_name", "模型"),
        ("ss_clip_skip", "CLIP 终止层数"),
        ("ss_network_module", "Kohya 模块类型"),
    ):
        val = meta.get(key)
        if val is not None and str(val) != "None":
            table.append({"label": label, "value": str(val)})

    started = meta.get("ss_training_started_at")
    if started:
        try:
            table.append({
                "label": "训练日期",
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
                "label": "分辨率",
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
        table.append({"label": "数据集大小", "value": str(img_count)})

    tags = build_tags(meta)[:24]
    # 卡片资料改从 models_json_data 的镜像 JSON 读取；首次访问时补齐重定向锚点
    user = _get_card_data(safe)
    if not user.get("hash") or not user.get("size"):
        if not user.get("hash"):
            hash_row = next((r for r in table if r.get("label") == "哈希值"), None)
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
        return {"ok": False, "error": "文件夹不存在"}
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
        return {"ok": False, "error": "标签或译文为空"}
    with _dict_lock:
        rows: list[list[str]] = []
        try:
            if DICT_FILE.exists():
                with DICT_FILE.open("r", encoding="utf-8", errors="ignore", newline="") as f:
                    rows = [r for r in csv.reader(f) if r]
        except Exception as e:
            return {"ok": False, "error": f"读取词典失败：{e}"}
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
            return {"ok": False, "error": f"写入词典失败：{e}"}
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
    """把 CUDA 运行库目录并入 PATH，供 CUDA 版 llama.dll 加载依赖（只做一次）。

    CUDA 构建的 llama.dll 依赖 cudart/cublas 等运行时 DLL，而 llama_cpp 自带的
    加载器只通过 CUDA_PATH 环境变量定位它们（ctypes 默认加载模式不读
    os.add_dll_directory）。若 WebUI 进程的 PATH 里没有 CUDA —— 例如从桌面
    快捷方式启动、或 CUDA Toolkit 未加入系统 PATH —— import llama_cpp 会因
    llama.dll 加载失败抛 RuntimeError，插件就会误报「未检测到 llama_cpp 模块」。
    这里主动补齐 PATH，使插件不依赖启动环境。
    """
    global _llama_dll_ready
    if _llama_dll_ready:
        return
    _llama_dll_ready = True
    if os.name != "nt":
        return
    dirs: list[str] = []
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
        _llm_load_error = "模型文件不存在，请在「标签翻译设置」中重新选择"
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
            _llm_load_error = f"加载失败：{e}"
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
                    _llm_load_error = "显存不足，本次已自动改用 CPU"
                except Exception as e2:
                    _llm = None
                    _llm_path = ""
                    _llm_load_error = f"加载失败：{e2}"
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
3. 角色名、作品名、以及无法翻译的自造触发词（如 kei1、my_style_v2）原样返回英文。
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
            _llm_load_error = f"推理失败：{e}"
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
            "模型未返回可解析的 JSON，请检查「翻译提示预设」内容"
            if not data else
            "模型返回的标签名与原文对不上，请检查「翻译提示预设」内容"
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
            engine_note = _llm_last_note or _llm_load_error or "未启用 GGUF 模型"
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
                last_err = f"数据不完整（{size}/{total} 字节）"
                continue
            tmp.replace(dest)  # 完整落盘后才改名，避免半成品被当成可用模型
            with _download_lock:
                _download_state.update(active=False, ok=True, error="")
            return
        raise RuntimeError(last_err or "多次重试后仍未完成")
    except Exception as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        with _download_lock:
            _download_state.update(active=False, ok=False, error=f"下载失败：{e}")


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
        return f"打开失败：{e}"
    return None


def on_app_started(_: gr.Blocks, app: FastAPI) -> None:
    if LORA_DIR.exists():
        app.mount("/lora_new_files", StaticFiles(directory=str(LORA_DIR)), name="lora_new_files")
    _ensure_watchdog()  # 启动空闲自动卸载守护线程（只启动一次）
    _ensure_lora_engine()  # sd_forge_lora 未启用时自带 <lora:...> 引擎

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
            return {"ok": False, "error": "文件夹不存在"}
        err = _open_in_explorer(abs_dir)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": str(abs_dir)}

    @app.post("/lora_new/api/llm_open_folder")
    def api_llm_open_folder():
        try:
            LLM_DIR.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return {"ok": False, "error": f"模型目录不可用：{e}"}
        err = _open_in_explorer(LLM_DIR)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "path": str(LLM_DIR)}

    @app.post("/lora_new/api/translate")
    def api_translate(payload: dict):
        tags = payload.get("tags", [])
        if not isinstance(tags, list):
            return {"ok": False, "error": "tags 必须是数组"}
        # 全局「翻译正在进行」标记：多个浏览器标签页共用同一后端，
        # 已有任务在跑时直接拒绝（busy=true），前端据此显示忙碌态并轮询等待
        with _translate_state_lock:
            if _translate_state["busy"]:
                return {"ok": False, "busy": True, "error": "已有翻译任务在进行中"}
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
            return {"ok": False, "error": "当前 llama_cpp 为 CPU 构建，不支持 GPU。需安装 CUDA 版 llama-cpp-python。"}
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
            return {"ok": False, "error": "无效的模型路径"}
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
            return {"ok": False, "error": "无效的翻译方案"}
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
                return {"ok": False, "error": "请先填写预设名称"}
            if name == PROMPT_DEFAULT_NAME:
                return {"ok": False, "error": "「默认」预设为内置内容，请换个名称保存"}
            if len(name) > PROMPT_NAME_MAX:
                return {"ok": False, "error": f"预设名称不能超过 {PROMPT_NAME_MAX} 个字符"}
            if not text.strip():
                return {"ok": False, "error": "提示词不能为空"}
            if len(text) > PROMPT_TEXT_MAX:
                return {"ok": False, "error": f"提示词不能超过 {PROMPT_TEXT_MAX} 个字符"}
            if "{tags}" not in text:
                return {"ok": False, "error": "提示词必须包含 {tags} 占位符，用于插入待翻译的标签列表"}
            presets = _stats.setdefault("prompt_presets", {})
            presets[name] = text
            _stats["active_prompt"] = name
            _save_stats()
            return _prompt_payload()

        if action == "delete":
            if name == PROMPT_DEFAULT_NAME:
                return {"ok": False, "error": "「默认」预设为内置内容，不可删除"}
            presets = _stats.get("prompt_presets")
            if not isinstance(presets, dict) or name not in presets:
                return {"ok": False, "error": "预设不存在"}
            del presets[name]
            if str(_stats.get("active_prompt") or "") == name:
                _stats["active_prompt"] = ""  # 删掉正在用的 → 回到默认预设
            _save_stats()
            return _prompt_payload()

        if action == "select":
            if name not in _prompt_presets():
                return {"ok": False, "error": "预设不存在"}
            _stats["active_prompt"] = name
            _save_stats()
            return _prompt_payload()

        return {"ok": False, "error": "无效的操作"}

    @app.post("/lora_new/api/llm_repo_files")
    def api_llm_repo_files(payload: dict):
        repo = _normalize_repo(str(payload.get("repo") or ""))
        if not repo or "/" not in repo:
            return {"ok": False, "error": "请填写 owner/name 形式的仓库或 HF 链接"}
        files = _hf_list_gguf(repo)
        if not files:
            return {"ok": False, "error": "未找到 .gguf 文件（或网络不可用）", "repo": repo}
        files.sort(key=lambda x: x["filename"])
        return {"ok": True, "repo": repo, "files": files,
                "endpoint": _pick_hf_endpoint(), "dir": str(LLM_DIR)}

    @app.post("/lora_new/api/llm_download")
    def api_llm_download(payload: dict):
        repo = _normalize_repo(str(payload.get("repo") or ""))
        filename = str(payload.get("filename") or "")
        if not repo or "/" not in repo:
            return {"ok": False, "error": "无效的仓库"}
        if not filename.lower().endswith(".gguf") or ".." in filename:
            return {"ok": False, "error": "无效的文件名"}
        with _download_lock:
            if _download_state["active"]:
                return {"ok": False, "error": "已有下载任务在进行中"}
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

    @app.post("/lora_new/api/user_metadata")
    async def api_user_metadata(payload: dict):
        rel = _safe_rel(payload.get("rel", ""))
        if not rel:
            return {"ok": False, "error": "无效的文件路径"}
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
            return {"ok": False, "error": "写入 JSON 失败"}
        # 同步清理旧存储中的遗留条目（迁移后不应再存在）
        if rel in _stats["user_metadata"]:
            _stats["user_metadata"].pop(rel, None)
            _save_stats()
        return {"ok": True}

    @app.post("/lora_new/api/preview")
    async def api_preview(rel: str = "", file: UploadFile = File(...)):
        safe = _safe_rel(rel)
        if not safe:
            return {"ok": False, "error": "无效的文件路径"}
        path = LORA_DIR / safe
        if not path.is_file():
            return {"ok": False, "error": "文件不存在"}
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
                return {"ok": False, "error": "上传的文件为空"}
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
            return {"ok": False, "error": f"写入失败：{e}"}
        _stats["custom_previews"].pop(safe, None)
        _save_stats()
        rel_out = _rel(target)
        return {"ok": True, "preview": rel_out, "preview_ver": _preview_ver(rel_out)}

    @app.post("/lora_new/api/folder_preview")
    async def api_folder_preview(rel: str = "", file: UploadFile = File(...)):
        safe = _safe_rel(rel)
        abs_dir = (LORA_DIR / safe) if safe else LORA_DIR
        if not abs_dir.is_dir():
            return {"ok": False, "error": "文件夹不存在"}
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
                return {"ok": False, "error": "上传的文件为空"}
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
            return {"ok": False, "error": f"写入失败：{e}"}
        return {"ok": True, "preview": _rel(target), "preview_ver": _preview_ver(_rel(target))}

    @app.get("/lora_new/api/dict_lookup")
    def api_dict_lookup(tag: str = ""):
        if not tag.strip():
            return {"ok": False, "error": "标签为空"}
        return _dict_lookup(tag)

    @app.post("/lora_new/api/dict_upsert")
    async def api_dict_upsert(payload: dict):
        return _dict_upsert(str(payload.get("tag", "")), str(payload.get("value", "")))

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
            return {"ok": False, "error": "无效的文件路径"}
        if not tag or not value:
            return {"ok": False, "error": "标签或译文为空"}
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
            super().__init__("LoRA 管理器")
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
