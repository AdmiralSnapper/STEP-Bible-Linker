const { Plugin, PluginSettingTab, Modal, MarkdownRenderer, ItemView, Setting, requestUrl } = require('obsidian');

//SETTINGS ======================================================================
/**
 * @typedef {Object} StepBibleLinkerSettings
 * @property {boolean} autoSyncOnNavigation - If true, STEP auto-syncs on navigation
 * @property {boolean} autoCloseSearchPanel - If true, the STEP search panel auto-closes when switching to a non-STEP tab
 * @property {boolean} useLocalUrlPrefix - If true, use local URL prefix.
 * @property {string[]} enabledVersions - List of STEP Bible versions to include in generated links
 */

/** @type {StepBibleLinkerSettings} */
const DEFAULT_SETTINGS = {
    autoSyncOnNavigation: true,
    autoCloseSearchPanel: true,
    enabledVersions: ["ESV", "THOT", "SBLG"],
    useLocalUrlPrefix: true,
};

class StepBibleLinkerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "STEP Bible Linker Settings" });

        new Setting(containerEl)
            .setName("Auto-Search from Webviewer")
            .setDesc("Automatically update the left search panel when navigating inside STEP Bible.")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.autoSyncOnNavigation)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSyncOnNavigation = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Auto-Close Search Panel")
            .setDesc("Automatically close the search panel when switching to a non-STEP tab.")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.autoCloseSearchPanel)
                    .onChange(async (value) => {
                        this.plugin.settings.autoCloseSearchPanel = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Use STEP localhost.")
            .setDesc("Toggle between local STEP localhost and online STEP website. This will need to be installed on your computer and running.")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.useLocalStepServer)
                    .onChange(async (value) => {
                        this.plugin.settings.useLocalStepServer = value;
                        await this.plugin.saveSettings();

                        // Optional: rewrite links to match new prefix
                        await this.plugin.toggleLocaltoOnline();

                        this.display();
                    });
            });


        //BIBLE VERSION TOGGLES ==========================================================================
        containerEl.createEl("h3", { text: "Bible Versions Enabled" });

        new Setting(containerEl)
            .setName("Enable ESV")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("ESV"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("ESV", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display();
                    });
            });

        new Setting(containerEl)
            .setName("Enable NIV")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("NIV"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("NIV", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display(); 
                    });
            });

        new Setting(containerEl)
            .setName("Enable KJV")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("KJV"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("KJV", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display(); 
                    });
            });

        new Setting(containerEl)
            .setName("Enable THOT")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("THOT"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("THOT", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display(); 
                    });
            });

        new Setting(containerEl)
            .setName("Enable SBLG")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("SBLG"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("SBLG", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display(); 
                    });
            });

        new Setting(containerEl)
            .setName("Enable LXX")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.enabledVersions.includes("LXX"))
                    .onChange(async (value) => {
                        this.plugin.toggleVersion("LXX", value);
                        await this.plugin.saveSettings();

                        // Rewrite all STEP links to match new version list
                        await this.plugin.rewriteStepLinks();
                        //Refresh UI to reflect changes in version order
                        this.display(); 
                    });
            });

        

        // VERSION REORDERING ==========================================================================
        containerEl.createEl("h3", { text: "Version Order" });

        const versions = this.plugin.settings.enabledVersions;

        versions.forEach((version, index) => {
            const setting = new Setting(containerEl)
                .setName(version)
                .setDesc("Order determines display order in STEP Bible.");

            // Move up
            setting.addButton(btn => {
                btn.setButtonText("↑")
                    .setDisabled(index === 0)
                    .onClick(async () => {
                        this.plugin.moveVersion(index, index - 1);
                        await this.plugin.saveSettings();

                        // IMPORTANT: re-read updated version list
                        this.plugin.settings.enabledVersions = [...this.plugin.settings.enabledVersions];

                        await this.plugin.rewriteStepLinks();
                        this.display();
                    });
            });

            // Move down
            setting.addButton(btn => {
                btn.setButtonText("↓")
                    .setDisabled(index === versions.length - 1)
                    .onClick(async () => {
                        this.plugin.moveVersion(index, index + 1);
                        await this.plugin.saveSettings();

                        // IMPORTANT: re-read updated version list
                        this.plugin.settings.enabledVersions = [...this.plugin.settings.enabledVersions];

                        await this.plugin.rewriteStepLinks();
                        this.display();
                    });
            });
        });

    }
}

//SEARCH VIEW ===================================================================
const STEP_SEARCH_VIEW = "step-search-view";

class StepSearchView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;

        this.searchInProgress = false;
        this.pendingQuery = null;
    }

    getViewType() {
        return STEP_SEARCH_VIEW;
    }

    getDisplayText() {
        return "STEP Search";
    }

    getIcon() {
        return "book-open-text";
    }

    onOpen() {
        const container = this.containerEl.children[1];
        container.empty();

        // Search input
        this.queryBox = container.createEl("input", {
            type: "text",
            placeholder: "STEP search…"
        });

        this.queryBox.style.width = "100%";
        this.queryBox.style.marginBottom = "10px";
        this.queryBox.readOnly = true;
        this.queryBox.style.backgroundColor = "#3b3b3b";
        this.queryBox.style.color = "#b9b9b9";
        this.queryBox.style.fontWeight = "bold";

        // CLICK LISTENER TO OPEN BIBLE SEARCH MODAL
        this.queryBox.addEventListener("click", async () => {
            const { MarkdownView } = require("obsidian");
            const plugin = this.plugin;

            let prefill = "";
            const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);

            if (activeView && activeView.editor) {
                prefill = activeView.editor.getSelection() || "";
            } else {
                try {
                    prefill = window.getSelection()?.toString() || "";
                } catch {
                    prefill = "";
                }
            }

            // NEW: open the refactored modal directly
            const modal = new StepBibleSearchModal(plugin.app, plugin, prefill);
            modal.open();
        });



        // Loading indicator
        this.searchLoadingIndicator = container.createEl("div", {
            text: "Searching…"
        });
        this.searchLoadingIndicator.style.display = "none";
        this.searchLoadingIndicator.style.marginBottom = "10px";
        this.searchLoadingIndicator.style.color = "#888";
        this.searchLoadingIndicator.style.fontSize = "0.75em";

        // Results area
        this.resultsEl = container.createEl("div");

        // Tooltip container (hover preview)
        this.hoverBox = document.body.createEl("div");
        this.hoverBox.style.position = "fixed";
        this.hoverBox.style.zIndex = "999999";
        this.hoverBox.style.display = "none";
        this.hoverBox.style.maxWidth = "300px";
        this.hoverBox.style.padding = "10px";
        this.hoverBox.style.borderRadius = "6px";
        this.hoverBox.style.backgroundColor = "var(--background-primary)";
        this.hoverBox.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
        this.hoverBox.style.fontSize = "0.85em";
        this.hoverBox.style.lineHeight = "1.4";
    }

    updateQuery(queryRef, displayRef) {
        // Update the query box to contain the formatted reference
        if (this.queryBox) {
            this.queryBox.value = displayRef;
        }

        // Run a search based on the query array.
        this.runSearch(queryRef);
    }

    async runSearch(queryRef) {
        if (this.searchInProgress) {
            this.pendingQuery = queryRef;
            return;
        }

        this.searchInProgress = true;
        this.showLoading();
        this.resultsEl.empty();

        if (!Array.isArray(queryRef) || queryRef.length === 0) {
            this.resultsEl.createEl("div", { text: "No query." });
            this.searchInProgress = false;
            return;
        }

        const files = this.plugin.app.vault.getMarkdownFiles();

        // Build regex list once
        const regexList = queryRef.map(q => new RegExp(`${q}(?:[.:\\-]|&)`));

        const matchedFiles = [];

        // PRE‑SCAN FILES FOR MATCHES + COUNT LINKS
        for (const file of files) {
            const text = await this.plugin.app.vault.read(file);

            // Does the file contain ANY match?
            const fileMatches = regexList.some(rx => rx.test(text));
            if (!fileMatches) continue;

            // Count matching links BEFORE rendering
            let linkCount = 0;

            // Extract all hrefs from Markdown links
            const hrefScan = [...text.matchAll(/\(([^)]+)\)/g)];

            for (const [, href] of hrefScan) {
                if (regexList.some(rx => rx.test(href))) {
                    linkCount++;
                }
            }

            matchedFiles.push({ file, linkCount });
        }

        this.hideLoading();

        if (matchedFiles.length === 0) {
            const msg = this.resultsEl.createEl("div", { text: "No notes found." });
            msg.style.color = "#414141"; 
            msg.style.fontSize = "0.75em";
        } else {
            let activeInlinePreview = null;

            for (const { file, linkCount } of matchedFiles) {

                const item = this.resultsEl.createEl("div");
                item.style.transition = "background-color 0.15s ease";
                item.style.padding = "4px 6px";
                item.style.borderRadius = "2px";
                item.addEventListener("mouseenter", () => item.style.backgroundColor = "var(--background-modifier-hover)");
                item.addEventListener("mouseleave", () => item.style.backgroundColor = "");
                item.style.display = "flex";
                item.style.alignItems = "center";
                item.style.gap = "10px";
                item.style.marginBottom = "4px";
                item.style.fontSize = "0.9em";
                item.style.lineHeight = "1.4";

                
                // Circle badge (number always visible, subtle background)
                const circleBtn = item.createEl("div");
                circleBtn.classList.add("circle-btn");
                circleBtn.setAttribute("data-count", linkCount);
                circleBtn.style.width = "22px";
                circleBtn.style.height = "22px";
                circleBtn.style.borderRadius = "4px";
                circleBtn.style.flexShrink = "0";
                circleBtn.style.display = "flex";
                circleBtn.style.alignItems = "center";
                circleBtn.style.justifyContent = "center";
                circleBtn.style.fontSize = "0.75em";
                circleBtn.style.cursor = "pointer";
                circleBtn.style.userSelect = "none";
                circleBtn.style.transition = "all 0.15s ease";
                circleBtn.style.backgroundColor = "var(--background-modifier-border)";
                circleBtn.style.color = "var(--text-normal)";
                circleBtn.textContent = linkCount > 0 ? linkCount : "";
                circleBtn.onmouseenter = () => {
                    // Only highlight if dropdown is open
                    if (activeInlinePreview && activeInlinePreview.item === item) {
                        circleBtn.style.backgroundColor = "var(--interactive-accent)";
                        circleBtn.style.color = "white";
                    }
                };
                circleBtn.onmouseleave = () => {
                    // Only un-highlight if dropdown is open
                    if (activeInlinePreview && activeInlinePreview.item === item) {
                        circleBtn.style.backgroundColor = "var(--background-modifier-border)";
                        circleBtn.style.color = "var(--text-normal)";
                    }
                };

                // Title text (click to open note)
                const titleEl = item.createEl("span", { text: file.basename });
                titleEl.style.cursor = "pointer";
                titleEl.style.flexGrow = "1";

                // Right‑side open button
                const openBtn = item.createEl("div");
                openBtn.innerHTML = `<span class="external-link"></span>`;  // ← replace ICON_NAME
                openBtn.style.marginLeft = "auto"; // pushes icon to the far right
                openBtn.style.cursor = "pointer";
                openBtn.style.fontSize = "1.1em";
                openBtn.style.color = "var(--interactive-accent)";
                openBtn.style.opacity = "0.85";
                openBtn.style.padding = "2px 4px";
                openBtn.style.borderRadius = "4px";
                openBtn.onmouseenter = () => {
                    openBtn.style.opacity = "1";
                    openBtn.style.backgroundColor = "var(--background-modifier-hover)";
                };
                openBtn.onmouseleave = () => {
                    openBtn.style.opacity = "0.85";
                    openBtn.style.backgroundColor = "";
                };
                openBtn.onclick = () => {
                    if (file) {
                        this.plugin.app.workspace.getLeaf(true).openFile(file);
                    }
                };

                // Shared state for preview + cycling
                let previewLinks = [];
                let cycleIndex = 0;

                // Highlight only the currently selected reference
                const highlightCurrent = () => {
                    previewLinks.forEach((link, index) => {
                        if (index === cycleIndex - 1) {
                            // Your exact highlight convention
                            link.style.textDecoration = "none";
                            link.style.textShadow = "none";
                            link.style.backgroundColor = "rgba(89, 89, 89, 0.35)";
                            link.style.borderRadius = "3px";
                        } else {
                            link.style.backgroundColor = "";
                            link.style.borderRadius = "";
                        }
                    });
                };

                // Extract preview-opening logic into a function
                const openPreview = async () => {

                    // If another preview is open, close it AND reset its circle
                    if (activeInlinePreview && activeInlinePreview.item !== item) {

                        // Collapse the old preview
                        activeInlinePreview.wrapper.style.maxHeight = "0";

                        // Reset the old circle to closed state
                        const oldCircle = activeInlinePreview.item.querySelector(".circle-btn");
                        if (oldCircle) {
                            oldCircle.style.backgroundColor = "var(--background-modifier-border)";
                            oldCircle.style.color = "var(--text-normal)";

                            // Restore plain count
                            const oldCount = oldCircle.getAttribute("data-count");
                            oldCircle.textContent = oldCount || "";
                        }

                        activeInlinePreview = null;
                    }

                    // If already open, do nothing
                    if (activeInlinePreview && activeInlinePreview.item === item) {
                        return;
                    }

                    // Circle enters "active but not hovered" state
                    circleBtn.style.backgroundColor = "var(--background-modifier-border-hover)";
                    circleBtn.style.color = "var(--text-normal)";

                    // Create wrapper for animation
                    const wrapper = document.createElement("div");
                    wrapper.style.overflow = "hidden";
                    wrapper.style.maxHeight = "0";
                    wrapper.style.transition = "max-height 0.25s ease";

                    // Create preview box
                    const preview = document.createElement("div");
                    preview.style.padding = "10px";
                    preview.style.margin = "6px 0 12px 0";
                    preview.style.borderRadius = "6px";
                    preview.style.backgroundColor = "var(--background-primary)";
                    preview.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";
                    preview.style.fontSize = "0.85em";
                    preview.style.lineHeight = "1.4";
                    preview.style.maxHeight = "300px";
                    preview.style.overflowY = "auto";

                    wrapper.appendChild(preview);
                    item.insertAdjacentElement("afterend", wrapper);

                    // Load full file
                    const fullText = await this.plugin.app.vault.read(file);

                    // Render full Markdown file
                    preview.empty();
                    await MarkdownRenderer.render(
                        this.plugin.app,
                        fullText,
                        preview,
                        this.plugin.app.workspace.getActiveFile()?.path || "",
                        this.plugin
                    );

                    // Remove tooltip + keep links clickable
                    preview.querySelectorAll("a").forEach(a => {
                        a.removeAttribute("title");
                        a.addEventListener("click", (ev) => {
                            ev.preventDefault();
                            window.open(a.href, "_blank");
                        });
                    });

                    // Find matching links in rendered preview
                    previewLinks = [];
                    const links = Array.from(preview.querySelectorAll("a"));

                    links.forEach(a => {
                        if (regexList.some(rx => rx.test(a.href))) {
                            previewLinks.push(a);
                        }
                    });

                    // Start at first match
                    cycleIndex = 1;
                    circleBtn.textContent = `${cycleIndex}/${previewLinks.length}`;

                    // Highlight first match
                    highlightCurrent();

                    // Scroll to first match
                    if (previewLinks.length > 0) {
                        const firstTarget = previewLinks[0];
                        firstTarget.scrollIntoView({
                            block: "center",
                            behavior: "smooth"
                        });
                    }

                    // Animate open
                    requestAnimationFrame(() => {
                        wrapper.style.maxHeight = preview.scrollHeight + "px";
                    });

                    activeInlinePreview = { item, wrapper, preview };
                };

                // Title click toggles dropdown
                titleEl.onclick = async () => {

                    // If open → close it
                    if (activeInlinePreview && activeInlinePreview.item === item) {

                        activeInlinePreview.wrapper.style.maxHeight = "0";
                        activeInlinePreview = null;

                        // Circle returns to closed state
                        circleBtn.style.backgroundColor = "var(--background-modifier-border)";
                        circleBtn.style.color = "var(--text-normal)";
                        circleBtn.textContent = linkCount > 0 ? linkCount : "";

                        cycleIndex = 1;
                        return;
                    }

                    // If closed → open it
                    await openPreview();

                    // Show cycling index
                    circleBtn.textContent = `1/${previewLinks.length}`;
                    cycleIndex = 1;
                };


                circleBtn.onclick = async () => {

                    // If dropdown is closed → open it
                    if (!activeInlinePreview || activeInlinePreview.item !== item) {
                        await openPreview();

                        // Set active state
                        circleBtn.style.backgroundColor = "var(--interactive-accent)";
                        circleBtn.style.color = "white";

                        circleBtn.textContent = `1/${previewLinks.length}`;
                        cycleIndex = 1;
                        return;
                    }

                    // If dropdown is open → cycle
                    if (previewLinks.length === 0) return;

                    cycleIndex = (cycleIndex % previewLinks.length) + 1;
                    circleBtn.textContent = `${cycleIndex}/${previewLinks.length}`;

                    highlightCurrent();

                    const previewEl = activeInlinePreview.preview;
                    const target = previewLinks[cycleIndex - 1];

                    if (target) {
                        target.scrollIntoView({
                            block: "center",
                            behavior: "smooth"
                        });
                    }                  
                };

                // Hover behavior (only when dropdown is open)
                circleBtn.onmouseenter = () => {
                    if (activeInlinePreview && activeInlinePreview.item === item) {
                        circleBtn.style.backgroundColor = "var(--interactive-accent)";
                        circleBtn.style.color = "white";
                    }
                };

                circleBtn.onmouseleave = () => {
                    if (activeInlinePreview && activeInlinePreview.item === item) {
                        circleBtn.style.backgroundColor = "var(--background-modifier-border-hover)";
                        circleBtn.style.color = "var(--text-normal)";
                    }
                };
            }
        }

        this.searchInProgress = false;

        if (this.pendingQuery) {
            const nextQuery = this.pendingQuery;
            this.pendingQuery = null;
            this.runSearch(nextQuery);
        }
    }

    showLoading() {
        this.searchLoadingIndicator.style.display = "block";
    }

    hideLoading() {
        this.searchLoadingIndicator.style.display = "none";
    }

    extractParagraphMatchingQuery(text, queryArray) {
        const paragraphs = text.split(/\n\s*\n/);

        for (const p of paragraphs) {
            for (const q of queryArray) {
                const regex = new RegExp(`${q}(?:[.-]|&)`);
                if (regex.test(p)) {
                    return p.trim();
                }
            }
        }

        return null;
    }
}

class StepBibleSearchModal extends Modal {
    constructor(app, plugin, prefill = "") {
        super(app);
        this.plugin = plugin;
        this.prefill = prefill;
    }

    async openStepUrl(url) {
        const localUp = await this.plugin.isLocalStepRunning();
        if (!localUp) {
            url = this.plugin.localUrl_onlineUrl(url);
        } else {
            try {
                const { requestUrl } = require("obsidian");
                const res = await requestUrl({ url, method: "GET", throw: false });
                if (!(res.status >= 200 && res.status < 400)) {
                    url = this.plugin.localUrl_onlineUrl(url);
                }
            } catch {
                url = this.plugin.localUrl_onlineUrl(url);
            }
        }

        window.open(url, "_blank");
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "column";
        contentEl.style.gap = "14px";
        contentEl.style.padding = "12px";

        const input = contentEl.createEl("input", {
            type: "text",
            placeholder: "Enter Reference"
        });

        input.style.width = "100%";
        input.style.margin = "0";
        input.style.padding = "10px 10px";
        input.style.fontSize = "14px";
        input.style.fontWeight = "bold";
        input.style.borderRadius = "4px";
        input.style.border = "1px solid var(--interactive-accent)";

        if (this.prefill && this.prefill.trim()) {
            input.value = this.prefill.trim();
            input.select();
        }

        this._keydownHandler = async (evt) => {
            if (evt.key === "Enter") {
                evt.preventDefault();
                evt.stopPropagation();

                const inputRef = (input.value || "").trim();
                const regex = this.plugin.buildInputRefRegex();
                const match = inputRef.match(regex);

                //Check if input ref matches regex
                if (!match || match[0].trim() !== inputRef) {
                    new Notice("Not a valid Bible reference.");
                    return;
                }

                const urlRef = this.plugin.inputRef_urlRef(inputRef);
                const url = this.plugin.urlRef_url(urlRef);

                //If no url was produced, fail silently. A warning will appear called by inputRef_urlRef()
                if (!urlRef) return;

                if (url) await this.openStepUrl(url);

                this.close();
            }
        };

        input.addEventListener("keydown", this._keydownHandler);
        input.focus();
    }

    onClose() {
        const input = this.contentEl.querySelector("input");
        if (input && this._keydownHandler) {
            input.removeEventListener("keydown", this._keydownHandler);
        }
        this.contentEl.empty();
    }
}

// PLUGIN =======================================================================
module.exports = class StepBibleLinkerPlugin extends Plugin {
    /** @type {StepBibleLinkerSettings} */
    settings;

    async onload() {

        console.log('STEP Bible Linker Loaded.');
        this.activePopover = null;

        // Load settings and add settings tab
        await this.loadSettings();
        this.addSettingTab(new StepBibleLinkerSettingTab(this.app, this));
        
        // REGISTER SEARCH VIEW
        this.registerView(
            STEP_SEARCH_VIEW,
            (leaf) => new StepSearchView(leaf, this)
        );

        // DETECT AND LINK INPUT REF AT CURSOR 
        this.addCommand({
            id: 'auto-link-step-ref',
            name: 'Link/Unlink Reference at Cursor',
            editorCallback: (editor) => {

                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);

                // --- 1. First: detect raw inputRef and link it ---
                const detected = this.detectInputRef(line, cursor.ch);

                if (detected) {
                    const { inputRef, start, end } = detected;

                    const before = line.slice(0, start);
                    const after = line.slice(end);

                    // Already linked?
                    if (!(before.endsWith("[") && after.startsWith("]"))) {
                        const urlRef = this.inputRef_urlRef(inputRef);
                        const displayRef = this.urlRef_displayRef(urlRef);
                        const url = this.urlRef_url(urlRef);

                        const stepLink = `([${displayRef}](${url}))`;

                        const newLine = line.slice(0, start) + stepLink + line.slice(end);
                        editor.setLine(cursor.line, newLine);

                        editor.setCursor({
                            line: cursor.line,
                            ch: start + stepLink.length
                        });
                    }

                    return; // IMPORTANT: stop here if linking happened
                }

                // --- 2. If no raw ref detected: check for existing STEP link and unlink it ---
                const stepLinkRegex = /\(\[([^\]]+)\]\(([^)]+reference=[^)]+)\)\)/g;

                let match;
                while ((match = stepLinkRegex.exec(line)) !== null) {
                    const start = match.index;
                    const end = start + match[0].length;

                    // Cursor inside the link?
                    if (cursor.ch >= start && cursor.ch <= end) {
                        const displayRef = match[1];

                        const newLine = line.slice(0, start) + displayRef + line.slice(end);
                        editor.setLine(cursor.line, newLine);

                        editor.setCursor({
                            line: cursor.line,
                            ch: start + displayRef.length
                        });

                        return;
                    }
                }

                new Notice("No reference detected");
            }
        });

        // SEARCH BASED ON STEP URL
        this.addCommand({
            id: "step-sync-search-panel",
            name: "Update STEP Search Panel",
            callback: async () => {

                const leaf = this.app.workspace.activeLeaf;
                if (!leaf) return;

                const view = leaf.view;
                if (!view) return;

                if (view.getViewType?.() !== "webviewer") return;

                // Get URL from view or webview fallback
                let url = view.url;
                if (view.webview?.getURL) {
                    try {
                        url = view.webview.getURL();
                    } catch { }
                }

                if (!url) return;

                // FIX: ensure webviewEl exists
                const webviewEl = view.webview;
                if (!webviewEl) return;

                await this.searchWebviewUrl(url, webviewEl);

                console.log("STEP Sync: Manual search panel update complete.");
            }
        });

        // SEARCH BASED ON STEP URL AUTOMATICALLY
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", async (leaf) => {
                if (!this.settings.autoSyncOnNavigation) return;

                const view = leaf?.view;
                if (!view) return;

                if (view.getViewType?.() !== "webviewer") return;
                const webviewEl = view.webview;
                if (!webviewEl) return;

                // Reset dedupe on tab switch
                webviewEl.__lastProcessedRef = null;

                // TAB SWITCHING — view.url is correct here
                await this.searchWebviewUrl(view.url, webviewEl);

                //
                // ALWAYS attach listeners fresh — WebView is recreated on tab switch
                //
                webviewEl.addEventListener("did-finish-load", async () => {
                    const currentUrl = webviewEl.getURL();
                    await this.searchWebviewUrl(currentUrl, webviewEl);
                });

                webviewEl.addEventListener("did-navigate-in-page", async () => {
                    const currentUrl = webviewEl.getURL();
                    await this.searchWebviewUrl(currentUrl, webviewEl);
                });
            })
        );

        // CLOSE SEARCH PANEL WHEN TAB CHANGES — BUT NOT WHEN SEARCH TAB IS FOCUSED
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                if (!this.settings.autoCloseSearchPanel) return;

                const view = leaf?.view;
                if (!view) return;

                if (leaf.getRoot() !== this.app.workspace.rootSplit) {
                    // Focus is NOT in the main editor area → do nothing
                    return;
                }

                // If the focused tab IS the STEP Search panel → do nothing
                if (view.getViewType?.() === "step-search-view") {
                    return;
                }

                // If the focused tab is NOT a webviewer → close search panel
                if (view.getViewType?.() !== "webviewer") {
                    this.minimiseLeftLeaf();
                    return;
                }

                // It's a webviewer — check URL
                const webviewEl = view.webview;
                if (!webviewEl) {
                    this.minimiseLeftLeaf();
                    return;
                }

                let url = null;

                try {
                    // Try the live webview URL first
                    url = webviewEl.getURL?.();
                } catch (e) {
                    // WebView not ready — ignore silently
                }

                // If URL does NOT contain reference= → close search panel
                if (!url || !url.includes("reference=")) {
                    this.minimiseLeftLeaf();
                    return;
                }

                // Otherwise: keep search panel open
            })
        );

        // HOVERING HANDLER
        this.registerDomEvent(document, "mouseover", async (evt) => {
            const targetEl = evt.target;
            if (!targetEl) return;

            let url = "";

            const lineParent = targetEl.closest(".cm-line");
            if (lineParent) {
                const m = lineParent.textContent.match(/https?:\/\/[^\s)]+/);
                if (m) url = m[0];
            }

            if (!url) {
                const a = targetEl.closest("a[href]");
                if (a && a.href.startsWith(this.urlPrefix)) {
                    url = a.href;
                }
            }

            if (!url) {
                const u = targetEl.closest(".cm-underline");
                if (u) {
                    const t = u.textContent.trim();
                    const refPattern =
                        /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*(?:\s+\d+(?::\d+)?(?:\s*-\s*\d+(?::\d+)?)?)?$/;

                    if (refPattern.test(t)) {
                        const urlRef = this.inputRef_urlRef(t);
                        if (urlRef) {
                            const builtUrl = this.urlRef_url(urlRef);
                            if (builtUrl) url = builtUrl;
                        }
                    }
                }
            }


            if (!url || !url.startsWith(this.urlPrefix)) return;

            if (this.activePopover) {
                this.activePopover.remove();
                this.activePopover = null;
            }

            const pop = document.createElement("div");
            pop.classList.add("step-popover");
            Object.assign(pop.style, {
                position: "fixed",
                left: "-9999px",
                top: "-9999px",
                visibility: "hidden",
                backgroundColor: "#2c2c2c",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                padding: "14px",
                width: "460px",
                maxHeight: "350px",
                overflowY: "auto",
                boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
                zIndex: "1000000",
                color: "#d6d6d6",
                fontSize: "13.5px",
                lineHeight: "1.6",
                fontFamily: "var(--font-interface)"
            });

            pop.innerHTML = "<i>Loading STEP Bible…</i>";
            document.body.appendChild(pop);

            const rect = pop.getBoundingClientRect();
            let leftPos = evt.clientX + 15;
            if (leftPos + rect.width > window.innerWidth) {
                leftPos = evt.clientX - rect.width - 15;
            }

            pop.style.left = `${leftPos}px`;
            pop.style.top = `${evt.clientY + 15}px`;
            pop.style.visibility = "visible";

            this.activePopover = pop;

            let hideTimeout = null;
            const cancelHide = () => {
                if (hideTimeout) clearTimeout(hideTimeout);
                hideTimeout = null;
            };
            const scheduleHide = () => {
                cancelHide();
                hideTimeout = setTimeout(() => {
                    pop.remove();
                    if (this.activePopover === pop) this.activePopover = null;
                }, 200);
            };

            requestAnimationFrame(() => {
                targetEl.addEventListener("mouseleave", scheduleHide, { once: true });
                pop.addEventListener("mouseenter", cancelHide);
                pop.addEventListener("mouseleave", scheduleHide);
            });

            try {
                if (!(await this.isLocalStepRunning())) {
                    url = this.localUrl_onlineUrl(url);
                }

                const urlRef = this.url_urlRef(url);
                if (!urlRef) return;

                //If only a book
                if (!urlRef.includes(".")) {
                    const info = this.getBookOverview(urlRef);

                    if (info) {
                        pop.innerHTML = `
                            <b>${info.name}</b><br>
                            ${info.chapters} chapters<br><br>
                            <i>Author:</i> ${info.author}<br>
                            <i>Location:</i> ${info.location}<br>
                            <i>Date:</i> ${info.date}<br><br>
                            ${info.synopsis}
                         `;
                        return;
                    }

                    pop.innerHTML = `<b>${urlRef}</b><br>No overview available.`;
                    return;
                }

                const verseRefs = this.urlRef_verseListArray(urlRef);

                let combined = "";
                const seen = new Set();

                for (const vRef of verseRefs) {
                    const verseUrl = url.includes("reference=")
                        ? url.replace(/reference=[^&]+/, `reference=${encodeURIComponent(vRef)}`)
                        : url;

                    const response = await requestUrl({ url: verseUrl });
                    const html = response.text;

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, "text/html");

                    const title = doc.querySelector("title")?.textContent || "";
                    const parts = title.split("|").map(p => p.trim());

                    let verseText = "";
                    if (parts.length >= 4) verseText = parts[3];

                    verseText = verseText
                        .replace(/\s+/g, " ")
                        .replace(/\s+([,;:.!?])/g, "$1")
                        .replace(/\s+\)/g, ")")
                        .replace(/\(\s+/g, "(")
                        .replace(/\s*,\s*$/g, "")
                        .trim();

                    if (!verseText || seen.has(verseText)) continue;
                    seen.add(verseText);

                    const [book, chap, verse] = vRef.split(".");
                    combined += `<p><strong>${chap}:${verse}</strong> ${verseText}</p>`;
                }

                pop.innerHTML = combined || "<p><i>No English text found.</i></p>";

                requestAnimationFrame(() => {
                    if (pop.scrollHeight > pop.clientHeight) {
                        pop.style.paddingBottom = "150px";
                    }
                });

            } catch (err) {
                pop.innerHTML = `<span style="color:var(--text-error)">Failed to load STEP Bible.</span>`;
            }
        });

        // OPEN SEARCH MODAL
        this.addCommand({
            id: "step-bible-search",
            name: "Search Bible Reference…",
            callback: () => {
                const { MarkdownView } = require("obsidian");

                let prefill = "";
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

                if (activeView?.editor) {
                    prefill = activeView.editor.getSelection() || "";
                } else {
                    try {
                        prefill = window.getSelection()?.toString() || "";
                    } catch {
                        prefill = "";
                    }
                }

                new StepBibleSearchModal(this.app, this, prefill).open();
            }
        });

    }

    // INPUT DETECTION =======================================================================================
    detectInputRef(line, cursorCh) {
        const refRegex = this.buildInputRefRegex();

        let m;
        while ((m = refRegex.exec(line)) !== null) {
            const mStart = m.index;
            const mEnd = mStart + m[0].length;

            if (cursorCh >= mStart && cursorCh <= mEnd) {
                return {
                    inputRef: m[0],
                    start: mStart,
                    end: mEnd
                };
            }
        }

        return null;
    }
    buildInputRefRegex() {
        const books = this.getAllBookPatterns();

        // Book group
        const bookGroup = `(?:${books.join("|")})`;

        // A chapter or chapter.verse or chapter.e or chapter.verse-e
        const cv = `\\d+(?:[.:](?:\\d+|e))?`;

        // Allow ranges:
        //   3-e
        //   3.16-e
        //   3.16-4.e
        //   3-4
        //   3.16-4.20
        const cvOrE = `(?:${cv}|e)`;
        const range = `${cvOrE}(?:\\s*-\\s*${cvOrE})?`;

        // Allow Bookname3.1 or Bookname 3.1 or Bookname 3.1-e
        const pattern = `${bookGroup}(?:\\s*${range})?`;

        return new RegExp(pattern, "gi");
    }


    
    // SEARCH HELPERS =========================================================================================
    async searchWebviewUrl(url, webviewEl) {
        if (!url || !url.includes("reference=")) return;

        const urlRef = this.url_urlRef(url);
        if (!urlRef) return;

        if (webviewEl.__lastProcessedRef === urlRef) return;
        webviewEl.__lastProcessedRef = urlRef;

        const queryRef = this.urlRef_queryRef(urlRef);
        const displayRef = this.urlRef_displayRef(urlRef);

        this.app.workspace.leftSplit?.expand();

        let leaf = this.app.workspace.getLeavesOfType("step-search-view")[0];

        if (!leaf) {
            leaf = this.app.workspace.getLeftLeaf(false);
            await leaf.setViewState({
                type: "step-search-view",
                state: {}
            });
        }

        this.app.workspace.setActiveLeaf(leaf, { focus: false });

        let searchView = leaf.view;

        for (let i = 0; i < 10; i++) {
            if (typeof searchView.updateQuery === "function") break;
            await new Promise(r => requestAnimationFrame(r));
            searchView = leaf.view;
        }

        if (typeof searchView.updateQuery !== "function") return;

        searchView.updateQuery(queryRef, displayRef);
    }
    minimiseLeftLeaf() {
        const leaf = this.app.workspace.getLeavesOfType("step-search-view")[0];
        if (leaf) {
            //this.app.workspace.detachLeavesOfType("step-search-view");

            const leftSplit = this.app.workspace.leftSplit;
            if (leftSplit && leftSplit.collapsed == false) {
                leftSplit.collapse();
            }
        }
    }

    // LOCAL/ONLINE URL HELPERS ===============================================================================
    async isLocalStepRunning() {
        try {
            const res = await requestUrl({
                url: "http://localhost:8989/",
                method: "GET",
                throw: false
            });

            return res.status >= 200 && res.status < 400;
        } catch {
            return false;
        }
    }
    localUrl_onlineUrl(localUrl) {
        const onlineBase = "https://www.stepbible.org/?";

        // Extract the query string after '?q='
        const match = localUrl.match(/\?q=([^#]+)/);
        if (!match) return localUrl;

        return `${onlineBase}q=${match[1]}`;
    }

    // CONVERTERS  =============================================================================================
    // inputRef_urlRef(inputRef) {

    //     const getBookMap = () => this.getBookMap();
    //     const getMaxVerse = (book, chap) => this.getMaxVerse(book, chap);
    //     const getMaxChapter = (book) => this.getMaxChapter(book);

    //     const normalizeBook = (rawBook) => {
    //         const lookup = rawBook.replace(/\s+/g, " ").toLowerCase();
    //         const book = getBookMap()[lookup] || rawBook;
    //         return book;
    //     };

    //     const bookKey = (book) => book.replace(/\s+/g, "");

    //     const fail = (msg) => {
    //         new Notice(msg);
    //         return null;
    //     };

    //     const checkChapterRange = (book, chap1, chap2) => {
    //         chap1 = parseInt(chap1);
    //         chap2 = parseInt(chap2);

    //         if (chap1 > chap2)
    //             return fail("Invalid range");

    //         const maxChap = getMaxChapter(book);
    //         if (!maxChap || chap1 > maxChap || chap2 > maxChap)
    //             return fail("Reference exceeds possible range");

    //         return true;
    //     };

    //     const checkVerseRange = (book, chap1, verse1, chap2, verse2) => {
    //         chap1 = parseInt(chap1);
    //         chap2 = parseInt(chap2);

    //         if (verse1 !== null) verse1 = parseInt(verse1);
    //         if (verse2 !== null) verse2 = parseInt(verse2);

    //         if (chap1 === chap2 && verse1 !== null && verse2 !== null) {
    //             if (verse1 > verse2)
    //                 return fail("Invalid range");
    //         }

    //         const max1 = getMaxVerse(book, chap1);
    //         const max2 = getMaxVerse(book, chap2);

    //         if (!max1 || !max2)
    //             return fail("Regex has allowed error");

    //         if (verse1 !== null && verse1 > max1)
    //             return fail("Reference exceeds possible range");

    //         if (verse2 !== null && verse2 > max2)
    //             return fail("Reference exceeds possible range");

    //         return true;
    //     };

    //     // --- PREPROCESS "e" EXPANSION BEFORE ANY PARSING ---

    //     if (inputRef.includes("e")) {

    //         const book = normalizeBook(inputRef.split(/\s+/)[0]);
    //         let remainder = inputRef.slice(book.length).trim();

    //         // Expand chapter.e → chapter.maxVerse
    //         remainder = remainder.replace(/(\d+)[.:]e\b/g, (full, chap) => {
    //             return `${chap}.${getMaxVerse(book, parseInt(chap))}`;
    //         });

    //         // Expand standalone "e"
    //         remainder = remainder.replace(/\be\b/g, (full, offset, fullString) => {

    //             // Use fullString (the remainder), NOT pre
    //             const prev = fullString[offset - 1];

    //             // If preceded by "-", treat as verse-level e
    //             // If preceded by "-", treat as verse-level e
    //             if (prev === "-") {

    //                 const beforeDash = fullString.slice(0, offset);

    //                 // If previous half contains "." or ":", then this e is verse-level
    //                 if (/[.:]/.test(beforeDash)) {

    //                     // Extract ONLY the chapter (before the dot or colon)
    //                     const chapterPart = beforeDash.split(/[.:]/)[0].match(/\d+$/);
    //                     if (chapterPart) {
    //                         const chap = parseInt(chapterPart[0]);
    //                         return getMaxVerse(book, chap);
    //                     }
    //                 }

    //                 // Otherwise: chapter-level e
    //                 return getMaxChapter(book);
    //             }

    //             // If preceded by "." or ":", verse-level e
    //             if (prev === "." || prev === ":") {
    //                 const chapMatch = fullString.slice(0, offset).match(/(\d+)[.:]$/);
    //                 if (chapMatch) {
    //                     const chap = parseInt(chapMatch[1]);
    //                     return getMaxVerse(book, chap);
    //                 }
    //             }

    //             // Otherwise chapter-level e
    //             return getMaxChapter(book);
    //         });

    //         inputRef = `${book}${remainder}`.trim();
    //     }

    //     let text = inputRef;

    //     {
    //         const stepPattern =
    //             /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\.(\d+)(?:\.(\d+))?(?:-([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)?\.(\d+)(?:\.(\d+))?)?$/;

    //         const m = text.match(stepPattern);
    //         if (m) {

    //             new Notice("match found");
    //             const rawBook1 = m[1].trim();
    //             const book1 = normalizeBook(rawBook1);
    //             const chap1 = m[2];
    //             const verse1 = m[3] || null;
    //             const bk1 = bookKey(book1);

    //             if (!m[4] && !verse1) return `${bk1}.${chap1}`;
    //             if (!m[4] && verse1) return `${bk1}.${chap1}.${verse1}`;

    //             const rawBook2 = (m[4] || rawBook1).trim();
    //             const book2 = normalizeBook(rawBook2);
    //             const chap2 = m[5];
    //             const verse2 = m[6] || null;
    //             const bk2 = bookKey(book2);

    //             if (!checkChapterRange(book1, chap1, chap2)) return null;
    //             if (!checkVerseRange(book1, chap1, verse1, chap2, verse2)) return null;

    //             if (!verse1 && !verse2)
    //                 return `${bk1}.${chap1}-${bk2}.${chap2}`;

    //             if (verse1 && verse2)
    //                 return `${bk1}.${chap1}.${verse1}-${bk2}.${chap2}.${verse2}`;

    //             if (!verse1 && verse2)
    //                 return `${bk1}.${chap1}-${bk2}.${chap2}.${verse2}`;

    //             if (verse1 && !verse2)
    //                 return `${bk1}.${chap1}.${verse1}-${bk2}.${chap1}.${chap2}`;
    //         }
    //     }

    //     const bookOnlyPattern = /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
    //     if (bookOnlyPattern.test(text) && !/\d+\s*:/.test(text)) {
    //         const lookup = text.toLowerCase();
    //         const book = getBookMap()[lookup];
    //         if (book) return book.replace(/\s+/g, "");
    //         return null;
    //     }

    //     const hasSpacedDash = /\s+-\s+/.test(text);

    //     let clean = text
    //         .replace(/–/g, "-")
    //         .replace(/\s*-\s*/g, "-")
    //         .replace(/:/g, ".");

    //     const bookRegex = /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/;
    //     const match = clean.match(bookRegex);
    //     if (!match) return null;

    //     const rawBook = match[0].trim();
    //     const book = normalizeBook(rawBook);
    //     const bk = bookKey(book);

    //     let remainder = clean.replace(match[0], "").trim();
    //     if (!remainder) return null;

    //     if (!remainder.includes("-")) {
    //         const parts = remainder.split(".");
    //         if (parts.length === 1) {
    //             if (!checkChapterRange(book, parts[0], parts[0])) return null;
    //             return `${bk}.${parts[0]}`;
    //         }
    //         if (parts.length === 2) {
    //             if (!checkChapterRange(book, parts[0], parts[0])) return null;
    //             if (!checkVerseRange(book, parts[0], parts[1], parts[0], parts[1])) return null;
    //             return `${bk}.${parts[0]}.${parts[1]}`;
    //         }
    //         return null;
    //     }

    //     const [left, right] = remainder.split("-");
    //     const leftParts = left.split(".");
    //     const rightParts = right.split(".");

    //     if (leftParts.length === 1 && rightParts.length === 1) {
    //         if (!checkChapterRange(book, leftParts[0], rightParts[0])) return null;
    //         return `${bk}.${leftParts[0]}-${bk}.${rightParts[0]}`;
    //     }

    //     if (leftParts.length === 2 && rightParts.length === 2) {
    //         if (!checkChapterRange(book, leftParts[0], rightParts[0])) return null;
    //         if (!checkVerseRange(book, leftParts[0], leftParts[1], rightParts[0], rightParts[1])) return null;
    //         return `${bk}.${leftParts[0]}.${leftParts[1]}-${bk}.${rightParts[0]}.${rightParts[1]}`;
    //     }

    //     if (leftParts.length === 2 && rightParts.length === 1) {
    //         if (!checkChapterRange(book, leftParts[0], rightParts[0])) return null;
    //         if (!checkVerseRange(book, leftParts[0], leftParts[1], rightParts[0], null)) return null;
    //         return `${bk}.${leftParts[0]}.${leftParts[1]}-${bk}.${leftParts[0]}.${rightParts[0]}`;
    //     }

    //     if (leftParts.length === 1 && rightParts.length === 2) {
    //         if (!checkChapterRange(book, leftParts[0], rightParts[0])) return null;
    //         if (!checkVerseRange(book, leftParts[0], null, rightParts[0], rightParts[1])) return null;
    //         return `${bk}.${leftParts[0]}-${bk}.${rightParts[0]}.${rightParts[1]}`;
    //     }

    //     return null;
    // }
    inputRef_urlRef(inputRef) {

        const getBookMap = () => this.getBookMap();
        const getMaxVerse = (book, chap) => this.getMaxVerse(book, chap);

        const STEP_FIX = {
            "Song of Solomon": "Song",
            "Song of Songs": "Song",
            "Canticles": "Song",
            "Song": "Song"
        };

        const normalizeBook = (rawBook) => {
            const lookup = rawBook.replace(/\s+/g, " ").toLowerCase();
            const book = getBookMap()[lookup] || rawBook;
            return STEP_FIX[book] || book;
        };

        const bookKey = (book) => book.replace(/\s+/g, "");

        const text = inputRef.trim();

        {
            const stepPattern =
                /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\.(\d+)(?:\.(\d+))?(?:-([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)?\.(\d+)(?:\.(\d+))?)?$/;

            const m = text.match(stepPattern);
            if (m) {
                const rawBook1 = m[1].trim();
                const book1 = normalizeBook(rawBook1);
                const chap1 = m[2];
                const verse1 = m[3] || null;
                const bk1 = bookKey(book1);

                if (!m[4] && !verse1) return `${bk1}.${chap1}`;
                if (!m[4] && verse1) return `${bk1}.${chap1}.${verse1}`;

                const rawBook2 = (m[4] || rawBook1).trim();
                const book2 = normalizeBook(rawBook2);
                const chap2 = m[5];
                const verse2 = m[6] || null;
                const bk2 = bookKey(book2);

                if (!verse1 && !verse2) return `${bk1}.${chap1}-${bk2}.${chap2}`;
                if (verse1 && verse2)
                    return `${bk1}.${chap1}.${verse1}-${bk2}.${chap2}.${verse2}`;
                if (!verse1 && verse2)
                    return `${bk1}.${chap1}-${bk2}.${chap2}.${verse2}`;
                if (verse1 && !verse2)
                    return `${bk1}.${chap1}.${verse1}-${bk2}.${chap1}.${chap2}`;
            }
        }

        const bookOnlyPattern = /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
        if (bookOnlyPattern.test(text) && !/\d+\s*:/.test(text)) {
            const lookup = text.toLowerCase();
            const book = getBookMap()[lookup];
            if (book) return book.replace(/\s+/g, "");
            return null;
        }

        const hasSpacedDash = /\s+-\s+/.test(text);

        let clean = text
            .replace(/–/g, "-")
            .replace(/\s*-\s*/g, "-")
            .replace(/:/g, ".");

        const bookRegex = /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/;
        const match = clean.match(bookRegex);
        if (!match) return null;

        const rawBook = match[0].trim();
        const book = normalizeBook(rawBook);
        const bk = bookKey(book);

        let remainder = clean.replace(match[0], "").trim();
        if (!remainder) return null;

        if (!remainder.includes("-")) {
            const parts = remainder.split(".");
            if (parts.length === 1) return `${bk}.${parts[0]}`;
            if (parts.length === 2) return `${bk}.${parts[0]}.${parts[1]}`;
            return null;
        }

        const [left, right] = remainder.split("-");
        const leftParts = left.split(".");
        const rightParts = right.split(".");

        if (hasSpacedDash && leftParts.length === 2 && rightParts.length === 1) {
            const lChap = leftParts[0];
            const lVerse = leftParts[1];
            const rChap = rightParts[0];
            const maxVerse = getMaxVerse(book, rChap);
            return `${bk}.${lChap}.${lVerse}-${bk}.${rChap}.${maxVerse}`;
        }

        if (leftParts.length === 1 && rightParts.length === 1)
            return `${bk}.${leftParts[0]}-${bk}.${rightParts[0]}`;

        if (leftParts.length === 2 && rightParts.length === 1)
            return `${bk}.${leftParts[0]}.${leftParts[1]}-${bk}.${leftParts[0]}.${rightParts[0]}`;

        if (leftParts.length === 1 && rightParts.length === 2)
            return `${bk}.${leftParts[0]}-${bk}.${rightParts[0]}.${rightParts[1]}`;

        if (leftParts.length === 2 && rightParts.length === 2)
            return `${bk}.${leftParts[0]}.${leftParts[1]}-${bk}.${rightParts[0]}.${rightParts[1]}`;

        return null;
    }

    urlRef_displayRef(urlRef) {

        const canonicalToDisplay = (canonical) => {
            return canonical.replace(/^([1-3])([A-Za-z].*)$/, "$1 $2");
        };

        const range = urlRef.split("-");
        const left = range[0].split(".");
        const right = range.length > 1 ? range[1].split(".") : null;

        const book1 = canonicalToDisplay(left[0]);
        const chap1 = left[1];
        const verse1 = left[2] || null;

        if (!chap1) return book1;

        if (!right) {
            if (!verse1) return `${book1} ${chap1}`;
            return `${book1} ${chap1}:${verse1}`;
        }

        const book2 = canonicalToDisplay(right[0]);
        const chap2 = right[1];
        const verse2 = right[2] || null;

        // SAME BOOK, SAME CHAPTER, VERSE RANGE
        if (book1 === book2 && chap1 === chap2 && verse1 && verse2) {
            return `${book1} ${chap1}:${verse1}-${verse2}`;
        }

        // CROSS-CHAPTER VERSE RANGE (this must come early)
        if (book1 === book2 && verse1 && verse2 && chap1 !== chap2) {
            return `${book1} ${chap1}:${verse1}-${chap2}:${verse2}`;
        }

        // SAME BOOK, CHAPTER → CHAPTER
        if (book1 === book2 && !verse1 && !verse2) {
            return `${book1} ${chap1}-${chap2}`;
        }

        // CHAPTER → VERSE (cross-chapter end)
        if (!verse1 && verse2) {
            return `${book1} ${chap1} - ${book2} ${chap2}:${verse2}`;
        }

        // SAME BOOK, SAME CHAPTER, VERSE → CHAPTER
        if (book1 === book2 && verse1 && !verse2) {
            return `${book1} ${chap1}:${verse1}-${chap2}`;
        }

        return urlRef;
    }


    url_urlRef(url) {
        const match = url.match(/reference=([^&]+)/);
        if (!match) return null;

        const raw = decodeURIComponent(match[1]).trim();
        if (!raw) return null;

        const bookMap = this.getBookMap(); // abbreviation → full name

        // Normalize a single book token (no dots)
        const normalizeBook = (bookToken) => {
            const lookup = bookToken.replace(/\s+/g, " ").trim().toLowerCase();
            const full = bookMap[lookup];
            if (!full) return bookToken; // no match → leave unchanged
            return full.replace(/\s+/g, ""); // canonical STEP form
        };

        // Normalize dotted reference like "Gen.1.2"
        const urlRef = (ref) => {
            const parts = ref.split(".");
            parts[0] = normalizeBook(parts[0]);
            return parts.join(".");
        };

        // Normalize ranges: "Gen.1-Gen.2"
        if (raw.includes("-")) {
            const [left, right] = raw.split("-");
            return `${urlRef(left)}-${urlRef(right)}`;
        }

        // Single reference
        return urlRef(raw);
    }
    urlRef_url(urlRef) {
        const versionPart = this.settings.enabledVersions
            .map(v => `version=${v}`)
            .join("@");

        const urlBase = `${this.urlPrefix}?q=${versionPart}@reference=`;
        const urlSuffix = "&options=GNVUH&display=COLUMN";

        if (!urlRef) return null;

        return `${urlBase}${urlRef}${urlSuffix}`;
    }
    urlRef_displayRef(urlRef) {
        const canonicalToDisplay = (canonical) => {
            return canonical.replace(/^([1-3])([A-Za-z].*)$/, "$1 $2");
        };

        const range = urlRef.split("-");
        const left = range[0].split(".");
        const right = range.length > 1 ? range[1].split(".") : null;

        const book1 = canonicalToDisplay(left[0]);
        const chap1 = left[1];
        const verse1 = left[2] || null;

        if (!chap1) return book1;

        if (!right) {
            if (!verse1) return `${book1} ${chap1}`;
            return `${book1} ${chap1}:${verse1}`;
        }

        const book2 = canonicalToDisplay(right[0]);
        const chap2 = right[1];
        const verse2 = right[2] || null;

        // SAME BOOK, SAME CHAPTER, VERSE RANGE
        if (book1 === book2 && chap1 === chap2 && verse1 && verse2) {
            return `${book1} ${chap1}:${verse1}-${verse2}`;
        }

        // CROSS-CHAPTER VERSE RANGE (this must come early)
        if (book1 === book2 && verse1 && verse2 && chap1 !== chap2) {
            return `${book1} ${chap1}:${verse1}-${chap2}:${verse2}`;
        }

        // SAME BOOK, CHAPTER → CHAPTER
        if (book1 === book2 && !verse1 && !verse2) {
            return `${book1} ${chap1}-${chap2}`;
        }

        // CHAPTER → VERSE (cross-chapter end)
        if (!verse1 && verse2) {
            return `${book1} ${chap1} - ${book2} ${chap2}:${verse2}`;
        }

        // SAME BOOK, SAME CHAPTER, VERSE → CHAPTER
        if (book1 === book2 && verse1 && !verse2) {
            return `${book1} ${chap1}:${verse1}-${chap2}`;
        }

        return urlRef;
    }
    urlRef_queryRef(urlRef) {

        // urlRef is already normalized and STEP-compatible
        urlRef = urlRef.trim();
        if (urlRef === "") return [];

        // Remove spaces (there shouldn't be any)
        urlRef = urlRef.replace(/\s+/g, "");

        // Book-only: match any STEP reference that starts with the book
        if (!urlRef.includes(".")) {
            return [`reference=${urlRef}`];
        }

        let refs = [];

        // RANGE HANDLING
        if (urlRef.includes("-")) {
            const [left, right] = urlRef.split("-");
            const lParts = left.split(".");
            const rParts = right.split(".");

            // CASE: Book.Chapter - Book.Chapter (same book)
            if (lParts.length === 2 && rParts.length === 2 && lParts[0] === rParts[0]) {
                const book = lParts[0];
                const startChap = parseInt(lParts[1], 10);
                const endChap = parseInt(rParts[1], 10);

                if (!Number.isNaN(startChap) && !Number.isNaN(endChap) && startChap <= endChap) {
                    for (let c = startChap; c <= endChap; c++) {
                        refs.push(`${book}.${c}`);
                    }
                } else {
                    refs = this.urlRef_verseListArray
                        ? this.urlRef_verseListArray(urlRef)
                        : [urlRef];
                }
            } else {
                // CASE: Full verse range or cross-chapter range
                refs = this.urlRef_verseListArray
                    ? this.urlRef_verseListArray(urlRef)
                    : [urlRef];
            }

        } else {
            // SINGLE REFERENCE (chapter or verse)
            refs.push(urlRef);
        }

        // Deduplicate
        refs = Array.from(new Set(refs || []));
        if (refs.length === 0) return [urlRef];

        // Convert each ref into a full search token
        return refs.map(r => `reference=${r}`);
    }
    urlRef_verseListArray(urlRef) {
        // Normalize: remove spaces from book part if any slipped through
        urlRef = urlRef.replace(/\s+/g, "");

        if (!urlRef.includes("-")) {
            const parts = urlRef.split(".");
            if (parts.length === 3) {
                return [urlRef];
            }
            if (parts.length === 2) {
                const [book, chapStr] = parts;
                const chap = parseInt(chapStr, 10);
                const maxVerse = this.getMaxVerse(book, chap);
                if (!maxVerse) return [urlRef];
                const list = [];
                for (let v = 1; v <= maxVerse; v++) {
                    list.push(`${book}.${chap}.${v}`);
                }
                return list;
            }
            return [urlRef];
        }

        const [startRef, endRef] = urlRef.split("-");
        const sParts = startRef.split(".");
        const eParts = endRef.split(".");

        const book = sParts[0];
        const sChap = parseInt(sParts[1], 10);
        const sVerse = sParts.length >= 3 ? parseInt(sParts[2], 10) : 1;

        const eBook = eParts[0];
        const eChap = parseInt(eParts[1], 10);
        const eVerse = eParts.length >= 3
            ? parseInt(eParts[2], 10)
            : this.getMaxVerse(eBook, eChap);

        if (!this.getMaxVerse(book, sChap) || !this.getMaxVerse(eBook, eChap)) {
            return [startRef];
        }

        const list = [];

        if (book === eBook && sChap === eChap) {
            for (let v = sVerse; v <= eVerse; v++) {
                list.push(`${book}.${sChap}.${v}`);
            }
            return list;
        }

        if (book === eBook) {
            const maxStart = this.getMaxVerse(book, sChap);
            for (let v = sVerse; v <= maxStart; v++) {
                list.push(`${book}.${sChap}.${v}`);
            }

            for (let c = sChap + 1; c < eChap; c++) {
                const maxMid = this.getMaxVerse(book, c);
                for (let v = 1; v <= maxMid; v++) {
                    list.push(`${book}.${c}.${v}`);
                }
            }

            for (let v = 1; v <= eVerse; v++) {
                list.push(`${book}.${eChap}.${v}`);
            }

            return list;
        }

        return [startRef];
    }

    // BIBLE INFORMATION HELPERS =================================================================================
    getAllBookPatterns() {
        const map = this.getBookMap(); // flat lookup: "1 peter" → "1Peter"
        const keys = Object.keys(map);

        // Escape spaces for regex
        const escaped = keys.map(k =>
            k.replace(/\s+/g, "\\s+")
        );

        // Sort longest → shortest so multi-word books match first
        escaped.sort((a, b) => b.length - a.length);

        return escaped;
    }
    getBookMap() {
        const rawData = {
            "en": [
                { bookName: "Genesis", abbreviations: ["Gen", "Ge", "Gn"] },
                { bookName: "Exodus", abbreviations: ["Exod", "Ex"] },
                { bookName: "Leviticus", abbreviations: ["Lev", "Lv", "Le"] },
                { bookName: "Numbers", abbreviations: ["Num", "Nm", "Nu"] },
                { bookName: "Deuteronomy", abbreviations: ["Deut", "Dt", "De", "Du"] },
                { bookName: "Joshua", abbreviations: ["Josh", "Jos", "Jo"] },
                { bookName: "Judges", abbreviations: ["Judg", "Jdg", "Jgs"] },
                { bookName: "Ruth", abbreviations: ["Ruth", "Ru"] },
                { bookName: "1 Samuel", abbreviations: ["1 Sam", "1Sm", "1Sa"] },
                { bookName: "2 Samuel", abbreviations: ["2 Sam", "2Sm", "2Sa"] },
                { bookName: "1 Kings", abbreviations: ["1 Kgs", "1Kg", "1Ki"] },
                { bookName: "2 Kings", abbreviations: ["2 Kgs", "2Kg", "2Ki"] },
                { bookName: "1 Chronicles", abbreviations: ["1 Chr", "1 Chron", "1Ch"] },
                { bookName: "2 Chronicles", abbreviations: ["2 Chr", "2 Chron", "2Ch"] },
                { bookName: "Ezra", abbreviations: ["Ezra", "Ezr"] },
                { bookName: "Nehemiah", abbreviations: ["Neh", "Ne"] },
                { bookName: "Esther", abbreviations: ["Esth", "Est", "Es"] },
                { bookName: "Job", abbreviations: ["Job", "Jb"] },
                { bookName: "Psalms", abbreviations: ["Ps", "Pss", "Psalm"] },
                { bookName: "Proverbs", abbreviations: ["Prov", "Prv", "Pr"] },
                { bookName: "Ecclesiastes", abbreviations: ["Qoheleth", "Eccl", "Eccles", "Ec", "Qoh"] },
                { bookName: "Song", abbreviations: ["Song", "SS", "So", "Sg", "Song of Solomon"] },
                { bookName: "Isaiah", abbreviations: ["Isa", "Is"] },
                { bookName: "Jeremiah", abbreviations: ["Jer", "Je"] },
                { bookName: "Lamentations", abbreviations: ["Lam", "La"] },
                { bookName: "Ezekiel", abbreviations: ["Ezek", "Ezk", "Ez"] },
                { bookName: "Daniel", abbreviations: ["Dan", "Dn", "Da"] },
                { bookName: "Hosea", abbreviations: ["Hos", "Ho"] },
                { bookName: "Joel", abbreviations: ["Joel", "Joe", "Jl"] },
                { bookName: "Amos", abbreviations: ["Amos", "Am"] },
                { bookName: "Obadiah", abbreviations: ["Obad", "Ob"] },
                { bookName: "Jonah", abbreviations: ["Jonah", "Jon"] },
                { bookName: "Micah", abbreviations: ["Mic", "Mi"] },
                { bookName: "Nahum", abbreviations: ["Nah", "Na"] },
                { bookName: "Habakkuk", abbreviations: ["Hab", "Hb"] },
                { bookName: "Zephaniah", abbreviations: ["Zeph", "Zep"] },
                { bookName: "Haggai", abbreviations: ["Hag", "Hg"] },
                { bookName: "Zechariah", abbreviations: ["Zech", "Zec"] },
                { bookName: "Malachi", abbreviations: ["Mal", "Ml"] },
                { bookName: "Matthew", abbreviations: ["Matt", "Mat", "Mt"] },
                { bookName: "Mark", abbreviations: ["Mark", "Mar", "Mk"] },
                { bookName: "Luke", abbreviations: ["Luke", "Lk", "Lu"] },
                { bookName: "John", abbreviations: ["John", "Jn", "Jo"] },
                { bookName: "Acts", abbreviations: ["Acts", "Ac"] },
                { bookName: "Romans", abbreviations: ["Rom", "Rm", "Ro"] },
                { bookName: "1 Corinthians", abbreviations: ["1 Cor", "1 Co", "1C"] },
                { bookName: "2 Corinthians", abbreviations: ["2 Cor", "2 Co", "2C"] },
                { bookName: "Galatians", abbreviations: ["Gal", "Ga"] },
                { bookName: "Ephesians", abbreviations: ["Eph", "Ep"] },
                { bookName: "Philippians", abbreviations: ["Phil", "Php"] },
                { bookName: "Colossians", abbreviations: ["Col", "Co"] },
                { bookName: "1 Thessalonians", abbreviations: ["1 Thess", "1 Thes", "1Th"] },
                { bookName: "2 Thessalonians", abbreviations: ["2 Thess", "2 Thes", "2Th"] },
                { bookName: "1 Timothy", abbreviations: ["1 Tim", "1 Tm", "1 Ti", "1T"] },
                { bookName: "2 Timothy", abbreviations: ["2 Tim", "2 Tm", "2 Ti", "2T"] },
                { bookName: "Titus", abbreviations: ["Titus", "Tit", "Ti"] },
                { bookName: "Philemon", abbreviations: ["Phlm", "Philem", "Phm"] },
                { bookName: "Hebrews", abbreviations: ["Heb", "He"] },
                { bookName: "James", abbreviations: ["Jas", "Ja"] },
                { bookName: "1 Peter", abbreviations: ["1 Pet", "1Pet", "1peter", "1 Pt", "1P"] },
                { bookName: "2 Peter", abbreviations: ["2 Pet", "2Pet", "2peter", "2 Pt", "2P"] },
                { bookName: "1 John", abbreviations: ["1 John", "1 Jn", "1 Jo", "1J"] },
                { bookName: "2 John", abbreviations: ["2 John", "2 Jn", "2 Jo", "2J"] },
                { bookName: "3 John", abbreviations: ["3 John", "3 Jn", "3 Jo", "3J"] },
                { bookName: "Jude", abbreviations: ["Jude", "Ju"] },
                { bookName: "Revelation", abbreviations: ["Rev", "Re", "Rv"] }
            ]
        };

        const flatMap = {};
        rawData.en.forEach(item => {
            const standardName = item.bookName.trim();
            flatMap[standardName.toLowerCase()] = standardName;
            item.abbreviations.forEach(abbr => {
                flatMap[abbr.replace(/\s+/g, ' ').trim().toLowerCase()] = standardName;
            });
        });
        return flatMap;
    }
    getMaxVerse(book, chapter) {
        const verseCounts = {
            "Genesis": [0, 31, 25, 24, 26, 32, 22, 24, 22, 29, 32, 32, 20, 18, 24, 21, 16, 27, 33, 38, 18, 34, 24, 20, 67, 34, 35, 46, 22, 35, 43, 55, 32, 20, 31, 29, 43, 36, 30, 23, 23, 57, 38, 34, 34, 28, 34, 31, 22, 33],
            "Exodus": [0, 22, 25, 22, 31, 23, 30, 25, 32, 35, 29, 10, 51, 22, 31, 27, 36, 16, 27, 25, 26, 36, 31, 33, 18, 40, 37, 21, 43, 46, 38, 18, 35, 23, 35, 35, 38, 29, 31, 43],
            "Leviticus": [0, 17, 16, 17, 35, 19, 30, 38, 36, 24, 20, 47, 8, 59, 57, 33, 34, 16, 30, 37, 27, 24, 33, 44, 23, 55, 46, 34],
            "Numbers": [0, 54, 34, 51, 49, 31, 27, 89, 26, 23, 36, 35, 16, 33, 45, 41, 50, 13, 32, 22, 29, 35, 41, 30, 25, 18, 65, 23, 31, 40, 16, 54, 42, 56, 29, 34, 13],
            "Deuteronomy": [0, 46, 37, 29, 49, 33, 25, 26, 20, 29, 22, 32, 32, 18, 29, 23, 22, 20, 22, 21, 20, 23, 30, 25, 22, 19, 19, 26, 68, 29, 20, 30, 52, 29],
            "Joshua": [0, 18, 24, 17, 24, 15, 27, 26, 35, 27, 43, 23, 24, 33, 15, 63, 10, 18, 28, 51, 9, 45, 34, 16],
            "Judges": [0, 36, 23, 31, 24, 31, 40, 25, 35, 57, 18, 40, 15, 25, 20, 20, 31, 13, 31, 30, 48, 25],
            "Ruth": [0, 22, 23, 18, 22],
            "1Samuel": [0, 28, 36, 21, 22, 12, 21, 17, 22, 27, 27, 15, 25, 23, 52, 35, 23, 58, 30, 24, 42, 15, 23, 28, 23, 44, 25, 12, 25, 11, 31],
            "2Samuel": [0, 27, 32, 39, 12, 25, 23, 29, 18, 13, 19, 27, 31, 39, 33, 37, 23, 29, 33, 43, 26, 22, 51, 39, 25],
            "1Kings": [0, 53, 46, 28, 34, 18, 38, 51, 66, 28, 29, 43, 33, 34, 31, 34, 34, 24, 46, 21, 43, 29, 53],
            "2Kings": [0, 18, 25, 27, 44, 27, 33, 20, 29, 37, 36, 21, 21, 25, 29, 38, 20, 41, 37, 37, 21, 26, 20, 37, 20, 30],
            "1Chronicles": [0, 54, 55, 24, 43, 26, 81, 40, 40, 44, 14, 47, 40, 14, 17, 29, 43, 27, 17, 19, 8, 30, 19, 32, 31, 31, 32, 34, 21],
            "2Chronicles": [0, 17, 18, 17, 22, 14, 42, 22, 18, 31, 19, 23, 16, 22, 15, 19, 14, 19, 34, 11, 37, 20, 12, 21, 27, 28, 23, 9, 27, 36],
            "Ezra": [0, 11, 70, 13, 24, 17, 22, 28, 36, 15, 44],
            "Nehemiah": [0, 11, 20, 32, 23, 19, 19, 73, 18, 38, 39, 36, 47, 31],
            "Esther": [0, 22, 23, 15, 17, 14, 14, 10, 17, 32, 3],
            "Job": [0, 22, 13, 26, 21, 27, 30, 21, 22, 35, 22, 20, 25, 28, 22, 35, 22, 16, 21, 29, 34, 30, 17, 25, 6, 14, 23, 28, 25, 31, 40, 22, 33, 37, 16, 33, 24, 41, 30, 32, 26, 17],
            "Psalms": [0, 6, 12, 8, 8, 12, 10, 17, 9, 20, 18, 7, 9, 6, 7, 5, 11, 15, 50, 14, 9, 13, 31, 6, 10, 22, 12, 14, 9, 11, 12, 24, 11, 22, 22, 28, 12, 40, 22, 13, 17, 13, 11, 5, 26, 17, 11, 9, 14, 20, 23, 19, 9, 6, 7, 23, 13, 11, 11, 17, 12, 8, 12, 11, 10, 13, 20, 7, 35, 36, 5, 24, 20, 28, 23, 10, 12, 20, 72, 13, 19, 16, 8, 18, 12, 13, 17, 7, 18, 52, 17, 16, 15, 5, 23, 11, 13, 12, 9, 9, 5, 8, 28, 22, 35, 45, 48, 43, 13, 31, 7, 10, 10, 9, 8, 18, 19, 2, 29, 176, 7, 8, 9, 4, 8, 5, 6, 5, 6, 8, 8, 3, 18, 3, 3, 21, 26, 9, 8, 24, 13, 10, 7, 12, 15, 21, 10, 20, 14, 9, 6],
            "Proverbs": [0, 33, 22, 35, 27, 23, 35, 27, 36, 18, 32, 31, 28, 25, 35, 33, 33, 28, 24, 29, 30, 31, 29, 35, 34, 28, 28, 27, 28, 27, 33],
            "Ecclesiastes": [0, 18, 26, 22, 16, 20, 12, 29, 17, 18, 20, 10, 14],
            "SongofSongs": [0, 17, 17, 11, 16, 16, 13, 13, 14],
            "Isaiah": [0, 31, 22, 26, 6, 30, 13, 25, 22, 21, 34, 16, 6, 22, 32, 9, 14, 14, 7, 25, 6, 17, 25, 18, 23, 12, 21, 13, 29, 24, 33, 9, 20, 24, 17, 10, 22, 38, 22, 8, 31, 29, 25, 28, 28, 25, 13, 15, 22, 26, 11, 23, 15, 12, 17, 13, 12, 21, 14, 21, 22, 11, 12, 19, 12, 25, 24],
            "Jeremiah": [0, 19, 37, 25, 31, 31, 30, 34, 22, 26, 25, 23, 17, 27, 22, 21, 21, 27, 23, 15, 18, 14, 30, 40, 10, 38, 24, 22, 17, 32, 24, 40, 44, 26, 22, 19, 32, 21, 28, 18, 16, 18, 22, 13, 30, 5, 28, 7, 47, 39, 46, 64],
            "Lamentations": [0, 22, 22, 66, 22, 22],
            "Ezekiel": [0, 28, 10, 27, 17, 17, 14, 27, 27, 11, 22, 25, 28, 23, 23, 8, 63, 24, 32, 14, 49, 32, 31, 49, 27, 17, 21, 36, 26, 21, 26, 18, 32, 33, 31, 15, 38, 28, 23, 29, 49, 26, 20, 27, 31, 25, 24, 23],
            "Daniel": [0, 21, 49, 30, 37, 31, 28, 28, 27, 27, 21, 45, 13],
            "Hosea": [0, 11, 23, 5, 19, 15, 11, 16, 14, 17, 15, 11, 15, 15, 10],
            "Joel": [0, 20, 32, 21],
            "Amos": [0, 15, 16, 15, 13, 27, 14, 17, 14, 15],
            "Obadiah": [0, 21],
            "Jonah": [0, 17, 10, 10, 11],
            "Micah": [0, 16, 13, 12, 13, 15, 16, 20],
            "Nahum": [0, 15, 13, 19],
            "Habakkuk": [0, 17, 20, 19],
            "Zephaniah": [0, 18, 15, 20],
            "Haggai": [0, 15, 23],
            "Zechariah": [0, 21, 13, 10, 14, 11, 15, 14, 23, 17, 12, 17, 14, 9, 21],
            "Malachi": [0, 14, 17, 18, 6],
            "Matthew": [0, 25, 23, 17, 25, 48, 34, 29, 34, 38, 42, 30, 50, 58, 36, 39, 28, 27, 35, 30, 34, 46, 46, 39, 51, 46, 75, 66, 20],
            "Mark": [0, 45, 28, 35, 41, 43, 56, 37, 38, 50, 52, 33, 44, 37, 72, 47, 20],
            "Luke": [0, 80, 52, 38, 44, 39, 49, 50, 56, 62, 42, 54, 59, 35, 35, 32, 31, 37, 43, 48, 47, 38, 71, 56, 53],
            "John": [0, 51, 25, 36, 54, 47, 71, 53, 59, 41, 42, 57, 50, 38, 31, 27, 33, 26, 40, 42, 31, 25],
            "Acts": [0, 26, 47, 26, 37, 42, 15, 60, 40, 43, 48, 30, 25, 52, 28, 41, 40, 34, 28, 41, 38, 40, 30, 35, 27, 27, 32, 44, 31],
            "Romans": [0, 32, 29, 31, 25, 21, 23, 25, 39, 33, 21, 36, 21, 14, 23, 33, 27],
            "1Corinthians": [0, 31, 16, 23, 21, 13, 20, 40, 13, 27, 33, 34, 31, 13, 40, 58, 24],
            "2Corinthians": [0, 24, 17, 18, 18, 21, 18, 16, 24, 15, 18, 33, 21, 14],
            "Galatians": [0, 24, 21, 29, 31, 26, 18],
            "Ephesians": [0, 23, 22, 21, 32, 33, 24],
            "Philippians": [0, 30, 30, 21, 23],
            "Colossians": [0, 29, 23, 25, 18],
            "1Thessalonians": [0, 10, 20, 13, 18, 28],
            "2Thessalonians": [0, 12, 17, 18],
            "1Timothy": [0, 20, 15, 16, 16, 25, 21],
            "2Timothy": [0, 18, 26, 17, 22],
            "Titus": [0, 16, 15, 15],
            "Philemon": [0, 25],
            "Hebrews": [0, 14, 18, 19, 16, 14, 20, 28, 13, 28, 39, 40, 29, 25],
            "James": [0, 27, 26, 18, 17, 20],
            "1Peter": [0, 25, 25, 22, 19, 14],
            "2Peter": [0, 21, 22, 18],
            "1John": [0, 10, 29, 24, 21, 21],
            "2John": [0, 13],
            "3John": [0, 15],
            "Jude": [0, 25],
            "Revelation": [0, 20, 29, 22, 11, 14, 17, 17, 13, 21, 11, 19, 17, 18, 20, 8, 21, 18, 24, 21, 15, 27]
        };

        const key = book.replace(/\s+/g, '');
        const arr = verseCounts[key];
        if (!arr) return null;
        if (chapter < 1 || chapter >= arr.length) return null;
        return arr[chapter];
    }
    getMaxChapter(book) {
        const chapterCounts = {
            Genesis: 50,
            Exodus: 40,
            Leviticus: 27,
            Numbers: 36,
            Deuteronomy: 34,
            Joshua: 24,
            Judges: 21,
            Ruth: 4,
            "1Samuel": 31,
            "2Samuel": 24,
            "1Kings": 22,
            "2Kings": 25,
            "1Chronicles": 29,
            "2Chronicles": 36,
            Ezra: 10,
            Nehemiah: 13,
            Esther: 10,
            Job: 42,
            Psalms: 150,
            Proverbs: 31,
            Ecclesiastes: 12,
            Song: 8,
            Isaiah: 66,
            Jeremiah: 52,
            Lamentations: 5,
            Ezekiel: 48,
            Daniel: 12,
            Hosea: 14,
            Joel: 3,
            Amos: 9,
            Obadiah: 1,
            Jonah: 4,
            Micah: 7,
            Nahum: 3,
            Habakkuk: 3,
            Zephaniah: 3,
            Haggai: 2,
            Zechariah: 14,
            Malachi: 4,
            Matthew: 28,
            Mark: 16,
            Luke: 24,
            John: 21,
            Acts: 28,
            Romans: 16,
            "1Corinthians": 16,
            "2Corinthians": 13,
            Galatians: 6,
            Ephesians: 6,
            Philippians: 4,
            Colossians: 4,
            "1Thessalonians": 5,
            "2Thessalonians": 3,
            "1Timothy": 6,
            "2Timothy": 4,
            Titus: 3,
            Philemon: 1,
            Hebrews: 13,
            James: 5,
            "1Peter": 5,
            "2Peter": 3,
            "1John": 5,
            "2John": 1,
            "3John": 1,
            Jude: 1,
            Revelation: 22
        };

        const key = book.replace(/\s+/g, '');
        return chapterCounts[key] || null;
    }
    getBookOverview(book) {
        const overviews = {
            // PENTATEUCH
            "Genesis": {
                name: "Genesis",
                chapters: 50,
                author: "Moses",
                location: "Wilderness (likely during Israel’s wanderings)",
                date: "c. 1446–1406 BC",
                synopsis: "Creation, the fall, the flood, and God’s covenant with Abraham, Isaac, Jacob, and Joseph."
            },
            "Exodus": {
                name: "Exodus",
                chapters: 40,
                author: "Moses",
                location: "Wilderness (Sinai region)",
                date: "c. 1446–1406 BC",
                synopsis: "God delivers Israel from Egypt, gives the Law, and instructs them to build the tabernacle."
            },
            "Leviticus": {
                name: "Leviticus",
                chapters: 27,
                author: "Moses",
                location: "Mount Sinai",
                date: "c. 1446–1406 BC",
                synopsis: "Laws for sacrifices, priesthood, purity, and holiness for Israel’s worship and daily life."
            },
            "Numbers": {
                name: "Numbers",
                chapters: 36,
                author: "Moses",
                location: "Wilderness (Sinai to Moab)",
                date: "c. 1446–1406 BC",
                synopsis: "Censuses, wilderness wanderings, rebellions, and God’s faithful guidance toward the Promised Land."
            },
            "Deuteronomy": {
                name: "Deuteronomy",
                chapters: 34,
                author: "Moses",
                location: "Plains of Moab",
                date: "c. 1406 BC",
                synopsis: "Moses’ final sermons, reviewing the Law and calling Israel to covenant faithfulness before entering Canaan."
            },

            // HISTORICAL (OT)
            "Joshua": {
                name: "Joshua",
                chapters: 24,
                author: "Joshua (with later editorial additions)",
                location: "Canaan",
                date: "c. 1406–1375 BC",
                synopsis: "Israel’s conquest and division of the Promised Land under Joshua’s leadership."
            },
            "Judges": {
                name: "Judges",
                chapters: 21,
                author: "Traditionally Samuel",
                location: "Israel",
                date: "c. 1050–1000 BC",
                synopsis: "Cycles of Israel’s sin, oppression, crying out, and deliverance through God‑raised judges."
            },
            "Ruth": {
                name: "Ruth",
                chapters: 4,
                author: "Traditionally Samuel",
                location: "Israel (Bethlehem)",
                date: "c. 1100–1000 BC (events earlier, in the time of the judges)",
                synopsis: "A Moabite woman’s loyalty leads to blessing and her inclusion in the line of David and Christ."
            },
            "1Samuel": {
                name: "1 Samuel",
                chapters: 31,
                author: "Traditionally Samuel, with later prophets (Nathan, Gad)",
                location: "Israel",
                date: "c. 1050–1000 BC",
                synopsis: "Transition from judges to monarchy: Samuel, Saul’s rise and fall, and David’s anointing."
            },
            "2Samuel": {
                name: "2 Samuel",
                chapters: 24,
                author: "Traditionally Nathan, Gad, and other court prophets",
                location: "Israel (Jerusalem)",
                date: "c. 1000–960 BC",
                synopsis: "David’s reign, his victories, sins, family turmoil, and God’s covenant promise to his house."
            },
            "1Kings": {
                name: "1 Kings",
                chapters: 22,
                author: "Unknown, traditionally a prophetic historian",
                location: "Israel/Judah (likely during exile)",
                date: "c. 560–540 BC",
                synopsis: "Solomon’s reign, the kingdom’s division, and the early history of Israel and Judah’s kings."
            },
            "2Kings": {
                name: "2 Kings",
                chapters: 25,
                author: "Unknown, traditionally a prophetic historian",
                location: "Exilic context (Babylon)",
                date: "c. 560–540 BC",
                synopsis: "The decline of Israel and Judah, leading to the fall of Samaria and Jerusalem and exile."
            },
            "1Chronicles": {
                name: "1 Chronicles",
                chapters: 29,
                author: "Unknown, traditionally Ezra",
                location: "Post‑exilic Judah",
                date: "c. 450–400 BC",
                synopsis: "Genealogies and a retelling of David’s reign with focus on worship and the temple."
            },
            "2Chronicles": {
                name: "2 Chronicles",
                chapters: 36,
                author: "Unknown, traditionally Ezra",
                location: "Post‑exilic Judah",
                date: "c. 450–400 BC",
                synopsis: "History of Judah’s kings, temple worship, and the fall of Jerusalem, ending with Cyrus’ decree."
            },
            "Ezra": {
                name: "Ezra",
                chapters: 10,
                author: "Ezra",
                location: "Babylon and Jerusalem",
                date: "c. 458–440 BC",
                synopsis: "Return from exile, rebuilding the temple, and Ezra’s reforms to restore covenant faithfulness."
            },
            "Nehemiah": {
                name: "Nehemiah",
                chapters: 13,
                author: "Nehemiah (with possible editorial additions)",
                location: "Susa and Jerusalem",
                date: "c. 445–430 BC",
                synopsis: "Rebuilding Jerusalem’s walls and renewing the people’s commitment to God’s Law."
            },
            "Esther": {
                name: "Esther",
                chapters: 10,
                author: "Unknown (possibly a Persian‑period Jew)",
                location: "Persian Empire (Susa)",
                date: "c. 460–430 BC",
                synopsis: "God’s providential preservation of the Jews through Esther and Mordecai in Persia."
            },

            // POETRY / WISDOM
            "Job": {
                name: "Job",
                chapters: 42,
                author: "Unknown (possibly early patriarchal era)",
                location: "Land of Uz",
                date: "Possibly second millennium BC (patriarchal period)",
                synopsis: "A righteous man’s suffering, dialogues on God’s justice, and God’s sovereign answer from the whirlwind."
            },
            "Psalms": {
                name: "Psalms",
                chapters: 150,
                author: "Multiple (David, Asaph, sons of Korah, others)",
                location: "Israel",
                date: "c. 1000–400 BC (compiled over centuries)",
                synopsis: "A collection of prayers, songs, and praises expressing the full range of human experience before God."
            },
            "Proverbs": {
                name: "Proverbs",
                chapters: 31,
                author: "Primarily Solomon, with other wise men",
                location: "Israel",
                date: "c. 970–700 BC (compiled)",
                synopsis: "Short sayings and teachings on wise living in the fear of the Lord."
            },
            "Ecclesiastes": {
                name: "Ecclesiastes",
                chapters: 12,
                author: "Traditionally Solomon (“Qoheleth”)",
                location: "Jerusalem",
                date: "c. 950–930 BC",
                synopsis: "Reflections on life’s vanity apart from God and the call to fear God and keep His commandments."
            },
            "Song of Solomon": {
                name: "Song of Solomon",
                chapters: 8,
                author: "Solomon",
                location: "Israel",
                date: "c. 950–930 BC",
                synopsis: "A poetic celebration of marital love, often seen as reflecting God’s love for His people."
            },

            // MAJOR PROPHETS
            "Isaiah": {
                name: "Isaiah",
                chapters: 66,
                author: "Isaiah son of Amoz",
                location: "Jerusalem",
                date: "c. 740–680 BC",
                synopsis: "Prophecies of judgment and hope, including strong messianic promises and visions of future restoration."
            },
            "Jeremiah": {
                name: "Jeremiah",
                chapters: 52,
                author: "Jeremiah the prophet",
                location: "Jerusalem (later Egypt)",
                date: "c. 627–580 BC",
                synopsis: "Warnings of coming judgment on Judah, calls to repentance, and promises of a new covenant."
            },
            "Lamentations": {
                name: "Lamentations",
                chapters: 5,
                author: "Traditionally Jeremiah",
                location: "Jerusalem (after its fall)",
                date: "c. 586–580 BC",
                synopsis: "Poetic laments over the destruction of Jerusalem, mingled with hope in God’s steadfast love."
            },
            "Ezekiel": {
                name: "Ezekiel",
                chapters: 48,
                author: "Ezekiel the priest‑prophet",
                location: "Babylon (among the exiles)",
                date: "c. 593–571 BC",
                synopsis: "Visions of God’s glory, judgment on Israel and the nations, and future restoration and a new temple."
            },
            "Daniel": {
                name: "Daniel",
                chapters: 12,
                author: "Daniel",
                location: "Babylon and Persia",
                date: "c. 605–536 BC",
                synopsis: "Narratives of faith in exile and apocalyptic visions of future kingdoms and God’s ultimate rule."
            },

            // MINOR PROPHETS
            "Hosea": {
                name: "Hosea",
                chapters: 14,
                author: "Hosea",
                location: "Northern Kingdom (Israel)",
                date: "c. 755–715 BC",
                synopsis: "Hosea’s marriage illustrates God’s faithful love toward an unfaithful people."
            },
            "Joel": {
                name: "Joel",
                chapters: 3,
                author: "Joel",
                location: "Judah",
                date: "c. 835–800 BC (conservative estimate)",
                synopsis: "A locust plague foreshadows the day of the Lord and God’s promise to pour out His Spirit."
            },
            "Amos": {
                name: "Amos",
                chapters: 9,
                author: "Amos, a shepherd from Tekoa",
                location: "Judah and Israel",
                date: "c. 760–750 BC",
                synopsis: "Oracles of judgment against social injustice and religious hypocrisy, with a promise of restoration."
            },
            "Obadiah": {
                name: "Obadiah",
                chapters: 1,
                author: "Obadiah",
                location: "Judah",
                date: "c. 586–550 BC",
                synopsis: "Judgment on Edom for its pride and violence, and the future triumph of the Lord’s kingdom."
            },
            "Jonah": {
                name: "Jonah",
                chapters: 4,
                author: "Traditionally Jonah",
                location: "Israel and Nineveh",
                date: "c. 780–760 BC",
                synopsis: "A reluctant prophet is sent to Nineveh, revealing God’s compassion for repentant sinners."
            },
            "Micah": {
                name: "Micah",
                chapters: 7,
                author: "Micah",
                location: "Judah",
                date: "c. 740–700 BC",
                synopsis: "Judgment on Samaria and Jerusalem, with promises of a coming ruler from Bethlehem."
            },
            "Nahum": {
                name: "Nahum",
                chapters: 3,
                author: "Nahum",
                location: "Judah",
                date: "c. 663–612 BC",
                synopsis: "Prophecy of Nineveh’s fall, showing God’s justice against oppressive nations."
            },
            "Habakkuk": {
                name: "Habakkuk",
                chapters: 3,
                author: "Habakkuk",
                location: "Judah",
                date: "c. 620–600 BC",
                synopsis: "A dialogue with God about evil and injustice, concluding with trust in God’s sovereign plan."
            },
            "Zephaniah": {
                name: "Zephaniah",
                chapters: 3,
                author: "Zephaniah",
                location: "Judah",
                date: "c. 640–620 BC",
                synopsis: "Warnings of the day of the Lord and promises of purification and restoration for a humble remnant."
            },
            "Haggai": {
                name: "Haggai",
                chapters: 2,
                author: "Haggai",
                location: "Jerusalem",
                date: "520 BC",
                synopsis: "Calls the returned exiles to rebuild the temple and promises God’s future glory."
            },
            "Zechariah": {
                name: "Zechariah",
                chapters: 14,
                author: "Zechariah",
                location: "Jerusalem",
                date: "c. 520–518 BC (visions) and later oracles",
                synopsis: "Visions and prophecies encouraging the rebuilding of the temple and pointing to the coming Messiah."
            },
            "Malachi": {
                name: "Malachi",
                chapters: 4,
                author: "Malachi",
                location: "Post‑exilic Judah",
                date: "c. 460–430 BC",
                synopsis: "Confronts spiritual apathy and promises a coming messenger before the day of the Lord."
            },

            // GOSPELS
            "Matthew": {
                name: "Matthew",
                chapters: 28,
                author: "Matthew the apostle",
                location: "Likely Syria or Palestine",
                date: "c. AD 50–65",
                synopsis: "Presents Jesus as the promised Messiah and King, fulfilling Old Testament prophecy."
            },
            "Mark": {
                name: "Mark",
                chapters: 16,
                author: "John Mark (associate of Peter)",
                location: "Likely Rome",
                date: "c. AD 50–60",
                synopsis: "A fast‑paced account of Jesus’ ministry, emphasizing His authority and servanthood."
            },
            "Luke": {
                name: "Luke",
                chapters: 24,
                author: "Luke the physician",
                location: "Likely Greece or Syria",
                date: "c. AD 60–62",
                synopsis: "An orderly narrative of Jesus’ life, highlighting His compassion for the marginalized."
            },
            "John": {
                name: "John",
                chapters: 21,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 80–90",
                synopsis: "Emphasizes Jesus as the eternal Son of God, that readers may believe and have life in His name."
            },

            // ACTS
            "Acts": {
                name: "Acts",
                chapters: 28,
                author: "Luke",
                location: "Likely Rome",
                date: "c. AD 62",
                synopsis: "The spread of the gospel from Jerusalem to Rome through the apostles, especially Peter and Paul."
            },

            // PAULINE EPISTLES
            "Romans": {
                name: "Romans",
                chapters: 16,
                author: "Paul",
                location: "Corinth",
                date: "c. AD 56–57",
                synopsis: "A systematic exposition of the gospel, justification by faith, and life in Christ."
            },
            "1Corinthians": {
                name: "1 Corinthians",
                chapters: 16,
                author: "Paul",
                location: "Ephesus",
                date: "c. AD 54–55",
                synopsis: "Addresses church divisions, immorality, spiritual gifts, and the resurrection."
            },
            "2Corinthians": {
                name: "2 Corinthians",
                chapters: 13,
                author: "Paul",
                location: "Macedonia",
                date: "c. AD 55–56",
                synopsis: "Defends Paul’s ministry and highlights God’s power in weakness and generous giving."
            },
            "Galatians": {
                name: "Galatians",
                chapters: 6,
                author: "Paul",
                location: "Likely Antioch or Corinth",
                date: "c. AD 48–55 (early letter)",
                synopsis: "Defends justification by faith alone against legalism and insists on freedom in Christ."
            },
            "Ephesians": {
                name: "Ephesians",
                chapters: 6,
                author: "Paul",
                location: "Imprisonment (likely Rome)",
                date: "c. AD 60–62",
                synopsis: "Explores the believer’s position in Christ and the unity and conduct of the church."
            },
            "Philippians": {
                name: "Philippians",
                chapters: 4,
                author: "Paul",
                location: "Imprisonment (likely Rome)",
                date: "c. AD 60–62",
                synopsis: "A joyful letter encouraging humility, unity, and rejoicing in Christ in all circumstances."
            },
            "Colossians": {
                name: "Colossians",
                chapters: 4,
                author: "Paul",
                location: "Imprisonment (likely Rome)",
                date: "c. AD 60–62",
                synopsis: "Affirms Christ’s supremacy over all creation and warns against false teaching."
            },
            "1Thessalonians": {
                name: "1 Thessalonians",
                chapters: 5,
                author: "Paul",
                location: "Corinth",
                date: "c. AD 50–51",
                synopsis: "Encourages a young church in faith, love, hope, and readiness for Christ’s return."
            },
            "2Thessalonians": {
                name: "2 Thessalonians",
                chapters: 3,
                author: "Paul",
                location: "Corinth",
                date: "c. AD 51–52",
                synopsis: "Clarifies teaching about the day of the Lord and exhorts believers to steadfastness and work."
            },
            "1Timothy": {
                name: "1 Timothy",
                chapters: 6,
                author: "Paul",
                location: "Macedonia",
                date: "c. AD 62–64",
                synopsis: "Instructions to Timothy on church leadership, sound doctrine, and godly living."
            },
            "2Timothy": {
                name: "2 Timothy",
                chapters: 4,
                author: "Paul",
                location: "Imprisonment in Rome",
                date: "c. AD 64–67",
                synopsis: "Paul’s final letter, urging Timothy to endure, preach the Word, and remain faithful."
            },
            "Titus": {
                name: "Titus",
                chapters: 3,
                author: "Paul",
                location: "Possibly Macedonia or Nicopolis",
                date: "c. AD 62–64",
                synopsis: "Guidance for appointing elders and promoting sound doctrine and good works in Crete."
            },
            "Philemon": {
                name: "Philemon",
                chapters: 1,
                author: "Paul",
                location: "Imprisonment (likely Rome)",
                date: "c. AD 60–62",
                synopsis: "A personal appeal for Onesimus, a runaway slave, to be received as a brother in Christ."
            },

            // GENERAL EPISTLES
            "Hebrews": {
                name: "Hebrews",
                chapters: 13,
                author: "Unknown (traditionally Paul or a close associate)",
                location: "Unknown",
                date: "c. AD 60–70",
                synopsis: "Shows Christ’s superiority over all and encourages perseverance in faith amid persecution."
            },
            "James": {
                name: "James",
                chapters: 5,
                author: "James, the brother of Jesus",
                location: "Jerusalem",
                date: "c. AD 44–49",
                synopsis: "Practical teaching on living out genuine faith through works and godly wisdom."
            },
            "1Peter": {
                name: "1 Peter",
                chapters: 5,
                author: "Peter the apostle",
                location: "“Babylon” (likely Rome)",
                date: "c. AD 62–64",
                synopsis: "Encourages suffering believers with hope, holiness, and the example of Christ."
            },
            "2Peter": {
                name: "2 Peter",
                chapters: 3,
                author: "Peter the apostle",
                location: "Likely Rome",
                date: "c. AD 64–67",
                synopsis: "Warns against false teachers and reminds believers of Christ’s promised return."
            },
            "1John": {
                name: "1 John",
                chapters: 5,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 85–95",
                synopsis: "Assures believers of eternal life and emphasizes love, obedience, and true doctrine."
            },
            "2John": {
                name: "2 John",
                chapters: 1,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 85–95",
                synopsis: "A brief letter urging love and truth while rejecting false teachers."
            },
            "3John": {
                name: "3 John",
                chapters: 1,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 85–95",
                synopsis: "Commends Gaius for hospitality and warns against Diotrephes’ pride and opposition."
            },
            "Jude": {
                name: "Jude",
                chapters: 1,
                author: "Jude, the brother of James",
                location: "Unknown",
                date: "c. AD 65–80",
                synopsis: "Urges believers to contend for the faith against false teachers and to remain in God’s love."
            },

            // REVELATION
            "Revelation": {
                name: "Revelation",
                chapters: 22,
                author: "John the apostle",
                location: "Island of Patmos",
                date: "c. AD 95–96",
                synopsis: "Apocalyptic visions revealing Christ’s ultimate victory, final judgment, and the new creation."
            }
        };

        return overviews[book] || null;
    }

    // SETTINGS MANAGEMENT HELPERS ================================================================================
    toggleVersion(version, enabled) {
        const list = this.settings.enabledVersions;

        if (enabled) {
            if (!list.includes(version)) list.push(version);
        } else {
            this.settings.enabledVersions = list.filter(v => v !== version);
        }
    }
    moveVersion(fromIndex, toIndex) {
        const list = this.settings.enabledVersions;
        const item = list.splice(fromIndex, 1)[0];
        list.splice(toIndex, 0, item);
    }
    async rewriteStepLinks() {
        const files = this.app.vault.getMarkdownFiles();

        // Build the version part from your toggles
        const versionPart = this.settings.enabledVersions.length
            ? this.settings.enabledVersions.map(v => `version=${v}`).join("@")
            : "";

        for (const file of files) {
            let data = await this.app.vault.read(file);
            let updated = data;

            // CASE 1: Replace existing version block
            updated = updated.replace(
                /version=[A-Za-z0-9]+(?:@version=[A-Za-z0-9]+)*/g,
                versionPart
            );

            // CASE 2: Replace empty version block: q=@reference=
            updated = updated.replace(
                /q=@reference=/g,
                versionPart
                    ? `q=${versionPart}@reference=`
                    : `q=@reference=` // leave empty if no versions enabled
            );

            if (updated !== data) {
                await this.app.vault.modify(file, updated);
            }
        }

        new Notice("STEP Bible links updated.");
    }
    async toggleLocaltoOnline() {
        const vault = this.app.vault;
        const mdFiles = vault.getMarkdownFiles();

        // Determine target prefix based on setting
        const targetPrefix = this.urlPrefix; // either localhost or online

        // Determine the opposite prefix
        const onlinePrefix = "https://www.stepbible.org/";
        const localPrefix = "http://localhost:8989/";

        const sourcePrefix = targetPrefix === localPrefix
            ? onlinePrefix
            : localPrefix;

        for (const file of mdFiles) {
            const text = await vault.read(file);

            // Replace ALL occurrences of the source prefix with the target prefix
            const replaced = text.replace(
                new RegExp(sourcePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
                targetPrefix
            );

            if (replaced !== text) {
                await vault.modify(file, replaced);
            }
        }

        this.urlPrefix = targetPrefix;

        new Notice("STEP Bible Links Updated.");
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.urlPrefix = this.settings.useLocalUrlPrefix
            ? "http://localhost:8989/"
            : "https://www.stepbible.org/";
    } 
    async saveSettings() {
        await this.saveData(this.settings);
        this.urlPrefix = this.settings.useLocalStepServer
            ? "http://localhost:8989/"
            : "https://www.stepbible.org/";
    }

    // PLUGIN UNLOAD
    onunload() {
        if (this.activePopover && this.activePopover.parentNode) {
            this.activePopover.parentNode.removeChild(this.activePopover);
        }
        console.log('STEP Bible Linker unloaded.');
    }
}