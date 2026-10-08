"""LoRA 加载引擎（从 extensions-builtin/sd_forge_lora 移植的精简版）。

为什么需要它
------------
`<lora:名字:权重>` 这个提示词语法本身不是 WebUI 内核能力，而是由内置扩展
sd_forge_lora 在它的 before_ui 回调里注册的 `ExtraNetworkLora` 处理器提供的
（见 extensions-builtin/sd_forge_lora/scripts/lora_script.py）。因此关掉该扩展后，
本插件写进提示词框的 `<lora:...>` 就没人解析，LoRA 不会真正加载。

本包把「枚举 LoRA 文件 + 解析 `<lora:...>` + 调用 Forge backend 打补丁」这条链路
移植进来，使 sd_forge_lora 未启用时本插件仍能独立工作。

与内置扩展的关系
----------------
- 两者同时启用时**本引擎不注册**：modules/extra_networks.py 的
  extra_network_registry 是按名字索引的 dict，后注册者会覆盖先注册者，
  重复注册会造成状态错乱。守卫见 register_extra_network_lora()。
- 只做内存内注册，不修改任何全局文件；不启用时本包完全不会被导入。

模块命名
--------
内置扩展用的是裸模块名（`network` / `networks` / `lora`）——靠 sys.path 解析。
本包放在独立命名空间下，包内一律使用相对导入，避免与内置扩展互相顶掉。

移植范围（有意的裁剪）
----------------------
只保留让 `<lora:...>` 生效所必需的链路；未移植内置扩展里与 AddNet 旧参数粘贴、
`lora_preferred_name` 之外的兼容性选项、lora.py 的第三方兼容别名等外围功能。
参数注释说明哪些地方对缺失的 WebUI 选项做了容错（关掉内置扩展后，那些选项
不会出现在 shared.opts 里）。
"""

from . import network, networks  # noqa: F401  （network 被 networks 惰性引用）
from .handler import ExtraNetworkLora

__all__ = ["ExtraNetworkLora", "register_extra_network_lora", "network", "networks"]


def register_extra_network_lora() -> bool:
    """注册 `<lora:...>` 处理器；若已有 'lora' 处理器则跳过。

    返回是否真的注册了。应在 on_app_started 阶段调用：那时所有扩展的
    before_ui 都已执行完，注册表是最终状态，判断不受回调先后影响。
    """
    from modules import extra_networks

    if "lora" in extra_networks.extra_network_registry:
        return False  # sd_forge_lora 已提供，避免重复注册

    networks.list_available_networks()
    handler = ExtraNetworkLora()
    networks.extra_network_lora = handler
    extra_networks.register_extra_network(handler)
    return True
