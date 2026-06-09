import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Delegation, DelegationListItem } from './types.ts';

type ResolveRootSessionID = (sessionID: string) => Promise<string>;

const DELEGATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

function assertValidPathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    path.isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label} "${value}".`);
  }
}

function formatPersistedOutput(delegation: Delegation, content: string): string {
  const title = delegation.title || delegation.id;
  const description = delegation.description || '(No description generated)';

  const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Started:** ${delegation.startedAt.toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || 'N/A'}

---

`;

  return header + content;
}

function parsePersistedDelegation(id: string, content: string): DelegationListItem {
  let title = '(loaded from storage)';
  let description = '';
  let agent: string | undefined;

  const titleMatch = content.match(/^# (.+)$/m);
  if (titleMatch) title = titleMatch[1];

  const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m);
  if (agentMatch) agent = agentMatch[1];

  const lines = content.split('\n');
  if (lines.length > 2 && lines[2]) {
    description = lines[2].slice(0, 150);
  }

  return {
    id,
    status: 'complete',
    title,
    description,
    agent,
  };
}

export class DelegationStorage {
  constructor(
    private baseDir: string,
    private resolveRootSessionID: ResolveRootSessionID,
  ) {}

  assertValidDelegationId(id: string): void {
    if (!DELEGATION_ID_PATTERN.test(id)) {
      throw new Error(`Invalid delegation ID "${id}".`);
    }
  }

  assertValidSessionId(sessionID: string): void {
    assertValidPathSegment(sessionID, 'session ID');
  }

  async getDelegationsDir(sessionID: string): Promise<string> {
    this.assertValidSessionId(sessionID);

    const rootID = await this.resolveRootSessionID(sessionID);
    assertValidPathSegment(rootID, 'root session ID');

    return path.join(this.baseDir, rootID);
  }

  async validateSessionRoot(sessionID: string): Promise<void> {
    await this.getDelegationsDir(sessionID);
  }

  async ensureDelegationsDir(sessionID: string): Promise<string> {
    const dir = await this.getDelegationsDir(sessionID);
    await fs.mkdir(dir, { recursive: true });

    return dir;
  }

  async persistOutput(delegation: Delegation, content: string): Promise<string> {
    this.assertValidDelegationId(delegation.id);

    const dir = await this.ensureDelegationsDir(delegation.parentSessionID);
    const filePath = path.join(dir, `${delegation.id}.md`);

    await fs.writeFile(filePath, formatPersistedOutput(delegation, content), 'utf8');

    return filePath;
  }

  async readOutput(sessionID: string, id: string): Promise<string | undefined> {
    this.assertValidDelegationId(id);

    const dir = await this.getDelegationsDir(sessionID);
    const filePath = path.join(dir, `${id}.md`);

    try {
      await fs.access(filePath);

      return await fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  async listPersistedDelegations(sessionID: string): Promise<DelegationListItem[]> {
    const results: DelegationListItem[] = [];
    const dir = await this.getDelegationsDir(sessionID);

    try {
      const files = await fs.readdir(dir);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const id = file.replace('.md', '');
        if (!DELEGATION_ID_PATTERN.test(id)) continue;

        try {
          const filePath = path.join(dir, file);
          const content = await fs.readFile(filePath, 'utf8');
          results.push(parsePersistedDelegation(id, content));
        } catch {
          results.push({
            id,
            status: 'complete',
            title: '(loaded from storage)',
            description: '',
          });
        }
      }
    } catch {
      // Directory may not exist yet.
    }

    return results;
  }

  async deleteOutput(sessionID: string, id: string): Promise<boolean> {
    this.assertValidDelegationId(id);
    const dir = await this.getDelegationsDir(sessionID);

    try {
      const filePath = path.join(dir, `${id}.md`);
      await fs.unlink(filePath);

      return true;
    } catch {
      return false;
    }
  }
}
