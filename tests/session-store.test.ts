import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../src/storage/session-store.js';
import type { AIMessage } from '../src/core/providers/interface.js';
import type { InvestigationRun } from '../src/core/models/investigation.js';

describe('SessionStore (SQLite Session & History Persistence)', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(async () => {
    testDbPath = path.join(os.tmpdir(), `test-opspilot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SessionStore(testDbPath);
    await store.init();
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }
  });

  it('creates and retrieves a new session', async () => {
    const session = await store.createSession({
      namespace: 'zcinema',
      context: 'kind-first-cluster',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
    });

    expect(session.id).toBeDefined();
    expect(session.namespace).toBe('zcinema');
    expect(session.context).toBe('kind-first-cluster');
    expect(session.title).toBe('Investigation in zcinema');

    const fetched = await store.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.namespace).toBe('zcinema');
    expect(fetched?.model).toBe('gemini-3.5-flash-lite');
  });

  it('updates session title and fields', async () => {
    const session = await store.createSession({
      namespace: 'default',
      provider: 'mock',
      model: 'mock-model',
    });

    await store.updateSessionTitle(session.id, 'Pod crashloop investigation');
    let fetched = await store.getSession(session.id);
    expect(fetched?.title).toBe('Pod crashloop investigation');

    await store.updateSession(session.id, {
      namespace: 'production',
      model: 'gemini-3.5-flash',
    });
    fetched = await store.getSession(session.id);
    expect(fetched?.namespace).toBe('production');
    expect(fetched?.model).toBe('gemini-3.5-flash');
  });

  it('lists sessions in descending order of updated_at', async () => {
    const s1 = await store.createSession({ namespace: 'ns1', provider: 'mock', model: 'm1' });
    const s2 = await store.createSession({ namespace: 'ns2', provider: 'mock', model: 'm2' });

    const list = await store.listSessions(10);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.id).toBe(s2.id);
    expect(list[1]?.id).toBe(s1.id);
  });

  it('persists and retrieves messages maintaining strict sequence and serializing tool calls', async () => {
    const session = await store.createSession({ namespace: 'test-ns', provider: 'mock', model: 'm' });

    const messages: AIMessage[] = [
      { role: 'system', content: 'You are OpsPilot' }, // Should be ignored
      { role: 'user', content: 'Why is api pod restarting?' },
      {
        role: 'assistant',
        content: undefined,
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_pod_status',
            arguments: { namespace: 'test-ns', podName: 'api-123' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'get_pod_status',
        content: JSON.stringify({ phase: 'Running', restartCount: 3 }),
      },
      {
        role: 'assistant',
        content: 'The api pod restarted 3 times due to memory pressure.',
      },
    ];

    await store.saveMessages(session.id, messages);

    const loaded = await store.getMessages(session.id);
    expect(loaded.length).toBe(4); // System message omitted
    expect(loaded[0]?.role).toBe('user');
    expect(loaded[0]?.content).toBe('Why is api pod restarting?');

    const asstMsg = loaded[1];
    expect(asstMsg?.role).toBe('assistant');
    if (asstMsg?.role === 'assistant') {
      expect(asstMsg.toolCalls).toHaveLength(1);
      expect(asstMsg.toolCalls?.[0]?.name).toBe('get_pod_status');
    }

    const toolMsg = loaded[2];
    expect(toolMsg?.role).toBe('tool');
    if (toolMsg?.role === 'tool') {
      expect(toolMsg.toolCallId).toBe('call_1');
      expect(toolMsg.toolName).toBe('get_pod_status');
    }

    expect(loaded[3]?.role).toBe('assistant');
    expect(loaded[3]?.content).toContain('The api pod restarted 3 times');
  });

  it('saves and retrieves investigation runs with reports', async () => {
    const session = await store.createSession({ namespace: 'test-ns', provider: 'mock', model: 'm' });

    const mockRun: InvestigationRun = {
      id: 'run_test_123',
      prompt: 'Check cluster health',
      namespace: 'test-ns',
      status: 'COMPLETED',
      startedAt: Date.now() - 5000,
      completedAt: Date.now(),
      toolCallCount: 2,
      evidence: [],
      report: {
        id: 'rep_123',
        summary: 'All workloads are healthy.',
        observedFacts: [],
        hypotheses: [],
        recommendations: [],
        confidence: 'high',
      },
      auditLog: [],
    };

    await store.saveInvestigation(mockRun, session.id);

    const stored = await store.getInvestigations(session.id);
    expect(stored.length).toBe(1);
    expect(stored[0]?.id).toBe('run_test_123');
    expect(stored[0]?.prompt).toBe('Check cluster health');
    expect(stored[0]?.reportJson).toBeDefined();

    const parsedReport = JSON.parse(stored[0]!.reportJson!);
    expect(parsedReport.summary).toBe('All workloads are healthy.');
    expect(parsedReport.confidence).toBe('high');
  });

  it('deletes session and cascades deletion of its messages and investigations', async () => {
    const session = await store.createSession({ namespace: 'del-ns', provider: 'mock', model: 'm' });
    await store.saveMessages(session.id, [{ role: 'user', content: 'test msg' }]);

    await store.deleteSession(session.id);

    expect(await store.getSession(session.id)).toBeNull();
    expect(await store.getMessages(session.id)).toHaveLength(0);
    expect(await store.getInvestigations(session.id)).toHaveLength(0);
  });
});
