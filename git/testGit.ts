import { execFileSync } from "child_process";
import { GitObjectStore } from "./objectStore";
import { getPendingChanges, getFileDiff, diffLines } from "./gitStatus";
import { readIndex } from "./gitIndex";
import { nodeRepoFS } from "./nodeFS";

let root = process.argv[2] || process.cwd();
let fs = nodeRepoFS(root);
let store = new GitObjectStore(fs);

function git(args: string[]) {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

let failures = 0;
function check(name: string, ours: string, theirs: string) {
    let ok = ours === theirs;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) {
        console.log(`   ours:   ${JSON.stringify(ours).slice(0, 400)}`);
        console.log(`   git:    ${JSON.stringify(theirs).slice(0, 400)}`);
    }
}

async function main() {
    // 1) HEAD resolution against a fully-packed repo.
    let head = await store.resolveHead();
    check("resolveHead", head, git(["rev-parse", "HEAD"]).trim());

    // 2) Read a blob out of the packfile (delta chains and all) and compare to git.
    let tree = await store.readHeadTree();
    let sampleName = [...tree.keys()].find(k => k.endsWith("hoster.py")) || [...tree.keys()][0];
    let sample = tree.get(sampleName);
    if (sample) {
        let obj = await store.readObject(sample.sha);
        let ours = new TextDecoder().decode(obj.data);
        check(`read packed blob (${sampleName})`, ours, git(["cat-file", "blob", sample.sha]));
    }

    // 3) Every blob in HEAD's tree must round-trip byte-for-byte.
    let mismatched = 0;
    for (let [name, entry] of tree) {
        if (entry.mode === "160000") continue;
        let obj = await store.readObject(entry.sha);
        let ours = Buffer.from(obj.data);
        let theirs = execFileSync("git", ["-C", root, "cat-file", "blob", entry.sha], { maxBuffer: 64 * 1024 * 1024 });
        if (!ours.equals(theirs)) {
            mismatched++;
            console.log(`   blob mismatch: ${name} (${entry.sha})`);
        }
    }
    check("all HEAD blobs round-trip", String(mismatched), "0");

    // 4) Pending changes list matches `git diff` (tracked modifications + deletions).
    let changes = await getPendingChanges(fs);
    let ours = changes.filter(c => c.status !== "added").map(c => `${c.status[0].toUpperCase()} ${c.path}`).sort().join("\n");
    let theirsRaw = git(["diff", "--name-status", "HEAD"]).trim();
    // git prints e.g. "M\tpath"; normalize to "M path", and drop additions (untracked, which we skip).
    let theirs = theirsRaw.split("\n").filter(Boolean).map(l => {
        let [code, ...rest] = l.split("\t");
        return `${code[0]} ${rest.join("\t")}`;
    }).filter(l => l.startsWith("M ") || l.startsWith("D ")).sort().join("\n");
    check("pending changes (M/D vs git diff HEAD)", ours, theirs);

    // 4b) Untracked (added) files match `git ls-files --others --exclude-standard` (gitignore honored).
    let ourAdded = changes.filter(c => c.status === "added").map(c => c.path).sort().join("\n");
    let gitAdded = git(["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean).sort().join("\n");
    check("untracked (added) vs git ls-files", ourAdded, gitAdded);

    // 5) The actual diff content for one modified file.
    let index = await readIndex(fs);
    let modified = changes.find(c => c.status === "modified");
    if (modified) {
        let entry = index.find(e => e.path === modified.path);
        if (entry) {
            let ourDiff = await getFileDiff({ fs, store, path: modified.path, stagedSha: entry.sha });
            let ourAddRemove = ourDiff.filter(l => l.kind !== " ").map(l => l.kind + l.text).join("\n");
            // Compare against git's +/- body lines (strip headers/@@ hunks).
            let gitDiff = git(["diff", "HEAD", "--", modified.path]);
            let gitBody = gitDiff.split("\n").filter(l =>
                (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")
            ).map(l => l[0] + l.slice(1)).join("\n");
            check(`diff body (${modified.path})`, ourAddRemove, gitBody);
        }
    }

    console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
    if (failures) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
