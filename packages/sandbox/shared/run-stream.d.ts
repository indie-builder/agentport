export declare const RUN_STREAM_MAXLEN = 1000;
export declare const RUN_CANCEL_PAYLOAD = "1";
export declare function runStreamKey(runId: string): string;
/** Pub/sub channel used to wake event-stream subscribers. */
export declare function runChannel(runId: string): string;
export declare function runCancelKey(runId: string): string;
export declare function runEnqueueOptions(jobId: string): {
    jobId: string;
    attempts: number;
    backoff: {
        type: string;
        delay: number;
    };
};
//# sourceMappingURL=run-stream.d.ts.map