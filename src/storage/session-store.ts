import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AIMessage, ToolCallRequest } from '../core/providers/interface.js';
import type { InvestigationRun } from '../core/models/investigation.js';

export interface Session {
  id: string;
  title: string;
  namespace: string;
  context?: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredInvestigation {
  id: string;
  sessionId: string;
  prompt: string;
  status: string;
  toolCallCount: number;
  reportJson?: string;
  conversationalResponse?: string;
  createdAt: number;
}

export class SessionStore {
  private db: any = null;
  private dbPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = customPath;
    } else {
      const baseDir = path.join(os.homedir(), '.opspilot');
      if (!fs.existsSync(baseDir)) {
        try {
          fs.mkdirSync(baseDir, { recursive: true });
        } catch {}
      }
      this.dbPath = path.join(baseDir, 'opspilot.db');
    }
  }

  async init(): Promise<void> {
    if (this.db) return;

    if (typeof (process.versions as any)?.bun !== 'undefined') {
      const { Database } = await import('bun:sqlite');
      this.db = new Database(this.dbPath);
    } else {
      const { default: Database } = await import('better-sqlite3');
      this.db = new Database(this.dbPath);
    }

    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        namespace TEXT NOT NULL,
        context TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        tool_call_count INTEGER NOT NULL,
        report_json TEXT,
        conversational_response TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_investigations_session ON investigations(session_id);
    `);
  }

  async createSession(data: {
    id?: string;
    title?: string;
    namespace: string;
    context?: string;
    provider: string;
    model: string;
  }): Promise<Session> {
    await this.init();
    const id = data.id || `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const title = data.title || `Investigation in ${data.namespace}`;

    this.db
      .prepare(
        `INSERT INTO sessions (id, title, namespace, context, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, title, data.namespace, data.context || null, data.provider, data.model, now, now);

    return {
      id,
      title,
      namespace: data.namespace,
      context: data.context,
      provider: data.provider,
      model: data.model,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    await this.init();
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      namespace: row.namespace,
      context: row.context || undefined,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listSessions(limit = 20): Promise<Session[]> {
    await this.init();
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      namespace: r.namespace,
      context: r.context || undefined,
      provider: r.provider,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async updateSessionTitle(id: string, title: string): Promise<void> {
    await this.init();
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  async updateSession(
    id: string,
    updates: Partial<Pick<Session, 'title' | 'namespace' | 'model' | 'context'>>
  ): Promise<void> {
    await this.init();
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.namespace !== undefined) {
      fields.push('namespace = ?');
      values.push(updates.namespace);
    }
    if (updates.model !== undefined) {
      fields.push('model = ?');
      values.push(updates.model);
    }
    if (updates.context !== undefined) {
      fields.push('context = ?');
      values.push(updates.context);
    }

    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async saveMessages(sessionId: string, messages: AIMessage[]): Promise<void> {
    await this.init();
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === 'system') continue; // Don't persist redundant system instructions

      const msgId = `msg_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`;
      let toolCallsJson: string | null = null;
      let toolCallId: string | null = null;
      let toolName: string | null = null;

      if (msg.role === 'assistant' && msg.toolCalls) {
        toolCallsJson = JSON.stringify(msg.toolCalls);
      } else if (msg.role === 'tool') {
        toolCallId = msg.toolCallId;
        toolName = msg.toolName;
      }

      insert.run(
        msgId,
        sessionId,
        msg.role,
        msg.content || null,
        toolCallsJson,
        toolCallId,
        toolName,
        now + i
      );
    }

    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  }

  async getMessages(sessionId: string): Promise<AIMessage[]> {
    await this.init();
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as any[];

    return rows.map((r): AIMessage => {
      if (r.role === 'user') {
        return { role: 'user', content: r.content || '' };
      }
      if (r.role === 'assistant') {
        const toolCalls: ToolCallRequest[] | undefined = r.tool_calls
          ? JSON.parse(r.tool_calls)
          : undefined;
        return { role: 'assistant', content: r.content || undefined, toolCalls };
      }
      if (r.role === 'tool') {
        return {
          role: 'tool',
          toolCallId: r.tool_call_id || '',
          toolName: r.tool_name || '',
          content: r.content || '',
        };
      }
      return { role: 'system', content: r.content || '' };
    });
  }

  async saveInvestigation(run: InvestigationRun, sessionId: string): Promise<void> {
    await this.init();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO investigations (id, session_id, prompt, status, tool_call_count, report_json, conversational_response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        sessionId,
        run.prompt,
        run.status,
        run.toolCallCount,
        run.report ? JSON.stringify(run.report) : null,
        run.conversationalResponse || null,
        now
      );

    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  }

  async getInvestigations(sessionId: string): Promise<StoredInvestigation[]> {
    await this.init();
    const rows = this.db
      .prepare('SELECT * FROM investigations WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as any[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      prompt: r.prompt,
      status: r.status,
      toolCallCount: r.tool_call_count,
      reportJson: r.report_json || undefined,
      conversationalResponse: r.conversational_response || undefined,
      createdAt: r.created_at,
    }));
  }

  async deleteSession(id: string): Promise<void> {
    await this.init();
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM investigations WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
