export const title = 'Agent Run Lifecycle';

export const colors = {
  queued: 'blue',
  running: 'orange',
  unconfirmed: 'purple',
  terminal: 'teal',
  broken: 'pink',
};

const queueLabel = (jobState) => {
  switch (jobState) {
    case 'none':
      return 'No Job';
    case 'waiting':
      return 'Job Waiting';
    case 'active':
      return 'Job Active';
    case 'completed':
      return 'Job Completed';
    case 'failed':
      return 'Job Failed';
    default:
      return String(jobState);
  }
};

const runLabel = (v) => {
  if (v.dbStatus === 'failed' && v.errorKind === 'infra' && !v.startedAt) {
    return 'Enqueue Failed (Infra)';
  }
  if (v.dbStatus === 'running' && v.pendingFinish !== 'none') {
    return `Pending Finish (${v.pendingFinish})`;
  }
  switch (v.dbStatus) {
    case 'queued':
      return 'Queued';
    case 'running':
      return v.sandboxId ? 'Running (Sandbox)' : 'Running (Starting)';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return String(v.dbStatus);
  }
};

export const state = (v) => ({
  Run: runLabel(v),
  Queue: queueLabel(v.jobState),
});

export const group = (v) => {
  if (v.overwrotePendingFinish) return 'broken';
  if (v.pendingFinish !== 'none') return 'unconfirmed';
  if (v.dbStatus === 'queued') return 'queued';
  if (v.dbStatus === 'running') return 'running';
  return 'terminal';
};

export const step = (action, from, to) => {
  switch (action) {
    case 'ProducerGetJobOk':
      return 'check existing job';
    case 'ProducerGetJobErr':
      return 'queue probe fails';
    case 'ProducerRemoveStaleOk':
      return 'remove stale job';
    case 'ProducerRemoveStaleErr':
      return 'stale job remove fails';
    case 'ProducerRecheckAfterRemove':
      return 'recheck job after remove';
    case 'ProducerAddJobOk':
      return to.jobState === 'waiting' && from.jobState === 'none'
        ? 'enqueue job'
        : 'duplicate job add';
    case 'ProducerAddJobErr':
      return 'queue add errors';
    case 'ProducerCheckActive1':
      return 'check if active after error';
    case 'ProducerMarkFailedThenRecheck':
      return 'mark enqueue failed';
    case 'ProducerRecheckActive2':
      return 'recheck active after marking failed';
    case 'ProducerMarkFailed':
      return 'fail enqueue';
    case 'ProducerRecover':
      return 'recover infra failure';
    case 'ProducerStartReplay':
      return 'replay enqueue';
    case 'CancelQueued':
      return 'cancel queued run';
    case 'CancelRemoveQueuedJob':
      return 'remove cancelled job';
    case 'CancelRunning':
      return 'request cancel on running run';
    case 'BullMQStall':
      return 'BullMQ lock expires';
    case 'WorkerPickJob':
      return 'worker picks job';
    case 'WorkerInitialRead':
      return to.jobState === 'completed' ? 'worker skips on read' : 'worker reads run';
    case 'WorkerClaimTx':
      return to.activeExec.length > from.activeExec.length && from.dbStatus === 'running'
        ? 'worker double-claims running run'
        : to.activeExec.length > from.activeExec.length
          ? 'worker claims run'
          : 'worker skips on claim';
    case 'WorkerPublishStartedOk':
      return 'publish run_started';
    case 'WorkerPublishStartedFail':
      return 'publish run_started fails, revert to queued';
    case 'WorkerAttachSandbox':
      return 'attach sandbox';
    case 'WorkerSandboxOutcome':
      return 'sandbox finishes';
    case 'WorkerWillRetryRequeue':
      return 'requeue retryable failure';
    case 'WorkerHandoffPending':
      return 'hand off pendingFinish';
    case 'WorkerFinalize':
      return 'worker finalizes run';
    case 'ReconcileRunningProbe':
      return 'reconciler probes running run';
    case 'ReconcileRunningRead':
      return 'reconciler re-reads running run';
    case 'ReconcileRunningCleanupOk':
      return 'reconciler cleans sandbox';
    case 'ReconcileRunningCleanupFail':
      return 'reconciler cleanup fails';
    case 'ReconcileRunningFinalize':
      return 'reconciler finalizes running run';
    case 'ReconcileQueuedProbe':
      return 'reconciler probes stale queued run';
    case 'ReconcileQueuedFinalize':
      return 'reconciler marks queued run lost';
    case 'Done':
      return null;
    default:
      return action;
  }
};
