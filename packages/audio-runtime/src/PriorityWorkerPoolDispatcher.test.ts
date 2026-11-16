import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityWorkerPoolDispatcher } from './PriorityWorkerPoolDispatcher';

describe('PriorityWorkerPoolDispatcher (Sections 11, 13 & 31)', () => {
  it('reserves at least 2 CPU cores on desktop and caps MOBILE_COMPANION to 1 worker slot', () => {
    const mobilePool = new PriorityWorkerPoolDispatcher(
      'MOBILE_COMPANION',
      () => async () => 'ok',
      { hardwareConcurrencyOverride: 8 },
    );
    assert.equal(mobilePool.getSlotCount(), 1);

    const desktopPool = new PriorityWorkerPoolDispatcher(
      'DESKTOP_STUDIO',
      () => async () => 'ok',
      { hardwareConcurrencyOverride: 8 },
    );
    assert.equal(desktopPool.getSlotCount(), 6);
  });

  it('preempts queued P3_BACKGROUND_BATCH tasks with incoming P0_REALTIME_PREVIEW tasks', async () => {
    const executionOrder: string[] = [];
    let releaseFirstWorkerTask!: () => void;

    const pool = new PriorityWorkerPoolDispatcher(
      'MOBILE_COMPANION',
      () => async (taskType, payload) => {
        const id = payload as string;
        executionOrder.push(id);
        if (id === 'p3_chunk_1') {
          await new Promise<void>((res) => {
            releaseFirstWorkerTask = res;
          });
        }
        return `done:${taskType}:${id}`;
      },
      { hardwareConcurrencyOverride: 4 },
    );

    const p1 = pool.dispatchTask({
      taskId: 't1',
      priority: 3,
      taskType: 'ASR_CHUNK',
      payload: 'p3_chunk_1',
    });

    const p2 = pool.dispatchTask({
      taskId: 't2',
      priority: 3,
      taskType: 'ASR_CHUNK',
      payload: 'p3_chunk_2',
    });

    const p0Preview = pool.dispatchTask({
      taskId: 't0_preview',
      priority: 0,
      taskType: 'SPLICE_PREVIEW',
      payload: 'p0_splice_preview',
    });

    releaseFirstWorkerTask();
    await Promise.all([p1, p2, p0Preview]);

    assert.deepEqual(executionOrder, ['p3_chunk_1', 'p0_splice_preview', 'p3_chunk_2']);
  });

  it('enforces backpressure on P3 tasks and skips aborted tasks in queue', async () => {
    let releaseSlot!: () => void;
    const pool = new PriorityWorkerPoolDispatcher(
      'MOBILE_COMPANION',
      () => async () => {
        await new Promise<void>((res) => {
          releaseSlot = res;
        });
        return 'ok';
      },
      { maxQueuedTasksBeforeBackpressure: 1 },
    );

    const firstRunning = pool.dispatchTask({
      taskId: 'run1',
      priority: 2,
      taskType: 'COMMIT',
      payload: {},
    });

    const abortCtrl = new AbortController();
    const queuedTask = pool.dispatchTask({
      taskId: 'q1',
      priority: 3,
      taskType: 'BATCH',
      payload: {},
      abortSignal: abortCtrl.signal,
    });

    // Queue now has 1 pending item -> next P3 task must hit backpressure
    await assert.rejects(
      () =>
        pool.dispatchTask({
          taskId: 'q2_overflow',
          priority: 3,
          taskType: 'BATCH',
          payload: {},
        }),
      /WORKER_POOL_BACKPRESSURE_LIMIT/,
    );

    abortCtrl.abort();
    releaseSlot();

    await firstRunning;
    await assert.rejects(() => queuedTask, /TASK_ABORTED_IN_QUEUE/);
  });
});
