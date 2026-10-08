/* ========== sd_forge_lora_new — 注入到 txt2img/img2img extra_tabs ==========
   无障碍要点：
   - 树节点/卡片可键盘聚焦与操作（Enter/Space）
   - 排序下拉为 role=listbox，支持上下键 + Escape
   - 详情弹窗为 role=dialog + aria-modal，含焦点陷阱，Esc 关闭并回焦
   - 悬停出现的按钮在 :focus-within 时同样可见（见 style.css）
   - Toast 使用 aria-live=polite 播报 */
(function () {
  const API = {
    tree: '/lora_new/api/tree',
    list: '/lora_new/api/list',
    search: '/lora_new/api/search',
    metadata: '/lora_new/api/metadata',
    cardInfo: '/lora_new/api/card_info',
    folderInfo: '/lora_new/api/folder_info',
    userMeta: '/lora_new/api/user_metadata',
    preview: '/lora_new/api/preview',
    folderPreview: '/lora_new/api/folder_preview',
    openFolder: '/lora_new/api/open_folder',
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
    tagTranslation: '/lora_new/api/tag_translation',
    uiSettings: '/lora_new/api/ui_settings',
  };

  const SORT_OPTIONS = [
    { value: 'name',        label: '文件名' },
    { value: 'created',     label: '创建日期' },
    { value: 'modified',    label: '修改日期' },
    { value: 'size',        label: '文件大小' },
    { value: 'usage_count', label: '使用次数' },
    { value: 'last_viewed', label: '最近查看' },
  ];

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
  const TRANS_MODES = [
    { v: 'dict', label: '仅用翻译词典' },
    { v: 'llm', label: '仅用模型翻译' },
    { v: 'hybrid', label: '使用混合翻译' },
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
  };

  // ---------- HTML 模板（用 class，不用 id） ----------
  const TAB_HTML = `
<div class="lna-root">
  <div class="lna-topbar" role="toolbar" aria-label="LoRA 管理器工具栏">
    <div class="lna-search-wrap">
      <svg class="lna-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
      <input class="lna-search" type="search" placeholder="搜索 LoRA 文件名..." aria-label="搜索 LoRA 文件名">
      <button class="lna-search-clear" type="button" aria-label="清除搜索内容" title="清除搜索内容" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
      </button>
    </div>
    <div class="pill-group pill-sm lna-sort">
      <span class="group-label" id="{UID}-sort-label">排序</span>
      <div class="base-dropdown">
        <button class="dd-trigger lna-sort-trigger" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{UID}-sort-label {UID}-sort-value">
          <span class="dd-value lna-sort-value" id="{UID}-sort-value">文件名</span>
          <span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></span>
        </button>
      </div>
      <button class="dir-btn lna-sort-dir" aria-label="排序方向：降序">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="lna-sort-arrow" d="M12 5v14M19 12l-7 7-7-7"></path></svg>
      </button>
    </div>
    <button class="lna-top-btn lna-refresh" aria-label="刷新：重新扫描磁盘">
      <svg class="lna-refresh-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      <span class="lna-refresh-label">刷新</span>
    </button>
    <button class="lna-top-btn lna-settings" aria-label="插件设置">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      <span>插件设置</span>
    </button>
    <button class="lna-top-btn lna-llm-state" type="button" aria-label="翻译模型状态" disabled>
      <span class="lna-llm-state-dot" aria-hidden="true"></span>
      <span class="lna-llm-state-text lna-llm-state-off">翻译模型未加载</span>
      <span class="lna-llm-state-text lna-llm-state-on">翻译模型已加载</span>
      <span class="lna-llm-state-text lna-llm-state-hover">卸载翻译模型</span>
    </button>
    <div class="lna-stats">
      <span class="lna-stat" title="LoRA 文件夹（含所有子文件夹）的模型总数">
        <span class="lna-stat-label">Lora模型总数</span>
        <span class="lna-stat-value lna-stat-count">—</span>
      </span>
      <span class="lna-stat" title="LoRA 文件夹（含所有子文件夹）的模型总大小">
        <span class="lna-stat-label">Lora模型总大小</span>
        <span class="lna-stat-value lna-stat-size">—</span>
      </span>
    </div>
  </div>
  <div class="lna-body">
    <aside class="lna-sidebar">
      <div class="lna-side-title" id="{UID}-tree-label">文件夹</div>
      <div class="lna-tree" role="tree" aria-labelledby="{UID}-tree-label"></div>
    </aside>
    <main class="lna-content">
      <nav class="lna-crumb" aria-label="面包屑导航"></nav>
      <div class="lna-grid" role="list" aria-label="LoRA 与文件夹列表"></div>
      <div class="lna-empty" role="status" style="display:none">此文件夹为空</div>
    </main>
  </div>
</div>`;

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
    mount.innerHTML = TAB_HTML.replace(/\{UID\}/g, 'lna' + (++uidCounter));
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
      flashToast('递归搜索接口不可用，请在页脚点击「重载 UI」后重试');
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
    const rootNode = makeTreeNode({ name: 'Lora (根)', rel: '', children: state.tree, count: state.rootCount, total: state.totalCount }, 0, true);
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
    const countTitle = recursive ? '该文件夹及所有子文件夹的模型数量' : '该文件夹直属的模型数量';
    const countAria = recursive
      ? `含子文件夹共 ${count} 个模型`
      : `直属模型 ${count} 个${hasChildren ? '，含子文件夹' : ''}`;

    const row = document.createElement('div');
    row.className = 'lna-tree-node' + (isExpanded ? ' expanded' : '');
    row.style.paddingLeft = (10 + depth * 14) + 'px';
    row.dataset.rel = node.rel || '';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-label', `${node.name}（文件夹，${countAria}）`);
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
      if (q) empty.textContent = '没有匹配的结果';
      // 隐藏了文件夹卡片且当前目录确实有子文件夹时，不要误报「为空」
      else if (!state.showFolderCards && state.folders.length > 0) empty.textContent = '文件夹卡片已隐藏，可在插件设置中开启';
      else empty.textContent = '此文件夹为空';
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
    el.setAttribute('aria-label', `文件夹：${f.name}，按 Enter 打开`);
    // 与 LoRA 卡一致：受「卡片图像预览」开关控制，关闭时隐藏封面层露出占位层
    const coverBg = state.showPreviews && f.preview ? `background-image:url('${previewUrl(f.preview, f.preview_ver)}')` : '';
    const coverStyle = coverBg + (state.showPreviews ? '' : 'display:none;');
    el.innerHTML = `
      <div class="lna-layer-base" aria-hidden="true">
        <div class="base-tag">文件夹</div>
        <div class="base-hint">暂无封面</div>
      </div>
      <div class="lna-layer-cover" style="${coverStyle}"></div>
      <div class="lna-layer-title">${esc(f.name)}</div>
      <div class="lna-card-actions">
        <button class="lna-icon-btn lna-copy" type="button" aria-label="复制文件夹路径：${esc(f.name)}" title="复制路径">${ICON.copy}</button>
        <button class="lna-icon-btn lna-cfg" type="button" aria-label="查看文件夹详情：${esc(f.name)}" title="卡片设置">${ICON.gear}<span>卡片</span></button>
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
    el.setAttribute('aria-label', `LoRA：${l.name}，大小 ${fmtSize(l.size)}，使用 ${l.usage_count} 次`);
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
        <div class="base-hint">暂无封面</div>
      </div>
      <div class="lna-layer-cover" style="${coverStyle}" role="img" aria-label="${esc(l.name)} 封面"></div>
      ${descHtml}
      <div class="lna-layer-title" title="${esc(l.name)}">${esc(l.name)}</div>
      <div class="lna-card-actions">
        <button class="lna-icon-btn lna-copy" type="button" aria-label="复制 LoRA 路径：${esc(l.name)}" title="复制路径">${ICON.copy}</button>
        <button class="lna-icon-btn lna-meta" type="button" aria-label="查看内部元数据：${esc(l.name)}" title="查看内部元数据">${ICON.info}</button>
        <button class="lna-icon-btn lna-cfg" type="button" aria-label="查看 LoRA 详情：${esc(l.name)}" title="卡片设置">${ICON.gear}<span>卡片</span></button>
      </div>
      <button class="lna-use-btn" type="button" aria-label="将 ${esc(l.name)} 的触发词添加到正提示词框、反向提示词添加到负提示词框">使用 Lora 提示词</button>
    `;
    el.querySelector('.lna-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyText((state.root || '') + '\\' + l.rel);
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
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.target.closest('button')) {
        e.preventDefault();
        openLoraCardSettings(l);
      }
    });
    return el;
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
          label.textContent = '刷新中...';
          label.classList.add('busy');
        }
        refresh.setAttribute('aria-busy', 'true');

        try {
          await loadTree();
          await loadDir(state.currentPath);
          renderFull(getActiveRoot());
          flashToast('已重新扫描');
        } finally {
          // 至少播完一圈动画再恢复文字（减弱动效时不等待）
          const wait = reduced ? 0 : Math.max(0, MIN_DUR - (performance.now() - t0));
          await new Promise((r) => setTimeout(r, wait));
          if (label) {
            label.classList.remove('busy'); // max-width 平滑收缩
            setTimeout(() => {
              if (!refresh.__lna_busy) label.textContent = '刷新'; // 期间若再次点击则不覆盖
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
          title: '插件设置',
          locked: true, // 仅可通过「关闭」按钮关闭，防止误触
          bodyHtml: `<div class="lna-set-group">
              <div class="lna-set-group-title">插件显示设置</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">树状文件夹菜单宽度</span>
                  <span class="lna-switch-desc">单位 px，范围 ${SIDEBAR_MIN}–${SIDEBAR_MAX}，点击「保存」后生效。</span>
                </span>
                <div class="lna-inline-group">
                  <input type="number" class="lna-size-input lna-sidebar-input" min="${SIDEBAR_MIN}" max="${SIDEBAR_MAX}" step="1" value="${state.sidebarWidth}" aria-label="树状文件夹菜单宽度（px）">
                  <button class="dlg-btn primary lna-sidebar-save" type="button">保存</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">内容区高度</span>
                  <span class="lna-switch-desc">调整左侧文件夹树与右侧 LoRA 卡片区容器的高度，单位 px，范围 ${BODY_H_MIN}–${BODY_H_MAX}，点击「保存」后生效。</span>
                </span>
                <div class="lna-inline-group">
                  <input type="number" class="lna-size-input lna-body-input" min="${BODY_H_MIN}" max="${BODY_H_MAX}" step="1" value="${state.bodyHeight}" aria-label="内容区高度（px）">
                  <button class="dlg-btn primary lna-body-save" type="button">保存</button>
                </div>
              </div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">文件夹卡片显示</span>
                  <span class="lna-switch-desc">关闭后，卡片列表不再显示文件夹卡片（左侧文件夹树仍可正常导航）。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showFolderCards" ${state.showFolderCards ? 'checked' : ''} aria-label="文件夹卡片显示">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">卡片图像预览</span>
                  <span class="lna-switch-desc">关闭后，即使卡片存在预览图也不引用，改为显示「暂无封面」占位。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showPreviews" ${state.showPreviews ? 'checked' : ''} aria-label="卡片图像预览">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">显示文件夹下所有模型</span>
                  <span class="lna-switch-desc">开启后无需搜索，卡片列表直接递归显示当前路径下所有子文件夹里的模型。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="showAllModels" ${state.showAllModels ? 'checked' : ''} aria-label="显示文件夹下所有模型">
              </label>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">搜索设置</div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">搜索子文件夹</span>
                  <span class="lna-switch-desc">开启后，搜索范围包含当前路径下的所有子文件夹（递归）。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="searchSubfolders" ${state.searchSubfolders ? 'checked' : ''} aria-label="搜索子文件夹">
              </label>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">只搜索 LoRA 模型</span>
                  <span class="lna-switch-desc">开启后，搜索结果只显示模型文件，不含文件夹卡片。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="onlyLora" ${state.onlyLora ? 'checked' : ''} aria-label="只搜索 LoRA 模型">
              </label>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">卡片样式调整</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">比例预设</span>
                  <span class="lna-switch-desc">按所选比例调整高度，宽度保持当前值不变。</span>
                </span>
                <div class="lna-ratio-group" role="group" aria-label="卡片比例预设">
                  ${CARD_RATIOS.map((r) => `<button class="lna-ratio-btn" type="button" data-ratio="${r.label}" aria-pressed="false">${r.label}</button>`).join('')}
                </div>
              </div>
              <label class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">锁定比例</span>
                  <span class="lna-switch-desc">开启后，修改宽度或高度时另一项按当前比例自动联动。</span>
                </span>
                <input type="checkbox" class="lna-switch" data-set="lockRatio" ${state.lockRatio ? 'checked' : ''} aria-label="锁定比例">
              </label>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">卡片尺寸</span>
                  <span class="lna-switch-desc">单位 px，范围 ${CARD_SIZE_MIN}–${CARD_SIZE_MAX}。</span>
                </span>
                <div class="lna-size-group">
                  <label class="lna-size-field">宽
                    <input type="number" class="lna-size-input" data-size="w" min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="1" value="${state.cardWidth}" aria-label="卡片宽度（px）">
                  </label>
                  <label class="lna-size-field">高
                    <input type="number" class="lna-size-input" data-size="h" min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="1" value="${state.cardHeight}" aria-label="卡片高度（px）">
                  </label>
                </div>
              </div>
            </div>
            <div class="lna-set-group">
              <div class="lna-set-group-title">标签翻译设置</div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">翻译方案</span>
                  <span class="lna-switch-desc">混合翻译：先查内置翻译词典，未收录的标签再用 GGUF 模型翻译；仅用翻译词典则不调用模型，未收录的标签显示「未完成翻译」。</span>
                </span>
                <div class="lna-mode-group" role="group" aria-label="标签翻译方案">
                  ${TRANS_MODES.map((x) => `<button class="lna-mode-btn${x.v === TRANS_MODE_DEFAULT ? ' active' : ''}" type="button" data-mode="${x.v}" aria-pressed="${x.v === TRANS_MODE_DEFAULT ? 'true' : 'false'}">${x.label}</button>`).join('')}
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">llama_cpp 模型</span>
                  <span class="lna-switch-desc">训练标签优先由所选 GGUF 模型翻译；模型未选择或加载失败时自动回退到内置词典。</span>
                </span>
                <div class="lna-inline-group">
                  <button class="dlg-btn lna-llm-open-folder" type="button" title="在资源管理器中打开模型所在的文件夹">打开模型文件夹</button>
                  <select class="lna-llm-select" aria-label="选择用于标签翻译的 GGUF 模型">
                    <option value="">（不使用 GGUF，仅用词典）</option>
                  </select>
                  <button class="dlg-btn lna-llm-refresh" type="button" title="重新扫描 models/LLM 目录">刷新</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">推理设备</span>
                  <span class="lna-switch-desc">CPU 不占显存、与出图互不干扰；GPU 翻译更快（约 10 秒内），但模型常驻显存（约 2.5GB），显存不足时会自动降级 CPU。</span>
                </span>
                <div class="lna-zh-switch lna-device-switch" role="group" aria-label="翻译推理设备">
                  <button class="lna-zh-key active" type="button" data-dev="cpu" aria-pressed="true">CPU</button>
                  <button class="lna-zh-key" type="button" data-dev="gpu" aria-pressed="false">GPU</button>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">翻译运行环境</span>
                  <span class="lna-switch-desc">CPU 版随插件离线安装，开箱即可用。需要 GPU 加速时在此下载 CUDA 版（约 490MB）：下载完成后重启 WebUI 会自动安装并生效。CUDA 版自带 CPU 后端，显存不足时仍会回退 CPU。</span>
                </span>
                <div class="lna-llm-dl">
                  <div class="lna-llm-dl-row">
                    <span class="lna-runtime-state" role="status" aria-live="polite">读取中…</span>
                  </div>
                  <div class="lna-llm-dl-row">
                    <button class="dlg-btn dlg-action lna-runtime-install" type="button">安装 CUDA 版本，使用 GPU 推理</button>
                  </div>
                  <div class="lna-llm-progress lna-runtime-progress" role="status" aria-live="polite" hidden></div>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">空闲时自动卸载模型</span>
                  <span class="lna-switch-desc">翻译完成后超过设定时长无新翻译，自动释放模型占用的显存/内存；下次翻译会重新加载（GPU 需几秒）。范围 ${IDLE_MIN}–${IDLE_MAX} 分钟。</span>
                </span>
                <div class="lna-inline-group">
                  <div class="lna-zh-switch lna-idle-switch" role="group" aria-label="空闲时自动卸载模型">
                    <button class="lna-zh-key" type="button" data-idle="0" aria-pressed="false">永不卸载模型</button>
                    <button class="lna-zh-key active" type="button" data-idle="1" aria-pressed="true">计时自动卸载</button>
                  </div>
                  <label class="lna-size-field">空闲
                    <input type="number" class="lna-size-input lna-idle-minutes" min="${IDLE_MIN}" max="${IDLE_MAX}" step="1" value="${IDLE_DEFAULT}" aria-label="空闲卸载时长（分钟）">
                  </label>
                  <span class="lna-idle-unit">分钟</span>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">下载 GGUF 模型</span>
                  <span class="lna-switch-desc">可填 HF 仓库 ID 或链接。会自动探测网络：官方站优先，超时或失败则改用 hf-mirror 镜像。</span>
                </span>
                <div class="lna-llm-dl">
                  <div class="lna-llm-dl-row">
                    <input type="text" class="lna-cf-input lna-llm-repo" value="${LLM_PRESET_REPO}" aria-label="模型下载仓库或链接" spellcheck="false">
                    <button class="dlg-btn dlg-action lna-llm-detect" type="button" title="读取该仓库中可用的 GGUF 文件">检测</button>
                  </div>
                  <div class="lna-llm-dl-row">
                    <select class="lna-llm-file" aria-label="选择要下载的 GGUF 文件">
                      <option value="">— 点「检测」读取可选文件 —</option>
                    </select>
                    <button class="dlg-btn primary lna-llm-download" type="button" title="下载所选模型到 LLM 目录">下载</button>
                  </div>
                  <div class="lna-llm-progress" role="status" aria-live="polite" hidden></div>
                </div>
              </div>
              <div class="lna-switch-row">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">翻译提示预设</span>
                  <span class="lna-switch-desc">模型翻译使用的提示词。切换下拉框立即生效；「默认」为内置内容，不可覆盖或删除。</span>
                </span>
                <div class="lna-inline-group">
                  <select class="lna-prompt-select" aria-label="选择翻译提示预设"></select>
                  <button class="dlg-btn lna-prompt-delete" type="button" title="删除当前选中的预设">删除预设</button>
                </div>
              </div>
              <div class="lna-switch-row lna-no-sep">
                <span class="lna-switch-text">
                  <span class="lna-switch-name">预设名称</span>
                  <span class="lna-switch-desc">保存时使用的预设名。与已有预设同名则覆盖，最长 ${PROMPT_NAME_MAX} 个字符。</span>
                </span>
                <div class="lna-inline-group">
                  <input type="text" class="lna-cf-input lna-prompt-name" maxlength="${PROMPT_NAME_MAX}" placeholder="例如：更口语化的译法" aria-label="预设名称" spellcheck="false">
                  <button class="dlg-btn primary lna-prompt-save" type="button" title="保存当前提示文本为新预设">保存预设</button>
                </div>
              </div>
              <div class="lna-prompt-editor">
                <div class="lna-prompt-editor-head">
                  <span class="lna-switch-name">预设提示文本</span>
                  <span class="lna-switch-desc">必须包含 <code>{tags}</code> 占位符，翻译时会被替换为待翻译的标签列表。</span>
                </div>
                <textarea class="lna-cf-input lna-prompt-text" rows="7" spellcheck="false" aria-label="预设提示文本"></textarea>
                <div class="lna-prompt-msg" role="status" aria-live="polite" hidden></div>
              </div>
            </div>`,
          footerHtml: `<button class="dlg-btn dlg-cancel" data-act="close" type="button">关闭</button>`,
          onOpen(modal) {
            modal.querySelector('[data-act="close"]').addEventListener('click', () => closeModal(modal));

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
                flashToast('请输入有效的宽度数值');
                return;
              }
              state.sidebarWidth = clampSidebarWidth(raw);
              saveSettings();
              applyLayoutVars();
              if (sbInp) sbInp.value = state.sidebarWidth;
              flashToast(`已保存：菜单宽度 ${state.sidebarWidth} px`);
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
                flashToast('请输入有效的高度数值');
                return;
              }
              state.bodyHeight = clampBodyHeight(raw);
              saveSettings();
              applyLayoutVars();
              if (bhInp) bhInp.value = state.bodyHeight;
              flashToast(`已保存：内容区高度 ${state.bodyHeight} px`);
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
                flashToast(`已应用比例 ${b.dataset.ratio}`);
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
                flashToast(sw.checked ? '已开启：' + sw.getAttribute('aria-label') : '已关闭：' + sw.getAttribute('aria-label'));
              });
            });

            updateRatioActive();
            bindLlmSettings(modal);
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
    btn.setAttribute('aria-label', loaded ? '翻译模型已加载，点击可卸载' : '翻译模型未加载');
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
          flashToast(j.unloaded ? '已卸载翻译模型，释放显存/内存' : '翻译模型本就未加载');
        } else {
          flashToast('卸载失败：' + ((j && j.error) || '未知错误'), true);
          refreshLlmState();
        }
      } catch (e) {
        flashToast('卸载失败：请求出错', true);
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
    none.textContent = engineReady ? '（不使用 GGUF，仅用词典）' : '（llama_cpp 未安装，仅用词典）';
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
        setLlmProgress(modal, (res && res.error) || '读取模型列表失败', true);
        return null;
      }
      fillLlmOptions(modal, res.models || [], res.selected || '', res.engine_ready);
      syncDeviceSwitch(modal, !!res.gpu, !!res.cuda_available);
      if (!res.engine_ready) {
        // 带上后端返回的真实原因：多数情况是 CUDA 运行库不在启动环境里
        setLlmProgress(
          modal,
          '未检测到可用的 llama_cpp 模块，标签翻译将只使用内置词典。'
            + (res.engine_error ? '原因：' + res.engine_error : ''),
          true,
        );
      }
      return res;
    } catch (e) {
      setLlmProgress(modal, '读取模型列表失败：请求出错', true);
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
        k.title = cudaAvailable ? 'GPU 推理（快，占显存）' : '当前为 CPU 构建，需安装 CUDA 版 llama-cpp-python';
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
  function syncModeSwitch(modal, mode) {
    const m = TRANS_MODES.some((x) => x.v === mode) ? mode : TRANS_MODE_DEFAULT;
    modal.querySelectorAll('.lna-mode-btn').forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function modeLabel(mode) {
    const hit = TRANS_MODES.find((x) => x.v === mode);
    return hit ? hit.label : String(mode || '');
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
      .map((p) => `<option value="${esc(p.name)}">${esc(p.name === defName ? p.name + '（内置）' : p.name)}</option>`)
      .join('');
    sel.value = active;

    const hit = presets.find((p) => p.name === active);
    textArea.value = hit ? hit.text : ((data && data.text) || '');
    nameInp.value = active === defName ? '' : active; // 默认预设不可覆盖，名称留空待填
    if (delBtn) {
      delBtn.disabled = active === defName; // 内置预设不可删除
      delBtn.title = delBtn.disabled ? '「默认」预设为内置内容，不可删除' : '删除当前选中的预设';
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
      setPromptMsg(modal, (res && res.error) || '操作失败', true);
      return null;
    } catch (e) {
      setPromptMsg(modal, '操作失败：请求出错', true);
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
      if (res) flashToast('已启用提示预设「' + res.active + '」');
    });

    // 保存：以输入框中的名称写入当前文本（同名覆盖）
    saveBtn.addEventListener('click', async () => {
      setPromptMsg(modal, '');
      const name = (nameInp.value || '').trim();
      const res = await editPromptPresets(modal, { action: 'save', name, text: textArea.value });
      if (res) flashToast('已保存提示预设「' + name + '」并启用');
    });

    // 删除当前选中的预设
    delBtn.addEventListener('click', async () => {
      setPromptMsg(modal, '');
      const res = await editPromptPresets(modal, { action: 'delete', name: sel.value });
      if (res) flashToast('已删除提示预设，当前启用「' + res.active + '」');
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
      o.textContent = '— 该仓库没有 GGUF 文件 —';
      sel.appendChild(o);
      return;
    }
    files.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.filename;
      // 带 mmproj 的是多模态投影文件，不是主模型，额外标注以免误选
      const tag = /mmproj/i.test(f.filename) ? '（多模态投影，非主模型）' : '';
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
      state.textContent = '读取运行环境失败';
      btn.disabled = true;
      return null;
    }
    let text = '';
    let canDownload = false;
    if (info.build === 'cuda') {
      text = info.usable ? '已是 CUDA 版：GPU 优先，显存不足时自动改用 CPU' : 'CUDA 版已安装，但无法加载';
    } else if (info.cuda_wheel_ready) {
      text = 'CUDA 版已下载，重启 WebUI 后自动安装并生效';
    } else if (!info.nvidia_ok) {
      text = info.driver
        ? `当前为 CPU 版（NVIDIA 驱动 ${info.driver} 低于 ${info.min_driver}，无法使用 GPU）`
        : '当前为 CPU 版（未检测到 NVIDIA 显卡）';
    } else {
      text = '当前为 CPU 版（可下载 CUDA 版以启用 GPU 推理）';
      canDownload = true;
    }
    state.textContent = text;
    btn.disabled = !canDownload;
    btn.title = canDownload ? '下载约 490MB 的 CUDA 版轮子；下载完成后重启 WebUI 自动安装' : '';
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
          const retry = st.attempt > 1 ? ` · 第 ${st.attempt} 次续传` : '';
          setRuntimeProgress(modal,
            `正在下载 CUDA 版：${fmtSize(st.done)}${st.total ? ' / ' + fmtSize(st.total) : ''}（${pct}%）${retry}`);
          return;
        }
        stopPoll();
        if (st.cuda_wheel_ready) {
          setRuntimeProgress(modal, 'CUDA 版已下载完成，请重启 WebUI：启动时会自动安装并生效');
          flashToast('CUDA 版下载完成，重启 WebUI 后生效');
        } else {
          setRuntimeProgress(modal, st.error || '下载未完成', true);
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
      setRuntimeProgress(modal, '正在准备下载…');
      try {
        const r = await fetch(API.runtimeDownloadCuda, { method: 'POST' });
        const res = await r.json();
        if (!res || !res.ok) {
          setRuntimeProgress(modal, (res && res.error) || '下载启动失败', true);
          refreshRuntimeInfo(modal);
          return;
        }
      } catch (e) {
        setRuntimeProgress(modal, '下载启动失败：请求出错', true);
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
      setLlmProgress(modal, '正在重新扫描模型目录…');
      const res = await refreshLlmModels(modal);
      refresh.disabled = false;
      if (res) setLlmProgress(modal, `已扫描到 ${(res.models || []).length} 个 GGUF 模型`);
    });

    // 打开模型文件夹：后端调系统资源管理器打开 LLM 目录
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', async () => {
        try {
          const r = await fetch(API.llmOpenFolder, { method: 'POST' });
          const res = await r.json();
          if (!res || !res.ok) flashToast('打开失败：' + ((res && res.error) || '未知错误'));
        } catch (e) {
          flashToast('打开失败：请求出错');
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
            flashToast(want ? '已切换 GPU 推理（下次翻译时加载进显存）' : '已切换 CPU 推理');
          } else {
            flashToast((res && res.error) || '切换失败');
          }
        } catch (e) {
          flashToast('切换失败：请求出错');
        }
      });
    });

    // 翻译方案切换：保存到后端（翻译时按该方案执行）
    modal.querySelectorAll('.lna-mode-btn').forEach((b) => {
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
            syncModeSwitch(modal, res.mode);
            flashToast('已切换为「' + modeLabel(res.mode) + '」');
          } else {
            flashToast('保存失败：' + ((res && res.error) || '未知错误'), true);
            await refreshTranslateMode(modal); // 回滚为后端真实值
          }
        } catch (e) {
          flashToast('保存失败：请求出错', true);
          await refreshTranslateMode(modal);
        }
      });
    });

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
          flashToast('保存失败：' + ((res && res.error) || '未知错误'), true);
          await refreshLlmIdle(modal); // 回滚为后端真实值
        }
      } catch (e) {
        flashToast('保存失败：请求出错', true);
        await refreshLlmIdle(modal);
      }
    }
    modal.querySelectorAll('.lna-idle-switch .lna-zh-key').forEach((k) => {
      k.addEventListener('click', () => {
        if (k.classList.contains('active')) return;
        const want = k.dataset.idle === '1';
        const minutes = clampIdleMinutes(idleInp ? idleInp.value : IDLE_DEFAULT);
        saveIdle({ auto_unload: want, minutes },
          want ? `已开启：空闲 ${minutes} 分钟后自动卸载` : '已关闭：模型将一直保留到手动卸载');
      });
    });
    if (idleInp) {
      // 输入过程中不提交，失焦/回车才归一化并保存（避免每敲一位都请求）
      const commitIdle = () => {
        const v = clampIdleMinutes(idleInp.value);
        idleInp.value = String(v);
        saveIdle({ minutes: v }, `已保存：空闲 ${v} 分钟后自动卸载`);
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
          flashToast(sel.value ? '已选择模型：' + sel.value : '已切换为仅用词典');
          setLlmProgress(modal, sel.value
            ? '模型将在下次翻译标签时自动加载（首次加载需要几秒）。'
            : '');
        } else {
          flashToast('保存失败：' + ((res && res.error) || '未知错误'));
        }
      } catch (e) {
        flashToast('保存失败：请求出错');
      }
    });

    async function detectRepo(showToast) {
      const repo = (repoInput.value || '').trim();
      if (!repo) { setLlmProgress(modal, '请先填写 HF 仓库或链接', true); return []; }
      detectBtn.disabled = true;
      setLlmProgress(modal, '正在探测网络并读取仓库文件列表…');
      try {
        const r = await fetch(API.llmRepoFiles, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo }),
        });
        const res = await r.json();
        if (!document.contains(modal)) return [];
        if (!res || !res.ok) {
          setLlmProgress(modal, (res && res.error) || '读取失败', true);
          return [];
        }
        fillLlmFiles(modal, res.files || []);
        setLlmProgress(modal, `已找到 ${res.files.length} 个文件 · 下载源：${res.endpoint} · 保存到 ${res.dir}`);
        if (showToast) flashToast(`检测到 ${res.files.length} 个可下载文件`);
        return res.files || [];
      } catch (e) {
        setLlmProgress(modal, '读取失败：请求出错', true);
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
            const retry = attempt > 1 ? ` · 第 ${attempt} 次续传` : '';
            setLlmProgress(modal, `正在下载 ${filename}：${fmtSize(done)}${total ? ' / ' + fmtSize(total) : ''}（${pct}%）· 源：${endpoint}${retry}`);
            return;
          }
          stopPoll();
          dlBtn.disabled = false;
          if (ok) {
            setLlmProgress(modal, `下载完成：${filename}。已加入模型列表。`);
            flashToast('模型下载完成');
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
      if (!filename) { setLlmProgress(modal, '请先选择要下载的文件', true); return; }
      dlBtn.disabled = true;
      setLlmProgress(modal, `准备下载 ${filename}…`);
      try {
        const r = await fetch(API.llmDownload, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: (repoInput.value || '').trim(), filename }),
        });
        const res = await r.json();
        if (!res || !res.ok) {
          dlBtn.disabled = false;
          setLlmProgress(modal, (res && res.error) || '启动下载失败', true);
          return;
        }
        startPoll();
      } catch (e) {
        dlBtn.disabled = false;
        setLlmProgress(modal, '启动下载失败：请求出错', true);
      }
    });
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
      const opt = SORT_OPTIONS.find((o) => o.value === state.sortKey);
      valueEl.textContent = opt.label;
      const dirLabel = state.sortDir === 'asc' ? '升序' : '降序';
      dirBtn.setAttribute('aria-label', '排序方向：' + dirLabel);
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
      menu.setAttribute('aria-label', '排序方式');
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.left = r.left + 'px';
      SORT_OPTIONS.forEach((o) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'lna-dd-item' + (o.value === state.sortKey ? ' selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', o.value === state.sortKey ? 'true' : 'false');
        item.innerHTML = `<span>${esc(o.label)}</span><span class="lna-dd-check" aria-hidden="true">✓</span>`;
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
      flashToast('已复制：' + text);
    } catch (err) {
      flashToast('复制失败，请手动复制');
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

  function tagsHtml(tags, tipText) {
    if (!tags || !tags.length) return '<span class="lna-cf-empty">（该模型未记录训练标签）</span>';
    return tags.map(([tag, cnt], i) => {
      const [bg, fg] = TAG_PALETTE[i % TAG_PALETTE.length];
      // .lna-tag-row 保持原有的「英文标签 + 计数」横排；.lna-tag-zh 为中文翻译（默认隐藏）
      const tip = tipText || '点击添加/移除触发词';
      return `<button class="lna-tag" type="button" data-tag="${esc(tag)}" aria-pressed="false" title="${esc(tip)}" style="--lna-tag-bg:${bg};--lna-tag-count-bg:${fg}"><span class="lna-tag-row"><span class="lna-tag-text">${esc(tag)}</span><span class="lna-tag-count">${esc(cnt)}</span></span><span class="lna-tag-zh"></span></button>`;
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
        flashToast('正在翻译中，暂时无法操作', true);
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
          if (document.contains(body)) flashToast('翻译失败：其它翻译任务长时间未完成', true);
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
            if (document.contains(body)) flashToast('翻译失败：其它翻译任务长时间未完成', true);
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
          flashToast(`翻译失败：接口不可用（HTTP ${r.status}），请重启 WebUI 后重试`);
          return false;
        }
        if (!res || !res.ok) {
          flashToast('翻译失败：' + ((res && res.error) || '未知错误'));
          return false;
        }
        if (!document.contains(body)) return false; // 弹窗已关闭
        body.__lnaZhLoaded = true;
        body.__lnaZhNote = res.note || ''; // 模型无有效产出时的原因，供按钮提示
        applyTagTranslations(body, res.translations || {}, true); // 合并：子集翻译不清空其余对照
        return true;
      } catch (e) {
        flashToast('翻译失败：请求出错');
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
    dlg.setAttribute('aria-label', '选择标签重新翻译');
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">选择标签重新翻译<span class="lna-cf-hint">勾选要重新翻译的标签；未勾选任何标签时点击确认将直接关闭</span></span>
        <button class="dlg-close" type="button" aria-label="关闭对话框">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh">${tagsHtml(info.tags, '点击选择/取消要重新翻译的标签')}</div>
        </div>
      </div>
      <div class="dlg-footer">
        <span class="lna-zh-time" role="status" aria-live="polite"></span>
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">关闭</button>
        <button class="dlg-btn primary lna-zh-repick" data-act="repick" type="button"><span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-repick-label">确认重新翻译</span></button>
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
      label.textContent = '正在翻译...';
      if (timeEl) { timeEl.textContent = ''; timeEl.classList.remove('is-err'); }
      setDlgBusy(dlg.querySelector('.dlg-body'), true); // 在途禁止关闭小弹窗
      const t0 = performance.now();
      const ok = await loadTagTranslations(body, tags, true, l.rel, true);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      refreshLlmState(); // 翻译会触发模型加载，立即刷新顶栏状态按钮
      if (closed || !document.contains(dlg)) return;
      okBtn.classList.remove('busy');
      spinner.hidden = true;
      label.textContent = '确认重新翻译';
      setDlgBusy(dlg.querySelector('.dlg-body'), false);
      if (timeEl) {
        if (ok) timeEl.textContent = `上次用时 ${secs} 秒`;
        else { timeEl.textContent = '翻译失败'; timeEl.classList.add('is-err'); }
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
          <div class="lna-dict-row"><span class="lna-dict-k">标签</span><span class="lna-dict-v">${tag ? esc(tag) : '<em class="lna-dict-none">（无）</em>'}</span></div>
          <div class="lna-dict-row"><span class="lna-dict-k">当前译文</span><span class="lna-dict-v">${zhText ? esc(zhText) : '<em class="lna-dict-none">（无译文）</em>'}</span></div>
        </div>`;
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
    dlg.setAttribute('aria-label', '将译文加入词典');
    // 结果区骨架：占位 / 查询中 / 结果三态共用同一结构，切换时高度不变，
    // 避免弹窗上下跳动（弹窗在遮罩里垂直居中，高度一变就会被重新居中）
    function dictSkeleton(tag, zh, matchHtml, btnLabel, canWrite) {
      return `${dictRowTagZh(tag, zh)}
        <div class="lna-dict-line">
          <div class="lna-dict-row"><span class="lna-dict-k">词典匹配</span><span class="lna-dict-v">${matchHtml}</span></div>
          <button class="dlg-btn primary lna-dict-save" type="button"${canWrite ? '' : ' aria-disabled="true"'}>${btnLabel}</button>
        </div>`;
    }
    // 未选择标签时的占位结果：与选中态同结构，按钮置灰不可写
    const emptyResultHtml = dictSkeleton('', '', '<em class="lna-dict-none">（无，请选择上方一个标签）</em>', '添加到词典', false);
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">将译文加入词典<span class="lna-cf-hint">单选标签后查询词典；已有译文才可写入</span></span>
        <button class="dlg-close" type="button" aria-label="关闭对话框">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh">${tagsHtml(info.tags, '点击选择要写入词典的标签（单选）')}</div>
        </div>
        <div class="lna-dict-result" role="status" aria-live="polite">${emptyResultHtml}
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">关闭</button>
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

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      mask.remove();
      unlockScroll();
    }
    dlg.querySelector('.dlg-close').addEventListener('click', close);
    dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);
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
          `<span class="lna-dict-tip is-err">词典查询失败：${esc((lookup && lookup.error) || '接口不可用，请重启 WebUI')}</span>`,
          '添加到词典', false);
        return;
      }
      const dictVal = lookup.dict_value || '';
      const canWrite = !!zhText;
      const btnLabel = lookup.found ? '替换词典译文' : '添加到词典';
      // 两行布局：行1=标签+当前译文，行2=词典匹配+按钮（按钮固定右端，避免文案长短变化导致按钮跳动）
      resultBox.innerHTML = dictSkeleton(tag, zhText, lookup.found
        ? `<span class="lna-dict-hit">已收录，现值：<b>${esc(dictVal)}</b></span>`
        : '<b class="lna-dict-miss">未收录（词典中没有该标签）</b>', btnLabel, canWrite);
      const saveBtn = resultBox.querySelector('.lna-dict-save');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          if (saveBtn.classList.contains('busy') || saveBtn.getAttribute('aria-disabled') === 'true') return;
          if (!canWrite) { flashToast('该标签暂无译文，无法写入词典', true); return; }
          saveBtn.classList.add('busy');
          const oldText = saveBtn.textContent;
          saveBtn.textContent = '正在写入...';
          try {
            const r = await fetch(API.dictUpsert, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tag, value: zhText }),
            });
            const res = await r.json();
            if (res && res.ok) {
              flashToast(lookup.found ? `已替换词典对照：${tag}` : `已添加到词典：${tag}`);
              if (selected === tag) renderResult(tag, zhText, { ok: true, key: res.key, found: true, dict_value: res.value });
            } else {
              flashToast('写入失败：' + ((res && res.error) || '未知错误'), true);
              saveBtn.classList.remove('busy');
              saveBtn.textContent = oldText;
            }
          } catch (e) {
            flashToast('写入失败：请求出错', true);
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
        resultBox.innerHTML = dictSkeleton(tag, zhText, '<em class="lna-dict-none">正在查询词典…</em>', '添加到词典', false);
        try {
          const r = await fetch(`${API.dictLookup}?tag=${encodeURIComponent(tag)}`);
          const res = await r.json();
          if (closed || seq !== reqSeq || !document.contains(dlg)) return;
          renderResult(tag, zhText, res);
        } catch (e) {
          if (closed || seq !== reqSeq || !document.contains(dlg)) return;
          resultBox.innerHTML = dictSkeleton(tag, zhText, '<span class="lna-dict-tip is-err">词典查询失败：请求出错</span>', '添加到词典', false);
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
    dlg.setAttribute('aria-label', '人工修正译文');
    // 空态 / 选中态共用同一结构，只换文本与输入框，高度不变，弹窗不抖动
    function skeleton(tag, zh) {
      const on = !!tag;
      return `${dictRowTagZh(tag, on ? zh : '')}
        <div class="lna-dict-line">
          <span class="lna-dict-k">修正译文</span>
          <input class="lna-mt-input" type="text" placeholder="填写该标签的中文译文" aria-label="修正译文" value="${on ? esc(zh) : ''}"${on ? '' : ' disabled'}>
          <button class="dlg-btn lna-save-blue lna-dict-save" type="button"${on ? '' : ' aria-disabled="true"'}>修改译文</button>
        </div>`;
    }
    dlg.innerHTML = `
      <header>
        <span class="dlg-title">人工修正译文<span class="lna-cf-hint">单选标签后手工填写译文；保存后立即生效</span></span>
        <button class="dlg-close" type="button" aria-label="关闭对话框">${ICON.close}</button>
      </header>
      <div class="dlg-body">
        <div class="lna-cf-field">
          <div class="lna-cf-tags show-zh">${tagsHtml(info.tags, '点击选择要修正译文的标签（单选）')}</div>
        </div>
        <div class="lna-dict-result" role="status" aria-live="polite">${skeleton('', '')}
        </div>
      </div>
      <div class="dlg-footer">
        <button class="dlg-btn dlg-cancel" data-act="cancel" type="button">关闭</button>
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
        if (!val) { flashToast('请先填写译文', true); input.focus(); return; }
        btn.classList.add('busy');
        btn.textContent = '正在保存...';
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
            flashToast(`已修正译文：${tag}`);
            if (selected === tag) render(tag);                // 重绘：同步「当前译文」并复位按钮
          } else {
            flashToast('保存失败：' + ((res && res.error) || '未知错误'), true);
            btn.classList.remove('busy');
            btn.textContent = '修改译文';
          }
        } catch (e) {
          if (!document.contains(dlg)) return;
          flashToast('保存失败：请求出错', true);
          btn.classList.remove('busy');
          btn.textContent = '修改译文';
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
    if (!src) { flashToast('未找到生成图像，请先在输出图库中生成或选中一张'); return; }
    let blob = null;
    try {
      const rr = await fetch(src);
      blob = await rr.blob();
    } catch (e) {
      blob = null;
    }
    if (!blob || !blob.size) { flashToast('读取生成图像失败'); return; }
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
        flashToast('已使用生成图像替换预览图');
      } else {
        flashToast('替换失败：' + ((res && res.error) || '未知错误'));
      }
    } catch (e) {
      flashToast('替换失败：请求出错');
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
            <span class="lna-cf-label">描述</span>
            <textarea class="lna-cf-input lna-cf-desc" rows="4">${esc(u.description || '')}</textarea>
          </label>
          ${metaTableHtml(info.table)}
          <div class="lna-cf-field">
            <span class="lna-cf-label">基础模型</span>
            <div class="lna-cf-radio">
              ${SD_VERSIONS.map((v) => `<label class="lna-cf-radio-item"><input type="radio" name="lna-sdver" value="${v}"${curVer === v ? ' checked' : ''}><span>${v}</span></label>`).join('')}
            </div>
          </div>
        </div>
        <div class="lna-cf-top-side">
          <div class="lna-cf-preview${info.preview ? '' : ' is-empty'}"${coverStyle}>
            <span class="lna-cf-preview-hint">暂无预览图</span>
          </div>
          <button class="dlg-btn dlg-action lna-cf-replace" type="button" data-act="replace">浏览并替换预览图像</button>
          <button class="dlg-btn dlg-action lna-cf-use-gen" type="button" data-act="use-generated">将生成的图像作为预览图像</button>
        </div>
      </div>
      <div class="lna-cf-field">
        <div class="lna-cf-tags-head">
          <span class="lna-cf-label lna-cf-tags-title">数据集的训练标签<span class="lna-cf-hint">点击标签可加入/移出触发词</span></span>
        </div>
        <div class="lna-cf-tags${state.showTagZh ? ' show-zh' : ''}">${tagsHtml(info.tags)}</div>
        ${hasTags ? `
        <div class="lna-cf-tags-actions">
          <div class="lna-zh-switch" role="group" aria-label="标签翻译显示开关">
            <button class="lna-zh-key${state.showTagZh ? '' : ' active'}" type="button" data-zh="0" aria-pressed="${state.showTagZh ? 'false' : 'true'}">隐藏翻译</button>
            <button class="lna-zh-key${state.showTagZh ? ' active' : ''}" type="button" data-zh="1" aria-pressed="${state.showTagZh ? 'true' : 'false'}">显示翻译</button>
          </div>
          <button class="dlg-btn dlg-action lna-cf-zh-all" type="button" title="批量翻译当前卡片的全部训练标签">${ICON.translateAll}<span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-all-label">翻译所有标签</span></button>
          <button class="dlg-btn dlg-action lna-cf-zh-missing" type="button" title="只翻译当前还没有中文对照的标签（已有对照的沿用，不调用模型）">${ICON.incomplete}<span class="lna-spinner" aria-hidden="true" hidden></span><span class="lna-zh-missing-label">翻译未完成标签</span></button>
          <button class="dlg-btn dlg-action lna-cf-zh-pick" type="button" title="勾选训练标签后重新翻译（跳过缓存，覆盖旧译文）">${ICON.retranslate}选择标签重新翻译</button>
          <button class="dlg-btn dlg-action lna-cf-zh-edit" type="button" title="单选训练标签，手工填写/修正其中文译文">${ICON.editZh}人工修正译文</button>
          <button class="dlg-btn dlg-action lna-cf-dict" type="button" title="单选训练标签，把其当前译文写入翻译词典">${ICON.addDict}将译文加入词典</button>
          <span class="lna-zh-time" role="status" aria-live="polite"></span>
        </div>` : ''}
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">触发词<span class="lna-cf-hint">会和 Lora 一起添加到提示词中</span></span>
        <textarea class="lna-cf-input lna-cf-activation" rows="2">${esc(u.activation_text || '')}</textarea>
      </label>
      <div class="lna-cf-field">
        <span class="lna-cf-label">推荐权重<span class="lna-cf-hint">设置为 0 以禁用</span></span>
        <div class="lna-cf-weight">
          <input type="range" class="lna-cf-weight-range" min="0" max="2" step="0.01" value="${weight}" aria-label="推荐权重滑块">
          <input type="number" class="lna-cf-weight-num" min="0" max="2" step="0.01" value="${weight}" aria-label="推荐权重数值">
        </div>
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">反向提示词<span class="lna-cf-hint">会被添加到反向提示词中</span></span>
        <textarea class="lna-cf-input lna-cf-negative" rows="2">${esc(u.negative_text || '')}</textarea>
      </label>
      <div class="lna-cf-field">
        <span class="lna-cf-label">随机提示词</span>
        <div class="lna-cf-random-row">
          <textarea class="lna-cf-input lna-cf-random" rows="4" readonly></textarea>
          <button class="dlg-btn lna-cf-gen" type="button">生成</button>
        </div>
      </div>
      <label class="lna-cf-field">
        <span class="lna-cf-label">注意事项</span>
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
      title: `卡片设置 · ${l.name}`,
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>正在读取卡片信息…</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="cancel" type="button">取消</button>
        <button class="dlg-btn primary" data-act="save" type="button">保存</button>`,
      onOpen(modal) {
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => closeModal(modal));

        // 替换按钮在内容区、异步渲染后才出现，故用事件委托
        modal.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="replace"]')) {
            if (!fileInput) { flashToast('卡片信息还在加载，请稍候'); return; }
            fileInput.click();
            return;
          }
          if (e.target.closest('[data-act="use-generated"]')) {
            applyGeneratedPreview(API.preview, l.rel, modal, l);
          }
        });

        modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
          const desc = modal.querySelector('.lna-cf-desc');
          if (!desc) { flashToast('卡片信息还在加载，请稍候'); return; }
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
            if (res && res.ok) { closeModal(modal); flashToast('已保存卡片设置'); }
            else flashToast('保存失败：' + ((res && res.error) || '未知错误'));
          } catch (e) {
            flashToast('保存失败：请求出错');
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
      info = { ok: false, error: '读取请求失败' };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭
    if (!info || !info.ok) {
      body.innerHTML = `<div class="dlg-empty">${esc((info && info.error) || '无法读取卡片信息')}</div>`;
      return;
    }
    body.innerHTML = cardFormHtml(info);

    // 点标签 → 加入/移出触发词
    const act = body.querySelector('.lna-cf-activation');
    // 按触发词输入框内容同步所有标签的选中态（手动输入/删除也能点亮/熄灭标签）
    function syncTagSelected() {
      const words = act.value.split(/\s*,\s*/).filter((x) => x.trim());
      body.querySelectorAll('.lna-tag').forEach((b) => {
        const on = words.includes(b.dataset.tag);
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    act.addEventListener('input', syncTagSelected);
    syncTagSelected(); // 打开弹窗时按已保存的触发词初始化选中态
    body.querySelectorAll('.lna-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        const words = act.value.split(/\s*,\s*/).filter((x) => x.trim());
        if (words.includes(tag)) {
          act.value = words.filter((x) => x !== tag).join(', ');
        } else {
          act.value = act.value.trim() ? act.value.replace(/\s*$/, '') + ', ' + tag : tag;
        }
        syncTagSelected(); // 程序改 value 不触发 input 事件，手动同步
      });
    });

    // 训练标签的中文翻译：连体胶囊开关（隐藏/显示）与批量翻译
    const zhKeys = body.querySelectorAll('.lna-zh-key');
    const zhAll = body.querySelector('.lna-cf-zh-all');
    const tagList = (info.tags || []).map(([t]) => t);
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
        if (label) label.textContent = '正在翻译标签中...';
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
              zhTime.textContent = `上次用时 ${secs} 秒`;
            }
          }
        } else if (zhTime) {
          zhTime.textContent = '翻译失败';
          zhTime.classList.add('is-err');
        }
      });
    }

    bindZhButton(zhAll, '.lna-zh-all-label', '翻译所有标签',
      () => tagList, '该模型没有训练标签');
    // 只提交当前显示为「未完成翻译」的标签：词典/缓存已命中的不再重复送模型
    bindZhButton(body.querySelector('.lna-cf-zh-missing'), '.lna-zh-missing-label', '翻译未完成标签',
      () => Array.from(body.querySelectorAll('.lna-tag.no-zh')).map((el) => el.dataset.tag),
      '没有未完成的标签');

    // 选择标签重新翻译：打开嵌套小弹窗勾选后重翻
    const zhPick = body.querySelector('.lna-cf-zh-pick');
    if (zhPick) {
      zhPick.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast('正在翻译中，暂时无法操作', true); return; }
        openRepickDialog(body, info, l);
      });
    }

    // 将翻译对照添加到词典：打开嵌套小弹窗单选标签后写入词典
    const dictBtn = body.querySelector('.lna-cf-dict');
    if (dictBtn) {
      dictBtn.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast('正在翻译中，暂时无法操作', true); return; }
        openDictDialog(body, info);
      });
    }

    // 人工修正译文：打开嵌套小弹窗单选标签后手工填写译文
    const editZhBtn = body.querySelector('.lna-cf-zh-edit');
    if (editZhBtn) {
      editZhBtn.addEventListener('click', () => {
        if (body.__lnaZhPromise) { flashToast('正在翻译中，暂时无法操作', true); return; }
        openManualTranslateDialog(body, info, l.rel);
      });
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
          flashToast('预览图已替换');
        } else {
          flashToast('替换失败：' + ((res && res.error) || '未知错误'));
        }
      } catch (e) {
        flashToast('替换失败：请求出错');
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
            <span class="lna-cf-label">描述</span>
            <textarea class="lna-cf-input lna-cf-desc" rows="4">${esc(info.description || '')}</textarea>
          </label>
          <dl class="lna-cf-info">
            <dt>名称</dt><dd>${esc(info.name)}</dd>
            <dt>相对路径</dt><dd>${esc(info.rel || '（根目录）')}</dd>
            <dt>模型个数<span class="lna-cf-hint">含子文件夹</span></dt><dd>${esc(String(info.count))}</dd>
          </dl>
        </div>
        <div class="lna-cf-top-side">
          <div class="lna-cf-preview${info.preview ? '' : ' is-empty'}"${coverStyle}>
            <span class="lna-cf-preview-hint">暂无预览图</span>
          </div>
          <button class="dlg-btn dlg-action lna-cf-replace" type="button" data-act="replace">浏览并替换预览图像</button>
          <button class="dlg-btn dlg-action lna-cf-use-gen" type="button" data-act="use-generated">将生成的图像作为预览图像</button>
          <button class="dlg-btn dlg-action lna-cf-open" type="button" data-act="open-folder">打开文件夹路径</button>
        </div>
      </div>
    </div>`;
  }

  async function openFolderCardSettings(f) {
    let fileInput = null;
    const dlg = openModal({
      title: `卡片设置 · ${f.name}`,
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>正在读取文件夹信息…</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="cancel" type="button">取消</button>
        <button class="dlg-btn primary" data-act="save" type="button">保存</button>`,
      onOpen(modal) {
        modal.querySelector('[data-act="cancel"]').addEventListener('click', () => closeModal(modal));

        // 替换按钮/打开按钮在内容区、异步渲染后才出现，故用事件委托
        modal.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="replace"]')) {
            if (!fileInput) { flashToast('文件夹信息还在加载，请稍候'); return; }
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
              if (!res || !res.ok) flashToast('打开失败：' + ((res && res.error) || '未知错误'));
            }).catch(() => flashToast('打开失败：请求出错'));
          }
        });

        modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
          const desc = modal.querySelector('.lna-cf-desc');
          if (!desc) { flashToast('文件夹信息还在加载，请稍候'); return; }
          try {
            const r = await fetch(API.userMeta, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rel: f.rel, description: desc.value }),
            });
            const res = await r.json();
            if (res && res.ok) { closeModal(modal); flashToast('已保存文件夹设置'); }
            else flashToast('保存失败：' + ((res && res.error) || '未知错误'));
          } catch (e) {
            flashToast('保存失败：请求出错');
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
      info = { ok: false, error: '读取请求失败' };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭
    if (!info || !info.ok) {
      body.innerHTML = `<div class="dlg-empty">${esc((info && info.error) || '无法读取文件夹信息')}</div>`;
      return;
    }
    body.innerHTML = folderFormHtml(info);

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
          flashToast('预览图已替换');
        } else {
          flashToast('替换失败：' + ((res && res.error) || '未知错误'));
        }
      } catch (e) {
        flashToast('替换失败：请求出错');
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
    if (text.length > META_VALUE_LIMIT) text = text.slice(0, META_VALUE_LIMIT) + '\n…（内容过长，已截断）';
    return `<pre class="lna-meta-json">${esc(text)}</pre>`;
  }

  function renderMetaTable(meta) {
    const keys = Object.keys(meta || {});
    if (!keys.length) return `<div class="dlg-empty">此模型未包含内部元数据</div>`;
    keys.sort((a, b) => (META_ORDER[a] || 999) - (META_ORDER[b] || 999)); // 稳定排序，其余保持原顺序
    const rows = keys.map((k) => `<dt>${esc(k)}</dt><dd>${fmtMetaValue(meta[k])}</dd>`).join('');
    return `<dl class="lna-meta-list">${rows}</dl>`;
  }

  async function openLoraMetadata(l) {
    const dlg = openModal({
      title: `${l.name} · 内部元数据`,
      locked: true,
      bodyHtml: `<div class="dlg-loading" role="status" aria-live="polite">
        <span class="lna-spinner" aria-hidden="true"></span>正在读取内部元数据…</div>`,
      footerHtml: `<button class="dlg-btn dlg-cancel" data-act="close" type="button">关闭</button>`,
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
      res = { ok: false, error: '读取请求失败' };
    }
    if (!document.contains(dlg)) return; // 弹窗已被关闭，丢弃结果
    body.innerHTML = res && res.ok
      ? renderMetaTable(res.metadata)
      : `<div class="dlg-empty">${esc((res && res.error) || '无法读取内部元数据')}</div>`;
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
      ? `已添加 ${l.name} 到${tabName}正/负提示词`
      : `已添加到${tabName}正提示词：${l.name}`);
  }

  function appendToPromptBox(selector, text) {
    const box = document.querySelector(selector);
    if (!box) {
      flashToast('找不到提示词输入框');
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
        <button class="dlg-close" type="button" aria-label="关闭对话框">${ICON.close}</button>
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
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !locked) { e.preventDefault(); close(); }
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
    nav.setAttribute('aria-label', '设置分组导航');
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
    // 主弹窗关闭时连带关闭嵌套小弹窗（重翻/词典），避免残留蒙版
    document.querySelectorAll('.lna-repick-mask, .lna-dict-mask').forEach((m) => {
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
    state.expandedFolders = loadExpandedFolders(); // 恢复已记忆的展开状态
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
