import { Plugin, Setting, showMessage } from "siyuan";
import { IPluginConfig } from "./types";
import {
    calculateHeaderNumbersForBlocks,
    num2Chinese,
    stripNumberPrefix,
} from "./utils/header_utils";
import { batchUpdateBlockContent, compareVersions, getDocHeaderBlocks, getVersion } from "./utils/api";
import "./style.scss";

const STORAGE_NAME = "sy-header-number";
const OLD_STORAGE_NAME = "auto-seq-number";
const DEBOUNCE_DELAY = 2000;
const BATCH_CHUNK_SIZE = 10;
const DEFAULT_POLL_INTERVAL = 5;

function getDefaultConfig(): IPluginConfig {
    return {
        formats: [
            "{1}. ",
            "{1}.{2} ",
            "{1}.{2}.{3} ",
            "{1}.{2}.{3}.{4} ",
            "{1}.{2}.{3}.{4}.{5} ",
            "{1}.{2}.{3}.{4}.{5}.{6} ",
        ],
        useChineseNumbers: [false, false, false, false, false, false],
        enabledLevels: [true, true, true, true, true, true],
        defaultEnabled: true,
        realTimeUpdate: false,
        pollInterval: DEFAULT_POLL_INTERVAL,
        docEnableStatus: {},
    };
}

export default class HeaderNumberPlugin extends Plugin {
    public config!: IPluginConfig;
    private debounceTimer: number | null = null;
    private pollTimer: number | null = null;
    private activeDocId: string | null = null;
    private activeProtyle: any;
    private shouldUpdate = false;
    private topBarElement: HTMLElement | null = null;
    private statusBarElement: HTMLElement | null = null;
    private version = "";
    // 增量更新缓存: docId → (blockId → 已添加的序号前缀)
    private lastAppliedNumbers: Map<string, Map<string, string>> = new Map();

    async onload() {
        this.version = await getVersion();
        this.config = await this.loadConfig();

        this.setting = new Setting({
            confirmCallback: () => {
                this.saveConfig();
            },
        });

        this.initSettings();
        this.initTopBar();
        this.initStatusBar();

        this.eventBus.on("loaded-protyle-dynamic", this.onProtyleLoaded);
        this.eventBus.on("loaded-protyle-static", this.onProtyleLoaded);
        this.eventBus.on("switch-protyle", this.onDocSwitch);
        this.eventBus.on("destroy-protyle", this.onDocClosed);
        if (this.config.realTimeUpdate) {
            this.eventBus.on("ws-main", this.onEdited);
        }
        this.startPolling();
    }

    async onunload() {
        this.clearDebounceTimer();
        this.stopPolling();
        this.eventBus.off("loaded-protyle-dynamic", this.onProtyleLoaded);
        this.eventBus.off("loaded-protyle-static", this.onProtyleLoaded);
        this.eventBus.off("switch-protyle", this.onDocSwitch);
        if (this.config.realTimeUpdate) {
            this.eventBus.off("ws-main", this.onEdited);
        }
        this.shouldUpdate = false;
    }

    // ==================== 设置面板 ====================

    private initSettings() {
        // 全局启用设置
        this.setting.addItem({
            title: this.i18n.defaultEnabled,
            description: this.i18n.defaultEnabledDesc,
            createActionElement: () => {
                const container = document.createElement("div");
                container.className = "setting-item__action";
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "b3-switch fn__flex-center";
                checkbox.checked = this.config.defaultEnabled;
                checkbox.addEventListener("change", () => {
                    this.config.defaultEnabled = checkbox.checked;
                });
                container.appendChild(checkbox);
                return container;
            },
        });

        // 实时更新设置
        this.setting.addItem({
            title: this.i18n.realTimeUpdate,
            description: this.i18n.realTimeUpdateDesc,
            createActionElement: () => {
                const container = document.createElement("div");
                container.className = "setting-item__action";
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "b3-switch fn__flex-center";
                checkbox.checked = this.config.realTimeUpdate;
                checkbox.addEventListener("change", () => {
                    this.config.realTimeUpdate = checkbox.checked;
                    if (checkbox.checked) {
                        this.eventBus.on("ws-main", this.onEdited);
                    } else {
                        this.eventBus.off("ws-main", this.onEdited);
                        this.clearDebounceTimer();
                    }
                });
                container.appendChild(checkbox);
                return container;
            },
        });

        // 轮询间隔设置
        this.setting.addItem({
            title: this.i18n.pollInterval,
            description: this.i18n.pollIntervalDesc,
            createActionElement: () => {
                const container = document.createElement("div");
                container.className = "setting-item__action";
                const input = document.createElement("input");
                input.type = "number";
                input.className = "b3-text-field fn__flex-center";
                input.style.width = "80px";
                input.min = "0";
                input.max = "60";
                input.step = "1";
                input.value = String(this.config.pollInterval);
                input.placeholder = "0";
                input.addEventListener("change", () => {
                    const val = parseInt(input.value) || 0;
                    this.config.pollInterval = Math.max(0, Math.min(60, val));
                    input.value = String(this.config.pollInterval);
                    this.restartPolling();
                });
                container.appendChild(input);
                const unitLabel = document.createElement("span");
                unitLabel.className = "fn__flex-center";
                unitLabel.style.marginLeft = "6px";
                unitLabel.textContent = this.i18n.pollIntervalUnit;
                container.appendChild(unitLabel);
                return container;
            },
        });

        // 各级标题格式设置（含级别启用开关、格式输入、中文数字选项、格式预览）
        for (let i = 0; i < 6; i++) {
            this.setting.addItem({
                title: this.i18n.headerFormat.replace("{1}", (i + 1).toString()),
                description: i === 0 ? this.i18n.headerFormatDesc : "",
                createActionElement: () => {
                    const container = document.createElement("div");
                    container.className = "setting-item__action";

                    // 级别启用开关
                    const toggleContainer = document.createElement("div");
                    toggleContainer.className = "fn__flex fn__flex-center level-toggle-option";
                    const levelToggle = document.createElement("input");
                    levelToggle.type = "checkbox";
                    levelToggle.className = "b3-switch fn__flex-center";
                    levelToggle.checked = this.config.enabledLevels[i];
                    levelToggle.addEventListener("change", () => {
                        this.config.enabledLevels[i] = levelToggle.checked;
                        this.updatePreview(previewEl, i);
                    });
                    const toggleLabel = document.createElement("span");
                    toggleLabel.className = "level-toggle-label";
                    toggleLabel.textContent = this.i18n.levelEnabled;
                    toggleContainer.appendChild(levelToggle);
                    toggleContainer.appendChild(toggleLabel);
                    container.appendChild(toggleContainer);

                    // 格式输入框
                    const inputContainer = document.createElement("div");
                    inputContainer.className = "fn__flex-1 format-input-container";
                    const input = document.createElement("input");
                    input.type = "text";
                    input.className = "b3-text-field fn__flex-1";
                    input.value = this.config.formats[i];
                    input.placeholder = this.i18n.formatPlaceholder;
                    input.addEventListener("input", () => {
                        this.config.formats[i] = input.value;
                        this.updatePreview(previewEl, i);
                    });
                    inputContainer.appendChild(input);
                    container.appendChild(inputContainer);

                    // 中文数字选项
                    const checkboxContainer = document.createElement("div");
                    checkboxContainer.className = "fn__flex fn__flex-center chinese-number-option";
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.className = "b3-switch fn__flex-center";
                    checkbox.checked = this.config.useChineseNumbers[i];
                    checkbox.addEventListener("change", () => {
                        this.config.useChineseNumbers[i] = checkbox.checked;
                        this.updatePreview(previewEl, i);
                    });
                    const label = document.createElement("span");
                    label.className = "chinese-number-label";
                    label.textContent = this.i18n.useChineseNumbers;
                    checkboxContainer.appendChild(checkbox);
                    checkboxContainer.appendChild(label);
                    container.appendChild(checkboxContainer);

                    // 格式预览
                    const previewEl = document.createElement("div");
                    previewEl.className = "format-preview";
                    this.updatePreview(previewEl, i);
                    container.appendChild(previewEl);

                    return container;
                },
            });
        }

        // 重置按钮
        this.setting.addItem({
            title: this.i18n.resetConfig,
            description: this.i18n.resetConfigDesc,
            createActionElement: () => {
                const container = document.createElement("div");
                container.className = "setting-item__action";
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline";
                button.textContent = this.i18n.resetBtn;
                button.addEventListener("click", async () => {
                    this.config = {
                        ...getDefaultConfig(),
                        docEnableStatus: this.config.docEnableStatus,
                    };
                    await this.saveConfig();
                    showMessage(this.i18n.settingsResetSuccess);
                    globalThis.location.reload();
                });
                container.appendChild(button);
                return container;
            },
        });
    }

    private updatePreview(previewEl: HTMLElement, level: number) {
        const format = this.config.formats[level];
        const useChinese = this.config.useChineseNumbers[level];
        const enabled = this.config.enabledLevels[level];

        if (!enabled) {
            previewEl.textContent = this.i18n.previewDisabled;
            previewEl.classList.add("disabled");
            return;
        }
        previewEl.classList.remove("disabled");

        // 用示例计数器生成预览: 1.2.3 等
        const sampleCounters = [1, 2, 3, 1, 1, 1];
        let preview = format;
        const placeholders = format.match(/\{(\d+)\}/g) || [];
        for (const placeholder of placeholders) {
            const match = placeholder.match(/\{(\d+)\}/);
            if (!match) continue;
            const index = parseInt(match[1]) - 1;
            const num = sampleCounters[index] || 1;
            const numStr = useChinese ? num2Chinese(num) : num.toString();
            preview = preview.replace(placeholder, numStr);
        }
        previewEl.textContent = `${this.i18n.previewLabel}${preview}`;
    }

    // ==================== 配置管理 ====================

    private async loadConfig(): Promise<IPluginConfig> {
        let config = getDefaultConfig();

        // 优先读取新存储名
        let stored = await this.loadData(STORAGE_NAME);

        // 从旧存储名迁移
        if (!stored) {
            stored = await this.loadData(OLD_STORAGE_NAME);
            if (stored) {
                await this.saveData(STORAGE_NAME, stored);
            }
        }

        if (stored) {
            config = Object.assign(config, stored);
            // 确保新增字段存在（兼容旧配置）
            if (!config.enabledLevels) {
                config.enabledLevels = [true, true, true, true, true, true];
            }
        }
        return config;
    }

    public async saveConfig() {
        await this.saveData(STORAGE_NAME, this.config);
    }

    // ==================== 顶部工具栏 ====================

    private ICON_SVG = `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <rect x="14" y="14" width="92" height="92" rx="16" fill="#FEF08A" stroke="#334155" stroke-width="3"/>
  <rect x="28" y="26" width="64" height="72" rx="4" fill="#FFFFFF" stroke="#334155" stroke-width="3" stroke-linejoin="round"/>
  <text x="36" y="48" font-family="sans-serif" font-weight="bold" font-size="15" fill="#F97316">1.</text>
  <path d="M 52 44 Q 64 42 76 45" fill="none" stroke="#334155" stroke-width="3" stroke-linecap="round"/>
  <text x="44" y="66" font-family="sans-serif" font-weight="bold" font-size="12" fill="#0EA5E9">1.1</text>
  <text x="44" y="84" font-family="sans-serif" font-weight="bold" font-size="12" fill="#0EA5E9">1.2</text>
  <path d="M 62 62 Q 70 60 76 63" fill="none" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 62 80 Q 68 78 72 80" fill="none" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 70 86 L 74 90 L 82 80" fill="none" stroke="#10B981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

    private initTopBar() {
        this.topBarElement = this.addTopBar({
            icon: this.ICON_SVG,
            title: this.i18n.toggleHeaderNumber,
            callback: async () => {
                if (this.isDocEnabled(this.activeDocId)) {
                    await this.clearDocNumbering(this.activeProtyle);
                    showMessage(this.i18n.numberingDisabled);
                    this.disableDoc(this.activeDocId);
                    this.updateTopBarState(false);
                } else {
                    await this.updateDocNumbering(this.activeProtyle);
                    showMessage(this.i18n.numberingEnabled);
                    this.enableDoc(this.activeDocId);
                    this.updateTopBarState(true);
                }
            },
        });

        if (this.topBarElement) {
            this.topBarElement.classList.add("toolbar__item--sy-header-number");
            if (this.activeDocId && this.isDocEnabled(this.activeDocId)) {
                this.topBarElement.classList.add("active");
            }
        }
    }

    // ==================== 状态栏 ====================

    private initStatusBar() {
        this.statusBarElement = this.addStatusBar({
            html: `<span class="status-icon">${this.ICON_SVG}</span><span class="status-text">${this.i18n.statusDisabled}</span>`,
        });
        if (this.statusBarElement) {
            this.statusBarElement.classList.add("status__item--sy-header-number");
            this.statusBarElement.addEventListener("click", () => {
                if (this.activeDocId) {
                    if (this.isDocEnabled(this.activeDocId)) {
                        this.clearDocNumbering(this.activeProtyle);
                        showMessage(this.i18n.numberingDisabled);
                        this.disableDoc(this.activeDocId);
                        this.updateTopBarState(false);
                    } else {
                        this.updateDocNumbering(this.activeProtyle);
                        showMessage(this.i18n.numberingEnabled);
                        this.enableDoc(this.activeDocId);
                        this.updateTopBarState(true);
                    }
                }
            });
        }
    }

    private updateStatusBarState(enabled: boolean) {
        if (!this.statusBarElement) return;
        const textEl = this.statusBarElement.querySelector(".status-text");
        if (textEl) {
            textEl.textContent = enabled
                ? this.i18n.statusEnabled
                : this.i18n.statusDisabled;
        }
        this.statusBarElement.classList.toggle("active", enabled);
    }

    // ==================== 事件处理 ====================

    private onProtyleLoaded = async (e: CustomEvent) => {
        this.activeProtyle = e.detail.protyle;
        this.activeDocId = this.getDocId(this.activeProtyle);
        if (!this.activeDocId) return;

        const enabled = this.isDocEnabled(this.activeDocId);
        this.updateTopBarState(enabled);

        if (enabled) {
            await this.updateDocNumbering(this.activeProtyle);
        }
    };

    private onEdited = async (e: CustomEvent) => {
        if (!this.activeDocId) return;
        if (!e.detail || !e.detail.cmd || e.detail.cmd !== "transactions") return;

        let hasHeaderChange = false;
        for (const transaction of e.detail.data) {
            for (const operation of transaction.doOperations) {
                const blockHtml = operation.data;
                if (/data-subtype="h\d"/.test(blockHtml)) {
                    hasHeaderChange = true;
                    break;
                }
            }
            if (hasHeaderChange) break;
        }

        if (hasHeaderChange) {
            this.shouldUpdate = true;
            this.queueUpdate();
        }
    };

    private onDocClosed = (_e: CustomEvent) => {
        this.topBarElement?.classList.remove("active");
    };

    private onDocSwitch = (e: CustomEvent) => {
        this.activeProtyle = e.detail.protyle;
        this.activeDocId = this.getDocId(this.activeProtyle);
        const enabled = this.isDocEnabled(this.activeDocId);
        this.updateTopBarState(enabled);
    };

    private queueUpdate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(async () => {
            if (this.shouldUpdate) {
                await this.updateDocNumbering(this.activeProtyle);
                this.shouldUpdate = false;
            }
            this.debounceTimer = null;
        }, DEBOUNCE_DELAY) as unknown as number;
    }

    private clearDebounceTimer() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    // ==================== 轮询机制 ====================

    private startPolling() {
        this.stopPolling();
        const interval = this.config.pollInterval;
        if (interval <= 0) return;

        this.pollTimer = window.setInterval(async () => {
            if (this.activeDocId && this.isDocEnabled(this.activeDocId) && this.activeProtyle) {
                await this.updateDocNumbering(this.activeProtyle);
            }
        }, interval * 1000) as unknown as number;
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private restartPolling() {
        this.startPolling();
    }

    private updateTopBarState(enabled: boolean) {
        if (this.topBarElement) {
            if (enabled) {
                this.topBarElement.classList.add("active");
            } else {
                this.topBarElement.classList.remove("active");
            }
        }
        this.updateStatusBarState(enabled);
    }

    // ==================== 文档启用/禁用 ====================

    private isDocEnabled(docId: string | null): boolean {
        if (!docId) return false;
        return docId in this.config.docEnableStatus
            ? this.config.docEnableStatus[docId]
            : this.config.defaultEnabled;
    }

    private enableDoc(docId: string | null) {
        if (!docId) return;
        this.config.docEnableStatus[docId] = true;
        this.saveConfig();
    }

    private disableDoc(docId: string | null) {
        if (!docId) return;
        this.shouldUpdate = false;
        this.clearDebounceTimer();
        this.config.docEnableStatus[docId] = false;
        this.saveConfig();
    }

    private getDocId(protyle: any): string | null {
        return protyle?.background?.ial?.id || null;
    }

    // ==================== 核心逻辑 ====================

    /**
     * 更新文档标题编号（增量更新：只更新序号发生变化的块）
     */
    private async updateDocNumbering(protyle: any) {
        const docId = this.getDocId(protyle);
        if (!docId) return;

        this.clearDebounceTimer();

        try {
            const headerBlocks = await getDocHeaderBlocks(docId);
            if (!headerBlocks || headerBlocks.length === 0) return;

            // 获取缓存
            const cachedNumbers = this.lastAppliedNumbers.get(docId) || new Map();

            // 在内存中清除已有序号，同时记录哪些块的内容被改变了
            const strippedBlockIds = new Set<string>();
            for (const block of headerBlocks) {
                if (!block.id) continue;
                const level = parseInt(block.subtype?.substring(1) || "0");
                if (level === 0) continue;

                const content = block.content || "";
                const cachedPrefix = cachedNumbers.get(block.id);
                const stripped = stripNumberPrefix(content, cachedPrefix, this.config.formats, level);
                if (stripped !== content) {
                    strippedBlockIds.add(block.id);
                }
                block.content = stripped;
            }

            // 计算新序号
            const headerNumbers = calculateHeaderNumbersForBlocks(
                headerBlocks,
                this.config.formats,
                this.config.useChineseNumbers,
                this.config.enabledLevels
            );

            // 增量对比：序号变化 OR 内容被剥离过（有旧序号需重写）
            const updates: Record<string, string> = {};
            const newCache = new Map<string, string>();

            for (const block of headerBlocks) {
                const blockId = block.id;
                if (!blockId) continue;

                const level = parseInt(block.subtype?.substring(1) || "0");
                if (level === 0) continue;

                const clearedContent = block.content || "";
                const number = headerNumbers[blockId];

                // 更新缓存
                if (number) {
                    newCache.set(blockId, number);
                }

                // 增量判断：序号前缀变化，或者剥离阶段发现有旧序号需要重写
                const oldPrefix = cachedNumbers.get(blockId);
                if (number !== oldPrefix || strippedBlockIds.has(blockId)) {
                    const markdownMarker = "#".repeat(level) + " ";
                    updates[blockId] = markdownMarker + number + clearedContent;
                }
            }

            // 更新缓存
            this.lastAppliedNumbers.set(docId, newCache);

            // 批量分块更新
            if (Object.keys(updates).length > 0) {
                await batchUpdateBlockContent(
                    updates,
                    "markdown",
                    this.canUseBulkApi(),
                    BATCH_CHUNK_SIZE
                );
            }

            this.updateTopBarState(true);
            this.shouldUpdate = false;
        } catch (error) {
            console.error(this.i18n.updateError, error);
            showMessage(this.i18n.updateErrorMsg);
        }
    }

    /**
     * 清除文档标题编号（无条件去除所有标题前的序号）
     */
    private async clearDocNumbering(protyle: any) {
        const docId = this.getDocId(protyle);
        if (!docId) return;

        try {
            const headerBlocks = await getDocHeaderBlocks(docId);
            if (!headerBlocks || headerBlocks.length === 0) return;

            const cachedNumbers = this.lastAppliedNumbers.get(docId) || new Map();
            const updates: Record<string, string> = {};

            for (const block of headerBlocks) {
                const blockId = block.id;
                if (!blockId) continue;

                const level = parseInt(block.subtype?.substring(1) || "0");
                if (level === 0) continue;

                const content = block.content || "";
                const cachedPrefix = cachedNumbers.get(blockId);
                // 无条件去除序号：用缓存前缀精确剥离 + 格式正则 + 通用正则兜底
                const newContent = stripNumberPrefix(content, cachedPrefix, this.config.formats, level);

                // 无条件更新所有标题块，确保序号被彻底清除
                const markdownMarker = "#".repeat(level) + " ";
                updates[blockId] = markdownMarker + newContent;
            }

            // 清除缓存
            this.lastAppliedNumbers.delete(docId);

            if (Object.keys(updates).length > 0) {
                await batchUpdateBlockContent(
                    updates,
                    "markdown",
                    this.canUseBulkApi(),
                    BATCH_CHUNK_SIZE
                );
            }
            this.updateTopBarState(false);
        } catch (error) {
            console.error(this.i18n.clearError, error);
            showMessage(this.i18n.clearErrorMsg);
        }
    }

    // ==================== 版本比较 ====================

    private canUseBulkApi(): boolean {
        return compareVersions(this.version, "3.1.25") >= 0;
    }
}
