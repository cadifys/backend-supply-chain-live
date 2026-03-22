# Manufacturing Hub — Workflow Diagrams

---

## 1. System Architecture Overview

```mermaid
graph TB
    subgraph INTERNET["🌐 Internet"]
        WEB["Web Browser\n(Admin / Manager / Super Admin)"]
        MOB["Mobile App\n(Lead / Worker)"]
    end

    subgraph AWS["☁️ AWS Cloud"]
        ALB["Application Load Balancer"]
        ECS["ECS Fargate\nNode.js API :4000"]
        CDN["CloudFront + S3\nReact Web App"]

        subgraph RDS["RDS PostgreSQL"]
            CENTRAL["central schema\n(organizations, super_admins, org_admins)"]
            ORG_A["org_acmeseed schema\n(users, stages, lots, transactions...)"]
            ORG_B["org_betasteel schema\n(users, stages, lots, transactions...)"]
            ORG_N["org_xyz schema\n..."]
        end
    end

    WEB -->|HTTPS| CDN
    WEB -->|API calls /api/*| ALB
    MOB -->|API calls /api/*| ALB
    CDN -->|Static files| WEB
    ALB --> ECS
    ECS -->|central queries| CENTRAL
    ECS -->|SET search_path = org_acmeseed| ORG_A
    ECS -->|SET search_path = org_betasteel| ORG_B
    ECS -->|SET search_path = org_xyz| ORG_N

    style INTERNET fill:#e0f2fe,stroke:#0284c7
    style AWS fill:#f0fdf4,stroke:#16a34a
    style RDS fill:#fefce8,stroke:#ca8a04
```

---

## 2. User Role Hierarchy & Access

```mermaid
graph TD
    SA["👑 SUPER ADMIN\n─────────────────\n• Platform-level only\n• Onboard organisations\n• Reset admin passwords\n• Web app only"]

    OA["🏢 ORG ADMIN\n─────────────────\n• Full org access\n• Configure stages & machines\n• Create all users\n• View all reports\n• Web app only"]

    MGR["📊 MANAGER\n─────────────────\n• Read all production data\n• View reports & dashboards\n• View all transactions\n• NO configuration access\n• Web app only"]

    LEAD["👷 LEAD\n─────────────────\n• Log daily work\n• Send/Accept transfers\n• View own 7-day history\n• Mobile app only"]

    WRK["⚙️ WORKER\n─────────────────\n• Log daily work\n• Send/Accept transfers\n• View own 7-day history\n• Mobile app only"]

    SA -->|"Creates org + first admin"| OA
    OA -->|"Creates managers"| MGR
    OA -->|"Creates leads"| LEAD
    OA -->|"Creates workers"| WRK
    MGR -.->|"Read-only view of"| LEAD
    MGR -.->|"Read-only view of"| WRK

    style SA fill:#7c3aed,color:#fff,stroke:#5b21b6
    style OA fill:#1d4ed8,color:#fff,stroke:#1e40af
    style MGR fill:#0369a1,color:#fff,stroke:#075985
    style LEAD fill:#15803d,color:#fff,stroke:#166534
    style WRK fill:#15803d,color:#fff,stroke:#166534
```

---

## 3. Login & Authentication Flow

```mermaid
flowchart TD
    START(["User opens app/web"]) --> INPUT["Enter email + password"]
    INPUT --> API["POST /api/auth/login"]

    API --> CHECK1{"Is it a\nSuper Admin?"}
    CHECK1 -->|Yes — found in central.super_admins| JWT_SA["Issue JWT\nrole: super_admin\nno orgId"]
    JWT_SA --> REDIRECT_SA["/super-admin dashboard"]

    CHECK1 -->|No| CHECK2{"Is it an\nOrg Admin?"}
    CHECK2 -->|Yes — found in central.org_admins| JWT_OA["Issue JWT\nrole: admin\norgId + orgSchema"]
    JWT_OA --> REDIRECT_OA["/admin dashboard"]

    CHECK2 -->|No| CHECK3{"Check all\norg schemas\nfor this email"}
    CHECK3 -->|Found in org_X.users| ROLE{"What role?"}
    ROLE -->|manager| REDIRECT_MGR["/manager dashboard"]
    ROLE -->|lead or worker| BLOCK["❌ Blocked on web\n'Use mobile app'"]

    CHECK3 -->|Not found anywhere| ERR["❌ Invalid credentials"]

    MOB_LOGIN(["Mobile login"]) --> API2["POST /api/auth/login"]
    API2 --> CHECK_MOB{"Role = lead\nor worker?"}
    CHECK_MOB -->|Yes| JWT_MOB["Issue JWT + store\nin SecureStore"]
    JWT_MOB --> HOME["Mobile Home Tab"]
    CHECK_MOB -->|No — admin/manager| ERR2["❌ Use web dashboard"]

    style START fill:#3b82f6,color:#fff
    style MOB_LOGIN fill:#16a34a,color:#fff
    style ERR fill:#dc2626,color:#fff
    style ERR2 fill:#dc2626,color:#fff
    style BLOCK fill:#f97316,color:#fff
```

---

## 4. Organisation Onboarding Flow (Super Admin)

```mermaid
flowchart TD
    SA_LOGIN(["Super Admin logs in"]) --> SA_DASH["Super Admin Dashboard"]
    SA_DASH --> NEW_ORG["Click 'New Organisation'"]
    NEW_ORG --> FORM["Fill form:\n• Org name + slug\n• Industry\n• Contact details\n• Admin name + email\n• Password (or auto-generate)"]

    FORM --> SUBMIT["Submit"]

    SUBMIT --> DB1["1️⃣ Insert into\ncentral.organizations\nwith slug = 'acmeseed'"]
    DB1 --> DB2["2️⃣ Insert into\ncentral.org_admins\nwith hashed password"]
    DB2 --> DB3["3️⃣ CREATE SCHEMA\norg_acmeseed"]
    DB3 --> DB4["4️⃣ Run migrations in\norg_acmeseed schema\n(create all tables)"]

    DB4 --> SUCCESS["✅ Success Screen\nShows temp password\n(shown ONCE only)"]

    SUCCESS --> SHARE["Super Admin shares\npassword with org admin\nsecurely"]
    SHARE --> ADMIN_LOGIN(["Org Admin logs in\nfor first time"])

    style SA_LOGIN fill:#7c3aed,color:#fff
    style SUCCESS fill:#16a34a,color:#fff
    style DB1 fill:#fef9c3,stroke:#ca8a04
    style DB2 fill:#fef9c3,stroke:#ca8a04
    style DB3 fill:#fef9c3,stroke:#ca8a04
    style DB4 fill:#fef9c3,stroke:#ca8a04
```

---

## 5. Admin Setup Flow (One-time Configuration)

```mermaid
flowchart LR
    ADMIN_IN(["Admin first login"]) --> STEP1

    subgraph STEP1["Step 1 — Create Stages"]
        S1["Add Stage: Raw Intake\n(order: 1)"]
        S2["Add Stage: Cleaning\n(order: 2)"]
        S3["Add Stage: Processing\n(order: 3)"]
        S4["Add Stage: Packaging\n(order: 4)"]
        S1 --- S2 --- S3 --- S4
    end

    STEP1 --> STEP2

    subgraph STEP2["Step 2 — Connect Stages (Flow)"]
        C1["Raw Intake → Cleaning"]
        C2["Cleaning → Processing"]
        C3["Processing → Packaging"]
        C1 --- C2 --- C3
    end

    STEP2 --> STEP3

    subgraph STEP3["Step 3 — Add Machines"]
        M1["Cleaner A → Cleaning stage"]
        M2["Thresher 1 → Processing stage"]
        M3["Packer M1 → Packaging stage"]
        M1 --- M2 --- M3
    end

    STEP3 --> STEP4

    subgraph STEP4["Step 4 — Create Users"]
        U1["Manager: Rahul\n(email login)"]
        U2["Lead: Suresh\n(Cleaning stage)"]
        U3["Worker: Ramesh\n(Processing stage)"]
        U4["Worker: Gopal\n(Packaging stage)"]
        U1 --- U2 --- U3 --- U4
    end

    STEP4 --> READY(["✅ Plant Ready\nWorkers can start logging"])

    style ADMIN_IN fill:#1d4ed8,color:#fff
    style READY fill:#16a34a,color:#fff
```

---

## 6. Core Material Flow — Lot Journey

```mermaid
flowchart TD
    RM(["🚛 Raw Material Arrives\n5000 kg Wheat — LOT-2024-031"])

    RM --> CREATE_LOT["Admin creates Lot\nLOT-2024-031\nQty: 5000 kg\nStarts at: Raw Intake"]

    CREATE_LOT --> STAGE1

    subgraph STAGE1["📦 Stage 1 — Raw Material Intake"]
        W1_LOG["Gopal logs work:\nInput: 5000 kg\nProcessed: 5000 kg\nOutput: 4950 kg\nLoss: 50 kg ⚠️"]
        W1_TRANSFER["Gopal sends transfer:\n4950 kg → Cleaning"]
    end

    STAGE1 --> PENDING1{{"⏳ Transfer PENDING\nRaju must accept"}}
    PENDING1 -->|"Raju taps Accept ✅"| STAGE2

    subgraph STAGE2["🌀 Stage 2 — Cleaning & Grading"]
        W2_LOG["Raju logs work:\nInput: 4950 kg\nProcessed: 4950 kg\nOutput: 4860 kg\nLoss: 90 kg ⚠️\nMachine: Air Cleaner A"]
        W2_TRANSFER["Raju sends transfer:\n4860 kg → Processing"]
    end

    STAGE2 --> PENDING2{{"⏳ Transfer PENDING\nSuresh must accept"}}
    PENDING2 -->|"Suresh taps Accept ✅"| STAGE3

    subgraph STAGE3["⚙️ Stage 3 — Processing"]
        W3_LOG["Suresh logs work:\nInput: 4860 kg\nProcessed: 4860 kg\nOutput: 4800 kg\nLoss: 60 kg ⚠️\nMachine: Thresher 1"]
        W3_TRANSFER["Suresh sends transfer:\n4800 kg → Packaging"]
    end

    STAGE3 --> PENDING3{{"⏳ Transfer PENDING\nGopal must accept"}}
    PENDING3 -->|"Gopal taps Accept ✅"| STAGE4

    subgraph STAGE4["📦 Stage 4 — Packaging"]
        W4_LOG["Gopal logs work:\nInput: 4800 kg\nProcessed: 4800 kg\nOutput: 4780 kg\nLoss: 20 kg ⚠️\nMachine: Packer M1"]
    end

    STAGE4 --> COMPLETE["✅ Admin marks Lot COMPLETED\nTotal Loss: 220 kg (4.4%)\nFinished: 4780 kg"]

    style RM fill:#f97316,color:#fff
    style COMPLETE fill:#16a34a,color:#fff
    style PENDING1 fill:#fef9c3,stroke:#ca8a04
    style PENDING2 fill:#fef9c3,stroke:#ca8a04
    style PENDING3 fill:#fef9c3,stroke:#ca8a04
```

---

## 7. Worker Daily Work Logging (Mobile App)

```mermaid
flowchart TD
    OPEN(["Worker opens mobile app"]) --> HOME["Home Tab\nSees today's stats +\nactive lots at their stage"]

    HOME --> TAP_LOT["Taps a Lot\n(e.g. LOT-2024-031)"]
    TAP_LOT --> LOG_WORK["Goes to Log Work tab"]

    LOG_WORK --> SELECT_LOT["Selects Lot\nfrom pill buttons"]
    SELECT_LOT --> SELECT_STAGE["Confirms current stage\n(auto-shown from lot)"]
    SELECT_STAGE --> ENTER_QTY

    subgraph ENTER_QTY["Enter Quantities"]
        Q1["Input Qty\n(received at station)"]
        Q2["Processed Qty\n(actually worked on)"]
        Q3["In-Stock Qty\n(waiting in queue)"]
        Q4["Output Qty\n(ready to send forward)"]
    end

    ENTER_QTY --> LOSS_CALC["🔴 Loss Auto-Calculated\nLoss = Processed - Output\nShown immediately"]

    LOSS_CALC --> VALIDATE{"Output >\nProcessed?"}
    VALIDATE -->|Yes| ERR["❌ Error shown\n'Output cannot exceed processed'"]
    ERR --> ENTER_QTY

    VALIDATE -->|No| NOTES["Optional: Add notes"]
    NOTES --> SUBMIT["Tap 'Log Work'"]
    SUBMIT --> SAVED["✅ Transaction saved\nHome stats update instantly"]

    SAVED --> SEND_TRANSFER{"Want to send\nmaterial forward?"}
    SEND_TRANSFER -->|Yes| GO_TRANSFER["Go to Transfers tab\nCreate transfer request"]
    SEND_TRANSFER -->|No| DONE(["Done for now"])

    style OPEN fill:#16a34a,color:#fff
    style LOSS_CALC fill:#fef2f2,stroke:#dc2626
    style ERR fill:#dc2626,color:#fff
    style SAVED fill:#16a34a,color:#fff
```

---

## 8. Material Transfer Flow (Stage to Stage)

```mermaid
sequenceDiagram
    actor Raju as Raju (Stage A Worker)
    participant API as Backend API
    participant DB as Database
    actor Suresh as Suresh (Stage B Worker)

    Note over Raju,Suresh: Raju wants to send 4860 kg to Stage B

    Raju->>API: POST /worker/transfers<br/>{lotId, fromStage: A, toStage: B, qty: 4860}
    API->>DB: Validate: A→B connection exists?
    DB-->>API: ✅ Valid connection
    API->>DB: INSERT material_transfers<br/>status = 'pending'
    API-->>Raju: ✅ Transfer request sent

    Note over Suresh: Suresh opens Transfers tab

    Suresh->>API: GET /worker/transfers/incoming
    API->>DB: SELECT where to_stage = B, status = pending
    DB-->>API: [Transfer: LOT-031, 4860kg from Raju]
    API-->>Suresh: Shows pending transfer card

    alt Suresh accepts
        Suresh->>API: PUT /worker/transfers/:id/accept
        API->>DB: UPDATE transfers SET status = 'accepted'
        API->>DB: UPDATE lots SET current_stage_id = Stage B
        API-->>Suresh: ✅ Accepted — lot now at Stage B
        Note over Suresh: LOT-031 appears in Suresh's lot list
    else Suresh rejects
        Suresh->>API: PUT /worker/transfers/:id/reject
        API->>DB: UPDATE transfers SET status = 'rejected'
        API-->>Suresh: Rejected
        Note over Raju: Raju sees 'Rejected' in Outgoing tab
        Note over Raju: Raju can re-send or send to different stage
    end
```

---

## 9. Reports & Dashboard Data Flow

```mermaid
flowchart LR
    subgraph WORKERS["Workers Log Work Daily"]
        T1["Raju: 2000kg in, 1960kg out"]
        T2["Suresh: 1800kg in, 1760kg out"]
        T3["Gopal: 3000kg in, 2950kg out"]
    end

    WORKERS -->|"INSERT stage_transactions"| DB[("PostgreSQL\nstage_transactions")]

    DB -->|"SUM / GROUP BY"| DASH

    subgraph DASH["Admin Dashboard (auto-refresh 60s)"]
        D1["Today Input: 6800 kg"]
        D2["Today Output: 6670 kg"]
        D3["Today Loss: 130 kg"]
        D4["Stage A Efficiency: 98%"]
        D5["7-Day Bar Chart"]
    end

    DB -->|"GROUP BY worker_id"| EFF

    subgraph EFF["Efficiency Report"]
        E1["Raju: 98% efficiency\n✅ Green"]
        E2["Suresh: 97.7% efficiency\n✅ Green"]
        E3["Machine Thresher 1: 96%\n🟡 Yellow — check maintenance"]
    end

    DB -->|"JOIN lots + stages"| FLOW

    subgraph FLOW["Material Flow Report"]
        F1["LOT-031: 5000kg in\n→ Stage1 lost 50kg\n→ Stage2 lost 90kg\n→ Stage3 lost 60kg\n= 4800kg out"]
    end

    style WORKERS fill:#e0f2fe,stroke:#0284c7
    style DB fill:#fefce8,stroke:#ca8a04
    style DASH fill:#f0fdf4,stroke:#16a34a
    style EFF fill:#f0fdf4,stroke:#16a34a
    style FLOW fill:#f0fdf4,stroke:#16a34a
```

---

## 10. Stage Configuration — DAG Examples

```mermaid
graph LR
    subgraph LINEAR["Linear Flow (Seed Processing)"]
        L1["Raw Intake"] --> L2["Cleaning"] --> L3["Threshing"] --> L4["Drying"] --> L5["Packaging"]
    end

    subgraph BRANCH["Branching Flow (Two Lines)"]
        B1["Raw Intake"] --> B2["Line A Processing"]
        B1 --> B3["Line B Processing"]
        B2 --> B4["Quality Check"]
        B3 --> B4
        B4 --> B5["Final Packing"]
    end

    subgraph SKIP["Skip-Stage Flow (Express Route)"]
        K1["Raw Intake"] --> K2["Standard Processing"]
        K2 --> K3["Quality Check"]
        K3 --> K5["Packaging"]
        K1 --> K4["Premium Processing"]
        K4 --> K5
    end

    style L1 fill:#dbeafe,stroke:#2563eb
    style L5 fill:#dcfce7,stroke:#16a34a
    style B1 fill:#dbeafe,stroke:#2563eb
    style B5 fill:#dcfce7,stroke:#16a34a
    style K1 fill:#dbeafe,stroke:#2563eb
    style K5 fill:#dcfce7,stroke:#16a34a
```

---

## 11. Full System Entity Relationship

```mermaid
erDiagram
    SUPER_ADMINS {
        uuid id PK
        string name
        string email
        string password_hash
    }

    ORGANIZATIONS {
        uuid id PK
        string name
        string slug "→ DB schema name"
        string industry
        uuid created_by FK
    }

    ORG_ADMINS {
        uuid id PK
        uuid org_id FK
        string name
        string email
        string password_hash
    }

    USERS {
        uuid id PK
        string name
        string email
        string role "manager/lead/worker"
        boolean is_active
    }

    STAGES {
        uuid id PK
        string name
        int stage_order
        boolean is_active
    }

    STAGE_CONNECTIONS {
        uuid id PK
        uuid from_stage_id FK
        uuid to_stage_id FK
    }

    MACHINES {
        uuid id PK
        string name
        uuid stage_id FK
    }

    LOTS {
        uuid id PK
        string lot_number
        string crop
        decimal total_qty
        uuid current_stage_id FK
        string status "active/completed"
    }

    STAGE_TRANSACTIONS {
        uuid id PK
        uuid lot_id FK
        uuid stage_id FK
        uuid worker_id FK
        uuid machine_id FK
        date transaction_date
        decimal input_qty
        decimal processed_qty
        decimal output_qty
        decimal loss_qty "GENERATED"
    }

    MATERIAL_TRANSFERS {
        uuid id PK
        uuid lot_id FK
        uuid from_stage_id FK
        uuid to_stage_id FK
        decimal qty
        uuid requested_by FK
        string status "pending/accepted/rejected"
    }

    SUPER_ADMINS ||--o{ ORGANIZATIONS : "creates"
    ORGANIZATIONS ||--o{ ORG_ADMINS : "has"
    STAGES ||--o{ STAGE_CONNECTIONS : "from"
    STAGES ||--o{ STAGE_CONNECTIONS : "to"
    STAGES ||--o{ MACHINES : "has"
    LOTS ||--o{ STAGE_TRANSACTIONS : "tracked in"
    STAGES ||--o{ STAGE_TRANSACTIONS : "at"
    USERS ||--o{ STAGE_TRANSACTIONS : "performed by"
    MACHINES ||--o{ STAGE_TRANSACTIONS : "used in"
    LOTS ||--o{ MATERIAL_TRANSFERS : "moved via"
```

---

## 12. Multi-Tenant Request Lifecycle

```mermaid
sequenceDiagram
    actor Worker as Worker (Raju)
    participant App as Mobile App
    participant API as Express API
    participant Auth as Auth Middleware
    participant Tenant as Tenant Middleware
    participant DB as PostgreSQL

    Worker->>App: Tap "Log Work" submit
    App->>API: POST /api/worker/transactions<br/>Authorization: Bearer <JWT>

    API->>Auth: Verify JWT token
    Auth-->>API: ✅ {userId, role:'worker', orgSchema:'org_acmeseed'}

    API->>Tenant: Inject tenant DB
    Tenant->>DB: Get connection pool for org_acmeseed
    Tenant->>DB: SET search_path = "org_acmeseed", public
    Tenant-->>API: req.tenantDb = scoped connection

    API->>API: RBAC check: role >= 'worker' ✅

    API->>DB: INSERT INTO stage_transactions (...)\n[automatically lands in org_acmeseed.stage_transactions]
    DB-->>API: Transaction saved ✅

    API-->>App: 201 Created
    App-->>Worker: "Work logged successfully!"

    Note over DB: org_betasteel data is\ncompletely untouched
```
