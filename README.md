# DevRoom — Multi-Agent Real-Time Dev Platform

A collaborative dev platform where multiple collaborators each have a **private Worker Agent chat**, everyone shares a **Master Agent channel**, and a **Master Agent runs continuously** to monitor tasks, contracts, and dependencies — preventing integration hell.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  apps/web (Next.js 14 + Tailwind)                       │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐  │
│  │ Master  │ │ My Agent │ │ Tasks  │ │  Notebook   │  │
│  │  Tab    │ │  Tab     │ │  Tab   │ │    Tab      │  │
│  └─────────┘ └──────────┘ └────────┘ └─────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (Socket.IO) + REST
┌──────────────────────▼──────────────────────────────────┐
│  apps/api (Node.js + Express + Prisma)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Master Agent │  │ Worker Agent │  │Master Monitor │ │
│  │ (claude-opus)│  │(claude-sonnet│  │ (continuous)  │ │
│  └──────────────┘  └──────────────┘  └───────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  PostgreSQL (Prisma)    +    Redis (sessions/jobs)       │
└─────────────────────────────────────────────────────────┘
```

---

## Features

### Privacy Model
- **Private Worker Chats**: Only you + your Worker Agent see your chat. Zero leakage to others.
- **Master Channel**: Shared by all room members — coordinated by Master Agent.
- **"Share to Master"**: Hover any Worker Agent message → share a sanitized snippet to master channel.

### Master Agent (Claude Opus)
- Generates task breakdown + contract stubs from room goal
- Responds to team in master channel with full room context
- Triggered on contract publish → impact analysis → targeted user alerts

### Worker Agent (Claude Sonnet)
- Private, context-aware chat per user
- Knows your assigned tasks, their acceptance criteria, and contract dependencies
- Helps with code, architecture, and integration decisions

### Continuous Monitor
- **Event-driven**: Handles task blocked/done, contract published, assignments
- **Periodic sweep (30s)**: Alerts stale tasks, unblocks resolved dependencies, cleans dangling refs
- **Dependency resolution**: When a prerequisite task completes, downstream tasks auto-unblock

### Contract Registry
- Versioned contracts (OpenAPI, TypeScript, JSON Schema, Protobuf)
- Heuristic breaking change detection (endpoint/symbol removal)
- Publish → impact analysis → block affected tasks → notebook entry → user alerts

---

## Quick Start

### 1. Prerequisites
- Node.js 20+
- Docker (for Postgres + Redis)
- Anthropic API key

### 2. Clone & Install
```bash
git clone <repo>
cd devroom
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY, DATABASE_URL, etc.
npm install
```

### 3. Start infrastructure
```bash
docker-compose up -d
```

### 4. Database setup
```bash
cd apps/api
npx prisma generate
npx prisma db push
# or for migrations: npx prisma migrate dev --name init
```

### 5. Run dev servers
```bash
# From root (runs both API + Web concurrently)
npm run dev

# Or separately:
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:3000
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis URL (optional for MVP; used by BullMQ) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`) |
| `SESSION_SECRET` | Express session secret (change in prod) |
| `FRONTEND_URL` | Frontend URL for CORS (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | API URL from browser (default: `http://localhost:4000`) |

---

## Project Structure

```
devroom/
├── apps/
│   ├── api/                    # Node.js + Express backend
│   │   └── src/
│   │       ├── index.ts        # Server entry point
│   │       ├── db.ts           # Prisma client
│   │       ├── websocket.ts    # Socket.IO setup + broadcast helpers
│   │       ├── agents/
│   │       │   ├── master.ts   # Master Agent (planning, impact analysis, chat)
│   │       │   ├── worker.ts   # Worker Agent (private per-user chat)
│   │       │   └── monitor.ts  # Continuous background monitor
│   │       ├── routes/
│   │       │   ├── auth.ts     # Register/login/logout/me
│   │       │   ├── rooms.ts    # CRUD + plan generation
│   │       │   ├── tasks.ts    # Assign + status updates
│   │       │   ├── contracts.ts # Propose + publish + versioning
│   │       │   ├── messages.ts # Master + worker channels (ACL enforced)
│   │       │   ├── notebook.ts # Timeline entries
│   │       │   └── invites.ts  # Invite link create + join
│   │       └── middleware/
│   │           └── auth.ts     # Session + room membership guards
│   │
│   └── web/                    # Next.js 14 frontend
│       └── src/
│           ├── app/
│           │   ├── page.tsx          # Room list
│           │   ├── login/page.tsx    # Auth
│           │   ├── rooms/[id]/       # Main room UI
│           │   └── invite/[token]/   # Invite join
│           ├── components/
│           │   ├── master/MasterTab.tsx
│           │   ├── worker/WorkerTab.tsx
│           │   ├── tasks/TasksTab.tsx
│           │   └── notebook/NotebookTab.tsx
│           ├── hooks/useSocket.ts    # Socket.IO real-time hook
│           └── lib/
│               ├── api.ts            # Axios API client
│               └── auth-context.tsx  # Auth state
│
├── packages/
│   └── shared/                 # Shared TypeScript types
│       └── src/
│           ├── types.ts        # All model + DTO types
│           └── events.ts       # WS event payload types
│
├── prisma/
│   └── schema.prisma           # Full data model
├── docker-compose.yml          # Postgres + Redis
└── .env.example
```

---

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | `{ name, email, password }` |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | Clear session |
| GET | `/auth/me` | Current user |

### Rooms
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/rooms` | ✓ | Create room |
| GET | `/rooms` | ✓ | List my rooms |
| GET | `/rooms/:id` | member | Room detail |
| POST | `/rooms/:id/plan` | admin | Generate AI plan |
| POST | `/rooms/:id/invites` | admin | Create invite link |

### Tasks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/tasks/:id` | member | Task detail |
| POST | `/tasks/:id/assign` | admin | Assign task |
| POST | `/tasks/:id/status` | assignee/admin | Update status |

### Contracts
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contracts/:id` | member | Contract + versions |
| POST | `/contracts/:id/propose` | member | Propose change |
| POST | `/contracts/:id/publish` | admin | Publish new version |

### Messages
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/rooms/:id/messages?channel=master` | member | Master history |
| GET | `/rooms/:id/messages?channel=worker` | member | My worker history |
| POST | `/rooms/:id/messages/master` | member | Send to master |
| POST | `/rooms/:id/messages/worker` | member | Send to my agent |

### WebSocket Events
```
Client auth: { roomId, userId }
Joins: room:{roomId}:global  +  room:{roomId}:user:{userId}

Server → Client:
  message.new  { ...Message }
  event.new    { ...Event }
  state.patch  { ...partial }
```

---

## Extending

### Add task-contract dependencies
After tasks and contracts are created via the plan, link them:
```sql
INSERT INTO "TaskContractDependency" (id, "taskId", "contractId", "dependencyType")
VALUES (gen_random_uuid(), '<taskId>', '<contractId>', 'consumes');
```

Or extend the API to accept them in the plan output (the `masterPlanRoom` JSON includes them implicitly — you can extend the schema to include `contractLinks` in task objects).

### Swap models
Edit `MASTER_MODEL` and `WORKER_MODEL` constants in `apps/api/src/agents/`:
- Master: `gpt-4o` (complex reasoning, planning, impact analysis)
- Worker: `gpt-4o` (context-aware private chat)
- Fast/cheap: `gpt-4o-mini` (used for impact analysis summaries)

### Production deployment
- Use a proper session store (connect-redis)
- Add rate limiting (express-rate-limit)
- Use BullMQ for background jobs (Redis already in docker-compose)
- Enable HTTPS, set `cookie.secure: true`
- Add input sanitization for XSS protection

---

## Definition of Done Status

| Feature | Status |
|---------|--------|
| Room create/invite/join | ✅ |
| Private worker chat (ACL) | ✅ |
| Shared master chat | ✅ |
| Real-time WebSocket (global + user scope) | ✅ |
| Task board (kanban + dependency indicators) | ✅ |
| Contract registry + versioning | ✅ |
| Breaking change detection (heuristic) | ✅ |
| Master Agent planning (Claude API) | ✅ |
| Master Agent chat (Claude API) | ✅ |
| Worker Agent chat (Claude API) | ✅ |
| Contract publish → impact alerts | ✅ |
| Task blocking/unblocking | ✅ |
| Dependency resolution on task done | ✅ |
| Continuous monitor (event + periodic) | ✅ |
| Notebook timeline | ✅ |
| "Share to Master" from worker chat | ✅ |
| History search + filter | ✅ |
