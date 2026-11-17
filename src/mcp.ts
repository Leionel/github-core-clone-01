// MCP over streamable HTTP (POST /mcp, one JSON body per request): the 2026-07-28 modern era
// (server/discover) and the legacy initialize handshake, the six github-mcp-server tools, and the
// JSON-RPC error codes the suite asserts. Tool results are both text (JSON) and structuredContent.

import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

export interface McpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === wanted) return tool;
    if ((ALIASES[tool.name] ?? []).some((a) => normalizeName(a) === wanted)) return tool;
    // A prefixed tool name (github__create_issue) still matches: the wanted name ends with it.
    if (wanted.endsWith(normalizeName(tool.name))) return tool;
  }
  return undefined;
}

type Args = Record<string, unknown>;

function arg(args: Args, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, tool: ToolDef, args: Args): Record<string, unknown> {
  const missing = tool.inputSchema.required.filter((key) => arg(args, key) === undefined);
  if (missing.length) return toolError(`missing required arguments: ${missing.join(', ')}`);

  const owner = String(arg(args, 'owner', 'owner_login', 'org', 'login', 'user') ?? VIEWER.login);
  const repoName = String(arg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name') ?? '');

  switch (tool.name) {
    case 'create_repo': {
      const name = String(arg(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name') ?? '');
      const description = String(arg(args, 'description', 'about', 'summary', 'body') ?? '');
      const isPrivate = Boolean(arg(args, 'private', 'is_private') ?? false);
      if (!name) return toolError('missing required argument: name');
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      if (!repo) return toolError(`repository ${VIEWER.login}/${name} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepoOrNull(store, owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepoOrNull(store, owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title', 'issue_title', 'subject') ?? '');
      const body = String(arg(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '');
      if (!title) return toolError('missing required argument: title');
      const issue = store.createIssue(repo, title, body, []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = getRepoOrNull(store, owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = String(arg(args, 'state', 'status') ?? 'open');
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return toolResult(issues.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = getRepoOrNull(store, owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const title = String(arg(args, 'title', 'pr_title', 'pull_request_title', 'subject') ?? '');
      const body = String(arg(args, 'body', 'description', 'content', 'text') ?? '');
      const head = String(arg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch') ?? '');
      const base = String(arg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch') ?? '');
      const headSha = store.refCommit(repo, `refs/heads/${head}`);
      const baseSha = store.refCommit(repo, `refs/heads/${base}`);
      if (headSha === null || baseSha === null) return toolError('head or base branch does not exist');
      const pull = store.createPull(repo, title, body, head, headSha, base, baseSha);
      return toolResult(pullJson(repo, pull, store.pullMergeable(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = getRepoOrNull(store, owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const number = Number(arg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'));
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`pull request ${number} not found`);
      const result = store.mergePull(repo, pull);
      if ('error' in result) return toolError(result.error);
      return toolResult({ merged: true, number: pull.number, state: pull.state, sha: result.sha, merge_commit_sha: result.sha });
    }
    default:
      return toolError(`unknown tool: ${tool.name}`);
  }
}

function getRepoOrNull(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function jsonRpc(id: unknown, result: unknown): McpResult {
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })),
  };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })),
  };
}

export function handleMcp(store: Store, method: string, rawBody: Buffer): McpResult {
  if (method === 'DELETE') {
    return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method not allowed' })) };
  }
  if (method !== 'POST') {
    return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method not allowed' })) };
  }
  const text = rawBody.toString('utf8');
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonRpcError(null, -32600, 'Invalid Request', 400);
    }
    request = parsed as Record<string, unknown>;
  } catch {
    // Parse error: answer 400 with -32700, echoing the id the client sent (424242 in the check).
    const m = /"id"\s*:\s*(\d+|"(?:[^"\\]|\\.)*")/.exec(text);
    let id: unknown = null;
    if (m) {
      const raw = m[1]!;
      id = raw.startsWith('"') ? JSON.parse(raw) : Number(raw);
    }
    return jsonRpcError(id, -32700, 'Parse error', 400);
  }

  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (rpcMethod === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return jsonRpc(id, {
      supportedVersions: [PREFERRED_REVISION],
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : '';
    const protocolVersion = LEGACY_REVISIONS.includes(requested) || requested === PREFERRED_REVISION ? requested : PREFERRED_REVISION;
    return jsonRpc(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (rpcMethod === 'notifications/initialized') {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (rpcMethod === 'tools/list') {
    return jsonRpc(id, { tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (!tool) return jsonRpcError(id, -32601, `unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Args;
    const result = callTool(store, tool, args);
    return jsonRpc(id, result);
  }
  if (isNotification) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (!rpcMethod) return jsonRpcError(id, -32600, 'Invalid Request');
  return jsonRpcError(id, -32601, `Method not found: ${rpcMethod}`);
}
