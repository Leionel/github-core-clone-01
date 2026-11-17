// GitHub GraphQL v4: a small parser + executor for the documents gh and github-mcp-server
// actually send (checks-graphql.ts GRAPHQL_DOCUMENTS). No general schema engine: the parser
// covers the subset (operations, variables, arguments, aliases, inline fragments, input objects,
// lists, enums) and the executor resolves against the same store as REST/MCP.

import { decodeGlobalId, issueGlobalId, nowIso, pullGlobalId, repoGlobalId, type Issue, type Pull, type Repo, type Store, VIEWER } from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface Selection {
  field: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: Selection[];
  fragmentOn: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'var'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
      if (!m) throw new Error('bad variable in GraphQL document');
      tokens.push({ type: 'var', value: m[0].slice(1) });
      i += m[0].length;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(i));
      if (!m) throw new Error('bad number in GraphQL document');
      tokens.push({ type: m[0].includes('.') || /[eE]/.test(m[0]) ? 'float' : 'int', value: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
      tokens.push({ type: 'name', value: m![0] });
      i += m![0].length;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@|&'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.type !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${JSON.stringify(tok)}`);
  }
  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok?.type === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const tok = this.next();
    if (tok.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(tok)}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek();
    if (tok?.type === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      kind = tok.value;
      this.pos += 1;
      const next = this.peek();
      if (next?.type === 'name') name = this.next().value as string;
    }
    // Variable definitions: skip the parenthesised list (names are resolved from `variables`).
    if (this.acceptPunct('(')) {
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.type === 'punct' && t.value === '(') depth += 1;
        if (t.type === 'punct' && t.value === ')') depth -= 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.type === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    // Inline fragment: ... on Type { ... }
    if (this.peek()?.type === 'punct' && this.peek()!.value === '...') {
      this.pos += 1;
      const on = this.peek();
      let fragmentOn: string | null = null;
      if (on?.type === 'name' && on.value === 'on') {
        this.pos += 1;
        fragmentOn = this.expectName();
      } else {
        throw new Error('named fragments are not supported');
      }
      const selections = this.parseSelectionSet();
      return { field: '', alias: null, args: {}, selections, fragmentOn };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let field = first;
    if (this.acceptPunct(':')) {
      alias = first;
      field = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.acceptPunct('(')) {
      while (!(this.peek()?.type === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.peek()?.type === 'punct' && this.peek()!.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { field, alias, args, selections, fragmentOn: null };
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok.type === 'var') return { kind: 'var', name: tok.value };
    if (tok.type === 'string') return { kind: 'string', value: tok.value };
    if (tok.type === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.type === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.type === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.type === 'punct' && tok.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek()?.type === 'punct' && this.peek()!.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.type === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.type === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(tok)} in GraphQL document`);
  }
}

function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema (field lists, for unknown-field detection and introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
    'description', 'isPrivate', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'closedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'fields', 'enumValues', 'kind', 'description'],
  __Schema: ['queryType', 'mutationType'],
  Ref: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

class FieldError extends Error {}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}
function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}
function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}
function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number.parseInt(decoded.parts[1]!, 10);
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const dbId = Number.parseInt(decoded.parts[1]!, 10);
  const number = Number.parseInt(decoded.parts[2]!, 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const dbId = Number.parseInt(decoded.parts[1]!, 10);
  const number = Number.parseInt(decoded.parts[2]!, 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.get(number);
    if (pull) return { repo, pull };
  }
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => direction * (a.seq - b.seq));
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterNum = cursorNumber(args.after as string | null | undefined);
  if (afterNum !== null) {
    const idx = issues.findIndex((i) => i.number === afterNum);
    if (idx >= 0) issues = issues.slice(idx + 1);
    else if (direction < 0) issues = issues.filter((i) => i.number < afterNum);
    else issues = issues.filter((i) => i.number > afterNum);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length ? cursorFor(page[0]!.number) : null },
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: pulls.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
    totalCount: pulls.length,
  };
}

function resolveField(store: Store, obj: GqlObject, field: string, args: Record<string, unknown>): unknown {
  const typename = obj.__typename;
  switch (typename) {
    case 'Query': {
      if (field === 'viewer') return userObject();
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, name);
        return repo ? repoObject(repo) : null;
      }
      if (field === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoByGlobalId(store, id);
          return repo ? repoObject(repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(store, id);
          return found ? issueObject(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, id);
          return found ? pullObject(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        const fields = SCHEMA_FIELDS[name];
        const enums = ENUM_VALUES[name];
        if (!fields && !enums) return null;
        return {
          __typename: '__Type',
          name,
          kind: enums ? 'ENUM' : 'OBJECT',
          description: null,
          fields: fields ? fields.map((f) => ({ name: f })) : null,
          enumValues: enums ? enums.map((e) => ({ name: e })) : null,
        };
      }
      if (field === '__schema') return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new FieldError(`repository ${String(input.repositoryId ?? '')} not found`);
        const title = String(input.title ?? '');
        if (!title) throw new FieldError('title is required');
        const issue = store.createIssue(repo, title, String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
        if (!found) throw new FieldError(`issue ${String(input.issueId ?? '')} not found`);
        found.issue.state = 'closed';
        found.issue.closedAt = nowIso();
        return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new FieldError(`repository ${String(input.repositoryId ?? '')} not found`);
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = store.refCommit(repo, `refs/heads/${head}`);
        const baseSha = store.refCommit(repo, `refs/heads/${base}`);
        if (headSha === null || baseSha === null) throw new FieldError('head or base branch does not exist');
        const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, headSha, base, baseSha);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
        if (!found) throw new FieldError(`pull request ${String(input.pullRequestId ?? '')} not found`);
        const result = store.mergePull(found.repo, found.pull);
        if ('error' in result) throw new FieldError(result.error);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull) };
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
        if (!found) throw new FieldError(`subject ${String(input.subjectId ?? '')} not found`);
        const comment = {
          id: found.repo.nextCommentId++,
          body: String(input.body ?? ''),
          userLogin: VIEWER.login,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: { __typename: 'IssueComment', id: `comment-${comment.id}`, body: comment.body },
            cursor: cursorFor(found.issue.number),
          },
        };
      }
      break;
    }
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return obj.id;
      if (field === 'name') return obj.name;
      if (field === 'email') return obj.email;
      if (field === 'avatarUrl') return null;
      break;
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      if (field === 'id') return repoGlobalId(repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userObject();
      if (field === 'defaultBranchRef') {
        const tip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
        return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.private;
      if (field === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'updatedAt') return repo.updatedAt;
      if (field === 'issue') {
        const number = args.number as number;
        const issue = repo.issues.get(number);
        return issue ? issueObject(repo, issue) : null;
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequests') return pullsConnection(repo, args);
      if (field === 'pullRequest') {
        const number = args.number as number;
        const pull = repo.pulls.get(number);
        return pull ? pullObject(repo, pull) : null;
      }
      break;
    }
    case 'Issue': {
      const issue = obj.issue as Issue;
      const repo = obj.repo as Repo;
      if (field === 'id') return issueGlobalId(repo.id, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issue.state.toUpperCase();
      if (field === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'closedAt') return issue.closedAt;
      if (field === 'author') return userObject();
      if (field === 'labels') return { __typename: 'LabelConnection', nodes: issue.labels.map((n) => ({ __typename: 'Label', name: n })) };
      if (field === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: `comment-${c.id}`, body: c.body })),
        };
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.totalCount;
      if (field === 'edges') return (obj.nodes as unknown[]).map((node) => ({ __typename: 'IssueEdge', node, cursor: null }));
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull as Pull;
      const repo = obj.repo as Repo;
      if (field === 'id') return pullGlobalId(repo.id, pull.number);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return store.pullMergeable(repo, pull);
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (field === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'closedAt') return pull.closedAt;
      if (field === 'author') return userObject();
      if (field === 'files') {
        const first = typeof args.first === 'number' ? args.first : 30;
        const files = store.pullFiles(repo, pull).slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes, status: f.status })),
        };
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return obj.additions;
      if (field === 'deletions') return obj.deletions;
      if (field === 'changes') return obj.changes;
      if (field === 'status') return obj.status;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'endCursor') return obj.endCursor;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field === 'startCursor') return obj.startCursor;
      break;
    }
    case 'IssueComment': {
      if (field === 'id') return obj.id;
      if (field === 'body') return obj.body;
      if (field === 'author') return userObject();
      if (field === 'createdAt') return obj.createdAt ?? null;
      if (field === 'updatedAt') return obj.updatedAt ?? null;
      break;
    }
    case 'Label': {
      if (field === 'name') return obj.name;
      break;
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      break;
    }
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'kind') return obj.kind;
      if (field === 'description') return obj.description;
      if (field === 'fields') return obj.fields;
      if (field === 'enumValues') return obj.enumValues;
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return obj.queryType;
      if (field === 'mutationType') return obj.mutationType;
      break;
    }
    case 'IssueEdge':
    case 'CommentEdge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      break;
    }
    case 'LabelConnection':
    case 'IssueCommentConnection': {
      if (field === 'nodes') return obj.nodes;
      break;
    }
    default: {
      // Payload wrappers (CreateIssuePayload etc.): fields are the nested objects.
      if (field === 'issue' || field === 'pullRequest' || field === 'commentEdge') return obj[field];
      break;
    }
  }
  return undefined;
}

function isGqlObject(value: unknown): value is GqlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as GqlObject).__typename === 'string';
}

function executeSelections(
  store: Store,
  obj: GqlObject,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentOn !== null) {
      if (selection.fragmentOn !== obj.__typename) continue;
      const nested = executeSelections(store, obj, selection.selections, variables, errors, path);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.field;
    const fields = SCHEMA_FIELDS[obj.__typename];
    if (!fields || !fields.includes(selection.field)) {
      // Unknown field: a validation error; the whole operation fails with data null.
      errors.push({
        message: `Cannot query field "${selection.field}" on type "${obj.__typename}".`,
        path: [...path, key],
      });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(selection.args)) args[name] = evalValue(value, variables);
    let value: unknown;
    try {
      value = resolveField(store, obj, selection.field, args);
    } catch (err) {
      if (err instanceof FieldError) {
        errors.push({ message: err.message, path: [...path, key] });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${selection.field}" on type "${obj.__typename}".`, path: [...path, key] });
      continue;
    }
    out[key] = applySelections(store, value, selection.selections, variables, errors, [...path, key]);
  }
  return out;
}

function applySelections(
  store: Store,
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: Array<string | number>,
): unknown {
  if (!selections.length) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => applySelections(store, item, selections, variables, errors, [...path, i]));
  }
  if (isGqlObject(value)) {
    return executeSelections(store, value, selections, variables, errors, path);
  }
  // Plain objects (e.g. pageInfo, __Type field lists): resolve their keys directly.
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.field;
      const raw = (value as Record<string, unknown>)[selection.field];
      if (raw === undefined) {
        errors.push({ message: `Cannot query field "${selection.field}".`, path: [...path, key] });
        continue;
      }
      out[key] = applySelections(store, raw, selection.selections, variables, errors, [...path, key]);
    }
    return out;
  }
  return value;
}

export interface GqlResult {
  data: unknown;
  errors: GqlError[];
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'Syntax Error: empty document' }] };
  if (operations.length > 1) {
    return { data: null, errors: [{ message: 'This operation requires an operation name' }] };
  }
  const operation = operations[0]!;
  const root: GqlObject = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const errors: GqlError[] = [];
  const data = executeSelections(store, root, operation.selections, variables, errors, []);
  if (errors.some((e) => e.message.startsWith('Cannot query field'))) {
    return { data: null, errors };
  }
  return { data, errors };
}
