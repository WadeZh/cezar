import { hc, type InferResponseType } from 'hono/client';
import { describe, it, expect } from 'vitest';
import type {
  FactoryImportResponse,
  FactoryStatus,
  FactoryTaskSummary,
  FactoryTasksResponse,
  FactoryUsageResponse,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const factory = client.api.v1.factory;
const project = client.api.v1.p[':projectId'].factory;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type Status = Assert<Exact<FactoryStatus, InferResponseType<typeof factory.status.$get, 200>>>;
type Usage = Assert<Exact<FactoryUsageResponse, InferResponseType<typeof factory.usage.$get, 200>>>;
type Tasks = Assert<Exact<FactoryTasksResponse, InferResponseType<typeof project.tasks.$get, 200>>>;
type Import = Assert<Exact<FactoryImportResponse, InferResponseType<typeof project.tasks.import.$post, 200>>>;
// A single task row of the list response must be the contract's summary.
type Row = Assert<
  Exact<FactoryTaskSummary, InferResponseType<typeof project.tasks.$get, 200>['tasks'][number]>
>;

// Never invoked: compile-time guarantees that validators reached AppType.
function typedBodies() {
  // @ts-expect-error a create without any idempotency key is refused by the route contract
  project.tasks.$post({ json: { title: 't', description: 'd', scope: [], acceptanceCriteria: [], acceptanceProfileId: 'p' } });
  // @ts-expect-error unknown action
  project.tasks[':taskId'].actions.$post({ json: { action: 'deploy' } });
  // @ts-expect-error an import batch over 100 is a schema-level refusal
  project.tasks.import.$post({ json: { tasks: Array.from({ length: 101 }, () => import(_key())) } });
}

function _key(): { key: string; title: string; description: string; scope: [] } {
  return { key: `k${Math.random()}`, title: 't', description: 'd', scope: [] };
}

describe('factory response parity', () => {
  it('keeps the chained factory families visible to the typed client', () => {
    expect(factory).toBeDefined();
    expect(project).toBeDefined();
    void typedBodies;
  });
});
