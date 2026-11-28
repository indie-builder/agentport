import {
  type AgentAction,
  type AgentChange,
  type AgentComponent,
  type AgentStep,
  agentTools,
  createAgent,
  type ObservedChange,
  registerTools,
} from '@ui-sdk/react/agent';

export type { AgentAction, AgentChange, AgentComponent, AgentStep, ObservedChange };

export type ConfirmRequest = {
  message: string;
  resolve: (allowed: boolean) => void;
};

export type UiAgentConfirmHandler = (message: string, signal: AbortSignal) => Promise<boolean>;

export type UiAgentBridge = ReturnType<typeof createAgent>;

declare global {
  interface Window {
    agent?: UiAgentBridge;
  }
}

let confirmHandler: UiAgentConfirmHandler | null = null;

export function setUiAgentConfirmHandler(handler: UiAgentConfirmHandler | null): () => void {
  confirmHandler = handler;
  return () => {
    if (confirmHandler === handler) {
      confirmHandler = null;
    }
  };
}

export function createUiAgent(confirm?: UiAgentConfirmHandler): UiAgentBridge {
  return createAgent({
    allow: async (step, { signal }) => {
      if (!step.confirm) {
        return true;
      }
      if (signal.aborted) {
        return false;
      }
      const handler = confirm ?? confirmHandler;
      if (!handler) {
        return false;
      }
      return handler(step.confirm, signal);
    },
  });
}

export const uiAgent = createUiAgent();
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.agent = uiAgent;
}
export const uiAgentTools = agentTools;
export { registerTools };
