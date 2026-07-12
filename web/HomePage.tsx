import * as preact from "preact";
import { observable } from "mobx";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { URLParam } from "sliftutils/render-utils/URLParam";
import { LocalStorageParamStr } from "sliftutils/render-utils/LocalStorageParam";
import { acquireDirectory, tryGetDirectory, hasStoredDirectory, forgetDirectory } from "./fsAccess";
import { fsAccessRepoFS } from "../git/fsAccessFS";
import { GitObjectStore } from "../git/objectStore";
import { readIndex } from "../git/gitIndex";
import { getPendingChanges, getFileDiff, DiffLine, ChangeStatus } from "../git/gitStatus";
import { buildStamp } from "./buildStamp";

const pathURL = new URLParam("path", "");
const filterURL = new URLParam("filter", "");
const contextURL = new URLParam("context", 8);

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const fontSizeParam = new LocalStorageParamStr("fdiff-font-size", "12");
const lineHeightParam = new LocalStorageParamStr("fdiff-line-height", "1.25");
const fontFamilyParam = new LocalStorageParamStr("fdiff-font-family", mono);
const sidebarWidthParam = new LocalStorageParamStr("fdiff-sidebar-width", "260");
const linkFilesParam = new LocalStorageParamStr("fdiff-link-files", "1");
const collapseKeyParam = new LocalStorageParamStr("fdiff-key-collapse", "[");
const expandKeyParam = new LocalStorageParamStr("fdiff-key-expand", "]");

function escapeRegex(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A 2x2 grid favicon in the app's added/deleted/context colors.
const faviconSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'>"
    + "<rect x='0' y='0' width='1' height='1' fill='hsl(140,50%,45%)'/>"
    + "<rect x='1' y='0' width='1' height='1' fill='hsl(0,0%,45%)'/>"
    + "<rect x='0' y='1' width='1' height='1' fill='hsl(0,0%,45%)'/>"
    + "<rect x='1' y='1' width='1' height='1' fill='hsl(0,60%,50%)'/>"
    + "</svg>";
function ensureFavicon() {
    let link = document.querySelector("link[rel='icon']") as HTMLLinkElement;
    if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = "data:image/svg+xml," + encodeURIComponent(faviconSvg);
}

// Collapsed sections persist in the URL, keyed by a hash of path + diff content — so when a file's
// contents change its key changes and it expands again.
const collapsedURL = new URLParam("collapsed", "");
function collapsedKeys(): Set<string> {
    return new Set(collapsedURL.value.split(".").filter(Boolean));
}
function writeCollapsed(keys: Set<string>) {
    collapsedURL.value = [...keys].join(".");
}
function shortHash(text: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

type RenderedDiff = { path: string; status: ChangeStatus; lines?: DiffLine[]; key: string };
type NumberedLine = { kind: DiffLine["kind"]; text: string; newNo?: number };
type BodyItem = { line: NumberedLine } | { gap: NumberedLine[]; id: string };

function fileId(index: number) {
    return "file-" + index;
}

// Renders an epoch-ms timestamp in the viewer's local time zone (UTC is not useful to read).
function formatBuildTime(ms: number) {
    let d = new Date(ms);
    let date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    let time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
    return date + " " + time;
}

function countChanges(diff: RenderedDiff) {
    let added = 0;
    let removed = 0;
    for (let line of diff.lines || []) {
        if (line.kind === "+") added++;
        if (line.kind === "-") removed++;
    }
    return { added, removed };
}

type FileEntry = { diff: RenderedDiff; index: number };
type TreeNode = { name: string; path: string; folders: Map<string, TreeNode>; files: FileEntry[]; added: number; removed: number };

function newTreeNode(name: string, path: string): TreeNode {
    return { name, path, folders: new Map(), files: [], added: 0, removed: 0 };
}
function aggregateTree(node: TreeNode) {
    let added = 0;
    let removed = 0;
    for (let f of node.files) {
        let c = countChanges(f.diff);
        added += c.added;
        removed += c.removed;
    }
    for (let child of node.folders.values()) {
        aggregateTree(child);
        added += child.added;
        removed += child.removed;
    }
    node.added = added;
    node.removed = removed;
}
// Groups changed files into a folder tree so the sidebar reads compactly and shows per-folder totals.
function buildTree(items: FileEntry[]): TreeNode {
    let root = newTreeNode("", "");
    for (let item of items) {
        let parts = item.diff.path.split("/");
        parts.pop();
        let node = root;
        for (let seg of parts) {
            let child = node.folders.get(seg);
            if (!child) {
                child = newTreeNode(seg, node.path ? node.path + "/" + seg : seg);
                node.folders.set(seg, child);
            }
            node = child;
        }
        node.files.push(item);
    }
    aggregateTree(root);
    return root;
}
// Files in the exact top-to-bottom order the sidebar tree shows them (folders sorted first, then files).
function flattenTree(node: TreeNode): FileEntry[] {
    let out: FileEntry[] = [];
    for (let name of [...node.folders.keys()].sort()) {
        let child = node.folders.get(name);
        if (child) out.push(...flattenTree(child));
    }
    for (let f of node.files.slice().sort((a, b) => a.diff.path < b.diff.path && -1 || 1)) out.push(f);
    return out;
}

// Assigns new-file line numbers (removed lines get none) then keeps only the lines within `context`
// of a change, replacing longer unchanged runs with a gap marker.
function bodyItems(lines: DiffLine[], context: number): BodyItem[] {
    let newNo = 1;
    let numbered: NumberedLine[] = lines.map(line => {
        if (line.kind === "-") return { kind: line.kind, text: line.text };
        return { kind: line.kind, text: line.text, newNo: newNo++ };
    });

    let n = numbered.length;
    let keep = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        if (numbered[i].kind === " ") continue;
        for (let j = Math.max(0, i - context); j <= Math.min(n - 1, i + context); j++) keep[j] = true;
    }

    let items: BodyItem[] = [];
    let i = 0;
    while (i < n) {
        if (keep[i]) {
            items.push({ line: numbered[i] });
            i++;
            continue;
        }
        let start = i;
        let hidden: NumberedLine[] = [];
        while (i < n && !keep[i]) {
            hidden.push(numbered[i]);
            i++;
        }
        items.push({ gap: hidden, id: String(start) });
    }
    return items;
}

@observer
export class HomePage extends preact.Component {
    synced = observable({
        loading: false,
        loaded: false,
        hasStored: false,
        error: "",
        diffs: [] as RenderedDiff[],
        lastLoadMs: 0,
        showSettings: false,
        expandedGaps: {} as Record<string, boolean>,
        visible: [] as number[],
    });

    // The file section the mouse is currently over — target of the [ and ] hotkeys. Not observable;
    // only read inside the key handler.
    hovered: string | undefined = undefined;

    onKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        let isCollapse = e.key === collapseKeyParam.value;
        let isExpand = e.key === expandKeyParam.value;
        if (!isCollapse && !isExpand) return;
        if (!this.hovered) return;
        e.preventDefault();
        let keys = collapsedKeys();
        if (isCollapse) keys.add(this.hovered);
        else keys.delete(this.hovered);
        writeCollapsed(keys);
    };

    captureKey(e: KeyboardEvent, param: LocalStorageParamStr) {
        if (e.key === "Tab") return;
        e.preventDefault();
        if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
        param.value = e.key;
    }

    sidebarEl: HTMLElement | undefined = undefined;

    // Rebuilt each render: maps a changed file's basename to the first diff index with that name, plus
    // a regex that matches those names in diff text (bounded so they aren't part of a larger symbol).
    nameIndex = new Map<string, number>();
    linkRegex: RegExp | undefined = undefined;

    buildLinkIndex() {
        let map = new Map<string, number>();
        // Iterate in reverse so the earliest occurrence wins when names collide.
        for (let i = this.synced.diffs.length - 1; i >= 0; i--) {
            let parts = this.synced.diffs[i].path.split("/");
            let base = parts[parts.length - 1];
            map.set(base, i);
            // Also match without the extension, so imports like "./scheduledShutdown" resolve.
            let noExt = base.replace(/\.[^.]+$/, "");
            if (noExt && noExt !== base) map.set(noExt, i);
        }
        this.nameIndex = map;
        if (linkFilesParam.value === "0" || map.size === 0) {
            this.linkRegex = undefined;
            return;
        }
        let names = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
        this.linkRegex = new RegExp("(?<![A-Za-z0-9_])(?:" + names.join("|") + ")(?![A-Za-z0-9_])", "g");
    }

    linkifyText(text: string): preact.ComponentChild[] {
        let regex = this.linkRegex;
        if (!regex) return [text];
        let out: preact.ComponentChild[] = [];
        let last = 0;
        regex.lastIndex = 0;
        let match = regex.exec(text);
        while (match) {
            if (match.index > last) out.push(text.slice(last, match.index));
            let name = match[0];
            let index = this.nameIndex.get(name);
            out.push(
                <span
                    key={match.index}
                    className={css.button.textDecoration("underline").hslcolor(210, 85, 74)}
                    onClick={() => window.location.hash = "#" + fileId(index || 0)}
                >
                    {name}
                </span>
            );
            last = match.index + name.length;
            match = regex.exec(text);
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
    }

    startResize = (e: MouseEvent) => {
        e.preventDefault();
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", this.onResize);
        document.addEventListener("mouseup", this.stopResize);
    };
    onResize = (e: MouseEvent) => {
        if (!this.sidebarEl) return;
        let left = this.sidebarEl.getBoundingClientRect().left;
        // Lower bound only; the upper bound (80vw) is enforced in CSS so it tracks the viewport.
        sidebarWidthParam.value = String(Math.round(Math.max(120, e.clientX - left)));
    };
    stopResize = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", this.onResize);
        document.removeEventListener("mouseup", this.stopResize);
    };

    // Scroll-spy: which file sections are currently within the diff viewport (for sidebar highlighting).
    mainEl: HTMLElement | undefined = undefined;
    scrollRaf = 0;
    lastVisibleKey = "";

    onMainScroll = () => {
        if (this.scrollRaf) return;
        this.scrollRaf = requestAnimationFrame(() => {
            this.scrollRaf = 0;
            this.updateVisible();
        });
    };
    updateVisible() {
        let main = this.mainEl;
        if (!main) return;
        let mainRect = main.getBoundingClientRect();
        let visible: number[] = [];
        main.querySelectorAll("[id^='file-']").forEach(el => {
            let rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.bottom > mainRect.top && rect.top < mainRect.bottom) {
                visible.push(Number((el as HTMLElement).id.slice(5)));
            }
        });
        let key = visible.slice().sort((a, b) => a - b).join(",");
        if (key !== this.lastVisibleKey) {
            this.lastVisibleKey = key;
            this.synced.visible = visible;
        }
    }

    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("mousemove", this.onResize);
        document.removeEventListener("mouseup", this.stopResize);
    }

    async componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
        ensureFavicon();
        let path = pathURL.value;
        if (!path) return;
        this.synced.hasStored = await hasStoredDirectory(path);
        let handle = await tryGetDirectory({ path, mode: "read" });
        if (handle) await this.load(handle);
    }

    async grant() {
        let path = pathURL.value;
        if (!path) return;
        this.synced.error = "";
        try {
            let handle = await acquireDirectory({ path, mode: "read" });
            this.synced.hasStored = true;
            await this.load(handle);
        } catch (e) {
            this.synced.error = String(e);
        }
    }

    async reset() {
        await forgetDirectory(pathURL.value);
        this.synced.hasStored = false;
        this.synced.loaded = false;
        this.synced.diffs = [];
        this.synced.error = "";
    }

    async load(handle: FileSystemDirectoryHandle) {
        this.synced.error = "";
        this.synced.loading = true;
        this.synced.expandedGaps = {};
        let start = performance.now();
        try {
            let fs = fsAccessRepoFS(handle);
            let store = new GitObjectStore(fs);
            let changes = await getPendingChanges(fs);
            let index = await readIndex(fs);
            let byPath = new Map(index.map(e => [e.path, e]));
            let diffs = await Promise.all(changes.map(async change => {
                let entry = byPath.get(change.path);
                let lines = await getFileDiff({ fs, store, path: change.path, stagedSha: entry && entry.sha || undefined });
                let key = shortHash(change.path + " " + lines.map(l => l.kind + l.text).join("\n"));
                return { path: change.path, status: change.status, lines, key };
            }));
            this.synced.diffs = diffs;
            // Drop collapsed keys that no longer match a current file (changed or gone) so it re-expands.
            let currentKeys = new Set(diffs.map(d => d.key));
            writeCollapsed(new Set([...collapsedKeys()].filter(k => currentKeys.has(k))));
            this.synced.loaded = true;
        } catch (e) {
            this.synced.error = String(e && ((e as Error).stack || (e as Error).message) || e);
        } finally {
            this.synced.lastLoadMs = Math.round(performance.now() - start);
            this.synced.loading = false;
            requestAnimationFrame(() => this.updateVisible());
        }
    }

    collapseAll() {
        writeCollapsed(new Set(this.synced.diffs.map(d => d.key)));
    }
    expandAll() {
        writeCollapsed(new Set());
    }
    toggleCollapse(diff: RenderedDiff) {
        let keys = collapsedKeys();
        if (keys.has(diff.key)) keys.delete(diff.key);
        else keys.add(diff.key);
        writeCollapsed(keys);
    }
    collapse(diff: RenderedDiff) {
        let keys = collapsedKeys();
        keys.add(diff.key);
        writeCollapsed(keys);
    }

    visibleDiffs() {
        let filter = filterURL.value.toLowerCase();
        return this.synced.diffs
            .map((diff, index) => ({ diff, index }))
            .filter(x => x.diff.path.toLowerCase().includes(filter));
    }

    renderCounts(added: number, removed: number) {
        return (
            <span className={css.hbox(6).fontFamily(mono).fontSize(11)}>
                <span className={css.hslcolor(140, 55, 62)}>+{added}</span>
                <span className={css.hslcolor(0, 62, 66)}>-{removed}</span>
            </span>
        );
    }

    renderBodyItem(diff: RenderedDiff, item: BodyItem, i: number) {
        if ("line" in item) return this.renderLine(item.line, "l" + i);
        let gapKey = diff.key + ":" + item.id;
        let expanded = this.synced.expandedGaps[gapKey];
        let indicator = (
            <div
                key={"gap" + i}
                className={css.button.paddingLeft(20).paddingTop(3).paddingBottom(3).fontSize(11)
                    + (expanded && css.hsl(210, 45, 16).hslcolor(210, 85, 74) || css.hsl(0, 0, 12).hslcolor(0, 0, 48))}
                onClick={() => this.synced.expandedGaps[gapKey] = !expanded}
            >
                {expanded && "▾" || "⋯"} {item.gap.length} unchanged — click to {expanded && "collapse" || "expand"}
            </div>
        );
        if (!expanded) return indicator;
        return [indicator, ...item.gap.map((line, j) => this.renderLine(line, "g" + i + "-" + j))];
    }

    renderLine(line: NumberedLine, key: string | number) {
        return (
            <div
                key={key}
                className={css.hbox(0).width("100%").paddingTop(1).paddingBottom(1)
                    + (line.kind === "+" && css.hsl(140, 45, 11))
                    + (line.kind === "-" && css.hsl(0, 45, 12))
                }
            >
                <span className={css.width(52).flexShrink0.textAlign("right").paddingRight(10).hslcolor(0, 0, 34).userSelect("none")}>
                    {line.newNo || ""}
                </span>
                <span className={css.width(14).flexShrink0.textAlign("center").userSelect("none")
                    + (line.kind === "+" && css.hslcolor(140, 55, 62))
                    + (line.kind === "-" && css.hslcolor(0, 62, 66))
                }>
                    {line.kind === " " && " " || line.kind}
                </span>
                <span className={css.flexGrow(1).minWidth(0).paddingRight(14).whiteSpace("pre-wrap").wordBreak("break-word")
                    + (line.kind === "+" && css.hslcolor(140, 50, 78))
                    + (line.kind === "-" && css.hslcolor(0, 55, 80))
                    + (line.kind === " " && css.hslcolor(0, 0, 78))
                }>
                    {this.linkifyText(line.text)}
                </span>
            </div>
        );
    }

    renderFile(diff: RenderedDiff, index: number) {
        let collapsed = collapsedKeys().has(diff.key);
        let counts = countChanges(diff);
        return (
            <div key={diff.path} id={fileId(index)} className={css.marginBottom(2)}
                onMouseEnter={() => this.hovered = diff.key}
                onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
                onAuxClick={e => { if (e.button === 1) { e.preventDefault(); this.collapse(diff); } }}
            >
                <div
                    className={css.button.hbox(8).alignItems("center").paddingLeft(8).paddingRight(10).paddingTop(4).paddingBottom(4)
                        .position("sticky").top(0).zIndex(1)
                        + (collapsed && css.hsl(0, 0, 15).borderBottom("1px solid hsl(0, 0%, 22%)"))
                        + (!collapsed && css.hsl(212, 48, 26).borderBottom("1px solid hsl(212, 45%, 40%)"))
                    }
                    onClick={() => this.toggleCollapse(diff)}
                >
                    <span className={css.width(10).hslcolor(0, 0, 55)}>{collapsed && "▶" || "▼"}</span>
                    {this.renderCounts(counts.added, counts.removed)}
                    <span className={css.hslcolor(diff.status === "deleted" && 0 || 0, 0, 55).width(58).fontSize(11)}>
                        {diff.status}
                    </span>
                    <span className={css.fontFamily(mono).fontSize(12).wordBreak("break-all")}>{diff.path}</span>
                </div>
                {!collapsed && diff.lines && (
                    <div className={css.fontFamily(fontFamilyParam.value || mono).fontSize(Number(fontSizeParam.value) || 12).lineHeight(Number(lineHeightParam.value) || 1.25).hsl(0, 0, 9)}>
                        {bodyItems(diff.lines, Number(contextURL.value) || 0).map((item, i) => this.renderBodyItem(diff, item, i))}
                    </div>
                )}
            </div>
        );
    }

    renderControls(controls: boolean) {
        let inputStyle = css.hsl(0, 0, 16).hslcolor(0, 0, 92).border("1px solid hsl(0,0%,26%)").borderRadius(4)
            .paddingLeft(8).paddingRight(8).paddingTop(4).paddingBottom(4).fontSize(12);
        return (
            <div className={css.hbox(10).alignItems("center")}>
                {controls && (
                    <input
                        className={inputStyle + css.width(200)}
                        placeholder="Filter files…"
                        value={filterURL.value}
                        onInput={e => filterURL.value = e.currentTarget.value}
                    />
                )}
                {controls && (
                    <label className={css.hbox(6).alignItems("center").hslcolor(0, 0, 60).fontSize(12)}>
                        Context
                        <input
                            className={inputStyle + css.width(54)}
                            type="number"
                            min="0"
                            value={String(contextURL.value)}
                            onInput={e => contextURL.value = Math.max(0, parseInt(e.currentTarget.value) || 0)}
                        />
                    </label>
                )}
                {controls && <button onClick={() => this.expandAll()}>Expand all</button>}
                {controls && <button onClick={() => this.collapseAll()}>Collapse all</button>}
                {this.synced.loaded && (
                    <button onClick={() => this.grant()} disabled={this.synced.loading}>
                        {this.synced.loading && "Reloading…" || "Reload"}
                    </button>
                )}
            </div>
        );
    }

    renderTopBar(path: string, controls: boolean) {
        let total = this.synced.diffs.reduce((acc, d) => {
            let c = countChanges(d);
            acc.added += c.added;
            acc.removed += c.removed;
            return acc;
        }, { added: 0, removed: 0 });
        return (
            <div className={css.hbox(14).alignItems("center").flexShrink0.paddingLeft(14).paddingRight(14).paddingTop(8).paddingBottom(8)
                .hsl(0, 0, 11).borderBottom("1px solid hsl(0, 0%, 20%)")}>
                <span className={css.fontSize(14)}>fdiff</span>
                <span className={css.hslcolor(0, 0, 58).fontFamily(mono).fontSize(12).ellipsis.maxWidth(300)}>{path}</span>
                {controls && (
                    <span className={css.hbox(8).alignItems("center").hslcolor(0, 0, 66).fontSize(12)}>
                        <span>{this.synced.diffs.length} files</span>
                        {this.renderCounts(total.added, total.removed)}
                        {this.synced.lastLoadMs > 0 && <span className={css.hslcolor(0, 0, 50)}>· {this.synced.lastLoadMs} ms</span>}
                    </span>
                )}
                {this.renderControls(controls)}
                <div className={css.hbox(12).alignItems("center").marginLeft("auto")}>
                    <span className={css.hslcolor(0, 0, 42).fontFamily(mono).fontSize(11)} title={new Date(buildStamp).toString()}>
                        built {formatBuildTime(buildStamp)}
                    </span>
                    <button onClick={() => this.synced.showSettings = true}>⚙ Settings</button>
                    {this.synced.hasStored && <button onClick={() => this.reset()}>Reset access</button>}
                </div>
            </div>
        );
    }

    renderTreeNode(node: TreeNode, depth: number): preact.ComponentChild[] {
        let rows: preact.ComponentChild[] = [];
        let indent = 10 + depth * 14;
        for (let name of [...node.folders.keys()].sort()) {
            let child = node.folders.get(name);
            if (!child) continue;
            rows.push(
                <div key={"d:" + child.path}
                    className={css.hbox(6).alignItems("center").justifyContent("space-between").paddingRight(8).paddingTop(2).paddingBottom(2).paddingLeft(indent)}>
                    <span className={css.flexGrow(1).minWidth(0).wordBreak("break-all").fontFamily(mono).fontSize(12).hslcolor(0, 0, 58)}>{child.name}/</span>
                    <span className={css.flexShrink0}>{this.renderCounts(child.added, child.removed)}</span>
                </div>
            );
            rows.push(...this.renderTreeNode(child, depth + 1));
        }
        let files = node.files.slice().sort((a, b) => a.diff.path < b.diff.path && -1 || 1);
        for (let f of files) {
            let counts = countChanges(f.diff);
            let parts = f.diff.path.split("/");
            // Expanded files get a faint blue; those also currently on screen get a stronger blue.
            let expanded = !collapsedKeys().has(f.diff.key);
            let onScreen = expanded && this.synced.visible.indexOf(f.index) >= 0;
            rows.push(
                <div key={"f:" + f.index}
                    className={css.button.hbox(6).alignItems("center").justifyContent("space-between").paddingRight(8).paddingTop(2).paddingBottom(2).paddingLeft(indent)
                        + (onScreen && css.hsl(212, 48, 28))
                        + (!onScreen && expanded && css.hsla(212, 60, 55, 0.14))}
                    onClick={() => window.location.hash = "#" + fileId(f.index)}>
                    <span className={css.flexGrow(1).minWidth(0).wordBreak("break-all").fontFamily(mono).fontSize(12).hslcolor(0, 0, 84).textDecoration("underline")}>
                        {parts[parts.length - 1]}
                    </span>
                    <span className={css.flexShrink0}>{this.renderCounts(counts.added, counts.removed)}</span>
                </div>
            );
        }
        return rows;
    }

    renderSettings() {
        if (!this.synced.showSettings) return undefined;
        let inputStyle = css.hsl(0, 0, 16).hslcolor(0, 0, 92).border("1px solid hsl(0,0%,26%)").borderRadius(4)
            .paddingLeft(8).paddingRight(8).paddingTop(4).paddingBottom(4).fontSize(12);
        let row = (label: string, input: preact.ComponentChild) => (
            <label className={css.hbox(10).alignItems("center").justifyContent("space-between")}>
                <span className={css.hslcolor(0, 0, 72)}>{label}</span>
                {input}
            </label>
        );
        return (
            <div
                className={css.position("fixed").top(0).left(0).width("100vw").height("100vh").hsla(0, 0, 0, 0.6)
                    .hbox(0).alignItems("center").justifyContent("center").zIndex(50)}
                onClick={() => this.synced.showSettings = false}
            >
                <div
                    className={css.vbox(14).width(440).maxWidth("92vw").pad2(18).hsl(0, 0, 12).border("1px solid hsl(0,0%,24%)").borderRadius(8)}
                    onClick={e => e.stopPropagation()}
                >
                    <div className={css.hbox(10).alignItems("center").justifyContent("space-between")}>
                        <span className={css.fontSize(15)}>Settings</span>
                        <button onClick={() => this.synced.showSettings = false}>Close</button>
                    </div>
                    {row("Font size (px)",
                        <input className={inputStyle + css.width(100)} type="number" min="8" max="40"
                            value={fontSizeParam.value} onInput={e => fontSizeParam.value = e.currentTarget.value} />)}
                    {row("Line height",
                        <input className={inputStyle + css.width(100)} type="number" step="0.05" min="1" max="3"
                            value={lineHeightParam.value} onInput={e => lineHeightParam.value = e.currentTarget.value} />)}
                    {row("Font family",
                        <input className={inputStyle + css.width(240)} type="text"
                            value={fontFamilyParam.value} onInput={e => fontFamilyParam.value = e.currentTarget.value} />)}
                    {row("Link file names in diffs",
                        <input type="checkbox" checked={linkFilesParam.value !== "0"}
                            onChange={e => linkFilesParam.value = e.currentTarget.checked && "1" || "0"} />)}
                    <div className={css.hslcolor(0, 0, 50).fontSize(11)}>
                        Hover a file and press a key to collapse/expand it. Click a box and press the key to rebind.
                    </div>
                    {row("Collapse key",
                        <input readOnly className={inputStyle + css.width(100).textAlign("center")}
                            value={collapseKeyParam.value} placeholder="press a key"
                            onKeyDown={e => this.captureKey(e, collapseKeyParam)} />)}
                    {row("Expand key",
                        <input readOnly className={inputStyle + css.width(100).textAlign("center")}
                            value={expandKeyParam.value} placeholder="press a key"
                            onKeyDown={e => this.captureKey(e, expandKeyParam)} />)}
                    <div className={css.hbox(8).alignItems("center").justifyContent("space-between")}>
                        <span className={css.hslcolor(0, 0, 50).fontSize(11)}>Saved in this browser; applies live.</span>
                        <button onClick={() => { fontSizeParam.value = ""; lineHeightParam.value = ""; fontFamilyParam.value = ""; }}>
                            Reset to defaults
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    renderPrompt(path: string) {
        return (
            <div className={css.vbox(12).pad2(20).maxWidth(680)}>
                <div>fdiff needs your permission to read this repository from disk:</div>
                <div className={css.paddingLeft(10).paddingRight(10).paddingTop(8).paddingBottom(8).hsl(0, 0, 15).borderRadius(4).fontFamily(mono)}>
                    {path}
                </div>
                <div className={css.hslcolor(0, 0, 58)}>
                    Click below, then select that exact folder in the picker. The grant is remembered for this path.
                </div>
                <div className={css.hbox(8)}>
                    <button onClick={() => this.grant()}>Provide access to {path}</button>
                    {this.synced.hasStored && <button onClick={() => this.reset()}>Reset saved access</button>}
                </div>
            </div>
        );
    }

    render() {
        let path = pathURL.value;
        let lastPart = path.split(/[\\/]/).filter(Boolean).pop();
        document.title = lastPart && (lastPart + " - fdiff") || "fdiff";

        if (!path) {
            return (
                <div className={css.fillBoth.vbox(12).pad2(20).hsl(0, 0, 7).hslcolor(0, 0, 92)}>
                    <div className={css.fontSize(14)}>fdiff</div>
                    <div className={css.hslcolor(0, 0, 58)}>
                        Open with a repository path, e.g. <span className={css.fontFamily(mono)}>?path=D:\repos\your-repo</span>
                    </div>
                </div>
            );
        }

        if (!this.synced.loaded) {
            return (
                <div className={css.size("100vw", "100vh").vbox(0).alignItems("stretch").hsl(0, 0, 7).hslcolor(0, 0, 92).overflowHidden}>
                    {this.renderTopBar(path, false)}
                    {this.synced.loading && <div className={css.pad2(20)}>Reading git changes…</div>}
                    {this.synced.error && <div className={css.pad2(20).hslcolor(0, 70, 66).whiteSpace("pre-wrap").fontFamily(mono).fontSize(12)}>{this.synced.error}</div>}
                    {!this.synced.loading && this.renderPrompt(path)}
                    {this.renderSettings()}
                </div>
            );
        }

        let visible = this.visibleDiffs();
        this.buildLinkIndex();
        // Cap at 80vw in CSS so an oversized stored width can never break the layout.
        let sidebarWidth = "min(" + (Number(sidebarWidthParam.value) || 260) + "px, 80vw)";
        let tree = buildTree(visible);
        let ordered = flattenTree(tree);
        return (
            <div className={css.size("100vw", "100vh").vbox(0).alignItems("stretch").hsl(0, 0, 7).hslcolor(0, 0, 92).overflowHidden}>
                <style>{`@keyframes fdiffBar { 0% { transform: translateX(-100%); } 100% { transform: translateX(500%); } }`}</style>
                {this.renderTopBar(path, true)}
                <div className={css.height(2).width("100%").flexShrink0.overflowHidden
                    + (this.synced.loading && css.hsl(0, 0, 15) || css.hsl(0, 0, 7))}>
                    {this.synced.loading && <div className={css.height(2).width("20%").hsl(210, 80, 58).animation("fdiffBar 1.1s ease-in-out infinite")} />}
                </div>
                <div className={css.hbox(0).alignItems("stretch").flexGrow(1).minHeight(0).overflowHidden}>
                    <div
                        ref={el => this.sidebarEl = el || undefined}
                        className={css.width(sidebarWidth).flexShrink0.overflowYAuto.hsl(0, 0, 9).paddingTop(6).paddingBottom(6)}
                    >
                        {this.renderTreeNode(tree, 0)}
                        {!visible.length && <div className={css.pad2(12).hslcolor(0, 0, 50)}>No matches.</div>}
                    </div>
                    <div
                        className={css.width(10).flexShrink0.hsl(0, 0, 14).hslhover(0, 0, 26).cursor("col-resize")}
                        onMouseDown={this.startResize}
                    />
                    <div
                        ref={el => this.mainEl = el || undefined}
                        onScroll={this.onMainScroll}
                        className={css.flexGrow(1).minWidth(0).overflowAuto.paddingBottom(200)}
                    >
                        {this.synced.error && <div className={css.pad2(16).hslcolor(0, 70, 66).whiteSpace("pre-wrap").fontFamily(mono).fontSize(12)}>{this.synced.error}</div>}
                        {!this.synced.diffs.length && <div className={css.pad2(16)}>No pending changes.</div>}
                        {this.synced.diffs.length && !visible.length && <div className={css.pad2(16).hslcolor(0, 0, 55)}>No files match the filter.</div>}
                        {ordered.map(x => this.renderFile(x.diff, x.index))}
                    </div>
                </div>
                {this.renderSettings()}
            </div>
        );
    }
}
