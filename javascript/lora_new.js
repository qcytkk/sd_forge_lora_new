/* ========== sd_forge_lora_new — 注入到 txt2img/img2img extra_tabs ==========
   无障碍要点：
   - 树节点/卡片可键盘聚焦与操作（Enter/Space）
   - 排序下拉为 role=listbox，支持上下键 + Escape
   - 详情弹窗为 role=dialog + aria-modal，含焦点陷阱，Esc 关闭并回焦（Esc 关闭带 400ms 冷却）
   - 卡片设置弹窗的预览图可点开大图（滚轮缩放 / 拖拽 / WASD 移动，Esc 关闭）
   - 悬停出现的按钮在 :focus-within 时同样可见（见 style.css）
   - Toast 使用 aria-live=polite 播报 */
(function () {
  const API = {
    tree: '/lora_new/api/tree',
    list: '/lora_new/api/list',
    search: '/lora_new/api/search',
    metadata: '/lora_new/api/metadata',
    cardInfo: '/lora_new/api/card_info',
    modelTags: '/lora_new/api/model_tags',
    tagShow: '/lora_new/api/tag_show',
    folderInfo: '/lora_new/api/folder_info',
    userMeta: '/lora_new/api/user_metadata',
    preview: '/lora_new/api/preview',
    folderPreview: '/lora_new/api/folder_preview',
    openFolder: '/lora_new/api/open_folder',
    reveal: '/lora_new/api/reveal',
    translate: '/lora_new/api/translate',
    translateStatus: '/lora_new/api/translate_status',
    llmModels: '/lora_new/api/llm_models',
    llmOpenFolder: '/lora_new/api/llm_open_folder',
    llmSelect: '/lora_new/api/llm_select',
    llmGpu: '/lora_new/api/llm_gpu',
    llmUnload: '/lora_new/api/llm_unload',
    llmStatus: '/lora_new/api/llm_status',
    llmIdleSettings: '/lora_new/api/llm_idle_settings',
    translateMode: '/lora_new/api/translate_mode',
    promptPresets: '/lora_new/api/prompt_presets',
    llmRepoFiles: '/lora_new/api/llm_repo_files',
    llmDownload: '/lora_new/api/llm_download',
    llmDownloadStatus: '/lora_new/api/llm_download_status',
    runtimeInfo: '/lora_new/api/runtime_info',
    runtimeDownloadCuda: '/lora_new/api/runtime_download_cuda',
    runtimeDownloadStatus: '/lora_new/api/runtime_download_status',
    use: '/lora_new/api/use',
    view: '/lora_new/api/view',
    dictLookup: '/lora_new/api/dict_lookup',
    dictUpsert: '/lora_new/api/dict_upsert',
    dictCheck: '/lora_new/api/dict_check',
    tagTranslation: '/lora_new/api/tag_translation',
    uiSettings: '/lora_new/api/ui_settings',
    matchOldData: '/lora_new/api/match_old_data',
    syncOldJson: '/lora_new/api/sync_old_json',
    syncOldJsonOverwrite: '/lora_new/api/sync_old_json_overwrite',
    syncOldJsonCompare: '/lora_new/api/sync_old_json_compare',
    syncOldJsonUnify: '/lora_new/api/sync_old_json_unify',
    i18n: '/lora_new/api/i18n',
    uiLang: '/lora_new/api/ui_lang',
  };

  // ---------- 界面多语言（i18n） ----------
  // 语言包由后端 /lora_new/api/i18n 下发（唯一数据源），前端只做查找与 {占位符} 插值。
  // 拉取失败时 dict 为空，t() 原样返回 key，界面回落为 key 文本，不影响任何功能。
  const I18N = { lang: '', available: [], dict: {} };
  // 语言代码 → 显示名（下拉框用；新增语言时在此补一行即可，未登记则显示原始代码）
  const LANG_NAMES = { zh_CN: '简体中文', zh_TW: '繁體中文', en_US: 'English', ja_JP: '日本語', ko_KR: '한국어', fr_FR: 'Français', ru_RU: 'Русский' };

  function t(key, vars) {
    if (key == null) return '';
    const s = I18N.dict[key];
    if (s == null) return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  function langName(code) {
    return LANG_NAMES[code] || code;
  }

  // 启动时拉取当前语言的语言包（在首次渲染之前调用）
  async function loadI18n() {
    try {
      const r = await fetch(API.i18n);
      const res = await r.json();
      if (res && res.dict) {
        I18N.lang = res.lang || '';
        I18N.available = Array.isArray(res.available) ? res.available : [];
        I18N.dict = res.dict;
      }
    } catch (e) {}
  }

  // 切换界面语言：写后端（持久化）→ 更新本地字典 → 重渲染当前视图
  async function switchLang(code) {
    if (code === I18N.lang) return;
    try {
      const r = await fetch(API.uiLang, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: code }),
      });
      const res = await r.json();
      if (!res || !res.dict) throw new Error('bad response');
      I18N.lang = res.lang || code;
      I18N.available = Array.isArray(res.available) ? res.available : I18N.available;
      I18N.dict = res.dict;
    } catch (e) {
      flashToast(t('toast.langFailed'), true);
      return false;
    }
    // 先重建骨架（刷新顶栏等挂载期生成的文案），再整体重渲染树与卡片
    rebuildSkeleton();
    renderFull(getActiveRoot());
    flashToast(t('settings.lang.switched'));
    return true;
  }

  // ---------- 屏蔽 Forge 全局界面本地化对本插件的干扰 ----------
  // Forge 的 javascript/localization.js 会在每次 UI 更新时遍历新增节点，把文本与
  // 它自己的界面语言词典做「精确整串匹配」，命中就直接覆盖文本（见其 processTextNode）。
  // WebUI 界面语言为中文时，"Filename"/"Refresh" 等词会被强制改回中文，与本插件的
  // 语言选择打架，出现同一界面中英文混杂。这里包一层 processNode，跳过本插件的节点，
  // 让插件文案完全由自身语言包决定（不改动任何 Forge 文件，仅内存内包装）。
  const LOCALIZE_SKIP_SEL = '.lna-root, .lna-modal-mask, .lna-lightbox, .lna-toast, .lna-dd-menu, .lna-dd-mask';

  function installLocalizationGuard() {
    const orig = window.processNode;
    if (typeof orig !== 'function' || orig.__lna_guard) return false;
    const wrapped = function (node) {
      try {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (el && el.closest && el.closest(LOCALIZE_SKIP_SEL)) return; // 本插件节点：由插件自身语言包决定文案
      } catch (e) { /* 判定失败则按原逻辑处理 */ }
      return orig.apply(this, arguments);
    };
    wrapped.__lna_guard = true;
    window.processNode = wrapped;
    return true;
  }

  // localization.js 可能晚于本脚本加载，故有限次重试直到包装成功
  function ensureLocalizationGuard() {
    if (installLocalizationGuard()) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (installLocalizationGuard() || ++tries > 40) clearInterval(timer);
    }, 250);
  }

  // 脚本加载即尝试安装（此时 Forge 核心脚本通常已就绪）
  ensureLocalizationGuard();

  const SORT_OPTIONS = [
    { value: 'name' },
    { value: 'created' },
    { value: 'modified' },
    { value: 'size' },
    { value: 'usage_count' },
    { value: 'last_viewed' },
  ];

  // 排序项显示名（i18n：sort.<value>）
  function sortLabel(value) {
    return t('sort.' + value);
  }

  // 共享状态（txt2img 和 img2img 两个实例共用）
  const state = {
    tree: null,
    root: '',
    rootCount: 0,            // 根目录直属模型数（树根节点徽标）
    totalCount: 0,           // 所有子文件夹中的模型总数（顶栏统计）
    totalSize: 0,            // 所有子文件夹中的模型总大小(字节)
    currentPath: '',
    folders: [],
    loras: [],
    sortKey: 'name',
    sortDir: 'asc',
    search: '',
    expandedFolders: null,  // Set<string> | null，记录已展开的文件夹 rel，持久化到 localStorage
    searchSubfolders: false, // 开启后搜索包含子文件夹（递归）
    onlyLora: false,         // 开启后搜索只显示 LoRA 模型，不含文件夹卡片
    showFolderCards: true,   // 关闭后卡片列表始终隐藏文件夹卡片
    showAllModels: false,    // 开启后无需搜索词也递归显示当前路径下所有子文件夹的模型
    showPreviews: true,      // 关闭后卡片不引用预览图，隐藏封面层（z-index 2），显示「暂无封面」占位（z-index 1）
    showTagZh: false,        // 卡片设置页：是否在每个训练标签下显示中文翻译
    searchResults: null,     // 递归搜索结果缓存 {folders, loras}，null 表示非递归模式
    cardWidth: 256,          // 卡片宽度(px)
    cardHeight: 385,         // 卡片高度(px)
    lockRatio: false,        // 锁定比例：改宽/高时另一项按比例联动
    sidebarWidth: 220,       // 左侧文件夹树宽度(px)
    bodyHeight: 468,         // 主体区高度(px)：左侧文件夹树与右侧卡片区容器高度
  };

  // 卡片比例预设（宽度不变，按比例算高度）
  const CARD_RATIOS = [
    { label: '1:1',  w: 1,  h: 1 },
    { label: '2:3',  w: 2,  h: 3 },
    { label: '9:16', w: 9,  h: 16 },
    { label: '3:2',  w: 3,  h: 2 },
    { label: '16:9', w: 16, h: 9 },
  ];
  const CARD_SIZE_MIN = 60;    // 卡片宽/高下限(px)，防误输入
  const CARD_SIZE_MAX = 1200;  // 上限
  const SIDEBAR_MIN = 140;     // 文件夹树宽度下限(px)
  const SIDEBAR_MAX = 480;     // 上限
  const BODY_H_MIN = 240;      // 主体区（文件夹树/卡片区）高度下限(px)
  const BODY_H_MAX = 1600;     // 上限

  // 标签翻译：GGUF 模型下载预设与推荐量化（点「下载」时若未手动选择则按此顺序挑）
  const LLM_PRESET_REPO = 'https://hf-mirror.com/mradermacher/Qwen3.5-2B_Abliterated-GGUF/tree/main';
  const LLM_PREFER_QUANT = ['Q4_K_M', 'IQ4_XS', 'Q4_K_S', 'Q5_K_M', 'Q3_K_M'];
  // 空闲自动卸载：分钟数范围与默认值（与后端 IDLE_MIN/MAX/DEFAULT 保持一致）
  const IDLE_MIN = 3;
  const IDLE_MAX = 200;
  const IDLE_DEFAULT = 5;
  // 标签翻译方案（与后端 TRANS_MODES 保持一致）：dict=仅用对照表 / llm=仅用模型 / hybrid=混合
  // 显示名走 i18n（settings.mode.<v>），故此处只保留取值
  const TRANS_MODES = [
    { v: 'dict' },
    { v: 'llm' },
    { v: 'hybrid' },
  ];
  const TRANS_MODE_DEFAULT = 'hybrid';
  // 翻译提示预设：名称长度上限（与后端 PROMPT_NAME_MAX 保持一致）
  const PROMPT_NAME_MAX = 30;

  // 展开状态持久化（跨刷新 / 重启保留，纯本机 UI 态，存 localStorage）
  const EXPANDED_STORAGE_KEY = 'lna_expanded_folders';

  // 插件界面设置持久化：存插件目录下的 data/ui_settings.json（后端读写）。
  // 校验后写入 state，非法值一律忽略，保持默认。
  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    if (typeof s.searchSubfolders === 'boolean') state.searchSubfolders = s.searchSubfolders;
    if (typeof s.onlyLora === 'boolean') state.onlyLora = s.onlyLora;
    if (typeof s.showFolderCards === 'boolean') state.showFolderCards = s.showFolderCards;
    if (typeof s.showAllModels === 'boolean') state.showAllModels = s.showAllModels;
    if (typeof s.showPreviews === 'boolean') state.showPreviews = s.showPreviews;
    if (typeof s.showTagZh === 'boolean') state.showTagZh = s.showTagZh;
    if (typeof s.lockRatio === 'boolean') state.lockRatio = s.lockRatio;
    // 排序方式与升降序：仅接受当前支持的取值，非法值保持默认
    if (SORT_OPTIONS.some((o) => o.value === s.sortKey)) state.sortKey = s.sortKey;
    if (s.sortDir === 'asc' || s.sortDir === 'desc') state.sortDir = s.sortDir;
    if (typeof s.cardWidth === 'number') state.cardWidth = clampCardSize(s.cardWidth);
    if (typeof s.cardHeight === 'number') state.cardHeight = clampCardSize(s.cardHeight);
    if (typeof s.sidebarWidth === 'number') state.sidebarWidth = clampSidebarWidth(s.sidebarWidth);
    if (typeof s.bodyHeight === 'number') state.bodyHeight = clampBodyHeight(s.bodyHeight);
  }

  async function loadSettings() {
    try {
      const r = await fetch(API.uiSettings);
      const res = await r.json();
      applySettings(res && res.settings);
    } catch (e) {}
  }

  // 待提交的控件设置（与后端 UI_SETTINGS_KEYS 白名单一一对应）
  function collectSettings() {
    return {
      searchSubfolders: state.searchSubfolders,
      onlyLora: state.onlyLora,
      showFolderCards: state.showFolderCards,
      showAllModels: state.showAllModels,
      showPreviews: state.showPreviews,
      showTagZh: state.showTagZh,
      lockRatio: state.lockRatio,
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      cardWidth: state.cardWidth,
      cardHeight: state.cardHeight,
      sidebarWidth: state.sidebarWidth,
      bodyHeight: state.bodyHeight,
    };
  }

  // 防抖回写：卡片尺寸输入框会在拖动/连打时高频触发
  let saveSettingsTimer = 0;
  function saveSettings() {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(() => {
      fetch(API.uiSettings, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: collectSettings() }),
      }).catch(() => {});
    }, 300);
  }

  function clampCardSize(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return CARD_SIZE_MIN;
    return Math.min(CARD_SIZE_MAX, Math.max(CARD_SIZE_MIN, n));
  }

  function clampSidebarWidth(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return SIDEBAR_MIN;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
  }

  function clampBodyHeight(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return BODY_H_MIN;
    return Math.min(BODY_H_MAX, Math.max(BODY_H_MIN, n));
  }

  // 把卡片尺寸、文件夹树宽度与主体区高度写到所有插件实例的根元素上（CSS 变量驱动布局）
  function applyLayoutVars() {
    const w = state.cardWidth + 'px';
    const h = state.cardHeight + 'px';
    const sw = state.sidebarWidth + 'px';
    const bh = state.bodyHeight + 'px';
    document.querySelectorAll('.lna-root').forEach((r) => {
      r.style.setProperty('--lna-card-w', w);
      r.style.setProperty('--lna-card-h', h);
      r.style.setProperty('--lna-sidebar-w', sw);
      r.style.setProperty('--lna-body-h', bh);
    });
  }

  // ---------- 图标 ----------
  const ICON = {
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
    // 打开所在路径：文件夹 + 定位放大镜
    reveal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><circle cx="10.5" cy="13" r="2.6"></circle><path d="m12.4 14.9 2.1 2.1"></path></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4.5"></path><path d="M12 16h.01"></path></svg>',
    // 翻译功能按钮图标：地球（翻译所有标签）
    translateAll: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"></circle><ellipse cx="12" cy="12" rx="3.5" ry="8.2"></ellipse><path d="M4.4 9.2h15.2M4.4 14.8h15.2"></path></svg>',
    // 半实半虚进度环（翻译未完成标签）
    incomplete: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4"></path><path d="M12 20.2a8.2 8.2 0 0 1 0-16.4" stroke-dasharray="2.6 3.6"></path></svg>',
    // 循环箭头（选择标签重新翻译）
    retranslate: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5c2.38 0 4.66.95 6.37 2.59L20.5 7.9"></path><path d="M20.5 3.4v4.5h-4.5"></path></svg>',
    // 书本加号（将译文加入词典）
    addDict: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"></path><path d="M12.5 7.5v6M9.5 10.5h6"></path></svg>',
    // 铅笔（人工修正译文）
    editZh: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L7.6 18.4l-4 1 1-4z"></path></svg>',
    // 列表（查看模型所有标签）
    list: '<svg class="lna-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3.6 6h.01M3.6 12h.01M3.6 18h.01"></path></svg>',
    // 网页链接（下载站地址前的小图标）
    link: '<svg class="lna-dl-link-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13.5a4.2 4.2 0 0 0 6 0l2.8-2.8a4.2 4.2 0 0 0-6-6l-1.4 1.4"></path><path d="M14 10.5a4.2 4.2 0 0 0-6 0l-2.8 2.8a4.2 4.2 0 0 0 6 6l1.4-1.4"></path></svg>',
  };

  // ---------- HTML 模板（用 class，不用 id） ----------
  // 注意：必须做成函数而非常量 —— 其中含 t() 取值，需在语言包加载完成后（挂载时）才求值。
  function tabHtml() {
    return `
<div class="lna-root">
  <div class="lna-topbar" role="toolbar" aria-label="${esc(t('toolbar.aria'))}">
    <div class="lna-search-wrap">
      <svg class="lna-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
      <input class="lna-search" type="search" placeholder="${esc(t('search.placeholder'))}" aria-label="${esc(t('search.aria'))}">
      <button class="lna-search-clear" type="button" aria-label="${esc(t('search.clear'))}" title="${esc(t('search.clear'))}" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
      </button>
    </div>
    <div class="pill-group pill-sm lna-sort">
      <span class="group-label" id="{UID}-sort-label">${t('sort.label')}</span>
      <div class="base-dropdown">
        <button class="dd-trigger lna-sort-trigger" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{UID}-sort-label {UID}-sort-value">
          <span class="dd-value lna-sort-value" id="{UID}-sort-value">${t('sort.name')}</span>
          <span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></span>
        </button>
      </div>
      <button class="dir-btn lna-sort-dir" aria-label="${esc(t('sort.dirAria', { dir: t('sort.dirDesc') }))}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="lna-sort-arrow" d="M12 5v14M19 12l-7 7-7-7"></path></svg>
      </button>
    </div>
    <button class="lna-top-btn lna-refresh" aria-label="${esc(t('refresh.aria'))}">
      <svg class="lna-refresh-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      <span class="lna-refresh-label">${t('refresh.label')}</span>
    </button>
    <button class="lna-top-btn lna-settings" aria-label="${esc(t('settings.aria'))}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      <span>${t('settings.aria')}</span>
    </button>
    <button class="lna-top-btn lna-llm-state" type="button" aria-label="${esc(t('llmState.aria'))}" disabled>
      <span class="lna-llm-state-dot" aria-hidden="true"></span>
      <span class="lna-llm-state-text lna-llm-state-off">${t('llmState.off')}</span>
      <span class="lna-llm-state-text lna-llm-state-on">${t('llmState.on')}</span>
      <span class="lna-llm-state-text lna-llm-state-hover">${t('llmState.hover')}</span>
    </button>
    <div class="lna-stats">
      <span class="lna-stat" title="${esc(t('stats.countTitle'))}">
        <span class="lna-stat-label">${t('stats.countLabel')}</span>
        <span class="lna-stat-value lna-stat-count">—</span>
      </span>
      <span class="lna-stat" title="${esc(t('stats.sizeTitle'))}">
        <span class="lna-stat-label">${t('stats.sizeLabel')}</span>
        <span class="lna-stat-value lna-stat-size">—</span>
      </span>
    </div>
  </div>
  <div class="lna-body">
    <aside class="lna-sidebar">
      <div class="lna-side-title" id="{UID}-tree-label">${t('sidebar.title')}</div>
      <div class="lna-tree" role="tree" aria-labelledby="{UID}-tree-label"></div>
    </aside>
    <main class="lna-content">
      <nav class="lna-crumb" aria-label="${esc(t('crumb.aria'))}"></nav>
      <div class="lna-grid" role="list" aria-label="${esc(t('grid.aria'))}"></div>
      <div class="lna-empty" role="status" style="display:none">${t('empty.folder')}</div>
    </main>
  </div>
</div>`;
  }

  let uidCounter = 0;

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  // 预览图 URL：拼上后端返回的版本号（文件 mtime），替换/重新生成预览图后依旧取到新图而非旧缓存
  function previewUrl(rel, ver) {
    const base = `/lora_new_files/${encodeURI(rel)}`;
    return ver ? `${base}?v=${encodeURIComponent(ver)}` : base;
  }
  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  // 顶栏统计的总大小：≥1G 用 G（两位小数），<1G 用 M
  function fmtTotalSize(bytes) {
    const n = Number(bytes) || 0;
    const GB = 1073741824;
    if (n >= GB) return (n / GB).toFixed(2) + ' G';
    return (n / 1048576).toFixed(1) + ' M';
  }

  // 把库级统计写到所有插件实例的顶栏
  function updateStatsUI() {
    document.querySelectorAll('.lna-root').forEach((r) => {
      const cnt = r.querySelector('.lna-stat-count');
      const size = r.querySelector('.lna-stat-size');
      if (cnt) cnt.textContent = String(state.totalCount);
      if (size) size.textContent = fmtTotalSize(state.totalSize);
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 读取已记忆的展开文件夹；返回 null 表示从未记录过（首次使用）
  function loadExpandedFolders() {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (raw === null) return null;
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return null;
    }
  }

  function saveExpandedFolders() {
    if (!state.expandedFolders) return;
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(state.expandedFolders)));
    } catch (e) {}
  }

  function getActiveRoot() {
    const roots = document.querySelectorAll('.lna-root');
    for (const r of roots) {
      if (r.offsetParent !== null) return r;
    }
    return roots[0] || null;
  }

  // ---------- 挂载到 Extra Networks 的「LoRA 管理器」页 ----------
  // 该页是真实的 Gradio Tab（由 Python 侧 ui_extra_networks.register_page 注册），
  // tab 按钮与面板显隐全归 Gradio 的 Tabs/TabItem 组件管理，插件只往它提供的
  // 容器里挂自己的 UI，不再手动改写框架节点（那样会与框架状态冲突）。
  // 容器 elem_id 形如 txt2img_lora_new_cards_html，见 scripts/main.py。
  let mountAttempts = 0;   // 轮询次数，用于给「等待 Python 提供的挂载点」设宽限期
  let mountTimer = null;

  function mountPage(tabname) {
    const host = document.getElementById(tabname + '_lora_new_cards_html');
    if (!host) return false;
    let mount = host.querySelector('.lna-mount');
    if (!mount) {
      // 容器内容由 Gradio 异步注入，先等待；久等不到（例如 HTML 被清洗）才自建兜底，
      // 避免过早自建后又被注入覆盖导致的闪烁
      if (mountAttempts < 5) return false;
      mount = document.createElement('div');
      mount.className = 'lna-mount';
      host.appendChild(mount);
    }
    if (mount.querySelector('.lna-root')) return false; // 已挂载
    mount.innerHTML = tabHtml().replace(/\{UID\}/g, 'lna' + (++uidCounter));
    renderFull(mount.querySelector('.lna-root'));
    return true;
  }

  // Gradio 异步注入页面 HTML，且重新渲染时会替换容器内容，
  // 故用轻量轮询持续补齐；已挂载时立即返回，开销可忽略。
  function ensureMounted() {
    mountAttempts += 1;
    let mounted = false;
    ['txt2img', 'img2img'].forEach((t) => { if (mountPage(t)) mounted = true; });
    if (!mounted) return;
    applyLayoutVars();
    updateStatsUI();
    refreshLlmState();
  }

  function startMountWatch() {
    if (mountTimer) return;
    mountTimer = setInterval(ensureMounted, 700);
  }

  // 整体重建已挂载的骨架：顶栏、搜索框、排序、按钮等文案由 tabHtml() 在挂载时求值，
  // 语言切换后必须重建这些节点才能刷新（仅 renderFull 只更新树与卡片区）。
  function rebuildSkeleton() {
    document.querySelectorAll('.lna-mount').forEach((m) => {
      if (m.querySelector('.lna-root')) m.innerHTML = ''; // 清空后由 mountPage 重新生成
    });
    ensureMounted();
  }

  // ---------- 数据加载 ----------
  async function loadTree() {
    const r = await fetch(API.tree);
    const data = await r.json();
    state.tree = data.children || [];
    state.root = data.root;
    state.rootCount = Number(data.count) || 0;
    state.totalCount = Number(data.total_count) || 0;
    state.totalSize = Number(data.total_size) || 0;
    updateStatsUI();
  }

  async function loadDir(rel) {
    state.currentPath = rel;
    const r = await fetch(`${API.list}?path=${encodeURIComponent(rel)}`);
    const data = await r.json();
    state.folders = data.folders || [];
    state.loras = data.loras || [];
    applySearch();
    syncTreeActive();
  }

  // 根据搜索词与开关决定渲染数据源
  function applySearch() {
    const q = state.search.trim();
    // 递归模式：开了「显示文件夹下所有模型」，或有关键词且开了「搜索子文件夹」
    // 关键词为空时后端返回整棵子树（不做名称过滤）
    if (state.showAllModels || (q && state.searchSubfolders)) {
      runRecursiveSearch(q);
    } else {
      state.searchResults = null;
      renderAll();
    }
  }

  // 递归搜索（含子文件夹），带请求序号防竞态
  let searchSeq = 0;
  async function runRecursiveSearch(q) {
    const seq = ++searchSeq;
    try {
      const r = await fetch(`${API.search}?path=${encodeURIComponent(state.currentPath)}&q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (seq !== searchSeq) return; // 已有更新的请求，丢弃本次结果
      state.searchResults = { folders: data.folders || [], loras: data.loras || [] };
    } catch (e) {
      if (seq !== searchSeq) return;
      state.searchResults = { folders: [], loras: [] };
      flashToast(t('toast.recursiveFailed'));
    }
    renderAll();
  }

  // 仅刷新内容区（不重建树，避免键盘焦点丢失）
  function renderAll(scope) {
    const root = scope || getActiveRoot();
    if (!root) return;
    renderGrid(root);
    bindTopbar(root);
    bindSortPill(root);
  }

  // 完整刷新（初始化 / 重新扫描时调用，会重建树）
  function renderFull(root) {
    if (!root) return;
    renderTree(root);
    renderAll(root);
  }

  // ---------- 文件夹树 ----------
  function renderTree(root) {
    const box = root.querySelector('.lna-tree');
    if (!box) return;
    box.innerHTML = '';
    // 展开状态由 makeTreeNode 依据 state.expandedFolders 恢复
    const rootNode = makeTreeNode({ name: t('tree.root'), rel: '', children: state.tree, count: state.rootCount, total: state.totalCount }, 0, true);
    box.appendChild(rootNode);
    syncTreeActive();
  }

  function syncTreeActive() {
    document.querySelectorAll('.lna-tree-node').forEach((n) => {
      if (n.dataset.rel === state.currentPath) n.setAttribute('aria-current', 'true');
      else n.removeAttribute('aria-current');
    });
  }

  function makeTreeNode(node, depth, isRoot) {
    const wrap = document.createElement('div');
    const hasChildren = node.children && node.children.length > 0;

    // 根节点默认展开；其余节点按记忆恢复
    const remembered = state.expandedFolders;
    const isExpanded = hasChildren && (isRoot || !!(remembered && remembered.has(node.rel)));
    // 徽标口径跟随「显示文件夹下所有模型」：开启时显示含子文件夹的总数（与卡片区
    // 递归展示的模型数对等），关闭时显示直属数量
    const recursive = !!state.showAllModels;
    const count = recursive ? (Number(node.total ?? node.count) || 0) : (Number(node.count) || 0); // 后端未重启时无 total 字段，回退直属数量
    const countTitle = recursive ? t('tree.countTotalTitle') : t('tree.countDirectTitle');
    const countAria = recursive
      ? t('tree.countAriaTotal', { n: count })
      : (hasChildren ? t('tree.countAriaDirectSub', { n: count }) : t('tree.countAriaDirect', { n: count }));

    const row = document.createElement('div');
    row.className = 'lna-tree-node' + (isExpanded ? ' expanded' : '');
    row.style.paddingLeft = (10 + depth * 14) + 'px';
    row.dataset.rel = node.rel || '';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-label', t('tree.nodeAria', { name: node.name, desc: countAria }));
    row.innerHTML = `
      <span class="twisty ${hasChildren ? '' : 'twisty-empty'}" aria-hidden="true">${ICON.chevron}</span>
      ${ICON.folder}
      <span class="lna-tree-body">
        <span class="lna-tree-label">${esc(node.name)}</span><span class="lna-tree-count" title="${countTitle}">${count}</span>
      </span>
    `;

    let childBox = null;
    if (hasChildren) {
      childBox = document.createElement('div');
      childBox.className = 'lna-tree-children';
      childBox.setAttribute('role', 'group');
      childBox.style.display = isExpanded ? 'block' : 'none';
      node.children.forEach((c) => childBox.appendChild(makeTreeNode(c, depth + 1)));
    }

    function select() {
      document.querySelectorAll('.lna-tree-node[aria-current="true"]').forEach((n) => n.removeAttribute('aria-current'));
      row.setAttribute('aria-current', 'true');
      loadDir(node.rel || '');
    }

    function toggle() {
      if (!hasChildren) return;
      setExpanded(!row.classList.contains('expanded'));
    }

    function setExpanded(expanded) {
      row.classList.toggle('expanded', expanded);
      row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      childBox.style.display = expanded ? 'block' : 'none';
      if (isRoot) return; // 根节点始终默认展开，不纳入记忆
      if (!state.expandedFolders) state.expandedFolders = loadExpandedFolders() || new Set();
      if (expanded) state.expandedFolders.add(node.rel);
      else state.expandedFolders.delete(node.rel);
      saveExpandedFolders();
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.twisty') && hasChildren) { toggle(); return; }
      if (hasChildren && !row.classList.contains('expanded')) toggle();
      select();
    });

    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (hasChildren && !row.classList.contains('expanded')) toggle();
        select();
      } else if (e.key === 'ArrowRight' && hasChildren && !row.classList.contains('expanded')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' && hasChildren && row.classList.contains('expanded')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusSiblingNode(row, e.key === 'ArrowDown' ? 1 : -1);
      }
    });

    wrap.appendChild(row);
    if (childBox) wrap.appendChild(childBox);
    return wrap;
  }

  function focusSiblingNode(row, dir) {
    const all = Array.from(document.querySelectorAll('.lna-tree-node'))
      .filter((n) => n.offsetParent !== null);
    const i = all.indexOf(row);
    const next = all[i + dir];
    if (next) next.focus();
  }

  // ---------- 卡片网格 ----------
  function renderGrid(root) {
    const grid = root.querySelector('.lna-grid');
    const empty = root.querySelector('.lna-empty');
    const crumb = root.querySelector('.lna-crumb');
    if (!grid) return;
    grid.innerHTML = '';

    if (crumb) renderCrumb(crumb);

    const q = state.search.trim().toLowerCase();
    // searchResults 仅在递归模式下非空，可直接作为判据
    const recursive = !!state.searchResults;
    let folders = [];
    let loras = [];
    if (recursive) {
      // 递归模式：结果来自后端对整棵子树（含子文件夹）的搜索
      folders = state.searchResults.folders.slice();
      loras = state.searchResults.loras.slice();
    } else {
      folders = state.folders.slice();
      loras = state.loras.slice();
      if (q) {
        folders = folders.filter((f) => f.name.toLowerCase().includes(q));
        loras = loras.filter((l) => l.name.toLowerCase().includes(q));
      }
    }
    // 「只搜索 LoRA 模型」：搜索时隐藏文件夹卡片
    if (q && state.onlyLora) folders = [];
    // 「文件夹卡片显示」关闭：始终隐藏文件夹卡片
    if (!state.showFolderCards) folders = [];

    const dir = state.sortDir === 'asc' ? 1 : -1;
    if (state.sortKey === 'name') {
      folders.sort((a, b) => a.name.localeCompare(b.name) * dir);
      loras.sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else {
      folders.sort((a, b) => a.name.localeCompare(b.name));
      loras.sort((a, b) => ((a[state.sortKey] || 0) - (b[state.sortKey] || 0)) * dir);
    }

    if (folders.length === 0 && loras.length === 0) {
      empty.style.display = 'block';
      if (q) empty.textContent = t('empty.noMatch');
      // 隐藏了文件夹卡片且当前目录确实有子文件夹时，不要误报「为空」
      else if (!state.showFolderCards && state.folders.length > 0) empty.textContent = t('empty.folderCardsHidden');
      else empty.textContent = t('empty.folder');
      grid.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    grid.style.display = 'grid';

    folders.forEach((f) => grid.appendChild(makeFolderCard(f)));
    loras.forEach((l) => grid.appendChild(makeLoraCard(l)));
  }

  function renderCrumb(crumb) {
    crumb.innerHTML = '';
    const parts = state.currentPath ? state.currentPath.split('/') : [];
    const mk = (label, rel, isLast) => {
      if (isLast) {
        const span = document.createElement('span');
        span.className = 'crumb-current';
        span.setAttribute('aria-current', 'location');
        span.textContent = label;
        return span;
      }
      const b = document.createElement('button');
      b.className = 'crumb-link';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        loadDir(rel);
        syncTreeActive();
      });
      return b;
    };
    crumb.appendChild(mk('Lora', '', parts.length === 0));
    let acc = '';
    parts.forEach((p, i) => {
      acc = acc ? acc + '/' + p : p;
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      crumb.appendChild(sep);
      crumb.appendChild(mk(p, acc, i === parts.length - 1));
    });
  }

  function makeFolderCard(f) {
    const el = document.createElement('div');
    el.className = 'lna-card folder';
    el.setAttribute('role', 'listitem');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', t('folder.cardAria', { name: f.name }));
    // 与 LoRA 卡一致：受「卡片图像预览」开关控制，关闭时隐藏封面层露出占位层
    const coverBg = state.showPreviews && f.preview ? `background-image:url('${previewUrl(f.preview, f.preview_ver)}')` : '';
    const coverStyle = coverBg + (state.showPreviews ? '' : 'display:none;');
    el.innerHTML = `
      <div class="lna-layer-base" aria-hidden="true">
        <div class="base-tag">${t('folder.baseTag')}</div>
        <div class="base-hint">${t('card.noCover')}</div>
      </div>
      <div class="lna-layer-cover" style="${coverStyle}"></div>
      <div class="lna-layer-title">${esc(f.name)}</div>
      <div class="lna-card-actions">
        <button class="lna-icon-btn lna-copy" type="button" aria-label="${esc(t('folder.copyPathAria', { name: f.name }))}" title="${esc(t('card.copyPathTitle'))}">${ICON.copy}</button>
        <button class="lna-icon-btn lna-cfg" type="button" aria-label="${esc(t('folder.detailAria', { name: f.name }))}" title="${esc(t('card.cfgTitle'))}">${ICON.gear}<span>${t('card.cfgLabel')}</span></button>
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.lna-icon-btn')) return;
      openFolder(f);
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) {
        e.preventDefault();
        openFolder(f);
      }
    });
    el.querySelector('.lna-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyText((state.root || '') + '\\' + f.rel);
    });
    el.querySelector('.lna-cfg').addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderCardSettings(f);
    });
    return el;
  }

  function openFolder(f) {
    loadDir(f.rel);
    syncTreeActive();
  }

  function makeLoraCard(l) {
    const el = document.createElement('div');
    el.className = 'lna-card lora';
    el.setAttribute('role', 'listitem');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', t('card.loraAria', { name: l.name, size: fmtSize(l.size), count: l.usage_count }));
    // 关闭「卡片图像预览」时不引用预览图，并隐藏封面层（z-index 2），露出「暂无封面」占位层（z-index 1）
    const coverBg = state.showPreviews && l.preview ? `background-image:url('${previewUrl(l.preview, l.preview_ver)}')` : '';
    const coverStyle = coverBg + (state.showPreviews ? '' : 'display:none;');
    // 卡片描述层：仅在有描述时渲染，悬停时从底部升起展示（见 style.css .lna-layer-desc）
    // 外层 .lna-layer-desc 负责高度升起（block + overflow），内层负责文字多行截断（-webkit-box）
    const descHtml = (l.description || '').trim()
      ? `<div class="lna-layer-desc" aria-hidden="true"><span class="lna-layer-desc-text">${esc(l.description)}</span></div>`
      : '';
    el.innerHTML = `
      <div class="lna-layer-base" aria-hidden="true">
        <div class="base-tag">LORA</div>
        <div class="base-hint">${t('card.noCover')}</div>
      </div>
      <div class="lna-layer-cover" style="${coverStyle}" role="img" aria-label="${esc(t('card.coverAria', { name: l.name }))}"></div>
      ${descHtml}
      <div class="lna-layer-title" title="${esc(l.name)}">${esc(l.name)}</div>
      <div class="lna-card-actions">
        <button class="lna-icon-btn lna-copy" type="button" aria-label="${esc(t('card.copyLoraAria', { name: l.name }))}" title="${esc(t('card.copyPathTitle'))}">${ICON.copy}</button>
        <button class="lna-icon-btn lna-reveal" type="button" aria-label="${esc(t('card.revealAria', { name: l.name }))}" title="${esc(t('card.revealTitle'))}">${ICON.reveal}</button>
        <button class="lna-icon-btn lna-meta" type="button" aria-label="${esc(t('card.metaAria', { name: l.name }))}" title="${esc(t('card.metaTitle'))}">${ICON.info}</button>
        <button class="lna-icon-btn lna-cfg" type="button" aria-label="${esc(t('card.detailAria', { name: l.name }))}" title="${esc(t('card.cfgTitle'))}">${ICON.gear}<span>${t('card.cfgLabel')}</span></button>
      </div>
      <button class="lna-del-btn" type="button" aria-label="${esc(t('card.delPromptAria', { name: l.name }))}">${t('card.delPromptLabel')}</button>
      <button class="lna-use-btn" type="button" aria-label="${esc(t('card.useAria', { name: l.name }))}">${t('card.useLabel')}</button>
    `;
    el.querySelector('.lna-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyText((state.root || '') + '\\' + l.rel);
    });
    el.querySelector('.lna-reveal').addEventListener('click', (e) => {
      e.stopPropagation();
      revealLora(l);
    });
    el.querySelector('.lna-cfg').addEventListener('click', (e) => {
      e.stopPropagation();
      openLoraCardSettings(l);
    });
    el.querySelector('.lna-meta').addEventListener('click', (e) => {
      e.stopPropagation();
      openLoraMetadata(l);
    });
    el.querySelector('.lna-use-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      useLora(l);
    });
    el.querySelector('.lna-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeLoraPrompt(l);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.target.closest('button')) {
        e.preventDefault();
        openLoraCardSettings(l);
      }
    });
    return el;
  }

  // 在资源管理器中打开模型所在文件夹，并自动选中该模型文件
  async function revealLora(l) {
    try {
      const r = await fetch(API.reveal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: l.rel }),
      });
      const res = await r.json();
      if (!res || !res.ok) flashToast(t('toast.openFailed', { msg: (res && res.error) || t('toast.unknownError') }));
    } catch (e) {
      flashToast(t('toast.openFailedReq'));
    }
  }

  // ---------- 顶部栏事件 ----------
  // 清除按钮仅在输入框有内容时显示
  function updateSearchClear(root) {
    const input = root.querySelector('.lna-search');
    const btn = root.querySelector('.lna-search-clear');
    if (input && btn) btn.hidden = input.value.length === 0;
  }

  function bindTopbar(root) {
    const search = root.querySelector('.lna-search');
    if (search && !search.__lna_bound) {
      search.__lna_bound = true;
      let timer = null;
      search.addEventListener('input', (e) => {
        updateSearchClear(root); // 即时反馈，不走防抖
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.search = e.target.value;
          applySearch();
        }, 120);
      });
      updateSearchClear(root);
    }
    const clearBtn = root.querySelector('.lna-search-clear');
    if (clearBtn && !clearBtn.__lna_bound) {
      clearBtn.__lna_bound = true;
      clearBtn.addEventListener('click', () => {
        if (!search) return;
        search.value = '';
        updateSearchClear(root);
        state.search = '';
        applySearch();
        search.focus();
      });
    }
    const refresh = root.querySelector('.lna-refresh');
    if (refresh && !refresh.__lna_bound) {
      refresh.__lna_bound = true;
      refresh.addEventListener('click', async () => {
        if (refresh.__lna_busy) return; // 防重复点击
        refresh.__lna_busy = true;
        const icon = refresh.querySelector('.lna-refresh-icon');
        const label = refresh.querySelector('.lna-refresh-label');
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const MIN_DUR = 800; // 与参考样式一致：图标旋转一圈时长
        const t0 = performance.now();

        // 图标旋转 360° + 品牌色辉光脉冲
        if (!reduced && icon && icon.animate) {
          icon.animate(
            [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
            { duration: MIN_DUR, easing: 'ease-in-out' }
          );
          refresh.animate(
            [
              { boxShadow: 'none' },
              { boxShadow: '0 0 14px 3px rgba(249, 115, 22, .55)', offset: 0.05 },
              { boxShadow: '0 0 14px 3px rgba(249, 115, 22, .55)', offset: 0.5 },
              { boxShadow: 'none' },
            ],
            { duration: MIN_DUR, easing: 'ease-out' }
          );
        }
        if (label) {
          label.textContent = t('refresh.busy');
          label.classList.add('busy');
        }
        refresh.setAttribute('aria-busy', 'true');

        try {
          await loadTree();
          await loadDir(state.currentPath);
          renderFull(getActiveRoot());
          flashToast(t('refresh.done'));
        } finally {
          // 至少播完一圈动画再恢复文字（减弱动效时不等待）
          const wait = reduced ? 0 : Math.max(0, MIN_DUR - (performance.now() - t0));
          await new Promise((r) => setTimeout(r, wait));
          if (label) {
            label.classList.remove('busy'); // max-width 平滑收缩
            setTimeout(() => {
              if (!refresh.__lna_busy) label.textContent = t('refresh.label'); // 期间若再次点击则不覆盖
            }, 250);
          }
          refresh.removeAttribute('aria-busy');
          refresh.__lna_busy = false;
        }
      });
    }
    const settings = root.querySelector('.lna-settings');
    if (settings && !settings.__lna_bound) {
      settings.__lna_bound = true;
      settings.addEventListener('click', () => {
        openModal({
          title: t('settings.title'),
          locked: true, // 仅可通过「关闭」按钮或 Esc 关闭（点击遮罩不关闭，防止误触）
          bodyHtml: `<div class="lna-set-group">
              <div class="lna-set-group-title">${t('settings.group.display')}</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.lang.name')}</span>
                  <span class="lna-switch-desc">${t('settings.lang.desc')}</span>
                </span>
                <div class="lna-inline-group">
                  <select class="lna-lang-select" aria-label="${t('settings.lang.aria')}">
                    ${I18N.available.map((c) => `<option value="${c}"${c === I18N.lang ? ' selected' : ''}>${esc(langName(c))}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.sidebar.name')}</span>
                  <span class="lna-switch-desc">${t('settings.sidebar.desc', { min: SIDEBAR_MIN, max: SIDEBAR_MAX })}</span>
                </span>
                <div class="lna-inline-group">
                  <input type="number" class="lna-size-input lna-sidebar-input" min="${SIDEBAR_MIN}" max="${SIDEBAR_MAX}" step="1" value="${state.sidebarWidth}" aria-label="${t('settings.sidebar.aria')}">
                  <button class="dlg-btn primary lna-sidebar-save" type="button">${t('settings.save')}</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.bodyH.name')}</span>
                  <span class="lna-switch-desc">${t('settings.bodyH.desc', { min: BODY_H_MIN, max: BODY_H_MAX })}</span>
                </span>
                <div class="lna-inline-group">
                  <input type="number" class="lna-size-input lna-body-input" min="${BODY_H_MIN}" max="${BODY_H_MAX}" step="1" value="${state.bodyHeight}" aria-label="${t('settings.bodyH.aria')}">
                  <button class="dlg-btn primary lna-body-save" type="button">${t('settings.save')}</button>
                </div>
              </div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.folderCards.name')}</span>
                  <span class="lna-switch-desc">${t('settings.folderCards.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showFolderCards" ${state.showFolderCards ? 'checked' : ''} aria-label="${t('settings.folderCards.name')}">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.previews.name')}</span>
                  <span class="lna-switch-desc">${t('settings.previews.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showPreviews" ${state.showPreviews ? 'checked' : ''} aria-label="${t('settings.previews.name')}">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.allModels.name')}</span>
                  <span class="lna-switch-desc">${t('settings.allModels.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showAllModels" ${state.showAllModels ? 'checked' : ''} aria-label="${t('settings.allModels.name')}">
              </label>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">${t('settings.group.search')}</div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.searchSub.name')}</span>
                  <span class="lna-switch-desc">${t('settings.searchSub.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="searchSubfolders" ${state.searchSubfolders ? 'checked' : ''} aria-label="${t('settings.searchSub.name')}">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.onlyLora.name')}</span>
                  <span class="lna-switch-desc">${t('settings.onlyLora.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="onlyLora" ${state.onlyLora ? 'checked' : ''} aria-label="${t('settings.onlyLora.name')}">
              </label>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">${t('settings.group.cardStyle')}</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.ratio.name')}</span>
                  <span class="lna-switch-desc">${t('settings.ratio.desc')}</span>
                </span>
                <div class="lna-ratio-group" role="group" aria-label="${t('settings.ratio.aria')}">
                  ${CARD_RATIOS.map((r) => `<button class="lna-ratio-btn" type="button" data-ratio="${r.label}" aria-pressed="false">${r.label}</button>`).join('')}
                </div>
              </div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.lockRatio.name')}</span>
                  <span class="lna-switch-desc">${t('settings.lockRatio.desc')}</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="lockRatio" ${state.lockRatio ? 'checked' : ''} aria-label="${t('settings.lockRatio.name')}">
              </label>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.cardSize.name')}</span>
                  <span class="lna-switch-desc">${t('settings.cardSize.desc', { min: CARD_SIZE_MIN, max: CARD_SIZE_MAX })}</span>
                </span>
                <div class="lna-size-group">
                  <label class="lna-size-field">${t('settings.width')}
                    <input type="number" class="lna-size-input" data-size="w" min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="1" value="${state.cardWidth}" aria-label="${t('settings.widthAria')}">
                  </label>
                  <label class="lna-size-field">${t('settings.height')}
                    <input type="number" class="lna-size-input" data-size="h" min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="1" value="${state.cardHeight}" aria-label="${t('settings.heightAria')}">
                  </label>
                </div>
              </div>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">${t('settings.group.translate')}</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.mode.name')}</span>
                  <span class="lna-switch-desc">${t('settings.mode.desc')}</span>
                </span>
                ${modeGroupHtml()}
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.llm.name')}</span>
                  <span class="lna-switch-desc">${t('settings.llm.desc')}</span>
                </span>
                <div class="lna-inline-group">
                  <button class="dlg-btn lna-llm-open-folder" type="button" title="${t('settings.llm.openFolderTitle')}">${t('settings.llm.openFolder')}</button>
                  <select class="lna-llm-select" aria-label="${t('settings.llm.selectAria')}">
                    <option value="">${t('settings.llm.none')}</option>
                  </select>
                  <button class="dlg-btn lna-llm-refresh" type="button" title="${t('settings.llm.refreshTitle')}">${t('settings.llm.refresh')}</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.device.name')}</span>
                  <span class="lna-switch-desc">${t('settings.device.desc')}</span>
                </span>
                <div class="lna-zh-switch lna-device-switch" role="group" aria-label="${t('settings.device.aria')}">
                  <button class="lna-zh-key active" type="button" data-dev="cpu" aria-pressed="true">CPU</button>
                  <button class="lna-zh-key" type="button" data-dev="gpu" aria-pressed="false">GPU</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.runtime.name')}</span>
                  <span class="lna-switch-desc">${t('settings.runtime.desc')}</span>
                </span>
                <div class="lna-llm-dl">
                  <div class="lna-llm-dl-row">
                    <span class="lna-runtime-state" role="status" aria-live="polite">${t('settings.runtime.reading')}</span>
                  </div>
                  <div class="lna-llm-dl-row">
                    <button class="dlg-btn dlg-action lna-runtime-install" type="button">${t('settings.runtime.install')}</button>
                  </div>
                  <div class="lna-llm-progress lna-runtime-progress" role="status" aria-live="polite" hidden></div>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.idle.name')}</span>
                  <span class="lna-switch-desc">${t('settings.idle.desc', { min: IDLE_MIN, max: IDLE_MAX })}</span>
                </span>
                <div class="lna-inline-group">
                  <div class="lna-zh-switch lna-idle-switch" role="group" aria-label="${t('settings.idle.aria')}">
                    <button class="lna-zh-key" type="button" data-idle="0" aria-pressed="false">${t('settings.idle.never')}</button>
                    <button class="lna-zh-key active" type="button" data-idle="1" aria-pressed="true">${t('settings.idle.timed')}</button>
                  </div>
                  <label class="lna-size-field">${t('settings.idle.label')}
                    <input type="number" class="lna-size-input lna-idle-minutes" min="${IDLE_MIN}" max="${IDLE_MAX}" step="1" value="${IDLE_DEFAULT}" aria-label="${t('settings.idle.minutesAria')}">
                  </label>
                  <span class="lna-idle-unit">${t('settings.idle.unit')}</span>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.download.name')}</span>
                  <span class="lna-switch-desc">${t('settings.download.desc')}
                    <span class="lna-dl-links"><a href="https://huggingface.co/models" target="_blank" rel="noopener noreferrer">${ICON.link}https://huggingface.co/models</a><a href="https://hf-mirror.com/models" target="_blank" rel="noopener noreferrer">${ICON.link}https://hf-mirror.com/models</a></span>
                  </span>
                </span>
                <div class="lna-llm-dl">
                  <div class="lna-llm-dl-row">
                    <input type="text" class="lna-cf-input lna-llm-repo" value="${LLM_PRESET_REPO}" aria-label="${t('settings.download.repoAria')}" spellcheck="false">
                    <button class="dlg-btn dlg-action lna-llm-detect" type="button" title="${t('settings.download.detectTitle')}">${t('settings.download.detect')}</button>
                  </div>
                  <div class="lna-llm-dl-row">
                    <select class="lna-llm-file" aria-label="${t('settings.download.fileAria')}">
                      <option value="">${t('settings.download.placeholder')}</option>
                    </select>
                    <button class="dlg-btn primary lna-llm-download" type="button" title="${t('settings.download.downloadTitle')}">${t('settings.download.download')}</button>
                  </div>
                  <div class="lna-llm-progress" role="status" aria-live="polite" hidden></div>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.prompt.name')}</span>
                  <span class="lna-switch-desc">${t('settings.prompt.desc')}</span>
                </span>
                <div class="lna-inline-group">
                  <select class="lna-prompt-select" aria-label="${t('settings.prompt.selectAria')}"></select>
                  <button class="dlg-btn lna-prompt-delete" type="button" title="${t('settings.prompt.deleteTitle')}">${t('settings.prompt.delete')}</button>
                </div>
              </div>
              <div class="lna-switch-row lna-no-sep">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">${t('settings.promptName.name')}</span>
                  <span class="lna-switch-desc">${t('settings.promptName.desc', { max: PROMPT_NAME_MAX })}</span>
                </span>
                <div class="lna-inline-group">
                  <input type="text" class="lna-cf-input lna-prompt-name" maxlength="${PROMPT_NAME_MAX}" placeholder="${t('settings.promptName.placeholder')}" aria-label="${t('settings.promptName.aria')}" spellcheck="false">
                  <button class="dlg-btn primary lna-prompt-save" type="button" title="${t('settings.promptName.saveTitle')}">${t('settings.promptName.save')}</button>
                </div>
              </div>
              <div class="lna-prompt-editor">
                <div class="lna-prompt-editor-head">
                  <span class="lna-switch-name">${t('settings.promptText.name')}</span>
                  <span class="lna-switch-desc">${t('settings.promptText.desc')}</span>
                </div>
                <textarea class="lna-cf-input lna-prompt-text" rows="7" spellcheck="false" aria-label="${t('settings.promptText.aria')}"></textarea>
                <div class="lna-prompt-msg" role="status" aria-live="polite" hidden></div>
              </div>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">${t('settings.group.oldData')}</div>
              <div class="lna-switch-row lna-no-sep">
                <span class="lna-switch-text">
                  <span class="lna-switch-desc">${t('settings.oldData.desc')}</span>
                </span>
                <button class="dlg-btn primary lna-match-run" type="button">${t('settings.oldData.run')}</button>
              </div>
              <div class="lna-match-progress lna-llm-progress" role="status" aria-live="polite" hidden></div>
              <div class="lna-match-result" hidden>
                <div class="lna-match-result-title">${t('settings.oldData.unmatchedTitle')}<span class="lna-match-result-count"></span></div>
                <div class="lna-match-result-desc">${t('settings.oldData.unmatchedDesc')}</div>
                <ul class="lna-match-unmatched" aria-label="${t('settings.oldData.unmatchedAria')}"></ul>
              </div>
              <div class="lna-switch-row lna-sep-top">
                <span class="lna-switch-text">
                  <span class="lna-switch-desc">${t('settings.sync.desc')}</span>
                </span>
                <button class="dlg-btn primary lna-sync-run" type="button">${t('settings.sync.run')}</button>
              </div>
              <div class="lna-sync-progress lna-llm-progress" role="status" aria-live="polite" hidden></div>
              <div class="lna-sync-conflicts" hidden>
                <div class="lna-sync-conflicts-title">${t('settings.sync.conflictsTitle')}<span class="lna-sync-conflicts-count"></span></div>
                <div class="lna-sync-conflicts-desc">${t('settings.sync.conflictsDesc')}</div>
                <ul class="lna-sync-list" aria-label="${t('settings.sync.conflictsAria')}"></ul>
              </div>
            </div>`,
          footerHtml: `<button class="dlg-btn dlg-cancel" data-act="close" type="button">${t('settings.close')}</button>`,
          onOpen(modal) {
            modal.querySelector('[data-act="close"]').addEventListener('click', () => closeModal(modal));

            // 界面语言下拉：切换后关闭并重开设置弹窗，让弹窗内文案同步刷新
            const langSel = modal.querySelector('.lna-lang-select');
            if (langSel) {
              langSel.addEventListener('change', async () => {
                const ok = await switchLang(langSel.value);
                if (!ok) return;
                closeModal(modal);
                const rootNow = getActiveRoot();
                const btn = rootNow && rootNow.querySelector('.lna-settings');
                if (btn) btn.click();
              });
            }

            const wInp = modal.querySelector('.lna-size-input[data-size="w"]');
            const hInp = modal.querySelector('.lna-size-input[data-size="h"]');

            function syncInputs() {
              if (wInp) wInp.value = state.cardWidth;
              if (hInp) hInp.value = state.cardHeight;
            }

            // 高亮与当前宽高比一致的预设按钮
            function updateRatioActive() {
              const cur = state.cardWidth > 0 ? state.cardHeight / state.cardWidth : 0;
              modal.querySelectorAll('.lna-ratio-btn').forEach((b) => {
                const parts = b.dataset.ratio.split(':').map(Number);
                const on = parts[0] > 0 && Math.abs(cur - parts[1] / parts[0]) < 0.005;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
              });
            }

            function commit() {
              saveSettings();
              applyLayoutVars();
              syncInputs();
              updateRatioActive();
            }

            // 改宽或改高：锁定比例时联动另一项
            function onSizeInput(which) {
              const inp = which === 'w' ? wInp : hInp;
              if (!inp) return;
              const raw = parseFloat(inp.value);
              if (!isFinite(raw)) return; // 清空或非法输入时不处理，等 change 归一化
              const v = clampCardSize(raw);
              if (which === 'w') {
                const ratio = state.cardWidth > 0 ? state.cardHeight / state.cardWidth : 1;
                state.cardWidth = v;
                if (state.lockRatio) state.cardHeight = clampCardSize(v * ratio);
              } else {
                const ratio = state.cardHeight > 0 ? state.cardWidth / state.cardHeight : 1;
                state.cardHeight = v;
                if (state.lockRatio) state.cardWidth = clampCardSize(v * ratio);
              }
              saveSettings();
              applyLayoutVars();
              // 不回写正在编辑的输入框，避免打断输入
              if (which === 'w' && hInp) hInp.value = state.cardHeight;
              if (which === 'h' && wInp) wInp.value = state.cardWidth;
              updateRatioActive();
            }

            if (wInp) {
              wInp.addEventListener('input', () => onSizeInput('w'));
              wInp.addEventListener('change', () => { wInp.value = state.cardWidth; });
            }
            if (hInp) {
              hInp.addEventListener('input', () => onSizeInput('h'));
              hInp.addEventListener('change', () => { hInp.value = state.cardHeight; });
            }

            // 树状文件夹菜单宽度：输入后点「保存」才生效
            const sbInp = modal.querySelector('.lna-sidebar-input');
            const sbSave = modal.querySelector('.lna-sidebar-save');
            function saveSidebarWidth() {
              const raw = parseFloat(sbInp ? sbInp.value : NaN);
              if (!isFinite(raw)) {
                if (sbInp) sbInp.value = state.sidebarWidth; // 输入非法则还原
                flashToast(t('toast.invalidWidth'));
                return;
              }
              state.sidebarWidth = clampSidebarWidth(raw);
              saveSettings();
              applyLayoutVars();
              if (sbInp) sbInp.value = state.sidebarWidth;
              flashToast(t('toast.savedSidebar', { v: state.sidebarWidth }));
            }
            if (sbSave) sbSave.addEventListener('click', saveSidebarWidth);
            if (sbInp) {
              sbInp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveSidebarWidth(); }
              });
            }

            // 内容区高度：输入后点「保存」才生效
            const bhInp = modal.querySelector('.lna-body-input');
            const bhSave = modal.querySelector('.lna-body-save');
            function saveBodyHeight() {
              const raw = parseFloat(bhInp ? bhInp.value : NaN);
              if (!isFinite(raw)) {
                if (bhInp) bhInp.value = state.bodyHeight; // 输入非法则还原
                flashToast(t('toast.invalidHeight'));
                return;
              }
              state.bodyHeight = clampBodyHeight(raw);
              saveSettings();
              applyLayoutVars();
              if (bhInp) bhInp.value = state.bodyHeight;
              flashToast(t('toast.savedBodyH', { v: state.bodyHeight }));
            }
            if (bhSave) bhSave.addEventListener('click', saveBodyHeight);
            if (bhInp) {
              bhInp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveBodyHeight(); }
              });
            }

            // 比例预设：宽度不变，高度按比例算
            modal.querySelectorAll('.lna-ratio-btn').forEach((b) => {
              b.addEventListener('click', () => {
                const parts = b.dataset.ratio.split(':').map(Number);
                if (!parts[0]) return;
                state.cardHeight = clampCardSize(state.cardWidth * parts[1] / parts[0]);
                commit();
                flashToast(t('toast.appliedRatio', { ratio: b.dataset.ratio }));
              });
            });

            modal.querySelectorAll('.lna-switch[data-set]').forEach((sw) => {
              sw.addEventListener('change', () => {
                const key = sw.dataset.set;
                state[key] = sw.checked;
                saveSettings();
                if (key === 'searchSubfolders') {
                  applySearch();
                } else if (key === 'onlyLora') {
                  // 只影响展示：有递归结果时直接重渲染，无需重新请求
                  if (state.searchResults) renderAll();
                  else applySearch();
                } else if (key === 'showFolderCards') {
                  renderAll();
                } else if (key === 'showPreviews') {
                  // 仅影响卡片封面渲染，直接重渲染即可
                  renderAll();
                } else if (key === 'showAllModels') {
                  // 需要重新向后端取整棵子树（或退回非递归）；同时重建树，
                  // 让徽标口径在「直属数量」与「含子文件夹总数」间切换
                  renderTree(getActiveRoot());
                  applySearch();
                }
                // lockRatio 只影响后续输入联动，不改变当前视图
                flashToast(sw.checked ? t('toast.switchOn', { name: sw.getAttribute('aria-label') }) : t('toast.switchOff', { name: sw.getAttribute('aria-label') }));
              });
            });

            updateRatioActive();
            bindLlmSettings(modal);
            bindMatchOldData(modal);
            bindSyncOldJson(modal);
          },
        });
      });
    }
    bindLlmStateButton(root);
  }

  // ---------- 翻译模型状态按钮（顶栏，3 态） ----------
  // 未加载=灰色只读；已加载=绿色，悬停变红色显示「卸载翻译模型」；点击卸载。
  // 自动卸载是后台静默发生的，故需定时轮询才能反映真实状态。
  const LLM_STATE_POLL_MS = 15000;
  let llmStateTimer = null;

  function paintLlmState(root, loaded) {
    const btn = root.querySelector('.lna-llm-state');
    if (!btn) return;
    btn.classList.toggle('is-loaded', !!loaded);
    btn.disabled = !loaded; // 未加载时纯展示，不可点击
    btn.setAttribute('aria-label', loaded ? t('llmState.loadedAria') : t('llmState.offAria'));
  }

  async function refreshLlmState() {
    let loaded = false;
    try {
      const r = await fetch(API.llmStatus);
      const j = await r.json();
      loaded = !!(j && j.ok && j.loaded);
    } catch (e) { return; }
    document.querySelectorAll('.lna-root').forEach((root) => {
      bindLlmStateButton(root); // 幂等：确保注入后首次轮询即已绑定点击
      paintLlmState(root, loaded);
    });
    return loaded;
  }

  function bindLlmStateButton(root) {
    const btn = root.querySelector('.lna-llm-state');
    if (!btn || btn.__lna_bound) return;
    btn.__lna_bound = true;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await fetch(API.llmUnload, { method: 'POST' });
        const j = await r.json();
        if (j && j.ok) {
          // 后端返回最新状态（已卸载时 unloaded=false，幂等不报错）
          document.querySelectorAll('.lna-root').forEach((el) => paintLlmState(el, !!j.loaded));
          flashToast(j.unloaded ? t('llmState.unloaded') : t('llmState.wasUnloaded'));
        } else {
          flashToast(t('llmState.unloadFailed', { msg: (j && j.error) || t('toast.unknownError') }), true);
          refreshLlmState();
        }
      } catch (e) {
        flashToast(t('llmState.unloadReqFailed'), true);
        refreshLlmState();
      }
    });
  }

  // 启动轮询（整个页面只跑一个定时器，覆盖两个 tab 实例）
  function startLlmStatePolling() {
    refreshLlmState();
    if (llmStateTimer) return;
    llmStateTimer = setInterval(refreshLlmState, LLM_STATE_POLL_MS);
  }

  // ---------- 标签翻译设置（GGUF 模型选择 + 下载） ----------
  function setLlmProgress(modal, text, isErr) {
    const box = modal.querySelector('.lna-llm-progress');
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || '';
    box.classList.toggle('is-err', !!isErr);
  }

  function fillLlmOptions(modal, models, selected, engineReady) {
    const sel = modal.querySelector('.lna-llm-select');
    if (!sel) return;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = engineReady ? t('settings.llm.none') : t('llm.noneNoEngine');
    sel.appendChild(none);
    models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.rel;
      o.textContent = `${m.name} · ${fmtSize(m.size)}`;
      sel.appendChild(o);
    });
    // 选中的模型可能已被删除，此时回落到「不使用」
    sel.value = models.some((m) => m.rel === selected) ? selected : '';
  }

  async function refreshLlmModels(modal) {
    try {
      const r = await fetch(API.llmModels);
      const res = await r.json();
      if (!document.contains(modal)) return null;
      if (!res || !res.ok) {
        setLlmProgress(modal, (res && res.error) || t('llm.readModelsFailed'), true);
        return null;
      }
      fillLlmOptions(modal, res.models || [], res.selected || '', res.engine_ready);
      syncDeviceSwitch(modal, !!res.gpu, !!res.cuda_available);
      if (!res.engine_ready) {
        // 带上后端返回的真实原因：多数情况是 CUDA 运行库不在启动环境里
        setLlmProgress(
          modal,
          t('llm.engineMissing')
            + (res.engine_error ? t('llm.engineReason', { msg: res.engine_error }) : ''),
          true,
        );
      }
      return res;
    } catch (e) {
      setLlmProgress(modal, t('llm.readModelsFailedReq'), true);
      return null;
    }
  }

  // 推理设备胶囊：同步选中态；CUDA 构建不可用时禁用 GPU 段
  function syncDeviceSwitch(modal, gpu, cudaAvailable) {
    const box = modal.querySelector('.lna-device-switch');
    if (!box) return;
    box.querySelectorAll('.lna-zh-key').forEach((k) => {
      const isGpu = k.dataset.dev === 'gpu';
      const on = isGpu === !!gpu;
      k.classList.toggle('active', on);
      k.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (isGpu) {
        k.disabled = !cudaAvailable;
        k.title = cudaAvailable ? t('llm.gpuTitle') : t('llm.gpuDisabledTitle');
      }
    });
  }

  // 空闲自动卸载：同步胶囊选中态 + 分钟输入框；关闭时输入框禁用
  function syncIdleSwitch(modal, autoUnload, minutes) {
    const box = modal.querySelector('.lna-idle-switch');
    if (box) {
      box.querySelectorAll('.lna-zh-key').forEach((k) => {
        const on = (k.dataset.idle === '1') === !!autoUnload;
        k.classList.toggle('active', on);
        k.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    const inp = modal.querySelector('.lna-idle-minutes');
    if (inp) {
      inp.value = String(minutes);
      inp.disabled = !autoUnload; // 永不卸载时无需设置时长
    }
  }

  function clampIdleMinutes(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return IDLE_DEFAULT;
    return Math.min(IDLE_MAX, Math.max(IDLE_MIN, n));
  }

  // 翻译方案：仅用对照表 / 仅用模型翻译 / 使用混合翻译
  function syncModeSwitch(root, mode) {
    const m = TRANS_MODES.some((x) => x.v === mode) ? mode : TRANS_MODE_DEFAULT;
    root.querySelectorAll('.lna-mode-btn').forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // 翻译方案控件 HTML：插件设置与卡片设置共用同一套按钮结构
  function modeGroupHtml() {
    return `<div class="lna-mode-group" role="group" aria-label="${t('settings.mode.groupAria')}">${TRANS_MODES.map((x) => `<button class="lna-mode-btn${x.v === TRANS_MODE_DEFAULT ? ' active' : ''}" type="button" data-mode="${x.v}" aria-pressed="${x.v === TRANS_MODE_DEFAULT ? 'true' : 'false'}">${t('settings.mode.' + x.v)}</button>`).join('')}</div>`;
  }

  function modeLabel(mode) {
    const hit = TRANS_MODES.find((x) => x.v === mode);
    return hit ? t('settings.mode.' + hit.v) : String(mode || '');
  }

  // 绑定翻译方案按钮：写入后端后同步「文档内所有」方案控件，
  // 使插件设置与卡片设置两处控件始终一致（共享同一后端值）。
  function bindModeSwitch(root) {
    root.querySelectorAll('.lna-mode-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        if (b.classList.contains('active')) return;
        const want = b.dataset.mode;
        try {
          const r = await fetch(API.translateMode, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: want }),
          });
          const res = await r.json();
          if (res && res.ok) {
            syncModeSwitch(document, res.mode);
            flashToast(t('toast.modeSwitched', { mode: modeLabel(res.mode) }));
          } else {
            flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
            await refreshTranslateMode(root); // 回滚为后端真实值
          }
        } catch (e) {
          flashToast(t('toast.saveFailed', { msg: t('toast.unknownError') }), true);
          await refreshTranslateMode(root);
        }
      });
    });
  }

  // 读取后端当前翻译方案并同步到弹窗
  async function refreshTranslateMode(modal) {
    try {
      const r = await fetch(API.llmStatus);
      const j = await r.json();
      if (!document.contains(modal) || !j || !j.ok) return null;
      syncModeSwitch(modal, j.translate_mode);
      return j;
    } catch (e) { return null; }
  }

  // 读取后端当前空闲设置并同步到弹窗
  async function refreshLlmIdle(modal) {
    try {
      const r = await fetch(API.llmStatus);
      const j = await r.json();
      if (!document.contains(modal) || !j || !j.ok) return null;
      syncIdleSwitch(modal, j.auto_unload, j.idle_minutes);
      return j;
    } catch (e) { return null; }
  }

  // ---------- 翻译提示预设 ----------
  function setPromptMsg(modal, text, isErr) {
    const box = modal.querySelector('.lna-prompt-msg');
    if (!box) return;
    if (!text) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = text;
    box.classList.toggle('is-err', !!isErr);
  }

  // 把后端返回的预设列表与当前启用项同步到弹窗控件
  function syncPromptUI(modal, data) {
    const sel = modal.querySelector('.lna-prompt-select');
    const nameInp = modal.querySelector('.lna-prompt-name');
    const textArea = modal.querySelector('.lna-prompt-text');
    const delBtn = modal.querySelector('.lna-prompt-delete');
    if (!sel || !nameInp || !textArea) return;
    const defName = (data && data.default_name) || '默认';
    const active = (data && data.active) || defName;
    const presets = (data && data.presets) || [];

    sel.innerHTML = presets
      .map((p) => `<option value="${esc(p.name)}">${esc(p.name === defName ? t('llm.promptBuiltinOption', { name: p.name }) : p.name)}</option>`)
      .join('');
    sel.value = active;

    const hit = presets.find((p) => p.name === active);
    textArea.value = hit ? hit.text : ((data && data.text) || '');
    nameInp.value = active === defName ? '' : active; // 默认预设不可覆盖，名称留空待填
    if (delBtn) {
      delBtn.disabled = active === defName; // 内置预设不可删除
      delBtn.title = delBtn.disabled ? t('llm.promptDefaultLockedTitle') : t('settings.prompt.deleteTitle');
    }
  }

  async function refreshPromptPresets(modal) {
    try {
      const r = await fetch(API.promptPresets);
      const j = await r.json();
      if (!document.contains(modal) || !j || !j.ok) return null;
      syncPromptUI(modal, j);
      return j;
    } catch (e) { return null; }
  }

  async function editPromptPresets(modal, payload) {
    try {
      const r = await fetch(API.promptPresets, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await r.json();
      if (res && res.ok) {
        syncPromptUI(modal, res);
        return res;
      }
      setPromptMsg(modal, (res && res.error) || t('llm.opFailed'), true);
      return null;
    } catch (e) {
      setPromptMsg(modal, t('llm.opFailedReq'), true);
      return null;
    }
  }

  function bindPromptPresets(modal) {
    const sel = modal.querySelector('.lna-prompt-select');
    const delBtn = modal.querySelector('.lna-prompt-delete');
    const saveBtn = modal.querySelector('.lna-prompt-save');
    const nameInp = modal.querySelector('.lna-prompt-name');
    const textArea = modal.querySelector('.lna-prompt-text');
    if (!sel || !saveBtn) return;

    refreshPromptPresets(modal);

    // 切换预设：立即生效（只影响后续模型翻译）
    sel.addEventListener('change', async () => {
      setPromptMsg(modal, '');
      const res = await editPromptPresets(modal, { action: 'select', name: sel.value });
      if (res) flashToast(t('llm.promptActivated', { name: res.active }));
    });

    // 保存：以输入框中的名称写入当前文本（同名覆盖）
    saveBtn.addEventListener('click', async () => {
      setPromptMsg(modal, '');
      const name = (nameInp.value || '').trim();
      const res = await editPromptPresets(modal, { action: 'save', name, text: textArea.value });
      if (res) flashToast(t('llm.promptSaved', { name }));
    });

    // 删除当前选中的预设
    delBtn.addEventListener('click', async () => {
      setPromptMsg(modal, '');
      const res = await editPromptPresets(modal, { action: 'delete', name: sel.value });
      if (res) flashToast(t('llm.promptDeleted', { name: res.active }));
    });
  }

  function pickPreferredFile(files) {
    for (const q of LLM_PREFER_QUANT) {
      const hit = files.find((f) => f.filename.toLowerCase().includes(q.toLowerCase()));
      if (hit) return hit.filename;
    }
    return files.length ? files[0].filename : '';
  }

  function fillLlmFiles(modal, files) {
    const sel = modal.querySelector('.lna-llm-file');
    if (!sel) return;
    sel.innerHTML = '';
    if (!files.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = t('llm.repoNoFiles');
      sel.appendChild(o);
      return;
    }
    files.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.filename;
      // 带 mmproj 的是多模态投影文件，不是主模型，额外标注以免误选
      const tag = /mmproj/i.test(f.filename) ? t('llm.mmprojTag') : '';
      o.textContent = `${f.filename}${tag}${f.size ? ' · ' + fmtSize(f.size) : ''}`;
      sel.appendChild(o);
    });
    sel.value = pickPreferredFile(files);
  }

  // ---------- 翻译运行环境（CPU / CUDA 版 llama-cpp-python） ----------
  function setRuntimeProgress(modal, text, isErr) {
    const box = modal.querySelector('.lna-runtime-progress');
    if (!box) return;
    if (!text) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = text;
    box.classList.toggle('is-err', !!isErr);
  }

  // 读取并渲染当前运行环境；返回后端数据（失败为 null）
  async function refreshRuntimeInfo(modal) {
    const state = modal.querySelector('.lna-runtime-state');
    const btn = modal.querySelector('.lna-runtime-install');
    if (!state || !btn) return null;
    let info = null;
    try {
      const r = await fetch(API.runtimeInfo);
      info = await r.json();
    } catch (e) { info = null; }
    if (!document.contains(modal)) return null;
    if (!info || !info.ok) {
      state.textContent = t('llm.runtimeReadFailed');
      btn.disabled = true;
      return null;
    }
    let text = '';
    let canDownload = false;
    if (info.build === 'cuda') {
      text = info.usable ? t('llm.runtimeCudaOk') : t('llm.runtimeCudaNoLoad');
    } else if (info.cuda_wheel_ready) {
      text = t('llm.runtimeWheelReady');
    } else if (!info.nvidia_ok) {
      text = info.driver
        ? t('llm.runtimeCpuOldDriver', { driver: info.driver, min: info.min_driver })
        : t('llm.runtimeCpuNoNvidia');
    } else {
      text = t('llm.runtimeCpuDownloadable');
      canDownload = true;
    }
    state.textContent = text;
    btn.disabled = !canDownload;
    btn.title = canDownload ? t('llm.runtimeDownloadTitle') : '';
    return info;
  }

  function bindRuntimeRow(modal) {
    const btn = modal.querySelector('.lna-runtime-install');
    if (!btn) return;
    let pollTimer = null;

    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function startPoll() {
      stopPoll();
      btn.disabled = true;
      pollTimer = setInterval(async () => {
        if (!document.contains(modal)) { stopPoll(); return; }
        let st = null;
        try {
          const r = await fetch(API.runtimeDownloadStatus);
          st = await r.json();
        } catch (e) { return; }
        if (!st || !st.ok) return;
        if (st.active) {
          const pct = st.total ? ((st.done / st.total) * 100).toFixed(1) : '?';
          const retry = st.attempt > 1 ? t('llm.retrySuffix', { n: st.attempt }) : '';
          setRuntimeProgress(modal,
            t('llm.runtimeDownloading', { done: fmtSize(st.done), total: st.total ? ' / ' + fmtSize(st.total) : '', pct, retry }));
          return;
        }
        stopPoll();
        if (st.cuda_wheel_ready) {
          setRuntimeProgress(modal, t('llm.runtimeDownloaded'));
          flashToast(t('llm.runtimeDoneToast'));
        } else {
          setRuntimeProgress(modal, st.error || t('llm.downloadIncomplete'), true);
        }
        refreshRuntimeInfo(modal);
      }, 1000);
    }

    refreshRuntimeInfo(modal);
    // 弹窗重新打开时若后端仍在下载，接续显示进度
    (async () => {
      try {
        const r = await fetch(API.runtimeDownloadStatus);
        const res = await r.json();
        if (res && res.ok && res.active && document.contains(modal)) startPoll();
      } catch (e) {}
    })();

    btn.addEventListener('click', async () => {
      setRuntimeProgress(modal, t('llm.preparingDownload'));
      try {
        const r = await fetch(API.runtimeDownloadCuda, { method: 'POST' });
        const res = await r.json();
        if (!res || !res.ok) {
          setRuntimeProgress(modal, (res && res.error) || t('llm.downloadStartFailed'), true);
          refreshRuntimeInfo(modal);
          return;
        }
      } catch (e) {
        setRuntimeProgress(modal, t('llm.downloadStartFailedReq'), true);
        return;
      }
      startPoll();
    });
  }

  function bindLlmSettings(modal) {
    const sel = modal.querySelector('.lna-llm-select');
    const refresh = modal.querySelector('.lna-llm-refresh');
    const openFolderBtn = modal.querySelector('.lna-llm-open-folder');
    const repoInput = modal.querySelector('.lna-llm-repo');
    const detectBtn = modal.querySelector('.lna-llm-detect');
    const fileSel = modal.querySelector('.lna-llm-file');
    const dlBtn = modal.querySelector('.lna-llm-download');
    if (!sel || !dlBtn) return;

    let pollTimer = null;

    refreshLlmModels(modal);
    refreshLlmIdle(modal);       // 同步空闲自动卸载开关与分钟数
    refreshTranslateMode(modal); // 同步翻译方案（仅用对照表 / 仅用模型翻译 / 混合）
    bindPromptPresets(modal);    // 翻译提示预设：下拉切换 + 保存 + 删除
    bindRuntimeRow(modal);       // 翻译运行环境：状态 + 下载 CUDA 版

    // 若后端仍有下载任务在进行（例如关掉弹窗又打开），接续显示进度
    (async () => {
      try {
        const r = await fetch(API.llmDownloadStatus);
        const res = await r.json();
        if (res && res.ok && res.active && document.contains(modal)) {
          dlBtn.disabled = true;
          startPoll();
        }
      } catch (e) {}
    })();

    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      setLlmProgress(modal, t('llm.rescanning'));
      const res = await refreshLlmModels(modal);
      refresh.disabled = false;
      if (res) setLlmProgress(modal, t('llm.scannedModels', { n: (res.models || []).length }));
    });

    // 打开模型文件夹：后端调系统资源管理器打开 LLM 目录
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', async () => {
        try {
          const r = await fetch(API.llmOpenFolder, { method: 'POST' });
          const res = await r.json();
          if (!res || !res.ok) flashToast(t('toast.openFailed', { msg: (res && res.error) || t('toast.unknownError') }));
        } catch (e) {
          flashToast(t('toast.openFailedReq'));
        }
      });
    }

    // 推理设备切换：保存后卸载模型，下次翻译按新设备重新加载
    modal.querySelectorAll('.lna-device-switch .lna-zh-key').forEach((k) => {
      k.addEventListener('click', async () => {
        if (k.disabled) return;
        const want = k.dataset.dev === 'gpu';
        try {
          const r = await fetch(API.llmGpu, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gpu: want }),
          });
          const res = await r.json();
          if (res && res.ok) {
            syncDeviceSwitch(modal, want, true);
            flashToast(want ? t('llm.switchedGpu') : t('llm.switchedCpu'));
          } else {
            flashToast((res && res.error) || t('llm.switchFailed'));
          }
        } catch (e) {
          flashToast(t('llm.switchFailedReq'));
        }
      });
    });

    // 翻译方案切换：保存到后端（翻译时按该方案执行），并与卡片设置处的同名控件同步
    bindModeSwitch(modal);

    // 空闲自动卸载：胶囊开关与分钟输入框
    const idleInp = modal.querySelector('.lna-idle-minutes');
    async function saveIdle(payload, okMsg) {
      try {
        const r = await fetch(API.llmIdleSettings, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const res = await r.json();
        if (res && res.ok) {
          syncIdleSwitch(modal, res.auto_unload, res.idle_minutes);
          if (okMsg) flashToast(okMsg);
        } else {
          flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
          await refreshLlmIdle(modal); // 回滚为后端真实值
        }
      } catch (e) {
        flashToast(t('toast.saveFailedReq'), true);
        await refreshLlmIdle(modal);
      }
    }
    modal.querySelectorAll('.lna-idle-switch .lna-zh-key').forEach((k) => {
      k.addEventListener('click', () => {
        if (k.classList.contains('active')) return;
        const want = k.dataset.idle === '1';
        const minutes = clampIdleMinutes(idleInp ? idleInp.value : IDLE_DEFAULT);
        saveIdle({ auto_unload: want, minutes },
          want ? t('llm.idleOn', { n: minutes }) : t('llm.idleOff'));
      });
    });
    if (idleInp) {
      // 输入过程中不提交，失焦/回车才归一化并保存（避免每敲一位都请求）
      const commitIdle = () => {
        const v = clampIdleMinutes(idleInp.value);
        idleInp.value = String(v);
        saveIdle({ minutes: v }, t('llm.idleSaved', { n: v }));
      };
      idleInp.addEventListener('change', commitIdle);
      idleInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitIdle(); }
      });
    }

    // 切换模型：写回后端并立即卸载旧实例，避免内存里堆多个模型
    sel.addEventListener('change', async () => {
      try {
        const r = await fetch(API.llmSelect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: sel.value }),
        });
        const res = await r.json();
        if (res && res.ok) {
          flashToast(sel.value ? t('llm.modelSelected', { name: sel.value }) : t('llm.switchedToDict'));
          setLlmProgress(modal, sel.value
            ? t('llm.modelLoadNote')
            : '');
        } else {
          flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }));
        }
      } catch (e) {
        flashToast(t('toast.saveFailedReq'));
      }
    });

    async function detectRepo(showToast) {
      const repo = (repoInput.value || '').trim();
      if (!repo) { setLlmProgress(modal, t('llm.needRepo'), true); return []; }
      detectBtn.disabled = true;
      setLlmProgress(modal, t('llm.probingRepo'));
      try {
        const r = await fetch(API.llmRepoFiles, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo }),
        });
        const res = await r.json();
        if (!document.contains(modal)) return [];
        if (!res || !res.ok) {
          setLlmProgress(modal, (res && res.error) || t('llm.readFailed'), true);
          return [];
        }
        fillLlmFiles(modal, res.files || []);
        setLlmProgress(modal, t('llm.filesFound', { n: res.files.length, endpoint: res.endpoint, dir: res.dir }));
        if (showToast) flashToast(t('llm.filesDetected', { n: res.files.length }));
        return res.files || [];
      } catch (e) {
        setLlmProgress(modal, t('llm.readFailedReq'), true);
        return [];
      } finally {
        detectBtn.disabled = false;
      }
    }

    detectBtn.addEventListener('click', () => detectRepo(true));

    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function startPoll() {
      stopPoll();
      pollTimer = setInterval(async () => {
        if (!document.contains(modal)) { stopPoll(); return; }
        try {
          const r = await fetch(API.llmDownloadStatus);
          const res = await r.json();
          if (!res || !res.ok) return;
          const { active, done, total, error, ok, filename, endpoint, attempt } = res;
          if (active) {
            const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '?';
            const retry = attempt > 1 ? t('llm.retrySuffix', { n: attempt }) : '';
            setLlmProgress(modal, t('llm.downloading', { file: filename, done: fmtSize(done), total: total ? ' / ' + fmtSize(total) : '', pct, endpoint, retry }));
            return;
          }
          stopPoll();
          dlBtn.disabled = false;
          if (ok) {
            setLlmProgress(modal, t('llm.downloadDone', { file: filename }));
            flashToast(t('llm.downloadDoneToast'));
            const res2 = await refreshLlmModels(modal);
            // 只有一个模型时自动选中，省去手动操作
            if (res2 && (res2.models || []).length === 1) {
              const only = res2.models[0].rel;
              sel.value = only;
              await fetch(API.llmSelect, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rel: only }),
              });
            }
          } else if (error) {
            setLlmProgress(modal, error, true);
            flashToast(error);
          }
        } catch (e) { /* 轮询期间的网络抖动忽略，下一轮重试 */ }
      }, 1000);
    }

    dlBtn.addEventListener('click', async () => {
      // 还没检测过就先自动检测，并按推荐量化自动挑选，满足「一键下载」
      if (!fileSel.value) {
        const files = await detectRepo(false);
        if (!files.length) return;
      }
      const filename = fileSel.value;
      if (!filename) { setLlmProgress(modal, t('llm.needFile'), true); return; }
      dlBtn.disabled = true;
      setLlmProgress(modal, t('llm.preparingFile', { file: filename }));
      try {
        const r = await fetch(API.llmDownload, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: (repoInput.value || '').trim(), filename }),
        });
        const res = await r.json();
        if (!res || !res.ok) {
          dlBtn.disabled = false;
          setLlmProgress(modal, (res && res.error) || t('llm.downloadStartFailed'), true);
          return;
        }
        startPoll();
      } catch (e) {
        dlBtn.disabled = false;
        setLlmProgress(modal, t('llm.downloadStartFailedReq'), true);
      }
    });
  }

  // ---------- 自动匹配旧数据 ----------
  function setMatchProgress(modal, text, isErr) {
    const box = modal.querySelector('.lna-match-progress');
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || '';
    box.classList.toggle('is-err', !!isErr);
  }

  function renderMatchResult(modal, res) {
    const wrap = modal.querySelector('.lna-match-result');
    if (!wrap) return;
    const list = (res && res.unmatched) || [];
    const countEl = wrap.querySelector('.lna-match-result-count');
    const ul = wrap.querySelector('.lna-match-unmatched');
    if (countEl) countEl.textContent = list.length ? t('sync.itemsCount', { n: list.length }) : t('sync.none');
    if (ul) {
      ul.innerHTML = list.map((it) => {
        const bits = [];
        if (it.hash) bits.push(t('sync.hashPrefix', { v: it.hash }));
        if (it.size) bits.push(t('sync.sizePrefix', { v: fmtSize(it.size) }));
        bits.push(it.has_content ? t('sync.hasContent') : t('sync.emptyData'));
        return `<li class="lna-match-item${it.has_content ? ' has-data' : ''}">
            <span class="lna-match-item-path" title="${esc(it.rel)}">${esc(it.rel)}</span>
            <span class="lna-match-item-meta">${esc(bits.join(' · '))}</span>
          </li>`;
      }).join('');
    }
    wrap.classList.toggle('is-empty', list.length === 0);
    wrap.hidden = false;
  }

  function bindMatchOldData(modal) {
    const btn = modal.querySelector('.lna-match-run');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (btn.__lna_busy) return;
      btn.__lna_busy = true;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const origText = btn.textContent;
      btn.innerHTML = '<span class="lna-spinner"></span>' + t('sync.matching');
      setMatchProgress(modal, t('sync.scanningOld'));
      let res = null;
      try {
        const r = await fetch(API.matchOldData, { method: 'POST' });
        res = await r.json();
      } catch (e) {
        res = null;
      }
      if (!document.contains(modal)) return;
      btn.__lna_busy = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = origText;
      if (!res || !res.ok) {
        setMatchProgress(modal, (res && res.error) || t('sync.matchFailedReq'), true);
        return;
      }
      const parts = [];
      if (res.matched) parts.push(t('sync.matchedCount', { n: res.matched }));
      if (res.moved) parts.push(t('sync.movedCount', { n: res.moved }));
      if (res.merged) parts.push(t('sync.mergedCount', { n: res.merged }));
      if (res.legacy_moved) parts.push(t('sync.legacyMovedCount', { n: res.legacy_moved }));
      const un = (res.unmatched || []).length;
      if (!res.matched) {
        setMatchProgress(modal, un ? t('sync.noMigratable', { n: un }) : t('sync.noneToMigrate'), un > 0);
      } else {
        setMatchProgress(modal, t('sync.matchSummary', { parts: parts.join(t('sync.listSep')), n: un }), un > 0);
      }
      renderMatchResult(modal, res);
      if (res.matched) {
        // 迁移后模型卡片信息可能变化，重扫目录与列表
        try {
          await loadTree();
          await loadDir(state.currentPath);
          renderFull(getActiveRoot());
        } catch (e) { /* 刷新失败不影响匹配结果展示 */ }
        flashToast(t('sync.migratedToast', { n: res.matched }));
      }
    });
  }

  // ---------- 同步旧插件（sd_forge_lora）的 JSON 到本插件 ----------
  function setSyncProgress(modal, text, isErr) {
    const box = modal.querySelector('.lna-sync-progress');
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || '';
    box.classList.toggle('is-err', !!isErr);
  }

  // 渲染冲突列表：左为 JSON 名，右为【覆盖】按钮。列表随弹窗销毁，重新打开需再点同步重新检测
  function renderSyncConflicts(modal, list) {
    const wrap = modal.querySelector('.lna-sync-conflicts');
    const ul = modal.querySelector('.lna-sync-list');
    const countEl = modal.querySelector('.lna-sync-conflicts-count');
    if (!wrap || !ul) return;
    const items = list || [];
    if (countEl) countEl.textContent = t('sync.itemsCount', { n: items.length });
    ul.innerHTML = items.map((it) => {
      // 差异字段标签：不同=黄橙、一边为空=红；一致的字段不显示
      const tags = (it.fields || [])
        .map((f) => `<span class="lna-sync-tag is-${esc(f.state)}">${esc(f.label)}</span>`)
        .join('');
      return `
        <li class="lna-sync-item" data-rel="${esc(it.rel)}">
          <div class="lna-sync-main">
            <span class="lna-sync-name" title="${esc(it.rel)}">${esc(it.name)}</span>
            ${tags ? `<div class="lna-sync-tags" aria-label="${esc(t('sync.diffFieldsAria'))}">${tags}</div>` : ''}
          </div>
          <div class="lna-sync-actions">
            <button class="dlg-btn lna-sync-compare" type="button" data-rel="${esc(it.rel)}" data-name="${esc(it.name)}">${t('sync.compare')}</button>
            <button class="dlg-btn lna-sync-overwrite" type="button" data-rel="${esc(it.rel)}">${t('sync.overwrite')}</button>
          </div>
        </li>`;
    }).join('');
    wrap.hidden = items.length === 0;
  }

  // ---------- 数据对比弹窗（旧插件 JSON vs 本插件 JSON，左右两栏） ----------
  function cmpLegendHtml() {
    return `<div class="lna-cmp-legend">
        <span class="is-same">${t('sync.same')}</span>
        <span class="is-diff">${t('sync.diff')}</span>
        <span class="is-empty">${t('sync.oneSideEmpty')}</span>
      </div>`;
  }

  function renderCompare(dlg, res) {
    const body = dlg.querySelector('.dlg-body');
    if (!body) return;
    const rows = (res && res.rows) || [];
    const emptyCell = '<em>' + t('sync.emptyCell') + '</em>';
    const cells = rows.map((r) => {
      const ov = r.old ? esc(r.old) : emptyCell;
      const nv = r.new ? esc(r.new) : emptyCell;
      const same = r.state === 'same';
      // 一致=灰色禁用；不同/一边为空=橙色可点
      const btn = same
        ? `<button class="dlg-btn lna-cmp-unify is-same" type="button" disabled title="${esc(t('sync.unifySameTitle'))}">${t('sync.unify')}</button>`
        : `<button class="dlg-btn primary lna-cmp-unify" type="button" data-key="${esc(r.key)}" data-label="${esc(r.label)}" title="${esc(t('sync.unifyTitle'))}">${t('sync.unify')}</button>`;
      return `<div class="lna-cmp-label">${esc(r.label)}</div>
        <div class="lna-cmp-val is-${esc(r.state)}">${ov}</div>
        <div class="lna-cmp-val is-${esc(r.state)}">${nv}</div>
        ${btn}`;
    }).join('');
    body.innerHTML = `${cmpLegendHtml()}
      <div class="lna-cmp">
        <div class="lna-cmp-head">${t('sync.oldJsonHead')}<span class="lna-cmp-sub">models/Lora/${esc(res.name)}.json</span></div>
        <div class="lna-cmp-head">${t('sync.newJsonHead')}<span class="lna-cmp-sub">models_json_data/${esc(res.name)}_new.json</span></div>
        <div class="lna-cmp-head lna-cmp-head-op" aria-hidden="true"></div>
        ${cells}
      </div>`;
  }

  // 数据统一化：左右二选一，用所选一侧的值覆盖另一侧的文件
  function openUnifyDialog(rel, row, onDone) {
    if (document.querySelector('.lna-unify-mask')) return; // 已打开，忽略重复点击
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-unify-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-unify-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('sync.unify'));
    const emptyCell = '<em>' + t('sync.emptyCell') + '</em>';
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('sync.unify')}<span class="lna-cf-hint">${esc(row.label)}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <p class="lna-unify-tip">${t('sync.unifyTip')}</p>
        <div class="lna-unify-cols">
          <div class="lna-unify-col">
            <div class="lna-unify-head">${t('sync.oldJsonHead')}</div>
            <div class="lna-unify-val">${row.old ? esc(row.old) : emptyCell}</div>
            <button class="dlg-btn primary lna-unify-pick" type="button" data-dir="old_to_new">${t('sync.overwriteLR')}</button>
          </div>
          <div class="lna-unify-col">
            <div class="lna-unify-head">${t('sync.newJsonHead')}</div>
            <div class="lna-unify-val">${row.new ? esc(row.new) : emptyCell}</div>
            <button class="dlg-btn primary lna-unify-pick" type="button" data-dir="new_to_old">${t('sync.overwriteRL')}</button>
          </div>
        </div>
        <div class="lna-unify-msg" role="status" aria-live="polite" hidden></div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="close" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    function setMsg(text, isErr) {
      const box = dlg.querySelector('.lna-unify-msg');
      if (!box) return;
      box.hidden = !text;
      box.textContent = text || '';
      box.classList.toggle('is-err', !!isErr);
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="close"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    dlg.querySelectorAll('.lna-unify-pick').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.__lna_busy) return;
        btn.__lna_busy = true;
        const picks = Array.from(dlg.querySelectorAll('.lna-unify-pick'));
        picks.forEach((b) => { b.disabled = true; });
        const origText = btn.textContent;
        btn.innerHTML = '<span class="lna-spinner"></span>' + t('sync.overwriting');
        let res = null;
        try {
          const r = await fetch(API.syncOldJsonUnify, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rel, key: row.key, direction: btn.dataset.dir }),
          });
          res = await r.json();
        } catch (e) {
          res = null;
        }
        if (!document.contains(dlg)) return;
        if (!res || !res.ok) {
          btn.__lna_busy = false;
          picks.forEach((b) => { b.disabled = false; });
          btn.textContent = origText;
          setMsg((res && res.error) || t('sync.overwriteFailedReq'), true);
          return;
        }
        flashToast(t('sync.unifiedToast', { label: row.label }));
        close();
        if (onDone) onDone();
      });
    });
  }

  async function openCompareDialog(rel, name, parentModal) {
    if (document.querySelector('.lna-cmp-mask')) return; // 已打开，忽略重复点击
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-cmp-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-cmp-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('sync.compareTitle'));
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('sync.compareTitle')}<span class="lna-cf-hint">${esc(name)}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="dlg-loading" role="status" aria-live="polite"><span class="lna-spinner" aria-hidden="true"></span>${t('sync.loadingCompare')}</div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="close" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="close"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const body = dlg.querySelector('.dlg-body');

    // 拉取（或重新拉取）对比数据并渲染；统一化后调用可即时反映新状态
    async function reload() {
      let data = null;
      try {
        const r = await fetch(API.syncOldJsonCompare, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel }),
        });
        data = await r.json();
      } catch (e) {
        data = null;
      }
      if (!document.contains(dlg)) return null; // 弹窗已被关闭，丢弃结果
      if (!data || !data.ok) {
        body.innerHTML = `<div class="dlg-empty">${esc((data && data.error) || t('sync.readCompareFailed'))}</div>`;
        return null;
      }
      dlg.__lnaCompare = data;
      renderCompare(dlg, data);
      return data;
    }

    // 事件委托只绑一次：点击【数据统一化】弹出左右二选一小窗
    body.addEventListener('click', (e) => {
      const ub = e.target.closest('.lna-cmp-unify');
      if (!ub || ub.disabled) return;
      const data = dlg.__lnaCompare;
      const row = data && (data.rows || []).find((r) => r.key === ub.dataset.key);
      if (!row) return;
      openUnifyDialog(rel, row, async () => {
        await reload();
        // 该字段统一后可能不再是冲突，同步刷新父弹窗的冲突列表
        if (parentModal && document.contains(parentModal)) {
          try {
            const r = await fetch(API.syncOldJson, { method: 'POST' });
            const s = await r.json();
            if (s && s.ok) renderSyncConflicts(parentModal, s.conflicts || []);
          } catch (err) { /* 刷新失败不影响统一结果 */ }
        }
      });
    });

    await reload();
  }

  function bindSyncOldJson(modal) {
    const btn = modal.querySelector('.lna-sync-run');
    if (!btn) return;
    const ul = modal.querySelector('.lna-sync-list');
    const wrap = modal.querySelector('.lna-sync-conflicts');

    btn.addEventListener('click', async () => {
      if (btn.__lna_busy) return;
      btn.__lna_busy = true;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const origText = btn.textContent;
      btn.innerHTML = '<span class="lna-spinner"></span>' + t('sync.syncing');
      setSyncProgress(modal, t('sync.scanningJson'));
      let res = null;
      try {
        const r = await fetch(API.syncOldJson, { method: 'POST' });
        res = await r.json();
      } catch (e) {
        res = null;
      }
      if (!document.contains(modal)) return;
      btn.__lna_busy = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = origText;
      if (!res || !res.ok) {
        setSyncProgress(modal, (res && res.error) || t('sync.syncFailedReq'), true);
        return;
      }
      const conflicts = res.conflicts || [];
      const parts = [];
      if (res.created) parts.push(t('sync.createdCount', { n: res.created }));
      if (res.filled) parts.push(t('sync.filledCount', { n: res.filled }));
      const summary = parts.length
        ? t('sync.syncedSummary', { parts: parts.join(t('sync.listSep')) })
        : t('sync.nothingToSync');
      setSyncProgress(modal, conflicts.length ? t('sync.conflictsSummary', { summary, n: conflicts.length }) : summary, conflicts.length > 0);
      renderSyncConflicts(modal, conflicts);
      if (res.created || res.filled) {
        try {
          await loadTree();
          await loadDir(state.currentPath);
          renderFull(getActiveRoot());
        } catch (e) { /* 刷新失败不影响同步结果展示 */ }
        flashToast(t('sync.syncedToast', { n: (res.created || 0) + (res.filled || 0) }));
      }
    });

    // 冲突列表：事件委托绑定一次；【查看数据对比】开对比弹窗，【覆盖】成功后移除该项
    if (ul) {
      ul.addEventListener('click', async (e) => {
        const cmp = e.target.closest('.lna-sync-compare');
        if (cmp) {
          openCompareDialog(cmp.dataset.rel, cmp.dataset.name || '', modal);
          return;
        }
        const ob = e.target.closest('.lna-sync-overwrite');
        if (!ob || ob.__lna_busy) return;
        const rel = ob.dataset.rel;
        ob.__lna_busy = true;
        ob.disabled = true;
        try {
          const r = await fetch(API.syncOldJsonOverwrite, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rel }),
          });
          const res = await r.json();
          if (!res || !res.ok) {
            ob.__lna_busy = false;
            ob.disabled = false;
            flashToast(t('sync.overwriteFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
            return;
          }
        } catch (err) {
          ob.__lna_busy = false;
          ob.disabled = false;
          flashToast(t('sync.overwriteFailedReq'), true);
          return;
        }
        if (!document.contains(modal)) return;
        const li = ob.closest('.lna-sync-item');
        if (li) li.remove();
        const left = ul.querySelectorAll('.lna-sync-item').length;
        const countEl = modal.querySelector('.lna-sync-conflicts-count');
        if (countEl) countEl.textContent = t('sync.itemsCount', { n: left });
        if (wrap && left === 0) wrap.hidden = true;
        flashToast(t('sync.overwrittenToast'));
        try {
          await loadDir(state.currentPath);
          renderFull(getActiveRoot());
        } catch (e) { /* 刷新失败不影响覆盖结果 */ }
      });
    }
  }

  // ---------- 排序胶囊 ----------
  function bindSortPill(root) {
    const trigger = root.querySelector('.lna-sort-trigger');
    if (!trigger || trigger.__lna_bound) return;
    trigger.__lna_bound = true;

    const valueEl = root.querySelector('.lna-sort-value');
    const dirBtn = root.querySelector('.lna-sort-dir');
    const arrow = root.querySelector('.lna-sort-arrow');

    function render() {
      valueEl.textContent = sortLabel(state.sortKey);
      const dirLabel = state.sortDir === 'asc' ? t('sort.dirAsc') : t('sort.dirDesc');
      dirBtn.setAttribute('aria-label', t('sort.dirAria', { dir: dirLabel }));
      dirBtn.setAttribute('title', dirLabel);
      arrow.setAttribute('d', state.sortDir === 'asc'
        ? 'M12 19V5M5 12l7-7 7 7'
        : 'M12 5v14M19 12l-7 7-7-7');
      renderAll(root);
    }

    function closeMenu() {
      trigger.setAttribute('aria-expanded', 'false');
      document.querySelectorAll('.lna-dd-mask, .lna-dd-menu').forEach((m) => m.remove());
    }

    function openMenu() {
      closeMenu();
      trigger.setAttribute('aria-expanded', 'true');
      const r = trigger.getBoundingClientRect();
      const mask = document.createElement('div');
      mask.className = 'lna-dd-mask';
      mask.addEventListener('click', closeMenu);
      document.body.appendChild(mask);
      const menu = document.createElement('div');
      menu.className = 'lna-dd-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', t('sort.menuAria'));
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.left = r.left + 'px';
      SORT_OPTIONS.forEach((o) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'lna-dd-item' + (o.value === state.sortKey ? ' selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', o.value === state.sortKey ? 'true' : 'false');
        item.innerHTML = `<span>${esc(sortLabel(o.value))}</span><span class="lna-dd-check" aria-hidden="true">✓</span>`;
        item.addEventListener('click', () => {
          state.sortKey = o.value;
          saveSettings(); // 记忆排序方式
          closeMenu();
          trigger.focus();
          render();
        });
        menu.appendChild(item);
      });
      document.body.appendChild(menu);

      // 键盘导航
      const items = Array.from(menu.querySelectorAll('.lna-dd-item'));
      const cur = items.findIndex((it) => it.getAttribute('aria-selected') === 'true');
      if (items[cur >= 0 ? cur : 0]) items[cur >= 0 ? cur : 0].focus();
      menu.addEventListener('keydown', (e) => {
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); trigger.focus(); }
        else if (e.key === 'Tab') { closeMenu(); }
      });
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      trigger.getAttribute('aria-expanded') === 'true' ? closeMenu() : openMenu();
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && trigger.getAttribute('aria-expanded') !== 'true') {
        e.preventDefault();
        openMenu();
      }
    });
    dirBtn.addEventListener('click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      saveSettings(); // 记忆升序/降序
      render();
    });
    render();
  }

  // ---------- 按钮行为 ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      flashToast(t('toast.copied', { text }));
    } catch (err) {
      flashToast(t('toast.copyFailed'));
    }
  }

  // ---------- 卡片设置（布局参考内置 sd_forge_lora 的用户元数据编辑页） ----------
  const SD_VERSIONS = ['SD1', 'SD2', 'SDXL', 'Flux', 'Unknown'];

  function metaTableHtml(table) {
    if (!table || !table.length) return '';
    const rows = table.map((r) => {
      const t = r.title ? ` title="${esc(r.title)}"` : '';
      return `<tr><th>${esc(r.label)}:</th><td${t}>${esc(r.value)}</td></tr>`;
    }).join('');
    return `<table class="file-metadata"><tbody>${rows}</tbody></table>`;
  }

  // 参考老插件 HighlightedText 的彩色标签：浅色底 + 深色文字，
  // 计数用同色系深底白字（两组配色对比度均满足无障碍要求）
  const TAG_PALETTE = [
    ['#fee2e2', '#991b1b'], ['#dcfce7', '#166534'], ['#dbeafe', '#1e40af'],
    ['#fef9c3', '#854d0e'], ['#f3e8ff', '#6b21a8'], ['#ccfbf1', '#115e59'],
    ['#ffedd5', '#9a3412'], ['#cffafe', '#155e75'], ['#ecfccb', '#3f6212'],
    ['#fce7f3', '#9d174d'],
  ];

  function tagsHtml(tags, tipText, opts) {
    if (!tags || !tags.length) return `<span class="lna-cf-empty">${t('cf.noTags')}</span>`;
    // plain=true：【将译文加入词典】弹窗专用，不下发彩色底，底色改由 CSS 按「是否已收录」统一分配
    const plain = !!(opts && opts.plain);
    return tags.map(([tag, cnt], i) => {
      const [bg, fg] = TAG_PALETTE[i % TAG_PALETTE.length];
      // .lna-tag-row 保持原有的「英文标签 + 计数」横排；.lna-tag-zh 为中文翻译（默认隐藏）
      const tip = tipText || t('cf.tagTipDefault');
      const style = plain ? '' : ` style="--lna-tag-bg:${bg};--lna-tag-count-bg:${fg}"`;
      return `<button class="lna-tag" type="button" data-tag="${esc(tag)}" aria-pressed="false" title="${esc(tip)}"${style}><span class="lna-tag-row"><span class="lna-tag-text">${esc(tag)}</span><span class="lna-tag-count">${esc(cnt)}</span></span><span class="lna-tag-zh"></span></button>`;
    }).join('');
  }

  // ---------- 训练标签的中文翻译 ----------
  // 译文只用于展示；点击标签写入提示词时始终使用英文原标签。
  // 有对照 → 显示译文；无对照 → 显示占位「未完成翻译」。
  function applyTagTranslations(body, map, merge) {
    // merge=true：与已有对照合并。只翻「未完成标签」时返回的 map 是子集，
    // 若整体替换会把其余已翻好的标签清成「未完成翻译」。
    const full = merge
      ? Object.assign({}, body.__lnaZhMap || {}, map || {})
      : Object.assign({}, map || {});
    body.__lnaZhMap = full;
    body.querySelectorAll('.lna-tag').forEach((btn) => {
      const span = btn.querySelector('.lna-tag-zh');
      if (!span) return;
      const zh = full[btn.dataset.tag];
      if (zh && zh !== btn.dataset.tag) {
        span.textContent = zh;
        btn.classList.add('has-zh');
        btn.classList.remove('no-zh');
      } else {
        // 无有效对照 → 标记为未完成，开关开启时由 CSS 显示「未完成翻译」占位
        span.textContent = '';
        btn.classList.remove('has-zh');
        btn.classList.add('no-zh');
      }
    });
    syncTagZhVisible(body);
  }

  function syncTagZhVisible(body) {
    const box = body.querySelector('.lna-cf-tags');
    if (box) box.classList.toggle('show-zh', !!state.showTagZh);
    body.querySelectorAll('.lna-zh-key').forEach((k) => {
      const on = (k.dataset.zh === '1') === !!state.showTagZh;
      k.classList.toggle('active', on);
      k.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // 翻译在途时禁用弹窗的关闭/取消/保存按钮：防止用户中途关窗后
  // 立刻打开另一张卡片再触发翻译，两个请求并发访问后端模型导致崩溃。
  // 注意：不能用原生 disabled——禁用按钮不派发 click，就无法提示用户。
  // 改用 aria-disabled + 视觉置灰，并在捕获阶段拦截点击弹红色轻提示。
  function setDlgBusy(body, busy) {
    const dlg = body.closest('.lna-dialog');
    if (!dlg) return;
    const btns = [dlg.querySelector('.dlg-close'),
      ...dlg.querySelectorAll('.dlg-footer .dlg-btn')];
    btns.forEach((b) => {
      if (!b) return;
      if (busy) {
        b.classList.add('lna-dlg-blocked');
        b.setAttribute('aria-disabled', 'true');
      } else {
        b.classList.remove('lna-dlg-blocked');
        b.removeAttribute('aria-disabled');
      }
    });
    if (busy && !dlg.__lnaBlockHandler) {
      const handler = (e) => {
        const b = e.target.closest('.dlg-close, .dlg-footer .dlg-btn');
        if (!b || !b.classList.contains('lna-dlg-blocked')) return;
        // 翻译在途：吞掉点击（含按钮自身的关闭/保存监听），只给提示
        e.preventDefault();
        e.stopPropagation();
        flashToast(t('toast.translating'), true);
      };
      dlg.__lnaBlockHandler = handler;
      dlg.addEventListener('click', handler, true); // 捕获阶段先于按钮监听执行
    } else if (!busy && dlg.__lnaBlockHandler) {
      dlg.removeEventListener('click', dlg.__lnaBlockHandler, true);
      dlg.__lnaBlockHandler = null;
    }
  }

  // 查询后端全局「翻译正在进行」标记（多浏览器标签页共享同一后端）
  async function zhStatusBusy() {
    try {
      const r = await fetch(API.translateStatus);
      const j = await r.json();
      return !!(j && j.ok && j.busy);
    } catch (e) { return false; }
  }

  // 轮询等待全局翻译空闲；弹窗被关闭则立即放弃。超时返回 false。
  async function zhWaitIdle(body, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (!document.contains(body)) return false;
      if (!(await zhStatusBusy())) return true;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return !(await zhStatusBusy());
  }

  // 拉取译文并写入标签（同一弹窗只取一次，除非强制刷新）；返回是否成功。
  // 已有在途请求时共享同一个 Promise 并等待其结果——重复发请求既浪费 LLM 推理，
  // 旧实现把「在途」误判为失败直接返回 false，导致按钮显示「翻译失败」。
  // waitIdle=true：先等其它标签页的翻译结束再发起（按钮显式触发用）；
  // waitIdle=false：全局正忙则本次静默跳过（弹窗自动补齐译文用，不阻塞用户操作）。
  async function loadTagTranslations(body, tags, force, rel, waitIdle) {
    if (body.__lnaZhPromise) {
      try { return await body.__lnaZhPromise; } catch (e) { return false; }
    }
    if (body.__lnaZhLoaded && !force) return true;
    const run = (async () => {
      // 自动补齐路径（非显式按钮）：全局正忙则直接跳过，不闪禁用态
      if (!waitIdle && await zhStatusBusy()) return false;
      setDlgBusy(body, true); // 覆盖「等待其它标签页空闲」阶段，期间禁止关闭/保存
      try {
        // 显式触发：先等其它标签页的翻译结束再发起自己的，避免并发
        if (waitIdle && !(await zhWaitIdle(body, 180000))) {
          if (document.contains(body)) flashToast(t('tag.translateTimeout'), true);
          return false;
        }
        let r = await fetch(API.translate, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // force：不吃后端模型缓存，重跑翻译流程并覆盖旧对照
          body: JSON.stringify({ tags, rel: rel || '', force: !!force }),
        });
        let res = await r.json();
        // 状态查询与提交之间仍可能有竞态（别的标签页抢先）：等空闲后重试一次
        if (res && res.busy) {
          if (!(await zhWaitIdle(body, 180000))) {
            if (document.contains(body)) flashToast(t('tag.translateTimeout'), true);
            return false;
          }
          r = await fetch(API.translate, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags, rel: rel || '', force: !!force }),
          });
          res = await r.json();
        }
        if (!r.ok) {
          flashToast(t('tag.translateHttpFailed', { code: r.status }));
          return false;
        }
        if (!res || !res.ok) {
          flashToast(t('tag.translateFailed', { msg: (res && res.error) || t('toast.unknownError') }));
          return false;
        }
        if (!document.contains(body)) return false; // 弹窗已关闭
        body.__lnaZhLoaded = true;
        body.__lnaZhNote = res.note || ''; // 模型无有效产出时的原因，供按钮提示
        applyTagTranslations(body, res.translations || {}, true); // 合并：子集翻译不清空其余对照
        return true;
      } catch (e) {
        flashToast(t('tag.translateFailedReq'));
        return false;
      } finally {
        body.__lnaZhPromise = null;
        if (document.contains(body)) setDlgBusy(body, false);
      }
    })();
    body.__lnaZhPromise = run;
    return run;
  }

  // ---------- 选择标签重新翻译（嵌套小弹窗） ----------
  // 复制一份训练标签供勾选：勾选态与触发词输入框完全独立，仅用于挑选要重翻的标签。
  // 确认后走主弹窗的 loadTagTranslations(force=true)：跳过缓存重翻并覆盖旧译文，
  // 全局忙碌排队、按钮忙碌态等状态管理均复用既有逻辑。
  function openRepickDialog(body, info, l) {
    if (document.querySelector('.lna-repick-mask')) return; // 已打开，忽略重复点击
    const zhMap = body.__lnaZhMap || {};
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-repick-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-repick-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.repickLabel'));
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.repickLabel')}<span class="lna-cf-hint">${t('tag.repickHint')}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh">${tagsHtml(info.tags, t('tag.pickRepickTag'))}</div>
        </div>
      </div>
      <div class="dlg-footer">
        <span class="lna-zh-time" role="status" aria-live="polite"></span>
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
        <button class="dlg-btn primary lna-zh-repick" data-act="repick" type="button"><span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-repick-label">${t('tag.confirmRepick')}</span></button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    // 初始译文：沿用主弹窗已持久化的对照，方便判断哪些标签需要重翻
    dlg.querySelectorAll('.lna-tag').forEach((btn) => {
      const span = btn.querySelector('.lna-tag-zh');
      const zh = zhMap[btn.dataset.tag];
      if (zh && zh !== btn.dataset.tag) { span.textContent = zh; btn.classList.add('has-zh'); }
      else btn.classList.add('no-zh');
    });

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    // 锁定模式：仅关闭按钮可关；翻译在途时由 setDlgBusy 拦截点击并提示
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    // 勾选切换：独立于触发词输入框，默认全部未选中
    dlg.querySelectorAll('.lna-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });

    const okBtn = dlg.querySelector('[data-act="repick"]');
    const spinner = okBtn.querySelector('.lna-spinner');
    const label = okBtn.querySelector('.lna-zh-repick-label');
    const timeEl = dlg.querySelector('.lna-zh-time');
    okBtn.addEventListener('click', async () => {
      if (okBtn.classList.contains('busy')) return; // 本按钮在途：禁止重复提交
      const tags = Array.from(dlg.querySelectorAll('.lna-tag.is-on')).map((el) => el.dataset.tag);
      if (!tags.length) { close(); return; } // 个数为 0：直接关闭，不进入翻译流程
      okBtn.classList.add('busy');
      spinner.hidden = false;
      label.textContent = t('tag.translatingDots');
      if (timeEl) { timeEl.textContent = ''; timeEl.classList.remove('is-err'); }
      setDlgBusy(dlg.querySelector('.dlg-body'), true); // 在途禁止关闭小弹窗
      const t0 = performance.now();
      const ok = await loadTagTranslations(body, tags, true, l.rel, true);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      refreshLlmState(); // 翻译会触发模型加载，立即刷新顶栏状态按钮
      if (closed || !document.contains(dlg)) return;
      okBtn.classList.remove('busy');
      spinner.hidden = true;
      label.textContent = t('tag.confirmRepick');
      setDlgBusy(dlg.querySelector('.dlg-body'), false);
      if (timeEl) {
        if (ok) timeEl.textContent = t('cf.lastTook', { secs });
        else { timeEl.textContent = t('cf.translateFailed'); timeEl.classList.add('is-err'); }
      }
      // 把主弹窗合并后的最新译文刷回小弹窗内的标签
      const map = body.__lnaZhMap || {};
      dlg.querySelectorAll('.lna-tag').forEach((btn) => {
        const span = btn.querySelector('.lna-tag-zh');
        const zh = map[btn.dataset.tag];
        if (zh && zh !== btn.dataset.tag) {
          span.textContent = zh;
          btn.classList.add('has-zh');
          btn.classList.remove('no-zh');
        } else {
          span.textContent = '';
          btn.classList.remove('has-zh');
          btn.classList.add('no-zh');
        }
      });
    });

    okBtn.focus();
  }

  // ---------- 将翻译对照添加到词典（嵌套小弹窗，标签单选） ----------
  // 结果区第一行（标签 + 当前译文）：【将译文加入词典】与【人工修正译文】两个小弹窗共用，
  // 保证两者布局一致、切换状态时高度不变（弹窗在遮罩里垂直居中，高度一变就会抖动）。
  function dictRowTagZh(tag, zh) {
    const zhText = zh || '';
    return `
        <div class="lna-dict-line">
          <div class="lna-dict-row"><span class="lna-dict-k">${t('tag.keyLabel')}</span><span class="lna-dict-v">${tag ? esc(tag) : `<em class="lna-dict-none">${t('tag.none')}</em>`}</span></div>
          <div class="lna-dict-row"><span class="lna-dict-k">${t('tag.currentZh')}</span><span class="lna-dict-v">${zhText ? esc(zhText) : `<em class="lna-dict-none">${t('tag.noZh')}</em>`}</span></div>
        </div>`;
  }

  // 译文归一化：折叠空白后比较，避免「短袖 」与「短袖」被判成不同
  function normZh(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  }

  // 【将译文加入词典】弹窗专用：把窗口内所有标签与词典全量比对并着色——
  //   已收录且与当前译文一致 → green（.is-matched）
  //   已收录但与当前译文不同 → 黄橙（.is-diff）
  //   未收录 → 红色（默认，即不加上述类）
  // 靠 .lna-dict-tags 限定作用域，仅本窗口生效；比对完成前保持中性灰，
  // 请求失败时不着色，避免误判成「全部未收录」。
  async function markDictMatches(root, zhMap) {
    const box = root.querySelector('.lna-dict-tags');
    if (!box) return;
    const btns = Array.from(box.querySelectorAll('.lna-tag'));
    if (!btns.length) return;
    try {
      const r = await fetch(API.dictCheck, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: btns.map((b) => b.dataset.tag) }),
      });
      const j = await r.json();
      if (!j || !j.ok || !j.dict || !document.contains(root)) return;
      btns.forEach((b) => {
        const d = j.dict[b.dataset.tag] || {};
        // 与弹窗内 has-zh 判定保持一致：译文等于标签本身时视为「无译文」
        const raw = zhMap && zhMap[b.dataset.tag];
        const cur = raw && raw !== b.dataset.tag ? normZh(raw) : '';
        const same = d.found && cur && normZh(d.value) === cur;
        b.classList.toggle('is-matched', !!same);
        b.classList.toggle('is-diff', !!d.found && !same);
      });
      box.classList.add('is-checked');
    } catch (e) { /* 比对失败：保持中性灰 */ }
  }

  // 单个标签写入词典成功后，就地把它改为「已收录且与译文一致」的绿色（仅本窗口）
  function markDictMatched(root, tag) {
    const box = root.querySelector('.lna-dict-tags');
    if (box) box.classList.add('is-checked');
    root.querySelectorAll('.lna-dict-tags .lna-tag').forEach((b) => {
      if (b.dataset.tag === tag) { b.classList.add('is-matched'); b.classList.remove('is-diff'); }
    });
  }

  // 选中标签后查询后端词典：命中 → 【替换词典译文】；未命中 → 【添加到词典】。
  // 写入内容 = 该标签在卡片里的当前译文（__lnaZhMap）；无译文时按钮禁用并提示先翻译。
  function openDictDialog(body, info) {
    if (document.querySelector('.lna-dict-mask')) return; // 已打开，忽略重复点击
    const zhMap = body.__lnaZhMap || {};
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-dict-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-repick-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.dictLabel'));
    // 结果区骨架：占位 / 查询中 / 结果三态共用同一结构，切换时高度不变，
    // 避免弹窗上下跳动（弹窗在遮罩里垂直居中，高度一变就会被重新居中）
    function dictSkeleton(tag, zh, matchHtml, btnLabel, canWrite) {
      return `${dictRowTagZh(tag, zh)}
        <div class="lna-dict-line">
          <div class="lna-dict-row"><span class="lna-dict-k">${t('tag.dictMatch')}</span><span class="lna-dict-v">${matchHtml}</span></div>
          <button class="dlg-btn primary lna-dict-save" type="button"${canWrite ? '' : ' aria-disabled="true"'}>${btnLabel}</button>
        </div>`;
    }
    // 未选择标签时的占位结果：与选中态同结构，按钮置灰不可写
    const emptyResultHtml = dictSkeleton('', '', `<em class="lna-dict-none">${t('tag.selectTagHint')}</em>`, t('tag.addToDict'), false);
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.dictLabel')}<span class="lna-cf-hint">${t('tag.dictHint')}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh lna-dict-tags">${tagsHtml(info.tags, t('tag.pickDictTag'), { plain: true })}</div>
        </div>
        <div class="lna-dict-result" role="status" aria-live="polite">${emptyResultHtml}
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    // 初始译文沿用主弹窗已持久化的对照
    dlg.querySelectorAll('.lna-tag').forEach((btn) => {
      const span = btn.querySelector('.lna-tag-zh');
      const zh = zhMap[btn.dataset.tag];
      if (zh && zh !== btn.dataset.tag) { span.textContent = zh; btn.classList.add('has-zh'); }
      else btn.classList.add('no-zh');
    });
    // 打开后全量比对词典：一致 → 绿、有差异 → 黄橙、未收录 → 红（仅本窗口）
    markDictMatches(dlg, zhMap);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const resultBox = dlg.querySelector('.lna-dict-result');
    let selected = '';
    let reqSeq = 0; // 查询序号：只渲染最后一次点击的结果，防慢响应覆盖新选择

    // 渲染结果区：found → 替换按钮；未收录 → 添加按钮；无译文 → 禁用提示
    function renderResult(tag, zh, lookup) {
      if (selected !== tag) return;
      const zhText = zh || '';
      if (!lookup || !lookup.ok) {
        resultBox.innerHTML = dictSkeleton(tag, zhText,
          `<span class="lna-dict-tip is-err">${t('tag.dictQueryFailed', { msg: (lookup && lookup.error) || t('tag.apiUnavailable') })}</span>`,
          t('tag.addToDict'), false);
        return;
      }
      const dictVal = lookup.dict_value || '';
      const canWrite = !!zhText;
      const btnLabel = lookup.found ? t('tag.replaceDict') : t('tag.addToDict');
      // 「词典匹配」行配色：已收录且与当前译文一致 → 绿；已收录但与译文不同 → 黄橙；未收录 → 红
      const same = !!zhText && normZh(zhText) === normZh(dictVal);
      const matchHtml = !lookup.found
        ? `<b class="lna-dict-miss">${t('tag.notInDict')}</b>`
        : `<span class="${same ? 'lna-dict-hit' : 'lna-dict-diff'}">${t('tag.inDictValue', { v: esc(dictVal) })}</span>`;
      // 两行布局：行1=标签+当前译文，行2=词典匹配+按钮（按钮固定右端，避免文案长短变化导致按钮跳动）
      resultBox.innerHTML = dictSkeleton(tag, zhText, matchHtml, btnLabel, canWrite);
      const saveBtn = resultBox.querySelector('.lna-dict-save');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          if (saveBtn.classList.contains('busy') || saveBtn.getAttribute('aria-disabled') === 'true') return;
          if (!canWrite) { flashToast(t('tag.noZhToWrite'), true); return; }
          saveBtn.classList.add('busy');
          const oldText = saveBtn.textContent;
          saveBtn.textContent = t('tag.writing');
          try {
            const r = await fetch(API.dictUpsert, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tag, value: zhText }),
            });
            const res = await r.json();
            if (res && res.ok) {
              flashToast(lookup.found ? t('tag.replacedDictToast', { tag }) : t('tag.addedDictToast', { tag }));
              markDictMatched(dlg, tag); // 写入成功 → 该标签样式更新为「已收录」绿色
              if (selected === tag) renderResult(tag, zhText, { ok: true, key: res.key, found: true, dict_value: res.value });
            } else {
              flashToast(t('tag.writeFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
              saveBtn.classList.remove('busy');
              saveBtn.textContent = oldText;
            }
          } catch (e) {
            flashToast(t('tag.writeFailedReq'), true);
            saveBtn.classList.remove('busy');
            saveBtn.textContent = oldText;
          }
        });
      }
    }

    // 单选：点击标签只保留一个选中态
    dlg.querySelectorAll('.lna-tag').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tag = btn.dataset.tag;
        dlg.querySelectorAll('.lna-tag.is-on').forEach((b) => {
          if (b !== btn) { b.classList.remove('is-on'); b.setAttribute('aria-pressed', 'false'); }
        });
        const on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (!on) {
          selected = '';
          resultBox.innerHTML = emptyResultHtml;
          return;
        }
        selected = tag;
        const seq = ++reqSeq;
        const zhText = zhMap[tag] && zhMap[tag] !== tag ? zhMap[tag] : '';
        // 查询中沿用同一骨架（仅「词典匹配」换文案），高度不变
        resultBox.innerHTML = dictSkeleton(tag, zhText, `<em class="lna-dict-none">${t('tag.queryingDict')}</em>`, t('tag.addToDict'), false);
        try {
          const r = await fetch(`${API.dictLookup}?tag=${encodeURIComponent(tag)}`);
          const res = await r.json();
          if (closed || seq !== reqSeq || !document.contains(dlg)) return;
          renderResult(tag, zhText, res);
        } catch (e) {
          if (closed || seq !== reqSeq || !document.contains(dlg)) return;
          resultBox.innerHTML = dictSkeleton(tag, zhText, `<span class="lna-dict-tip is-err">${t('tag.dictQueryFailedReq')}</span>`, t('tag.addToDict'), false);
        }
      });
    });

    dlg.querySelector('.dlg-close').focus();
  }

  // ---------- 人工修正译文（嵌套小弹窗，标签单选） ----------
  // 选中标签后在文本框里手工填写/修正中文译文；保存后写入该模型的镜像 JSON 与全局译文缓存。
  function openManualTranslateDialog(body, info, rel) {
    if (document.querySelector('.lna-manual-mask')) return; // 已打开，忽略重复点击
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-manual-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-repick-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.editZhLabel'));
    // 空态 / 选中态共用同一结构，只换文本与输入框，高度不变，弹窗不抖动
    function skeleton(tag, zh) {
      const on = !!tag;
      return `${dictRowTagZh(tag, on ? zh : '')}
        <div class="lna-dict-line">
          <span class="lna-dict-k">${t('tag.fixZh')}</span>
          <input class="lna-mt-input" type="text" placeholder="${esc(t('tag.fixZhPlaceholder'))}" aria-label="${esc(t('tag.fixZh'))}" value="${on ? esc(zh) : ''}"${on ? '' : ' disabled'}>
          <button class="dlg-btn lna-save-blue lna-dict-save" type="button"${on ? '' : ' aria-disabled="true"'}>${t('tag.modifyZh')}</button>
        </div>`;
    }
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.editZhLabel')}<span class="lna-cf-hint">${t('tag.manualHint')}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh">${tagsHtml(info.tags, t('tag.pickFixTag'))}</div>
        </div>
        <div class="lna-dict-result" role="status" aria-live="polite">${skeleton('', '')}
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    // 同步本弹窗标签区的译文（与主弹窗独立，applyTagTranslations 只管 body 里的标签）
    function syncDlgTags() {
      const map = body.__lnaZhMap || {};
      dlg.querySelectorAll('.lna-tag').forEach((btn) => {
        const span = btn.querySelector('.lna-tag-zh');
        if (!span) return;
        const zh = map[btn.dataset.tag];
        if (zh && zh !== btn.dataset.tag) {
          span.textContent = zh;
          btn.classList.add('has-zh');
          btn.classList.remove('no-zh');
        } else {
          span.textContent = '';
          btn.classList.remove('has-zh');
          btn.classList.add('no-zh');
        }
      });
    }
    // 初始译文沿用主弹窗已持久化的对照
    syncDlgTags();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const resultBox = dlg.querySelector('.lna-dict-result');
    let selected = '';

    // 取该标签已持久化的译文（与原文相同视为「未翻译」）
    function curZh(tag) {
      const v = (body.__lnaZhMap || {})[tag];
      return v && v !== tag ? v : '';
    }

    // 重绘结果区并绑定【修改译文】：输入框预填当前译文，便于在此基础上修正
    function render(tag) {
      resultBox.innerHTML = skeleton(tag, curZh(tag));
      const btn = resultBox.querySelector('.lna-dict-save');
      const input = resultBox.querySelector('.lna-mt-input');
      if (!btn || !input || !tag) return;
      btn.addEventListener('click', async () => {
        if (btn.classList.contains('busy')) return;
        const val = input.value.trim();
        if (!val) { flashToast(t('tag.needZh'), true); input.focus(); return; }
        btn.classList.add('busy');
        btn.textContent = t('tag.saving');
        try {
          const r = await fetch(API.tagTranslation, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rel: rel || '', tag, value: val }),
          });
          const res = await r.json();
          if (!document.contains(dlg)) return;
          if (res && res.ok) {
            applyTagTranslations(body, { [tag]: val }, true); // 卡片设置页的标签即时更新
            syncDlgTags();                                   // 本弹窗标签区的译文同步刷新
            flashToast(t('tag.fixedZhToast', { tag }));
            if (selected === tag) render(tag);                // 重绘：同步「当前译文」并复位按钮
          } else {
            flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
            btn.classList.remove('busy');
            btn.textContent = t('tag.modifyZh');
          }
        } catch (e) {
          if (!document.contains(dlg)) return;
          flashToast(t('toast.saveFailedReq'), true);
          btn.classList.remove('busy');
          btn.textContent = t('tag.modifyZh');
        }
      });
    }

    // 单选：点击标签只保留一个选中态
    dlg.querySelectorAll('.lna-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        dlg.querySelectorAll('.lna-tag.is-on').forEach((b) => {
          if (b !== btn) { b.classList.remove('is-on'); b.setAttribute('aria-pressed', 'false'); }
        });
        const on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        selected = on ? tag : '';
        render(selected);
        if (selected) resultBox.querySelector('.lna-mt-input').focus();
      });
    });

    dlg.querySelector('.dlg-close').focus();
  }

  // ---------- 查看模型所有标签（嵌套弹窗，列表 + 分页） ----------
  // 数据源：ss_tag_frequency 汇总后的完整标签（后端不截断，按出现次数降序）。
  // 四栏：序号 / 标签键（单词）/ 标签值（数字）/ 译文（默认留空，后续再接翻译功能）。
  function openAllTagsDialog(rel, mainBody) {
    if (document.querySelector('.lna-alltags-mask')) return; // 已打开，忽略重复点击
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-alltags-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-alltags-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.allTagsLabel'));
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.allTagsLabel')}<span class="lna-cf-hint">${t('cf.allTagsHint')}</span></span>
        <label class="lna-alltags-size-wrap">
          <span class="lna-alltags-size-label">${t('cf.allTagsSize')}</span>
          <select class="lna-alltags-size" aria-label="${esc(t('cf.allTagsSize'))}">
            <option value="20">20</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="all">${t('cf.allTagsSizeAll')}</option>
          </select>
        </label>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="dlg-loading" role="status" aria-live="polite">
          <span class="lna-spinner" aria-hidden="true"></span>${t('cf.allTagsLoading')}</div>
      </div>
      <div class="dlg-footer">
        <span class="lna-alltags-total" role="status" aria-live="polite"></span>
        <button class="dlg-btn dlg-action lna-alltags-translate" type="button" title="${esc(t('cf.allTagsTranslate'))}"><span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-alltags-translate-label">${t('cf.allTagsTranslate')}</span></button>
        <span class="lna-zh-time" role="status" aria-live="polite"></span>
        <div class="lna-alltags-pager">
          <button class="dlg-btn dlg-action lna-alltags-prev" type="button">${t('cf.allTagsPrev')}</button>
          <span class="lna-alltags-page">
            <span class="lna-alltags-page-pre"></span>
            <input class="lna-alltags-page-input" type="number" min="1" step="1" inputmode="numeric" title="${esc(t('cf.allTagsJump'))}" aria-label="${esc(t('cf.allTagsJump'))}" disabled>
            <span class="lna-alltags-page-post"></span>
          </span>
          <button class="dlg-btn dlg-action lna-alltags-next" type="button">${t('cf.allTagsNext')}</button>
        </div>
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const body = dlg.querySelector('.dlg-body');
    const totalEl = dlg.querySelector('.lna-alltags-total');
    const pagePre = dlg.querySelector('.lna-alltags-page-pre');
    const pagePost = dlg.querySelector('.lna-alltags-page-post');
    const pageInput = dlg.querySelector('.lna-alltags-page-input');
    const prevBtn = dlg.querySelector('.lna-alltags-prev');
    const nextBtn = dlg.querySelector('.lna-alltags-next');
    const sizeSelect = dlg.querySelector('.lna-alltags-size');
    // 页码模板在 {cur} 处切开：数字框插在中间，「第/Page/ページ … 页」等前后缀由语言包决定，
    // 这样各语言把页码放在哪一侧都正确，无需为「输入框」再新增一套键。
    const PAGE_TPL = t('cf.allTagsPage').split('{cur}');

    let tags = [];
    let page = 0;
    let pageSize = '50'; // 每页条数；'all' 表示全部显示在一页
    const zhMap = {};    // tag -> 中文译文（【翻译标签】按钮写入，第四列展示）
    const dictMap = {};  // tag -> { found, value }：词典收录情况，决定【加入词典】按钮配色
    const showMap = {};  // tag -> 'show'|'hide'：卡片设置标签池的显隐覆盖（缺省走默认规则）
    let tagLimit = 24;   // 默认显示上限（后端下发，未主动设置时的可见标签个数）
    let translating = false;

    function pageRows() {
      const n = pageSize === 'all' ? tags.length : Number(pageSize);
      return n > 0 ? n : 1;
    }
    function pages() { return Math.max(1, Math.ceil(tags.length / pageRows())); }

    function fillTpl(part, total) {
      return String(part || '').replace('{total}', String(total)).trim();
    }

    // 每行「标签词显示」的当前状态：有显式覆盖按覆盖，否则按默认规则（出现次数前 tagLimit 个显示）
    function isShown(tag, idx) {
      const ov = showMap[tag];
      return ov ? ov === 'show' : idx < tagLimit;
    }

    // 就地把某行的胶囊拨到目标状态（写入成功后调用，避免整表重绘）
    function applyShowToRow(tr, tag, idx) {
      const shown = isShown(tag, idx);
      tr.querySelectorAll('.lna-show-switch .lna-zh-key').forEach((b) => {
        const on = (b.dataset.show === '1') === shown;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function renderPage() {
      const total = pages();
      if (page > total - 1) page = total - 1;
      const size = pageRows();
      const start = page * size;
      const rows = tags.slice(start, start + size).map(([tag, cnt], i) => {
        const zh = zhMap[tag];
        const dcls = dictState(tag, zh);
        const shown = isShown(tag, start + i);
        return `
        <tr>
          <td class="lna-alltags-index">${start + i + 1}</td>
          <td class="lna-alltags-tag" data-tag="${esc(tag)}">${esc(tag)}</td>
          <td class="lna-alltags-count">${esc(cnt)}</td>
          <td class="lna-alltags-zh">${zh && zh !== tag ? esc(zh) : ''}</td>
          <td class="lna-alltags-show">
            <div class="lna-zh-switch lna-show-switch" role="group" aria-label="${esc(t('cf.allTagsShowHint', { n: tagLimit }))}">
              <button class="lna-zh-key${shown ? '' : ' active'}" type="button" data-show="0" aria-pressed="${shown ? 'false' : 'true'}">${t('cf.allTagsShowHide')}</button>
              <button class="lna-zh-key${shown ? ' active' : ''}" type="button" data-show="1" aria-pressed="${shown ? 'true' : 'false'}">${t('cf.allTagsShowShow')}</button>
            </div>
          </td>
          <td class="lna-alltags-actions">
            <button class="dlg-btn dlg-action lna-alltags-edit" type="button">${t('cf.allTagsEdit')}</button>
            <button class="dlg-btn dlg-action lna-alltags-dict${dcls ? ' ' + dcls : ''}" type="button">${t('cf.allTagsDict')}</button>
          </td>
        </tr>`;
      }).join('');
      body.innerHTML = `
        <div class="lna-alltags-wrap">
          <table class="lna-alltags">
            <thead><tr>
              <th>${t('cf.allTagsColIndex')}</th>
              <th>${t('cf.allTagsColTag')}</th>
              <th>${t('cf.allTagsColCount')}</th>
              <th>${t('cf.allTagsColZh')}</th>
              <th>${t('cf.allTagsColShow')}</th>
              <th>${t('cf.allTagsColActions')}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      totalEl.textContent = t('cf.allTagsTotal', { n: tags.length });
      totalEl.classList.remove('is-err');
      pagePre.textContent = fillTpl(PAGE_TPL[0], total);
      pagePost.textContent = fillTpl(PAGE_TPL[1], total);
      pageInput.value = String(page + 1);
      pageInput.max = String(total);
      pageInput.disabled = false;
      prevBtn.disabled = page <= 0;
      nextBtn.disabled = page >= total - 1;
    }

    function showEmpty(msg, isErr) {
      body.innerHTML = `<div class="dlg-empty">${esc(msg)}</div>`;
      totalEl.textContent = isErr ? msg : t('cf.allTagsTotal', { n: 0 });
      totalEl.classList.toggle('is-err', !!isErr);
      pagePre.textContent = '';
      pagePost.textContent = '';
      pageInput.value = '';
      pageInput.disabled = true;
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    }

    // 页码输入框：回车或失去焦点时跳页；越界（<1 或 >总页数）自动夹取到合法范围
    function commitPage() {
      if (pageInput.disabled) return;
      const total = pages();
      let n = parseInt(pageInput.value, 10);
      if (!isFinite(n)) { pageInput.value = String(page + 1); return; } // 非数字 → 还原当前页
      if (n < 1) n = 1;
      if (n > total) n = total;
      if (n - 1 !== page) { page = n - 1; renderPage(); }
      else pageInput.value = String(page + 1); // 值被夹取过时归位
    }
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitPage(); }
    });
    pageInput.addEventListener('blur', commitPage);

    // 切换每页条数：重置到第一页并重绘（无数据时仅改状态，不渲染空表）
    sizeSelect.addEventListener('change', () => {
      pageSize = sizeSelect.value;
      page = 0;
      if (tags.length) renderPage();
    });

    prevBtn.addEventListener('click', () => { if (page > 0) { page -= 1; renderPage(); } });
    nextBtn.addEventListener('click', () => { if (page < pages() - 1) { page += 1; renderPage(); } });

    // 【翻译标签】：只翻译「当前页」显示的标签，其余页不翻译。
    // 沿用全局「翻译方案」（与卡片设置弹窗共用同一后端模式，本弹窗不再放方案控件）。
    // 分批：每次请求最多 50 个标签（如某页 200 个 → 4 批），结果累积到 zhMap 后回填第四列。
    const TAGS_PER_BATCH = 50;
    const tsBtn = dlg.querySelector('.lna-alltags-translate');
    const tsSpinner = tsBtn.querySelector('.lna-spinner');
    const tsLabel = tsBtn.querySelector('.lna-alltags-translate-label');
    const tsTime = dlg.querySelector('.lna-zh-time');

    // 就地回填第四列（不整表重绘，避免滚动位置被弹回顶部）
    function applyZhToRows() {
      body.querySelectorAll('tbody tr').forEach((tr) => {
        const tagTd = tr.querySelector('.lna-alltags-tag');
        const zhTd = tr.querySelector('.lna-alltags-zh');
        if (!tagTd || !zhTd) return;
        const zh = zhMap[tagTd.dataset.tag];
        zhTd.textContent = zh && zh !== tagTd.dataset.tag ? zh : '';
      });
    }

    // 【加入词典】按钮配色状态：词典已收录且有译文 → 与当前译文一致为 is-matched(绿)、不同为 is-diff(黄)；
    // 未收录（或收录但无值）→ ''（灰白默认）。无当前译文时一律视为「有差异」。
    function dictState(tag, zh) {
      const d = dictMap[tag];
      if (!d || !d.found || !d.value) return '';
      const cur = zh && zh !== tag ? normZh(zh) : '';
      return (cur && normZh(d.value) === cur) ? 'is-matched' : 'is-diff';
    }

    // 就地刷新当前页按钮配色（批量匹配返回后调用，避免整表重绘）
    function applyDictToRows() {
      body.querySelectorAll('tbody tr').forEach((tr) => {
        const tagTd = tr.querySelector('.lna-alltags-tag');
        const btn = tr.querySelector('.lna-alltags-dict');
        if (!tagTd || !btn) return;
        const st = dictState(tagTd.dataset.tag, zhMap[tagTd.dataset.tag]);
        btn.classList.toggle('is-matched', st === 'is-matched');
        btn.classList.toggle('is-diff', st === 'is-diff');
      });
    }

    // 打开弹窗时批量匹配词典（一次请求全部标签）：决定【加入词典】按钮配色；失败则保持灰白
    async function loadDictStates() {
      try {
        const r = await fetch(API.dictCheck, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: tags.map((x) => x[0]) }),
        });
        const res = await r.json();
        if (closed || !document.contains(dlg) || !res || !res.ok || !res.dict) return;
        Object.assign(dictMap, res.dict);
        applyDictToRows();
      } catch (e) { /* 匹配失败：保持默认灰白配色 */ }
    }

    // 单批请求：撞上其它标签页正在翻译时，等全局空闲后重试一次；失败返回 null
    async function postTranslateBatch(batch) {
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: batch, rel: rel || '', force: false }),
      };
      let r = await fetch(API.translate, opts);
      let res = await r.json();
      if (res && res.busy) {
        if (!(await zhWaitIdle(body, 180000))) return null;
        r = await fetch(API.translate, opts);
        res = await r.json();
      }
      if (!r.ok || !res || !res.ok) return null;
      return res;
    }

    tsBtn.addEventListener('click', async () => {
      if (translating) return; // 本弹窗已在翻译
      if (!tags.length) { flashToast(t('cf.allTagsEmpty'), true); return; }
      // 只取当前页可见的标签
      const size = pageRows();
      const pageTags = tags.slice(page * size, page * size + size).map((x) => x[0]);
      if (!pageTags.length) { flashToast(t('cf.allTagsEmpty'), true); return; }
      if (await zhStatusBusy()) { flashToast(t('toast.translating'), true); return; } // 其它标签页在跑
      translating = true;
      tsBtn.classList.add('busy');
      tsSpinner.hidden = false;
      tsLabel.textContent = t('cf.translating');
      tsTime.textContent = '';
      tsTime.classList.remove('is-err');
      setDlgBusy(body, true); // 翻译在途：禁止关闭/翻页等操作
      const t0 = performance.now();
      let ok = true;
      try {
        if (!(await zhWaitIdle(body, 180000))) {
          ok = false; // 关闭弹窗或等待超时
        } else {
          for (let i = 0; i < pageTags.length; i += TAGS_PER_BATCH) {
            if (!document.contains(dlg)) { ok = false; break; }
            const batch = pageTags.slice(i, i + TAGS_PER_BATCH);
            const res = await postTranslateBatch(batch);
            if (!res) { ok = false; break; }
            Object.assign(zhMap, res.translations || {});
            applyZhToRows();
          }
        }
      } catch (e) {
        ok = false;
      }
      translating = false;
      if (!document.contains(dlg)) return; // 弹窗已被关闭
      tsBtn.classList.remove('busy');
      tsSpinner.hidden = true;
      tsLabel.textContent = t('cf.allTagsTranslate');
      setDlgBusy(body, false);
      refreshLlmState(); // 翻译可能触发模型加载，立即刷新顶栏状态按钮
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      tsTime.textContent = ok ? t('cf.lastTook', { secs }) : t('cf.translateFailed');
      tsTime.classList.toggle('is-err', !ok);
      if (!ok) flashToast(t('cf.translateFailed'), true);
    });

    // 操作列：行会随翻页重绘，用 body 级委托最稳。
    // 【修改译文】/【加入词典】都针对该行单个单词，各自弹出小窗。
    body.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.lna-alltags-edit');
      const dictBtn = e.target.closest('.lna-alltags-dict');
      if (!editBtn && !dictBtn) return;
      if (translating) { flashToast(t('toast.translating'), true); return; } // 翻译在途禁止并发操作
      const tr = e.target.closest('tr');
      const tagTd = tr && tr.querySelector('.lna-alltags-tag');
      const tag = tagTd ? tagTd.dataset.tag : '';
      if (!tag) return;
      if (editBtn) {
        // 改译后：译文列与词典配色都要重算（译文变化会影响「与词典一致/有差异」的判定）
        openAllTagsEditDialog(tag, rel, zhMap, mainBody, () => {
          applyZhToRows();
          applyDictToRows();
        });
      } else {
        openAllTagsDictDialog(tag, zhMap, () => {
          // 入库成功 → 该标签词典值即当前译文，按钮应变为绿色
          dictMap[tag] = { found: true, value: zhMap[tag] || '' };
          applyDictToRows();
        });
      }
    });

    // 「标签词显示」胶囊：写入该模型 JSON 的显隐覆盖表，并让卡片设置的标签池就地跟随。
    // 同样用 body 级委托（行会随翻页重绘）。写入期间禁用该行两个按钮，避免并发重复提交。
    body.addEventListener('click', async (e) => {
      const key = e.target.closest('.lna-show-switch .lna-zh-key');
      if (!key || key.disabled) return;
      const tr = key.closest('tr');
      const tagTd = tr && tr.querySelector('.lna-alltags-tag');
      const tag = tagTd ? tagTd.dataset.tag : '';
      if (!tag) return;
      const idx = tags.findIndex((x) => x[0] === tag);
      const show = key.dataset.show === '1';
      if (isShown(tag, idx) === show) return; // 已是目标状态，无需请求
      const keys = tr.querySelectorAll('.lna-show-switch .lna-zh-key');
      keys.forEach((b) => { b.disabled = true; });
      try {
        const r = await fetch(API.tagShow, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: rel || '', tag, show }),
        });
        const res = await r.json();
        if (!document.contains(dlg)) return; // 弹窗已关闭
        if (!res || !res.ok) {
          flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
          return;
        }
        // 与默认规则一致时不留覆盖（与后端保持同一口径）
        if (show === (idx < tagLimit)) delete showMap[tag];
        else showMap[tag] = show ? 'show' : 'hide';
        applyShowToRow(tr, tag, idx);
        // 卡片设置弹窗的标签池跟随刷新（可见列表由后端算好，可突破默认上限）
        if (mainBody && document.contains(mainBody) && mainBody.__lnaSetPoolTags) {
          mainBody.__lnaSetPoolTags(res.tags);
        }
      } catch (err) {
        if (document.contains(dlg)) {
          flashToast(t('toast.saveFailed', { msg: t('toast.unknownError') }), true);
        }
      } finally {
        if (document.contains(dlg)) keys.forEach((b) => { b.disabled = false; });
      }
    });

    (async () => {
      try {
        const r = await fetch(`${API.modelTags}?rel=${encodeURIComponent(rel)}`);
        const res = await r.json();
        if (closed || !document.contains(dlg)) return;
        if (!res || !res.ok) {
          showEmpty((res && res.error) || t('cf.allTagsLoadFailed'), true);
          return;
        }
        tags = Array.isArray(res.tags) ? res.tags : [];
        // 回显已持久化的译文（刷新后仍显示），与「翻译标签」写回同一份数据
        const tr = res.tag_translations || {};
        Object.keys(tr).forEach((k) => {
          if (tr[k] && tr[k] !== k) zhMap[k] = tr[k];
        });
        // 显隐覆盖表 + 默认上限：决定「标签词显示」胶囊的初始状态
        Object.assign(showMap, res.tag_show || {});
        if (Number(res.tag_limit) > 0) tagLimit = Number(res.tag_limit);
        if (!tags.length) { showEmpty(t('cf.allTagsEmpty'), false); return; }
        renderPage();
        loadDictStates(); // 异步批量匹配词典，决定【加入词典】按钮配色
      } catch (e) {
        if (closed || !document.contains(dlg)) return;
        showEmpty(t('cf.allTagsLoadFailed'), true);
      }
    })();

    dlg.querySelector('.dlg-close').focus();
  }

  // ---------- 查看所有标签：单标签【修改译文】弹窗 ----------
  // 只针对一个固定单词，无选择步骤；保存后写入该模型 JSON（持久化）+ 全局译文缓存。
  function openAllTagsEditDialog(tag, rel, zhMap, mainBody, onSaved) {
    if (document.querySelector('.lna-alltags-edit-mask')) return; // 已打开，忽略重复点击
    const curZh = zhMap[tag] && zhMap[tag] !== tag ? zhMap[tag] : '';
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-alltags-edit-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-repick-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.editZhLabel'));
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.editZhLabel')}<span class="lna-cf-hint">${t('tag.manualHint')}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-dict-result" role="status" aria-live="polite">
          ${dictRowTagZh(tag, curZh)}
          <div class="lna-dict-line">
            <span class="lna-dict-k">${t('tag.fixZh')}</span>
            <input class="lna-mt-input" type="text" placeholder="${esc(t('tag.fixZhPlaceholder'))}" aria-label="${esc(t('tag.fixZh'))}" value="${esc(curZh)}">
            <button class="dlg-btn lna-save-blue lna-dict-save" type="button">${t('tag.modifyZh')}</button>
          </div>
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const input = dlg.querySelector('.lna-mt-input');
    const saveBtn = dlg.querySelector('.lna-dict-save');
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.classList.contains('busy')) return;
      const val = input.value.trim();
      if (!val) { flashToast(t('tag.needZh'), true); input.focus(); return; }
      saveBtn.classList.add('busy');
      saveBtn.textContent = t('tag.saving');
      try {
        const r = await fetch(API.tagTranslation, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rel: rel || '', tag, value: val }),
        });
        const res = await r.json();
        if (!document.contains(dlg)) return;
        if (res && res.ok) {
          zhMap[tag] = val;
          // 卡片设置弹窗里的同一标签同步刷新（若该标签在其 24 个之内）
          if (mainBody && document.contains(mainBody)) applyTagTranslations(mainBody, { [tag]: val }, true);
          flashToast(t('tag.fixedZhToast', { tag }));
          if (onSaved) onSaved();
          close();
        } else {
          flashToast(t('tag.writeFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
          saveBtn.classList.remove('busy');
          saveBtn.textContent = t('tag.modifyZh');
        }
      } catch (e) {
        flashToast(t('tag.writeFailedReq'), true);
        saveBtn.classList.remove('busy');
        saveBtn.textContent = t('tag.modifyZh');
      }
    });
    input.focus();
  }

  // ---------- 查看所有标签：单标签【加入词典】弹窗 ----------
  // 针对一个固定单词：查询词典（已收录→替换 / 未收录→添加），写入内容取该标签当前译文。
  function openAllTagsDictDialog(tag, zhMap, onSaved) {
    if (document.querySelector('.lna-alltags-dict-mask')) return; // 已打开，忽略重复点击
    const zhText = zhMap[tag] && zhMap[tag] !== tag ? zhMap[tag] : '';
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask lna-modal-mask--nested lna-alltags-dict-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog lna-repick-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', t('cf.dictLabel'));
    // 查询中 / 结果两态共用同一骨架，切换时高度不变
    function skeleton(matchHtml, btnLabel, canWrite) {
      return `${dictRowTagZh(tag, zhText)}
        <div class="lna-dict-line">
          <div class="lna-dict-row"><span class="lna-dict-k">${t('tag.dictMatch')}</span><span class="lna-dict-v">${matchHtml}</span></div>
          <button class="dlg-btn primary lna-dict-save" type="button"${canWrite ? '' : ' aria-disabled="true"'}>${btnLabel}</button>
        </div>`;
    }
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">${t('cf.dictLabel')}<span class="lna-cf-hint">${t('tag.dictHint')}</span></span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-dict-result" role="status" aria-live="polite">
          ${skeleton(`<em class="lna-dict-none">${t('tag.queryingDict')}</em>`, t('tag.addToDict'), false)}
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('settings.close')}</button>
      </div>`;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });

    const resultBox = dlg.querySelector('.lna-dict-result');

    // found → 【替换词典译文】；未收录 → 【添加到词典】；无译文 → 置灰不可写
    function renderResult(lookup) {
      if (!lookup || !lookup.ok) {
        resultBox.innerHTML = skeleton(
          `<span class="lna-dict-tip is-err">${t('tag.dictQueryFailed', { msg: (lookup && lookup.error) || t('tag.apiUnavailable') })}</span>`,
          t('tag.addToDict'), false);
        return;
      }
      const dictVal = lookup.dict_value || '';
      const canWrite = !!zhText;
      const btnLabel = lookup.found ? t('tag.replaceDict') : t('tag.addToDict');
      const same = !!zhText && normZh(zhText) === normZh(dictVal);
      const matchHtml = !lookup.found
        ? `<b class="lna-dict-miss">${t('tag.notInDict')}</b>`
        : `<span class="${same ? 'lna-dict-hit' : 'lna-dict-diff'}">${t('tag.inDictValue', { v: esc(dictVal) })}</span>`;
      resultBox.innerHTML = skeleton(matchHtml, btnLabel, canWrite);
      const saveBtn = resultBox.querySelector('.lna-dict-save');
      if (!saveBtn) return;
      saveBtn.addEventListener('click', async () => {
        if (saveBtn.classList.contains('busy')) return;
        if (!canWrite) { flashToast(t('tag.noZhToWrite'), true); return; }
        saveBtn.classList.add('busy');
        const oldText = saveBtn.textContent;
        saveBtn.textContent = t('tag.writing');
        try {
          const r = await fetch(API.dictUpsert, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag, value: zhText }),
          });
          const res = await r.json();
          if (!document.contains(dlg)) return;
          if (res && res.ok) {
            flashToast(lookup.found ? t('tag.replacedDictToast', { tag }) : t('tag.addedDictToast', { tag }));
            if (onSaved) onSaved();
            renderResult({ ok: true, key: res.key, found: true, dict_value: res.value });
          } else {
            flashToast(t('tag.writeFailed', { msg: (res && res.error) || t('toast.unknownError') }), true);
            saveBtn.classList.remove('busy');
            saveBtn.textContent = oldText;
          }
        } catch (e) {
          flashToast(t('tag.writeFailedReq'), true);
          saveBtn.classList.remove('busy');
          saveBtn.textContent = oldText;
        }
      });
    }

    (async () => {
      try {
        const r = await fetch(`${API.dictLookup}?tag=${encodeURIComponent(tag)}`);
        const lookup = await r.json();
        if (closed || !document.contains(dlg)) return;
        renderResult(lookup);
      } catch (e) {
        if (closed || !document.contains(dlg)) return;
        renderResult(null);
      }
    })();

    dlg.querySelector('.dlg-close').focus();
  }

  // 参考内置实现：按标签词频随机抽词组成提示词
  function randomPromptFromTags(tags) {
    if (!tags || !tags.length) return '';
    const maxCount = tags[0][1];
    const picked = [];
    tags.forEach(([tag, count]) => {
      if (count > Math.random() * maxCount) {
        picked.push(String(tag).replace(/[(){}\[\]]/g, '\\$&'));
      }
    });
    return picked.sort().join(', ');
  }

  // 取当前输出图库中「选中的」生成图像（无选中则取最后一张，即最新生成），返回图片 src
  // 插件页是 Gradio Tab，会隐藏 Generation 面板，故直接按 id 取图库节点，不依赖可见性判断
  function pickGeneratedImageSrc() {
    const root = getActiveRoot();
    const tabitem = root ? root.closest('.tabitem') : null;
    const prefix = (tabitem && tabitem.id.indexOf('img2img') >= 0) ? 'img2img' : 'txt2img';
    const gal = document.getElementById(`${prefix}_gallery`);
    if (!gal) return null;
    const thumbs = gal.querySelectorAll('.thumbnail-item');
    if (!thumbs.length) return null;
    const thumb = gal.querySelector('.thumbnail-item.selected') || thumbs[thumbs.length - 1];
    const img = thumb.querySelector('img');
    return img && img.src ? img.src : null;
  }

  // 参考内置 sd_forge_lora 的「替换预览图像」：把输出图库中选中的生成图像存为该卡片预览图
  async function applyGeneratedPreview(endpoint, rel, scope, card) {
    const src = pickGeneratedImageSrc();
    if (!src) { flashToast(t('toast.noGeneratedImage')); return; }
    let blob = null;
    try {
      const rr = await fetch(src);
      blob = await rr.blob();
    } catch (e) {
      blob = null;
    }
    if (!blob || !blob.size) { flashToast(t('toast.readImageFailed')); return; }
    const fd = new FormData();
    fd.append('file', blob, 'preview.png');
    try {
      const r = await fetch(`${endpoint}?rel=${encodeURIComponent(rel)}`, { method: 'POST', body: fd });
      const res = await r.json();
      if (res && res.ok) {
        const pv = scope.querySelector('.lna-cf-preview');
        if (pv) {
          pv.classList.remove('is-empty');
          pv.style.backgroundImage = `url('${previewUrl(res.preview, res.preview_ver)}')`;
        }
        card.preview = res.preview;
        card.preview_ver = res.preview_ver;
        renderAll(); // 同步卡片缩略图/封面
        flashToast(t('cf.previewFromGenerated'));
      } else {
        flashToast(t('toast.replaceFailed', { msg: (res && res.error) || t('toast.unknownError') }));
      }
    } catch (e) {
      flashToast(t('toast.replaceFailedReq'));
    }
  }

  function cardFormHtml(info) {
    const u = info.user || {};
    const weight = Number(u.preferred_weight) || 0;
    const curVer = u.base_model || info.sd_version || 'Unknown';
    const hasTags = !!(info.tags && info.tags.length); // 未记录训练标签的模型不显示翻译功能按钮
    const coverStyle = info.preview
      ? ` style="background-image:url('${previewUrl(info.preview, info.preview_ver)}')"`
      : '';
    return `
    <div class="lna-card-form">
      <div class="lna-cf-top">
        <div class="lna-cf-top-main">
          <label class="lna-cf-field">
            <span class="lna-cf-label">${t('cf.description')}</span>
            <textarea class="lna-cf-input lna-cf-desc" rows="4">${esc(u.description || '')}</textarea>
          </label>
          ${metaTableHtml(info.table)}
          <div class="lna-cf-field">
            <span class="lna-cf-label">${t('cf.baseModel')}</span>
            <div class="lna-cf-radio">
              ${SD_VERSIONS.map((v) => `<label class="lna-cf-radio-item"><input type="radio" name="lna-sdver" value="${v}"${curVer === v ? ' checked' : ''}><span>${v}</span></label>`).join('')}
            </div>
          </div>
        </div>
        <div class="lna-cf-top-side">
          <div class="lna-cf-preview${info.preview ? '' : ' is-empty'}"${coverStyle}>
            <span class="lna-cf-preview-hint">${t('cf.previewHint')}</span>
          </div>
          <button class="dlg-btn dlg-action lna-cf-replace" type="button" data-act="replace">${t('cf.replacePreview')}</button>
          <button class="dlg-btn dlg-action lna-cf-use-gen" type="button" data-act="use-generated">${t('cf.useGenerated')}</button>
        </div>
      </div>
      <div class="lna-cf-field">
        <div class="lna-cf-tags-head">
          <span class="lna-cf-label lna-cf-tags-title">${t('cf.tagsTitle')}<span class="lna-cf-hint">${t('cf.tagsHint')}</span></span>
          ${hasTags ? `<button class="dlg-btn dlg-action lna-cf-tags-all" type="button" title="${esc(t('cf.allTagsHint'))}">${ICON.list}${t('cf.allTagsLabel')}</button>` : ''}
        </div>
        <div class="lna-cf-tags${state.showTagZh ? ' show-zh' : ''}">${tagsHtml(info.tags)}</div>
        ${hasTags ? `
        <div class="lna-cf-tags-actions">
          <div class="lna-zh-switch" role="group" aria-label="${esc(t('cf.zhGroupAria'))}">
            <button class="lna-zh-key${state.showTagZh ? '' : ' active'}" type="button" data-zh="0" aria-pressed="${state.showTagZh ? 'false' : 'true'}">${t('cf.zhHide')}</button>
            <button class="lna-zh-key${state.showTagZh ? ' active' : ''}" type="button" data-zh="1" aria-pressed="${state.showTagZh ? 'true' : 'false'}">${t('cf.zhShow')}</button>
          </div>
          ${modeGroupHtml()}
          <button class="dlg-btn dlg-action lna-cf-zh-all" type="button" title="${esc(t('cf.translateAllTitle'))}">${ICON.translateAll}<span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-all-label">${t('cf.translateAllLabel')}</span></button>
          <button class="dlg-btn dlg-action lna-cf-zh-missing" type="button" title="${esc(t('cf.translateMissingTitle'))}">${ICON.incomplete}<span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-missing-label">${t('cf.translateMissingLabel')}</span></button>
          <button class="dlg-btn dlg-action lna-cf-zh-pick" type="button" title="${esc(t('cf.repickTitle'))}">${ICON.retranslate}${t('cf.repickLabel')}</button>
          <button class="dlg-btn dlg-action lna-cf-zh-edit" type="button" title="${esc(t('cf.editZhTitle'))}">${ICON.editZh}${t('cf.editZhLabel')}</button>
          <button class="dlg-btn dlg-action lna-cf-dict" type="button" title="${esc(t('cf.dictTitle'))}">${ICON.addDict}${t('cf.dictLabel')}</button>
          <span class="lna-zh-time" role="status" aria-live="polite"></span>
        </div>` : ''}
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">${t('cf.activation')}<span class="lna-cf-hint">${t('cf.activationHint')}</span></span>
        <textarea class="lna-cf-input lna-cf-activation" rows="2">${esc(u.activation_text || '')}</textarea>
      </label>
      <div class="lna-cf-field">
        <span class="lna-cf-label">${t('cf.weight')}<span class="lna-cf-hint">${t('cf.weightHint')}</span></span>
        <div class="lna-cf-weight">
          <input type="range" class="lna-cf-weight-range" min="0" max="2" step="0.01" value="${weight}" aria-label="${esc(t('cf.weightRangeAria'))}">
          <input type="number" class="lna-cf-weight-num" min="0" max="2" step="0.01" value="${weight}" aria-label="${esc(t('cf.weightNumAria'))}">
        </div>
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">${t('cf.negative')}<span class="lna-cf-hint">${t('cf.negativeHint')}</span></span>
        <textarea class="lna-cf-input lna-cf-negative" rows="2">${esc(u.negative_text || '')}</textarea>
      </label>
      <div class="lna-cf-field">
        <span class="lna-cf-label">${t('cf.random')}</span>
        <div class="lna-cf-random-row">
          <textarea class="lna-cf-input lna-cf-random" rows="4" readonly></textarea>
          <button class="dlg-btn lna-cf-gen" type="button">${t('cf.gen')}</button>
        </div>
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">${t('cf.notes')}</span>
        <textarea class="lna-cf-input lna-cf-notes" rows="4">${esc(u.notes || '')}</textarea>
      </label>
    </div>`;
  }

  async function openLoraCardSettings(l) {
    // 记录「最近查看」
    try {
      await fetch(API.view, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: l.rel }),
      });
    } catch (e) {}

    let fileInput = null;
    const dlg = openModal({
      title: t('cf.title', { name: l.name }),
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>${t('cf.loadingCard')}</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('cf.cancel')}</button>
        <button class="dlg-btn primary" data-act="save" type="button">${t('settings.save')}</button>`,
      onOpen(modal) {
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => closeModal(modal));

        // 替换按钮在内容区、异步渲染后才出现，故用事件委托
        modal.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="replace"]')) {
            if (!fileInput) { flashToast(t('toast.cardLoading')); return; }
            fileInput.click();
            return;
          }
          if (e.target.closest('[data-act="use-generated"]')) {
            applyGeneratedPreview(API.preview, l.rel, modal, l);
          }
        });

        modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
          const desc = modal.querySelector('.lna-cf-desc');
          if (!desc) { flashToast(t('toast.cardLoading')); return; }
          const ver = modal.querySelector('input[name="lna-sdver"]:checked');
          const wNum = modal.querySelector('.lna-cf-weight-num');
          const payload = {
            rel: l.rel,
            description: desc.value,
            base_model: ver ? ver.value : 'Unknown',
            activation_text: (modal.querySelector('.lna-cf-activation') || { value: '' }).value,
            preferred_weight: parseFloat(wNum ? wNum.value : 0) || 0,
            negative_text: (modal.querySelector('.lna-cf-negative') || { value: '' }).value,
            notes: (modal.querySelector('.lna-cf-notes') || { value: '' }).value,
          };
          try {
            const r = await fetch(API.userMeta, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const res = await r.json();
            if (res && res.ok) { closeModal(modal); flashToast(t('toast.cardSaved')); }
            else flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }));
          } catch (e) {
            flashToast(t('toast.saveFailedReq'));
          }
        });
      },
    });

    const body = dlg.querySelector('.dlg-body');
    let info;
    try {
      const r = await fetch(`${API.cardInfo}?rel=${encodeURIComponent(l.rel)}`);
      info = await r.json();
    } catch (e) {
      info = { ok: false, error: t('toast.readReqFailed') };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭
    if (!info || !info.ok) {
      body.innerHTML = `<div class="dlg-empty">${esc((info && info.error) || t('cf.loadFailed'))}</div>`;
      return;
    }
    body.innerHTML = cardFormHtml(info);
    bindPreviewZoom(body, info.name || l.name);

    // 点标签 → 加入/移出触发词
    const act = body.querySelector('.lna-cf-activation');
    // 触发词文本框 → 词条数组：按逗号切分并逐项去首尾空白。
    // 不逐项去空白时，形如 " dildo riding, x" 的首项会带前导空格，与标签名对不上。
    function actWords() {
      return act.value.split(',').map((x) => x.trim()).filter(Boolean);
    }
    // 标签归一化：与后端 _normalize_tag 一致（去空白、转小写、空白→下划线）。
    // ss_tag_frequency 与触发词里常出现「下划线 / 空格」两种写法（如 open_mouth / open mouth），
    // 直接字符串比较会判成不同标签，导致标签不亮、且再次点击删不掉。
    function normTag(s) {
      return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '_');
    }
    // 按触发词输入框内容同步所有标签的选中态（手动输入/删除也能点亮/熄灭标签）
    function syncTagSelected() {
      const keys = new Set(actWords().map(normTag));
      body.querySelectorAll('.lna-tag').forEach((b) => {
        const on = keys.has(normTag(b.dataset.tag));
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    act.addEventListener('input', syncTagSelected);
    syncTagSelected(); // 打开弹窗时按已保存的触发词初始化选中态
    // 点标签 → 加入/移出触发词。标签池会随【标签词显示】开关重绘，故抽成函数，重绘后再绑一次。
    function bindPoolTagClicks() {
      body.querySelectorAll('.lna-tag').forEach((btn) => {
        if (btn.__lnaBound) return;
        btn.__lnaBound = true;
        btn.addEventListener('click', () => {
          const tag = btn.dataset.tag;
          const key = normTag(tag);
          const words = actWords();
          // 归一化比较：等价写法（下划线/空格、大小写、多空白）视为同一标签
          const kept = words.filter((w) => normTag(w) !== key);
          if (kept.length !== words.length) {
            act.value = kept.join(', ');             // 已存在 → 移出（连同重复项与异形写法一并清掉）
          } else {
            act.value = kept.concat(tag).join(', '); // 不存在 → 追加标签原文
          }
          syncTagSelected(); // 程序改 value 不触发 input 事件，手动同步
        });
      });
    }
    bindPoolTagClicks();

    // 「查看模型所有标签」里的【标签词显示】开关会改变标签池内容：由该弹窗经
    // body.__lnaSetPoolTags 回调重绘（可见列表由后端按覆盖表算好，可突破默认上限）。
    const tagsBox = body.querySelector('.lna-cf-tags');
    body.__lnaSetPoolTags = (list) => {
      info.tags = Array.isArray(list) ? list : [];
      if (!tagsBox) return;
      tagsBox.innerHTML = tagsHtml(info.tags);
      bindPoolTagClicks();
      syncTagSelected();                                // 重绘后恢复触发词的选中态
      applyTagTranslations(body, body.__lnaZhMap || {}); // 重绘后回填已持久化的译文
    };

    // 训练标签的中文翻译：连体胶囊开关（隐藏/显示）与批量翻译
    const zhKeys = body.querySelectorAll('.lna-zh-key');
    const zhAll = body.querySelector('.lna-cf-zh-all');
    const tagListNow = () => (info.tags || []).map((x) => x[0]); // 随标签池重绘实时变化
    // 打开弹窗只展示 JSON 里已持久化的对照（不发任何请求）；
    // 无对照的标签显示「未完成翻译」占位，翻译仅由【翻译所有标签】按钮显式触发
    applyTagTranslations(body, info.tag_translations || {});
    zhKeys.forEach((k) => {
      k.addEventListener('click', () => {
        const want = k.dataset.zh === '1';
        if (state.showTagZh === want) return;
        state.showTagZh = want;
        saveSettings();
        syncTagZhVisible(body); // 纯显示切换，不触发翻译
      });
    });
    // 翻译方案切换控件：与插件设置处的同名控件共享后端值，双向同步
    if (body.querySelector('.lna-mode-btn')) {
      bindModeSwitch(dlg);
      refreshTranslateMode(dlg);
    }
    // 翻译按钮通用流程：忙碌态 + 计时 + 完成后自动开启译文显示
    const zhTime = body.querySelector('.lna-zh-time');
    function bindZhButton(btn, labelSel, idleLabel, getTags, emptyMsg) {
      if (!btn) return;
      const spinner = btn.querySelector('.lna-spinner');
      const label = btn.querySelector(labelSel);
      btn.addEventListener('click', async () => {
        if (btn.classList.contains('busy')) return; // 本按钮翻译完成前保持忙碌态，防重复点击
        const actions = btn.closest('.lna-cf-tags-actions');
        if (actions && actions.querySelector('.dlg-btn.busy')) return; // 另一个翻译按钮正在跑
        const tags = getTags();
        if (!tags.length) { flashToast(emptyMsg); return; }
        // 先切忙碌样式：即使其它标签页正在翻译，也立即反馈「正在翻译标签中...」并排队等待
        btn.classList.add('busy');
        if (spinner) spinner.hidden = false;
        if (label) label.textContent = t('cf.translating');
        if (zhTime) { zhTime.textContent = ''; zhTime.classList.remove('is-err'); }
        const t0 = performance.now();
        const before = body.querySelectorAll('.lna-tag.has-zh').length;
        // waitIdle=true：检测全局「翻译正在进行」，存在则不并发、等其结束再执行
        const ok = await loadTagTranslations(body, tags, true, l.rel, true);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        refreshLlmState(); // 翻译会触发模型加载，立即刷新顶栏状态按钮
        if (!document.contains(body)) return; // 弹窗已关闭
        const added = body.querySelectorAll('.lna-tag.has-zh').length - before;
        btn.classList.remove('busy');
        if (spinner) spinner.hidden = true;
        if (label) label.textContent = idleLabel;
        if (ok) {
          // 翻译后自动开启显示，让用户直接看到结果
          if (!state.showTagZh) {
            state.showTagZh = true;
            saveSettings();
          }
          syncTagZhVisible(body);
          if (zhTime) {
            // 一条译文都没新增（模型跑了但没给出可用结果）→ 报出原因，不假装成功
            if (added <= 0 && body.__lnaZhNote) {
              zhTime.textContent = body.__lnaZhNote;
              zhTime.classList.add('is-err');
            } else {
              zhTime.textContent = t('cf.lastTook', { secs });
            }
          }
        } else if (zhTime) {
          zhTime.textContent = t('cf.translateFailed');
          zhTime.classList.add('is-err');
        }
      });
    }

    bindZhButton(zhAll, '.lna-zh-all-label', t('cf.translateAllLabel'),
      () => tagListNow(), t('cf.noTagsMsg'));
    // 只提交当前显示为「未完成翻译」的标签：词典/缓存已命中的不再重复送模型
    bindZhButton(body.querySelector('.lna-cf-zh-missing'), '.lna-zh-missing-label', t('cf.translateMissingLabel'),
      () => Array.from(body.querySelectorAll('.lna-tag.no-zh')).map((el) => el.dataset.tag),
      t('cf.noMissingMsg'));

    // 选择标签重新翻译：打开嵌套小弹窗勾选后重翻
    const zhPick = body.querySelector('.lna-cf-zh-pick');
    if (zhPick) {
      zhPick.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast(t('toast.translating'), true); return; }
        openRepickDialog(body, info, l);
      });
    }

    // 将翻译对照添加到词典：打开嵌套小弹窗单选标签后写入词典
    const dictBtn = body.querySelector('.lna-cf-dict');
    if (dictBtn) {
      dictBtn.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast(t('toast.translating'), true); return; }
        openDictDialog(body, info);
      });
    }

    // 人工修正译文：打开嵌套小弹窗单选标签后手工填写译文
    const editZhBtn = body.querySelector('.lna-cf-zh-edit');
    if (editZhBtn) {
      editZhBtn.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast(t('toast.translating'), true); return; }
        openManualTranslateDialog(body, info, l.rel);
      });
    }

    // 查看模型所有标签：打开嵌套弹窗，分页展示 ss_tag_frequency 完整标签
    const viewAllTagsBtn = body.querySelector('.lna-cf-tags-all');
    if (viewAllTagsBtn) {
      viewAllTagsBtn.addEventListener('click', () => openAllTagsDialog(l.rel, body));
    }

    // 权重滑块 ↔ 数字框
    const wRange = body.querySelector('.lna-cf-weight-range');
    const wNum = body.querySelector('.lna-cf-weight-num');
    if (wRange && wNum) {
      wRange.addEventListener('input', () => { wNum.value = wRange.value; });
      wNum.addEventListener('input', () => {
        const v = parseFloat(wNum.value);
        if (isFinite(v)) wRange.value = v;
      });
    }

    // 随机提示词
    const genBtn = body.querySelector('.lna-cf-gen');
    if (genBtn) {
      genBtn.addEventListener('click', () => {
        body.querySelector('.lna-cf-random').value = randomPromptFromTags(info.tags);
      });
    }

    // 隐藏的文件选择器：替换预览图
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await fetch(`${API.preview}?rel=${encodeURIComponent(l.rel)}`, { method: 'POST', body: fd });
        const res = await r.json();
        if (res && res.ok) {
          const pv = body.querySelector('.lna-cf-preview');
          if (pv) {
            pv.classList.remove('is-empty');
            pv.style.backgroundImage = `url('${previewUrl(res.preview, res.preview_ver)}')`;
          }
          l.preview = res.preview;
          l.preview_ver = res.preview_ver;
          renderAll(); // 同步卡片缩略图
          flashToast(t('cf.previewReplaced'));
        } else {
          flashToast(t('toast.replaceFailed', { msg: (res && res.error) || t('toast.unknownError') }));
        }
      } catch (e) {
        flashToast(t('toast.replaceFailedReq'));
      }
      fileInput.value = '';
    });
  }

  // ---------- 文件夹卡片设置 ----------
  function folderFormHtml(info) {
    const coverStyle = info.preview
      ? ` style="background-image:url('${previewUrl(info.preview, info.preview_ver)}')"`
      : '';
    return `
    <div class="lna-card-form">
      <div class="lna-cf-top">
        <div class="lna-cf-top-main">
          <label class="lna-cf-field">
            <span class="lna-cf-label">${t('cf.description')}</span>
            <textarea class="lna-cf-input lna-cf-desc" rows="4">${esc(info.description || '')}</textarea>
          </label>
          <dl class="lna-cf-info">
            <dt>${t('folder.name')}</dt><dd>${esc(info.name)}</dd>
            <dt>${t('folder.relPath')}</dt><dd>${esc(info.rel || t('folder.rootDir'))}</dd>
            <dt>${t('folder.count')}<span class="lna-cf-hint">${t('folder.countHint')}</span></dt><dd>${esc(String(info.count))}</dd>
          </dl>
        </div>
        <div class="lna-cf-top-side">
          <div class="lna-cf-preview${info.preview ? '' : ' is-empty'}"${coverStyle}>
            <span class="lna-cf-preview-hint">${t('cf.previewHint')}</span>
          </div>
          <button class="dlg-btn dlg-action lna-cf-replace" type="button" data-act="replace">${t('cf.replacePreview')}</button>
          <button class="dlg-btn dlg-action lna-cf-use-gen" type="button" data-act="use-generated">${t('cf.useGenerated')}</button>
          <button class="dlg-btn dlg-action lna-cf-open" type="button" data-act="open-folder">${t('folder.openPath')}</button>
        </div>
      </div>
    </div>`;
  }

  async function openFolderCardSettings(f) {
    let fileInput = null;
    const dlg = openModal({
      title: t('cf.title', { name: f.name }),
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>${t('folder.loading')}</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="cancel" type="button">${t('cf.cancel')}</button>
        <button class="dlg-btn primary" data-act="save" type="button">${t('settings.save')}</button>`,
      onOpen(modal) {
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => closeModal(modal));

        // 替换按钮/打开按钮在内容区、异步渲染后才出现，故用事件委托
        modal.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="replace"]')) {
            if (!fileInput) { flashToast(t('toast.folderLoading')); return; }
            fileInput.click();
            return;
          }
          if (e.target.closest('[data-act="use-generated"]')) {
            applyGeneratedPreview(API.folderPreview, f.rel, modal, f);
            return;
          }
          if (e.target.closest('[data-act="open-folder"]')) {
            fetch(API.openFolder, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rel: f.rel }),
            }).then((r) => r.json()).then((res) => {
              if (!res || !res.ok) flashToast(t('toast.openFailed', { msg: (res && res.error) || t('toast.unknownError') }));
            }).catch(() => flashToast(t('toast.openFailedReq')));
          }
        });

        modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
          const desc = modal.querySelector('.lna-cf-desc');
          if (!desc) { flashToast(t('toast.folderLoading')); return; }
          try {
            const r = await fetch(API.userMeta, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rel: f.rel, description: desc.value }),
            });
            const res = await r.json();
            if (res && res.ok) { closeModal(modal); flashToast(t('toast.folderSaved')); }
            else flashToast(t('toast.saveFailed', { msg: (res && res.error) || t('toast.unknownError') }));
          } catch (e) {
            flashToast(t('toast.saveFailedReq'));
          }
        });
      },
    });

    const body = dlg.querySelector('.dlg-body');
    let info;
    try {
      const r = await fetch(`${API.folderInfo}?rel=${encodeURIComponent(f.rel)}`);
      info = await r.json();
    } catch (e) {
      info = { ok: false, error: t('toast.readReqFailed') };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭
    if (!info || !info.ok) {
      body.innerHTML = `<div class="dlg-empty">${esc((info && info.error) || t('folder.loadFailed'))}</div>`;
      return;
    }
    body.innerHTML = folderFormHtml(info);
    bindPreviewZoom(body, info.name || f.name);

    // 隐藏的文件选择器：替换文件夹封面
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch(`${API.folderPreview}?rel=${encodeURIComponent(f.rel)}`, { method: 'POST', body: fd });
        const res = await r.json();
        if (res && res.ok) {
          const pv = body.querySelector('.lna-cf-preview');
          if (pv) {
            pv.classList.remove('is-empty');
            pv.style.backgroundImage = `url('${previewUrl(res.preview, res.preview_ver)}')`;
          }
          f.preview = res.preview;
          f.preview_ver = res.preview_ver;
          renderAll(); // 同步文件夹卡片封面
          flashToast(t('cf.previewReplaced'));
        } else {
          flashToast(t('toast.replaceFailed', { msg: (res && res.error) || t('toast.unknownError') }));
        }
      } catch (e) {
        flashToast(t('toast.replaceFailedReq'));
      }
      fileInput.value = '';
    });
  }

  // ---------- 内部元数据（safetensors __metadata__） ----------
  // 展示顺序参考内置 sd_forge_lora：常用字段靠前，标签词频靠后
  const META_ORDER = { ss_sd_model_name: 1, ss_resolution: 2, ss_clip_skip: 3, ss_num_train_images: 10, ss_tag_frequency: 20 };
  const META_VALUE_LIMIT = 4000;  // 单个值的最大展示字符数，超出截断
  const META_BOX_MIN = 300;       // 字符串超过此长度也放进滚动框，避免撑高弹窗

  function fmtMetaValue(v) {
    if (v === null || v === undefined) return '—';
    let text;
    if (typeof v === 'object') {
      text = JSON.stringify(v, null, 2);
    } else {
      const str = String(v);
      if (str === '') return '—';
      // 短文本直接展示，长文本/多行文本放进滚动框
      if (str.length <= META_BOX_MIN && !str.includes('\n')) return esc(str);
      text = str;
    }
    if (text.length > META_VALUE_LIMIT) text = text.slice(0, META_VALUE_LIMIT) + t('meta.truncated');
    return `<pre class="lna-meta-json">${esc(text)}</pre>`;
  }

  function renderMetaTable(meta) {
    const keys = Object.keys(meta || {});
    if (!keys.length) return `<div class="dlg-empty">${t('meta.empty')}</div>`;
    keys.sort((a, b) => (META_ORDER[a] || 999) - (META_ORDER[b] || 999)); // 稳定排序，其余保持原顺序
    const rows = keys.map((k) => `<dt>${esc(k)}</dt><dd>${fmtMetaValue(meta[k])}</dd>`).join('');
    return `<dl class="lna-meta-list">${rows}</dl>`;
  }

  async function openLoraMetadata(l) {
    const dlg = openModal({
      title: t('meta.title', { name: l.name }),
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>${t('meta.loading')}</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="close" type="button">${t('settings.close')}</button>`,
      onOpen(modal) {
        modal.querySelector('[data-act="close"]').addEventListener('click', () => closeModal(modal));
      },
    });
    const body = dlg.querySelector('.dlg-body');
    let res;
    try {
      const r = await fetch(`${API.metadata}?rel=${encodeURIComponent(l.rel)}`);
      res = await r.json();
    } catch (e) {
      res = { ok: false, error: t('toast.readReqFailed') };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭，丢弃结果
    body.innerHTML = res && res.ok
      ? renderMetaTable(res.metadata)
      : `<div class="dlg-empty">${esc((res && res.error) || t('meta.loadFailed'))}</div>`;
  }

  async function useLora(l) {
    let res = {};
    try {
      const r = await fetch(API.use, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rel: l.rel }),
      });
      res = await r.json();
    } catch (e) {}
    // 参考内置 ExtraNetworksPageLora：触发词（卡片资料优先，回退 .txt）随 <lora:..> 一起进正提示词；
    // 反向提示词进负提示词框；首选权重非 0 时写入权重
    const weight = (res.preferred_weight && res.preferred_weight > 0) ? res.preferred_weight : 1;
    const loraTag = `<lora:${l.name}:${weight}>`;
    const activation = (res.activation_text || '').trim() || (l.trigger || '').trim();
    const promptToAdd = activation ? `${loraTag} ${activation}` : loraTag;
    const negativeToAdd = (res.negative_text || '').trim();
    const root = getActiveRoot();
    const tabitem = root ? root.closest('.tabitem') : null;
    const isImg2Img = tabitem && tabitem.id.indexOf('img2img') >= 0;
    const prefix = isImg2Img ? 'img2img' : 'txt2img';
    appendToPromptBox(`#${prefix}_prompt`, promptToAdd);
    if (negativeToAdd) appendToPromptBox(`#${prefix}_neg_prompt`, negativeToAdd);
    const tabName = isImg2Img ? 'img2img' : 'txt2img';
    flashToast(negativeToAdd
      ? t('useLora.addedBoth', { name: l.name, tab: tabName })
      : t('useLora.addedPositive', { tab: tabName, name: l.name }));
  }

  function appendToPromptBox(selector, text) {
    const box = document.querySelector(selector);
    if (!box) {
      flashToast(t('toast.promptBoxNotFound'));
      return;
    }
    const ta = box.querySelector('textarea');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const cur = ta.value || '';
    let sep = '';
    if (cur) {
      if (cur.endsWith(',') || cur.endsWith('，')) sep = ' ';
      else if (cur.endsWith(' ')) sep = '';
      else sep = ', ';
    }
    setter.call(ta, cur + sep + text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- 删除 Lora 提示词（撤销【使用 Lora 提示词】加入的内容）----------
  // 与 useLora 同源：用同一份卡片资料重算「<lora:name:权重> 触发词」，
  // 优先整段精确移除（空白宽松匹配），失败则退化到按名字移除任意权重的 <lora:name:...> 标签。
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 收尾清理：折叠多余空格与连续逗号，去掉首尾遗留的分隔符
  function tidyPrompt(s) {
    return String(s)
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/(?:\s*,\s*){2,}/g, ', ')
      .replace(/^[\s,]+/, '')
      .replace(/[\s,]+$/, '');
  }

  // 以原生 setter 写回并派发 input/change，确保 Forge 侧能读到更新后的提示词
  function setPromptValue(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 标签归一化：折叠空白、转小写、剥掉外层权重括号，仅用于比对，不用于写回
  function normalizeTag(s) {
    return String(s)
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/^\((.*):[\d.]+\)$/, '$1')
      .trim();
  }

  // 按「整标签」精确删除：提示词按逗号（含全角）与换行切成 tag，命中目标集合就整段移除，
  // 并沿用原有分隔符重组。只做整 tag 比对，避免 "black thighhighs" 先被其中的
  // "thighhighs" 删成 "black" 这类顺序依赖造成的残留。
  function removeTagSetFrom(selector, targets, tagRe) {
    const box = document.querySelector(selector);
    const ta = box && box.querySelector('textarea');
    if (!ta) return false;
    const cur = ta.value || '';
    if (!cur) return false;
    const parts = cur.split(/([,，\n])/); // 捕获分隔符，重组时保留原有换行/逗号风格
    let hit = false;
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
      const seg = parts[i];
      const sep = parts[i + 1] || '';
      const t = normalizeTag(seg);
      if (t && (targets.has(t) || (tagRe && tagRe.test(seg.trim())))) {
        hit = true; // 连同其后面的分隔符一起丢弃
        continue;
      }
      out.push(seg + sep);
    }
    if (!hit) return false;
    setPromptValue(ta, tidyPrompt(out.join('')));
    return true;
  }

  // 从指定提示词框移除该 Lora 的提示词片段；返回是否有内容被移除。
  //   1) 删除任意权重的 <lora:名字:...> 标签（整 tag 匹配）；
  //   2) 把卡片「触发词」字段按逗号拆开，逐个作为整 tag 移除。
  function removeLoraPromptFrom(selector, name, activation) {
    const targets = new Set(
      String(activation || '').split(/[,，\n]/).map(normalizeTag).filter(Boolean)
    );
    const tagRe = new RegExp('^<lora:' + escapeRegExp(name) + ':[^>]*>$', 'i');
    return removeTagSetFrom(selector, targets, tagRe);
  }

  // 负提示词同样按整 tag 移除：文本可能包含多个逗号分隔的标签，逐段比对更稳妥
  function removeTextFromPrompt(selector, text) {
    const targets = new Set(
      String(text || '').split(/[,，\n]/).map(normalizeTag).filter(Boolean)
    );
    if (!targets.size) return false;
    return removeTagSetFrom(selector, targets, null);
  }

  async function removeLoraPrompt(l) {
    // 读卡片资料用只读的 card_info（不用会累加使用次数的 /use）
    let info = {};
    try {
      const r = await fetch(`${API.cardInfo}?rel=${encodeURIComponent(l.rel)}`);
      info = await r.json();
    } catch (e) {}
    const u = (info && info.user) || {};
    const activation = String(u.activation_text || '').trim() || String(l.trigger || '').trim();
    const negative = String(u.negative_text || '').trim();
    const root = getActiveRoot();
    const tabitem = root ? root.closest('.tabitem') : null;
    const isImg2Img = tabitem && tabitem.id.indexOf('img2img') >= 0;
    const tabName = isImg2Img ? 'img2img' : 'txt2img';
    let removed = removeLoraPromptFrom(`#${tabName}_prompt`, l.name, activation);
    if (negative) {
      removed = removeTextFromPrompt(`#${tabName}_neg_prompt`, negative) || removed;
    }
    if (!removed) { flashToast(t('card.delPromptNone'), true); return; }
    flashToast(t('card.delPromptDone', { tab: tabName }));
  }

  // ---------- 无障碍详情弹窗 ----------
  let lastFocused = null;

  function openModal({ title, bodyHtml, footerHtml, onOpen, locked }) {
    closeModal();
    lastFocused = document.activeElement;
    const mask = document.createElement('div');
    mask.className = 'lna-modal-mask';
    const dlg = document.createElement('div');
    dlg.className = 'lna-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'lna-dlg-title');
    dlg.innerHTML = `
      <header>
        <span class="dlg-title" id="lna-dlg-title">${esc(title)}</span>
        <button class="dlg-close" type="button" aria-label="${esc(t('common.closeDialog'))}">${ICON.close}</button>
      </header>
      <div class="dlg-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="dlg-footer">${footerHtml}</div>` : ''}
    `;
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    lockScroll(); // 禁止背景页面滚动
    setupDialogNav(dlg); // 设置类弹窗：header 生成分组导航并联动滚动高亮

    function close() { closeModal(); }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    if (!locked) {
      // locked 模式下点击遮罩不关闭，只能通过按钮关闭
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    }
    // Esc 关闭改由文档级监听统一处理（含 400ms 冷却，避免高频连点连续关窗），此处只保留焦点陷阱
    mask.__lnaClose = close; // 供文档级 Esc 关闭逻辑取用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') trapFocus(e, dlg, close);
    });
    if (onOpen) onOpen(dlg);

    const first = dlg.querySelector('.dlg-btn.primary, .dlg-btn, [data-act], .dlg-close');
    (first || dlg.querySelector('.dlg-close')).focus();
    return dlg;
  }

  // 设置类弹窗：header 生成分组导航；鼠标在内容区时以鼠标所在分组为准，
  // 其余情况按滚动位置判定，点击导航滚动到对应分组
  function setupDialogNav(dlg) {
    const body = dlg.querySelector('.dlg-body');
    const header = dlg.querySelector('header');
    if (!body || !header) return;
    const groups = Array.from(body.querySelectorAll('.lna-set-group'));
    if (groups.length < 2) return; // 少于两个分组时不显示导航，其余小弹窗不受影响
    const nav = document.createElement('nav');
    nav.className = 'dlg-nav';
    nav.setAttribute('aria-label', t('common.setNavAria'));
    const items = groups.map((g) => {
      const titleEl = g.querySelector('.lna-set-group-title');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlg-nav-item';
      b.textContent = titleEl ? titleEl.textContent.trim() : '';
      b.addEventListener('click', () => {
        // 用滚动容器的相对位置计算目标，避免 offsetTop 受定位祖先影响
        const delta = g.getBoundingClientRect().top - body.getBoundingClientRect().top;
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        body.scrollTo({ top: body.scrollTop + delta, behavior: reduced ? 'auto' : 'smooth' });
      });
      nav.appendChild(b);
      return b;
    });
    header.insertBefore(nav, header.querySelector('.dlg-close')); // 插到标题与关闭按钮之间

    let active = -1;
    let pointer = null; // 鼠标在内容区内的最近坐标（mouseover 时记录）；移出内容区后置空
    let rafId = 0;

    function sync() {
      // 一次读取所有分组矩形，鼠标判定与滚动判定共用，避免重复布局查询
      const bodyTop = body.getBoundingClientRect().top;
      const rects = groups.map((g) => g.getBoundingClientRect());
      // 1) 鼠标在内容区：以鼠标所在分组为准（坐标与矩形比较，无需命中测试；
      //    滚动使区块从指针下掠过时同样成立）
      let idx = -1;
      if (pointer) {
        idx = rects.findIndex((r) => pointer.x >= r.left && pointer.x < r.right
          && pointer.y >= r.top && pointer.y < r.bottom);
      }
      // 2) 无鼠标信息（键盘滚动、拖动滚动条、鼠标在内容区外）：取顶部已越过容器顶的最后一个分组
      if (idx < 0) {
        idx = 0;
        rects.forEach((r, i) => {
          if (r.top - bodyTop <= 1) idx = i;
        });
        // 已滚到底部时固定高亮最后一项（末组内容不足一屏时也能正确切换）
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) idx = groups.length - 1;
      }
      if (idx === active) return;
      active = idx;
      // 先清除列表里全部选中样式，再给目标项添加，保证任何时刻只有一项高亮
      items.forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-current', 'false');
      });
      items[idx].classList.add('is-active');
      items[idx].setAttribute('aria-current', 'true');
    }

    // 高频的 mouseover/scroll 合并到每帧最多一次判定
    function schedule() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; sync(); });
    }

    body.addEventListener('scroll', schedule, { passive: true });
    // mouseover 仅在跨越元素边界时触发，比 mousemove 省得多；坐标由事件直接提供，
    // 不再调用 elementFromPoint
    body.addEventListener('mouseover', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    });
    body.addEventListener('mouseleave', () => {
      pointer = null;
      schedule();
    });
    // 打开时不做初始判定（此时鼠标尚未进入内容区，几何兜底会先点亮第一项、随后
    // 又跳走）；等首次真实交互（鼠标进入内容区 / 滚动）后再高亮
  }

  function trapFocus(e, dlg, close) {
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(dlg.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // 弹窗打开时锁定页面滚动：fixed 蒙版只能挡点击，挡不住滚动
  // （滚轮会沿祖先链冒泡到 <html> 滚动容器），故直接禁用根元素滚动。
  let scrollLockCount = 0;
  let savedScrollStyle = null;

  function lockScroll() {
    if (scrollLockCount === 0) {
      const html = document.documentElement;
      const body = document.body;
      // 滚动条消失会让内容横向位移，用 padding 补偿
      const sbw = window.innerWidth - html.clientWidth;
      savedScrollStyle = {
        htmlOverflow: html.style.overflow,
        bodyOverflow: body.style.overflow,
        bodyPaddingRight: body.style.paddingRight,
      };
      html.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
      if (sbw > 0) {
        const cur = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
        body.style.paddingRight = (cur + sbw) + 'px';
      }
    }
    scrollLockCount++;
  }

  function unlockScroll() {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0 && savedScrollStyle) {
      const html = document.documentElement;
      const body = document.body;
      html.style.overflow = savedScrollStyle.htmlOverflow;
      body.style.overflow = savedScrollStyle.bodyOverflow;
      body.style.paddingRight = savedScrollStyle.bodyPaddingRight;
      savedScrollStyle = null;
    }
  }

  function closeModal(el) {
    // 主弹窗关闭时连带关闭嵌套小弹窗（重翻/词典/人工修正/数据对比/数据统一化/查看所有标签），避免残留蒙版
    document.querySelectorAll('.lna-repick-mask, .lna-dict-mask, .lna-cmp-mask, .lna-unify-mask, .lna-alltags-mask, .lna-alltags-edit-mask, .lna-alltags-dict-mask').forEach((m) => {
      m.remove();
      unlockScroll();
    });
    let mask = el;
    if (mask && !mask.classList.contains('lna-modal-mask')) {
      mask = mask.closest('.lna-modal-mask');
    }
    if (!mask) mask = document.querySelector('.lna-modal-mask');
    if (mask) {
      mask.remove();
      unlockScroll(); // 只有真的移除了蒙版才解除锁定，保证计数平衡
    }
    if (lastFocused && document.contains(lastFocused)) {
      try { lastFocused.focus(); } catch (e) {}
    }
    lastFocused = null;
  }

  // ---------- Esc 关闭弹窗 ----------
  // 文档级监听（捕获阶段）：无论焦点落在弹窗哪个位置都能收到 Esc。规则：
  //   1) 只关「最上层」弹窗——先关嵌套小弹窗，再关主弹窗；
  //   2) 关闭动作有 400ms 冷却，避免误触/高频连点把多层弹窗连着关光；
  //   3) 翻译在途（弹窗被置为忙碌态 .lna-dlg-blocked）时拒绝关闭，防止推理被中断。
  const ESC_CLOSE_COOLDOWN = 400;
  let escClosedAt = 0;

  function topEscDialog() {
    const nested = document.querySelectorAll('.lna-modal-mask--nested');
    if (nested.length) return nested[nested.length - 1]; // 后打开的排在 DOM 末尾，即最上层
    return document.querySelector('.lna-modal-mask:not(.lna-modal-mask--nested)');
  }

  function onDocumentEsc(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('.lna-lightbox')) return; // 大图预览在最上层，Esc 交给它自己处理
    const mask = topEscDialog();
    if (!mask) return; // 没开弹窗：交给其它 Esc 逻辑（如排序下拉）
    e.preventDefault();
    const closeBtn = mask.querySelector('.dlg-close');
    if (closeBtn && closeBtn.classList.contains('lna-dlg-blocked')) {
      flashToast(t('toast.translating'), true); // 与按钮拦截提示保持一致
      return;
    }
    const now = Date.now();
    if (now - escClosedAt < ESC_CLOSE_COOLDOWN) return; // 冷却期内忽略，防连点连续关窗
    escClosedAt = now;
    if (typeof mask.__lnaClose === 'function') mask.__lnaClose();
  }

  document.addEventListener('keydown', onDocumentEsc, true);

  // ---------- 大图预览（点击卡片封面打开） ----------
  // 交互：滚轮以光标为中心缩放；按住拖拽平移；WASD 键盘平移；Esc / 关闭按钮 / 点击图外关闭。
  function openLightbox(src, name) {
    if (document.querySelector('.lna-lightbox')) return; // 已打开则忽略重复点击
    const box = document.createElement('div');
    box.className = 'lna-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', t('lightbox.aria', { name }));
    box.innerHTML = `
      <div class="lna-lightbox-stage"><img class="lna-lightbox-img" src="${esc(src)}" alt="${esc(name)}" draggable="false"></div>
      <button class="lna-lightbox-close" type="button" aria-label="${esc(t('lightbox.closeAria'))}">${ICON.close}</button>
      <div class="lna-lightbox-hint" aria-hidden="true">${t('lightbox.hint')}</div>`;
    document.body.appendChild(box);
    lockScroll();
    const prevFocus = document.activeElement; // 关闭后把焦点还给预览图

    const stage = box.querySelector('.lna-lightbox-stage');
    const img = box.querySelector('.lna-lightbox-img');
    const MIN_SCALE = 0.2, MAX_SCALE = 12;
    let scale = 1, tx = 0, ty = 0;
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };

    // 以光标为中心缩放：让光标下的点在缩放前后停留在屏幕同一位置。
    // 图片经 flex 居中，其几何中心即 stage 中心，故位移按中心坐标换算。
    function zoomAt(mx, my, factor) {
      const s2 = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      if (s2 === scale) return;
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const k = s2 / scale;
      tx = (mx - cx) * (1 - k) + k * tx;
      ty = (my - cy) * (1 - k) + k * ty;
      scale = s2;
      apply();
    }

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    // 拖拽平移（指针事件统一处理鼠标 / 触屏 / 触控笔）
    let dragging = false, moved = false, sx = 0, sy = 0, stx = 0, sty = 0;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      box.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      tx = stx + (e.clientX - sx);
      ty = sty + (e.clientY - sy);
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
      apply();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
      box.classList.remove('is-dragging');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // 点击图片外的空白区域关闭（刚拖拽完的这次点击不算作“点击”）
    box.addEventListener('click', (e) => {
      if (moved || e.target.closest('.lna-lightbox-close')) return;
      const r = img.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) close();
    });

    // 键盘：WASD 平移（按住 Shift 加速），Esc 关闭
    const STEP = 32;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      const step = e.shiftKey ? STEP * 2.5 : STEP;
      const k = e.key.toLowerCase();
      if (k === 'w') ty -= step;
      else if (k === 's') ty += step;
      else if (k === 'a') tx -= step;
      else if (k === 'd') tx += step;
      else return;
      e.preventDefault();
      apply();
    }
    document.addEventListener('keydown', onKey, true);

    function close() {
      if (!document.contains(box)) return;
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      unlockScroll();
      if (prevFocus && document.contains(prevFocus)) {
        try { prevFocus.focus(); } catch (e) {}
      }
    }
    box.querySelector('.lna-lightbox-close').addEventListener('click', close);
    box.querySelector('.lna-lightbox-close').focus();
  }

  // 卡片设置弹窗右侧预览图：有图时可点击（或回车）打开大图预览。
  // 图片地址在点击时从元素当前的 background-image 读取，替换/重新生成预览图后依旧取到新图。
  function bindPreviewZoom(scope, name) {
    const pv = scope.querySelector('.lna-cf-preview');
    if (!pv) return;
    const open = () => {
      const m = /url\((['"]?)(.*?)\1\)/.exec(pv.style.backgroundImage || '');
      if (m && m[2]) openLightbox(m[2], name);
    };
    pv.addEventListener('click', open);
    if (pv.classList.contains('is-empty')) return; // 无预览图：保持纯占位，不设可聚焦/提示
    pv.setAttribute('role', 'button');
    pv.setAttribute('tabindex', '0');
    pv.setAttribute('aria-label', t('lightbox.aria', { name }));
    pv.title = t('lightbox.openTitle');
    pv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function flashToast(msg, isErr) {
    let t = document.querySelector('.lna-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'lna-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle('is-err', !!isErr); // 红色文字变体（用于阻止类提示）
    // 强制回流以重启动画
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); }, 2200);
  }

  // ---------- 启动 ----------
  async function init() {
    ensureLocalizationGuard(); // 尽早屏蔽 Forge 全局本地化对本插件节点的改写
    state.expandedFolders = loadExpandedFolders(); // 恢复已记忆的展开状态
    await loadI18n();     // 先取界面语言包，再渲染，避免首屏出现 key 文本
    await loadSettings(); // 恢复排序方式 / 插件设置开关（读插件目录的 ui_settings.json）
    await loadTree();
    await loadDir('');
    ensureMounted();      // 挂载到 Gradio 的页面容器（可能尚未注入，由轮询补齐）
    startMountWatch();    // 持续补齐：容器异步注入或被重渲染后自动重新挂载
    applyLayoutVars();
    updateStatsUI();
    startLlmStatePolling(); // 翻译模型状态按钮：首次刷新 + 定时轮询（自动卸载需轮询感知）
  }

  function waitAndInit() {
    if (document.getElementById('txt2img_extra_tabs') || document.getElementById('img2img_extra_tabs')) {
      init();
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', waitAndInit);
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.getElementById('txt2img_extra_tabs') || document.getElementById('img2img_extra_tabs')) {
        observer.disconnect();
        init();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndInit);
  } else {
    waitAndInit();
  }
})();
