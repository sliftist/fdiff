import { RepoFS, toHex, readUint32BE, inflateAll, inflateExact } from "./gitCore";

export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export type GitObject = { type: GitObjectType; data: Uint8Array };

function packTypeName(t: number): GitObjectType {
    if (t === 1) return "commit";
    if (t === 2) return "tree";
    if (t === 3) return "blob";
    if (t === 4) return "tag";
    throw new Error(`Unsupported pack object type ${t}`);
}

type Pack = {
    pack: Uint8Array;
    idx: Uint8Array;
    fanout: number[];
    shaTableOffset: number;
    offsetsTableOffset: number;
    largeOffsetsTableOffset: number;
};

// Reads a delta buffer's leading size varint (little-endian, 7 bits per byte).
function readSizeVarint(buf: Uint8Array, pos: number): [number, number] {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
        byte = buf[pos++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return [value, pos];
}

function applyDelta(base: Uint8Array, delta: Uint8Array) {
    let pos = 0;
    // Source size (must match base length) then target size; we only need the target.
    [, pos] = readSizeVarint(delta, pos);
    let targetSize = 0;
    [targetSize, pos] = readSizeVarint(delta, pos);
    let out = new Uint8Array(targetSize);
    let outPos = 0;
    while (pos < delta.length) {
        let op = delta[pos++];
        if (op & 0x80) {
            // Copy a run from the base object.
            let copyOffset = 0;
            let copySize = 0;
            if (op & 0x01) copyOffset += delta[pos++];
            if (op & 0x02) copyOffset += delta[pos++] * 0x100;
            if (op & 0x04) copyOffset += delta[pos++] * 0x10000;
            if (op & 0x08) copyOffset += delta[pos++] * 0x1000000;
            if (op & 0x10) copySize += delta[pos++];
            if (op & 0x20) copySize += delta[pos++] * 0x100;
            if (op & 0x40) copySize += delta[pos++] * 0x10000;
            if (copySize === 0) copySize = 0x10000;
            out.set(base.subarray(copyOffset, copyOffset + copySize), outPos);
            outPos += copySize;
        } else if (op) {
            // Insert literal bytes taken from the delta stream.
            out.set(delta.subarray(pos, pos + op), outPos);
            outPos += op;
            pos += op;
        }
    }
    return out;
}

export class GitObjectStore {
    private packsPromise: Promise<Pack[]> | undefined;

    constructor(private fs: RepoFS) { }

    async readObject(sha: string): Promise<GitObject> {
        let loose = await this.readLoose(sha);
        if (loose) return loose;
        let packed = await this.readPacked(sha);
        if (packed) return packed;
        throw new Error(`Object not found: ${sha}`);
    }

    private async readLoose(sha: string): Promise<GitObject | undefined> {
        let bytes = await this.fs.readFile(`.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`);
        if (!bytes) return undefined;
        let raw = await inflateAll(bytes);
        let space = raw.indexOf(0x20);
        let nul = raw.indexOf(0x00, space + 1);
        let type = new TextDecoder().decode(raw.subarray(0, space)) as GitObjectType;
        return { type, data: raw.subarray(nul + 1) };
    }

    private loadPacks() {
        if (!this.packsPromise) this.packsPromise = this.doLoadPacks();
        return this.packsPromise;
    }

    private async doLoadPacks() {
        let packs: Pack[] = [];
        let entries = await this.fs.readDir(".git/objects/pack");
        if (!entries) return packs;
        for (let entry of entries) {
            if (!entry.name.endsWith(".idx")) continue;
            let base = entry.name.slice(0, -4);
            let idx = await this.fs.readFile(`.git/objects/pack/${base}.idx`);
            let pack = await this.fs.readFile(`.git/objects/pack/${base}.pack`);
            if (!idx || !pack) continue;
            // idx v2 layout: 8-byte header, then a 256-entry fanout table.
            let fanout: number[] = [];
            for (let i = 0; i < 256; i++) fanout.push(readUint32BE(idx, 8 + i * 4));
            let count = fanout[255];
            let shaTableOffset = 8 + 256 * 4;
            let offsetsTableOffset = shaTableOffset + count * 20 + count * 4;
            let largeOffsetsTableOffset = offsetsTableOffset + count * 4;
            packs.push({ pack, idx, fanout, shaTableOffset, offsetsTableOffset, largeOffsetsTableOffset });
        }
        return packs;
    }

    private findOffset(p: Pack, sha: string): number | undefined {
        let first = parseInt(sha.slice(0, 2), 16);
        let lo = first === 0 ? 0 : p.fanout[first - 1];
        let hi = p.fanout[first];
        while (lo < hi) {
            let mid = (lo + hi) >> 1;
            let midSha = toHex(p.idx.subarray(p.shaTableOffset + mid * 20, p.shaTableOffset + mid * 20 + 20));
            if (midSha === sha) {
                let off = readUint32BE(p.idx, p.offsetsTableOffset + mid * 4);
                if (off & 0x80000000) {
                    let large = off & 0x7fffffff;
                    return readUint32BE(p.idx, p.largeOffsetsTableOffset + large * 8) * 0x100000000
                        + readUint32BE(p.idx, p.largeOffsetsTableOffset + large * 8 + 4);
                }
                return off;
            }
            if (midSha < sha) lo = mid + 1; else hi = mid;
        }
        return undefined;
    }

    private async readPacked(sha: string): Promise<GitObject | undefined> {
        let packs = await this.loadPacks();
        for (let p of packs) {
            let offset = this.findOffset(p, sha);
            if (offset !== undefined) return await this.readAtOffset(p, offset);
        }
        return undefined;
    }

    private async readAtOffset(p: Pack, offset: number): Promise<GitObject> {
        let pos = offset;
        let byte = p.pack[pos++];
        let type = (byte >> 4) & 7;
        let size = byte & 0x0f;
        let shift = 4;
        while (byte & 0x80) {
            byte = p.pack[pos++];
            size += (byte & 0x7f) * 2 ** shift;
            shift += 7;
        }

        if (type === 6) {
            // ofs_delta: base is at (this offset - relativeOffset) within the same pack.
            let b = p.pack[pos++];
            let relative = b & 0x7f;
            while (b & 0x80) {
                b = p.pack[pos++];
                relative = (relative + 1) * 0x80 + (b & 0x7f);
            }
            let base = await this.readAtOffset(p, offset - relative);
            let delta = await inflateExact(p.pack.subarray(pos), size);
            return { type: base.type, data: applyDelta(base.data, delta) };
        }
        if (type === 7) {
            // ref_delta: base is referenced by sha (possibly in another pack or loose).
            let baseSha = toHex(p.pack.subarray(pos, pos + 20));
            pos += 20;
            let base = await this.readObject(baseSha);
            let delta = await inflateExact(p.pack.subarray(pos), size);
            return { type: base.type, data: applyDelta(base.data, delta) };
        }
        return { type: packTypeName(type), data: await inflateExact(p.pack.subarray(pos), size) };
    }

    async resolveHead(): Promise<string> {
        let head = await this.fs.readFile(".git/HEAD");
        if (!head) throw new Error(".git/HEAD not found");
        let text = new TextDecoder().decode(head).trim();
        if (text.startsWith("ref: ")) return await this.resolveRef(text.slice(5).trim());
        return text;
    }

    async resolveRef(ref: string): Promise<string> {
        let direct = await this.fs.readFile(`.git/${ref}`);
        if (direct) return new TextDecoder().decode(direct).trim();
        let packed = await this.fs.readFile(".git/packed-refs");
        if (packed) {
            for (let line of new TextDecoder().decode(packed).split("\n")) {
                if (!line || line.startsWith("#") || line.startsWith("^")) continue;
                let space = line.indexOf(" ");
                if (line.slice(space + 1).trim() === ref) return line.slice(0, space);
            }
        }
        throw new Error(`Ref not found: ${ref}`);
    }

    private async readTree(sha: string, prefix: string, out: Map<string, { mode: string; sha: string }>) {
        let obj = await this.readObject(sha);
        if (obj.type !== "tree") throw new Error(`Expected tree, was ${obj.type} for ${sha}`);
        let data = obj.data;
        let pos = 0;
        while (pos < data.length) {
            let space = data.indexOf(0x20, pos);
            let mode = new TextDecoder().decode(data.subarray(pos, space));
            let nul = data.indexOf(0x00, space + 1);
            let name = new TextDecoder().decode(data.subarray(space + 1, nul));
            let entrySha = toHex(data.subarray(nul + 1, nul + 21));
            pos = nul + 21;
            if (mode === "40000") {
                await this.readTree(entrySha, prefix + name + "/", out);
            } else {
                out.set(prefix + name, { mode, sha: entrySha });
            }
        }
    }

    async readHeadTree(): Promise<Map<string, { mode: string; sha: string }>> {
        let commitSha = await this.resolveHead();
        let commit = await this.readObject(commitSha);
        let treeLine = new TextDecoder().decode(commit.data).split("\n").find(l => l.startsWith("tree "));
        if (!treeLine) throw new Error(`Commit ${commitSha} has no tree line`);
        let out = new Map<string, { mode: string; sha: string }>();
        await this.readTree(treeLine.slice(5).trim(), "", out);
        return out;
    }
}
