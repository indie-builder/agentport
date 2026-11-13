import { KeyRound, MoreHorizontal, Plug, Trash2, Wrench } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';

export function ServerActions({
  displayName,
  generated,
  testing,
  testPending,
  canTest,
  canTools,
  canTokens,
  canDelete,
  onTest,
  onCatalog,
  onTools,
  onConnection,
  onDelete,
}: {
  displayName: string;
  generated: boolean;
  testing: boolean;
  testPending: boolean;
  canTest: boolean;
  canTools: boolean;
  canTokens: boolean;
  canDelete: boolean;
  onTest: (trigger: HTMLElement) => void;
  onCatalog: (trigger: HTMLElement) => void;
  onTools: (trigger: HTMLElement) => void;
  onConnection: (trigger: HTMLElement) => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon-sm"
            aria-label={`操作 ${displayName}`}
          >
            <MoreHorizontal />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="w-40">
        <DropdownMenuGroup>
          {canTest ? (
            <DropdownMenuItem
              disabled={testPending}
              onClick={() => triggerRef.current && onTest(triggerRef.current)}
            >
              <Plug /> {testing ? '测试中…' : '测试连接'}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => triggerRef.current && onCatalog(triggerRef.current)}>
            <Wrench /> 工具与测试
          </DropdownMenuItem>
          {generated && canTools ? (
            <DropdownMenuItem onClick={() => triggerRef.current && onTools(triggerRef.current)}>
              <Wrench /> 工具定义
            </DropdownMenuItem>
          ) : null}
          {generated && canTokens ? (
            <DropdownMenuItem
              onClick={() => triggerRef.current && onConnection(triggerRef.current)}
            >
              <KeyRound /> 连接信息
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => triggerRef.current && onDelete(triggerRef.current)}
              >
                <Trash2 /> 删除
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
