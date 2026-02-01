"use strict";

var obsidian = require("obsidian");

// ============================================================================
// Constants
// ============================================================================
const VIEW_TYPE_UNUSED_ATTACHMENTS = "clean-unused-attachments-view";

// ============================================================================
// Default Settings
// ============================================================================
const DEFAULT_SETTINGS = {
    deleteOption: ".trash",
    logsModal: true,
    excludedFolders: "",
    excludeSubfolders: false,
    ribbonIcon: false,
    extensionMode: "all",      // "all" | "include" | "exclude"
    extensions: "png,jpg,jpeg,gif,bmp,svg,webp,pdf,mp4,mp3"
};

// ============================================================================
// Settings Tab
// ============================================================================
class SettingsTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Clean Unused Attachments" });

        // Ribbon Icon
        new obsidian.Setting(containerEl)
            .setName("Ribbon Icon")
            .setDesc("Show quick access icon in left ribbon")
            .addToggle(t => t.setValue(this.plugin.settings.ribbonIcon)
                .onChange(v => { this.plugin.settings.ribbonIcon = v; this.plugin.saveSettings(); this.plugin.refreshRibbon(); }));

        // Delete Destination
        new obsidian.Setting(containerEl)
            .setName("Delete Destination")
            .addDropdown(d => {
                d.addOption(".trash", "Obsidian Trash");
                d.addOption("system-trash", "System Trash");
                d.addOption("permanent", "Permanent Delete");
                d.setValue(this.plugin.settings.deleteOption);
                d.onChange(v => { this.plugin.settings.deleteOption = v; this.plugin.saveSettings(); });
            });

        // Excluded Folders
        new obsidian.Setting(containerEl)
            .setName("Excluded Folders")
            .setDesc("Comma-separated folder paths to exclude")
            .addTextArea(t => t.setValue(this.plugin.settings.excludedFolders)
                .onChange(v => { this.plugin.settings.excludedFolders = v; this.plugin.saveSettings(); }));

        new obsidian.Setting(containerEl)
            .setName("Exclude Subfolders")
            .addToggle(t => t.setValue(this.plugin.settings.excludeSubfolders)
                .onChange(v => { this.plugin.settings.excludeSubfolders = v; this.plugin.saveSettings(); }));

        containerEl.createEl("h3", { text: "Extension Filter" });

        // Extension Mode
        new obsidian.Setting(containerEl)
            .setName("Filter Mode")
            .setDesc("Which file types to scan")
            .addDropdown(d => {
                d.addOption("all", "All Files");
                d.addOption("include", "Include Only");
                d.addOption("exclude", "Exclude");
                d.setValue(this.plugin.settings.extensionMode);
                d.onChange(v => {
                    this.plugin.settings.extensionMode = v;
                    this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide extensions input
                });
            });

        // Extensions (only show if not "all")
        if (this.plugin.settings.extensionMode !== "all") {
            new obsidian.Setting(containerEl)
                .setName("Extensions")
                .setDesc("Comma-separated, e.g.: png,jpg,pdf")
                .addText(t => t.setValue(this.plugin.settings.extensions)
                    .onChange(v => { this.plugin.settings.extensions = v; this.plugin.saveSettings(); }));
        }
    }
}


// ============================================================================
// Sidebar View
// ============================================================================
class UnusedAttachmentsView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.unusedFiles = [];
        this.selected = new Set();
        this.isLoading = false;
        this.searchQuery = "";
        this.previewEl = null;
        this.lastDeletedBatch = []; // Store batch for undo
        this.hasScanned = false;    // Track if first scan completed
    }

    getViewType() { return VIEW_TYPE_UNUSED_ATTACHMENTS; }
    getDisplayText() { return "Clean Unused Attachments"; }
    getIcon() { return "search-check"; }

    async onOpen() {
        this.containerEl.addClass("cui-container");
        this.render();
        // Create global preview element
        this.previewEl = document.body.createDiv({ cls: "cui-preview-popover" });
        // Removed: await this.scan(); // Let user initiate first scan
    }

    render() {
        this.containerEl.empty();
        const main = this.containerEl.createDiv({ cls: "cui-main" });

        // Header
        const header = main.createDiv({ cls: "cui-header" });
        header.createEl("h4", { text: "Clean Unused Attachments" });

        const actions = header.createDiv({ cls: "cui-actions" });

        this.refreshBtn = actions.createEl("button", {
            text: "① Refresh",
            cls: "cui-text-btn cui-refresh-prime",
            title: "Start Scanning"
        });
        this.refreshBtn.onclick = (e) => {
            e.preventDefault();
            this.scan();
        };

        const exportBtn = actions.createEl("button", { text: "Export", cls: "cui-text-btn", title: "Export" });
        exportBtn.onclick = () => this.exportReport();

        // Delete & Undo Buttons (top right)
        const deleteGroup = actions.createDiv({ cls: "cui-delete-group" });

        this.undoBtn = deleteGroup.createEl("button", { text: "Undo", cls: "cui-undo-btn" });
        this.undoBtn.onclick = () => this.undoBatch();

        this.deleteBtn = deleteGroup.createEl("button", { text: "Delete", cls: "cui-delete-btn" });
        this.deleteBtn.onclick = () => this.deleteSelected();

        // Search Section (Fixed at top)
        const searchContainer = main.createDiv({ cls: "cui-search-container" });
        if (!this.hasScanned) searchContainer.addClass("cui-disabled");

        const searchWrapper = searchContainer.createDiv({ cls: "cui-search-wrapper" });
        const searchInput = searchWrapper.createEl("input", {
            type: "text",
            cls: "cui-search-input",
            placeholder: "Filter files..."
        });
        if (!this.hasScanned) searchInput.disabled = true;

        const clearBtn = searchWrapper.createDiv({ cls: "cui-search-clear", text: "×", title: "Clear search" });
        clearBtn.onclick = () => {
            searchInput.value = "";
            this.searchQuery = "";
            clearBtn.style.display = "none";
            this.renderList();
        };

        searchInput.oninput = (e) => {
            this.searchQuery = e.target.value.toLowerCase();
            clearBtn.style.display = this.searchQuery ? "flex" : "none";
            this.renderList();
        };

        // All/None/MSelect Buttons
        const selActions = searchContainer.createDiv({ cls: "cui-search-actions", style: "display:flex; gap:4px;" });
        const allBtn = selActions.createEl("button", { text: "All", cls: "cui-text-btn" });
        const noneBtn = selActions.createEl("button", { text: "None", cls: "cui-text-btn" });
        const mSelectBtn = selActions.createEl("button", { text: "MSelect", cls: "cui-text-btn", title: "Incremental Selection: adds only currently filtered files to your selection" });

        if (!this.hasScanned) {
            allBtn.disabled = noneBtn.disabled = mSelectBtn.disabled = true;
        }

        allBtn.onclick = () => this.selectAll(true);
        noneBtn.onclick = () => this.selectAll(false);
        mSelectBtn.onclick = () => this.selectFiltered();

        this.statsEl = header.createDiv({ cls: "cui-stats" });
        this.statsEl.style.display = "none";

        this.listEl = main.createDiv({ cls: "cui-list" });
        this.renderList();
    }

    renderList() {
        this.listEl.empty();

        if (!this.hasScanned) {
            this.renderWelcome();
            return;
        }

        let files = this.unusedFiles;
        if (this.searchQuery) {
            files = files.filter(f => f.name.toLowerCase().includes(this.searchQuery));
        }

        if (files.length === 0) {
            const empty = this.listEl.createDiv({ cls: "cui-empty" });
            if (this.unusedFiles.length === 0) {
                empty.createSpan({ cls: "cui-empty-icon", text: "✓" });
                empty.createSpan({ text: "All attachments are referenced" });
            } else {
                empty.createSpan({ text: "No matching files found" });
            }
        } else {
            files.forEach(f => this.renderItem(f));
        }

        // Update stats/delete button separately if needed, but for now scan() handles main stats.
        // Let's update delete button text at least based on selection visibility? 
        // Actually deleteSelected uses 'this.selected', which tracks paths regardless of visibility. 
        // That's fine.
    }

    renderWelcome() {
        const welcome = this.listEl.createDiv({ cls: "cui-welcome" });

        const hero = welcome.createDiv({ cls: "cui-welcome-hero" });
        obsidian.setIcon(hero.createDiv({ cls: "cui-welcome-icon" }), "search-check");
        hero.createEl("h1", { text: "Clean Unused Attachments" });
        hero.createEl("p", { text: "Efficiently identify and remove media files that are no longer referenced in your vault." });

        const steps = welcome.createDiv({ cls: "cui-welcome-steps" });
        const addStep = (num, title, desc) => {
            const step = steps.createDiv({ cls: "cui-welcome-step" });
            step.createDiv({ cls: "cui-step-num", text: num });
            const content = step.createDiv({ cls: "cui-step-content" });
            content.createDiv({ cls: "cui-step-title", text: title });
            content.createDiv({ cls: "cui-step-desc", text: desc });
        };

        addStep("①", "Scan Vault", "Click Refresh to analyze link references using a reverse-indexing algorithm.");
        addStep("②", "Verify Results", "Review the list of orphans. You can preview images or search to confirm usage.");
        addStep("③", "Clean Up", "Select items and click Delete to move them to your designated trash location.");

        welcome.createEl("div", {
            cls: "cui-welcome-algorithm",
            text: "Algorithm Note: This plugin performs a full-text scan of all Markdown files to build a reference index, ensuring even manually formatted links are detected."
        });
    }

    async scan() {
        if (this.isLoading) return;
        this.isLoading = true;
        this.hasScanned = true; // Mark as scanned
        this.render(); // Redraw UI to fix search box status
        this.refreshBtn?.addClass("cui-spinning");
        // this.selected.clear(); // Keep selection on refresh? Maybe better to clear.
        this.selected.clear();
        this.listEl.empty();

        const loading = this.listEl.createDiv({ cls: "cui-loading" });
        loading.createDiv({ cls: "cui-spinner" });
        loading.createSpan({ text: "Scanning..." });

        try {
            await this.performScan();
            loading.remove();
            this.statsEl.textContent = `Found ${this.unusedFiles.length} unused file${this.unusedFiles.length !== 1 ? 's' : ''}`;
            this.renderList();
        } catch (e) {
            loading.empty();
            loading.createSpan({ text: `Error: ${e.message}` });
        }

        this.refreshBtn?.removeClass("cui-spinning");
        this.isLoading = false;
        this.updateUI();
    }

    // ========================================================================
    // Core Detection: Reverse Index
    // ========================================================================
    async performScan() {
        const referencedNames = new Set();

        // Regex for explicit link syntax
        const wikiRegex = /!?\[\[([^\]\|#]+)/g;      // ![[path]] or [[path]] - stop at | or # or ]
        const mdRegex = /!?\[[^\]]*\]\(([^)#\s]+)/g; // ![](path) or [](path) - stop at # or space

        const allFiles = this.app.vault.getFiles();
        const mdFiles = allFiles.filter(f => f.extension === "md");

        // Build referenced names set
        for (const file of mdFiles) {
            try {
                const content = await this.app.vault.cachedRead(file);

                // Extract from wiki-links
                for (const match of content.matchAll(wikiRegex)) {
                    let linkPath = match[1].trim();
                    // Handle escaped characters at the end of the capture (e.g. before an escaped pipe \| or hash \#)
                    if (linkPath.endsWith("\\")) linkPath = linkPath.slice(0, -1);

                    const filename = linkPath.split(/[/\\]/).pop();
                    if (filename) referencedNames.add(filename.toLowerCase());
                }

                // Extract from markdown-links
                for (const match of content.matchAll(mdRegex)) {
                    let linkPath = match[1].trim();
                    // Decode URL-encoded paths
                    try { linkPath = decodeURIComponent(linkPath); } catch { }
                    const filename = linkPath.split(/[/\\]/).pop();
                    if (filename) referencedNames.add(filename.toLowerCase());
                }
            } catch { }
        }

        // Filter files
        const { extensionMode, extensions, excludedFolders, excludeSubfolders } = this.plugin.settings;
        const extSet = new Set(extensions.split(",").map(e => e.trim().toLowerCase()).filter(e => e));
        const excludeFolders = excludedFolders.split(",").map(f => f.trim()).filter(f => f);

        this.unusedFiles = [];

        for (const file of allFiles) {
            // Skip md files
            if (file.extension === "md") continue;

            // Extension filter
            const ext = file.extension.toLowerCase();
            if (extensionMode === "include" && !extSet.has(ext)) continue;
            if (extensionMode === "exclude" && extSet.has(ext)) continue;

            // Excluded folders
            let excluded = false;
            for (const folder of excludeFolders) {
                if (excludeSubfolders ? file.path.startsWith(folder) : file.parent?.path === folder) {
                    excluded = true;
                    break;
                }
            }
            if (excluded) continue;

            // Check if referenced
            if (!referencedNames.has(file.name.toLowerCase())) {
                file._parentPath = file.parent?.path || "/"; // Pre-cache path
                this.unusedFiles.push(file);
                this.selected.add(file.path);
            }
        }
    }

    renderItem(file) {
        const item = this.listEl.createDiv({ cls: "cui-item" });

        // Check if deleted
        if (file.deleted) {
            item.addClass("cui-deleted");
        }

        const cb = item.createEl("input", { type: "checkbox", cls: "cui-checkbox" });
        cb.checked = this.selected.has(file.path);
        cb.onchange = () => {
            cb.checked ? this.selected.add(file.path) : this.selected.delete(file.path);
            this.updateUI();
        };

        const thumb = item.createDiv({ cls: "cui-thumb" });
        if (/^(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(file.extension)) {
            const imgPath = this.app.vault.adapter.getResourcePath(file.path);
            const img = thumb.createEl("img");
            img.src = imgPath;
            img.onerror = () => { thumb.empty(); thumb.textContent = "📄"; };

            // Hover Preview logic
            thumb.onmouseenter = (e) => this.showPreview(e, imgPath);
            thumb.onmouseleave = () => this.hidePreview();
            thumb.onmousemove = (e) => this.movePreview(e);
        } else {
            thumb.textContent = "📄";
        }

        const info = item.createDiv({ cls: "cui-info" });
        const nameRow = info.createDiv({ cls: "cui-name-row" });

        const name = nameRow.createSpan({ cls: "cui-name", text: file.name });
        // Click to open file
        name.onclick = () => {
            if (file.deleted) return;
            this.app.workspace.openLinkText(file.path, "", true);
        };

        // Undo button (only if deleted)
        if (file.deleted) {
            const undoBtn = nameRow.createEl("button", { text: "Undo", cls: "cui-undo-btn" });
            undoBtn.onclick = (e) => {
                e.stopPropagation();
                this.undoDelete(file, item);
            };
        }

        const tools = nameRow.createDiv({ cls: "cui-tools" });
        if (!file.deleted) {
            const copyBtn = tools.createEl("button", { cls: "cui-tool-btn", title: "Copy filename" });
            copyBtn.createSpan({ text: "📋 Copy" });
            copyBtn.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(file.name); new obsidian.Notice("Copied!"); };

            const searchBtn = tools.createEl("button", { cls: "cui-tool-btn", title: "Search in vault" });
            searchBtn.createSpan({ text: "🔍 Search" });
            searchBtn.onclick = (e) => {
                e.stopPropagation();
                this.openSearch(file.name);
            };
        }

        const pathRow = info.createDiv({ cls: "cui-path" });
        pathRow.createSpan({ cls: "cui-path-label", text: "📂 " });
        const displayPath = file._parentPath || (file.parent?.path) || "/";
        pathRow.createSpan({ text: displayPath });
    }

    showPreview(e, src) {
        if (!this.previewEl) return;
        this.previewEl.empty();
        const img = this.previewEl.createEl("img");
        img.src = src;
        this.previewEl.addClass("cui-visible");
        this.movePreview(e);
    }

    hidePreview() {
        this.previewEl?.removeClass("cui-visible");
    }

    movePreview(e) {
        if (!this.previewEl) return;
        const offset = 15;
        let top = e.clientY + offset;
        let left = e.clientX + offset;

        // Boundary check (simple)
        if (top + 200 > window.innerHeight) top = e.clientY - 210;
        if (left + 200 > window.innerWidth) left = e.clientX - 210;

        this.previewEl.style.top = `${top}px`;
        this.previewEl.style.left = `${left}px`;
    }

    openSearch(query) {
        this.app.commands.executeCommandById("global-search:open");
        setTimeout(() => {
            const leaf = this.app.workspace.getLeavesOfType("search")[0];
            leaf?.view?.setQuery?.(`"${query}"`);
        }, 200);
    }

    async exportReport() {
        if (!this.unusedFiles.length) return new obsidian.Notice("Nothing to export");
        let md = `# Unused Attachments Report\n\nGenerated: ${new Date().toLocaleString()}\nTotal: ${this.unusedFiles.length}\n\n`;
        md += `| Filename | Path |\n|---|---|\n`;
        this.unusedFiles.forEach(f => md += `| ${f.name} | ${f.path} |\n`);

        const path = "Unused Attachments Report.md";
        const existing = this.app.vault.getAbstractFileByPath(path);
        existing ? await this.app.vault.modify(existing, md) : await this.app.vault.create(path, md);
        new obsidian.Notice(`Saved: ${path}`);
        this.app.workspace.openLinkText(path, "", true);
    }

    selectAll(select) {
        this.listEl.querySelectorAll(".cui-checkbox").forEach(cb => cb.checked = select);
        select ? this.unusedFiles.forEach(f => this.selected.add(f.path)) : this.selected.clear();
        this.updateUI();
    }

    selectFiltered() {
        if (!this.searchQuery) return;
        const filtered = this.unusedFiles.filter(f => f.name.toLowerCase().includes(this.searchQuery));
        filtered.forEach(f => this.selected.add(f.path));
        this.renderList();
        this.updateUI();
    }

    updateUI() {
        let toDelete = 0;
        let toUndo = 0;

        this.unusedFiles.forEach(f => {
            if (this.selected.has(f.path)) {
                if (f.deleted) toUndo++;
                else toDelete++;
            }
        });

        if (this.deleteBtn) {
            this.deleteBtn.textContent = toDelete > 0 ? `Delete (${toDelete})` : "Delete";
            this.deleteBtn.toggleClass("cui-delete-active", toDelete > 0);
            this.deleteBtn.disabled = toDelete === 0;
        }

        if (this.undoBtn) {
            this.undoBtn.style.display = "inline-block";
            this.undoBtn.textContent = toUndo > 0 ? `Undo (${toUndo})` : "Undo";
            this.undoBtn.disabled = toUndo === 0;
        }
    }

    async deleteSelected() {
        if (!this.selected.size) return;
        const toDelete = this.unusedFiles.filter(f => this.selected.has(f.path) && !f.deleted);
        const opt = this.plugin.settings.deleteOption;

        this.lastDeletedBatch = []; // Start new batch
        let count = 0;
        for (const file of toDelete) {
            try {
                if (opt === ".trash") await this.app.vault.trash(file, false);
                else if (opt === "system-trash") await this.app.vault.trash(file, true);
                else await this.app.vault.delete(file);

                // Mark as deleted in state
                file.deleted = true;
                file.originalPath = file.path;
                file._parentPath = file.parent?.path || "/";
                this.selected.delete(file.path);
                this.lastDeletedBatch.push(file); // Track for batch undo
                count++;
            } catch (e) {
                new obsidian.Notice(`Error deleting ${file.name}: ${e.message}`);
            }
        }

        if (count > 0) {
            new obsidian.Notice(`Deleted ${count} file(s).`);
            this.renderList();
            this.updateUI();
        }
    }

    async undoBatch() {
        const toUndo = this.unusedFiles.filter(f => this.selected.has(f.path) && f.deleted);
        if (!toUndo.length) return;

        let restored = 0;
        const adapter = this.app.vault.adapter;

        for (const file of toUndo) {
            try {
                // NOTE: Similar logic to undoDelete
                const trashPath = ".trash/" + file.name;
                if (await adapter.exists(trashPath)) {
                    await adapter.rename(trashPath, file.originalPath);
                    file.deleted = false;
                    restored++;
                }
            } catch (e) {
                console.error("Undo failed for", file.name, e);
            }
        }

        if (restored > 0) {
            new obsidian.Notice(`Restored ${restored} file(s).`);
            this.renderList();
            this.updateUI();
        } else {
            new obsidian.Notice("Could not restore selected files (not found in .trash).");
        }
    }

    async undoDelete(file, itemEl) {
        try {
            // NOTE: This only works robustly if using Obsidian Trash (.trash)
            // We need to find the file in trash.
            // Simplified: we try to restore to 'file.originalPath' from '.trash/file.name'

            const trashPath = ".trash/" + file.name;

            const adapter = this.app.vault.adapter;
            // Check if file exists in trash (approximate check)
            let existsInTrash = await adapter.exists(trashPath);

            if (!existsInTrash) {
                new obsidian.Notice("Cannot undo: File not found in Obsidian trash.");
                return;
            }

            // Restore
            await adapter.rename(trashPath, file.originalPath);

            // Reset state
            file.deleted = false;
            new obsidian.Notice(`Restored ${file.name}`);
            this.renderList();

        } catch (e) {
            new obsidian.Notice("Undo failed: " + e.message);
        }
    }

    async onClose() { this.containerEl.empty(); }
}

// ============================================================================
// Main Plugin
// ============================================================================
class CleanUnusedAttachmentsPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_UNUSED_ATTACHMENTS, leaf => new UnusedAttachmentsView(leaf, this));
        this.addCommand({ id: "open-view", name: "Clean Unused Attachments", callback: () => this.activateView() });
        this.addSettingTab(new SettingsTab(this.app, this));
        this.refreshRibbon();
    }

    onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE_UNUSED_ATTACHMENTS); }

    refreshRibbon = () => {
        this.ribbonEl?.remove();
        if (this.settings.ribbonIcon) {
            this.ribbonEl = this.addRibbonIcon("search-check", "Clean Unused Attachments", () => this.activateView());
        }
    };

    async activateView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNUSED_ATTACHMENTS);
        if (leaves.length) {
            this.app.workspace.revealLeaf(leaves[0]);
            leaves[0].view?.scan?.();
        } else {
            await this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE_UNUSED_ATTACHMENTS, active: true });
        }
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

module.exports = CleanUnusedAttachmentsPlugin;