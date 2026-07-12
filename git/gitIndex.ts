import { RepoFS, toHex, readUint32BE } from "./gitCore";

export type IndexEntry = { path: string; sha: string; mode: number; size: number; mtimeSeconds: number; mtimeNanos: number };

// Parses .git/index (versions 2 and 3). We only need the staged blob sha and path per tracked file;
// stat data and extensions are skipped.
export async function readIndex(fs: RepoFS): Promise<IndexEntry[]> {
    let data = await fs.readFile(".git/index");
    if (!data) return [];
    let signature = new TextDecoder().decode(data.subarray(0, 4));
    if (signature !== "DIRC") throw new Error(`Unexpected index signature "${signature}", expected "DIRC"`);
    let version = readUint32BE(data, 4);
    if (version > 3) throw new Error(`Unsupported index version ${version} (only 2 and 3 are handled)`);
    let count = readUint32BE(data, 8);

    let out: IndexEntry[] = [];
    let pos = 12;
    for (let i = 0; i < count; i++) {
        let start = pos;
        let mtimeSeconds = readUint32BE(data, start + 8);
        let mtimeNanos = readUint32BE(data, start + 12);
        let mode = readUint32BE(data, start + 24);
        let size = readUint32BE(data, start + 36);
        let sha = toHex(data.subarray(start + 40, start + 60));
        let flags = (data[start + 60] << 8) | data[start + 61];
        let nameLen = flags & 0x0fff;
        let fixed = 62;
        // In v3+ the high bit of flags signals a second 2-byte flags word before the name.
        if (version >= 3 && (flags & 0x4000)) fixed = 64;
        let nameStart = start + fixed;
        let nameEnd = nameLen < 0x0fff ? nameStart + nameLen : data.indexOf(0x00, nameStart);
        let path = new TextDecoder().decode(data.subarray(nameStart, nameEnd));
        out.push({ path, sha, mode, size, mtimeSeconds, mtimeNanos });
        // Entries are NUL-padded so each is a multiple of 8 bytes, with at least one trailing NUL.
        pos = start + ((fixed + (nameEnd - nameStart) + 8) & ~7);
    }
    return out;
}
