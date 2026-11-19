/// <reference lib="webworker" />

import { WorkerBrokerRequest, WorkerStorageCore } from '../engine/workerStorageCore';

const core = new WorkerStorageCore();

self.onmessage = async (event: MessageEvent<WorkerBrokerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || typeof msg.type !== 'string') {
    return;
  }

  try {
    const { payload, transfer } = await core.handleMessage(msg);
    self.postMessage(
      {
        id: msg.id,
        ok: true,
        payload,
      },
      transfer,
    );
  } catch (err) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
