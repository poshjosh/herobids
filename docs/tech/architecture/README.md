# System Architecture

## Overview

An agentic platform which offers AI agents as a service (AaaS). Also uses skills to give agents expertise. Users describe what they want to accomplish; AI agents handle execution continuously within defined constraints.

```mermaid
graph TB
    subgraph Clients["External Clients"]
        UI["Web UI\n(React/Vite)"]
        AGENT["AI Agent\n(Docker container)"]
    end

    subgraph Apps["Apps"]
        API["apps/api\n(Fastify HTTP)\nbots · accounts · credentials\njournals · positions · billing\nagent routes · auth"]
        WORKER["apps/worker\n(Long-running process)\nWorkerRuntime · TradingActor\nBacktestRuntime · AgentRuntime"]
    end

    subgraph Infra["Infrastructure"]
        PG[("PostgreSQL\n(source of truth)")]
        REDIS[("Redis\nBullMQ queues\npub/sub")]
    end

    subgraph Engine["packages/engine"]
        CYCLE["TradingCycle"]
        PLANNER["Planner\n(Decision → Plan)"]
        RISK["RiskGate"]
        EXEC["Executors\npaper / shadow / live"]
        POSTRACK["PositionTracker"]
        RECON["Reconciler"]
        JOURNAL["Journal"]
        MDS["MarketDataFeed\n(polling / stream)"]
    end

    subgraph VenuePkg["packages/venues"]
        HL["HyperliquidAdapter\n(OrderbookVenuePort)"]
        BY["BybitAdapter\n(OrderbookVenuePort)"]
        JUP["JupiterSwapAdapter\n(SwapVenuePort)"]
        INCH["OneInchSwapAdapter\n(SwapVenuePort)"]
        POOL["PublicStreamPool\n(WebSocket fan-out)"]
        MARK["MarkSource\n(Oracle / LastFill)"]
    end

    subgraph Strategy["packages/strategy"]
        STRAT["Strategy impl\n(e.g. Momentum)"]
    end

    subgraph LLM["packages/llm"]
        LLMCLIENT["LLM Client\n(agent decisions)"]
    end

    subgraph Domain["packages/domain (zero deps)"]
        PORTS["Ports\n(OrderbookVenuePort\nSwapVenuePort)"]
        TYPES["Types / Value objects\n(Price, Quantity, Decision)"]
    end

    subgraph DB["packages/db"]
        DRIZZLE["Drizzle ORM\nschemas · repos · migrations"]
    end

    subgraph External["External Venues"]
        HLNET["Hyperliquid API\n(perps)"]
        BYNET["Bybit API\n(perps)"]
        JUPNET["Jupiter API\n(Solana DEX)"]
        ONENET["1inch API\n(EVM DEX)"]
    end

    UI -->|"HTTPS"| API
    AGENT -->|"agent protocol\n(AgentMessageBroker)"| WORKER

    API -->|"reads/writes"| PG
    API -->|"enqueues lifecycle\n& backtest jobs"| REDIS

    WORKER -->|"dequeues jobs"| REDIS
    WORKER -->|"reads/writes"| PG

    WORKER --> CYCLE
    WORKER --> POOL
    CYCLE --> PLANNER
    CYCLE --> RISK
    CYCLE --> EXEC
    CYCLE --> POSTRACK
    CYCLE --> RECON
    CYCLE --> JOURNAL
    CYCLE --> MDS
    STRAT -->|"Decision"| CYCLE
    MDS --> POOL

    JOURNAL -->|"append events"| DRIZZLE
    DRIZZLE --> PG

    EXEC --> HL & BY & JUP & INCH
    RECON --> HL & BY & JUP & INCH
    POOL --> HL & BY

    HL --> HLNET
    BY --> BYNET
    JUP --> JUPNET
    INCH --> ONENET

    PORTS -.->|"implemented by"| HL & BY & JUP & INCH
    TYPES -.->|"used by"| Engine & Strategy & VenuePkg

    LLMCLIENT -->|"generates decisions"| WORKER

    CFG["config/default.yaml\n(operator config)"]
    CFG --> API & WORKER
```

## Package Layers

| Layer | Package | Role |
|---|---|---|
| Domain | `packages/domain` | Zero-dep types, ports, value objects — the shared language |
| Engine | `packages/engine` | Pure business logic — trading cycle, risk gate, executors, reconciler |
| Venues | `packages/venues` | Venue adapters, WebSocket stream pool, mark sources |
| Strategy | `packages/strategy` | Strategy implementations emitting `Decision` objects |
| DB | `packages/db` | Drizzle ORM — schema, repos, migrations |
| Worker | `apps/worker` | Long-running runtime: actors, agent runtime, backtest runtime |
| API | `apps/api` | HTTP surface — CRUD, auth, billing; enqueues BullMQ lifecycle jobs |
| Web | `apps/web` | React/Vite frontend |

**Dependency rule:** `domain` ← `engine` ← `strategy` / `venues` / `db` ← `apps/*`

Nothing in `engine` imports from `venues` or `db`; all cross-boundary communication goes through ports defined in `domain`.
