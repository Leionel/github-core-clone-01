// The forge's store: one in-memory model shared by git smart HTTP, REST v3, GraphQL v4 and MCP.
// No disk I/O, no wall-clock time in stored state: every timestamp is the trial's fixed instant
// (MAKEFUN_TRIAL_NOW when the env sets it, else a fixed default), and every server-made git commit
// uses a fixed epoch, so two runs on one instance behave identically.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

// The token owner's identity: wire.ts's fixed scenario (SCENARIO_SEED 0x6a09e667f3bcc909,
// buildScenario(): the viewer is users[0]). The suite addresses every repository under this login,
// and a repository under any other owner is a 404.
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

export const FIXED_EPOCH = 1700000000; // server-made git commits: fixed, deterministic
export const FIXED_NOW = '2025-01-01T00:00:00.000Z';

/** The instant every REST/GraphQL timestamp carries. */
export function nowIso(): string {
  const env = process.env.MAKEFUN_TRIAL_NOW;
  return env && env.length > 0 ? env : FIXED_NOW;
}

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// ---------------------------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function repoGlobalId(dbId: number): string {
  return b64(`Repository:${dbId}`);
}
export function issueGlobalId(dbId: number, number: number): string {
  return b64(`Issue:${dbId}:${number}`);
}
export function pullGlobalId(dbId: number, number: number): string {
  return b64(`PullRequest:${dbId}:${number}`);
}
export function commentGlobalId(dbId: number, issueNumber: number, commentId: number): string {
  return b64(`IssueComment:${dbId}:${issueNumber}:${commentId}`);
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0]!;
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
  if (!/^\d+$/.test(parts[1]!)) return null;
  return { kind, parts };
}

// ---------------------------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number; // numeric REST id, stable per repo
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  seq: number; // creation order, monotonic per repo
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface Repo {
  id: number; // databaseId
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // shared issue+PR number sequence, starts at 1
  nextCommentId: number;
  nextLabelId: number;
  seq: number; // creation order across repos
}

export class Store {
  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  private nextRepoId = 1;
  private nextRepoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** All of the token owner's repos, in creation order. */
  ownerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      seq: this.nextRepoSeq++,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The commit at a ref, or null. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      try {
        return parseTag(object.data).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Peel a tag (recursively) to its commit, or the oid itself when it is not a tag. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      try {
        current = parseTag(object.data).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // trees
  // -------------------------------------------------------------------------------------------

  /** The blob oid at `path` in the tree, or null (missing or a directory). */
  treeGetBlob(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s.length > 0);
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Immediate children of `dirPath` in the tree ('' = root): [{name, path, mode, oid}]. */
  treeListDir(repo: Repo, treeOid: string, dirPath: string): Array<{ name: string; path: string; mode: string; oid: string }> {
    let current = treeOid;
    const segments = dirPath.split('/').filter((s) => s.length > 0);
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((e) => e.name === segment && e.mode === '40000');
      if (!entry) return [];
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return [];
    const prefix = segments.length ? `${segments.join('/')}/` : '';
    return parseTree(object.data).map((e) => ({ name: e.name, path: `${prefix}${e.name}`, mode: e.mode, oid: e.oid }));
  }

  /** A new tree oid with `path` set to `blobOid` (or removed when null), based on `treeOid`. */
  treeSetPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    const build = (current: string | null, depth: number): string => {
      const entries: TreeEntry[] = current ? parseTree(repo.objects.get(current)!.data) : [];
      const name = segments[depth]!;
      const existing = entries.find((e) => e.name === name);
      let nextEntries = entries.filter((e) => e.name !== name);
      if (depth === segments.length - 1) {
        if (blobOid !== null) nextEntries.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = build(existing && existing.mode === '40000' ? existing.oid : null, depth + 1);
        nextEntries.push({ mode: '40000', name, oid: child });
      }
      // Drop now-empty directories (except at the root, where an empty tree is fine).
      nextEntries = nextEntries.filter((e) => {
        if (e.mode !== '40000') return true;
        const child = repo.objects.get(e.oid);
        return child !== undefined && parseTree(child.data).length > 0;
      });
      return this.putObject(repo, 'tree', buildTree(nextEntries));
    };
    return build(treeOid, 0);
  }

  /** All file paths (blobs) under a tree, with their blob oids. */
  treeFiles(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else if (entry.mode !== '160000') out.set(`${prefix}${entry.name}`, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Diff two trees: paths changed between `baseTree` and `headTree`. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): Array<{
    path: string;
    status: 'added' | 'removed' | 'modified';
    baseOid: string | null;
    headOid: string | null;
  }> {
    const base = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, string>();
    const head = headTree ? this.treeFiles(repo, headTree) : new Map<string, string>();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; baseOid: string | null; headOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path) ?? null;
      const h = head.get(path) ?? null;
      if (b === h) continue;
      if (b === null) out.push({ path, status: 'added', baseOid: null, headOid: h });
      else if (h === null) out.push({ path, status: 'removed', baseOid: b, headOid: null });
      else out.push({ path, status: 'modified', baseOid: b, headOid: h });
    }
    return out;
  }

  /** The merge base (best common ancestor) of two commits, or null when unrelated. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push(parent);
      }
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push(parent);
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // server-made commits (contents API, merges)
  // -------------------------------------------------------------------------------------------

  /** Create a commit on `ref` with `treeOid` and `parents`, author/committer the viewer. */
  makeCommit(repo: Repo, ref: string, treeOid: string, parents: string[], message: string): string {
    const data = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: viewerIdent(),
      committer: viewerIdent(),
      timestamp: FIXED_EPOCH,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(ref, oid);
    repo.updatedAt = nowIso();
    return oid;
  }

  /** Commit a file change (set or delete `path`) on `ref`; returns the new commit oid. */
  commitFileChange(
    repo: Repo,
    ref: string,
    path: string,
    blobOid: string | null,
    message: string,
  ): { commit: string; tree: string } {
    const tip = this.refCommit(repo, ref);
    const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
    const tree = this.treeSetPath(repo, baseTree, path, blobOid);
    const commit = this.makeCommit(repo, ref, tree, tip ? [tip] : [], message);
    return { commit, tree };
  }

  // -------------------------------------------------------------------------------------------
  // issues / pulls
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const now = nowIso();
    const issue: Issue = {
      number,
      id: repo.id * 1000000 + number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const now = nowIso();
    const pull: Pull = {
      number,
      id: repo.id * 1000000 + number,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Squash-merge a pull request. Returns the merge commit oid, or an error string. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    const headTip = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return { error: 'head or base branch is missing' };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headFiles = this.treeFiles(repo, headTree);
    const baseFiles = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, string>();
    const baseTipFiles = this.treeFiles(repo, baseTipTree);
    // Conflict: a path changed on both sides since the merge base, to different contents.
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path) ?? null;
      const atHead = headFiles.get(path) ?? null;
      const atTip = baseTipFiles.get(path) ?? null;
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) {
        return { error: 'merge conflict' };
      }
    }
    // Already merged: head's tree is the base tip's tree and head is an ancestor of base.
    if (headTree === baseTipTree && isAncestor(headTip, baseTip, this.lookup(repo))) {
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = baseTip;
      pull.updatedAt = nowIso();
      pull.closedAt = nowIso();
      return { sha: baseTip };
    }
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const sha = this.makeCommit(repo, `refs/heads/${pull.baseRef}`, headTree, [baseTip], message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso();
    pull.closedAt = nowIso();
    pull.baseSha = sha;
    return { sha };
  }

  /** The changed files of a pull request (merge-base tree vs head tip tree), with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{
    filename: string;
    status: 'added' | 'removed' | 'modified';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const headTip = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return [];
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const countLines = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text.length === 0) return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    return this.diffTrees(repo, baseTree, headTree).map((change) => {
      const additions = countLines(change.headOid);
      const deletions = change.status === 'added' ? 0 : countLines(change.baseOid);
      return {
        filename: change.path,
        status: change.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  /** Whether a pull request would conflict if merged now (same rule as mergePull). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return 'UNKNOWN';
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headFiles = this.treeFiles(repo, headTree);
    const baseFiles = baseTree ? this.treeFiles(repo, baseTree) : new Map<string, string>();
    const baseTipFiles = this.treeFiles(repo, baseTipTree);
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path) ?? null;
      const atHead = headFiles.get(path) ?? null;
      const atTip = baseTipFiles.get(path) ?? null;
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

/** Walk the commit graph from `tip` (newest first), calling `visit` for each commit oid. */
export function walkCommits(repo: Repo, tip: string, visit: (oid: string, commit: ReturnType<typeof parseCommit>) => void): void {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    visit(oid, commit);
    for (const parent of commit.parents) queue.push(parent);
  }
}

export { ZERO_OID, collectReachable };
