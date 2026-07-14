import * as preact from "preact";
import { observable } from "mobx";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { formatDateTime, formatDate } from "socket-function/src/formatting/format";
import { GitObjectStore } from "../git/objectStore";
import { getFileHistory, alignLines, FileVersion } from "../git/fileHistory";

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// A stable-ish color per commit for the blame gutter, so runs from the same commit read as a group.
function commitColor(sha: string) {
    let h = 0;
    for (let i = 0; i < sha.length; i++) h = (h * 31 + sha.charCodeAt(i)) >>> 0;
    return css.hslcolor(h % 360, 45, 62);
}

@observer
export class HistoryView extends preact.Component<{ store: GitObjectStore; path: string; onClose: () => void }> {
    synced = observable({
        loading: true,
        error: "",
        versions: [] as FileVersion[],
        versionIndex: 0,
        // The selected line is anchored to a specific version+line, then mapped into whatever version is shown.
        anchorVersion: undefined as number | undefined,
        anchorLine: undefined as number | undefined,
    });

    // Per adjacent-version line maps and blame, computed once after load. Not observable.
    forward: number[][] = [];   // forward[i][lineInV(i)] = line in V(i+1), or -1
    backward: number[][] = [];  // backward[i][lineInV(i+1)] = line in V(i), or -1
    blame: number[][] = [];     // blame[v][line] = version index that introduced the line
    scrollSelectedNext = false;

    async componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
        try {
            let versions = await getFileHistory(this.props.store, this.props.path);
            if (!versions.length) {
                this.synced.error = "No history found for this file.";
                this.synced.loading = false;
                return;
            }
            this.computeMaps(versions);
            this.synced.versions = versions;
            this.synced.versionIndex = versions.length - 1;
            this.synced.loading = false;
        } catch (e) {
            this.synced.error = String(e && ((e as Error).stack || (e as Error).message) || e);
            this.synced.loading = false;
        }
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }

    computeMaps(versions: FileVersion[]) {
        this.forward = [];
        this.backward = [];
        for (let i = 0; i < versions.length - 1; i++) {
            let curToPrev = alignLines(versions[i].lines, versions[i + 1].lines); // len = V(i+1)
            this.backward[i] = curToPrev;
            let toNext = new Array(versions[i].lines.length).fill(-1);
            for (let j = 0; j < curToPrev.length; j++) {
                if (curToPrev[j] >= 0) toNext[curToPrev[j]] = j;
            }
            this.forward[i] = toNext;
        }
        // Blame: a line inherits its origin from the previous version if unchanged, else this version.
        this.blame = [];
        this.blame[0] = versions[0].lines.map(() => 0);
        for (let i = 1; i < versions.length; i++) {
            let back = this.backward[i - 1];
            this.blame[i] = versions[i].lines.map((_, j) => {
                let prev = back[j];
                if (prev >= 0) return this.blame[i - 1][prev];
                return i;
            });
        }
    }

    // Maps a line from one version to another via the alignment chain; -1 if it doesn't exist there.
    mapLine(fromV: number, line: number, toV: number) {
        let v = fromV;
        let idx = line;
        while (v < toV && idx >= 0) { idx = this.forward[v][idx]; v++; }
        while (v > toV && idx >= 0) { idx = this.backward[v - 1][idx]; v--; }
        return idx;
    }
    selectedLine() {
        if (this.synced.anchorVersion === undefined || this.synced.anchorLine === undefined) return -1;
        return this.mapLine(this.synced.anchorVersion, this.synced.anchorLine, this.synced.versionIndex);
    }

    selectVersion(i: number) {
        let n = this.synced.versions.length;
        this.synced.versionIndex = Math.max(0, Math.min(n - 1, i));
        this.scrollSelectedNext = true;
    }
    selectLine(line: number) {
        this.synced.anchorVersion = this.synced.versionIndex;
        this.synced.anchorLine = line;
    }
    moveLine(delta: number) {
        let cur = this.selectedLine();
        let lines = this.synced.versions[this.synced.versionIndex].lines;
        let next = cur < 0 ? 0 : Math.max(0, Math.min(lines.length - 1, cur + delta));
        this.selectLine(next);
        this.scrollSelectedNext = true;
    }

    onKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.key === "ArrowUp") { e.preventDefault(); this.moveLine(-1); }
        else if (e.key === "ArrowDown") { e.preventDefault(); this.moveLine(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); this.selectVersion(this.synced.versionIndex - 1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); this.selectVersion(this.synced.versionIndex + 1); }
    };

    async copyRaw() {
        let content = this.synced.versions[this.synced.versionIndex].lines.join("\n");
        if (navigator.clipboard) await navigator.clipboard.writeText(content);
    }

    componentDidUpdate() {
        if (this.scrollSelectedNext) {
            this.scrollSelectedNext = false;
            let el = document.querySelector("[data-selected-line='1']");
            if (el) el.scrollIntoView({ block: "nearest" });
        }
    }

    versionTitle(v: FileVersion) {
        return `${formatDateTime(v.time)}  ${v.shortSha}  ${v.message}  (${v.author})`;
    }

    renderTimeline() {
        let versions = this.synced.versions;
        let step = Math.max(1, Math.ceil(versions.length / 9));
        let anchorSet = this.synced.anchorVersion !== undefined;
        return (
            <div className={css.hbox(0).alignItems("stretch").overflowXAuto.paddingLeft(10).paddingRight(10).hsl(0, 0, 10).borderBottom("1px solid hsl(0,0%,20%)")}>
                {versions.map((v, i) => {
                    let selected = i === this.synced.versionIndex;
                    let hasLine = anchorSet && this.mapLine(this.synced.anchorVersion || 0, this.synced.anchorLine || 0, i) >= 0;
                    let showLabel = i === 0 || i === versions.length - 1 || i % step === 0;
                    let top = showLabel && i % 2 === 0;
                    let bottom = showLabel && i % 2 === 1;
                    return (
                        <div key={v.commitSha} title={this.versionTitle(v)}
                            className={css.button.vbox(0).alignItems("center").justifyContent("space-between").minWidth(26).paddingTop(3).paddingBottom(3)}
                            onClick={() => this.selectVersion(i)}>
                            <div className={css.height(14).fontSize(9).hslcolor(0, 0, 55).whiteSpace("nowrap")}>{top && formatDate(v.time) || ""}</div>
                            <div className={css.size(13, 13).borderRadius(7).flexShrink0
                                + (selected && css.hsl(210, 85, 60).border("2px solid hsl(0,0%,95%)"))
                                + (!selected && hasLine && css.hsl(210, 70, 52))
                                + (!selected && !hasLine && css.hsl(0, 0, 40).border("1px solid hsl(0,0%,55%)"))} />
                            <div className={css.height(14).fontSize(9).hslcolor(0, 0, 55).whiteSpace("nowrap")}>{bottom && formatDate(v.time) || ""}</div>
                        </div>
                    );
                })}
            </div>
        );
    }

    renderContent() {
        let v = this.synced.versions[this.synced.versionIndex];
        let sel = this.selectedLine();
        let versions = this.synced.versions;
        return (
            <div className={css.fillBoth.overflowAuto.fontFamily(mono).fontSize(12).lineHeight(1.4).paddingBottom(200)}>
                {v.lines.map((text, j) => {
                    let origin = versions[this.blame[this.synced.versionIndex][j]];
                    let isSel = j === sel;
                    return (
                        <div key={j} data-selected-line={isSel && "1" || undefined}
                            className={css.hbox(0).width("100%").paddingTop(1).paddingBottom(1)
                                + (isSel && css.hsl(210, 55, 22))}
                            onClick={() => this.selectLine(j)}>
                            <span title={this.versionTitle(origin)}
                                className={css.width(150).flexShrink0.ellipsis.paddingLeft(8).paddingRight(8).userSelect("none") + commitColor(origin.commitSha)}>
                                {origin.shortSha} {formatDate(origin.time)}
                            </span>
                            <span className={css.width(48).flexShrink0.textAlign("right").paddingRight(10).hslcolor(0, 0, 36).userSelect("none")}>{j + 1}</span>
                            <span className={css.flexGrow(1).minWidth(0).paddingLeft(10).paddingRight(14).whiteSpace("pre-wrap").wordBreak("break-word").hslcolor(0, 0, 82)}>{text}</span>
                        </div>
                    );
                })}
            </div>
        );
    }

    render() {
        if (this.synced.loading) {
            return <div className={css.fillBoth.pad2(20).hsl(0, 0, 7).hslcolor(0, 0, 85)}>Loading history…</div>;
        }
        if (this.synced.error) {
            return (
                <div className={css.fillBoth.vbox(12).pad2(20).hsl(0, 0, 7).hslcolor(0, 0, 85)}>
                    <button onClick={this.props.onClose}>← Back</button>
                    <div className={css.hslcolor(0, 70, 66).whiteSpace("pre-wrap").fontFamily(mono).fontSize(12)}>{this.synced.error}</div>
                </div>
            );
        }
        let v = this.synced.versions[this.synced.versionIndex];
        return (
            <div className={css.size("100vw", "100vh").vbox(0).alignItems("stretch").hsl(0, 0, 7).hslcolor(0, 0, 90).overflowHidden}>
                <div className={css.hbox(12).alignItems("center").flexShrink0.paddingLeft(12).paddingRight(12).paddingTop(8).paddingBottom(8).hsl(0, 0, 11).borderBottom("1px solid hsl(0,0%,20%)")}>
                    <button onClick={this.props.onClose}>← Back</button>
                    <span className={css.fontFamily(mono).fontSize(13)}>{this.props.path}</span>
                    <span className={css.hslcolor(0, 0, 56).fontSize(12).ellipsis.flexGrow(1).minWidth(0)}>
                        {v.shortSha} · {formatDateTime(v.time)} · {v.message}
                    </span>
                    <span className={css.hslcolor(0, 0, 50).fontSize(11)}>{this.synced.versionIndex + 1}/{this.synced.versions.length}</span>
                    <button onClick={() => this.copyRaw()}>Copy raw</button>
                </div>
                {this.renderTimeline()}
                {this.renderContent()}
            </div>
        );
    }
}
