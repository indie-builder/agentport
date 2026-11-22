---- MODULE BugPendingFinishOverwrite ----
EXTENDS Naturals, FiniteSets

CONSTANTS Producers, Workers, MaxAttempts

VARIABLES
  dbStatus,
  errorKind,
  startedAt,
  pendingFinish,
  sandboxId,
  jobState,
  attempts,
  bullmqStalled,
  pState,
  pUsed,
  pAddedOrSawActive,
  wState,
  wOutcome,
  wRetryable,
  wAttempts,
  activeExec,
  rState,
  rSnapSandbox,
  rSnapPending,
  terminalOnStartedCount,
  startedTerminalStatus,
  overwrotePendingFinish,
  cancelRequested,
  reconciledAsLost

vars == <<
  dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
  jobState, attempts, bullmqStalled,
  pState, pUsed, pAddedOrSawActive,
  wState, wOutcome, wRetryable, wAttempts, activeExec,
  rState, rSnapSandbox, rSnapPending,
  terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
  cancelRequested, reconciledAsLost
>>

TerminalStatuses == {"succeeded", "failed", "cancelled"}
ActiveJobStates == {"waiting", "active"}
GoneJobStates == {"none", "completed", "failed"}

IsNeverStartedFailure ==
  dbStatus = "failed" /\ errorKind = "infra" /\ ~startedAt

TypeOK ==
  /\ dbStatus \in {"queued", "running", "succeeded", "failed", "cancelled"}
  /\ errorKind \in {"none", "infra", "runtime"}
  /\ startedAt \in BOOLEAN
  /\ pendingFinish \in {"none", "succeeded", "failed"}
  /\ sandboxId \in BOOLEAN
  /\ jobState \in {"none", "waiting", "active", "completed", "failed"}
  /\ attempts \in 0..MaxAttempts
  /\ bullmqStalled \in BOOLEAN
  /\ pState \in [Producers -> {
       "idle", "get_job", "remove_stale", "recheck_after_remove",
       "add_job", "check_active_1", "mark_failed_then_recheck",
       "recheck_active_2", "mark_failed", "recover", "done_ok", "done_err"
     }]
  /\ pUsed \in [Producers -> BOOLEAN]
  /\ pAddedOrSawActive \in [Producers -> BOOLEAN]
  /\ wState \in [Workers -> {
       "idle", "initial_read", "claim_tx", "publish_started",
       "attach_sandbox", "run_sandbox", "will_retry_requeue",
       "handoff_pending", "finalize"
     }]
  /\ wOutcome \in [Workers -> {"none", "succeeded", "failed", "cancelled"}]
  /\ wRetryable \in [Workers -> BOOLEAN]
  /\ wAttempts \in [Workers -> 0..MaxAttempts]
  /\ activeExec \subseteq Workers
  /\ rState \in {"idle", "running_read", "running_cleanup", "running_finalize", "queued_finalize"}
  /\ rSnapSandbox \in BOOLEAN
  /\ rSnapPending \in {"none", "succeeded", "failed"}
  /\ terminalOnStartedCount \in 0..3
  /\ startedTerminalStatus \in {"none", "succeeded", "failed", "cancelled"}
  /\ overwrotePendingFinish \in BOOLEAN
  /\ cancelRequested \in BOOLEAN
  /\ reconciledAsLost \in BOOLEAN

Init ==
  /\ dbStatus = "queued"
  /\ errorKind = "none"
  /\ startedAt = FALSE
  /\ pendingFinish = "none"
  /\ sandboxId = FALSE
  /\ jobState = "none"
  /\ attempts = 0
  /\ bullmqStalled = FALSE
  /\ pState = [p \in Producers |-> IF p = "P1" THEN "get_job" ELSE "idle"]
  /\ pUsed = [p \in Producers |-> (p = "P1")]
  /\ pAddedOrSawActive = [p \in Producers |-> FALSE]
  /\ wState = [w \in Workers |-> "idle"]
  /\ wOutcome = [w \in Workers |-> "none"]
  /\ wRetryable = [w \in Workers |-> FALSE]
  /\ wAttempts = [w \in Workers |-> 0]
  /\ activeExec = {}
  /\ rState = "idle"
  /\ rSnapSandbox = FALSE
  /\ rSnapPending = "none"
  /\ terminalOnStartedCount = 0
  /\ startedTerminalStatus = "none"
  /\ overwrotePendingFinish = FALSE
  /\ cancelRequested = FALSE
  /\ reconciledAsLost = FALSE

ProducerStartReplay(p) ==
  /\ p = "P2"
  /\ ~pUsed[p]
  /\ pState[p] = "idle"
  /\ dbStatus = "queued" \/ IsNeverStartedFailure
  /\ IF IsNeverStartedFailure
     THEN /\ dbStatus' = "queued"
          /\ errorKind' = "none"
          /\ reconciledAsLost' = FALSE
     ELSE UNCHANGED <<dbStatus, errorKind, reconciledAsLost>>
  /\ pState' = [pState EXCEPT ![p] = "get_job"]
  /\ pUsed' = [pUsed EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested
     >>

ProducerGetJobOk(p) ==
  /\ pState[p] = "get_job"
  /\ \/ /\ jobState = "none"
        /\ pState' = [pState EXCEPT ![p] = "add_job"]
        /\ UNCHANGED pAddedOrSawActive
     \/ /\ jobState \in ActiveJobStates
        /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
        /\ pState' = [pState EXCEPT ![p] = "recover"]
     \/ /\ jobState \in {"completed", "failed"}
        /\ pState' = [pState EXCEPT ![p] = "remove_stale"]
        /\ UNCHANGED pAddedOrSawActive
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerGetJobErr(p) ==
  /\ pState[p] = "get_job"
  /\ pState' = [pState EXCEPT ![p] = "mark_failed"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerRemoveStaleOk(p) ==
  /\ pState[p] = "remove_stale"
  /\ IF jobState \in {"completed", "failed"}
     THEN jobState' = "none"
     ELSE UNCHANGED jobState
  /\ pState' = [pState EXCEPT ![p] = "add_job"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerRemoveStaleErr(p) ==
  /\ pState[p] = "remove_stale"
  /\ pState' = [pState EXCEPT ![p] = "recheck_after_remove"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerRecheckAfterRemove(p) ==
  /\ pState[p] = "recheck_after_remove"
  /\ \/ /\ jobState \in ActiveJobStates
        /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
        /\ pState' = [pState EXCEPT ![p] = "recover"]
     \/ /\ jobState \notin ActiveJobStates
        /\ pState' = [pState EXCEPT ![p] = "mark_failed"]
        /\ UNCHANGED pAddedOrSawActive
     \/ /\ pState' = [pState EXCEPT ![p] = "mark_failed"]
        /\ UNCHANGED pAddedOrSawActive
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerAddJobOk(p) ==
  /\ pState[p] = "add_job"
  /\ IF jobState = "none"
     THEN /\ jobState' = "waiting"
          /\ attempts' = 0
          /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
     ELSE IF jobState \in ActiveJobStates
     THEN /\ UNCHANGED <<jobState, attempts>>
          /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
     ELSE /\ UNCHANGED <<jobState, attempts, pAddedOrSawActive>>
  /\ pState' = [pState EXCEPT ![p] = "recover"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       bullmqStalled, pUsed,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerAddJobErr(p) ==
  /\ pState[p] = "add_job"
  /\ \/ /\ jobState = "none"
        /\ jobState' = "waiting"
        /\ attempts' = 0
     \/ UNCHANGED <<jobState, attempts>>
  /\ pState' = [pState EXCEPT ![p] = "check_active_1"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       bullmqStalled, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerCheckActive1(p) ==
  /\ pState[p] = "check_active_1"
  /\ \/ /\ jobState \in ActiveJobStates
        /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
        /\ pState' = [pState EXCEPT ![p] = "recover"]
     \/ /\ jobState \notin ActiveJobStates
        /\ pState' = [pState EXCEPT ![p] = "mark_failed_then_recheck"]
        /\ UNCHANGED pAddedOrSawActive
     \/ /\ pState' = [pState EXCEPT ![p] = "mark_failed"]
        /\ UNCHANGED pAddedOrSawActive
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerMarkFailedThenRecheck(p) ==
  /\ pState[p] = "mark_failed_then_recheck"
  /\ IF dbStatus = "queued"
     THEN /\ dbStatus' = "failed"
          /\ errorKind' = "infra"
     ELSE UNCHANGED <<dbStatus, errorKind>>
  /\ pState' = [pState EXCEPT ![p] = "recheck_active_2"]
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerRecheckActive2(p) ==
  /\ pState[p] = "recheck_active_2"
  /\ \/ /\ jobState \in ActiveJobStates
        /\ pAddedOrSawActive' = [pAddedOrSawActive EXCEPT ![p] = TRUE]
        /\ pState' = [pState EXCEPT ![p] = "recover"]
     \/ /\ jobState \notin ActiveJobStates
        /\ pState' = [pState EXCEPT ![p] = "done_err"]
        /\ UNCHANGED pAddedOrSawActive
     \/ /\ pState' = [pState EXCEPT ![p] = "done_err"]
        /\ UNCHANGED pAddedOrSawActive
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerMarkFailed(p) ==
  /\ pState[p] = "mark_failed"
  /\ IF dbStatus = "queued"
     THEN /\ dbStatus' = "failed"
          /\ errorKind' = "infra"
     ELSE UNCHANGED <<dbStatus, errorKind>>
  /\ pState' = [pState EXCEPT ![p] = "done_err"]
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ProducerRecover(p) ==
  /\ pState[p] = "recover"
  /\ IF IsNeverStartedFailure
     THEN /\ dbStatus' = "queued"
          /\ errorKind' = "none"
          /\ reconciledAsLost' = FALSE
     ELSE UNCHANGED <<dbStatus, errorKind, reconciledAsLost>>
  /\ pState' = [pState EXCEPT ![p] = "done_ok"]
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested
     >>

CancelQueued ==
  /\ dbStatus = "queued"
  /\ dbStatus' = "cancelled"
  /\ errorKind' = "none"
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

CancelRemoveQueuedJob ==
  /\ dbStatus = "cancelled"
  /\ jobState = "waiting"
  /\ jobState' = "none"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

CancelRunning ==
  /\ dbStatus = "running"
  /\ ~cancelRequested
  /\ cancelRequested' = TRUE
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       reconciledAsLost
     >>

BullMQStall ==
  /\ ~bullmqStalled
  /\ jobState = "active"
  /\ bullmqStalled' = TRUE
  /\ jobState' = "waiting"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       attempts,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerPickJob(w) ==
  /\ wState[w] = "idle"
  /\ jobState = "waiting"
  /\ jobState' = "active"
  /\ wState' = [wState EXCEPT ![w] = "initial_read"]
  /\ wAttempts' = [wAttempts EXCEPT ![w] = attempts]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerInitialRead(w) ==
  /\ wState[w] = "initial_read"
  /\ IF dbStatus \in {"queued", "running"} \/ IsNeverStartedFailure
     THEN /\ wState' = [wState EXCEPT ![w] = "claim_tx"]
          /\ UNCHANGED jobState
     ELSE /\ wState' = [wState EXCEPT ![w] = "idle"]
          /\ IF jobState = "active" THEN jobState' = "completed" ELSE UNCHANGED jobState
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerClaimTx(w) ==
  /\ wState[w] = "claim_tx"
  /\ IF dbStatus = "queued" \/ IsNeverStartedFailure
     THEN /\ dbStatus' = "running"
          /\ startedAt' = TRUE
          /\ errorKind' = "none"
          /\ wState' = [wState EXCEPT ![w] = "publish_started"]
          /\ activeExec' = activeExec \cup {w}
          /\ UNCHANGED jobState
     ELSE /\ wState' = [wState EXCEPT ![w] = "idle"]
          /\ IF jobState = "active" THEN jobState' = "completed" ELSE UNCHANGED jobState
          /\ UNCHANGED <<dbStatus, errorKind, startedAt, activeExec>>
  /\ UNCHANGED <<
       pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, wAttempts,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerPublishStartedOk(w) ==
  /\ wState[w] = "publish_started"
  /\ wState' = [wState EXCEPT ![w] = "attach_sandbox"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerPublishStartedFail(w) ==
  /\ wState[w] = "publish_started"
  /\ IF dbStatus = "running"
     THEN /\ dbStatus' = "queued"
          /\ startedAt' = FALSE
     ELSE UNCHANGED <<dbStatus, startedAt>>
  /\ activeExec' = activeExec \ {w}
  /\ wState' = [wState EXCEPT ![w] = "idle"]
  /\ IF jobState = "active"
     THEN IF wAttempts[w] + 1 < MaxAttempts
          THEN /\ attempts' = wAttempts[w] + 1
               /\ jobState' = "waiting"
          ELSE /\ UNCHANGED attempts
               /\ jobState' = "failed"
     ELSE UNCHANGED <<jobState, attempts>>
  /\ UNCHANGED <<
       errorKind, pendingFinish, sandboxId,
       bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, wAttempts,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerAttachSandbox(w) ==
  /\ wState[w] = "attach_sandbox"
  /\ sandboxId' = TRUE
  /\ wState' = [wState EXCEPT ![w] = "run_sandbox"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wOutcome, wRetryable, wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerSandboxOutcome(w) ==
  /\ wState[w] = "run_sandbox"
  /\ \/ /\ wOutcome' = [wOutcome EXCEPT ![w] = "succeeded"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
        /\ wState' = [wState EXCEPT ![w] = "finalize"]
     \/ /\ cancelRequested
        /\ wOutcome' = [wOutcome EXCEPT ![w] = "cancelled"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
        /\ wState' = [wState EXCEPT ![w] = "finalize"]
     \/ /\ wOutcome' = [wOutcome EXCEPT ![w] = "failed"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
        /\ wState' = [wState EXCEPT ![w] = "finalize"]
     \/ /\ wOutcome' = [wOutcome EXCEPT ![w] = "failed"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = TRUE]
        /\ IF wAttempts[w] + 1 < MaxAttempts
           THEN wState' = [wState EXCEPT ![w] = "will_retry_requeue"]
           ELSE wState' = [wState EXCEPT ![w] = "finalize"]
     \/ /\ wOutcome' = [wOutcome EXCEPT ![w] = "succeeded"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
        /\ wState' = [wState EXCEPT ![w] = "handoff_pending"]
     \/ /\ wOutcome' = [wOutcome EXCEPT ![w] = "failed"]
        /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
        /\ wState' = [wState EXCEPT ![w] = "handoff_pending"]
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wAttempts, activeExec,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerWillRetryRequeue(w) ==
  /\ wState[w] = "will_retry_requeue"
  /\ IF dbStatus = "running"
     THEN /\ dbStatus' = "queued"
          /\ startedAt' = FALSE
     ELSE UNCHANGED <<dbStatus, startedAt>>
  /\ activeExec' = activeExec \ {w}
  /\ wState' = [wState EXCEPT ![w] = "idle"]
  /\ wOutcome' = [wOutcome EXCEPT ![w] = "none"]
  /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
  /\ IF jobState = "active"
     THEN /\ attempts' = wAttempts[w] + 1
          /\ jobState' = "waiting"
     ELSE UNCHANGED <<jobState, attempts>>
  /\ UNCHANGED <<
       errorKind, pendingFinish, sandboxId,
       bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wAttempts,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerHandoffPending(w) ==
  /\ wState[w] = "handoff_pending"
  /\ IF dbStatus = "running"
     THEN pendingFinish' = wOutcome[w]
     ELSE UNCHANGED pendingFinish
  /\ activeExec' = activeExec \ {w}
  /\ wState' = [wState EXCEPT ![w] = "idle"]
  /\ wOutcome' = [wOutcome EXCEPT ![w] = "none"]
  /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
  /\ IF jobState = "active"
     THEN jobState' = "completed"
     ELSE UNCHANGED jobState
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wAttempts,
       rState, rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

WorkerFinalize(w) ==
  /\ wState[w] = "finalize"
  /\ IF dbStatus = "running"
     THEN /\ dbStatus' = wOutcome[w]
          /\ errorKind' = IF wOutcome[w] = "failed" THEN "runtime" ELSE "none"
          /\ IF startedAt
             THEN /\ terminalOnStartedCount' = terminalOnStartedCount + 1
                  /\ IF startedTerminalStatus = "none"
                     THEN startedTerminalStatus' = wOutcome[w]
                     ELSE UNCHANGED startedTerminalStatus
             ELSE UNCHANGED <<terminalOnStartedCount, startedTerminalStatus>>
          /\ IF wRetryable[w] /\ jobState = "active"
             THEN jobState' = "failed"
             ELSE IF jobState = "active"
             THEN jobState' = "completed"
             ELSE UNCHANGED jobState
     ELSE /\ UNCHANGED <<dbStatus, errorKind, terminalOnStartedCount, startedTerminalStatus>>
          /\ IF jobState = "active"
             THEN jobState' = "completed"
             ELSE UNCHANGED jobState
  /\ activeExec' = activeExec \ {w}
  /\ wState' = [wState EXCEPT ![w] = "idle"]
  /\ wOutcome' = [wOutcome EXCEPT ![w] = "none"]
  /\ wRetryable' = [wRetryable EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wAttempts,
       rState, rSnapSandbox, rSnapPending,
       overwrotePendingFinish, cancelRequested, reconciledAsLost
     >>

ReconcileRunningProbe ==
  /\ rState = "idle"
  /\ dbStatus = "running"
  /\ pendingFinish # "none" \/ startedAt
  /\ jobState \in GoneJobStates
  /\ rSnapSandbox' = sandboxId
  /\ rSnapPending' = pendingFinish
  /\ rState' = "running_read"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ReconcileRunningRead ==
  /\ rState = "running_read"
  /\ IF dbStatus = "running"
        /\ sandboxId = rSnapSandbox
        /\ (pendingFinish = "none") = (rSnapPending = "none")
     THEN rState' = IF sandboxId THEN "running_cleanup" ELSE "running_finalize"
     ELSE rState' = "idle"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ReconcileRunningCleanupOk ==
  /\ rState = "running_cleanup"
  /\ rState' = "running_finalize"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ReconcileRunningCleanupFail ==
  /\ rState = "running_cleanup"
  /\ rState' = "idle"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ReconcileRunningFinalize ==
  /\ rState = "running_finalize"
  /\ IF dbStatus = "running"
     THEN /\ dbStatus' = IF rSnapPending = "none" THEN "failed" ELSE rSnapPending
          /\ errorKind' = IF rSnapPending = "none" THEN "none"
                          ELSE IF rSnapPending = "failed" THEN "runtime" ELSE "none"
          /\ IF rSnapPending = "none" /\ pendingFinish # "none"
             THEN overwrotePendingFinish' = TRUE
             ELSE UNCHANGED overwrotePendingFinish
          /\ IF rSnapPending # "none"
             THEN pendingFinish' = "none"
             ELSE UNCHANGED pendingFinish
          /\ IF startedAt
             THEN /\ terminalOnStartedCount' = terminalOnStartedCount + 1
                  /\ IF startedTerminalStatus = "none"
                     THEN startedTerminalStatus' = IF rSnapPending = "none" THEN "failed" ELSE rSnapPending
                     ELSE UNCHANGED startedTerminalStatus
             ELSE UNCHANGED <<terminalOnStartedCount, startedTerminalStatus>>
          /\ IF pendingFinish = "none"
             THEN activeExec' = {}
             ELSE UNCHANGED activeExec
     ELSE UNCHANGED <<dbStatus, errorKind, pendingFinish, terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish, activeExec>>
  /\ rState' = "idle"
  /\ UNCHANGED <<
       startedAt, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts,
       rSnapSandbox, rSnapPending,
       cancelRequested, reconciledAsLost
     >>

ReconcileQueuedProbe ==
  /\ rState = "idle"
  /\ dbStatus = "queued"
  /\ jobState \in GoneJobStates
  /\ rState' = "queued_finalize"
  /\ UNCHANGED <<
       dbStatus, errorKind, startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rSnapSandbox, rSnapPending,
       terminalOnStartedCount, startedTerminalStatus, overwrotePendingFinish,
       cancelRequested, reconciledAsLost
     >>

ReconcileQueuedFinalize ==
  /\ rState = "queued_finalize"
  /\ IF dbStatus = "queued"
     THEN /\ dbStatus' = "failed"
          /\ errorKind' = "infra"
          /\ reconciledAsLost' = TRUE
          /\ IF startedAt
             THEN terminalOnStartedCount' = terminalOnStartedCount + 1
             ELSE UNCHANGED terminalOnStartedCount
     ELSE UNCHANGED <<dbStatus, errorKind, reconciledAsLost, terminalOnStartedCount>>
  /\ rState' = "idle"
  /\ UNCHANGED <<
       startedAt, pendingFinish, sandboxId,
       jobState, attempts, bullmqStalled,
       pState, pUsed, pAddedOrSawActive,
       wState, wOutcome, wRetryable, wAttempts, activeExec,
       rSnapSandbox, rSnapPending,
       startedTerminalStatus, overwrotePendingFinish, cancelRequested
     >>

Settled ==
  /\ \A p \in Producers : pState[p] \in {"idle", "done_ok", "done_err"}
  /\ \A w \in Workers : wState[w] = "idle"
  /\ rState = "idle"
  /\ jobState \notin ActiveJobStates
  /\ dbStatus # "running"

Done ==
  /\ Settled
  /\ UNCHANGED vars

Next ==
  \/ \E p \in Producers :
       \/ ProducerStartReplay(p)
       \/ ProducerGetJobOk(p)
       \/ ProducerGetJobErr(p)
       \/ ProducerRemoveStaleOk(p)
       \/ ProducerRemoveStaleErr(p)
       \/ ProducerRecheckAfterRemove(p)
       \/ ProducerAddJobOk(p)
       \/ ProducerAddJobErr(p)
       \/ ProducerCheckActive1(p)
       \/ ProducerMarkFailedThenRecheck(p)
       \/ ProducerRecheckActive2(p)
       \/ ProducerMarkFailed(p)
       \/ ProducerRecover(p)
  \/ CancelQueued
  \/ CancelRemoveQueuedJob
  \/ CancelRunning
  \/ BullMQStall
  \/ \E w \in Workers :
       \/ WorkerPickJob(w)
       \/ WorkerInitialRead(w)
       \/ WorkerClaimTx(w)
       \/ WorkerPublishStartedOk(w)
       \/ WorkerPublishStartedFail(w)
       \/ WorkerAttachSandbox(w)
       \/ WorkerSandboxOutcome(w)
       \/ WorkerWillRetryRequeue(w)
       \/ WorkerHandoffPending(w)
       \/ WorkerFinalize(w)
  \/ ReconcileRunningProbe
  \/ ReconcileRunningRead
  \/ ReconcileRunningCleanupOk
  \/ ReconcileRunningCleanupFail
  \/ ReconcileRunningFinalize
  \/ ReconcileQueuedProbe
  \/ ReconcileQueuedFinalize
  \/ Done

Spec == Init /\ [][Next]_vars

NoDoubleExecution ==
  Cardinality(activeExec) <= 1

NoTerminalWhileUnconfirmed ==
  pendingFinish # "none" => dbStatus = "running"

NoPendingFinishOverwrite ==
  ~overwrotePendingFinish

AtMostOneTerminalWinner ==
  terminalOnStartedCount <= 1

TerminalMonotonic ==
  startedTerminalStatus # "none" => (dbStatus = startedTerminalStatus /\ startedAt)

NoStuckEnqueueFailure ==
  ( (\A p \in Producers : pState[p] \in {"idle", "done_ok", "done_err"})
    /\ (\A w \in Workers : wState[w] = "idle")
    /\ rState = "idle"
    /\ (\E p \in Producers : pState[p] = "done_ok")
    /\ jobState = "completed"
    /\ ~reconciledAsLost
  ) => ~(dbStatus = "failed" /\ errorKind = "infra" /\ ~startedAt)

EnqueueOkImpliesJobWasActive ==
  \A p \in Producers :
    (pState[p] = "done_ok" /\ dbStatus = "queued") => pAddedOrSawActive[p]

====
