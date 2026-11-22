---- MODULE BugConcurrentSync ----
EXTENDS Naturals

CONSTANTS Syncers, MaxGen

VARIABLES dbGen, redisGen, snapshots, maxWritten

vars == <<dbGen, redisGen, snapshots, maxWritten>>
InFlight == {s \in Syncers : snapshots[s] # 0}

Init ==
  /\ dbGen = 1
  /\ redisGen = 1
  /\ snapshots = [s \in Syncers |-> 0]
  /\ maxWritten = 1

DbUpdate ==
  /\ dbGen < MaxGen
  /\ dbGen' = dbGen + 1
  /\ UNCHANGED <<redisGen, snapshots, maxWritten>>

BeginSync(s) ==
  /\ s \notin InFlight
  /\ snapshots' = [snapshots EXCEPT ![s] = dbGen]
  /\ UNCHANGED <<dbGen, redisGen, maxWritten>>

WriteSchedule(s) ==
  /\ s \in InFlight
  /\ redisGen' = snapshots[s]
  /\ maxWritten' = IF maxWritten >= snapshots[s] THEN maxWritten ELSE snapshots[s]
  /\ snapshots' = [snapshots EXCEPT ![s] = 0]
  /\ UNCHANGED dbGen

Next ==
  \/ DbUpdate
  \/ \E s \in Syncers : BeginSync(s) \/ WriteSchedule(s)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ dbGen \in 1..MaxGen
  /\ redisGen \in 1..MaxGen
  /\ snapshots \in [Syncers -> 0..MaxGen]
  /\ maxWritten \in 1..MaxGen

NoStaleOverwrite == redisGen = maxWritten

====
