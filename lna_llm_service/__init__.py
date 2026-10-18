"""本地 LLM 翻译共享服务。

sd_forge_lora_new 与 sd-webui-prompt-all-in-one-forge 共用同一份实现的入口。
使用方先把 <extensions>/sd_forge_lora_new 加入 sys.path，再 `import lna_llm_service`。
"""
from . import core

__all__ = ["core"]
