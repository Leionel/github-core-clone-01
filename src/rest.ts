// GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels,
// pull requests, files and merges. Shapes follow api.github.com; extra fields are allowed by
// the suite's shape checks, so responses are generous where GitHub is.

import { isObjectId, parseCommit } from './git.ts';
import {
  VIEWER,
  commentGlobalId,
  issueGlobalId,
  nowIso,
  pullGlobalId,
  repoGlobalId,
  walkCommits,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown; // undefined => no body (204)
  headers?: Record<string, string>;
}

const notFound = (message = 'Not Found'): RestResult => ({ status: 404, body: { message } });
const badRequest = (message: string): RestResult => ({ status: 400, body: { message } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', html_url: `https://example.invalid/${login}` };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    license: null,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `label-${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name };
    }),
    user: userJson(issue.userLogin, VIEWER.id),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull, mergeable?: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: mergeable ?? null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    user: userJson(pull.userLogin, VIEWER.id),
    assignee: null,
    assignees: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(comment.userLogin, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: line, email: '', date: repo.createdAt };
    return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]!) * 1000).toISOString() };
  };
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: author.email === VIEWER.email ? userJson(VIEWER.login, VIEWER.id) : null,
    committer: committer.email === VIEWER.email ? userJson(VIEWER.login, VIEWER.id) : null,
    parents: commit.parents.map((p) => ({ sha: p })),
    tree: { sha: commit.tree },
    url: `https://example.invalid/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(all: T[], query: URLSearchParams, baseUrl: string, path: string): Page<T> {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const links: string[] = [];
  const url = (p: number): string => `${baseUrl}${path}?${new URLSearchParams({ ...Object.fromEntries(query), per_page: String(perPage), page: String(p) }).toString()}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(totalPages)}>; rel="last"`);
  return { items, link: links.length ? links.join(', ') : null };
}

function pageHeaders(page: Page<unknown>): Record<string, string> {
  return page.link ? { link: page.link } : {};
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function bodyObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Resolve a branch name (or oid) to a commit oid, or null. */
function resolveRefCommit(store: Store, repo: Repo, ref: string): string | null {
  if (repo.refs.has(`refs/heads/${ref}`)) return store.refCommit(repo, `refs/heads/${ref}`);
  if (repo.refs.has(ref)) return store.refCommit(repo, ref);
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object?.type === 'commit') return ref;
    if (object?.type === 'tag') return store.peelToCommit(repo, ref);
  }
  return null;
}

function b64decode(content: unknown): Buffer | null {
  if (typeof content !== 'string') return null;
  try {
    const cleaned = content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  const path = `/${segments.join('/')}`;

  // API root and meta are public (no token needed); the server enforces auth elsewhere.
  if (method === 'GET' && (path === '/' || path === '')) {
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (method === 'GET' && path === '/meta') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (method === 'GET' && path === '/rate_limit') {
    const reset = Math.floor(Date.parse(nowIso()) / 1000) + 3600;
    return {
      status: 200,
      body: {
        resources: { core: { limit: 5000, remaining: 4999, reset, used: 1 }, search: { limit: 30, remaining: 30, reset, used: 0 } },
        rate: { limit: 5000, remaining: 4999, reset, used: 1 },
      },
    };
  }

  // GET /user
  if (method === 'GET' && path === '/user') {
    return { status: 200, body: { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email } };
  }

  // /user/repos
  if (path === '/user/repos') {
    if (method === 'GET') {
      const repos = store.ownerRepos(VIEWER.login);
      const page = paginate(repos, query, baseUrl, '/api/v3/user/repos');
      return { status: 200, body: page.items.map(repoJson), headers: pageHeaders(page) };
    }
    if (method === 'POST') {
      const b = bodyObject(body);
      const name = b ? asString(b.name) : undefined;
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return unprocessable('name is required');
      }
      const description = (b && asString(b.description)) ?? '';
      const isPrivate = (b && asBoolean(b.private)) ?? false;
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      if (!repo) return { status: 422, body: { message: `Repository ${VIEWER.login}/${name} already exists` } };
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }

  // /repos/:owner/:name[/...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const rest = segments.slice(3);
    return handleRepoRoute(store, method, owner, name, rest, query, body, baseUrl);
  }

  return notFound();
}

function handleRepoRoute(
  store: Store,
  method: string,
  owner: string,
  name: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  const repo = resolveRepo(store, owner, name);
  if (!repo) return notFound();
  const repoPath = `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // /repos/:owner/:name
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const b = bodyObject(body);
      if (b && asString(b.description) !== undefined) {
        repo.description = asString(b.description)!;
        repo.updatedAt = nowIso();
      }
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: undefined };
    }
    return notFound();
  }

  const head = rest[0]!;

  // branches
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! }, protected: false }));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound();
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  // git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = bodyObject(body);
      const ref = b ? asString(b.ref) : undefined;
      const sha = b ? asString(b.sha) : undefined;
      if (!ref || !ref.startsWith('refs/') || !sha || !isObjectId(sha)) {
        return unprocessable('ref and sha are required');
      }
      if (!repo.objects.has(sha)) return unprocessable(`object ${sha} does not exist`);
      if (repo.refs.has(ref)) return unprocessable(`ref ${ref} already exists`);
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha }, url: `${repoPath}/git/refs/${encodeURIComponent(ref)}` } };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return { status: 200, body: { ref, sha, object: { sha }, url: `${repoPath}/git/refs/${encodeURIComponent(ref)}` } };
    }
    return notFound();
  }

  // commits
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const refParam = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRefCommit(store, repo, refParam);
    if (!tip) return notFound();
    const commits: Array<Record<string, unknown>> = [];
    walkCommits(repo, tip, (oid) => {
      const json = commitJson(repo, oid);
      if (json) commits.push(json);
    });
    const page = paginate(commits, query, baseUrl, `${repoPath}/commits`);
    return { status: 200, body: page.items, headers: pageHeaders(page) };
  }

  // contents
  if (head === 'contents') {
    return handleContents(store, method, repo, rest.slice(1), query, body);
  }

  // labels
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].sort((a, b) => a.id - b.id).map(labelJson) };
    }
    if (method === 'POST' && rest.length === 1) {
      const b = bodyObject(body);
      const labelName = b ? asString(b.name) : undefined;
      if (!labelName) return unprocessable('name is required');
      const existing = repo.labels.get(labelName);
      if (existing) return { status: 201, body: labelJson(existing) };
      const label: Label = {
        id: repo.nextLabelId++,
        name: labelName,
        color: (b && asString(b.color)) ?? 'ededed',
        description: (b && asString(b.description)) ?? '',
      };
      repo.labels.set(labelName, label);
      return { status: 201, body: labelJson(label) };
    }
    return notFound();
  }

  // issues
  if (head === 'issues') {
    return handleIssues(store, method, repo, rest.slice(1), query, body, baseUrl, repoPath);
  }

  // pulls
  if (head === 'pulls') {
    return handlePulls(store, method, repo, rest.slice(1), query, body, baseUrl, repoPath);
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(
  store: Store,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const filePath = rest.map(decodeURIComponent).join('/');
  const branch = (bodyObject(body)?.branch as string | undefined) ?? query.get('ref') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = store.refCommit(repo, refName);

  if (method === 'GET') {
    if (!tip) return notFound();
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    if (filePath === '') {
      const entries = store.treeListDir(repo, tree, '');
      return {
        status: 200,
        body: entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          url: '',
        })),
      };
    }
    const blobOid = store.treeGetBlob(repo, tree, filePath);
    if (blobOid) {
      const data = repo.objects.get(blobOid)!.data;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: data.toString('base64'),
          sha: blobOid,
          url: '',
          html_url: '',
          git_url: '',
          download_url: '',
        },
      };
    }
    const entries = store.treeListDir(repo, tree, filePath);
    if (entries.length) {
      return {
        status: 200,
        body: entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          url: '',
        })),
      };
    }
    return notFound();
  }

  if (method === 'PUT') {
    const b = bodyObject(body);
    const message = b ? asString(b.message) : undefined;
    const content = b ? b.content : undefined;
    if (!message) return unprocessable('message is required');
    const data = b64decode(content);
    if (data === null) return unprocessable('content must be base64');
    if (filePath === '') return unprocessable('path is required');
    const isUnborn = !tip && branch === repo.defaultBranch;
    if (!tip && !isUnborn) return unprocessable(`branch ${branch} does not exist`);
    const currentBlob = tip ? store.treeGetBlob(repo, parseCommit(repo.objects.get(tip)!.data).tree, filePath) : null;
    const givenSha = b ? asString(b.sha) : undefined;
    if (givenSha !== undefined) {
      if (!currentBlob) return unprocessable('sha given but the file does not exist');
      if (givenSha.toLowerCase() !== currentBlob.toLowerCase()) {
        return { status: 409, body: { message: 'sha does not match the current blob' } };
      }
    } else if (currentBlob) {
      return unprocessable('sha is required to update an existing file');
    }
    const blobOid = store.putObject(repo, 'blob', data);
    const { commit } = store.commitFileChange(repo, refName, filePath, blobOid, message);
    return {
      status: currentBlob ? 200 : 201,
      body: {
        content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      },
    };
  }

  if (method === 'DELETE') {
    const b = bodyObject(body);
    const message = b ? asString(b.message) : undefined;
    const givenSha = b ? asString(b.sha) : undefined;
    if (!message) return unprocessable('message is required');
    if (!tip) return notFound();
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const currentBlob = store.treeGetBlob(repo, tree, filePath);
    if (!currentBlob) return notFound();
    if (givenSha !== undefined && givenSha.toLowerCase() !== currentBlob.toLowerCase()) {
      return { status: 409, body: { message: 'sha does not match the current blob' } };
    }
    const { commit } = store.commitFileChange(repo, refName, filePath, null, message);
    return { status: 200, body: { commit: { sha: commit, message } } };
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(
  store: Store,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const page = paginate(issues, query, baseUrl, `${repoPath}/issues`);
      return { status: 200, body: page.items.map((i) => issueJson(repo, i)), headers: pageHeaders(page) };
    }
    if (method === 'POST') {
      const b = bodyObject(body);
      const title = b ? asString(b.title) : undefined;
      if (!title) return unprocessable('title is required');
      const bodyText = (b && asString(b.body)) ?? '';
      const labels = Array.isArray(b?.labels) ? (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`label ${label} does not exist`);
      }
      const issue = store.createIssue(repo, title, bodyText, labels);
      return { status: 201, body: issueJson(repo, issue) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue = repo.issues.get(number);
  if (!issue) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const b = bodyObject(body);
      if (b) {
        const state = asString(b.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? nowIso() : null;
        }
        if (asString(b.title) !== undefined) issue.title = asString(b.title)!;
        if (asString(b.body) !== undefined) issue.body = asString(b.body)!;
        if (Array.isArray(b.labels)) {
          const labels = (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[];
          for (const label of labels) {
            if (!repo.labels.has(label)) return unprocessable(`label ${label} does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = nowIso();
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (rest.length === 2 && method === 'GET') {
      return { status: 200, body: issue.comments.map((c) => commentJson(repo, issue, c)) };
    }
    if (rest.length === 2 && method === 'POST') {
      const b = bodyObject(body);
      const text = b ? asString(b.body) : undefined;
      if (!text) return unprocessable('body is required');
      const comment: Comment = {
        id: repo.nextCommentId++,
        body: text,
        userLogin: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return { status: 201, body: commentJson(repo, issue, comment) };
    }
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function handlePulls(
  store: Store,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      const page = paginate(pulls, query, baseUrl, `${repoPath}/pulls`);
      return {
        status: 200,
        body: page.items.map((p) => pullJson(repo, p, p.state === 'open' ? store.pullMergeable(repo, p) : undefined)),
        headers: pageHeaders(page),
      };
    }
    if (method === 'POST') {
      const b = bodyObject(body);
      const title = b ? asString(b.title) : undefined;
      const head = b ? asString(b.head) : undefined;
      const base = b ? asString(b.base) : undefined;
      if (!title || !head || !base) return unprocessable('title, head and base are required');
      const bodyText = (b && asString(b.body)) ?? '';
      const headSha = store.refCommit(repo, `refs/heads/${head}`);
      const baseSha = store.refCommit(repo, `refs/heads/${base}`);
      if (headSha === null || baseSha === null) return unprocessable('head or base branch does not exist');
      const pull = store.createPull(repo, title, bodyText, head, headSha, base, baseSha);
      return { status: 201, body: pullJson(repo, pull, store.pullMergeable(repo, pull)) };
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: pullJson(repo, pull, pull.state === 'open' ? store.pullMergeable(repo, pull) : undefined) };
    }
    return notFound();
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const files = store.pullFiles(repo, pull).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    return { status: 200, body: files };
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    if (pull.state !== 'open') {
      return { status: 405, body: { message: 'pull request is not open' } };
    }
    const result = store.mergePull(repo, pull);
    if ('error' in result) {
      if (result.error === 'merge conflict') return { status: 405, body: { message: 'merge conflict' } };
      return unprocessable(result.error);
    }
    return {
      status: 200,
      body: { merged: true, sha: result.sha, message: 'Pull request successfully merged' },
    };
  }

  return notFound();
}
