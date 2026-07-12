import { RepoFS, hashBlob } from "./gitCore";
import { readIndex } from "./gitIndex";
import { GitObjectStore } from "./objectStore";
import { listUntracked } from "./untracked";

export type ChangeStatus = "modified" | "deleted" | "added";
export type FileChange = { path: string; status: ChangeStatus };

// Removes CR that immediately precedes LF (CRLF -> LF). On Windows repos with core.autocrlf, git
// stores LF-normalized blobs while the working tree is CRLF, so a byte-for-byte comparison would
// flag every text file as modified. This mirrors git's normalization.
function stripCarriageReturns(bytes: Uint8Array): Uint8Array {
    let out = new Uint8Array(bytes.length);
    let j = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
        out[j++] = bytes[i];
    }
    return out.subarray(0, j);
}

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    let results = new Array<R>(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            let i = next++;
            results[i] = await fn(items[i]);
        }
    }
    let workers: Promise<void>[] = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// Pending changes = tracked files that differ from the index (modified/deleted) plus untracked files
// that aren't gitignored (added) — i.e. what `git status` reports.
//
// Files are checked concurrently, and — like `git status` — a tracked file whose on-disk size and
// mtime match the index is assumed unchanged, so its contents are never read or hashed.
export async function getPendingChanges(fs: RepoFS): Promise<FileChange[]> {
    let entries = await readIndex(fs);
    let results = await mapLimit(entries, 48, async (entry): Promise<FileChange | undefined> => {
        let stat = await fs.stat(entry.path);
        if (!stat) return { path: entry.path, status: "deleted" };
        let indexMtimeMs = entry.mtimeSeconds * 1000 + Math.round(entry.mtimeNanos / 1e6);
        if (stat.size === entry.size && Math.abs(stat.mtimeMs - indexMtimeMs) <= 1) return undefined;

        let working = await fs.readFile(entry.path);
        if (!working) return { path: entry.path, status: "deleted" };
        if (await hashBlob(working) === entry.sha) return undefined;
        // Fall back to a line-ending-normalized comparison so CRLF working trees don't look modified.
        let normalized = stripCarriageReturns(working);
        if (normalized.length !== working.length && await hashBlob(normalized) === entry.sha) return undefined;
        return { path: entry.path, status: "modified" };
    });

    let changes = results.filter((x): x is FileChange => !!x);
    let untracked = await listUntracked(fs, new Set(entries.map(e => e.path)));
    for (let path of untracked) changes.push({ path, status: "added" });
    return changes;
}

export type DiffLine = { kind: " " | "-" | "+"; text: string };

// Longest-common-subsequence line diff. Not fancy, but correct — enough to show what changed.
export function diffLines(oldText: string, newText: string): DiffLine[] {
    let a = oldText.length ? oldText.split("\n") : [];
    let b = newText.length ? newText.split("\n") : [];
    let n = a.length;
    let m = b.length;
    let lcs: number[][] = [];
    for (let i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (a[i] === b[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
            else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    let out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ kind: " ", text: a[i] });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({ kind: "-", text: a[i] });
            i++;
        } else {
            out.push({ kind: "+", text: b[j] });
            j++;
        }
    }
    while (i < n) { out.push({ kind: "-", text: a[i] }); i++; }
    while (j < m) { out.push({ kind: "+", text: b[j] }); j++; }
    return out;
}

// Old (staged) content vs current working-tree content, as a line diff.
export async function getFileDiff(config: {
    fs: RepoFS;
    store: GitObjectStore;
    path: string;
    stagedSha?: string;
}): Promise<DiffLine[]> {
    // Untracked (added) files have no staged blob, so the old side is empty.
    let oldText = "";
    if (config.stagedSha) {
        let oldObj = await config.store.readObject(config.stagedSha);
        oldText = new TextDecoder().decode(oldObj.data).replace(/\r\n/g, "\n");
    }
    let working = await config.fs.readFile(config.path);
    // Normalize CRLF -> LF on both sides so line-ending differences don't show as whole-file diffs.
    let newText = working ? new TextDecoder().decode(working).replace(/\r\n/g, "\n") : "";
    return diffLines(oldText, newText);
}
