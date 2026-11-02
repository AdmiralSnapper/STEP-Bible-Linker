const { Plugin, PluginSettingTab, Modal, MarkdownRenderer, ItemView, Setting, requestUrl, Notice, AbstractInputSuggest, TFolder, setIcon } = require('obsidian');

//SETTINGS ======================================================================
/**
 * @typedef {Object} StepBibleLinkerSettings
 * @property {boolean} autoSyncOnNavigation - If true, STEP auto-syncs on navigation
 * @property {boolean} autoCloseSearchPanel - If true, the STEP search panel auto-closes when switching to a non-STEP tab
 * @property {boolean} useLocalStepServer - If true, use local URL prefix
 * @property {string[]} globalVersions - Master list and ordering of versions configured in settings
 * @property {string[]} localVersions - Active versions toggled in search modal and used in links
 */

/** @type {StepBibleLinkerSettings} */
const DEFAULT_SETTINGS = {
    autoSyncOnNavigation: true,
    autoCloseSearchPanel: true,
    useLocalStepServer: true,
    globalVersions: ["ESV", "THOT", "SBLG"],
    localVersions: ["ESV", "THOT", "SBLG"],
    noteLinesColour: "#17758f",
    typedColours: {},
    noteTypesFolder: "",
};

/**
 * Suggests vault folders as the user types into a text input.
 */
class FolderSuggest extends AbstractInputSuggest {
    constructor(app, inputEl, onPick) {
        super(app, inputEl);
        this.onPick = onPick;
    }

    getSuggestions(query) {
        const q = query.toLowerCase();
        return this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(q))
            .map(f => f.path);
    }

    renderSuggestion(path, el) {
        el.setText(path);
    }

    selectSuggestion(path) {
        if (this.inputEl) this.inputEl.setValue(path);
        this.close();
        if (this.onPick) this.onPick(path);
    }
}

// ==== TYPED NOTE PARSER (pure, testable outside Obsidian) ====
// START_TYPED_PARSER
/**
 * Parse one typed note file's text into entries.
 * A reference line is a line that starts with a markdown link whose target
 * contains "reference=". Everything up to the next reference line is that
 * entry's freeform content (text, images, anything).
 *
 * Returns { entries, crosslinks }: entries are [{ refText, refRaw, source,
 * content }] in file order (a repeated reference in the same file produces one
 * entry whose contents are concatenated); crosslinks are references found
 * inside freeform content, each { refText, refRaw, source, target } pointing
 * at the entry it lives in. Sections MUST be separated by a line of only
 * dashes (---, 3 or more), which also closes any escape block: a reference
 * line before the next --- is content (its refs become crosslinks), so refs
 * can be written at the start of lines without opening a new section. A line
 * of only tildes (~~~) toggles an escape block (legacy, kept for
 * compatibility). A reference line may begin with an optional "(["
 * wrapper, e.g. "([Gen 3:16](url)) notes".
 */
function parseTypedFile(text, fileBasename) {
    const refLine = /^[ \t]*(?:\(\s*)?\[([^\]]+)\]\(([^)]*reference=[^)]*)\)(.*)$/; // optional "(" before the link; link must start the line
    const inlineRef = /\[([^\]]+)\]\(([^)]*reference=[^)]*)\)/g;
    const entries = [];
    const crosslinks = [];
    const byRef = new Map();
    let current = null;
    let escaped = false; // inside a ~~~ block: line-start refs are content, not section starts
    let closed = true;   // a --- has closed the previous section (true at file start)

    for (const line of text.split(/\r?\n/)) {
        if (/^[ \t]*-{3,}[ \t]*$/.test(line)) {
            // --- : hard section break; also closes any open escape block.
            // Blank separator lines after it belong to no section and are dropped.
            escaped = false;
            current = null;
            closed = true;
            continue;
        }
        if (/^[ \t]*~{3,}[ \t]*$/.test(line)) {
            escaped = !escaped; // toggle escape block
            continue;
        }
        const m = escaped ? null : line.match(refLine);
        if (m && closed) {
            const refText = m[1].trim();
            const refRaw = decodeURIComponent(m[2].trim());
            const trailing = m[3] ? m[3].replace(/^[ \t]*\)/, "") : ""; // drop the closing paren of an "([...])" wrapper
            if (byRef.has(refRaw)) {
                current = byRef.get(refRaw); // duplicate ref: append content to existing entry
            } else {
                current = { refText, refRaw, source: fileBasename, content: "" };
                byRef.set(refRaw, current);
                entries.push(current);
            }
            closed = false; // next section needs a --- first
            if (trailing.trim()) current.content += (current.content ? "\n" : "") + trailing.trim();
            continue;
        }
        if (current) current.content += (current.content ? "\n" : "") + line;
        // crosslinks: any reference link on a line that did not start a section
        if (current) {
            for (const cm of line.matchAll(inlineRef)) {
                crosslinks.push({
                    refText: cm[1].trim(),
                    refRaw: decodeURIComponent(cm[2].trim()),
                    source: fileBasename,
                    target: current, // the section this crosslink points to
                });
            }
        }
    }

    // trim leading/trailing blank lines from each entry's content
    for (const e of entries) {
        e.content = e.content.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
    }
    return { entries, crosslinks };
}

// Canonical book order (matches the verse-count table's key order), used to
// compare two references positionally.
const STEP_BOOK_ORDER = ["Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth","1Samuel","2Samuel","1Kings","2Kings","1Chronicles","2Chronicles","Ezra","Nehemiah","Esther","Job","Psalms","Proverbs","Ecclesiastes","SongofSongs","Song","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel","Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi","Matthew","Mark","Luke","John","Acts","Romans","1Corinthians","2Corinthians","Galatians","Ephesians","Philippians","Colossians","1Thessalonians","2Thessalonians","1Timothy","2Timothy","Titus","Philemon","Hebrews","James","1Peter","2Peter","1John","2John","3John","Jude","Revelation"];

/**
 * Turn a canonical reference range ("Genesis.1.1", "Genesis.1", or
 * "Genesis.1.1-Genesis.1.3") into a comparable [start, end] ordinal pair.
 * A chapter-only reference covers the whole chapter.
 */
function canonBounds(range) {
    if (!range) return null;
    const point = (s) => {
        const p = String(s).trim().split(".");
        const bi = STEP_BOOK_ORDER.indexOf(p[0]);
        const ch = parseInt(p[1], 10);
        const v = p[2] ? parseInt(p[2], 10) : null;
        if (bi < 0 || !ch) return null;
        return { bi, ch, v };
    };
    const parts = String(range).split("-").map(s => s.trim()).filter(Boolean);
    const a = point(parts[0]);
    if (!a) return null;
    const b = parts.length > 1 ? point(parts[parts.length - 1]) : a;
    if (!b) return null;
    const ord = (p, end) => p.bi * 1e9 + p.ch * 1e6 + (p.v == null ? (end ? 999999 : 0) : p.v);
    return { start: ord(a, false), end: ord(b, true) };
}

/**
 * How does a reference found inside a section relate to that section's own
 * reference? Returns one of:
 *   "self"     — same passage (no bar needed)
 *   "nested"   — the target sits inside the section (detail within scope)
 *   "encloses" — the target wraps the whole section
 *   "external" — a genuine cross-reference elsewhere
 */
function scopeRelation(sectionCanon, targetCanon) {
    const s = canonBounds(sectionCanon);
    const t = canonBounds(targetCanon);
    if (!s || !t) return "external";
    if (t.start >= s.start && t.end <= s.end) {
        return (t.start === s.start && t.end === s.end) ? "self" : "nested";
    }
    if (s.start >= t.start && s.end <= t.end) return "encloses";
    return "external";
}
// END_TYPED_PARSER

class StepBibleLinkerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    rebuildGlobalVersions(activeEnglish, activeOriginal) {
        const newGlobal = [...activeEnglish, ...activeOriginal];
        this.plugin.settings.globalVersions = newGlobal;
        
        // Ensure localVersions only contains versions in globalVersions and preserves order
        const currentLocal = this.plugin.settings.localVersions || [];
        this.plugin.settings.localVersions = newGlobal.filter(v => currentLocal.includes(v));
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
                        await this.plugin.toggleLocaltoOnline();
                        this.display();
                    });
            });

        containerEl.createEl("h3", { text: "STEP Note bars" });

        new Setting(containerEl)
            .setName("Bible notes folder")
            .setDesc("Vault folder holding one markdown file per note type. Bible references outside this folder are still detected, but will display the entire markdown file, not a single reference section.")
            .addText(text => {
                text
                    .setPlaceholder("e.g. Folder/File")
                    .setValue(this.plugin.settings.noteTypesFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.noteTypesFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
                new FolderSuggest(this.app, text.inputEl, async (path) => {
                    this.plugin.settings.noteTypesFolder = path;
                    await this.plugin.saveSettings();
                    this.display(); // re-render so the visible value matches what was saved
                });
            });

        // COLOURS SECTION
        new Setting(containerEl)
            .setName("Note bar colour")
            .setDesc("Colour of notes outside Bible notes folder.")
            .addColorPicker(color => {
                color
                    .setValue(this.plugin.settings.noteLinesColour)
                    .onChange(async (value) => {
                        this.plugin.settings.noteLinesColour = value;
                        await this.plugin.saveSettings();
                    });
            })
            .addText(text => {
                text
                    .setValue(this.plugin.settings.noteLinesColour)
                    .setPlaceholder("#17758f")
                    .onChange(async (value) => {
                        if (/^#[0-9a-fA-F]{3,8}$/.test(value.trim())) {
                            this.plugin.settings.noteLinesColour = value.trim();
                            await this.plugin.saveSettings();
                            this.plugin.refreshNoteDots();
                        }
                    });
            });

        // Per-type bar colours, updating live as types are added/removed.
        const colourRow = (name) => {
            const s = new Setting(containerEl)
                .setName(name)
                .setDesc("Bar colour for this note type.")
                .addColorPicker(color => color
                    .setValue(this.plugin.settings.typedColours[name])
                    .onChange(async (value) => {
                        this.plugin.settings.typedColours[name] = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshNoteDots();
                    }))
                .addText(text => text
                    .setValue(this.plugin.settings.typedColours[name])
                    .onChange(async (value) => {
                        const v = value.trim();
                        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
                            this.plugin.settings.typedColours[name] = v;
                            await this.plugin.saveSettings();
                            this.plugin.refreshNoteDots();
                        }
                    }));
            return s;
        };
        const typeColourNames = Object.keys(this.plugin.settings.typedColours).sort();
        if (!typeColourNames.length) {
            containerEl.createEl("p", {
                text: "No note types yet — add one below and its colour appears here.",
                cls: "setting-item-description"
            });
        }
        for (const n of typeColourNames) colourRow(n);

        // NOTE TYPES SECTION: a live list of type files with edit/delete.
        containerEl.createEl("h3", { text: "Note types" });
        const folderPath = (this.plugin.settings.noteTypesFolder || "").trim().replace(/\/+$/, "");
        const folderObj = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : null;
        const folderExists = !!(folderObj && folderObj.children);

        // ADD: create a new type file in the folder; its colour row appears immediately.
        new Setting(containerEl)
            .setName("Add note type")
            .setDesc(folderExists
                ? "Creates a new markdown file in the note types folder."
                : "Pick a note types folder first (above).")
            .addText(text => {
                text.inputEl.classList.add("step-new-type-input");
                text.setPlaceholder("New type name");
            })
            .addExtraButton(btn => btn
                .setIcon("plus")
                .setTooltip("Create type")
                .onClick(async () => {
                    if (!folderExists) return;
                    const input = containerEl.querySelector(".step-new-type-input");
                    const name = input ? input.value.trim() : "";
                    if (!name || /[\\/:]/.test(name)) return;
                    const path = `${folderPath}/${name}.md`;
                    if (this.app.vault.getAbstractFileByPath(path)) {
                        new Notice(`A file "${name}.md" already exists there.`);
                        return;
                    }
                    await this.app.vault.create(path, "");
                    // assign a colour now so the row shows immediately
                    const palette = ["#c05761", "#5b8c5a", "#b8860b", "#7f5fbf", "#2e86ab", "#c97b2d"];
                    this.plugin.settings.typedColours[name] = palette[Object.keys(this.plugin.settings.typedColours).length % palette.length];
                    await this.plugin.saveSettings();
                    this.plugin.refreshNoteDots();
                    this.display();
                }));

        // Existing types: open-for-edit and delete buttons; live via refreshNoteDots.
        const listTypeNames = () => {
            if (!folderExists) return [];
            const f = this.app.vault.getFolderByPath(folderPath);
            return f.children.filter(c => c.path && c.path.endsWith(".md")).map(c => c.basename).sort();
        };
        const typeNames = listTypeNames();
        if (!typeNames.length) {
            containerEl.createEl("p", {
                text: "No note types yet. Pick a folder above and add a type; it will appear here.",
                cls: "setting-item-description"
            });
        }
        for (const typeName of typeNames) {
            new Setting(containerEl)
                .setName(typeName)
                .addButton(btn => btn
                    .setIcon("edit")
                    .setTooltip("Open this type's file for editing")
                    .onClick(async () => {
                        const file = this.app.vault.getAbstractFileByPath(`${folderPath}/${typeName}.md`);
                        if (!file) { new Notice(`No file "${typeName}.md" found.`); return; }
                        await this.app.workspace.getLeaf("tab").openFile(file);
                    }))
                .addButton(btn => btn
                    .setIcon("trash")
                    .setTooltip("Delete this type: removes the file from the folder and its colour from settings")
                    .onClick(async () => {
                        if (folderExists) {
                            const file = this.app.vault.getAbstractFileByPath(`${folderPath}/${typeName}.md`);
                            if (file) await this.app.vault.delete(file);
                        }
                        delete this.plugin.settings.typedColours[typeName];
                        await this.plugin.saveSettings();
                        this.plugin.refreshNoteDots();
                        this.display();
                    }));
        }

        const globalList = this.plugin.settings.globalVersions || [];

        // 1. ENGLISH VERSIONS SECTION ================================================================
        containerEl.createEl("h3", { text: "English Versions" });

        const allEnglish = ["ESV", "NIV", "KJV"];
        let activeEnglish = globalList.filter(v => allEnglish.includes(v));
        const inactiveEnglish = allEnglish.filter(v => !activeEnglish.includes(v));

        const allOriginal = ["THOT", "SBLG", "LXX"];
        let activeOriginal = globalList.filter(v => allOriginal.includes(v));
        const inactiveOriginal = allOriginal.filter(v => !activeOriginal.includes(v));

        const originalNames = {
            "THOT": "Hebrew Old Testament (THOT)",
            "SBLG": "Greek New Testament (SBLG)",
            "LXX": "Septuagint (LXX)"
        };

        // Active English versions (reorderable)
        activeEnglish.forEach((version, index) => {
            new Setting(containerEl)
                .setName(version)
                .addToggle(toggle => {
                    toggle.setValue(true).onChange(async (value) => {
                        if (!value) {
                            activeEnglish = activeEnglish.filter(v => v !== version);
                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        }
                    });
                })
                .addButton(btn => {
                    btn.setButtonText("↑")
                        .setDisabled(index === 0)
                        .onClick(async () => {
                            const temp = activeEnglish[index];
                            activeEnglish[index] = activeEnglish[index - 1];
                            activeEnglish[index - 1] = temp;

                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        });
                })
                .addButton(btn => {
                    btn.setButtonText("↓")
                        .setDisabled(index === activeEnglish.length - 1)
                        .onClick(async () => {
                            const temp = activeEnglish[index];
                            activeEnglish[index] = activeEnglish[index + 1];
                            activeEnglish[index + 1] = temp;

                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        });
                });
        });

        // Inactive English versions
        inactiveEnglish.forEach((version) => {
            new Setting(containerEl)
                .setName(version)
                .addToggle(toggle => {
                    toggle.setValue(false).onChange(async (value) => {
                        if (value) {
                            activeEnglish.push(version);
                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            if (!this.plugin.settings.localVersions.includes(version)) {
                                this.plugin.settings.localVersions.push(version);
                            }
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        }
                    });
                });
        });

        // 2. ORIGINAL & ANCIENT LANGUAGES SECTION ====================================================
        containerEl.createEl("h3", { text: "Original & Ancient Languages" });

        // Active Original versions (reorderable)
        activeOriginal.forEach((version, index) => {
            new Setting(containerEl)
                .setName(originalNames[version] || version)
                .addToggle(toggle => {
                    toggle.setValue(true).onChange(async (value) => {
                        if (!value) {
                            activeOriginal = activeOriginal.filter(v => v !== version);
                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        }
                    });
                })
                .addButton(btn => {
                    btn.setButtonText("↑")
                        .setDisabled(index === 0)
                        .onClick(async () => {
                            const temp = activeOriginal[index];
                            activeOriginal[index] = activeOriginal[index - 1];
                            activeOriginal[index - 1] = temp;

                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        });
                })
                .addButton(btn => {
                    btn.setButtonText("↓")
                        .setDisabled(index === activeOriginal.length - 1)
                        .onClick(async () => {
                            const temp = activeOriginal[index];
                            activeOriginal[index] = activeOriginal[index + 1];
                            activeOriginal[index + 1] = temp;

                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        });
                });
        });

        // Inactive Original versions
        inactiveOriginal.forEach((version) => {
            new Setting(containerEl)
                .setName(originalNames[version] || version)
                .addToggle(toggle => {
                    toggle.setValue(false).onChange(async (value) => {
                        if (value) {
                            activeOriginal.push(version);
                            this.rebuildGlobalVersions(activeEnglish, activeOriginal);
                            if (!this.plugin.settings.localVersions.includes(version)) {
                                this.plugin.settings.localVersions.push(version);
                            }
                            await this.plugin.saveSettings();
                            await this.plugin.rewriteStepLinks();
                            this.display();
                        }
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

    updateQuery(queryRef, displayRef, force = false) {
        const queryKey = Array.isArray(queryRef) ? queryRef.join("|") : String(queryRef);

        if (!force && this._currentSearchKey === queryKey) {
            return;
        }

        this._currentSearchKey = queryKey;

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

                    // Remove tooltips (Obsidian attaches them to the anchors
                    // themselves) and keep links clickable.
                    this.plugin.stripLinkTooltips(preview, this.plugin.app.workspace.getActiveFile()?.path || "");

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
        this._isSubmitting = false;
        this._changesCommitted = false;

        // Draft state (only applied when Enter is pressed)
        this._draftLocalVersions = [...(this.plugin.settings.localVersions || [])];
        this._draftLocalStepServer = this.plugin.settings.useLocalStepServer;
        this._draftAutoSync = this.plugin.settings.autoSyncOnNavigation;
        this._draftAutoClose = this.plugin.settings.autoCloseSearchPanel;

        // Track last synced vault states (default to current if not set)
        if (!this.plugin.settings.lastSyncedVersions) {
            this.plugin.settings.lastSyncedVersions = [...(this.plugin.settings.localVersions || [])];
        }
        if (this.plugin.settings.lastSyncedServerMode === undefined) {
            this.plugin.settings.lastSyncedServerMode = this.plugin.settings.useLocalStepServer;
        }
    }

    hasAnyDraftChanges() {
        const local = this._draftLocalVersions;
        const currentLocal = this.plugin.settings.localVersions || [];
        const versionsChanged = local.length !== currentLocal.length || local.some((v, i) => v !== currentLocal[i]);
        const serverChanged = this._draftLocalStepServer !== this.plugin.settings.useLocalStepServer;
        const autoSyncChanged = this._draftAutoSync !== this.plugin.settings.autoSyncOnNavigation;
        const autoCloseChanged = this._draftAutoClose !== this.plugin.settings.autoCloseSearchPanel;
        return versionsChanged || serverChanged || autoSyncChanged || autoCloseChanged;
    }

    async triggerSyncIfWebviewerActive() {
        const activeLeaf = this.app.workspace.activeLeaf;
        let view = activeLeaf?.view;

        if (view?.getViewType?.() !== "webviewer") {
            const webLeaves = this.app.workspace.getLeavesOfType("webviewer");
            if (webLeaves.length > 0) {
                view = webLeaves[0].view;
            }
        }

        if (view && view.getViewType?.() === "webviewer") {
            const webviewEl = view.webview;
            const url = view.url || webviewEl?.getURL?.();
            if (url && (url.includes("stepbible.org") || url.includes("localhost:8989")) && webviewEl) {
                await this.plugin.searchWebviewUrl(url, webviewEl, { ignoreAutoSync: true, ignoreDuplicate: false });
            }
        }
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

        // Always open in a fresh tab:
        let targetLeaf = this.app.workspace.getLeaf("tab");
        if (targetLeaf && typeof targetLeaf.setViewState === "function") {
            await targetLeaf.setViewState({
                type: "webviewer",
                active: true,
                state: { url }
            });
            this.app.workspace.revealLeaf(targetLeaf);
        }

        if (!targetLeaf) {
            window.open(url, "_blank");
            return;
        }

        const waitForWebview = () => {
            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                const webviewEl = targetLeaf.view?.webview;
                if (webviewEl) {
                    clearInterval(interval);

                    // Attach centralized listeners via plugin helper
                    if (typeof this.plugin.attachWebviewListeners === "function") {
                        this.plugin.attachWebviewListeners(webviewEl);
                    }

                    if (this.plugin.settings.autoSyncOnNavigation) {
                        await this.plugin.searchWebviewUrl(url, webviewEl, { ignoreAutoSync: false, ignoreDuplicate: true });
                    }

                    await this.plugin.autoCollapseStepToolbar(webviewEl);
                }

                if (attempts > 50) {
                    clearInterval(interval);
                }
            }, 100);
        };

        waitForWebview();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "column";
        contentEl.style.gap = "10px";
        contentEl.style.padding = "16px";

        // 1. INPUT & TOGGLE ICON ROW ================================================================
        const inputRow = contentEl.createEl("div");
        inputRow.style.display = "flex";
        inputRow.style.alignItems = "center";
        inputRow.style.gap = "8px";

        const input = inputRow.createEl("input", {
            type: "text",
            placeholder: "Enter Reference (e.g. John 3.16)"
        });

        input.style.flex = "1";
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

        const isCurrentlyOpen = this.plugin.settings.searchModalSettingsOpen;

        // Settings Toggle Button (Gear Icon)
        const toggleBtn = inputRow.createEl("button");
        toggleBtn.tabIndex = -1;
        toggleBtn.style.height = "38px";
        toggleBtn.style.width = "38px";
        toggleBtn.style.display = "flex";
        toggleBtn.style.alignItems = "center";
        toggleBtn.style.justifyContent = "center";
        toggleBtn.style.fontSize = "16px";
        toggleBtn.style.cursor = "pointer";
        toggleBtn.style.borderRadius = "4px";
        toggleBtn.style.border = "1px solid var(--background-modifier-border)";
        toggleBtn.style.backgroundColor = isCurrentlyOpen
            ? "var(--interactive-accent)"
            : "var(--background-secondary)";
        toggleBtn.style.color = isCurrentlyOpen
            ? "var(--text-on-accent)"
            : "var(--text-muted)";
        toggleBtn.style.userSelect = "none";
        toggleBtn.style.outline = "none";
        toggleBtn.style.transition = "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)";

        const gearIcon = toggleBtn.createEl("span", { text: "⚙" });
        gearIcon.style.display = "inline-block";
        gearIcon.style.transition = "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)";
        gearIcon.style.transform = isCurrentlyOpen ? "rotate(90deg)" : "rotate(0deg)";

        // 2. ANIMATED COLLAPSIBLE WRAPPER ==========================================================
        const animWrapper = contentEl.createEl("div");
        animWrapper.style.display = "grid";
        animWrapper.style.gridTemplateRows = isCurrentlyOpen ? "1fr" : "0fr";
        animWrapper.style.transition = "grid-template-rows 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease";
        animWrapper.style.opacity = isCurrentlyOpen ? "1" : "0";

        const settingsDrawer = animWrapper.createEl("div");
        settingsDrawer.style.overflow = "hidden";
        settingsDrawer.style.display = "flex";
        settingsDrawer.style.flexDirection = "column";
        settingsDrawer.style.gap = "12px";
        settingsDrawer.style.padding = isCurrentlyOpen ? "12px" : "0px 12px";
        settingsDrawer.style.borderRadius = "6px";
        settingsDrawer.style.border = "1.5px solid var(--background-modifier-border)";
        settingsDrawer.style.backgroundColor = "transparent";
        settingsDrawer.style.transition = "border-color 0.2s ease, padding 0.25s ease";

        // Animated Container for bottom helper text
        const helperWrapper = settingsDrawer.createEl("div");
        helperWrapper.style.display = "grid";
        helperWrapper.style.gridTemplateRows = "0fr";
        helperWrapper.style.opacity = "0";
        helperWrapper.style.transition = "grid-template-rows 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease";

        const helperInner = helperWrapper.createEl("div");
        helperInner.style.overflow = "hidden";

        const helperText = helperInner.createEl("div", { text: "" });
        helperText.style.textAlign = "center";
        helperText.style.fontSize = "11px";
        helperText.style.color = "var(--text-muted)";
        helperText.style.paddingTop = "6px";
        helperText.style.userSelect = "none";

        const updateDrawerBorder = () => {
            if (this.hasAnyDraftChanges()) {
                settingsDrawer.style.borderColor = "var(--interactive-accent)";
                helperWrapper.style.gridTemplateRows = "1fr";
                helperWrapper.style.opacity = "1";

                const hasText = (input.value || "").trim().length > 0;
                helperText.setText(
                    hasText
                        ? "Press enter to confirm changes and open reference"
                        : "Press enter to confirm changes"
                );
            } else {
                settingsDrawer.style.borderColor = "var(--background-modifier-border)";
                helperWrapper.style.gridTemplateRows = "0fr";
                helperWrapper.style.opacity = "0";
                helperText.setText("");
            }
        };

        input.addEventListener("input", () => {
            updateDrawerBorder();
        });

        toggleBtn.onmousedown = (e) => e.preventDefault();

        toggleBtn.onclick = async (e) => {
            e.preventDefault();
            const isOpen = !this.plugin.settings.searchModalSettingsOpen;
            this.plugin.settings.searchModalSettingsOpen = isOpen;

            animWrapper.style.gridTemplateRows = isOpen ? "1fr" : "0fr";
            animWrapper.style.opacity = isOpen ? "1" : "0";
            settingsDrawer.style.padding = isOpen ? "12px" : "0px 12px";

            toggleBtn.style.backgroundColor = isOpen
                ? "var(--interactive-accent)"
                : "var(--background-secondary)";
            toggleBtn.style.color = isOpen
                ? "var(--text-on-accent)"
                : "var(--text-muted)";
            gearIcon.style.transform = isOpen ? "rotate(90deg)" : "rotate(0deg)";

            await this.plugin.saveSettings();
            input.focus();
        };

        const isVersionsOutOfSync = () => {
            const local = this._draftLocalVersions;
            const synced = this.plugin.settings.lastSyncedVersions || [];
            if (local.length !== synced.length) return true;
            return local.some((v, i) => v !== synced[i]);
        };

        const isServerOutOfSync = () => {
            return this._draftLocalStepServer !== this.plugin.settings.lastSyncedServerMode;
        };

        // =========================================================================
        // SECTION 1: VERSIONS
        // =========================================================================
        const versionsSection = settingsDrawer.createEl("div");
        versionsSection.style.display = "flex";
        versionsSection.style.flexDirection = "column";
        versionsSection.style.gap = "6px";

        const versionsTitle = versionsSection.createEl("span", { text: "Versions" });
        versionsTitle.style.fontSize = "12px";
        versionsTitle.style.fontWeight = "bold";
        versionsTitle.style.color = "var(--text-muted)";

        const versionsRow = versionsSection.createEl("div");
        versionsRow.style.display = "flex";
        versionsRow.style.justifyContent = "space-between";
        versionsRow.style.alignItems = "center";
        versionsRow.style.gap = "8px";

        const versionPillsContainer = versionsRow.createEl("div");
        versionPillsContainer.style.display = "flex";
        versionPillsContainer.style.flexWrap = "wrap";
        versionPillsContainer.style.gap = "6px";

        const changedIndicator = versionsRow.createEl("span", { text: "" });
        changedIndicator.style.flexShrink = "0";
        changedIndicator.style.fontSize = "11px";
        changedIndicator.style.fontWeight = "bold";
        changedIndicator.style.color = "var(--text-accent)";
        changedIndicator.style.userSelect = "none";

        const renderVersionPills = () => {
            versionPillsContainer.empty();

            const globalList = this.plugin.settings.globalVersions || [];
            const localList = this._draftLocalVersions;

            if (isVersionsOutOfSync()) {
                changedIndicator.setText("● Changed");
            } else {
                changedIndicator.setText("");
            }

            globalList.forEach(version => {
                const isActive = localList.includes(version);
                const btn = versionPillsContainer.createEl("button", { text: version });

                btn.tabIndex = -1;
                btn.style.padding = "4px 10px";
                btn.style.fontSize = "12px";
                btn.style.fontWeight = "bold";
                btn.style.borderRadius = "12px";
                btn.style.cursor = "pointer";
                btn.style.border = "none";
                btn.style.userSelect = "none";
                btn.style.outline = "none";
                btn.style.transition = "all 0.15s ease-in-out";

                if (isActive) {
                    btn.style.backgroundColor = "var(--interactive-accent)";
                    btn.style.color = "var(--text-on-accent)";
                } else {
                    btn.style.backgroundColor = "var(--background-modifier-border)";
                    btn.style.color = "var(--text-muted)";
                    btn.style.opacity = "0.7";
                }

                btn.onmousedown = (e) => e.preventDefault();

                btn.onclick = (e) => {
                    e.preventDefault();

                    if (isActive) {
                        this._draftLocalVersions = this._draftLocalVersions.filter(v => v !== version);
                    } else {
                        const updated = [...this._draftLocalVersions, version];
                        this._draftLocalVersions = globalList.filter(v => updated.includes(v));
                    }

                    renderVersionPills();
                    updateDrawerBorder();
                    input.focus();
                };
            });
        };

        renderVersionPills();

        // =========================================================================
        // SECTION 2: SEARCH PANEL
        // =========================================================================
        const searchPanelSection = settingsDrawer.createEl("div");
        searchPanelSection.style.display = "flex";
        searchPanelSection.style.flexDirection = "column";
        searchPanelSection.style.gap = "6px";

        const searchPanelTitle = searchPanelSection.createEl("span", { text: "Search Panel" });
        searchPanelTitle.style.fontSize = "12px";
        searchPanelTitle.style.fontWeight = "bold";
        searchPanelTitle.style.color = "var(--text-muted)";

        const searchPanelPillsContainer = searchPanelSection.createEl("div");
        searchPanelPillsContainer.style.display = "flex";
        searchPanelPillsContainer.style.flexWrap = "wrap";
        searchPanelPillsContainer.style.gap = "6px";

        const renderSearchPanelPills = () => {
            searchPanelPillsContainer.empty();

            const panelControls = [
                {
                    name: "Auto Search",
                    get: () => this._draftAutoSync,
                    set: (val) => { this._draftAutoSync = val; }
                },
                {
                    name: "Auto Close",
                    get: () => this._draftAutoClose,
                    set: (val) => { this._draftAutoClose = val; }
                }
            ];

            panelControls.forEach(ctrl => {
                const isActive = ctrl.get();
                const btn = searchPanelPillsContainer.createEl("button", { text: ctrl.name });

                btn.tabIndex = -1;
                btn.style.padding = "4px 10px";
                btn.style.fontSize = "12px";
                btn.style.fontWeight = "bold";
                btn.style.borderRadius = "12px";
                btn.style.cursor = "pointer";
                btn.style.border = "none";
                btn.style.userSelect = "none";
                btn.style.outline = "none";
                btn.style.transition = "all 0.15s ease-in-out";

                if (isActive) {
                    btn.style.backgroundColor = "var(--interactive-accent)";
                    btn.style.color = "var(--text-on-accent)";
                } else {
                    btn.style.backgroundColor = "var(--background-modifier-border)";
                    btn.style.color = "var(--text-muted)";
                    btn.style.opacity = "0.7";
                }

                btn.onmousedown = (e) => e.preventDefault();

                btn.onclick = (e) => {
                    e.preventDefault();
                    ctrl.set(!isActive);
                    renderSearchPanelPills();
                    updateDrawerBorder();
                    input.focus();
                };
            });
        };

        renderSearchPanelPills();

        // =========================================================================
        // SECTION 3: SERVER
        // =========================================================================
        const serverSection = settingsDrawer.createEl("div");
        serverSection.style.display = "flex";
        serverSection.style.flexDirection = "column";
        serverSection.style.gap = "6px";

        const serverTitle = serverSection.createEl("span", { text: "Server" });
        serverTitle.style.fontSize = "12px";
        serverTitle.style.fontWeight = "bold";
        serverTitle.style.color = "var(--text-muted)";

        const serverRow = serverSection.createEl("div");
        serverRow.style.display = "flex";
        serverRow.style.justifyContent = "space-between";
        serverRow.style.alignItems = "center";

        const serverPillContainer = serverRow.createEl("div");

        const localStatusIndicator = serverRow.createEl("span", { text: "" });
        localStatusIndicator.style.fontSize = "11px";
        localStatusIndicator.style.fontWeight = "bold";
        localStatusIndicator.style.userSelect = "none";

        const checkLocalServerStatus = async () => {
            const isRunning = await this.plugin.isLocalStepRunning();
            if (isRunning) {
                localStatusIndicator.setText("● Localhost Running");
                localStatusIndicator.style.color = "#4caf50";
            } else {
                localStatusIndicator.setText("● Localhost Offline");
                localStatusIndicator.style.color = "var(--text-muted)";
            }
        };

        checkLocalServerStatus();

        const renderServerPill = () => {
            serverPillContainer.empty();

            const isActive = this._draftLocalStepServer;
            const btn = serverPillContainer.createEl("button", { text: "Localhost" });

            btn.tabIndex = -1;
            btn.style.padding = "4px 10px";
            btn.style.fontSize = "12px";
            btn.style.fontWeight = "bold";
            btn.style.borderRadius = "12px";
            btn.style.cursor = "pointer";
            btn.style.border = "none";
            btn.style.userSelect = "none";
            btn.style.outline = "none";
            btn.style.transition = "all 0.15s ease-in-out";

            if (isActive) {
                btn.style.backgroundColor = "var(--interactive-accent)";
                btn.style.color = "var(--text-on-accent)";
            } else {
                btn.style.backgroundColor = "var(--background-modifier-border)";
                btn.style.color = "var(--text-muted)";
                btn.style.opacity = "0.7";
            }

            btn.onmousedown = (e) => e.preventDefault();

            btn.onclick = (e) => {
                e.preventDefault();
                this._draftLocalStepServer = !isActive;
                renderServerPill();
                updateDrawerBorder();
                input.focus();
            };
        };

        renderServerPill();

        settingsDrawer.appendChild(helperWrapper);
        updateDrawerBorder();

        const buildUrlWithDraftVersions = (urlRef) => {
            const versionPart = this._draftLocalVersions
                .map(v => `version=${v}`)
                .join("@");
            const prefix = this._draftLocalStepServer
                ? "http://localhost:8989/"
                : "https://www.stepbible.org/";
            return `${prefix}?q=${versionPart}@reference=${urlRef}&options=GNVUH&display=COLUMN&skipwelcome`;
        };

        const commitDraftAndSync = async () => {
            const versionsChanged = isVersionsOutOfSync();
            const serverChanged = isServerOutOfSync();
            const autoSyncTurnedOn = !this.plugin.settings.autoSyncOnNavigation && this._draftAutoSync;

            // Commit all settings directly to plugin
            this.plugin.settings.localVersions = [...this._draftLocalVersions];
            this.plugin.settings.useLocalStepServer = this._draftLocalStepServer;
            this.plugin.settings.autoSyncOnNavigation = this._draftAutoSync;
            this.plugin.settings.autoCloseSearchPanel = this._draftAutoClose;
            await this.plugin.saveSettings();

            if (serverChanged) {
                await this.plugin.toggleLocaltoOnline();
                this.plugin.settings.lastSyncedServerMode = this.plugin.settings.useLocalStepServer;
            }
            if (versionsChanged) {
                await this.plugin.rewriteStepLinks();
                this.plugin.settings.lastSyncedVersions = [...this.plugin.settings.localVersions];
            }
            if (autoSyncTurnedOn) {
                await this.triggerSyncIfWebviewerActive();
            }
            await this.plugin.saveSettings();
            new Notice("Settings updated");
        };

        const resetInputState = () => {
            this._isSubmitting = false;
            contentEl.style.opacity = "1";
            contentEl.style.pointerEvents = "auto";
            input.disabled = false;
            input.style.opacity = "1";
            input.style.cursor = "text";
            input.focus();
        };

        this._keydownHandler = async (evt) => {
            if (evt.key === "Enter") {
                evt.preventDefault();
                evt.stopPropagation();

                if (this._isSubmitting) return;

                const inputRef = (input.value || "").trim();

                // 1. If NO reference and NO changes: Simply close modal cleanly
                if (!inputRef && !this.hasAnyDraftChanges()) {
                    this._changesCommitted = true;
                    this.close();
                    return;
                }

                this._isSubmitting = true;

                // 2. If NO reference but THERE ARE changes: Grey out modal until links update
                if (!inputRef) {
                    contentEl.style.opacity = "0.5";
                    contentEl.style.pointerEvents = "none";
                    helperText.setText("Updating vault links...");

                    try {
                        await commitDraftAndSync();
                        this._changesCommitted = true;
                        updateDrawerBorder();
                        renderVersionPills();
                        renderSearchPanelPills();
                        renderServerPill();
                    } finally {
                        resetInputState();
                    }
                    return;
                }

                // 3. If reference IS entered: Validate, commit settings immediately, search, and close
                input.disabled = true;
                input.style.opacity = "0.5";
                input.style.cursor = "not-allowed";

                const regex = this.plugin.buildInputRefRegex();
                const match = inputRef.match(regex);

                if (!match || match[0].trim() !== inputRef) {
                    new Notice("Not a valid Bible reference.");
                    resetInputState();
                    return;
                }

                const urlRef = this.plugin.inputRef_urlRef(inputRef);
                if (!urlRef) {
                    resetInputState();
                    return;
                }

                const url = buildUrlWithDraftVersions(urlRef);
                const versionsChanged = isVersionsOutOfSync();
                const serverChanged = isServerOutOfSync();
                const autoSyncTurnedOn = !this.plugin.settings.autoSyncOnNavigation && this._draftAutoSync;

                // --- CRITICAL FIX: COMMIT SETTINGS SYNCHRONOUSLY BEFORE OPENING TAB ---
                this.plugin.settings.localVersions = [...this._draftLocalVersions];
                this.plugin.settings.useLocalStepServer = this._draftLocalStepServer;
                this.plugin.settings.autoSyncOnNavigation = this._draftAutoSync;
                this.plugin.settings.autoCloseSearchPanel = this._draftAutoClose;
                this._changesCommitted = true;

                // 1. Search & Open URL inside Obsidian tab
                if (url) {
                    await this.openStepUrl(url);
                }

                // 2. Close modal immediately
                this.close();

                // 3. Save settings to disk & update vault in background
                await this.plugin.saveSettings();

                if (versionsChanged || serverChanged || autoSyncTurnedOn) {
                    setTimeout(async () => {
                        if (serverChanged) {
                            await this.plugin.toggleLocaltoOnline();
                            this.plugin.settings.lastSyncedServerMode = this.plugin.settings.useLocalStepServer;
                        }
                        if (versionsChanged) {
                            await this.plugin.rewriteStepLinks();
                            this.plugin.settings.lastSyncedVersions = [...this.plugin.settings.localVersions];
                        }
                        if (autoSyncTurnedOn) {
                            await this.triggerSyncIfWebviewerActive();
                        }
                        await this.plugin.saveSettings();
                    }, 50);
                }

            }
        };

        input.addEventListener("keydown", this._keydownHandler);
        input.focus();
    }

    onClose() {
        if (!this._changesCommitted && this.hasAnyDraftChanges()) {
            new Notice("Changes not committed");
        }

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

        // Note-dots state (vault scan derived from the per-file text cache)
        this._noteDotsCache = null;
        this._noteDotsTextCache = {};
        this._noteDotsRefreshTimer = null;
        this._localStepRunningCache = { value: null, time: 0 };
        this._lastSearchQueryRef = null;
        this.setupBarHover();

        // Load settings and add settings tab
        await this.loadSettings();
        this.addSettingTab(new StepBibleLinkerSettingTab(this.app, this));
        
        // REGISTER SEARCH VIEW
        this.registerView(
            STEP_SEARCH_VIEW,
            (leaf) => new StepSearchView(leaf, this)
        );  

        // DETECT AND LINK INPUT REF AT CURSOR 
        //============================================================================
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
        //============================================================================
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

                await this.searchWebviewUrl(url, webviewEl, { ignoreAutoSync: true, ignoreDuplicate: true });
            }
        });

        // SEARCH PANEL 
        //============================================================================
        this.attachWebviewListeners = (webviewEl) => {
            if (!webviewEl || webviewEl.__stepListenersAttached) return;
            webviewEl.__stepListenersAttached = true;

            // Bar hover reports from the guest page, forwarded as console
            // messages (the guest has no node integration for ipcRenderer).
            webviewEl.addEventListener("console-message", (ev) => {
                const msg = (ev && ev.message) || "";
                if (msg.startsWith("__STEPBARCLICK__")) {
                    let click = null;
                    try { click = JSON.parse(msg.slice("__STEPBARCLICK__".length)); } catch (e) { click = null; }
                    this.handleBarClickMessage(webviewEl, click);
                    return;
                }
                if (!msg.startsWith("__STEPBAR__")) return;
                let hit = null;
                try { hit = JSON.parse(msg.slice("__STEPBAR__".length)); } catch (e) { hit = null; }
                this.handleBarHoverMessage(webviewEl, hit);
            });

            //Listener function that gets attached to webview  
            const onNav = async () => {
                const currentUrl = webviewEl.getURL?.();
                if (!currentUrl) return;

                if (this.settings.autoSyncOnNavigation) {
                    await this.searchWebviewUrl(currentUrl, webviewEl, { ignoreAutoSync: false, ignoreDuplicate: true });
                }
                await this.autoCollapseStepToolbar(webviewEl);
                await this.injectNoteDots(webviewEl);
            };

            //Attach listener
            webviewEl.addEventListener("did-finish-load", onNav);
            webviewEl.addEventListener("did-navigate-in-page", onNav);
        };
        
        // On new tab
        this.app.workspace.onLayoutReady(async () => {
            const webLeaves = this.app.workspace.getLeavesOfType("webviewer");
            for (const leaf of webLeaves) {
                
                const webviewEl = leaf.view?.webview;
                if (webviewEl) {
                    this.attachWebviewListeners(webviewEl);
                    // Fresh webviews aren't ready for executeJavaScript yet;
                    if (!webviewEl.getURL?.()) return;
                    if (this.settings.autoSyncOnNavigation) {
                        const url = leaf.view.url || webviewEl.getURL?.();
                        if (url) await this.searchWebviewUrl(url, webviewEl, { ignoreAutoSync: false, ignoreDuplicate: true });
                    }
                    await this.autoCollapseStepToolbar(webviewEl);
                    await this.injectNoteDots(webviewEl);
                }
            }
        });
        // Saved/created/deleted/renamed notes: re-derive the bar map at once.
        // modify fires when the editor flushes to disk (about 2s after typing
        // stops); create/delete/rename never fire modify, so they are needed
        // too or a new note would draw no bar until a reload.
        this.registerEvent(this.app.vault.on("modify", (f) => {
            if (f && f.extension === "md") this.scheduleNoteDotsRefresh();
        }));
        this.registerEvent(this.app.vault.on("create", (f) => {
            if (f && f.extension === "md") this.scheduleNoteDotsRefresh();
        }));
        this.registerEvent(this.app.vault.on("delete", (f) => {
            if (f && f.extension === "md") {
                if (this._noteDotsTextCache) delete this._noteDotsTextCache[f.path];
                this.scheduleNoteDotsRefresh();
            }
        }));
        this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
            if (f && f.extension === "md") {
                if (this._noteDotsTextCache && oldPath) delete this._noteDotsTextCache[oldPath];
                this.scheduleNoteDotsRefresh();
            }
        }));
        // On tab switch
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", async (leaf) => {
                const view = leaf?.view;
                if (!view || view.getViewType?.() !== "webviewer") return;

                const webviewEl = leaf.view?.webview;
                if (webviewEl) {
                    this.attachWebviewListeners(webviewEl);
                    // Fresh webviews aren't ready for executeJavaScript yet;
                    if (!webviewEl.getURL?.()) return;
                    if (this.settings.autoSyncOnNavigation) {
                        const url = leaf.view.url || webviewEl.getURL?.();
                        if (url) await this.searchWebviewUrl(url, webviewEl, { ignoreAutoSync: false, ignoreDuplicate: true });
                    }
                    await this.autoCollapseStepToolbar(webviewEl);
                    await this.injectNoteDots(webviewEl);
                }
            })
        );
        // Close panel
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
        //============================================================================
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

            // Only clear/reprocess when the hovered reference actually changes;
            // mouseover fires repeatedly on child elements within the same link.
            const refKey = this.urlRef_url(url);
            if (this._hoverRefKey === refKey) return;
            this._hoverRefKey = refKey;

            // Any new reference clears leftover highlights
            this.clearAllStepHighlights();

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

            pop.innerHTML = "<i>Loading STEP Bible\u2026</i>";
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
                    // Pop is gone: allow the same link to re-trigger a popup
                    this._hoverRefKey = null;
                }, 200);
            };

            requestAnimationFrame(() => {
                targetEl.addEventListener("mouseleave", scheduleHide, { once: true });
                pop.addEventListener("mouseenter", cancelHide);
                pop.addEventListener("mouseleave", () => {
                    scheduleHide();
                    // Highlights only clear when the pointer leaves the popout
                    this._hoverRefKey = null;
                    this.clearAllStepHighlights();
                });
                // Leaving the link without entering the popout also clears highlights
                targetEl.addEventListener("mouseleave", () => {
                    setTimeout(() => {
                        if (!pop.isConnected) {
                            this._hoverRefKey = null;
                            this.clearAllStepHighlights();
                        }
                    }, 400);
                }, { once: true });
            });

            try {
                if (!(await this.isLocalStepRunning())) {
                    url = this.localUrl_onlineUrl(url);
                }

                const urlRef = this.url_urlRef(url);
                if (!urlRef) return;

                // ---------- WEBVIEW HIGHLIGHT CHECK ----------
                // Highlight verses in any STEP webviewer tab showing verses
                // in this reference's range.
                if (urlRef.includes(".")) {
                    const wvLeaves = this.app.workspace.getLeavesOfType("webviewer");
                    const wvEls = wvLeaves
                        .map(l => l?.view?.webview ?? l?.view?.el?.querySelector?.("webview"))
                        .filter(el => el && typeof el.executeJavaScript === "function");

                    // Expand the hovered reference into explicit verse refs
                    // (urlRef_verseListArray already handles ranges/chapters)
                    const hoverRefs = this.urlRef_verseListArray(urlRef) || [];
                    const hoverSet = new Set(hoverRefs);

                    for (const wvEl of wvEls) {
                        // Expand the page's current reference the same way
                        const pageUrl = wvEl.getURL?.() || "";
                        const pageUrlRef = this.url_urlRef(pageUrl);
                        const pageRefs = pageUrlRef ? (this.urlRef_verseListArray(pageUrlRef) || []) : [];

                        // Intersect
                        const matched = pageRefs.filter(r => hoverSet.has(r));
                        if (matched.length === 0) continue;

                        await wvEl.executeJavaScript(`
                            (function() {
                                document.querySelectorAll(".step-ref-hover").forEach(el =>
                                    el.classList.remove("step-ref-hover"));

                                const existing = document.getElementById("step-linker-ref-style");
                                if (existing) existing.remove();
                                {
                                    const style = document.createElement("style");
                                    style.id = "step-linker-ref-style";
                                    style.textContent = [
                                        ".verse.step-ref-hover {",
                                        "  background-color: rgba(190, 190, 163, 0.19) !important;",
                                        "  outline: 1px solid #cacda600 !important;",
                                        "  border-radius: 3px;",
                                        "}"
                                    ].join("\\n");
                                    document.head.appendChild(style);
                                }

                                // Canonical matched set from the plugin
                                const targetSet = new Set(${JSON.stringify(matched)});

                                // Same conversion the dots use
                                const bookMap = window.__stepDotBookMap || {};
                                const toCanon = (ref) => {
                                    const parts = ref.split(".");
                                    const full = bookMap[parts[0].toLowerCase()];
                                    if (!full) return null;
                                    return [full.replace(/\\s+/g, ""), parts[1], parts[2]].filter(x => x !== undefined).join(".");
                                };

                                document.querySelectorAll("a.verseLink").forEach(a => {
                                    const canon = toCanon(a.getAttribute("name") || "");
                                    if (canon && targetSet.has(canon)) {
                                        const verse = a.closest(".verse");
                                        if (verse) verse.classList.add("step-ref-hover");
                                    }
                                });
                            })();
                        `);
                    }
                }
                // ---------------------------------------------

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
        //============================================================================
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
        const bookGroup = `(?:${books.join("|")})`;

        // Chapter, Chapter.Verse, or Chapter.e
        const cv = `\\d+(?:[.:](?:\\d+|e))?`;

        // Right-hand side of range: cv, or standalone 'e'
        const range = `${cv}(?:\\s*-\\s*(?:${cv}|e))?`;

        const pattern = `\\b${bookGroup}\\b(?:\\s*${range})?`;

        return new RegExp(pattern, "gi");
    }


    // SEARCH HELPERS =======================================================================================
    async searchWebviewUrl(url, webviewEl, { ignoreAutoSync = false, ignoreDuplicate = false } = {}) {
        if (!url || !url.includes("reference=")) return;

        // 1. SETTING GATE: Block search if autosearch is OFF unless explicitly bypassed
        if (!ignoreAutoSync && !this.settings.autoSyncOnNavigation) {
            return;
        }

        const urlRef = this.url_urlRef(url);
        if (!urlRef) return;

        const queryRef = this.urlRef_queryRef(urlRef);
        const displayRef = this.urlRef_displayRef(urlRef);

        // Convert array/query to comparable string key
        const queryKey = Array.isArray(queryRef) ? queryRef.join("|") : String(queryRef);

        // 2. DUPLICATE GATE: Block identical queries unless ignoreDuplicate is true
        if (!ignoreDuplicate && this._lastSearchQueryKey === queryKey) {
            return;
        }

        this._lastSearchQueryKey = queryKey;
        this._lastSearchQueryRef = queryRef;

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

        searchView.updateQuery(queryRef, displayRef, ignoreDuplicate);
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

    // Clear .step-ref-hover highlights in every STEP webview
    clearAllStepHighlights() {
        const wvLeaves = this.app.workspace.getLeavesOfType("webviewer");
        for (const l of wvLeaves) {
            const wvEl = l?.view?.webview ?? l?.view?.el?.querySelector?.("webview");
            if (wvEl && typeof wvEl.executeJavaScript === "function") {
                wvEl.executeJavaScript(`
                    document.querySelectorAll(".step-ref-hover").forEach(el =>
                        el.classList.remove("step-ref-hover"));
                `).catch(() => { });
            }
        }
    }

    // LOCAL/ONLINE URL HELPERS ===============================================================================
    async isLocalStepRunning() {
        // Cache: repeated hovers shouldn't re-fetch localhost every time.
        const now = Date.now();
        if (this._localStepRunningCache.value !== null
            && now - this._localStepRunningCache.time < 10000) {
            return this._localStepRunningCache.value;
        }
        try {
            const res = await requestUrl({
                url: "http://localhost:8989/",
                method: "GET",
                throw: false
            });

            this._localStepRunningCache = { value: res.status >= 200 && res.status < 400, time: now };
            return this._localStepRunningCache.value;
        } catch {
            this._localStepRunningCache = { value: false, time: now };
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

    // CONVERTERS =============================================================================================
    inputRef_urlRef(inputRef) {

        const getBookMap = () => this.getBookMap();
        const getMaxVerse = (book, chap) => this.getMaxVerse(book, chap);
        const getMaxChapter = (book) => this.getMaxChapter(book);

        const normalizeBook = (rawBook) => {
            const lookup = rawBook.replace(/\s+/g, " ").toLowerCase();
            return getBookMap()[lookup] || null;
        };

        const bookKey = (book) => book.replace(/\s+/g, "");

        let text = inputRef.trim();

        // --- PREPROCESS 'e' (End of chapter or end of book) ---
        const bookMatch = text.match(/^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/);
        if (bookMatch) {
            const rawBook = bookMatch[0].trim();
            const resolvedBook = normalizeBook(rawBook);
            if (resolvedBook) {
                let rest = text.substring(bookMatch[0].length).trim();

                // Replace 4.e -> 4.<maxVerse>
                rest = rest.replace(/(\d+)[.:]e\b/gi, (_, chap) => {
                    const maxV = getMaxVerse(resolvedBook, parseInt(chap, 10));
                    return maxV ? `${chap}.${maxV}` : `${chap}.e`;
                });

                // Replace 3.16-e -> 3.16-<maxVerse>
                rest = rest.replace(/(\d+)[.:](\d+)\s*-\s*e\b/gi, (_, chap, verse) => {
                    const maxV = getMaxVerse(resolvedBook, parseInt(chap, 10));
                    return maxV ? `${chap}.${verse}-${maxV}` : `${chap}.${verse}-e`;
                });

                // Replace 3-e -> 3-<maxChapter>
                rest = rest.replace(/(\d+)\s*-\s*e\b/gi, (_, chap) => {
                    const maxC = getMaxChapter(resolvedBook);
                    return maxC ? `${chap}-${maxC}` : `${chap}-e`;
                });

                text = `${rawBook} ${rest}`.trim();
            }
        }

        const validateChapVerse = (book, chap, verse = null) => {
            const maxChap = getMaxChapter(book);
            if (!maxChap) {
                new Notice(`Unknown chapter limits for "${book}".`);
                return false;
            }
            if (isNaN(chap) || chap < 1) {
                new Notice(`Invalid chapter "${chap}". Chapters must be 1 or greater.`);
                return false;
            }
            if (chap > maxChap) {
                new Notice(`${book} only has ${maxChap} chapter${maxChap === 1 ? '' : 's'} (${chap} entered).`);
                return false;
            }
            if (verse !== null) {
                const maxV = getMaxVerse(book, chap);
                if (maxV === null) {
                    new Notice(`Unknown verse limits for ${book} ${chap}.`);
                    return false;
                }
                if (isNaN(verse) || verse < 1) {
                    new Notice(`Invalid verse "${verse}". Verses must be 1 or greater.`);
                    return false;
                }
                if (verse > maxV) {
                    new Notice(`${book} ${chap} only has ${maxV} verses (${verse} entered).`);
                    return false;
                }
            }
            return true;
        };

        const validateRange = (book1, c1, v1, book2, c2, v2) => {
            if (!validateChapVerse(book1, c1, v1)) return false;
            if (!validateChapVerse(book2, c2, v2)) return false;

            if (book1 === book2) {
                if (c2 < c1) {
                    new Notice(`Invalid range: End chapter (${c2}) is before start chapter (${c1}).`);
                    return false;
                }
                if (c1 === c2 && v1 !== null && v2 !== null && v2 < v1) {
                    new Notice(`Invalid range: End verse (${v2}) is before start verse (${v1}).`);
                    return false;
                }
            }
            return true;
        };

        // 1. STEP format check (e.g., Gen.1.1-Gen.1.5 or Gen.1.1-2)
        {
            const stepPattern =
                /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\.(\d+)(?:\.(\d+))?(?:-([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)?\.(\d+)(?:\.(\d+))?)?$/;

            const m = text.match(stepPattern);
            if (m) {
                const rawBook1 = m[1].trim();
                const book1 = normalizeBook(rawBook1);
                if (!book1) {
                    //new Notice(`Unrecognized book name: "${rawBook1}".`);
                    return null;
                }
                const chap1 = parseInt(m[2], 10);
                const verse1 = m[3] ? parseInt(m[3], 10) : null;
                const bk1 = bookKey(book1);

                if (!m[4] && !m[5]) {
                    if (!validateChapVerse(book1, chap1, verse1)) return null;
                    return verse1 ? `${bk1}.${chap1}.${verse1}` : `${bk1}.${chap1}`;
                }

                const rawBook2 = (m[4] || rawBook1).trim();
                const book2 = normalizeBook(rawBook2);
                if (!book2) {
                    //new Notice(`Unrecognized book name: "${rawBook2}".`);
                    return null;
                }
                const chap2 = parseInt(m[5], 10);
                const verse2 = m[6] ? parseInt(m[6], 10) : null;
                const bk2 = bookKey(book2);

                if (!verse1 && !verse2) {
                    if (!validateRange(book1, chap1, null, book2, chap2, null)) return null;
                    return `${bk1}.${chap1}-${bk2}.${chap2}`;
                }
                if (verse1 && verse2) {
                    if (!validateRange(book1, chap1, verse1, book2, chap2, verse2)) return null;
                    return `${bk1}.${chap1}.${verse1}-${bk2}.${chap2}.${verse2}`;
                }
                if (!verse1 && verse2) {
                    if (!validateRange(book1, chap1, 1, book2, chap2, verse2)) return null;
                    return `${bk1}.${chap1}.1-${bk2}.${chap2}.${verse2}`;
                }
                if (verse1 && !verse2) {
                    if (!validateRange(book1, chap1, verse1, book2, chap1, chap2)) return null;
                    return `${bk1}.${chap1}.${verse1}-${bk2}.${chap1}.${chap2}`;
                }
            }
        }

        // 2. Book only check
        const bookOnlyPattern = /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
        if (bookOnlyPattern.test(text) && !/\d+\s*:/.test(text)) {
            const book = normalizeBook(text);
            if (book) return book.replace(/\s+/g, "");
            //new Notice(`Unrecognized book name: "${text}".`);
            return null;
        }

        let clean = text
            .replace(/–/g, "-")
            .replace(/\s*-\s*/g, "-")
            .replace(/:/g, ".");

        const bookRegex = /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/;
        const match = clean.match(bookRegex);
        if (!match) {
            new Notice(`Could not parse Bible reference from "${text}".`);
            return null;
        }

        const rawBook = match[0].trim();
        const book = normalizeBook(rawBook);
        if (!book) {
            //new Notice(`Unrecognized book name: "${rawBook}".`);
            return null;
        }
        const bk = bookKey(book);

        let remainder = clean.replace(match[0], "").trim();
        if (!remainder) {
            return bk;
        }

        if (!remainder.includes("-")) {
            const parts = remainder.split(".").map(p => parseInt(p, 10));
            if (parts.length === 1) {
                if (!validateChapVerse(book, parts[0])) return null;
                return `${bk}.${parts[0]}`;
            }
            if (parts.length === 2) {
                if (!validateChapVerse(book, parts[0], parts[1])) return null;
                return `${bk}.${parts[0]}.${parts[1]}`;
            }
            new Notice(`Invalid passage format: "${text}".`);
            return null;
        }

        const [left, right] = remainder.split("-");
        const leftParts = left.split(".").map(p => parseInt(p, 10));
        const rightParts = right.split(".").map(p => parseInt(p, 10));

        // Gen 1 - 3 -> Gen.1-Gen.3
        if (leftParts.length === 1 && rightParts.length === 1) {
            const lChap = leftParts[0];
            const rChap = rightParts[0];
            if (!validateRange(book, lChap, null, book, rChap, null)) return null;
            return `${bk}.${lChap}-${bk}.${rChap}`;
        }

        // Gen 1:1 - 5 -> Gen.1.1-Gen.1.5
        if (leftParts.length === 2 && rightParts.length === 1) {
            const lChap = leftParts[0];
            const lVerse = leftParts[1];
            const rVerse = rightParts[0];
            if (!validateRange(book, lChap, lVerse, book, lChap, rVerse)) return null;
            return `${bk}.${lChap}.${lVerse}-${bk}.${lChap}.${rVerse}`;
        }

        // Gen 3 - 4.5 -> Gen.3.1-Gen.4.5
        if (leftParts.length === 1 && rightParts.length === 2) {
            const lChap = leftParts[0];
            const rChap = rightParts[0];
            const rVerse = rightParts[1];
            if (!validateRange(book, lChap, 1, book, rChap, rVerse)) return null;
            return `${bk}.${lChap}.1-${bk}.${rChap}.${rVerse}`;
        }

        // Gen 1.1 - 2.5 -> Gen.1.1-Gen.2.5
        if (leftParts.length === 2 && rightParts.length === 2) {
            const lChap = leftParts[0];
            const lVerse = leftParts[1];
            const rChap = rightParts[0];
            const rVerse = rightParts[1];
            if (!validateRange(book, lChap, lVerse, book, rChap, rVerse)) return null;
            return `${bk}.${lChap}.${lVerse}-${bk}.${rChap}.${rVerse}`;
        }

        new Notice(`Invalid reference range format: "${text}".`);
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
        const versionPart = (this.settings.localVersions || [])
            .map(v => `version=${v}`)
            .join("@");

        const urlBase = `${this.urlPrefix}?q=${versionPart}@reference=`;
        const urlSuffix = "&options=GNVUH&display=COLUMN&skipwelcome";

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

    // DOM EDITORS
    async autoCollapseStepToolbar(webviewEl) {
        if (!webviewEl || typeof webviewEl.executeJavaScript !== "function") return;

        try {
            await webviewEl.executeJavaScript(`
                (function() {
                    console.log("STEP Plugin: Attempting toolbar auto-collapse...");
                    const tryCollapse = () => {
                        const navbar = document.getElementById("stepnavbar");
                        const resizeBtn = document.querySelector(".resizePanel") || 
                                          document.querySelector(".glyphicon-resize-full")?.closest("a, button, div, span");

                        if (navbar && navbar.style.display !== "none" && resizeBtn) {
                            console.log("STEP Plugin: Found resizePanel button, clicking...");
                            resizeBtn.click();
                            return true;
                        } else if (navbar && navbar.style.display === "none") {
                            console.log("STEP Plugin: Toolbar already collapsed.");
                            return true;
                        }
                        return false;
                    };

                    if (!tryCollapse()) {
                        let attempts = 0;
                        const interval = setInterval(() => {
                            attempts++;
                            if (tryCollapse() || attempts > 30) {
                                clearInterval(interval);
                            }
                        }, 100);
                    }
                })();
            `);
        } catch (err) {
            console.error("STEP Plugin: executeJavaScript error:", err);
        }
    }
    // Per-file text cache. Reading a markdown file is the costly part of a
    // vault scan, so texts are kept keyed by mtime and only re-read when a
    // file's mtime actually moves. Derived map data is rebuilt from these
    // cached texts, which is cheap.
    async readNoteText(file) {
        if (!this._noteDotsTextCache) this._noteDotsTextCache = {};
        const hit = this._noteDotsTextCache[file.path];
        const mtime = file.stat && file.stat.mtime ? file.stat.mtime : 0;
        if (hit && hit.mtime === mtime) return hit.text;
        const text = await this.app.vault.cachedRead(file);
        this._noteDotsTextCache[file.path] = { mtime, text };
        return text;
    }

    // A saved note changes exactly one file, so the derived map is dropped and
    // rebuilt from cached texts on the next injection. Debounced because a
    // save can fire several events at once (e.g. sync + editor flush).
    scheduleNoteDotsRefresh() {
        if (this._noteDotsRefreshTimer) clearTimeout(this._noteDotsRefreshTimer);
        this._noteDotsRefreshTimer = setTimeout(() => {
            this._noteDotsRefreshTimer = null;
            this.refreshNoteDots();
        }, 150);
    }

    // Re-scan the vault and re-inject bars into every open STEP webview.
    // Used after settings changes (e.g. type colours) so they apply immediately.
    refreshNoteDots() {
        this._noteDotsCache = null;
        for (const leaf of this.app.workspace.getLeavesOfType("webviewer")) {
            const wv = leaf.view?.webview;
            const url = leaf.view?.url || wv?.getURL?.() || "";
            if (wv && (url.includes("stepbible.org") || url.includes("localhost:8989"))) {
                this.injectNoteDots(wv).catch(e => console.error("STEP Plugin: refresh error:", e));
            }
        }
    }

    async injectNoteDots(webviewEl) {
        if (!webviewEl || typeof webviewEl.executeJavaScript !== "function") return;

        let res = null;
        try {
            const bookMap = this.getBookMap();
            const toCanonical = (ref) => {
                const parts = ref.split(".");
                const lookup = parts[0].replace(/\s+/g, " ").trim().toLowerCase();
                const full = bookMap[lookup];
                if (!full) return null;
                return [full.replace(/\s+/g, ""), parts[1], parts[2]].filter(x => x !== undefined).join(".");
            };

            // STEP 2: derive the vault map from the per-file text cache. The
            // cache is dropped whenever a note is saved, so there is no TTL: a
            // rebuild only re-reads files whose mtime moved.
            const now = Date.now();
            if (!this._noteDotsCache) {
                const map = {}; // canonicalVerse -> Set of note basenames
                const bookRefs = {}; // bookName -> Set of note basenames (whole-book references)
                const files = this.app.vault.getMarkdownFiles();
                const typedPrefix = (this.settings.noteTypesFolder || "").trim().replace(/\/+$/, "");
                const linkRegex = /\[([^\]]+)\]\(([^)]*reference=([^)&]+)[^)]*)/g;
                // Plain markdown links as well as the "([...])"-wrapped form STEP
                // writes: notes outside the notes folder are hand-written, so they
                // may use either.
                // Popover content lives here for typed and ordinary notes alike: a
                // plain note's entry shows the WHOLE file, scrolled to the first
                // mention of the reference that drew the bar.
                const typedData = { colourOf: {}, contentOf: {}, outlineOf: {} };
                const plainColour = (this.settings && this.settings.noteLinesColour) || "#17758f";

                for (const file of files) {
                    // Files in the note-types folder are typed bars, not ordinary green bars.
                    if (typedPrefix && file.path.startsWith(typedPrefix + "/")) continue;
                    const text = await this.readNoteText(file);
                    if (!text.includes("reference=")) continue;

                    let refN = 0;
                    // A reference repeated in the same note draws a single bar;
                    // the popover's mention stepper covers the repeated instances.
                    const seenRefs = new Set();
                    for (const [, linkText, , refRaw] of text.matchAll(linkRegex)) {
                        // One id per reference in the file, so every reference draws
                        // its own bar instead of one bar stretching over all of them.
                        // Path, not basename: two notes can share a name in
                        // different folders and must not share bars.
                        const id = "N:" + file.path + ":" + (refN++);
                        const decoded = decodeURIComponent(refRaw.trim());
                        // Ranges are written either in full on both sides
                        // (Numbers.22-Numbers.24) or abbreviated (Numbers.22-24).
                        // The abbreviated right side inherits the book — and the
                        // chapter when the left side names a verse — so a note on
                        // Numbers 22-24 is not mistaken for a note on Numbers 22.
                        let halves = decoded.split("-").map(s => s.trim());
                        const left = halves[0] || "";
                        let right = halves[1] || "";
                        const leftParts = left.split(".");
                        if (right && !right.includes(".")) {
                            right = leftParts.length >= 3
                                ? [leftParts[0], leftParts[1], right].join(".")
                                : [leftParts[0], right].join(".");
                        }
                        const canonL = toCanonical(left);
                        const canonR = right ? toCanonical(right) : null;
                        if (!canonL) continue;

                        // Deduplicate on the resolved range, not the spelling,
                        // so "Genesis.1.1" and "Genesis.1.1-1.1" share one bar.
                        const refKey = canonL + (canonR ? "-" + canonR : "");
                        if (seenRefs.has(refKey)) continue;
                        seenRefs.add(refKey);

                        const [bookL, chapL, verseL] = canonL.split(".");

                        // The popover shows the whole file. No colourOf entry, so
                        // every bar in a non-note-type file is a plain solid bar.
                        typedData.contentOf[id] = {
                            label: file.basename,
                            // Title/label text without the wrapping brackets STEP
                            // puts around its links: "Genesis 3", not "(Genesis 3)".
                            refText: linkText.trim().replace(/^[\[(]+/, "").replace(/[\])]+$/, "").trim(),
                            refRaw: left + (right ? "-" + right : ""),
                            text: text,
                            path: file.path,
                            colour: plainColour,
                            wholeNote: true,
                            searchRef: left + (right ? "-" + right : ""),
                        };

                        const maxV = (c) => this.getMaxVerse(bookL, parseInt(c, 10)) || 0;
                        const fill = (c, firstV, lastV) => {
                            for (let v = firstV; v <= lastV; v++) {
                                const key = `${bookL}.${c}.${v}`;
                                (map[key] = map[key] || new Set()).add(id);
                            }
                        };

                        // Book-only reference (no chapter): one solid bar across
                        // the whole book, exactly like any other reference.
                        if (!chapL) {
                            const lastChap = this.getMaxChapter(bookL) || 0;
                            for (let c = 1; c <= lastChap; c++) fill(c, 1, maxV(c));
                            continue;
                        }

                        const bookR = canonR ? canonR.split(".")[0] : bookL;
                        const chapR = canonR ? canonR.split(".")[1] : chapL;
                        const verseR = canonR ? (canonR.split(".")[2] || null) : null;

                        if (bookL !== bookR) continue; // cross-book ranges unsupported for bars

                        for (let c = parseInt(chapL, 10); c <= parseInt(chapR, 10); c++) {
                            // No range (canonR null) means a single verse: end at verseL,
                            // NOT the last verse of the chapter.
                            const lastV = canonR
                                ? ((c === parseInt(chapR, 10) && verseR) ? parseInt(verseR, 10) : maxV(c))
                                : (verseL ? parseInt(verseL, 10) : maxV(c));
                            const firstV = (c === parseInt(chapL, 10)) ? (parseInt(verseL || "1", 10)) : 1;
                            fill(c, firstV, lastV);
                        }
                    }
                }
                const bookRefKeys = Object.keys(bookRefs);

                // TYPED NOTES: files in the user's note-types folder, one type
                // per file. Entries become bars coloured by type; crosslinks
                // (refs inside content) become bars in the crosslink colour
                // pointing at the section they live in.
                // (typedData is declared above: ordinary notes fill it too.)
                const entryIdOf = {}; // raw section ref -> its typed entry id
                const folderPath = (this.settings.noteTypesFolder || "").trim();
                if (folderPath) {
                    const prefix = folderPath.replace(/\/+$/, "") + "/";
                    const typeFiles = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
                    const palette = ["#c05761", "#8a6db1", "#3f7fae", "#b8860b", "#7a9a3f", "#a352cc", "#c87f3f"];
                    this.settings.typedColours = this.settings.typedColours || {};
                    let coloursDirty = false;
                    const addTypedRef = (refStr, key) => {
                        const [left, right] = refStr.split("-").map(s => s.trim());
                        const canonL = toCanonical(left);
                        const canonR = right ? toCanonical(right) : null;
                        if (!canonL) return;
                        const [bookL, chapL, verseL] = canonL.split(".");
                        if (!chapL) return; // typed whole-book refs: not supported yet
                        const bookR = canonR ? canonR.split(".")[0] : bookL;
                        const chapR = canonR ? canonR.split(".")[1] : chapL;
                        const verseR = canonR ? (canonR.split(".")[2] || null) : null;
                        if (bookL !== bookR) return;
                        const maxV = (c) => this.getMaxVerse(bookL, parseInt(c, 10)) || 0;
                        // chapter-only ref (reference=Genesis.1): whole chapter
                        const startV = verseL ? parseInt(verseL, 10) : 1;
                        for (let c = parseInt(chapL, 10); c <= parseInt(chapR, 10); c++) {
                            const lastV = canonR ? ((c === parseInt(chapR, 10) && verseR) ? parseInt(verseR, 10) : maxV(c)) : (verseL ? parseInt(verseL, 10) : maxV(c));
                            const firstV = (c === parseInt(chapL, 10)) ? startV : 1;
                            for (let v = firstV; v <= lastV; v++) {
                                const k2 = `${bookL}.${c}.${v}`;
                                (map[k2] = map[k2] || new Set()).add(key);
                            }
                        }
                    };
                    const refPart = (target) => {
                        const m = target.split("reference=")[1];
                        return m ? m.split("&")[0].trim() : null;
                    };
                    for (let fi = 0; fi < typeFiles.length; fi++) {
                        const f = typeFiles[fi];
                        const base = f.basename;
                        if (!this.settings.typedColours[base]) {
                            this.settings.typedColours[base] = palette[fi % palette.length];
                            coloursDirty = true;
                        }
                        const colour = this.settings.typedColours[base];
                        const text = await this.readNoteText(f);
                        const parsed = parseTypedFile(text, base);
                        // Canonical range string for a raw reference, e.g.
                        // "Genesis.1.1" or "Genesis.1.1-Genesis.1.3" (null if unknown).
                        const canonRange = (rawRef) => {
                            const rp = refPart(rawRef);
                            if (!rp) return null;
                            const [l, r] = rp.split("-").map(s => s.trim());
                            const cl = toCanonical(l);
                            if (!cl) return null;
                            const cr = r ? toCanonical(r) : null;
                            return cr ? cl + "-" + cr : cl;
                        };
                        parsed.entries.forEach((e, i) => {
                            const id = "T:" + base + ":" + i;
                            const rp = refPart(e.refRaw);
                            if (rp) addTypedRef(rp, id);
                            entryIdOf[e.refRaw] = id;
                            typedData.colourOf[id] = colour;
                            // A note's own bar never marks or scrolls the note's
                            // markdown: highlighting belongs to crosslinks only.
                            typedData.contentOf[id] = { label: base, refText: e.refText, refRaw: e.refRaw, text: e.content, colour: colour, noMentions: true, ownCanon: canonRange(e.refRaw) };
                        });
                        // A reference repeated inside the same note (the text
                        // between one section's --- markers) draws a single bar,
                        // keyed on the resolved range so "Genesis.1.1" and
                        // "Genesis.1.1-1.1" collapse to one.
                        const seenCross = new Map();
                        parsed.crosslinks.forEach((c, i) => {
                            const id = "X:" + base + ":" + i;
                            const rp = refPart(c.refRaw);
                            const parentId = entryIdOf[c.target.refRaw] || null;
                            const canon = canonRange(c.refRaw) || rp || "?" + i;
                            const dedupeKey = (parentId || "-") + "\u0000" + canon;
                            if (seenCross.has(dedupeKey)) return;
                            seenCross.set(dedupeKey, id);
                            // Every reference in a note's content gets a bar,
                            // including refs scoped to the note's own section
                            // (e.g. Genesis 1.2 inside a note on Genesis 1). They
                            // are treated exactly like any other crosslink.
                            if (rp) addTypedRef(rp, id);
                            // Every crosslink bar is a solid bar in the note type's
                            // colour, exactly like the section's own bar.
                            typedData.colourOf[id] = colour;
                            // The popover shows the WHOLE note file, not just the
                            // section: clicking the crosslink scrolls to the first
                            // place the linked verse is mentioned in the note.
                            let searchRef = rp || "";
                            try { searchRef = decodeURIComponent(searchRef); } catch (e) {}
                            // The popover shows only the section this reference
                            // was written in (the text under its parent entry),
                            // not the whole note file. The title stays the note's
                            // own reference either way.
                            const parentText = parentId && typedData.contentOf[parentId]
                                ? typedData.contentOf[parentId].text
                                : text;
                            // A crosslink pointing at the note's own reference would
                            // otherwise mark and scroll to the note's heading line
                            // first. That leading mention is dropped; only the
                            // crosslink's own spot in the body is marked.
                            const ownCanon = parentId && typedData.contentOf[parentId] ? typedData.contentOf[parentId].ownCanon : null;
                            const dropFirstMention = !!(ownCanon && canonRange(c.refRaw) === ownCanon);
                            typedData.contentOf[id] = { label: base, refText: c.target.refText, refRaw: c.target.refRaw, searchRef: searchRef, text: parentText, colour: colour, wholeFile: true, parentId: parentId, dropFirstMention: dropFirstMention };
                        });
                    }
                    if (coloursDirty) this.saveSettings();
                }
                // serialise the complete map (untyped + typed) for the page
                const serialised = {};
                for (const k of Object.keys(map)) serialised[k] = Array.from(map[k]);
                const serialisedBookRefs = {};
                for (const k of bookRefKeys) serialisedBookRefs[k] = Array.from(bookRefs[k]);
                this._noteDotsCache = { time: now, map: serialised, bookRefs: serialisedBookRefs, typedData };
            }

            // STEP 3: push the FULL vault map + bookMap once per webview.
            // The page intersects it with the CURRENT verses at injection time,
            // so observer reruns during internal navigation always use fresh refs
            // (fixes the stale-data race where arrow navigation injected old-page data).
            await webviewEl.executeJavaScript(
                `window.__stepDotFullMap = ${JSON.stringify(this._noteDotsCache.map)};` +
                `window.__stepDotBookMap = ${JSON.stringify(bookMap)};` +
                `window.__stepBookRefs = ${JSON.stringify(this._noteDotsCache.bookRefs || {})};` +
                `window.__stepTypedData = ${JSON.stringify(this._noteDotsCache.typedData || { colourOf: {}, contentOf: {}, outlineOf: {} })};`);

            // 4b. Define the in-page injector + MutationObserver:
            //  - observes document.body (survives STEP's container swaps)
            //  - disconnects around injection so our own bar-appends never feed back
            //  - debounced 300ms, idempotent injector (duplicate-guarded per note)
            res = await webviewEl.executeJavaScript(`
                (function() {
                    try {
                        // The injector: idempotent, safe to run any number of times
                        window.__stepInjectDots = function() {
                            const fullMap = window.__stepDotFullMap || {};
                            const bookMap = window.__stepDotBookMap || {};
                            const toCanon = (ref) => {
                                const parts = ref.split(".");
                                const full = bookMap[parts[0].toLowerCase()];
                                if (!full) return null;
                                return [full.replace(/\\s+/g, ""), parts[1], parts[2]].filter(x => x !== undefined).join(".");
                            };

                            if (!document.getElementById("step-linker-dot-style")) {
                                const style = document.createElement("style");
                                style.id = "step-linker-dot-style";
                                style.textContent = [
                                    "div.verse { position: relative; }",
                                    // NOTE: no padding rule here — the adaptive gutter is set
                                    // as an inline style on the passage container below, and a
                                    // stylesheet !important would override it.
                                    ".step-note-bar {",
                                    "  position: absolute; top: 0;",
                                    "  width: 4px; min-height: 10px;",
                                    "  background: ${(this.settings && this.settings.noteLinesColour) || "#17758f"}; opacity: 0.7;",
                                    "  border-radius: 2px;",
                                    "  cursor: pointer; z-index: 10;",
                                    "  transition: opacity 0.12s ease, width 0.12s ease;",
                                    "}",
                                    // Crosslinks (refs inside note content) are hollow:
                                    // stroke only, a little wider so the stroke reads.
                                    ".step-note-bar[data-cross='1'] { width: 5px; background: transparent; }",
                                    // A typed bar widens the moment the pointer is on
                                    // it. data-hold carries the same widened width so
                                    // the bar stays wide while its popover is open —
                                    // including after the pointer moves onto the
                                    // popover, or onto another bar.
                                    ".step-note-bar[data-typed='1']:hover { width: 6px; opacity: 1; }",
                                    ".step-note-bar[data-typed='1'][data-cross='1']:hover { width: 7px; opacity: 1; }",
                                    ".step-note-bar[data-hold='1'] { opacity: 1; width: 6px; }",
                                    ".step-note-bar[data-hold='1'][data-cross='1'] { width: 7px; }",
                                    // A crosslink widens its section bar on hover, the
                                    // same instant the crosslink itself widens. Kept on
                                    // its own attribute so the host's hold sync can't
                                    // clear it.
                                    ".step-note-bar[data-parent-lit='1'] { opacity: 1; width: 6px; }",
                                    ".step-note-bar[data-parent-lit='1'][data-cross='1'] { width: 7px; }",
                                    ".verse.step-ref-hover {",
                                    "  background-color: rgba(190, 190, 163, 0.19) !important;",
                                    "  outline: 1px solid #cacda600 !important;",
                                    "  border-radius: 3px;",
                                    "}",
                                    ".step-note-tip {",
                                    "  position: fixed; z-index: 1000000;",
                                    "  background: #1e1e1e; color: #d6d6d6;",
                                    "  border: 1px solid var(--border-color);",
                                    "  border-radius: 4px; padding: 4px 8px;",
                                    "  font-size: 12px; font-family: var(--font-interface);",
                                    "  pointer-events: none; white-space: nowrap;",
                                    "  box-shadow: 0 2px 8px rgba(0,0,0,0.3);",
                                    "}",
                                    ".step-note-tip.wide {",
                                    "  white-space: pre-line; max-width: 480px;",
                                    "  padding: 8px 12px; line-height: 1.5;",
                                    "  max-height: 50vh; overflow: hidden;",
                                    "}"
                                ].join("\\n");
                                document.head.appendChild(style);
                            }

                            // Collect the page's verses in DOM order
                            const verses = [];
                            window.__stepVerses = verses; // exposed for host-driven highlight
                            const seenVerses = new Set();
                            document.querySelectorAll("a.verseLink").forEach(anchor => {
                                const name = anchor.getAttribute("name");
                                if (!name) return;
                                const canon = toCanon(name);
                                if (!canon) return;
                                const verseEl = anchor.closest(".verse") || anchor.parentElement;
                                if (!verseEl || seenVerses.has(verseEl)) return;
                                seenVerses.add(verseEl);
                                verses.push({ verse: verseEl, canon });
                            });

                            // For each note, the min/max verse index present on this page
                            const noteIdx = {};
                            verses.forEach((v, i) => {
                                const notes = fullMap[v.canon];
                                if (!notes) return;
                                notes.forEach(nb => {
                                    const e = noteIdx[nb] || (noteIdx[nb] = { min: i, max: i });
                                    if (i < e.min) e.min = i;
                                    if (i > e.max) e.max = i;
                                });
                            });

                            // Bars are anchored to the passage container, not the
                            // verse spans: inline spans have unreliable bounding
                            // boxes, so measure from rects relative to the container.
                            const cont = verses.length
                                ? (verses[0].verse.closest(".passageContentHolder") ||
                                   verses[0].verse.closest("[class*='passage']") ||
                                   document.body)
                                : null;
                            let contRect = null;
                            if (cont) {
                                cont.style.position = "relative";
                                contRect = cont.getBoundingClientRect();
                            }

                            // Build note list in verse order, then assign slots by
                            // vertical overlap: each bar gets the first slot whose
                            // previous occupant doesn't overlap its range. This makes
                            // overlapping bars sit in separate columns and makes the
                            // gutter width adapt to how many overlap at once.
                            const noteList = Object.keys(noteIdx)
                                .map(nb => ({ nb, e: noteIdx[nb] }))
                                // Longer spans first so the longest bar lands in the
                                // leftmost slot and bars funnel large-to-small left to right.
                                .sort((a, b) => (b.e.max - b.e.min) - (a.e.max - a.e.min) || a.e.min - b.e.min);
                            const slotEnds = [];   // slot -> max verse index used
                            const slotOf = {};
                            noteList.forEach(item => {
                                let s = 0;
                                while (s < slotEnds.length && slotEnds[s] >= item.e.min) s++;
                                slotOf[item.nb] = s;
                                slotEnds[s] = item.e.max;
                            });

                            const dbg = [];
                            let maxSlot = 0;
                            let added = 0;

                            // Every bar is a plain solid bar: whole-book references
                            // are expanded to the book's verses when the map is built.
                            noteList.forEach(item => {
                                const slot = slotOf[item.nb];
                                // Track widest slot regardless of whether the bar is
                                // newly added — otherwise re-injection (bars already
                                // exist) collapses the gutter back to the base padding.
                                maxSlot = Math.max(maxSlot, slot);
                                    const firstV = verses[item.e.min].verse;
                                    const lastV = verses[item.e.max].verse;

                                    // Idempotency: one bar per note per page
                                    const existing = cont.querySelector('.step-note-bar[data-note="' + item.nb.replace(/"/g, "") + '"]');
                                    if (existing) return;

                                    // Typed bars take their colour from the note-type
                                    // settings (or the crosslink colour for X: ids).
                                    const tinfo = (window.__stepTypedData || {}).contentOf && window.__stepTypedData.contentOf[item.nb];
                                    const bar = document.createElement("div");
                                    bar.className = "step-note-bar";
                                    bar.dataset.note = item.nb;
                                    // Metadata for the plugin-side hover popover: the
                                    // verse range and whether this is a typed/crosslink bar.
                                    bar.dataset.ref = verses[item.e.min].canon + ".." + verses[item.e.max].canon;
                                    if (tinfo) bar.dataset.typed = "1";
                                    if (tinfo && window.__stepTypedData.colourOf[item.nb]) {
                                        const typeCol = window.__stepTypedData.colourOf[item.nb];
                                        bar.style.background = typeCol;
                                    }
                                    if (item.nb.indexOf("X:") === 0) {
                                        // Crosslink: hollow bar, stroke only.
                                        const stroke = (window.__stepTypedData.colourOf || {})[item.nb] || "currentColor";
                                        bar.dataset.cross = "1";
                                        bar.style.background = "transparent";
                                        bar.style.boxShadow = "inset 0 0 0 2px " + stroke;
                                    }
                                    // Fixed gutter position; widths live in the
                                    // stylesheet so :hover can still widen a bar.
                                    const baseLeft = 2;
                                    bar.style.left = (baseLeft + slot * 8) + "px";

                                    // Measure the range from viewport rects, converted
                                    // to container-content coordinates (accounting for
                                    // container scroll) so inline spans can't inflate it.
                                    const r1 = firstV.getBoundingClientRect();
                                    const r2 = lastV.getBoundingClientRect();
                                    // The verse span includes the raised verse number,
                                    // so its rect top sits above the text line. Align the
                                    // bar to the text's own line box instead.
                                    const lineH1 = parseFloat(getComputedStyle(firstV).lineHeight) || r1.height;
                                    // Stretch the bar to cover the full vertical extent of the
                                    // referenced text: top of the verse number down to the bottom
                                    // of the last verse's final line.
                                    const top1 = r1.top - contRect.top + cont.scrollTop;
                                    const bottom2 = r2.bottom - contRect.top + cont.scrollTop;
                                    bar.style.top = top1 + "px";
                                    bar.style.height = Math.max(10, bottom2 - top1) + "px";
                                    dbg.push("#" + added + " s" + slot + " t" + Math.round(top1) + " h" + Math.round(bottom2 - top1) + " " + verses[item.e.min].canon + ".." + verses[item.e.max].canon);

                                    bar.__range = { min: item.e.min, max: item.e.max };
                                    // Hover: highlight the whole referenced range in-page.
                                    // Typed bars show their content in an Obsidian-managed
                                    // popover (plugin side), so no in-page tip for them.
                                    bar.addEventListener("mouseenter", () => {
                                        window.__stepHighlight(item.nb);
                                        if (tinfo) {
                                            // Widen this crosslink's section bar too.
                                            const pid = tinfo.parentId;
                                            if (pid) {
                                                const pb = cont.querySelector('.step-note-bar[data-note="' + pid.replace(/"/g, "") + '"]');
                                                if (pb) { pb.setAttribute("data-parent-lit", "1"); bar.__parentLit = pb; }
                                            }
                                            return;
                                        }
                                        const fr2 = firstV.getBoundingClientRect();
                                        const tip = document.createElement("div");
                                        tip.className = "step-note-tip";
                                        if (tinfo) {
                                            tip.classList.add("wide");
                                            tip.textContent = tinfo.label + "\\n\\n" + tinfo.text;
                                        } else {
                                            tip.textContent = item.nb;
                                        }
                                        tip.style.left = (fr2.right + 10) + "px";
                                        tip.style.top = fr2.top + "px";
                                        document.body.appendChild(tip);
                                        // Clamp inside the viewport: verses near the right
                                        // or bottom edge would otherwise push the tip off screen.
                                        const tr = tip.getBoundingClientRect();
                                        const lx = Math.max(4, Math.min(fr2.right + 10, window.innerWidth - tr.width - 4));
                                        const ty = Math.max(4, Math.min(fr2.top, window.innerHeight - tr.height - 4));
                                        tip.style.left = lx + "px";
                                        tip.style.top = ty + "px";
                                        bar.__tip = tip;
                                    });
                                    bar.addEventListener("mouseleave", () => {
                                        // Don't wipe a highlight the popover is holding.
                                        if (!(window.__stepHl && window.__stepHl.hold)) window.__stepHighlight("");
                                        if (bar.__parentLit) { bar.__parentLit.removeAttribute("data-parent-lit"); bar.__parentLit = null; }
                                        if (bar.__tip) { bar.__tip.remove(); bar.__tip = null; }
                                    });

                                    cont.appendChild(bar);
                                    added++;
                            });

                            // Re-injection is a full sync, not an append: a bar
                            // whose note no longer maps onto this page (the
                            // reference was deleted from the note, or the note
                            // itself went away) has to disappear without a
                            // reload. Anything left over is stale.
                            if (cont) {
                                const keep = new Set(noteList.map(it => it.nb));
                                cont.querySelectorAll('.step-note-bar').forEach(b => {
                                    const id = b.getAttribute('data-note') || '';
                                    if (keep.has(id)) return;
                                    if (b.__tip) { b.__tip.remove(); b.__tip = null; }
                                    if (b.__parentLit) { b.__parentLit.removeAttribute('data-parent-lit'); b.__parentLit = null; }
                                    b.remove();
                                });
                            }
                            // Adaptive gutter: widen padding to fit the slot stack
                            if (cont && cont !== document.body) {
                                cont.style.paddingLeft = (16 + maxSlot * 8) + "px";
                            }
                            if (dbg.length) {
                                // debug info goes to the console log in the plugin; no title edit
                            }
                            return { added, dbg: dbg.join(" | "), cont: cont === document.body ? "BODY" : (cont && cont.className) || "?", verses: verses.length };
                        };

                        // Host-driven highlight: while the mouse is over a bar or
                        // its popover, the referenced verses stay lit. An optional
                        // second argument adds a canonical range ("Gen.1.1" or
                        // "Gen.1.1-Gen.1.3") — used by crosslinks to light up the
                        // note's own reference as well as the linked one.
                        window.__stepHighlight = function(id, sourceRange) {
                            const clear = () => {
                                if (window.__stepHl) {
                                    if (window.__stepHl.els) window.__stepHl.els.forEach(el => el.classList.remove("step-ref-hover"));
                                    if (window.__stepHl.bars) window.__stepHl.bars.forEach(el => el.classList.remove("step-bar-expand"));
                                }
                                window.__stepHl = null;
                            };
                            clear();
                            if (!id) return;
                            const verses = window.__stepVerses || [];
                            const els = [];
                            const lit = (v) => {
                                if (!v || !v.verse || els.indexOf(v.verse) !== -1) return;
                                v.verse.classList.add("step-ref-hover");
                                els.push(v.verse);
                            };
                            const bar = document.querySelector('.step-note-bar[data-note="' + CSS.escape(id) + '"]');
                            if (bar && bar.__range) {
                                for (let i = bar.__range.min; i <= bar.__range.max; i++) lit(verses[i]);
                            }
                            // A ref bar lights only what it points at — never the
                            // note text the ref was written in.
                            const range = sourceRange || "";
                            if (range && verses.length) {
                                const parts = (c) => {
                                    const a = String(c || "").split(".");
                                    return [a[0] || "", parseInt(a[1], 10) || 0, parseInt(a[2], 10) || 0];
                                };
                                const halves = range.split("-");
                                const lo = parts(halves[0]);
                                const hi = halves[1] ? parts(halves[1]) : lo;
                                const cmp = (x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] - y[1]) || (x[2] - y[2]));
                                verses.forEach(v => {
                                    const q = parts(v.canon);
                                    if (!q[0]) return;
                                    if (cmp(q, lo) >= 0 && cmp(q, hi) <= 0) lit(v);
                                });
                            }
                            window.__stepHl = { els: els, bars: [] };
                        };

                        // Host-driven bar widening. The host sends the ids of every
                        // note whose popover is currently open; a bar is wide exactly
                        // while its id is in that list, so the popout and the bar
                        // appear and disappear together.
                        window.__stepHoldBars = function(ids) {
                            const set = new Set(Array.isArray(ids) ? ids : []);
                            document.querySelectorAll(".step-note-bar[data-hold='1']").forEach(b => {
                                if (!set.has(b.dataset.note || "")) b.removeAttribute("data-hold");
                            });
                            set.forEach(id => {
                                const b = document.querySelector('.step-note-bar[data-note="' + CSS.escape(id) + '"]');
                                if (b) b.setAttribute("data-hold", "1");
                            });
                        };

                        // Hit-test for the plugin-side hover popover: which bar sits
                        // under this point? Coordinates are viewport-relative.
                        window.__stepBarAt = function(x, y) {
                            const hits = document.elementsFromPoint(x, y)
                                .filter(el => el.classList && el.classList.contains("step-note-bar"));
                            if (!hits.length) return null;
                            const b = hits[0];
                            return { id: b.dataset.note || "", ref: b.dataset.ref || "", typed: b.dataset.typed === "1" };
                        };

                        // Mouse events over the guest page never reach the host
                        // document, and the guest has no node integration (no
                        // ipcRenderer), so bar hovers are reported through the
                        // console-message channel, which webview forwards to the host.
                        if (!window.__stepBarHoverHook) {
                            window.__stepBarHoverHook = true;
                            let lastHover = null;
                            document.addEventListener("mousemove", (e) => {
                                const hit = window.__stepBarAt
                                    ? window.__stepBarAt(e.clientX, e.clientY) : null;
                                const key = hit ? hit.id : "";
                                if (key === lastHover) return; // only report changes
                                lastHover = key;
                                console.log("__STEPBAR__" + JSON.stringify(hit));
                            }, { passive: true });
                            // Cursor leaving the page entirely never fires a
                            // mousemove, so report the exit explicitly.
                            const reportLeave = () => {
                                if (!lastHover) return;
                                lastHover = null;
                                console.log("__STEPBAR__null");
                            };
                            document.addEventListener("mouseleave", reportLeave, { passive: true });
                            window.addEventListener("mouseout", (e) => {
                                if (!e.relatedTarget) reportLeave();
                            }, { passive: true });
                            // Clicking a bar pins the popover (host-side)
                            document.addEventListener("click", (e) => {
                                const hit = window.__stepBarAt
                                    ? window.__stepBarAt(e.clientX, e.clientY) : null;
                                console.log("__STEPBARCLICK__" + JSON.stringify(hit));
                            }, { passive: true });
                        }

                        // Observe document.body — the only element guaranteed to survive
                        // STEP's navigation. Feedback from our own bar-appends is
                        // suppressed by disconnect-around-inject below.
                        const getTargets = () => [document.body];

                        if (!window.__stepDotObserver) {
                            let pending = null;
                            const run = () => {
                                clearTimeout(pending);
                                pending = setTimeout(() => {
                                    try {
                                        if (!window.__stepInjectDots) return;
                                        if (window.__stepDotObserver) window.__stepDotObserver.disconnect();
                                        let n;
                                        try { n = window.__stepInjectDots(); }
                                        finally { if (window.__stepDotObserve) window.__stepDotObserve(); }
                                    } catch (e) {
                                        console.log("[step-dots] OBS ERR " + (e && e.message ? e.message.slice(0, 80) : e));
                                    }
                                }, 300);
                            };
                            // Re-measure bars when layout changes: bars are absolutely
                            // positioned, so their tops/heights go stale when text rewraps
                            // (window resize, fonts loading, scrollbar appearing).
                            if (!window.__stepBarResizeHooked) {
                                window.__stepBarResizeHooked = true;
                                const remeasure = () => {
                                    try {
                                        document.querySelectorAll(".step-note-bar").forEach(b => b.remove());
                                        if (window.__stepInjectDots) window.__stepInjectDots();
                                    } catch (e) {
                                        console.log("[step-dots] RESIZE ERR " + (e && e.message ? e.message.slice(0, 80) : e));
                                    }
                                };
                                let rt;
                                const debounced = () => { clearTimeout(rt); rt = setTimeout(remeasure, 200); };
                                window.addEventListener("resize", debounced);
                                // Watch the passage container itself: pane resizes, scrollbar
                                // changes and rewraps all change its size without a window event.
                                if (window.ResizeObserver) {
                                    const hookCont = () => {
                                        const c = document.querySelector(".passageContentHolder") || document.body;
                                        if (window.__stepBarRO && window.__stepBarRO._cont === c) return;
                                        if (window.__stepBarRO) window.__stepBarRO.disconnect();
                                        window.__stepBarRO = new ResizeObserver(debounced);
                                        window.__stepBarRO._cont = c;
                                        window.__stepBarRO.observe(c);
                                    };
                                    hookCont();
                                }
                                // Fonts finish loading after first paint and rewrap text;
                                // re-measure once they do, plus one late safety pass.
                                if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(remeasure, 100));
                                setTimeout(remeasure, 1200);
                            }
                            const obs = new MutationObserver(run);
                            window.__stepDotObserver = obs;
                            window.__stepDotObserve = () => {
                                try { obs.disconnect(); } catch (e) {}
                                getTargets().forEach(t => obs.observe(t, { childList: true, subtree: true }));
                            };
                            window.__stepDotObserve();
                        }

                        // Inject once now, observer suppressed during our own DOM writes
                        if (window.__stepDotObserver) window.__stepDotObserver.disconnect();
                        let res = null;
                        try { res = window.__stepInjectDots(); } finally {
                            if (window.__stepDotObserve) window.__stepDotObserve();
                        }

                        window.__stepLastInjectError = null;
                        return res;

                    } catch (e) {
                        window.__stepLastInjectError = e && e.message ? e.message : String(e);
                        return null;
                    }
                })();
            `);

        } catch (err) {
            console.error("STEP Plugin: injectNoteDots error:", err);
        }
        if (res) {
            if (res.dbg) console.log("STEP Plugin: bars =>", "cont=" + res.cont, "verses=" + res.verses, res.dbg);
            else console.log("STEP Plugin: inject =>", "added=" + res.added, "verses=" + res.verses, "cont=" + res.cont);
        }    }



    async rewriteStepLinks() {
        // No cache invalidation here: every write below goes through
        // vault.modify, which raises the modify event that rebuilds the map.
        const files = this.app.vault.getMarkdownFiles();

        const activeList = this.settings.localVersions || [];
        const versionPart = activeList.length
            ? activeList.map(v => `version=${v}`).join("@")
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

        new Notice("Updated Versions in Links");
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

        new Notice("Links Updated to " + (targetPrefix === localPrefix ? "Local" : "Online") + " Server");
    }
    async loadSettings() {
        const loadedData = await this.loadData() || {};
        if (loadedData.enabledVersions && !loadedData.globalVersions) {
            loadedData.globalVersions = [...loadedData.enabledVersions];
            loadedData.localVersions = [...loadedData.enabledVersions];
            delete loadedData.enabledVersions;
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
        this.urlPrefix = this.settings.useLocalStepServer
            ? "http://localhost:8989/"
            : "https://www.stepbible.org/";
    }

    // BAR HOVER POPOVER: the guest page reports bar hovers over Electron's
    // sendToHost channel (mouse events over a webview guest never reach the
    // host document). Typed/crosslink bars open an Obsidian-managed popover
    // (real markdown: text, images, links) anchored at the webview's top right.
    setupBarHover() {
        if (this._barHoverReady) return;
        this._barHoverReady = true;
        this._barHoverTimer = null;
        // Two slots so a pinned note and a hover note can coexist: the hover
        // box stacks above the pinned one.
        this._pinnedPop = null;
        this._hoverPop = null;
        this._barPinned = false;

        // Popover styling (header + body), theme-aware via Obsidian variables.
        {
            // Reuse the node if a previous load left one behind, but always
            // rewrite its text: a stale stylesheet from an older build is how
            // the box ended up with no background at all.
            let st = document.getElementById("step-bar-popover-style");
            if (!st) {
                st = document.createElement("style");
                st.id = "step-bar-popover-style";
                document.head.appendChild(st);
            }
            st.textContent = [
                // The box used to be Obsidian's HoverPopover, which supplied the
                // theme surface. Now it's our own div, so we draw it ourselves.
                ".step-bar-popover { width: max-content; max-width: 560px; min-width: 240px; max-height: 30vh; overflow: hidden; font-size: 13px;" +
                "  background: var(--background-primary); color: var(--text-normal);" +
                "  border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m, 8px);" +
                "  box-shadow: 0 4px 18px rgba(0,0,0,0.28); }",
                ".step-bar-popover .step-bar-popover-header {",
                "  position: relative; display: flex; flex-direction: column; gap: 1px;",
                "  padding: 8px 44px 6px 12px; margin-bottom: 0; flex: 0 0 auto; border-bottom: 1px solid var(--background-modifier-border); }",
                ".step-bar-popover .step-bar-popover-title {",
                "  font-weight: 700; font-size: 15px; font-family: var(--font-interface); color: var(--text-normal); }",
                ".step-bar-popover .step-bar-popover-ref {",
                "  font-size: 12px; font-family: var(--font-interface); color: var(--text-muted); }",
                ".step-bar-popover .step-bar-popover-buttons {",
                "  position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; }",
                ".step-bar-popover .step-bar-popover-buttons-hidden { display: none; }",
                ".step-bar-popover .step-bar-popover-btn {",
                "  background: transparent; border: none; box-shadow: none; padding: 0; cursor: pointer;",
                "  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }",
                ".step-bar-popover .step-bar-popover-btn:hover { background: rgba(255,255,255,0.25); }",
                ".step-bar-popover .step-bar-popover-btn svg { width: 16px; height: 16px; }",
                ".step-bar-popover .step-bar-popover-body { padding: 8px 14px 10px 14px; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }",
            ].join("\n");
        }

        const dispose = (entry) => {
            if (!entry) return;
            const pop = entry.pop;
            clearTimeout(this._hoverCloseTimer);
            this._barDragging = false;
            if (!entry.pinned) this._pointerInPopover = false;
            // Drop the slot first, then sync: the bar narrows on the same tick
            // the popover is torn down.
            if (entry.pinned) {
                if (this._pinnedPop === entry) this._pinnedPop = null;
                this._barPinned = false;
            } else if (this._hoverPop === entry) this._hoverPop = null;
            try { (entry.hide || pop.hide.bind(pop))(); } catch (e) { try { pop.hide(); } catch (e2) {} }
            // Narrow the bars in the same tick the popover goes away.
            this._syncBarHold();
            if (entry.anchorEl && entry.anchorEl.parentNode) entry.anchorEl.remove();
            if (!entry.pinned) {
                // No fade-out: a hover note goes the instant the bar is left.
                try { if (entry.body) { entry.body.style.display = "none"; entry.body.remove(); } } catch (e) {}
            }
            if (entry.pinned) {
                // Closing the pinned note releases the lit passage.
                try {
                    if (this._barWebview && this._barWebview.executeJavaScript)
                        this._barWebview.executeJavaScript(`window.__stepHighlight && window.__stepHighlight("")`).catch(() => {});
                } catch (e) {}
            }
        };
        // Keep the guest's widened bars in step with the open popovers.
        this._syncBarHold = () => {
            const ids = [];
            const add = (id) => {
                if (!id) return;
                if (ids.indexOf(id) < 0) ids.push(id);
                // A crosslink's section bar stays widened with it.
                const td = this._noteDotsCache && this._noteDotsCache.typedData;
                const p = td && td.contentOf && td.contentOf[id] && td.contentOf[id].parentId;
                if (p && ids.indexOf(p) < 0) ids.push(p);
            };
            if (this._pinnedPop) add(this._pinnedPop.id);
            if (this._hoverPop) add(this._hoverPop.id);
            const wv = this._barWebview;
            if (!wv || !wv.executeJavaScript) return;
            try {
                wv.executeJavaScript(`window.__stepHoldBars && window.__stepHoldBars(${JSON.stringify(ids)})`).catch(() => {});
            } catch (e) {}
        };
        const closeHover = () => dispose(this._hoverPop);
        const closePinned = () => dispose(this._pinnedPop);
        const closePopover = () => { closeHover(); closePinned(); };
        this._closeBarPopover = closePopover;
        this._closeHoverPopover = closeHover;
        this._closePinnedPopover = closePinned;
        this._barOpenTimer = null;

        // Moving between a bar and its popover crosses a gap, and the popover
        // sits outside the webview (so the guest reports "no bar"). Close a
        // hover note only after a short grace period, and never while the
        // pointer is actually over the popover.
        this._lastBarHit = null;
        this._barDragging = false;
        this._pointerInPopover = false;
        this._lastPointer = null;
        this.registerDomEvent(document, "mousemove", (e) => {
            this._lastPointer = { x: e.clientX, y: e.clientY };
        }, { passive: true, capture: true });
        // True when the tracked pointer sits inside the open hover popover.
        // Geometry is used instead of enter/leave flags: a flag can stay stuck
        // when the element is removed or re-rendered under the cursor, which
        // made notes linger for seconds.
        const pointerOverHoverPop = () => {
            if (!this._hoverPop) return false;
            const c = document.querySelector(".step-bar-popover:not(.step-bar-popover-pinned)");
            if (!c) return false;
            const p = this._lastPointer;
            if (!p) return this._pointerInPopover;
            const r = c.getBoundingClientRect();
            return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        };
        this._scheduleHoverClose = () => {
            clearTimeout(this._hoverCloseTimer);
            this._hoverCloseTimer = setTimeout(() => {
                if (pointerOverHoverPop()) return;
                if (this._lastBarHit) return;
                closeHover();
                if (!this._barPinned && this._barWebview) {
                    try { this._barWebview.executeJavaScript(`window.__stepHighlight && window.__stepHighlight("")`).catch(() => {}); } catch (e) {}
                }
            }, 90);
        };

        // Called from the webview's ipc-message listener. A null hit means the
        // pointer is over no bar: close any open popover. A typed hit opens a
        // popover after a short hover delay (later messages cancel the timer).
        this.handleBarHoverMessage = (webviewEl, hit) => {
            this._barWebview = webviewEl;
            // Mid-drag the guest still reports whatever bar the box happens to
            // sit over; rebuilding or closing popovers then would move the box
            // out from under the pointer and kill the drag.
            if (this._barDragging) return;
            // Push highlight state into the guest: the verses stay lit while
            // the mouse is on the bar OR on the popover (guest can't see the
            // popover, the host bridges it).
            const pushHighlight = (id) => {
                webviewEl.executeJavaScript(`window.__stepHighlight && window.__stepHighlight(${JSON.stringify(id || "")})`).catch(() => {});
            };
            if (!hit || !hit.typed) {
                // Cancel any pending open: a timer that fires after the pointer
                // has left would pop a note up with no bar hovered under it.
                clearTimeout(this._barOpenTimer);
                this._lastBarHit = null;
                // While pinned, moving off the bar must not close the pinned
                // note — but a transient hover note still goes away.
                this._scheduleHoverClose();
                return;
            }
            this._lastBarHit = hit;
            clearTimeout(this._hoverCloseTimer);
            pushHighlight(hit.id);
            // Already showing this bar (pinned or hovering): nothing to do.
            if (this._pinnedPop && this._pinnedPop.id === hit.id) { closeHover(); return; }
            if (this._hoverPop && this._hoverPop.id === hit.id) return;
            clearTimeout(this._barOpenTimer);
            this._barOpenTimer = setTimeout(() => this.openBarPopover(webviewEl, hit, false), 150);
        };

        // Click on a bar: pin the popover (stays put, movable, resizable)
        this.handleBarClickMessage = (webviewEl, hit) => {
            clearTimeout(this._barOpenTimer);
            if (!hit || !hit.typed) return;
            if (this._pinnedPop && this._pinnedPop.id === hit.id) {
                // second click on the same bar unpins and closes
                closePinned();
                closeHover();
                return;
            }
            // Clicking a different bar replaces the pinned note.
            this.openBarPopover(webviewEl, hit, true);
        };

        // Create the popover for one bar hit. Pinned popovers get a header
        // toolbar (open-in-Obsidian button), are draggable by the header and
        // resizable from the corner.
        this.openBarPopover = async (webviewEl, hit, pinned) => {
            const box = webviewEl.getBoundingClientRect();
            if (!box.width) { if (!pinned) closePopover(); this._syncBarHold(); return; }

            // Content from the cached typed scan (same ids the page uses)
            const td = this._noteDotsCache && this._noteDotsCache.typedData;
            const info = td && td.contentOf && td.contentOf[hit.id];
            if (!info) { this._syncBarHold(); return; }
            const base = hit.id.split(":")[1];
            const folder = (this.settings.noteTypesFolder || "").trim().replace(/\/+$/, "");
            // Typed entries live in the notes folder; ordinary notes record
            // their real path (they can sit anywhere in the vault).
            const sourcePath = info.path || (folder ? `${folder}/${base}.md` : `${base}.md`);

            // Pinning replaces the pinned note and any transient hover note;
            // hovering keeps the pinned note where it is.
            closeHover();
            if (pinned) closePinned();

            // Anchor at the webview's top right corner
            const anchorEl = document.createElement("div");
            anchorEl.style.cssText = "position:fixed;width:0;height:0;pointer-events:none;";
            anchorEl.style.left = (box.right - 8) + "px";
            anchorEl.style.top = (box.top + 8) + "px";
            document.body.appendChild(anchorEl);

            let pop = null;
            // Own element, not Obsidian's HoverPopover. HoverPopover keeps a
            // single shared hover element for the whole app and hides itself on
            // mouseleave; that closed pinned notes when the pointer moved off
            // them and made two independent notes impossible. A plain div we
            // own is torn down only when we say so.
            const body = document.createElement("div");
            pop = {
                hoverEl: body,
                hide() { try { body.remove(); } catch (e) {} },
                position() {},
                show() {}
            };
            document.body.appendChild(body);
            body.addClass("step-bar-popover");
            // A transient hover note must stack above the pinned one.
            body.style.zIndex = pinned ? "1000000" : "1000002";
            // Anchor at the top right of the webview: right-aligned by pulling
            // the box back over its own width.
            body.style.position = "fixed";
            body.style.left = (box.right - 8) + "px";
            body.style.top = (box.top + 8) + "px";
            body.style.right = "auto";
            body.style.bottom = "auto";
            body.style.transform = "translateX(-100%)";
            // Register immediately: any later failure must still leave the
            // popover closeable (otherwise the X does nothing).
            const entry = { pop, id: hit.id, anchorEl, pinned: !!pinned, hide: null, body };
            if (pinned) { this._pinnedPop = entry; this._barPinned = true; }
            else this._hoverPop = entry;
            this._barWebview = webviewEl;
            this._syncBarHold();
            body.style.maxHeight = "30vh";
            // Width hugs the content; height is a fixed length, scrolled
            // inside. Pinned and unpinned are the same size.
            body.style.width = "max-content";
            // HoverPopover's hoverEl is a flex row by default; force a column
            // so the title sits above the text.
            body.style.display = "flex";
            body.style.flexDirection = "column";
            body.style.alignItems = "stretch";
            // Track whether the pointer is inside the popover: leaving a bar for
            // its own note must not close it.
            if (!pinned) {
                this._pointerInPopover = false;
                body.addEventListener("mouseenter", () => {
                    this._pointerInPopover = true;
                    clearTimeout(this._hoverCloseTimer);
                });
                body.addEventListener("mouseleave", () => {
                    this._pointerInPopover = false;
                    this._scheduleHoverClose();
                });
            }

            // Moving the pointer onto the popover no longer lights anything in
            // STEP: the passage highlight belongs to the bar hover alone.

            // Title block, coloured like the note bar: note name (bold,
            // larger) with the verse reference underneath. Buttons overlay
            // the block's top right corner.
            const header = body.createDiv({ cls: "step-bar-popover-header" });
            // Title-block colour = bar colour; pick white or dark grey text
            // by the block's relative luminance.
            const hex = (info.colour || "#17758f").replace("#", "");
            const rgb = hex.length === 3 ? hex.split("").map(c => parseInt(c + c, 16)) : [0, 1, 2].map(i => parseInt(hex.substr(i * 2, 2), 16));
            const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
            const darkText = lum > 0.6;
            if (info.colour) header.style.backgroundColor = info.colour;
            else header.style.backgroundColor = "var(--background-secondary)";
            // Pin the title block: it stays in view while the note scrolls under it.
            header.style.position = "sticky";
            header.style.top = "0";
            header.style.zIndex = "5";
            header.style.flex = "0 0 auto";
            header.style.padding = "8px 44px 6px 12px";
            const titleEl = header.createDiv({ cls: "step-bar-popover-title" });
            // The title is always the note's own reference — the same title for
            // every bar that file or section draws.
            const titleText = info.refText || "";
            titleEl.setText(titleText);
            titleEl.style.fontWeight = "700";
            titleEl.style.fontSize = "15px";
            titleEl.style.color = darkText ? "#3a3a3a" : "#ffffff";
            const refEl = header.createDiv({ cls: "step-bar-popover-ref" });
            refEl.setText(info.label || "");
            refEl.style.fontSize = "12px";
            refEl.style.color = darkText ? "rgba(58,58,58,0.75)" : "rgba(255,255,255,0.8)";
            const btns = header.createDiv({ cls: "step-bar-popover-buttons" });
            btns.style.position = "absolute";
            btns.style.top = "6px";
            btns.style.right = "6px";
            btns.style.display = "flex";
            btns.style.flexDirection = "row";
            btns.style.gap = "4px";
            // Lucide svgs size via width:1em; a tiny inherited font-size collapses
            // them to a dot. Pin explicit pixel size + colour on the svg.
            const hardenIcon = (btn) => {
                const svg = btn.querySelector("svg");
                if (!svg) return;
                const col = darkText ? "#3a3a3a" : "#ffffff";
                for (const k of ["width", "height"]) {
                    svg.setAttribute(k, "16");
                    svg.style[k] = "16px";
                }
                svg.style.stroke = col;
                svg.style.display = "block";
            };
            if (pinned) {
                const openBtn = btns.createEl("button", { cls: "step-bar-popover-btn" });
                openBtn.style.background = "transparent";
                openBtn.style.border = "none";
                openBtn.style.borderRadius = "50%";
                openBtn.style.width = "26px";
                openBtn.style.height = "26px";
                openBtn.style.padding = "0";
                openBtn.style.fontSize = "16px"; // em-sized icons must not inherit a tiny font
                openBtn.style.display = "flex";
                openBtn.style.alignItems = "center";
                openBtn.style.justifyContent = "center";
                openBtn.style.cursor = "pointer";
                openBtn.addEventListener("mouseenter", () => { openBtn.style.background = "rgba(128,128,128,0.35)"; });
                openBtn.addEventListener("mouseleave", () => { openBtn.style.background = "transparent"; });
                setIcon(openBtn, "lucide-arrow-up-right");
                hardenIcon(openBtn);
                openBtn.setAttribute("aria-label", "Open in Obsidian at this reference");
                openBtn.addEventListener("click", async (ev) => {
                    ev.stopPropagation();
                    try {
                        const leaf2 = await this.app.workspace.openLinkText(sourcePath, "", true);
                        const view = leaf2 && leaf2.view;
                        if (view && view.getMode && view.getMode() === "source" && view.editor) {
                            const ed = view.editor;
                            const value = ed.getValue();
                            const lines = value.split("\n");
                            const wantRaw = String(info.refRaw || "").trim();
                            const wantText = String(info.refText || "").replace(/[\[\]]/g, "").trim();
                            let lineNo = -1;
                            if (wantRaw) {
                                for (let i = 0; i < lines.length; i++) {
                                    if (!lines[i].includes("reference=")) continue;
                                    const m = lines[i].match(/reference=([^)&\s]+)/);
                                    if (!m) continue;
                                    let got = m[1];
                                    try { got = decodeURIComponent(got); } catch (e) {}
                                    if (got.trim() === wantRaw) { lineNo = i; break; }
                                }
                            }
                            // Fallback: the line that names the reference, so a
                            // hand-written or odd-encoded link still lands right.
                            if (lineNo < 0 && wantText) {
                                for (let i = 0; i < lines.length; i++) {
                                    if (lines[i].includes("reference=") && lines[i].includes(wantText)) { lineNo = i; break; }
                                }
                            }
                            if (lineNo >= 0) {
                                const pos = { line: lineNo, ch: 0 };
                                // Select the whole line: scrolling lands there and
                                // the line is visibly highlighted.
                                ed.setSelection(pos, { line: lineNo, ch: lines[lineNo].length });
                                ed.scrollIntoView({ from: pos, to: pos }, true);
                            }
                        }
                    } catch (e) {}
                    closePinned();
                });
                const closeBtn = btns.createEl("button", { cls: "step-bar-popover-btn" });
                closeBtn.style.background = "transparent";
                closeBtn.style.border = "none";
                closeBtn.style.borderRadius = "50%";
                closeBtn.style.width = "26px";
                closeBtn.style.height = "26px";
                closeBtn.style.padding = "0";
                closeBtn.style.fontSize = "16px"; // em-sized icons must not inherit a tiny font
                closeBtn.style.display = "flex";
                closeBtn.style.alignItems = "center";
                closeBtn.style.justifyContent = "center";
                closeBtn.style.cursor = "pointer";
                closeBtn.addEventListener("mouseenter", () => { closeBtn.style.background = "rgba(128,128,128,0.35)"; });
                closeBtn.addEventListener("mouseleave", () => { closeBtn.style.background = "transparent"; });
                setIcon(closeBtn, "lucide-x");
                if (!closeBtn.querySelector("svg")) {
                    // Last resort: guaranteed-visible unicode cross
                    closeBtn.setText("\u2715");
                    closeBtn.style.color = darkText ? "#3a3a3a" : "#ffffff";
                    closeBtn.style.fontSize = "14px";
                    closeBtn.style.lineHeight = "26px";
                }
                hardenIcon(closeBtn);
                closeBtn.setAttribute("aria-label", "Close");
                closeBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    closePinned();
                });
            } else {
                btns.addClass("step-bar-popover-buttons-hidden");
            }

            const mdEl = body.createDiv({ cls: "step-bar-popover-body" });
            mdEl.style.padding = "8px 14px 10px 14px";
            // The markdown body is its own scroll container: the title block
            // above it stays put and the note scrolls underneath. Without
            // min-height:0 a flex child refuses to shrink, so the box grows
            // instead of scrolling and the wheel does nothing.
            mdEl.style.flex = "1 1 auto";
            mdEl.style.minHeight = "0";
            mdEl.style.overflowY = "auto";
            mdEl.style.overflowX = "hidden";
            mdEl.style.overscrollBehavior = "contain";
            // Wheel over the popover scrolls the note even if the pointer is
            // over the title block or the box's padding.
            body.addEventListener("wheel", (ev) => {
                if (!mdEl.style.display || mdEl.style.display === "none") return;
                if (mdEl.scrollHeight <= mdEl.clientHeight) return;
                mdEl.scrollTop += ev.deltaY;
                ev.preventDefault();
            }, { passive: false });
            try {
                await MarkdownRenderer.render(this.app, info.text || "", mdEl, sourcePath, this);
            } catch (e) {
                mdEl.setText(info.text || "");
            }

            // MarkdownRenderer hands links over to Obsidian's tooltip system
            // (title/aria-label + listeners), which normal reading views
            // suppress but a bare div in a custom panel does not — hence the
            // black URL box on hover.
            this.stripLinkTooltips(mdEl, sourcePath);


            // Every place the linked passage is mentioned in the note.
            const needles = [];
            if (info.searchRef) {
                const parts = String(info.searchRef).split("-")[0].split(".");
                needles.push(String(info.searchRef).replace(/\./g, " "));
                // "Genesis.3.15" also reads as "Genesis 3:15" in prose.
                if (parts.length >= 3) needles.push(parts[0] + " " + parts[1] + ":" + parts[2]);
            }
            // Every spelling a reference can take in prose: "Genesis.3.15",
            // "Genesis 3 15", "Genesis 3:15", "Genesis 3.15".
            [info.searchRef, info.refRaw].filter(Boolean).forEach((r) => {
                const plain = String(r).replace(/\./g, " ");
                needles.push(plain);
                String(r).split("-")[0].split(".").length >= 3 && needles.push(plain.replace(/(\d+) (\d+)$/, "$1:$2"));
                needles.push(String(r).split("-")[0]);
            });
            if (info.refText) needles.push(info.refText);
            // A note's own bar shows the note unmarked, at the top. Only a
            // crosslink marks and scrolls to its reference.
            let mentions = info.noMentions ? [] : this.findMentions(mdEl, info.searchRef, needles);
            // Skip the note's own heading line, which carries the same reference
            // text as this crosslink. The crosslink's spot in the body is the
            // first mention worth marking.
            if (info.dropFirstMention && mentions.length) {
                const firstBlock = mdEl.firstElementChild;
                while (mentions.length > 1 && firstBlock &&
                    (firstBlock === mentions[0] || firstBlock.contains(mentions[0]))) {
                    mentions.shift();
                }
            }

            // Match heights: measure the natural content height (header + body)
            // at the popover's final width and use it for both the hover state
            // and the pinned state, capped at 60% of the viewport. Below the cap
            // the content scrolls.
            //
            // The width has to settle first: `max-content` is only resolved by
            // layout, and the markdown inside wraps to whatever width it ends up
            // with. Measuring before that produces a height for the wrong wrap
            // (far too tall when the box is measured narrow), which is why some
            // notes came out much longer than their content. Measure with the
            // height/max-height off, read the body's own scrollHeight, then cap.
            // Fixed vertical length: half the old 60vh cap. Content past it
            // scrolls inside; the box never grows to fit the whole note.
            const capH = () => Math.max(180, Math.round(window.innerHeight * 0.3));
            let fittedH = 0;
            const fitHeight = () => {
                // Once the user has dragged the box taller, their height wins.
                if (body.dataset.stepUserH) return;
                // A collapsed note (title bar only) has no content to size to.
                if (body.classList.contains("step-bar-popover-collapsed")) {
                    body.style.height = "auto";
                    body.style.maxHeight = "none";
                    body.style.overflow = "hidden";
                    return;
                }
                fittedH = capH();
                body.style.maxHeight = fittedH + "px";
                body.style.height = fittedH + "px";
                body.style.overflow = "hidden";
                // One scroller only, and it is the markdown element: two nested
                // scrollbars fought each other and swallowed the wheel.
                body.style.overflowY = "hidden";
            };
            fitHeight();
            // Re-measure once layout has settled, in case the initial pass ran
            // before the width resolved (that produced the over-tall boxes).
            requestAnimationFrame(() => requestAnimationFrame(() => {
                try {
                    fitHeight();
                    if (pinned && !collapsedPopover) body.style.height = fittedH + "px";
                    if (mentions.length) scrollToMention(0);
                } catch (e) {}
            }));
            // Late layout (webfonts, images, markdown embeds) can change the
            // wrapped height after the first two frames; settle the size again so
            // a slow-loading note doesn't stay measured at the fallback height.
            window.setTimeout(() => {
                try {
                    if (!body.isConnected) return;
                    fitHeight();
                    if (pinned && !collapsedPopover) body.style.height = fittedH + "px";
                    if (mentions.length) scrollToMention(0);
                } catch (e) {}
            }, 180);

            // Scroll to the first mention, and (pinned) offer a counter button
            // to step through the rest.
            const scrollToMention = (i) => {
                const el = mentions[i];
                if (!el) return;
                // Whatever actually clips the content is the thing to scroll:
                // usually the markdown body, but HoverPopover may wrap it in a
                // scroller of its own. Walk up and take the innermost clipper
                // that overflows; fall back to the body.
                const isScroller = (n) => {
                    if (!n || n.nodeType !== 1 || n === document.body) return false;
                    if (n.scrollHeight <= n.clientHeight + 1) return false;
                    const oy = getComputedStyle(n).overflowY;
                    return oy === "auto" || oy === "scroll" || oy === "overlay";
                };
                let sc = null;
                for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
                    if (isScroller(n)) { sc = n; break; }
                }
                if (!sc && body.scrollHeight > body.clientHeight + 1) {
                    if (getComputedStyle(body).overflowY === "hidden") body.style.overflowY = "auto";
                    sc = body;
                }
                if (!sc) return;
                const cr = sc.getBoundingClientRect();
                const er = el.getBoundingClientRect();
                // Centre the mention in what is actually visible. The title bar
                // can overlap the top of the scroll area, so the covered strip
                // is not usable space: measure the visible box from the bar's
                // lower edge instead.
                const hr = header.getBoundingClientRect();
                const covered = Math.max(0, Math.min(hr.bottom - cr.top, cr.height));
                const usableTop = cr.top + covered;
                const usableH = Math.max(24, cr.height - covered);
                const target = usableTop + usableH / 2 - er.height / 2;
                const delta = er.top - target;
                if (Math.abs(delta) < 1) return;
                const max = sc.scrollHeight - sc.clientHeight;
                sc.scrollTop = Math.min(max, Math.max(0, sc.scrollTop + delta));
            };
            if (mentions.length) scrollToMention(0);

            if (pinned && mentions.length > 1) {
                let idx = 0;
                const counter = btns.createEl("button", { cls: "step-bar-popover-btn step-bar-popover-counter" });
                counter.style.width = "auto";
                counter.style.minWidth = "34px";
                counter.style.padding = "0 6px";
                counter.style.borderRadius = "10px";
                counter.style.fontSize = "11px";
                counter.style.fontFamily = "var(--font-interface)";
                counter.style.background = darkText ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.18)";
                counter.style.color = darkText ? "#3a3a3a" : "#ffffff";
                counter.style.border = "none";
                counter.style.cursor = "pointer";
                counter.style.display = "flex";
                counter.style.alignItems = "center";
                counter.style.justifyContent = "center";
                counter.style.height = "22px";
                counter.style.marginTop = "0";
                counter.style.alignSelf = "center";
                counter.setText(`${idx + 1}/${mentions.length}`);
                counter.setAttribute("aria-label", "Next mention");
                // Stepper sits left of Open/Close.
                if (btns.firstChild !== counter) btns.insertBefore(counter, btns.firstChild);
                counter.addEventListener("pointerdown", (ev) => ev.stopPropagation());
                counter.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    idx = (idx + 1) % mentions.length;
                    counter.setText(`${idx + 1}/${mentions.length}`);
                    scrollToMention(idx);
                });
            }

            // A Bible-note section that holds nothing but the reference itself
            // (no prose, no images) collapses: only its coloured title bar shows.
            let collapsedPopover = false;
            try {
                const tmp = mdEl.cloneNode(true);
                // Links are content, not chrome: a body whose only text is a
                // link must still show. So anchors are kept here and also count
                // as content when deciding whether to collapse.
                const hasLink = !!mdEl.querySelector("a");
                tmp.querySelectorAll("img, video, audio, br, hr, .step-popover-mention").forEach(n => n.remove());
                // The reference can also arrive as plain text (a bare
                // "Genesis 3:15", the note's own title line, frontmatter), so
                // scrub every known spelling of it before deciding.
                let leftover = (tmp.textContent || "").replace(/[\s\u00a0]+/g, "");
                const strip = [info.refText, info.refRaw, info.searchRef];
                if (info.searchRef) {
                    const p = String(info.searchRef).split("-")[0].split(".");
                    strip.push(String(info.searchRef).replace(/\./g, " "));
                    if (p.length >= 3) { strip.push(p[0] + " " + p[1] + ":" + p[2]); strip.push(p[0] + " " + p[1] + "." + p[2]); }
                }
                strip.filter(Boolean).forEach((t) => {
                    const needle = String(t).replace(/[\s\u00a0]+/g, "");
                    if (!needle) return;
                    while (leftover.includes(needle)) leftover = leftover.split(needle).join("");
                });
                // Drop punctuation-only remains ("|", "—", "()", ":") too.
                leftover = leftover.replace(/[|\-–—:;,·•·()\[\]{}"“”'’«»]/g, "");
                if (!leftover && !hasLink) {
                    mdEl.style.display = "none";
                    mdEl.style.padding = "0";
                    body.classList.add("step-bar-popover-collapsed");
                    collapsedPopover = true;
                }
            } catch (e) {}

            if (pinned) {
                // Keep it where it is, movable and resizable, and stop the
                // HoverPopover from hiding itself when the mouse leaves it.
                body.classList.add("step-bar-popover-pinned");
                // HoverPopover re-positions its element on mousemove via a
                // transform; that fights the drag. Neutralise both hooks.
                try { if (typeof pop.position === "function") pop.position = () => {}; } catch (e) {}
                try { if (typeof pop.show === "function") pop.show = () => {}; } catch (e) {}
                const r = anchorEl.getBoundingClientRect();
                body.style.position = "fixed";
                // Obsidian positions hover popovers with a CSS transform, which
                // would override left/top entirely and make the box refuse to
                // move. Take the transform off so the drag can use left/top.
                body.style.transform = "none";
                body.style.translate = "0 0";
                body.style.maxHeight = capH() + "px";
                body.style.inset = "auto";
                body.style.zIndex = "1000000";
                body.style.left = Math.max(4, r.left - body.offsetWidth) + "px";
                body.style.top = r.top + "px";
                body.style.right = "auto";
                body.style.overflow = "hidden";
                body.style.minWidth = "240px";
                // Keep the measured height from the hover state (do not force a
                // fixed 210px), so pinning doesn't change the box's size. The
                // height must stay pinned too: with maxHeight:none the box just
                // grows to fit the whole note and there is nothing left to
                // scroll. Fixed height + the body's own scroller = scrollable.
                body.style.minHeight = collapsedPopover ? "0" : "80px";
                body.style.maxWidth = "560px";
                body.style.maxHeight = collapsedPopover ? "none" : capH() + "px";
                if (!collapsedPopover) body.style.height = capH() + "px";

                // Vertical-only resize handle along the bottom edge: drag down
                // to make the box taller (content scrolls inside).
                const grip = body.createDiv({ cls: "step-bar-popover-grip" });
                grip.style.position = "absolute";
                grip.style.left = "0";
                grip.style.right = "0";
                grip.style.bottom = "0";
                grip.style.height = "9px";
                grip.style.cursor = "ns-resize";
                grip.style.zIndex = "10";
                grip.style.background = "transparent";
                let vresize = null;
                grip.addEventListener("pointerdown", (ev) => {
                    ev.preventDefault();
                    vresize = { sy: ev.clientY, h: body.offsetHeight };
                    grip.setPointerCapture(ev.pointerId);
                });
                grip.addEventListener("pointermove", (ev) => {
                    if (!vresize) return;
                    body.dataset.stepUserH = "1";
                    body.style.height = Math.max(80, vresize.h + ev.clientY - vresize.sy) + "px";
                });
                const endV = () => { vresize = null; };
                grip.addEventListener("pointerup", endV);
                grip.addEventListener("pointercancel", endV);
                entry.hide = () => { try { body.remove(); } catch (e) {} };

                // Drag by the header. Listeners go on document while dragging:
                // element capture is unreliable here because Obsidian's
                // HoverPopover owns the element and can re-render it mid-drag.
                // Drag the box. Deliberately capture-free: element pointer
                // capture can be lost the moment anything re-renders the
                // header (which happens on notes whose popover body is rebuilt,
                // e.g. one referencing its own section), and a spurious
                // `lostpointercapture` used to end the drag on its first tick.
                // Everything runs off window-level capture listeners instead.
                let drag = null;
                let dragRaf = false;
                const onDragMove = (ev) => {
                    if (!drag) return;
                    if (ev.pointerId !== undefined && drag.pid !== ev.pointerId) return;
                    const dx = ev.clientX - drag.sx;
                    const dy = ev.clientY - drag.sy;
                    if (!dx && !dy) return;
                    drag.moved = true;
                    body.style.left = Math.max(0, drag.l + dx) + "px";
                    body.style.top = Math.max(0, drag.t + dy) + "px";
                };
                const onDragEnd = (ev) => {
                    if (!drag) return;
                    // Ignore a pointerup/cancel that belongs to another pointer.
                    if (ev && ev.pointerId !== undefined && drag.pid !== undefined &&
                        ev.pointerId !== drag.pid && ev.type !== "blur") return;
                    // A pointerup while the button is still reported down, or a
                    // pointercancel we did not ask for, must not kill the drag.
                    if (ev && ev.type === "pointerup" && ev.buttons) return;
                    drag = null;
                    dragRaf = false;
                    this._barDragging = false;
                    try { body.style.userSelect = ""; body.style.cursor = "move"; } catch (e) {}
                    window.removeEventListener("pointermove", onDragMove, true);
                    window.removeEventListener("pointerup", onDragEnd, true);
                    window.removeEventListener("pointercancel", onDragEnd, true);
                    window.removeEventListener("blur", onBlur, true);
                };
                const onBlur = () => onDragEnd({ type: "blur" });
                header.style.cursor = "move";
                header.style.touchAction = "none";
                header.style.userSelect = "none";
                body.style.cursor = "move";
                const startDrag = (ev) => {
                    if (drag) return;
                    if (ev.button !== undefined && ev.button !== 0) return;
                    const t = ev.target;
                    if (t && t.closest && t.closest("button, a, .step-bar-popover-grip")) return;
                    const r = body.getBoundingClientRect();
                    // The box is right-aligned with translateX(-100%); drop the
                    // transform before dragging or it jumps a full width left.
                    body.style.transform = "none";
                    body.style.left = r.left + "px";
                    body.style.top = r.top + "px";
                    drag = { sx: ev.clientX, sy: ev.clientY, l: r.left, t: r.top, pid: ev.pointerId, moved: false };
                    // Stop hover handling for the duration of the drag.
                    this._barDragging = true;
                    clearTimeout(this._barOpenTimer);
                    clearTimeout(this._hoverCloseTimer);
                    try { body.style.userSelect = "none"; body.style.cursor = "grabbing"; } catch (e) {}
                    // Nothing else in Obsidian gets to see this press: link
                    // handling, page preview and the editor all bail out.
                    try { ev.preventDefault(); } catch (e) {}
                    try { ev.stopPropagation(); } catch (e) {}
                    window.addEventListener("pointermove", onDragMove, true);
                    window.addEventListener("pointerup", onDragEnd, true);
                    window.addEventListener("pointercancel", onDragEnd, true);
                    window.addEventListener("blur", onBlur, true);
                };
                // One entry point only. A single capture listener, so a press
                // fires startDrag exactly once (the old body+header pair fired
                // it twice and the second pass could clear the drag state).
                body.addEventListener("pointerdown", startDrag, true);
            }

            if (collapsedPopover) {
                body.style.height = "auto";
                body.style.minHeight = "0";
                body.style.maxHeight = "none";
                body.style.overflow = "hidden";
                body.style.padding = "0";
            }

            // Layout (and, when pinned, repositioning) lands a frame or two after
            // the box is built; re-run the jump until it sticks.
            if (mentions.length) {
                requestAnimationFrame(() => {
                    scrollToMention(0);
                    requestAnimationFrame(() => {
                        scrollToMention(0);
                        requestAnimationFrame(() => scrollToMention(0));
                    });
                });
            }

            entry.anchorEl = anchorEl;

            // Obsidian sets its own stacking on show; re-assert ours a frame
            // later so a hover note always sits above a pinned one.
            const wantZ = pinned ? "1000000" : "1000002";
            const reassertZ = () => { try { body.style.zIndex = wantZ; } catch (e) {} };
            reassertZ();
            requestAnimationFrame(() => { reassertZ(); requestAnimationFrame(reassertZ); });
        };

        // Leaving the window kills any open (unpinned) popover
        this.registerDomEvent(document, "mouseleave", () => this._scheduleHoverClose());
    }

    // Kill Obsidian's hover tooltips on links rendered into a custom panel.
    // Attributes are not enough: Obsidian attaches hover listeners to the
    // anchor, so each link is replaced with a clean clone (no listeners, no
    // tooltip attributes) and given our own click handling back.
    // Every place a reference is mentioned in rendered note text: anchors whose
    // link points at the same passage, else plain-text hits for the reference.
    // Returns the marked elements in document order.
    findMentions(root, refRaw, needles) {
        const spans = [];
        const mark = (el) => {
            el.classList.add("step-popover-mention");
            el.style.backgroundColor = "rgba(190, 190, 163, 0.22)";
            el.style.borderRadius = "3px";
            el.style.boxShadow = "0 0 0 2px rgba(190, 190, 163, 0.16)";
            el.style.color = "inherit";
            spans.push(el);
        };
        const target = String(refRaw || "").replace(/\s+/g, "").toLowerCase();
        if (target) {
            root.querySelectorAll("a").forEach((a) => {
                const h = a.getAttribute("href") || a.getAttribute("data-href") || "";
                const m = h.match(/reference=([^&]+)/);
                if (!m) return;
                let v = m[1];
                try { v = decodeURIComponent(v); } catch (e) {}
                if (String(v).replace(/\s+/g, "").toLowerCase() === target) mark(a);
            });
        }
        if (spans.length) return spans;

        const escape = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [];
        for (const n of needles || []) {
            const t = String(n || "").replace(/\s+/g, " ").trim();
            if (!t) continue;
            const re = new RegExp(t.split(" ").map(escape).join("\\s+"), "gi");
            if (!patterns.some(p => p.source === re.source)) patterns.push(re);
        }
        if (!patterns.length) return spans;

        const nodes = [];
        const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName))
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
        });
        let node;
        while ((node = walker.nextNode())) nodes.push(node);

        for (const original of nodes) {
            if (!original.nodeValue || !original.parentNode) continue;
            // The node under the cursor is replaced as we split, so scan the
            // tail of the split rather than the original node — hence `let`,
            // not the for-of binding.
            let n = original;
            // One pass over a combined pattern: splitting the text mutates the
            // node the other patterns were about to scan.
            const combined = new RegExp(patterns.map(p => "(?:" + p.source + ")").join("|"), "gi");
            let m;
            while (n.nodeValue && (m = combined.exec(n.nodeValue)) !== null) {
                if (!m[0].length) { combined.lastIndex++; continue; }
                let textNode = n;
                if (m.index > 0) textNode = n.splitText(m.index);
                const after = textNode.splitText(m[0].length);
                const span = root.ownerDocument.createElement("span");
                span.textContent = textNode.nodeValue;
                textNode.parentNode.replaceChild(span, textNode);
                mark(span);
                n = after;
                if (!n.nodeValue) break;
                combined.lastIndex = 0;
            }
        }
        return spans;
    }

    stripLinkTooltips(root, sourcePath) {
        root.querySelectorAll("a").forEach(a => {
            const ext = a.classList.contains("external-link");
            const href = a.getAttribute("href") || "";
            const dataHref = a.getAttribute("data-href") || "";
            const clone = a.cloneNode(true);
            for (const attr of ["title", "aria-label", "data-tooltip", "aria-describedby"]) {
                clone.removeAttribute(attr);
                clone.querySelectorAll("[" + attr + "]").forEach(n => n.removeAttribute(attr));
            }
            clone.addEventListener("mouseover", () => {
                // Strip again on hover: Obsidian's post-processing can re-add
                // tooltip attributes after the initial render. Attributes are
                // removed, but the event is NOT stopped — Obsidian's page
                // preview (the grey hover popout) is a document-level handler
                // and needs the event to bubble.
                for (const attr of ["title", "aria-label", "data-tooltip", "aria-describedby"]) clone.removeAttribute(attr);
            });
            clone.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (ext) {
                    window.open(href, "_blank");
                    return;
                }
                const target = dataHref || href;
                if (!target) return;
                this.app.workspace.openLinkText(target, sourcePath || "", false);
            });
            a.replaceWith(clone);
        });

        // MarkdownRenderer post-processing is async; sweep once more after the
        // current task so late-added title attributes are cleared too.
        setTimeout(() => {
            root.querySelectorAll("a").forEach(a => {
                for (const attr of ["title", "aria-label", "data-tooltip", "aria-describedby"]) a.removeAttribute(attr);
            });
        }, 0);
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