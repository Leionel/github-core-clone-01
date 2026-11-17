// Git smart HTTP: info/refs (v0 + v2), upload-pack (v2 ls-refs/fetch, v0 fetch), receive-pack.
// Speaks the protocol the suite's git client speaks (program/env/src/git-client.ts), and real git.

import {
  ZERO_OID,
  collectReachable,
  decodePktLinesUntilFlush,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './git.ts';
import { VIEWER, nowIso, type Repo, type Store } from './store.ts';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  gitProtocolVersion: 2 | 0; // from the Git-Protocol request header
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AD_UPLOAD = 'application/x-git-upload-pack-advertisement';
const AD_RECEIVE = 'application/x-git-receive-pack-advertisement';
const RES_UPLOAD = 'application/x-git-upload-pack-result';
const RES_RECEIVE = 'application/x-git-receive-pack-result';

function json404(message = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message })) };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message })) };
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function peelOid(repo: Repo, oid: string): string | null {
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

/** The repo's refs as advertisement lines (HEAD first is handled by the caller). */
function refLines(repo: Repo, opts: { peel: boolean; symrefs: boolean }): RefLine[] {
  const lines: RefLine[] = [];
  if (opts.symrefs) lines.push({ name: 'HEAD', oid: repo.refs.get('refs/heads/main') ?? ZERO_OID, symrefTarget: 'refs/heads/main' });
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (opts.peel && name.startsWith('refs/tags/')) {
      const peeled = peelOid(repo, oid);
      if (peeled !== null && peeled !== oid) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(store: Store, req: GitRequest): GitResponse {
  if (req.owner !== VIEWER.login) return json404();
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) return json404();

  if (req.service === 'git-receive-pack') {
    const caps = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
    const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
    const lines = refLines(repo, { peel: false, symrefs: false });
    if (lines.length === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      lines.forEach((line, i) => {
        const text = i === 0 ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`;
        parts.push(encodePktLine(text));
      });
    }
    parts.push(pktLineFlush());
    return { status: 200, contentType: AD_RECEIVE, body: Buffer.concat(parts) };
  }

  // git-upload-pack
  if (req.gitProtocolVersion === 2) {
    const parts: Buffer[] = [
      encodePktLine('# service=git-upload-pack\n'),
      pktLineFlush(),
      encodePktLine('version 2\n'),
      encodePktLine('ls-refs=unborn\n'),
      encodePktLine('fetch=shallow thin-pack\n'),
      encodePktLine('object-format=sha1\n'),
      encodePktLine('agent=forge/1.0\n'),
      pktLineFlush(),
    ];
    return { status: 200, contentType: AD_UPLOAD, body: Buffer.concat(parts) };
  }

  const caps = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack multi_ack shallow agent=forge/1.0';
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  const lines = refLines(repo, { peel: true, symrefs: true });
  if (lines.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => {
      const text = i === 0 ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`;
      parts.push(encodePktLine(text));
      if (line.peeled) parts.push(encodePktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return { status: 200, contentType: AD_UPLOAD, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const lines = refLines(repo, { peel: wantPeel, symrefs: wantSymrefs });
  const hasRefs = repo.refs.size > 0;
  const hasMain = repo.refs.has('refs/heads/main');
  for (const line of lines) {
    if (!matches(line.name)) continue;
    if (line.name === 'HEAD') {
      if (!hasMain) {
        if (wantUnborn) parts.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
        continue;
      }
      let text = `${line.oid} ${line.name}`;
      if (line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
      parts.push(encodePktLine(`${text}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
    if (line.peeled) text += ` peeled:${line.peeled}`;
    parts.push(encodePktLine(`${text}\n`));
  }
  if (!hasRefs && wantUnborn && !parts.length) {
    parts.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  deepenRelative: boolean;
}

function planFetch(repo: Repo, plan: FetchPlan): {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
} {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Resolve each want to its commit (peeling tags); remember tag objects themselves.
  const wantCommits: string[] = [];
  const extraObjects = new Map<string, GitObject>(); // tag objects that are wants
  for (const want of plan.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extraObjects.set(want, object);
      const peeled = peelOid(repo, want);
      if (peeled) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }
  // Depth-limited commit walk from the want commits. `deepen N` is an absolute depth, but
  // `deepen N` with `deepen-relative` is relative to the depth the client already has: the
  // current depth of a shallow boundary is its generation from a want tip (wants are generation
  // 1), so the new depth is that generation plus N. (Real git sends `deepen 1` +
  // `deepen-relative` for `fetch --deepen=1` on a depth-1 clone; the suite sends absolute
  // `deepen 2`.) The walk is capped: a depth-1 fetch of a 200-commit history only ever visits
  // the tip, never the whole history — that is what makes 50 concurrent shallow clones cheap.
  const generation = new Map<string, number>();
  {
    const queue: Array<{ oid: string; depth: number }> = wantCommits.map((oid) => ({ oid, depth: 1 }));
    const boundarySet = new Set(plan.shallowBoundaries);
    let baseGen = 0;
    let boundariesFound = 0;
    while (queue.length) {
      const { oid, depth } = queue.shift()!;
      if (generation.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      generation.set(oid, depth);
      if (boundarySet.has(oid)) {
        boundariesFound += 1;
        baseGen = Math.max(baseGen, depth);
      }
      // Stop expanding once we are past the depth that matters. Absolute `deepen N`: the cap
      // is N. `deepen-relative`: until every boundary is found there is no cap (a boundary can
      // sit deeper than N from the tip); once they are found the cap is their generation plus N.
      // With no boundaries, deepen-relative falls back to the absolute depth.
      let cap: number | null;
      if (plan.depth === null) cap = null;
      else if (!plan.deepenRelative) cap = plan.depth;
      else if (boundarySet.size === 0) cap = plan.depth;
      else if (boundariesFound >= boundarySet.size && baseGen > 0) cap = baseGen + plan.depth;
      else cap = null;
      if (cap !== null && depth >= cap) continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  let effectiveDepth = plan.depth;
  if (plan.deepenRelative && plan.depth !== null) {
    let base = 0;
    for (const boundary of plan.shallowBoundaries) {
      const gen = generation.get(boundary);
      if (gen !== undefined) base = Math.max(base, gen);
    }
    effectiveDepth = base > 0 ? base + plan.depth : plan.depth;
  }
  const included = new Set<string>();
  for (const [oid, depth] of generation) {
    if (effectiveDepth === null || depth <= effectiveDepth) included.add(oid);
  }
  // Shallow boundary: included commits with a parent that was cut (not included).
  const shallow: string[] = [];
  for (const oid of [...included].sort()) {
    const object = repo.objects.get(oid)!;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((p) => !included.has(p))) shallow.push(oid);
  }
  // Unshallow: old boundaries now fully included (all parents included).
  const unshallow: string[] = [];
  for (const boundary of plan.shallowBoundaries) {
    if (!included.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.every((p) => included.has(p))) unshallow.push(boundary);
  }
  // Objects the client already has. A `have` is normally the commit plus its whole history — but
  // a have that is also a shallow boundary is only the commit and its tree: the client's depth-1
  // clone never held its parents, which is exactly what a deepen fetch must deliver.
  const shallowSet = new Set(plan.shallowBoundaries);
  const haveClosure = new Set<string>();
  for (const have of plan.haves) {
    try {
      if (shallowSet.has(have)) {
        const object = repo.objects.get(have);
        if (object?.type === 'commit') {
          haveClosure.add(have);
          const tree = parseCommit(object.data).tree;
          for (const oid of collectReachable([tree], lookup, { allowMissing: true })) haveClosure.add(oid);
        } else {
          for (const oid of collectReachable([have], lookup, { allowMissing: true })) haveClosure.add(oid);
        }
      } else {
        for (const oid of collectReachable([have], lookup, { allowMissing: true })) haveClosure.add(oid);
      }
    } catch {
      // a have the server cannot resolve is ignored
    }
  }
  // Objects: for each included commit, the commit itself plus its tree and blobs — never the
  // parents (a depth limit cuts the history, so a plain reachability walk would over-send).
  const send = new Set<string>();
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    send.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    for (const blobOid of collectReachable([tree], lookup, { allowMissing: true })) {
      if (!haveClosure.has(blobOid)) send.add(blobOid);
    }
  }
  for (const oid of extraObjects.keys()) if (!haveClosure.has(oid)) send.add(oid);
  const objects = [...send].sort().map((oid) => repo.objects.get(oid)!).filter(Boolean);
  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of plan.haves) {
    if (plan.wants.includes(have)) {
      acks.push(have);
      continue;
    }
    for (const want of wantCommits) {
      if (isAncestor(have, want, lookup)) {
        acks.push(have);
        break;
      }
    }
  }
  return { objects, shallow, unshallow, acks: [...new Set(acks)] };
}

function packSection(objects: GitObject[]): Buffer[] {
  const pack = writePack(objects);
  return [encodePktLine('packfile\n'), ...sidebandPackets(1, pack), pktLineFlush()];
}

export function handleUploadPack(store: Store, req: GitRequest): GitResponse {
  if (req.owner !== VIEWER.login) return json404();
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) return json404();

  let lines: string[];
  try {
    const decoded = decodePktLinesUntilFlush(req.body);
    lines = decoded.lines;
  } catch (err) {
    return json400(`malformed pkt-line request: ${(err as Error).message}`);
  }
  if (lines.length === 0) return json400('empty upload-pack request');
  const first = lines[0]!;

  if (first.startsWith('command=')) {
    // Protocol v2.
    const command = first.slice('command='.length).trim();
    const delimAt = lines.indexOf('\u0001');
    const args = (delimAt >= 0 ? lines.slice(delimAt + 1) : lines.slice(1)).map((l) => l.replace(/\n$/, ''));
    if (command === 'ls-refs') {
      return { status: 200, contentType: RES_UPLOAD, body: lsRefsResponse(repo, args) };
    }
    if (command !== 'fetch') return json400(`unknown v2 command ${JSON.stringify(command)}`);
    const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null, deepenRelative: false };
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) plan.shallowBoundaries.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) plan.depth = Number.parseInt(arg.slice(7).trim(), 10);
      else if (arg === 'deepen-relative') plan.deepenRelative = true;
      else if (arg === 'done') done = true;
    }
    for (const want of plan.wants) {
      if (!isObjectId(want) || !repo.objects.has(want)) return json400(`unknown object ${want}`);
    }
    const result = planFetch(repo, plan);
    // Protocol v2, as git's fetch-pack.c reads it: a request that carries `done` makes the
    // client skip the acknowledgments section entirely and go straight to expecting (in order)
    // shallow-info, wanted-refs, packfile-uris, packfile — so the server must NOT send an
    // acknowledgments section in answer to a `done` request, or the client dies with
    // "expected 'packfile', received 'acknowledgments'". The acknowledgments section is only
    // for a negotiation round (no `done`): ACKs plus `ready` and a DELIM when a packfile follows
    // in the same response, or a bare NAK and a FLUSH when the client must send another round.
    // Sections are separated by delim packets (0001); only the response's end is a flush (0000).
    // (The suite's parser reads sections by name and accepts either shape, so this suits both.)
    const parts: Buffer[] = [];
    if (done) {
      if (result.shallow.length || result.unshallow.length || plan.depth !== null || plan.shallowBoundaries.length) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
        parts.push(pktLineDelim());
      }
      parts.push(...packSection(result.objects));
      return { status: 200, contentType: RES_UPLOAD, body: Buffer.concat(parts) };
    }
    parts.push(encodePktLine('acknowledgments\n'));
    if (result.acks.length) {
      for (const ack of result.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
      parts.push(pktLineDelim());
      if (result.shallow.length || result.unshallow.length || plan.depth !== null || plan.shallowBoundaries.length) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
        parts.push(pktLineDelim());
      }
      parts.push(...packSection(result.objects));
    } else {
      parts.push(encodePktLine('NAK\n'));
      parts.push(pktLineFlush());
    }
    return { status: 200, contentType: RES_UPLOAD, body: Buffer.concat(parts) };
  }

  // Protocol v0 fetch: wants (with optional caps) + shallow/deepen, flush, haves + done, flush.
  // The body was decoded only to the first flush; re-split the whole body into sections.
  const sections: string[][] = [];
  let rest = req.body;
  for (;;) {
    let decoded;
    try {
      decoded = decodePktLinesUntilFlush(rest);
    } catch (err) {
      return json400(`malformed pkt-line request: ${(err as Error).message}`);
    }
    sections.push(decoded.lines);
    rest = rest.subarray(decoded.rest);
    if (rest.length === 0) break;
    // A second section follows; if it does not start with a pkt-line, it is not a v0 fetch.
    if (!/^[0-9a-fA-F]{4}$/.test(rest.subarray(0, 4).toString('ascii'))) break;
  }
  const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null, deepenRelative: false };
  for (const line of sections[0] ?? []) {
    const clean = line.replace(/\n$/, '').split('\0')[0]!;
    if (clean.startsWith('want ')) plan.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) plan.shallowBoundaries.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) plan.depth = Number.parseInt(clean.slice(7).trim(), 10);
    else if (clean === 'deepen-relative') plan.deepenRelative = true;
  }
  for (const line of sections[1] ?? []) {
    const clean = line.replace(/\n$/, '');
    if (clean.startsWith('have ')) plan.haves.push(clean.slice(5).trim());
  }
  if (!plan.wants.length) return json400('v0 fetch with no want lines');
  for (const want of plan.wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) return json400(`unknown object ${want}`);
  }
  const result = planFetch(repo, plan);
  const parts: Buffer[] = [];
  if (result.acks.length) {
    for (const ack of result.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(1, writePack(result.objects)));
  parts.push(pktLineFlush());
  return { status: 200, contentType: RES_UPLOAD, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, req: GitRequest): GitResponse {
  if (req.owner !== VIEWER.login) return json404();
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) return json404();

  let decoded: { lines: string[]; rest: number };
  try {
    decoded = decodePktLinesUntilFlush(req.body);
  } catch (err) {
    return json400(`malformed pkt-line request: ${(err as Error).message}`);
  }
  const commands: PushCommand[] = [];
  let useSideband = false;
  for (let i = 0; i < decoded.lines.length; i += 1) {
    const raw = decoded.lines[i]!.replace(/\n$/, '');
    const nul = raw.indexOf('\0');
    const head = nul >= 0 ? raw.slice(0, nul) : raw;
    if (i === 0 && nul >= 0) {
      const caps = raw.slice(nul + 1).split(' ');
      useSideband = caps.includes('side-band-64k');
    }
    const parts = head.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      return json400(`bad receive-pack command ${JSON.stringify(head.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (!commands.length) return json400('receive-pack with no commands');

  const packBytes = req.body.subarray(decoded.rest);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, { resolveBase: lookup });
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 120);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new tip's closure must be present. A fast-forward's new history is
    // only the commits after the old tip — everything behind the old tip is already stored and
    // was verified when it was set — so the walk stops at the old tip instead of re-walking the
    // whole history on every push (which would make 200 sequential pushes quadratic).
    // A tag ref's tip is peeled to its commit for the walk and the fast-forward check: a tag
    // oid itself never appears in a commit's ancestry.
    const currentCommit = current === undefined ? null : (store.peelToCommit(repo, current) ?? current);
    let closureOk = true;
    {
      const queue: string[] = [command.newOid];
      const seen = new Set<string>();
      const stopAt = currentCommit;
      while (queue.length && closureOk) {
        const oid = queue.pop()!;
        if (oid === stopAt || seen.has(oid)) continue;
        seen.add(oid);
        const object = lookup(oid);
        if (!object) {
          closureOk = false;
          break;
        }
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          queue.push(commit.tree);
          for (const parent of commit.parents) queue.push(parent);
        } else if (object.type === 'tag') {
          queue.push(parseTag(object.data).object);
        } else if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) {
            if (entry.mode !== '160000') queue.push(entry.oid);
          }
        }
      }
    }
    if (!closureOk) {
      results.push({ ref: command.ref, ok: false, reason: 'missing objects' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (currentCommit === null || !isAncestor(currentCommit, command.newOid, lookup)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  report.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const result of results) {
    report.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  // The report-status stream. A real git server terminates the report *inside* band 1 with a
  // pkt-line flush, then ends the outer stream with its own flush: the band-1 bytes are
  // `unpack ok` / `ok|ng <ref> ...` lines followed by `0000`, and only then the outer `0000`.
  // Real git's client reads the report to that inner flush; without it it reports "the remote
  // end hung up unexpectedly" even though the refs were updated. (The suite's parser only keeps
  // data packets, so the inner flush is harmless there too.)
  const parts: Buffer[] = [];
  if (useSideband) {
    // Band-1 payload: the report lines plus the inner flush; then the outer flush.
    parts.push(...sidebandPackets(1, Buffer.concat([encodePktLines(report.map((line) => `${line}\n`)), pktLineFlush()])));
    parts.push(pktLineFlush());
  } else {
    // No sideband: the report lines plus a single flush.
    parts.push(encodePktLines(report.map((line) => `${line}\n`)));
    parts.push(pktLineFlush());
  }
  repo.updatedAt = nowIso();
  return { status: 200, contentType: RES_RECEIVE, body: Buffer.concat(parts) };
}
