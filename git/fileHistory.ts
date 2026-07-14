import { GitObjectStore } from "./objectStore";

// One distinct version of a file: the commit that changed it to this content.
export type FileVersion = {
    commitSha: string;
    shortSha: string;
    message: string;
    author: string;
    time: number;      // committer time, ms
    blobSha: string;
    lines: string[];
};

// Walks first-parent history from HEAD and returns the file's distinct versions, oldest first. Each
// version is a commit where the file's content changed from the previous (older) commit.
export async function getFileHistory(store: GitObjectStore, path: string): Promise<FileVersion[]> {
    let parts = path.split("/").filter(Boolean);

    let commits: { sha: string; tree: string; message: string; author: string; time: number; parent: string | undefined }[] = [];
    let sha: string | undefined = await store.resolveHead();
    let seen = new Set<string>();
    while (sha && !seen.has(sha)) {
        seen.add(sha);
        let commit = await store.readCommit(sha);
        commits.push({
            sha, tree: commit.tree, message: commit.message.split("\n")[0],
            author: commit.author, time: commit.committerTime || commit.authorTime, parent: commit.parents[0],
        });
        sha = commit.parents[0];
    }

    // Resolve the file's blob sha at each commit (newest -> oldest).
    let blobShas = await Promise.all(commits.map(c => store.resolvePath(c.tree, parts)));

    // Walk oldest -> newest, emitting a version whenever the blob changes to a real (existing) blob.
    let versions: FileVersion[] = [];
    let prevBlob: string | undefined = undefined;
    for (let i = commits.length - 1; i >= 0; i--) {
        let blob = blobShas[i];
        if (!blob) {
            prevBlob = undefined;
            continue;
        }
        if (blob === prevBlob) continue;
        prevBlob = blob;
        let content = new TextDecoder().decode((await store.readObject(blob)).data).replace(/\r\n/g, "\n");
        let c = commits[i];
        versions.push({
            commitSha: c.sha, shortSha: c.sha.slice(0, 7), message: c.message, author: c.author,
            time: c.time, blobSha: blob, lines: content.length ? content.split("\n") : [],
        });
    }
    return versions;
}

// LCS alignment of two line arrays. Returns, for each line in `cur`, the matching index in `prev`
// (or -1 if the line is new). Guarded by size — very large files skip alignment (returns all -1).
export function alignLines(prev: string[], cur: string[]): number[] {
    let n = prev.length;
    let m = cur.length;
    let curToPrev = new Array(m).fill(-1);
    if (n === 0 || m === 0) return curToPrev;
    if (n * m > 4_000_000) return curToPrev;

    let dp: Int32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (prev[i] === cur[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
            else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (prev[i] === cur[j]) {
            curToPrev[j] = i;
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return curToPrev;
}
