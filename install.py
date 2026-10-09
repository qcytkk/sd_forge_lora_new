"""sd_forge_lora_new 安装脚本：静默安装 llama-cpp-python（标签翻译用的推理运行时）。

分两种安装，都在 WebUI 启动阶段完成（此时没有任何进程占用 DLL，可直接覆盖安装）：

1) CPU 版（保底，默认路径）：优先用随插件分发的
   wheels/llama_cpp_python-*-py3-none-win_amd64.whl（`pip install --no-index --no-deps`，
   全程不联网）；本地轮子缺失或装不上时，再从预编译轮子索引在线装 CPU 版。
   目的是「零操作、开箱可用」，即使网络不通也能用 CPU 推理。

2) CUDA 版（用户主动选择）：用户在插件设置里点「安装 CUDA 版本，使用 GPU 推理」后，
   轮子会被下载到 wheels/cuda/；本脚本检测到它就强装该轮子。
   CUDA 版自带 CPU 后端，故 GPU 推理优先、显存不足时插件会自动改用 CPU——GPU/CPU 都可用。
   安装失败或装完无法导入时，会把该轮子重命名隔离（避免每次启动反复重试），并保证 CPU 版可用。

注意：CPU 轮子与 CUDA 轮子版本号相同，pip 会因「Requirement already satisfied」跳过替换，
因此这里一律带 --force-reinstall。

以下情况直接跳过（只打日志，不报错，不影响 WebUI 启动）：
- 当前 CPU 不支持 AVX2（预编译轮子在老 CPU 上会以 Illegal instruction 崩掉进程）

由 WebUI 在每次启动时自动执行（modules/launch_utils.py 的 run_extensions_installers），
使用 --skip-install 启动时不会执行。只操作插件目录与 WebUI 的 Python 环境，不改全局文件。
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WHEELS_DIR = os.path.join(HERE, "wheels")
CUDA_WHEELS_DIR = os.path.join(WHEELS_DIR, "cuda")
# 随插件分发的轮子文件名前缀，用于在 wheels/ 中挑选
WHEEL_PREFIX = "llama_cpp_python-"

DIST_NAME = "llama-cpp-python"          # pip 包名
IMPORT_NAME = "llama_cpp"               # 导入名

# CPU 预编译轮子索引（索引页在 GitHub Pages，轮子本体在 GitHub Releases）
CPU_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/cpu"


def _log(msg: str) -> None:
    print(f"[sd_forge_lora_new] {msg}")


def already_installed() -> bool:
    """llama_cpp 是否已安装。用 find_spec 而非 import，避免 CUDA 版 DLL 缺失时误判。"""
    try:
        return importlib.util.find_spec(IMPORT_NAME) is not None
    except Exception:
        return False


def cpu_supports_avx2() -> bool | None:
    """当前 CPU 是否支持 AVX2。返回 None 表示无法判定（此时按「支持」处理）。

    预编译轮子编译时启用了 AVX2/FMA，在不支持的老 CPU 上加载即崩溃（不是异常，
    而是进程直接挂掉），所以安装前先做一次能力判断。
    """
    try:
        import torch  # WebUI 自带；此处只读取 CPU 指令集能力，不做计算

        cap = str(torch.backends.cpu.get_cpu_capability()).upper()
        return cap in ("AVX2", "AVX512")
    except Exception:
        return None


def pick_local_wheel() -> str | None:
    """在 wheels/ 顶层挑出 CPU 轮子（py3-none 或本机的 cpXX 标签）。不含 wheels/cuda/。"""
    if not os.path.isdir(WHEELS_DIR):
        return None
    cp = f"cp{sys.version_info.major}{sys.version_info.minor}"
    for name in sorted(os.listdir(WHEELS_DIR)):
        if not name.startswith(WHEEL_PREFIX) or not name.endswith("-win_amd64.whl"):
            continue
        if "-py3-none-" in name or f"-{cp}-{cp}-" in name:
            return os.path.join(WHEELS_DIR, name)
    return None


def pick_cuda_wheel() -> str | None:
    """在 wheels/cuda/ 中挑出用户下载的 CUDA 轮子（文件名与 CPU 轮子相同，靠目录区分）。"""
    if not os.path.isdir(CUDA_WHEELS_DIR):
        return None
    for name in sorted(os.listdir(CUDA_WHEELS_DIR)):
        if name.startswith(WHEEL_PREFIX) and name.endswith("-win_amd64.whl"):
            return os.path.join(CUDA_WHEELS_DIR, name)
    return None


def _prepare_dll_env() -> None:
    """把 CUDA 12 运行库所在目录并入 PATH，供 CUDA 版轮子的 llama.dll / ggml-cuda.dll 加载。

    官方 cu124 轮子**不自带** cudart/cublas（只有内核），必须从外部找到它们。
    WebUI 自带的 torch 里正好有 CUDA 12 的运行库
    （cudart64_12 / cublas64_12 / cublasLt64_12），最优先使用它——这样没装 CUDA Toolkit
    的机器也能用 CUDA 版；其次再补本机 CUDA Toolkit 的 bin 目录。

    这一步必须做，否则 verify_import() 会因找不到依赖 DLL 而失败，把可用的 CUDA 版误判为不可用。
    """
    if os.name != "nt":
        return
    dirs: list[str] = []
    # WebUI 自带的 torch 里有 CUDA 12 运行库（cudart64_12 / cublas64_12 / cublasLt64_12）。
    # 用 find_spec 定位而不 import torch：同样能拿到目录，且避免每次启动都付几秒的导入开销。
    try:
        spec = importlib.util.find_spec("torch")
        base = None
        if spec is not None:
            if spec.submodule_search_locations:
                base = list(spec.submodule_search_locations)[0]
            elif spec.origin:
                base = os.path.dirname(spec.origin)
        tlib = os.path.join(base, "lib") if base else ""
        if tlib and os.path.isdir(tlib):
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
    if not dirs:
        return
    # 子进程（pip / import 校验）默认继承本进程环境，故改 PATH 即可生效
    os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except Exception:
            pass


def verify_import() -> tuple[bool, str]:
    """在子进程里真正 import 一次 llama_cpp，返回 (是否成功, 失败原因)。

    放到子进程是为了不被拖累：若装上的构建与 CPU 指令集不兼容，导入会直接
    以 Illegal instruction 结束进程；同时把失败原因带回来，便于在启动日志里定位。
    """
    try:
        r = subprocess.run([sys.executable, "-c", f"import {IMPORT_NAME}"],
                           capture_output=True, text=True, timeout=180)
    except Exception as e:
        return False, str(e)
    if r.returncode == 0:
        return True, ""
    lines = [ln.strip() for ln in ((r.stderr or "") + "\n" + (r.stdout or "")).splitlines() if ln.strip()]
    return False, (lines[-1] if lines else f"退出码 {r.returncode}")


def install_wheel(wheel: str) -> int:
    """安装本地轮子：--no-index 禁用索引、--no-deps 不动依赖，全程不联网。
    --force-reinstall 是必需的：CPU/CUDA 轮子版本号相同，否则 pip 会判定「已满足」而跳过。"""
    cmd = [
        sys.executable, "-m", "pip", "install",
        "--no-index", "--no-deps", "--force-reinstall",
        "--disable-pip-version-check", "--no-warn-script-location", wheel,
    ]
    _log("本地安装 " + os.path.basename(wheel))
    return subprocess.call(cmd)


def install_from_index(label: str, index_url: str) -> int:
    """从预编译轮子索引在线安装。--only-binary 禁止回退到源码编译；
    pip 会按当前解释器自动匹配轮子，匹配不到就快速失败（而不是尝试编译）。"""
    cmd = [
        sys.executable, "-m", "pip", "install",
        "--index-url", index_url,
        "--only-binary=:all:", "--no-deps", "--force-reinstall",
        "--disable-pip-version-check", "--no-warn-script-location",
        "--timeout", "30", "--retries", "1",
        DIST_NAME,
    ]
    _log(f"在线安装（{label}）：{index_url}")
    return subprocess.call(cmd)


def install_cpu() -> bool:
    """CPU 版安装：优先本地轮子（零网络），其次 CPU 索引。返回是否可用（能导入）。"""
    wheel = pick_local_wheel()
    if wheel is not None:
        try:
            if install_wheel(wheel) == 0:
                ok, why = verify_import()
                if ok:
                    return True
                _log(f"本地轮子安装后无法导入：{why}，改用在线方式")
        except Exception as e:
            _log(f"本地安装失败：{e}")
    try:
        if install_from_index("CPU", CPU_INDEX) == 0:
            ok, why = verify_import()
            if ok:
                return True
            _log(f"在线安装的 CPU 版无法导入：{why}")
    except Exception as e:
        _log(f"在线安装失败（CPU）：{e}")
    return False


def quarantine(wheel: str) -> None:
    """把装不成功的轮子改名隔离，避免每次启动都重复尝试同一个坏文件。"""
    try:
        os.replace(wheel, wheel + ".failed")
    except Exception:
        pass


def remove_quiet(path: str) -> None:
    """删除已成功安装的轮子文件；失败静默。

    必须删除：否则 wheels/cuda/ 里的轮子会一直存在，导致每次启动都重复强装一遍。
    删除后再次启动会走「已装且能导入 → 不动」的分支直接退出。
    """
    try:
        os.remove(path)
    except Exception:
        pass


def main() -> None:
    _prepare_dll_env()  # 很便宜：只查目录、拼 PATH，供 CUDA 版轮子加载 cudart/cublas

    cuda_wheel = pick_cuda_wheel()
    installed = already_installed()
    ok = verify_import()[0] if installed else False

    # 每次启动留一行结论：排查问题时一眼能看出走到哪一步、为什么没装
    _log("运行时检查：已安装={0}、可正常导入={1}、wheels/cuda 待装轮子={2}".format(
        "是" if installed else "否", "是" if ok else "否", "有" if cuda_wheel else "无"))

    if cuda_wheel is None and ok:
        return  # 已经能用了，且没有新轮子要装

    if cpu_supports_avx2() is False:
        _log("当前 CPU 不支持 AVX2，跳过安装（预编译轮子会崩溃，标签翻译将仅使用内置词典）")
        return

    # 1) 用户已下载 CUDA 轮子 → 优先强装（CUDA 版自带 CPU 后端，GPU/CPU 都可用）
    if cuda_wheel is not None:
        try:
            if install_wheel(cuda_wheel) == 0:
                ok2, why2 = verify_import()
                if ok2:
                    remove_quiet(cuda_wheel)  # 装好即删，避免每次启动重复强装
                    _log("已安装 CUDA 版 llama-cpp-python（GPU 优先，显存不足时自动改用 CPU）")
                    return
                _log(f"CUDA 版安装后无法导入：{why2}")
        except Exception as e:
            _log(f"CUDA 版安装失败：{e}")
        quarantine(cuda_wheel)
        _log("CUDA 版不可用，改用 CPU 版")

    # 2) 仍然可用（含上面的失败回退后依旧可用）→ 不动
    if ok:
        return

    # 3) CPU 版保底（本地零网络优先）
    if install_cpu():
        _log("已安装 CPU 版 llama-cpp-python")
    else:
        _log("未能安装 llama-cpp-python，标签翻译将仅使用内置词典")


if __name__ == "__main__":
    main()
