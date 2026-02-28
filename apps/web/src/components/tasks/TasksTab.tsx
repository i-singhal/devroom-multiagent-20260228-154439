"use client";
import { useState } from "react";
import { tasksApi, contractsApi } from "../../lib/api";
import { useSocket } from "../../hooks/useSocket";
import { useEffect } from "react";
import { CheckCircle2, Clock, AlertTriangle, Eye, ChevronDown, Plus, FileCode } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";

const STATUS_META: Record<string, { label: string; color: string; icon: any }> = {
  todo: { label: "To Do", color: "bg-slate-700 text-slate-300", icon: Clock },
  in_progress: { label: "In Progress", color: "bg-blue-600/20 text-blue-300", icon: Clock },
  blocked: { label: "Blocked", color: "bg-red-600/20 text-red-300", icon: AlertTriangle },
  review: { label: "In Review", color: "bg-yellow-600/20 text-yellow-300", icon: Eye },
  done: { label: "Done", color: "bg-green-600/20 text-green-300", icon: CheckCircle2 },
};

interface Props {
  roomId: string;
  tasks: any[];
  members: any[];
  userId: string;
  isAdmin: boolean;
  onRefresh: () => void;
}

export default function TasksTab({ roomId, tasks, members, userId, isAdmin, onRefresh }: Props) {
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [selectedContract, setSelectedContract] = useState<any>(null);
  const [contractDetail, setContractDetail] = useState<any>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState<string | null>(null);
  const [publishData, setPublishData] = useState({ summary: "", breaking: false, content: "" });
  const { on } = useSocket(roomId, userId);

  useEffect(() => {
    const unsub = on("event.new", (evt: any) => {
      if (["task.status.updated", "task.assigned"].includes(evt.type)) {
        onRefresh();
      }
    });
    return unsub;
  }, [on, onRefresh]);

  const contracts = tasks
    .flatMap((t) => t.contractDeps ?? [])
    .map((d) => d.contract)
    .filter((c, i, arr) => c && arr.findIndex((x) => x?.id === c.id) === i);

  const assign = async (taskId: string, assignedUserId: string) => {
    await tasksApi.assign(taskId, assignedUserId);
    setAssigning(null);
    onRefresh();
  };

  const loadContract = async (contractId: string) => {
    const res = await contractsApi.get(contractId);
    setContractDetail(res.data);
    setSelectedContract(contractId);
  };

  const publish = async (contractId: string) => {
    await contractsApi.publish(contractId, publishData);
    setShowPublish(null);
    setPublishData({ summary: "", breaking: false, content: "" });
    onRefresh();
  };

  const byStatus = (status: string) => tasks.filter((t) => t.status === status);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-auto p-4">
        <div className="flex gap-3 min-w-max h-full">
          {Object.entries(STATUS_META).map(([status, meta]) => {
            const StatusIcon = meta.icon;
            const columnTasks = byStatus(status);
            return (
              <div key={status} className="w-64 flex-shrink-0">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <StatusIcon className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-xs font-medium text-slate-400">{meta.label}</span>
                  <span className="badge bg-slate-800 text-slate-400 ml-auto">{columnTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {columnTasks.map((task) => (
                    <div
                      key={task.id}
                      className={clsx(
                        "card p-3 cursor-pointer hover:border-brand-500/30 transition-all",
                        selectedTask?.id === task.id && "border-brand-500/50"
                      )}
                      onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                    >
                      <p className="text-sm text-white font-medium leading-tight">{task.title}</p>
                      {task.assignedUser && (
                        <p className="text-xs text-slate-500 mt-1.5">
                          👤 {task.assignedUser.name}
                        </p>
                      )}
                      {task.blockedReason && (
                        <p className="text-xs text-red-400 mt-1 flex items-start gap-1">
                          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          {task.blockedReason}
                        </p>
                      )}
                      {/* Deps */}
                      {task.toDependencies?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {task.toDependencies.map((dep: any) => {
                            const depTask = tasks.find((t) => t.id === dep.fromTaskId);
                            return depTask ? (
                              <span key={dep.id} className={clsx("badge text-xs", STATUS_META[depTask.status]?.color ?? "bg-slate-700 text-slate-400")}>
                                ← {depTask.title.slice(0, 16)}
                              </span>
                            ) : null;
                          })}
                        </div>
                      )}
                      <p className="text-xs text-slate-600 mt-2">
                        {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedTask && (
        <div className="w-80 border-l border-white/5 flex flex-col overflow-y-auto flex-shrink-0">
          <div className="p-4 border-b border-white/5">
            <button onClick={() => setSelectedTask(null)} className="text-xs text-slate-500 hover:text-white mb-3">✕ Close</button>
            <h3 className="font-semibold text-white mb-1">{selectedTask.title}</h3>
            <span className={`badge text-xs ${STATUS_META[selectedTask.status]?.color}`}>
              {STATUS_META[selectedTask.status]?.label}
            </span>
          </div>

          <div className="p-4 space-y-4 flex-1">
            <div>
              <p className="text-xs text-slate-500 mb-1">Description</p>
              <p className="text-sm text-slate-300">{selectedTask.description}</p>
            </div>

            <div>
              <p className="text-xs text-slate-500 mb-1">Acceptance Criteria</p>
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-sans">{selectedTask.acceptanceCriteria}</pre>
            </div>

            {isAdmin && !selectedTask.assignedUserId && (
              <div>
                <p className="text-xs text-slate-500 mb-2">Assign to</p>
                <div className="space-y-1">
                  {members.map((m: any) => (
                    <button
                      key={m.userId}
                      onClick={() => assign(selectedTask.id, m.userId)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-surface-900 hover:bg-brand-600/20 text-sm text-slate-300 hover:text-white transition-colors"
                    >
                      {m.user?.name} <span className="text-slate-600 text-xs">({m.role})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedTask.contractDeps?.length > 0 && (
              <div>
                <p className="text-xs text-slate-500 mb-2">Contract Dependencies</p>
                <div className="space-y-1">
                  {selectedTask.contractDeps.map((dep: any) => dep.contract && (
                    <button
                      key={dep.id}
                      onClick={() => loadContract(dep.contractId)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-surface-900 hover:bg-brand-600/10 text-xs flex items-center gap-2 text-slate-300"
                    >
                      <FileCode className="w-3.5 h-3.5 text-brand-400" />
                      {dep.contract.name}
                      <span className="text-slate-600 ml-auto">{dep.dependencyType}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Contract Detail Modal */}
      {contractDetail && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-white">{contractDetail.name}</h3>
                <p className="text-xs text-slate-500">{contractDetail.type} · {contractDetail.versions?.length ?? 0} versions</p>
              </div>
              <div className="flex gap-2">
                {isAdmin && (
                  <button
                    onClick={() => { setShowPublish(contractDetail.id); setPublishData({ summary: "", breaking: false, content: contractDetail.versions?.[0]?.content ?? "" }); }}
                    className="btn-primary text-xs"
                  >
                    Publish New Version
                  </button>
                )}
                <button onClick={() => { setContractDetail(null); setSelectedContract(null); }} className="btn-ghost text-xs">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {contractDetail.versions?.map((v: any) => (
                <div key={v.id} className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-white">v{v.version}</span>
                    {v.breaking && <span className="badge bg-red-600/20 text-red-300">Breaking</span>}
                    <span className="text-xs text-slate-500 ml-auto">{formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}</span>
                  </div>
                  <p className="text-xs text-slate-400 mb-2">{v.summary}</p>
                  <pre className="bg-surface-900 p-3 rounded-lg text-xs text-slate-300 overflow-x-auto">{v.content}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Publish Modal */}
      {showPublish && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-lg">
            <h3 className="font-semibold text-white mb-4">Publish New Contract Version</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Summary</label>
                <input className="input" value={publishData.summary} onChange={(e) => setPublishData((p) => ({ ...p, summary: e.target.value }))} placeholder="What changed?" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Content</label>
                <textarea className="input font-mono text-xs resize-none" rows={10} value={publishData.content} onChange={(e) => setPublishData((p) => ({ ...p, content: e.target.value }))} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={publishData.breaking} onChange={(e) => setPublishData((p) => ({ ...p, breaking: e.target.checked }))} className="rounded" />
                <span className="text-sm text-slate-300">Breaking change</span>
              </label>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowPublish(null)} className="btn-ghost flex-1">Cancel</button>
                <button onClick={() => publish(showPublish)} className="btn-primary flex-1" disabled={!publishData.summary || !publishData.content}>Publish</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
