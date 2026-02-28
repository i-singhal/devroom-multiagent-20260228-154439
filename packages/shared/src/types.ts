// ─── Enums ────────────────────────────────────────────────────────────────────

export type MembershipRole = "owner" | "admin" | "collaborator";
export type AgentType = "master" | "worker";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done";
export type ContractType = "openapi" | "typescript" | "protobuf" | "jsonschema" | "other";
export type DependencyType = "consumes" | "produces" | "modifies";
export type MessageChannel = "master" | "worker";
export type EventVisibility = "global" | "user";
export type EntryCategory =
  | "decision"
  | "contract_change"
  | "task_update"
  | "integration"
  | "blocker"
  | "summary";

// ─── Core Models ──────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface Room {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  roomId: string;
  userId: string;
  role: MembershipRole;
  createdAt: string;
  user?: User;
}

export interface Task {
  id: string;
  roomId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  assignedUserId: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  assignedUser?: User;
  fromDependencies?: TaskDependency[];
  toDependencies?: TaskDependency[];
  contractDeps?: TaskContractDependency[];
}

export interface TaskDependency {
  id: string;
  roomId: string;
  fromTaskId: string;
  toTaskId: string;
}

export interface Contract {
  id: string;
  roomId: string;
  name: string;
  type: ContractType;
  currentVersionId: string | null;
  createdAt: string;
  versions?: ContractVersion[];
}

export interface ContractVersion {
  id: string;
  contractId: string;
  version: number;
  content: string;
  summary: string;
  breaking: boolean;
  createdAt: string;
}

export interface TaskContractDependency {
  id: string;
  taskId: string;
  contractId: string;
  dependencyType: DependencyType;
}

export interface Message {
  id: string;
  roomId: string;
  channel: MessageChannel;
  ownerUserId: string | null;
  senderUserId: string | null;
  senderAgentId: string | null;
  content: string;
  createdAt: string;
  senderUser?: User;
  senderAgent?: { id: string; type: AgentType };
}

export interface AppEvent {
  id: string;
  roomId: string;
  visibility: EventVisibility;
  visibleToUserId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NotebookEntry {
  id: string;
  roomId: string;
  category: EntryCategory;
  title: string;
  content: string;
  references: {
    taskIds?: string[];
    contractIds?: string[];
    messageIds?: string[];
    links?: string[];
  };
  createdAt: string;
}

// ─── API DTOs ─────────────────────────────────────────────────────────────────

export interface RoomDetail extends Room {
  memberships: Membership[];
  tasks: Task[];
  contracts: Contract[];
  myRole: MembershipRole;
}

export interface CreateRoomDto {
  title: string;
  goal: string;
}

export interface AssignTaskDto {
  assignedUserId: string;
}

export interface UpdateTaskStatusDto {
  status: TaskStatus;
  blockedReason?: string;
}

export interface ProposeContractDto {
  summary: string;
  breaking: boolean;
  proposedContent: string;
}

export interface PublishContractDto {
  summary: string;
  breaking: boolean;
  content: string;
}

export interface SendMessageDto {
  content: string;
  sharedFromMessageId?: string;
}

export interface CreateNotebookEntryDto {
  category: EntryCategory;
  title: string;
  content: string;
  references?: NotebookEntry["references"];
}

// ─── Master Planning ──────────────────────────────────────────────────────────

export interface MasterPlanOutput {
  tasks: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    assigneeHint?: string;
  }[];
  dependencies: {
    fromTitle: string;
    toTitle: string;
  }[];
  contracts: {
    name: string;
    type: ContractType;
    initialContent: string;
    summary: string;
  }[];
  notesForNotebook: string;
}
