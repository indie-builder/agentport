import { useEffect, useRef, useState } from 'react';
import { useFormBlocker } from '../lib/form.js';
import { ConfirmDialog } from './confirm-dialog.js';

/** 弹层草稿保护：dirty 关闭先确认，pending 期间禁止关闭与路由离开。 */
export function useDraftGuard(dirty: boolean, pending: boolean, onClose: () => void) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };
  return { blocker, confirmDiscard, setConfirmDiscard, finish, close };
}

/** 弹层内统一的放弃草稿与路由离开确认。 */
export function DraftGuardDialogs({
  guard,
  draft,
  pending,
}: {
  guard: ReturnType<typeof useDraftGuard>;
  draft: string;
  pending: boolean;
}) {
  return (
    <>
      <ConfirmDialog
        open={guard.confirmDiscard}
        onClose={() => guard.setConfirmDiscard(false)}
        title="放弃未保存的更改？"
        description={`关闭后${draft}`}
        confirmLabel="放弃并关闭"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) guard.finish();
        }}
      />
      <ConfirmDialog
        open={guard.blocker.status === 'blocked'}
        onClose={() => guard.blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : `离开后${draft}`}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => guard.blocker.proceed()}
      />
    </>
  );
}
