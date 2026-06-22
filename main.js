const { Plugin, requestUrl } = require('obsidian');

module.exports = class StepBibleLinkerPlugin extends Plugin {
    async onload() {
        console.log('STEP Bible Linker: Restored Text Overlay Engine Active.');
        this.activePopover = null;

        // LINK REFERENCE AT CURSOR 
        this.addCommand({
            id: 'auto-link-step-ref',
            name: 'Link Reference at Cursor',
            editorCallback: (editor) => {
                //Get cursor
                const cursor = editor.getCursor();
                //Get text line with cursor
                const line = editor.getLine(cursor.line);

                const refRegex = this.buildReferenceRegexGlobal();
                let match = null, start = 0, end = 0;

                let m;
                //While there is a verse in the line:
                while ((m = refRegex.exec(line)) !== null) {
                    const mStart = m.index;
                    const mEnd = mStart + m[0].length;

                    if (cursor.ch >= mStart && cursor.ch <= mEnd) {
                        match = m[0];
                        start = mStart;
                        end = mEnd;
                        break;
                    }
                }
                //If no match, return.
                if (!match) return;

                const before = line.slice(0, start);
                const after = line.slice(end);
                if (before.endsWith("[") && after.startsWith("]")) return;

                //Build a URL from the match
                const result = this.buildStepLink(match);
                if (!result) return;

                //Replace the text with the correct link format. 
                const replacement = `[${result.expandedText}](${result.finalUrl})`;
                const newLine = line.slice(0, start) + replacement + line.slice(end);

                editor.setLine(cursor.line, newLine);
            }
        });

        //HOVERING HANDLER
        this.registerDomEvent(document, 'mouseover', async (evt) => {
            const targetEl = evt.target;
            if (!targetEl) return;

            let linkUrl = "";

            // 1. Expanded link in editor
            const lineParent = targetEl.closest('.cm-line');
            if (lineParent) {
                const m = lineParent.textContent.match(/https?:\/\/localhost:8989\/[^\s)]+/);
                if (m) linkUrl = m[0];
            }

            // 2. Reading mode <a>
            if (!linkUrl) {
                const a = targetEl.closest('a[href]');
                if (a && a.href.startsWith('http://localhost:8989/')) linkUrl = a.href;
            }

            // 3. Collapsed Live Preview
            if (!linkUrl) {
                const u = targetEl.closest('.cm-underline');
                if (u) {
                    const t = u.textContent.trim();

                    const refPattern =
                        /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*(?:\s+\d+(?::\d+)?(?:\s*-\s*\d+(?::\d+)?)?)?$/;

                    if (refPattern.test(t)) {
                        const result = this.buildStepLink(t);
                        if (result) linkUrl = result.finalUrl;
                    }
                }
            }

            if (!linkUrl.startsWith('http://localhost:8989/')) return;

            // If a popover is already open, close it
            if (this.activePopover) {
                this.activePopover.remove();
                this.activePopover = null;
            }

            // Create popover
            const pop = document.createElement("div");
            Object.assign(pop.style, {
                position: "fixed",
                left: `${evt.clientX + 15}px`,
                top: `${evt.clientY + 15}px`,
                backgroundColor: "var(--background-secondary-alt)",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                padding: "14px",
                width: "460px",
                maxHeight: "350px",
                overflowY: "auto",
                boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
                zIndex: "99999",
                color: "var(--text-normal)",
                fontSize: "13.5px",
                lineHeight: "1.6",
                fontFamily: "var(--font-interface)"
            });

            pop.innerHTML = "<i>Loading STEP Bible…</i>";
            document.body.appendChild(pop);
            this.activePopover = pop;

            // Hide logic
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

            // Attach listeners
            requestAnimationFrame(() => {
                targetEl.addEventListener("mouseleave", scheduleHide, { once: true });
                pop.addEventListener("mouseenter", cancelHide);
                pop.addEventListener("mouseleave", scheduleHide);
            });

            // Fetch STEP text
            try {
                if (!(await this.isLocalStepRunning())) {
                    linkUrl = this.rewriteToOnline(linkUrl);
                }

                const serverRef = this.extractReferenceFromUrl(linkUrl);
                if (!serverRef) return;

                // BOOK-ONLY HOVER HANDLING
                // A book-only reference has no chapter/verse → no dots in serverRef
                if (!serverRef.includes(".")) {
                    const info = this.getBookOverview(serverRef);

                    if (info) {
                        pop.innerHTML = `
                            <b>${info.name}</b><br>
                            ${info.chapters} chapters<br><br>
                            <i>Author:</i> ${info.author}<br>
                            <i>Location:</i> ${info.location}<br>
                            <i>Date:</i> ${info.date}<br><br>
                            ${info.synopsis}
                        `;

                        // Stop here — do NOT run the verse-fetching logic
                        return;
                    }

                    // Fallback if overview missing
                    pop.innerHTML = `<b>${serverRef}</b><br>No overview available.`;
                    return;
                }

                const verseRefs = this.expandServerRefToVerseList(serverRef);

                let combined = "";
                const seen = new Set();

                for (const vRef of verseRefs) {
                    const verseUrl = this.buildUrlForRef(linkUrl, vRef);
                    const verseText = await this.fetchSingleVerseFromTitle(verseUrl);
                    if (!verseText || seen.has(verseText)) continue;
                    seen.add(verseText);

                    const [book, chap, verse] = vRef.split(".");
                    combined += `<p><strong>${chap}:${verse}</strong> ${verseText}</p>`;
                }

                pop.innerHTML = combined || "<p><i>No English text found.</i></p>";

                // Add bottom padding only if scrollable
                requestAnimationFrame(() => {
                    if (pop.scrollHeight > pop.clientHeight) {
                        pop.style.paddingBottom = "24px"; // or whatever feels right
                    }

                    // Prevent right-edge overflow
                    const rect = pop.getBoundingClientRect();
                    const overflow = rect.right - window.innerWidth;

                    if (overflow > 0) {
                        pop.style.left = `${evt.clientX - rect.width - 15}px`;
                    }
                });

            } catch (err) {
                pop.innerHTML = `<span style="color:var(--text-error)">Failed to load STEP Bible.</span>`;
            }
        });

        // DIALOGUE BOX FOR REFERENCE SEARCH
        this.addCommand({
            id: "step-bible-search",
            name: "Search Bible Reference…",

            callback: () => {
                const { Modal, requestUrl, MarkdownView } = require("obsidian");
                const plugin = this;

                class BibleSearchModal extends Modal {
                    constructor(app, plugin, onSubmit, prefill = "") {
                        super(app);
                        this.plugin = plugin;
                        this.onSubmit = onSubmit;
                        this.prefill = prefill;
                    }

                    onOpen() {
                        const { contentEl } = this;

                        // Use flex column + gap for consistent vertical spacing
                        contentEl.style.display = "flex";
                        contentEl.style.flexDirection = "column";
                        contentEl.style.gap = "14px";
                        contentEl.style.padding = "12px";

                        const title = contentEl.createEl("h3", { text: "Enter Bible Reference" });
                        title.style.margin = "0";
                        title.style.padding = "0";
                        title.style.fontSize = "16px";

                        const input = contentEl.createEl("input", {
                            type: "text",
                            placeholder: "e.g., Numbers 3:16"
                        });

                        // Larger input spacing and comfortable touch target
                        input.style.width = "100%";
                        input.style.margin = "0";
                        input.style.padding = "10px 8px";
                        input.style.fontSize = "14px";
                        input.style.borderRadius = "6px";

                        // Small hint under the input — make it almost the same color as the background
                        const hint = contentEl.createEl("div", {
                            text: "Type bible for all scripture references."
                        });
                        hint.style.fontSize = "12px";
                        hint.style.margin = "0";
                        hint.style.padding = "0";

                        // Detect theme and set hint color to be nearly background-matching
                        const isDark = document.body.classList.contains("theme-dark");
                        // Very subtle: near-background (almost invisible)
                        hint.style.color = isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0)";
                        hint.style.opacity = "1";

                        // Prefill if provided
                        if (this.prefill && this.prefill.trim()) {
                            input.value = this.prefill.trim();
                            input.select();
                        }

                        this._keydownHandler = async (evt) => {
                            const rawValue = input.value || "";
                            const trimmed = rawValue.trim();

                            // ENTER → merged behavior (normal submit + open search)
                            if (evt.key === "Enter") {

                                evt.preventDefault();
                                evt.stopPropagation();

                                // Normal submit
                                this.onSubmit(input.value);

                                // ALSO open search with the same query
                                const query = this.buildSearchQuery(trimmed);

                                plugin.app.workspace.leftSplit?.expand();

                                let leaf = plugin.app.workspace.getLeavesOfType("search")[0];

                                console.log(leaf)

                                if (!leaf) {
                                    leaf = plugin.app.workspace.getLeftLeaf(false);
                                    await leaf.setViewState({
                                        type: "search",
                                        state: { query }
                                    });
                                }

                                leaf.view?.setQuery?.(query);
                                plugin.app.workspace.setActiveLeaf(leaf, { focus: true });

                                this.close();
                            }
                        };
                        
                        input.addEventListener("keydown", this._keydownHandler);

                        input.focus();
                    }

                    // buildSearchQuery uses plugin helpers on plugin
                    buildSearchQuery(ref) {
                        ref = ref.trim();

                        if (ref.toLowerCase() === "bible") {
                            return "reference=";
                        }

                        const parsed = this.plugin.parseAndExpandVerse(ref);
                        if (!parsed || !parsed.serverRef) {
                            return `"${ref}"`;
                        }

                        const serverRef = parsed.serverRef.replace(/\s+/g, "");

                        // Book-only: match any STEP reference that starts with the book
                        if (!serverRef.includes(".")) {
                            return `"reference=${serverRef}"`;
                        }

                        let refs = [];

                        if (serverRef.includes("-")) {
                            const [left, right] = serverRef.split("-");
                            const lParts = left.split(".");
                            const rParts = right.split(".");

                            if (lParts.length === 2 && rParts.length === 2 && lParts[0] === rParts[0]) {
                                const book = lParts[0];
                                const startChap = parseInt(lParts[1], 10);
                                const endChap = parseInt(rParts[1], 10);

                                if (!Number.isNaN(startChap) && !Number.isNaN(endChap) && startChap <= endChap) {
                                    for (let c = startChap; c <= endChap; c++) {
                                        refs.push(`${book}.${c}`);
                                    }
                                } else {
                                    refs = this.plugin.expandServerRefToVerseList
                                        ? this.plugin.expandServerRefToVerseList(serverRef)
                                        : [serverRef];
                                }
                            } else {
                                refs = this.plugin.expandServerRefToVerseList
                                    ? this.plugin.expandServerRefToVerseList(serverRef)
                                    : [serverRef];
                            }
                        } else {
                            const parts = serverRef.split(".");
                            if (parts.length === 2) {
                                refs.push(serverRef);
                            } else {
                                refs.push(serverRef);
                            }
                        }

                        refs = Array.from(new Set(refs || []));
                        if (refs.length === 0) return `"${ref}"`;

                        const parts = refs.map(r => `"reference=${r}"`);
                        return parts.join(" OR ");
                    }

                    onClose() {
                        const input = this.contentEl.querySelector("input");
                        if (input && this._keydownHandler) {
                            input.removeEventListener("keydown", this._keydownHandler);
                        }

                        this.contentEl.empty();
                    }

                }

                // Determine a sensible prefill:
                // 1) If an editor is active, use its selection
                // 2) Otherwise, try the DOM selection (reading mode)
                // 3) Otherwise, empty string
                let prefill = "";

                const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView && activeView.editor) {
                    prefill = activeView.editor.getSelection() || "";
                } else {
                    try {
                        const domSel = (window.getSelection && window.getSelection().toString && window.getSelection().toString()) || "";
                        prefill = domSel || "";
                    } catch (e) {
                        prefill = "";
                    }
                }

                const modal = new BibleSearchModal(this.app, plugin, async (refText) => {
                    console.log("Modal submitted:", refText);

                    // If the reference ends with letters (no digits after the letters), append " 1"
                    if (/^[A-Za-z0-9\s]+[A-Za-z]+$/.test(refText)) {
                        refText = refText.trim() + " 1";
                    }

                    const result = this.buildStepLink(refText);
                    console.log("buildStepLink result:", result);

                    if (!result) return;

                    // Do NOT insert anything into the editor

                    // Use your helper first
                    const localIsUp = await this.isLocalStepRunning();

                    let urlToOpen;
                    if (localIsUp) {
                        try {
                            const res = await requestUrl({
                                url: result.finalUrl,
                                method: "GET",
                                throw: false
                            });

                            if (res.status >= 200 && res.status < 400) {
                                urlToOpen = result.finalUrl;
                            } else {
                                urlToOpen = this.rewriteToOnline(result.finalUrl);
                            }
                        } catch {
                            urlToOpen = this.rewriteToOnline(result.finalUrl);
                        }
                    } else {
                        urlToOpen = this.rewriteToOnline(result.finalUrl);
                    }

                    console.log("Opening URL:", urlToOpen);
                    window.open(urlToOpen, "_blank");
                }, prefill);

                modal.open();
            }
        });
        
    }

    // BUILDS THE STEP URL FROM GIVEN TEXT
    buildStepLink(refText) {

        const urlPrefix = "http://localhost:8989/?q=version=ESV@version=THOT@version=SBLG@reference=";
        const urlSuffix = "&options=GNVUH&display=COLUMN";

        // Normalize input
        const clean = refText.trim().replace(/\s+/g, " ");

        // 1. BOOK-ONLY HANDLING (optionally numbered, but NO chapter/verse)
        const bookOnlyPattern = /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

        // Test the input to see if it just a book.
        if (bookOnlyPattern.test(clean)) {
            const lookupKey = clean.toLowerCase();

            const book = this.getBookMap()[lookupKey];

            if (!book) return null;

            return {
                expandedText: book,
                finalUrl: `${urlPrefix}${book}${urlSuffix}`
            };
        }

        // 2. FULL PARSE (chapter/verse/range)
        const parsingResult = this.parseAndExpandVerse(clean);
        if (!parsingResult) return null;

        return {
            expandedText: parsingResult.expandedText,
            finalUrl: `${urlPrefix}${parsingResult.serverRef}${urlSuffix}`
        };
    }

    // CHECKS IF LOCAL STEP IS RUNNING
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

    // REWRITES URL TO ONLINE STEP BIBLE
    rewriteToOnline(url) {
        const onlineBase = "https://www.stepbible.org/?";

        // Extract the query string after '?q='
        const match = url.match(/\?q=([^#]+)/);
        if (!match) return url;

        return `${onlineBase}q=${match[1]}`;
    }

    // --- Extract "reference=..." from the STEP URL ---
    extractReferenceFromUrl(url) {
        const match = url.match(/reference=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    // --- Build a new URL with a different reference=... ---
    buildUrlForRef(originalUrl, newRef) {
        if (originalUrl.includes("reference=")) {
            return originalUrl.replace(/reference=[^&]+/, `reference=${encodeURIComponent(newRef)}`);
        }
        return originalUrl;
    }

    // --- Fetch text by reading <title> text ---
    async fetchSingleVerseFromTitle(url) {
        const response = await requestUrl({ url });
        const html = response.text;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        const title = doc.querySelector("title")?.textContent || "";
        const parts = title.split("|").map(p => p.trim());

        let verseText = "";
        if (parts.length >= 4) {
            verseText = parts[3]; // English text
        }

        verseText = verseText
            .replace(/\s+/g, " ")              // collapse weird spacing
            .replace(/\s+([,;:.!?])/g, "$1")   // remove space before punctuation
            .replace(/\s+\)/g, ")")            // remove space before ')'
            .replace(/\(\s+/g, "(")            // remove space after '('
            .replace(/\s*,\s*$/g, "")          // remove trailing commas only
            .trim();

        return verseText || null;
    }

    // --- Expand a STEP-style serverRef into a list of verse refs ---
    expandServerRefToVerseList(serverRef) {
        // Normalize: remove spaces from book part if any slipped through
        serverRef = serverRef.replace(/\s+/g, "");

        if (!serverRef.includes("-")) {
            const parts = serverRef.split(".");
            if (parts.length === 3) {
                return [serverRef];
            }
            if (parts.length === 2) {
                const [book, chapStr] = parts;
                const chap = parseInt(chapStr, 10);
                const maxVerse = this.getMaxVerse(book, chap);
                if (!maxVerse) return [serverRef];
                const list = [];
                for (let v = 1; v <= maxVerse; v++) {
                    list.push(`${book}.${chap}.${v}`);
                }
                return list;
            }
            return [serverRef];
        }

        const [startRef, endRef] = serverRef.split("-");
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

    //TURNS REFERENCE TEXT INTO FULL REFERENCE AND URL
    parseAndExpandVerse(text) {

        // 1. BOOK-ONLY HANDLING (optionally numbered, but NO chapter/verse)
        const bookOnlyPattern = /^[1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

        // Only treat as book-only if:
        // - It matches the book-only pattern
        // - AND it does NOT contain any chapter/verse digits after the book name
        // Only treat as book-only if it matches AND has no chapter/verse
        if (bookOnlyPattern.test(text.trim()) && !/\d+\s*:/.test(text)) {
            const lookupKey = text.trim().toLowerCase();
            const book = this.getBookMap()[lookupKey];

            if (book) {
                return {
                    expandedText: book,
                    serverRef: book
                };
            }
        }

        // Detect spaced dash BEFORE normalization destroys spacing
        const hasSpacedDash = /\s+-\s+/.test(text);

        let clean = text
            .replace(/–/g, "-")
            .replace(/\s*-\s*/g, "-")
            .replace(/:/g, ".");

        const bookRegex = /^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)/;
        const match = clean.match(bookRegex);
        if (!match) return { expandedText: text, serverRef: clean };

        const rawBook = match[0].trim();
        const lookupKey = rawBook.replace(/\s+/g, " ").toLowerCase();
        const book = this.getBookMap()[lookupKey] || rawBook;

        // ⭐ STEP Bible requires "Song" instead of "Song of Solomon"
        const stepFix = {
            "Song of Solomon": "Song",
            "Song of Songs": "Song",
            "Canticles": "Song",
            "Song": "Song"
        };
        const fixedBook = stepFix[book] || book;

        // STEP / verseCounts key: remove spaces from book name
        const bookKey = book.replace(/\s+/g, "");

        let remainder = clean.replace(match[0], "").trim();

        if (!remainder.includes("-")) {
            const parts = remainder.split(".");
            if (parts.length === 1) {
                return {
                    expandedText: `${book} ${parts[0]}`,
                    serverRef: `${bookKey}.${parts[0]}`
                };
            }
            if (parts.length === 2) {
                return {
                    expandedText: `${book} ${parts[0]}:${parts[1]}`,
                    serverRef: `${bookKey}.${parts[0]}.${parts[1]}`
                };
            }
        }

        const [left, right] = remainder.split("-");
        const leftParts = left.split(".");
        const rightParts = right.split(".");

        // NEW RULE: spaced dash means cross-chapter (e.g. "Jer 4:7 - 8")
        if (hasSpacedDash && leftParts.length === 2 && rightParts.length === 1) {
            const lChap = leftParts[0];
            const lVerse = leftParts[1];
            const rChap = rightParts[0];

            const maxVerse = this.getMaxVerse(book, rChap);

            return {
                expandedText: `${book} ${lChap}:${lVerse} - ${rChap}:${maxVerse}`,
                serverRef: `${bookKey}.${lChap}.${lVerse}-${bookKey}.${rChap}.${maxVerse}`
            };
        }

        if (leftParts.length === 1 && rightParts.length === 1) {
            // CASE 1: CHAPTER → CHAPTER
            // Example: "Jer 3-4"
            // Meaning: Jeremiah chapters 3 through 4
            return {
                expandedText: `${book} ${leftParts[0]}-${rightParts[0]}`,
                serverRef: `${bookKey}.${leftParts[0]}-${bookKey}.${rightParts[0]}`
            };
        }

        if (leftParts.length === 2 && rightParts.length === 1) {
            // CASE 2: SAME-CHAPTER VERSE RANGE
            // Example: "Jer 3.1-8"
            // Meaning: Jeremiah 3:1–8
            return {
                expandedText: `${book} ${leftParts[0]}:${leftParts[1]}-${rightParts[0]}`,
                serverRef: `${bookKey}.${leftParts[0]}.${leftParts[1]}-${bookKey}.${leftParts[0]}.${rightParts[0]}`
            };
        }

        if (leftParts.length === 1 && rightParts.length === 2) {
            // CASE 3: CHAPTER → VERSE (CROSS-CHAPTER ENDING)
            // Example: "Jer 3-4.8"
            // Meaning: Jeremiah 3:1 through 4:8
            return {
                expandedText: `${book} ${leftParts[0]}-${rightParts[0]}:${rightParts[1]}`,
                serverRef: `${bookKey}.${leftParts[0]}-${bookKey}.${rightParts[0]}.${rightParts[1]}`
            };
        }

        if (leftParts.length === 2 && rightParts.length === 2) {
            // CASE 4: VERSE → VERSE (FULL CROSS-CHAPTER RANGE)
            // Example: "Jer 3.1-4.8"
            // Meaning: Jeremiah 3:1–4:8
            return {
                expandedText: `${book} ${leftParts[0]}:${leftParts[1]} - ${rightParts[0]}:${rightParts[1]}`,
                serverRef: `${bookKey}.${leftParts[0]}.${leftParts[1]}-${bookKey}.${rightParts[0]}.${rightParts[1]}`
            };
        }

        return {
            expandedText: text,
            serverRef: `${bookKey}.${left}-${bookKey}.${right}`
        };
    }

    //BUILDS A REGEX TO DETECT BOOK NAMES FROM TEXT LINE
    buildReferenceRegexGlobal() {
        const books = this.getAllBookPatterns();

        // Book group
        const bookGroup = `(?:${books.join("|")})`;

        // Chapter/verse/range
        const cv = `\\d+(?:[:.]\\d+)?`;
        const range = `${cv}(?:\\s*-\\s*${cv})?`;

        // Full pattern:
        // - Book only
        // - Book + chapter/verse/range
        const pattern =
            `${bookGroup}(?:\\s+${range})?`;

        return new RegExp(pattern, "gi");
    }

    //RETURNS ALL POSSIBLE BOOK NAMES, ABBREVIATIONS INCLUDED
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

    //MAP OF ALL BOOK NAMES
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
                { bookName: "Song of Songs", abbreviations: ["Song", "SS", "So", "Sg", "Song of Solomon"] },
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
                { bookName: "1 Peter", abbreviations: ["1 Pet", "1 Pt", "1P"] },
                { bookName: "2 Peter", abbreviations: ["2 Pet", "2 Pt", "2P"] },
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

    //ALL MAX VERSE NUMBERS IN EVERY CHAPTER OF BIBLE
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

    //ALL BOOK OVERVIEWS
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
            "1 Samuel": {
                name: "1 Samuel",
                chapters: 31,
                author: "Traditionally Samuel, with later prophets (Nathan, Gad)",
                location: "Israel",
                date: "c. 1050–1000 BC",
                synopsis: "Transition from judges to monarchy: Samuel, Saul’s rise and fall, and David’s anointing."
            },
            "2 Samuel": {
                name: "2 Samuel",
                chapters: 24,
                author: "Traditionally Nathan, Gad, and other court prophets",
                location: "Israel (Jerusalem)",
                date: "c. 1000–960 BC",
                synopsis: "David’s reign, his victories, sins, family turmoil, and God’s covenant promise to his house."
            },
            "1 Kings": {
                name: "1 Kings",
                chapters: 22,
                author: "Unknown, traditionally a prophetic historian",
                location: "Israel/Judah (likely during exile)",
                date: "c. 560–540 BC",
                synopsis: "Solomon’s reign, the kingdom’s division, and the early history of Israel and Judah’s kings."
            },
            "2 Kings": {
                name: "2 Kings",
                chapters: 25,
                author: "Unknown, traditionally a prophetic historian",
                location: "Exilic context (Babylon)",
                date: "c. 560–540 BC",
                synopsis: "The decline of Israel and Judah, leading to the fall of Samaria and Jerusalem and exile."
            },
            "1 Chronicles": {
                name: "1 Chronicles",
                chapters: 29,
                author: "Unknown, traditionally Ezra",
                location: "Post‑exilic Judah",
                date: "c. 450–400 BC",
                synopsis: "Genealogies and a retelling of David’s reign with focus on worship and the temple."
            },
            "2 Chronicles": {
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
            "1 Corinthians": {
                name: "1 Corinthians",
                chapters: 16,
                author: "Paul",
                location: "Ephesus",
                date: "c. AD 54–55",
                synopsis: "Addresses church divisions, immorality, spiritual gifts, and the resurrection."
            },
            "2 Corinthians": {
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
            "1 Thessalonians": {
                name: "1 Thessalonians",
                chapters: 5,
                author: "Paul",
                location: "Corinth",
                date: "c. AD 50–51",
                synopsis: "Encourages a young church in faith, love, hope, and readiness for Christ’s return."
            },
            "2 Thessalonians": {
                name: "2 Thessalonians",
                chapters: 3,
                author: "Paul",
                location: "Corinth",
                date: "c. AD 51–52",
                synopsis: "Clarifies teaching about the day of the Lord and exhorts believers to steadfastness and work."
            },
            "1 Timothy": {
                name: "1 Timothy",
                chapters: 6,
                author: "Paul",
                location: "Macedonia",
                date: "c. AD 62–64",
                synopsis: "Instructions to Timothy on church leadership, sound doctrine, and godly living."
            },
            "2 Timothy": {
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
            "1 Peter": {
                name: "1 Peter",
                chapters: 5,
                author: "Peter the apostle",
                location: "“Babylon” (likely Rome)",
                date: "c. AD 62–64",
                synopsis: "Encourages suffering believers with hope, holiness, and the example of Christ."
            },
            "2 Peter": {
                name: "2 Peter",
                chapters: 3,
                author: "Peter the apostle",
                location: "Likely Rome",
                date: "c. AD 64–67",
                synopsis: "Warns against false teachers and reminds believers of Christ’s promised return."
            },
            "1 John": {
                name: "1 John",
                chapters: 5,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 85–95",
                synopsis: "Assures believers of eternal life and emphasizes love, obedience, and true doctrine."
            },
            "2 John": {
                name: "2 John",
                chapters: 1,
                author: "John the apostle",
                location: "Likely Ephesus",
                date: "c. AD 85–95",
                synopsis: "A brief letter urging love and truth while rejecting false teachers."
            },
            "3 John": {
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

    onunload() {
        if (this.activePopover && this.activePopover.parentNode) {
            this.activePopover.parentNode.removeChild(this.activePopover);
        }
        console.log('STEP Bible Linker unloaded.');
    }
}