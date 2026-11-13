import type { RuntimeEnvironment, Server } from '@agentport/shared';
import { useState } from 'react';
import { DialogShell } from '../../components/dialog-shell.js';
import { ErrorState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { LastTest } from './shared.js';

/** 试连前选环境：默认预选该 server 上次实际用的环境，避免沿用别的连接器选择。 */
export function TestEnvironmentDialog({
  server,
  lastTest,
  environments,
  environmentsLoading,
  environmentsError,
  onRetryEnvironments,
  getReturnFocus,
  onClose,
  onConfirm,
}: {
  server: Server;
  lastTest: LastTest | null;
  environments: RuntimeEnvironment[];
  environmentsLoading: boolean;
  environmentsError: unknown;
  onRetryEnvironments: () => void;
  getReturnFocus: () => HTMLElement | null;
  onClose: () => void;
  onConfirm: (environmentId: string) => void;
}) {
  const defaultEnvironment = environments.find((environment) => environment.isDefault);
  const options = [
    { value: 'default', label: defaultEnvironment?.name ?? '平台默认环境' },
    ...environments
      .filter((environment) => !environment.isDefault)
      .map((environment) => ({ value: environment.id, label: environment.name })),
  ];
  // 本次页面结果优先；刷新后回退到后端持久化的上次试连身份。
  const lastEnvironment = lastTest
    ? (lastTest.result.runtimeEnvironment ?? null)
    : (server.lastTestRuntimeEnvironment ?? null);
  const lastEnvironmentId = lastEnvironment?.environmentId ?? null;
  // 客户端只知道「不在当前列表里」，删除只是最常见的原因。
  const lastEnvironmentMissing =
    lastEnvironmentId !== null &&
    !environments.some((environment) => environment.id === lastEnvironmentId);
  // 上次环境已不可用时回到默认，不能留一个列表里不存在的值。
  const initialEnvironmentId =
    lastEnvironmentId !== null &&
    environments.some(
      (environment) => environment.id === lastEnvironmentId && !environment.isDefault,
    )
      ? lastEnvironmentId
      : 'default';
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const environmentId = selectedEnvironmentId ?? initialEnvironmentId;
  const environmentsAvailable = !environmentsLoading && environmentsError === null;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`测试 ${server.name}`}
        finalFocus={getReturnFocus}
        className="max-w-md sm:max-w-md"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="server-test-environment">运行环境</FieldLabel>
            {environmentsLoading ? (
              <FieldDescription role="status">正在加载运行环境…</FieldDescription>
            ) : environmentsError !== null ? (
              <ErrorState
                title="运行环境列表没有加载出来"
                error={environmentsError}
                onRetry={onRetryEnvironments}
              />
            ) : (
              <>
                <Select
                  value={environmentId}
                  items={options}
                  onValueChange={(next) => {
                    if (next !== null) setSelectedEnvironmentId(next);
                  }}
                >
                  <SelectTrigger
                    id="server-test-environment"
                    className="w-full"
                    aria-describedby={
                      lastEnvironmentMissing ? 'server-test-environment-hint' : undefined
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {lastEnvironmentMissing ? (
                  <FieldDescription id="server-test-environment-hint">
                    上次使用的环境已不在当前列表中，已预选默认环境；确认后按所选环境测试。
                  </FieldDescription>
                ) : null}
              </>
            )}
          </Field>
        </FieldGroup>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!environmentsAvailable} onClick={() => onConfirm(environmentId)}>
            开始测试
          </Button>
        </div>
      </DialogShell>
    </Dialog>
  );
}
