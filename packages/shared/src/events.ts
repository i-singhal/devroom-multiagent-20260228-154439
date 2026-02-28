// ─── WebSocket Event Payloads ─────────────────────────────────────────────────

export interface TaskAssignedPayload {
  taskId: string;
  assignedUserId: string;
  taskTitle: string;
}

export interface TaskStatusUpdatedPayload {
  taskId: string;
  taskTitle: string;
  status: string;
  blockedReason?: string;
}

export interface WorkerProgressUpdatedPayload {
  taskId: string;
  summary: string;
  percent?: number;
}

export interface WorkerBlockedPayload {
  taskId: string;
  reason: string;
  needs: { type: string; id: string }[];
}

export interface ContractProposedChangePayload {
  contractId: string;
  contractName: string;
  proposedByUserId: string;
  proposedByName: string;
  breaking: boolean;
  summary: string;
  proposedContent: string;
}

export interface ContractPublishedPayload {
  contractId: string;
  contractName: string;
  contractVersionId: string;
  breaking: boolean;
  summary: string;
}

export interface MasterImpactAlertPayload {
  contractId: string;
  contractName: string;
  impactedTaskIds: string[];
  summary: string;
  recommendedActions: string[];
}

export interface MasterIntegrationAlertPayload {
  severity: "low" | "medium" | "high";
  message: string;
  relatedTaskIds: string[];
  relatedContractIds: string[];
}

export interface MasterDigestPayload {
  byUser: {
    userId: string;
    userName: string;
    tasks: { taskId: string; title: string; status: string; lastUpdate: string }[];
  }[];
  byTask: {
    taskId: string;
    title: string;
    status: string;
    assignedUserId?: string;
    blockedReason?: string;
  }[];
}

export interface NotebookEntryAddedPayload {
  entryId: string;
  category: string;
  title: string;
}

// ─── WebSocket Protocol ───────────────────────────────────────────────────────

export type ServerToClientEvents = {
  "message.new": (msg: import("./types").Message) => void;
  "event.new": (evt: import("./types").AppEvent) => void;
  "state.patch": (patch: Record<string, unknown>) => void;
};

export type ClientToServerEvents = {
  "message.send": (data: { channel: "master" | "worker"; content: string }) => void;
  "event.emit": (data: { type: string; payload: Record<string, unknown> }) => void;
};
