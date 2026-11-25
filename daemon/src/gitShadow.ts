import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LIMITS } from "./config.js";
import { resolveSafePath } from "./security.js";
import type { CheckpointRecord } from "./types.js";

const HEAD_REF = "refs/repobridge/head";
const CP_REF_PREFIX = "refs/repobridge/cp/";
const META_PREFIX = "REPOBRIDGE_META:";
const MAX_CHECKPOINTS = LIMITS.MAX_CHECKPOINTS;
interface CommitMeta {
  id: string;
  timestamp: string;
  treeSha: string | null;
  restorableFiles: string[];
  createdFiles: string[];
  createdDirs: string[];
}

export class GitShadowEngine {
  private readonly repoRoot: string;
  private readonly gitDir: string | null;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.gitDir = this.detectGitDir();
  }

  private git(args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync("git", args, {
      cwd: this.repoRoot,
      env: env ?? process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  }

  private detectGitDir(): string | null {
    try {
      const out = this.git(["rev-parse", "--absolute-git-dir"]);
      return out ? path.resolve(out) : null;
    } catch {
      return null;
    }
  }

  public isGitRepo(): boolean {
    return this.gitDir !== null;
  }

  public getBranch(): string {
    if (!this.gitDir) return "no-git";
    try {
      return this.git(["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
    } catch {
      return "unborn-branch";
    }
  }

  private getHeadSha(): string | null {
    if (!this.gitDir) return null;
    try {
      return this.git(["rev-parse", "--verify", HEAD_REF]) || null;
    } catch {
      return null;
    }
  }

  private getEmptyTreeSha(): string {
    // Standard Git empty tree hash (create/verify via mktree)
    return execFileSync("git", ["mktree"], {
      cwd: this.repoRoot,
      input: "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  }

  private parseCommitRecord(commitSha: string): CheckpointRecord | null {
    try {
      const raw = this.git(["cat-file", "commit", commitSha]);
      const parentMatch = raw.match(/^parent ([0-9a-f]{40})$/m);
      const treeMatch = raw.match(/^tree ([0-9a-f]{40})$/m);
      const metaIdx = raw.indexOf(META_PREFIX);
      if (metaIdx === -1) return null;

      const jsonText = raw.slice(metaIdx + META_PREFIX.length).trim();
      const meta = JSON.parse(jsonText) as CommitMeta;
      return {
        id: meta.id,
        commitSha,
        parentSha: parentMatch ? parentMatch[1] : null,
        timestamp: meta.timestamp,
        treeSha: meta.treeSha ?? (treeMatch ? treeMatch[1] : null),
        restorableFiles: Array.isArray(meta.restorableFiles) ? meta.restorableFiles : [],
        createdFiles: Array.isArray(meta.createdFiles) ? meta.createdFiles : [],
        createdDirs: Array.isArray(meta.createdDirs) ? meta.createdDirs : [],
        touchedFiles: Array.isArray(meta.restorableFiles) ? meta.restorableFiles : []
      };
    } catch {
      return null;
    }
  }

  private createCommit(treeSha: string, parentSha: string | null, meta: CommitMeta): string {
    const args = ["commit-tree", treeSha];
    if (parentSha) {
      args.push("-p", parentSha);
    }
    const message = `repobridge checkpoint ${meta.id}\n\n${META_PREFIX}${JSON.stringify(meta)}\n`;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "RepoBridge",
      GIT_AUTHOR_EMAIL: "repobridge@local",
      GIT_COMMITTER_NAME: "RepoBridge",
      GIT_COMMITTER_EMAIL: "repobridge@local"
    };
    return execFileSync("git", args, {
      cwd: this.repoRoot,
      env,
      input: message,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  }
  private deleteRef(refName: string): void {
    try {
      this.git(["update-ref", "-d", refName]);
    } catch {
      // ignore if ref absent
    }
  }

  public listCheckpoints(): CheckpointRecord[] {
    if (!this.gitDir) return [];
    const records: CheckpointRecord[] = [];
    let cursor = this.getHeadSha();
    let guard = 0;

    while (cursor && guard < MAX_CHECKPOINTS + 5) {
      guard += 1;
      const rec = this.parseCommitRecord(cursor);
      if (!rec) break;
      records.push(rec);
      cursor = rec.parentSha;
    }

    // Oldest first so consumers see chronological stack order
    return records.reverse();
  }

  private pruneOldRefs(records: CheckpointRecord[]): void {
    if (records.length <= MAX_CHECKPOINTS) return;
    const evicted = records.slice(0, records.length - MAX_CHECKPOINTS);
    for (const item of evicted) {
      this.deleteRef(`${CP_REF_PREFIX}${item.id}`);
    }
  }

  public createCheckpoint(writeFilePaths: string[] = []): CheckpointRecord | null {
    if (!this.gitDir) return null;

    // Validate paths individually so one bad path never aborts the batch; regular files only
    const restorableFiles: string[] = [];
    const seen = new Set<string>();

    for (const raw of writeFilePaths) {
      try {
        const abs = resolveSafePath(this.repoRoot, raw, true);
        if (!fs.existsSync(abs)) continue;
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()) continue;
        const rel = path.relative(this.repoRoot, abs).replace(/\\/g, "/");
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          restorableFiles.push(rel);
        }
      } catch {
        // Invalid or protected path — executeTool will return a normal error
      }
    }

    const id = `cp_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
    const timestamp = new Date().toISOString();
    let snapshotTreeSha: string | null = null;
    let commitTreeSha: string;

    if (restorableFiles.length > 0) {
      const tmpIndex = path.join(
        this.gitDir,
        `gemini-tmp-index-${crypto.randomBytes(4).toString("hex")}`
      );
      try {
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        this.git(["add", "-f", "--", ...restorableFiles], env);
        snapshotTreeSha = this.git(["write-tree"], env);
        commitTreeSha = snapshotTreeSha;
      } catch (err) {
        console.warn(
          `[GitShadow] Checkpoint snapshot skipped: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      } finally {
        if (fs.existsSync(tmpIndex)) {
          try {
            fs.unlinkSync(tmpIndex);
          } catch {
            // ignore
          }
        }
      }
    } else {
      commitTreeSha = this.getEmptyTreeSha();
    }

    try {
      const parentSha = this.getHeadSha();
      const meta: CommitMeta = {
        id,
        timestamp,
        treeSha: snapshotTreeSha,
        restorableFiles,
        createdFiles: [],
        createdDirs: []
      };
      const commitSha = this.createCommit(commitTreeSha, parentSha, meta);
      this.git(["update-ref", HEAD_REF, commitSha]);
      this.git(["update-ref", `${CP_REF_PREFIX}${id}`, commitSha]);
      this.pruneOldRefs(this.listCheckpoints());

      return {
        id,
        commitSha,
        parentSha,
        timestamp,
        treeSha: snapshotTreeSha,
        restorableFiles,
        createdFiles: [],
        createdDirs: [],
        touchedFiles: restorableFiles
      };
    } catch (err) {
      console.warn(
        `[GitShadow] Failed to write checkpoint commit: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  public recordCreatedFile(
    checkpointId: string | null,
    relPath: string,
    createdDirs: string[] = []
  ): void {
    if (!checkpointId || !this.gitDir) return;
    const headSha = this.getHeadSha();
    if (!headSha) return;

    const current = this.parseCommitRecord(headSha);
    if (!current || current.id !== checkpointId) return;

    let changed = false;
    const createdFiles = [...current.createdFiles];
    const nextDirs = [...current.createdDirs];

    if (!createdFiles.includes(relPath)) {
      createdFiles.push(relPath);
      changed = true;
    }
    for (const dir of createdDirs) {
      if (!nextDirs.includes(dir)) {
        nextDirs.push(dir);
        changed = true;
      }
    }
    if (!changed) return;

    try {
      const commitTreeSha = current.treeSha ?? this.getEmptyTreeSha();
      const amendedSha = this.createCommit(commitTreeSha, current.parentSha, {
        id: current.id,
        timestamp: current.timestamp,
        treeSha: current.treeSha,
        restorableFiles: current.restorableFiles,
        createdFiles,
        createdDirs: nextDirs
      });
      this.git(["update-ref", HEAD_REF, amendedSha]);
      this.git(["update-ref", `${CP_REF_PREFIX}${current.id}`, amendedSha]);
    } catch (err) {
      console.warn(
        `[GitShadow] Failed to amend created file metadata: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public revertLastCheckpoint(): { ok: boolean; message: string; remaining: number } {
    if (!this.gitDir) {
      return {
        ok: false,
        message: "Not a Git repository; shadow rollback unavailable.",
        remaining: 0
      };
    }

    const headSha = this.getHeadSha();
    if (!headSha) {
      return { ok: false, message: "No checkpoints available to revert.", remaining: 0 };
    }

    const last = this.parseCommitRecord(headSha);
    if (!last) {
      return {
        ok: false,
        message: "Corrupted checkpoint commit at refs/gemini/head.",
        remaining: 0
      };
    }

    try {
      // Restore ONLY the specific pre-edit files touched in this turn
      if (last.treeSha && last.restorableFiles.length > 0) {
        for (const rel of last.restorableFiles) {
          const abs = resolveSafePath(this.repoRoot, rel, true);
          const blob = execFileSync("git", ["cat-file", "blob", `${last.treeSha}:${rel}`], {
            cwd: this.repoRoot,
            stdio: ["ignore", "pipe", "pipe"]
          });
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, blob);
        }
      }

      // Remove brand-new files created during that turn
      for (const rel of last.createdFiles) {
        const abs = resolveSafePath(this.repoRoot, rel, true);
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
      }

      // Remove empty directories created by write_file (deepest first)
      const dirsToClean = [...last.createdDirs].sort((a, b) => b.length - a.length);
      for (const relDir of dirsToClean) {
        try {
          const absDir = resolveSafePath(this.repoRoot, relDir, true);
          if (fs.existsSync(absDir)) {
            fs.rmdirSync(absDir);
          }
        } catch {
          // Leave non-empty directories intact
        }
      }

      // Pop refs/gemini/head back to parent commit
      if (last.parentSha) {
        this.git(["update-ref", HEAD_REF, last.parentSha]);
      } else {
        this.deleteRef(HEAD_REF);
      }
      this.deleteRef(`${CP_REF_PREFIX}${last.id}`);

      const remaining = this.listCheckpoints().length;
      return {
        ok: true,
        message: `Reverted ${last.restorableFiles.length} modified + ${last.createdFiles.length} created file(s) from ${last.id}.`,
        remaining
      };
    } catch (err) {
      return {
        ok: false,
        message: `Git revert failed: ${err instanceof Error ? err.message : String(err)}`,
        remaining: this.listCheckpoints().length
      };
    }
  }
}
