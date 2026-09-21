# **PAS-001: DocPost Blueprint**

# **PAS-001 Blueprint: \[DocPost\]** 

Status: Draft | Owner: Rayane Ventura | Updated: 08.08.2026

# **What problem we're solving and why**

Upload a set of documents to many destinations at once.  
**Current State:** The document platform only supports uploading a single file to a single destination. Coordinators repeat the same upload dozens or hundreds of times per batch. The work is slow, and because it is manual, files get skipped or land in the wrong binder with no record of what went wrong.

**Impact:** Coordinator hours are wasted on mechanical repetition. Worse, in a regulated clinical trial context, a missed or misplaced document is a compliance problem, not just an inconvenience. There is currently no way to answer "did every file reach every destination?" with confidence.

# **Context**

The client needs a tool, that lets a user:

* Select multiple files in a single session  
* Map each file to one or more destinations that they have access to (teams, binders, folders)  
* Submit the whole batch in one action  
* Track the progress of every individual upload  
* Know exactly which uploads succeeded and which failed

  # **Domain Dictionary**

  **Document Platform:** A permission controlled document repository organized as **Team → Binder → Folder → Document**, deployed independently per region.  
  **Destination:** A specific binder or folder within a team where a file can be delivered.  
  **Job:** A single batch submission containing uploaded files and their destination mappings.  
  **Task:** The atomic unit of work representing one file delivered to one destination.  
  **Staging:** Temporary encrypted storage for uploaded files before delivery, retained for 30 days after job completion.  
  **Delivery:** The background process of transferring a staged file to a destination with integrity verification.  
  **Task Lifecycle:** The progression of a task through **Pending → In Progress → Completed** or **Failed**.


  # **Related Documentation**

* Design Requirements: [DocPost Requirements](https://docs.google.com/document/d/1XZb3DNl7iRZ2rB6iCkQM5QnZ3TeSpYO1ypxbkaVlaUc/edit?tab=t.0)  
* HLD: [https://app.eraser.io/workspace/c9Wa9y7fnkrHFSnYAt75](https://app.eraser.io/workspace/c9Wa9y7fnkrHFSnYAt75)

  # **Job Stories**

1. **When** I start a distribution session, **I want** to browse only the teams, binders, and folders I am authorized to access, **so that** I can confidently select valid destinations.  
2. **When** I need to distribute several documents, **I want** to upload all my files in a single batch and assign them to one or more destinations, **so that** I can complete large submissions efficiently without repeating the same work.  
3. **When** I submit a batch, **I want** immediate confirmation that it has been accepted, **so that** I can continue working while the deliveries are processed in the background.  
4. **When** my batch is being processed, **I want** each delivery to succeed or fail independently, **so that** one failed delivery does not prevent the others from completing.  
5. **When** my uploads are being processed, **I want** to monitor the status of the overall job and each individual delivery, **so that** I always know what has completed, what is still running, and what requires attention.  
6. **When** a delivery fails, **I want** to know which file, which destination, and the reason for the failure, **so that** I can resolve the problem and retry if necessary.

   ## **High-Level Architecture (** [https://app.eraser.io/workspace/c9Wa9y7fnkrHFSnYAt75](https://app.eraser.io/workspace/c9Wa9y7fnkrHFSnYAt75) **)**

| Components Overview |  |
| :---- | :---- |
| **Component** | **Responsibility** |
| **Web Client (React SPA)** | Allows users to browse destinations, select files, map files to destinations, submit jobs, and monitor job progress. Uploads and downloads files directly to the staging store using presigned URLs. |
| **API Gateway** | Public entry point for all HTTP and WebSocket traffic. Validates JWTs, applies throttling, and routes requests to private services. Never transfers file bytes. |
| **Internal Application Load Balancer (ALB)** | Routes authenticated requests within the private network to the appropriate service using host and path-based routing. Not publicly accessible. |
| **Authentication Service** | Manages user registration, authentication, password storage, and JWT issuance. Provides short-lived service tokens for internal service-to-service authentication. The only component that handles credentials. |
| **DocPost API** | Handles destination discovery, presigned URL generation, job submission, and job/task status queries. Owns the job, task, and file metadata. Never processes file contents. |
| **Staging Store (Amazon S3 \+ AWS KMS)** | Stores uploaded files encrypted at rest until delivery completes. Enforces server-side encryption and automatically removes staged files 30 days after job completion using lifecycle policies. |
| **PostgreSQL (one instance, three isolated logical databases)** | Persistent data store. Each service owns its own logical database and accesses it using dedicated credentials. Stores users, permissions, jobs, tasks, file metadata, and integrity checksums. Cross-service data is accessed only through service APIs. |
| **Amazon SQS (Job Queue, Task Queue, and DLQs)** | Decouples job submission from document delivery. The Job Queue triggers asynchronous fan-out, while the Task Queue schedules one message per delivery task. Separate DLQs ensure failed messages are retained for recovery instead of being lost. |
| **Worker Tier (AWS Lambda \+ SQS Event Source Mappings)** | Executes asynchronous processing. The Fan-out Lambda expands jobs into task messages, while the Delivery Lambda retrieves staged files, verifies integrity, delivers documents to the platform, updates task status, and pushes live status updates through WebSockets. Database access is mediated through RDS Proxy. |
| **Document Platform (Mock DMS)** | Destination system deployed independently in each region. Stores delivered documents within the appropriate team, binder, and folder hierarchy, and confirms successful delivery. |

   **System Boundaries :** There are **THREE** main product areas.

   

   **DocPost:** Batch upload application used by coordinators

   **Document Platform:** Owns teams, binders, folders, documents and permissions

   Although **DocPost** and the **Document platform** are separate application capabilities, everything is being built as part of this project.

   **DocPost** does not permanently own the final documents. It stages the files and delivers them through the document platform’s internal API.

   **The final destination is:**

   **Team → Binder → Folder → (Nested Folder) → Document**

   # **User Flows** 

   ## **Flow 1: Browse destinations**

* The user signs in and starts a new distribution session.  
* The web client retrieves the list of available regions..  
* For each region, the web client requests the teams enabled for DocPost through the DocPost API.  
* As the user navigates the hierarchy, binders and folders are loaded on demand and filtered according to the user's permissions.  
* The user chooses one or more destinations for the document batch.  
  **Expected outcome:** The destination hierarchy is displayed in under 500ms, and the user can access and select only destinations for which they have permission.

  ## **Flow 2: Distribute a batch of documents**

* The user starts a new distribution session.  
* The user navigates the available destination hierarchy and selects the required target folders.  
* The user selects up to 100 files, which are uploaded directly from the browser to the staging store while upload progress is shown for each file.  
* The user associates one or more files with one or more destinations.  
* Once the submission is confirmed, the system acknowledges the request in under 500 ms and immediately displays the newly created job with all tasks in the **Pending** state.  
* Background workers independently verify each uploaded file and deliver it to the appropriate regional document platform. Transient failures are automatically retried at least three times.  
  **Expected outcome:** Every task eventually reaches either the **Completed** or **Failed** state, with failures reporting a clear reason (+DLQ). A failure affecting one task does not impact the processing of any other task.  
  ---

  ## **Flow 3: Monitor a job**

* The user opens the job dashboard to review both active and completed jobs.  
* Each job displays an overall status calculated from the state of its individual tasks.  
* Selecting a job reveals every task, including its file, destination, and current processing status (**Pending**, **In Progress**, **Completed**, or **Failed**).  
* Task status changes are pushed to the interface automatically without requiring the user to refresh the page.  
  **Expected outcome:** The user can quickly determine whether every file has been delivered to every selected destination and, if any delivery fails, identify the affected file, destination, and failure reason. User should also be able to see the audit of past jobs and tasks.  
  ---

  ## **Flow 4: Download a staged file**

* The user opens a job submitted by any member of one of their teams.  
* The user selects a staged file to download.  
* The system validates the user's team membership and issues a short-lived download URL for the staging store.  
* The browser downloads the file directly from the staging store without routing the file through the application servers.

**Expected outcome:** Any authorized team member can retrieve staged files belonging to their team's jobs, while unauthorized users are prevented from accessing the files at every stage of the process.

# **Decisions that require architectural decisions**

            [DocPost - Rayane Ventura](https://docs.google.com/document/d/1SDteRJuSXlhbqEv4XGTbCR1sKfI1PgyY51WX1UmIi48/edit?tab=t.rmzplle76p34) \- ADR

# **Technical Design** 

   
[DocPost - Rayane Ventura](https://docs.google.com/document/d/1SDteRJuSXlhbqEv4XGTbCR1sKfI1PgyY51WX1UmIi48/edit?tab=t.1m78kwcuuynr) \- Technical Design

# **ADRs \- Architectural Decision Records**

# **ADR-001: DocPost Architectural Decision Record**

# **ADR-001** Edge Architecture for Public API Traffic

# **Context:**

DocPost offers an HTTP REST API  that is consumed by the web SPA. Behind the API gateway sits multiple services (auth, DocPost API, Document Platform). All endpoints are authenticated and services run in containers inside a private network in aws ECS

# **Decision Matrix:** How do we route internet traffic to internal services?

## 

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Architecture Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| 1\. Public ALB → ECS Services | • Simplest architecture • Native ECS integration • Lowest infrastructure cost • Easy to operate, monitor, and debug | • Public-facing load balancer • Authentication handled by application services • No built-in API throttling • Less centralized API governance | Best for small to medium sized systems, internal tools, early stage products, or applications where simplicity, lower cost, and operational ease are more important than centralized edge controls. |
| **2\. API Gateway → VPC Link → Internal ALB → ECS Services** *(Selected)* | • JWT authentication at the edge • Built-in throttling and rate limiting • Internal load balancer with private services • Centralized API policies and security • Clear separation between public and private infrastructure | • Additional infrastructure components • Two routing layers increase request path complexity • More difficult debugging • Higher operational cost | Best for enterprise, healthcare, finance, or other security sensitive systems that require centralized authentication, throttling, auditing, and private backend services. |
| 3\. API Gateway → VPC Link → Cloud Map or NLB → ECS Services | • Managed public API entry point • Edge authentication and throttling • Can eliminate the need for an Application Load Balancer • Well suited for direct service discovery integrations | • More complex service discovery • Still requires a VPC Link• Less flexible routing than an ALB • Fewer Layer 7 features • Higher operational complexity | Best for specialized architectures where services already use AWS Cloud Map or a Network Load Balancer, where Layer 4 routing is sufficient, or where avoiding an ALB is a deliberate architectural decision. |

## 

# **Decision:** 

For **DocPost**, Option 2 is the best fit because it keeps ECS services private while providing centralized JWT validation and throttling at the public edge. Having the API Gateway as the entry point offers:

* Centralized authentication  
* Managed throttling  
* A private backend boundary  
* Stronger API governance

**Refined By**: Rayane Ventura

# **ADR-002 File Upload Route**

# **ADR-002** File Upload Route

# **Context:**

Users can upload up to 100 files ranging from 2MB-1GB, team members can download the files they have access to without ever losing UI interactivity, file integrity must be verifiable , Job acknowledgement kept under 500ms regardless of batch size. Files are encrypted at rest via aws KMS server side encryption so keys are never sent with the file bytes. 

# **Decision Matrix:** Do uploaded files travel through our internal services before reaching the storage BLOB, or are directly uploaded through presigned URLs?

## 

| Options Considered |  |  |  |  |
| :---- | :---- | :---- | :---- | :---- |
| **Option** | **File-byte path** | **Advantages** | **Disadvantages** | **Best use case** |
| **1\. Presigned uploads and downloads** *(Selected)* | Upload: Browser → S3 Download: S3 → Browser | • API does not handle file bandwidth • Large transfers do not occupy API connections • Supports parallel uploads and per file progress • S3 can enforce upload restrictions • Scales well for large files and high concurrency | • API does not observe upload completion directly • Objects must be verified before Job creation or delivery • Presigned URLs are temporary bearer credentials • Requires S3 CORS and upload state coordination | Best for systems handling large files, batch uploads, high concurrency, and asynchronous processing. |
| **2\. Proxy all file bytes through API servers** | Upload: Browser → API → S3 Download: S3 → API → Browser | • API directly observes transfer success or failure • Centralized validation and scanning • No presigned bearer URLs exposed to clients • Client communicates only with the API | • API must scale with file bandwidth • Long uploads keep connections open • Every byte passes through two network legs • Higher latency and infrastructure cost • Resumable uploads and streaming logic must be implemented | Best when strict in line inspection is required, files are relatively small, or clients cannot access object storage directly. |
| **3\. Proxy uploads and use presigned downloads** | Upload: Browser → API → S3 Download: S3 → Browser | • API directly observes uploads• Downloads do not consume API bandwidth• Centralized upload validation | • Retains upload scaling and connection problems • Two transfer mechanisms must be maintained • More complex security and testing • Less consistent architecture | Best when uploads must pass through the API for a specific compliance or validation requirement, but downloads should remain scalable. |

# **Decision:** 

DocPost may process large files, multiple parallel uploads, and asynchronous deliveries. Presigned transfers keep file bytes outside the API tier, allowing the API services to focus on authentication, authorization, Job creation, Task management, and status tracking.  
**Recommended Mitigations:**  
• Scope each presigned request to one object  
• Use short expiration times  
• Delete abandoned uploads using an S3 lifecycle policy

**Refined By:** Rayane Ventura

# **ADR-003 Encryption at rest for staged files**

# **ADR-003** Encryption at rest for staged files 

# **Context:**

The requirements explicitly declares we should use a encryption key management service instead of creating our own. Files go directly from browser to s3 via presigned URLs [(ADR-002)]() , so client should not handle encryption key. Staged files contain critical healthcare document, so control, audit, revoke and rotation of keys matter. 

# **Decision Matrix:** Which s3 server side encryption service should we use ?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. SSE S3 (S3 managed keys)** | • Zero configuration • No KMS request cost • Fully compatible with presigned uploads • Simplest operational model | • No control over encryption keys • No custom key policies • No independent key revocation • Limited auditability of key usage • Weakest option for compliance sensitive systems | Best for prototypes, internal tools, or low risk applications where ease of use and low cost are more important than strict security and compliance controls. |
| **2\. SSE-KMS with AWS-managed key (`aws/s3`)** *(Selected)* | • Managed by AWS KMS  • No customer key management required • Compatible with presigned uploads • CloudTrail records KMS usage • Meets the requirement of using a cloud managed KMS | • Key policy cannot be customized • Key cannot be disabled or deleted • Encryption key cannot be used as an access boundary • Rotation schedule is fully managed by AWS | Good for production systems that require KMS managed encryption but do not need full control over encryption keys or advanced security policies.This approach satisfies the project's security requirements while minimizing operational complexity and KMS request costs.  |
| **3\. SSE KMS with Customer Managed Key (CMK)**  | • Full control over key policies • Least-privilege access control • Key can be disabled or scheduled for deletion • Automatic or manual key rotation • Complete CloudTrail auditing • Strong separation between storage permissions and decryption permissions • Ideal for multi region architectures and regulated environments | • Additional KMS key and request costs • More complex IAM and key policy management • Requires operational management of encryption keys | These capabilities are **not required for the first version of DocPost** and introduce additional operational overhead without providing immediate value for the stated requirements. |
| **4\. SSE-C (Customer-Provided Keys)** |  • Full ownership and possession of encryption key material • Independent of AWS KMS  | • Raw encryption keys must be supplied with every S3 request • Presigned browser uploads would expose encryption keys, making this unsuitable for direct browser uploads • The platform must securely store and protect raw key material itself • No built-in key rotation, auditing, or centralized key management from AWS • Significantly higher security and operational burden | Suitable only for highly specialized environments with strict external key management requirements where the application,not the cloud provider,must own all encryption keys. **Not recommended for DocPost**, as it conflicts with secure browser uploads and the project's requirement to use a dedicated cloud key management service. |

# **Decision:** 

**Use server-side encryption with AWS KMS (SSE-KMS) using the AWs managed `aws/s3` key, with S3 Bucket Keys enabled.**

This approach satisfies the project's security requirements while minimizing operational complexity and KMS request costs.

If a future customer, auditor, or regulatory requirement demands customer ownership of encryption keys, DocPost can migrate to **SSE-KMS with a Customer-Managed Key (CMK)**.

The migration requires only infrastructure changes:

**Refined By:** Rayane Ventura

# **ADR-004 Presigned URLs expiration policy**

# **ADR-004** Presigned URLs expiration policy

# **Context:**

A presigned URL  is a bearer credential: Anyone holding it can perform the signed operation until it expires. Therefore the safeguard will be to have an ideal expiry time. Download and Upload have different usage patterns. Upload can have a higher latency , specially in slow networks , while Download starts right after being issued, but can take a long time to complete, if it started before expiration, should not be revoked.                

# **Decision Matrix:** How long do upload (POST) and download (GET) urls stay valid ?

# **Decision:** 

* **Upload URLs:** 15 min, giving browsers enough time for large batches.  
* **Download URLs:** 2 min, since downloads start immediately.  
* Each URL is scoped to **one object and one operation**.  
* **URL expiry** controls credential validity, the **staging deadline** controls how long the job waits for the file.  
* Transfers started before expiry can **finish normally**, even after expiry.

**Refined By:** Rayane Ventura

# **ADR-005 Task and queue for async delivery**

# **ADR-005** Task and queue technology for asynchronous delivery

# **Context:**

One single Job creates up to 2,000 tasks, and the system handles up to 90,000 deliveries/day so submissions need to be completely decoupled from task creation. At least  3 attempts at delivery in case of failure, no silent loss and failures are isolated, not impacting other tasks..       

# **Decision Matrix:** What component temporarily holds Tasks after a Job is created, but before a worker starts processing them?

| Options Considered |  |  |  |
| ----- | ----- | ----- | ----- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Amazon SQS Standard Queue \+ DLQ** *(Selected)* | • Fully managed with no brokers to operate • Automatic retries using visibility timeout • Built-in dead-letter queue support • Scales automatically for large task spikes • Low cost with pay-per-request pricing • Naturally models one message per task | • At-least-once delivery requires idempotent workers • AWS-specific implementation • Local development typically requires LocalStack or a development queue | Best for independent background task processing where scalability, reliability, automatic retries, and minimal operational overhead are the primary requirements. |
| **2\. RabbitMQ (Self-managed or Amazon MQ)** | • Flexible routing with exchanges, topics, and priorities • Cloud portable • Easy to run locally using Docker | • Requires broker provisioning and maintenance • Retry and dead-letter behaviour require additional configuration • Higher operational cost than SQS | Best for systems requiring advanced routing patterns, message priorities, or complex messaging workflows beyond simple work queues. |
| **3\. Apache Kafka (Amazon MSK)** | • Extremely high throughput • Durable event retention and replay • Supports multiple independent consumers • Excellent for analytics and event streaming | • Partition ordering can delay independent tasks • Retry and DLQ behaviour must be implemented separately • Highest infrastructure complexity and cost | Best for large-scale event streaming, analytics pipelines, and audit logging where event replay and multiple downstream consumers are required. |
| **4\. PostgreSQL Queue (`SELECT ... FOR UPDATE SKIP LOCKED`)** | • No additional infrastructure • Transactional enqueueing with job creation • Simple to inspect and manage using SQL | • Background processing competes with application queries • Retry, visibility timeout, and DLQ must be implemented in application code • Polling overhead increases with worker count • Limited scalability compared to dedicated queues | Best for small systems, prototypes, or low-throughput applications where operational simplicity is more important than scalability and resilience. |

# **Decision:** 

SQS Standard maps directly to the system requirements:

* **Visibility timeout and `maxReceiveCount`** provide at least three delivery attempts.  
* **One message per task** allows every file-to-destination delivery to be processed independently.  
* **The dead-letter queue** ensures that tasks that exhaust their retries are isolated for investigation rather than silently lost.  
* **At-least-once delivery** means duplicate messages are possible, so the delivery worker must be idempotent. This is already an identified system requirement and would be necessary with any reliable queueing solution.

**Refined By:** Rayane Ventura

# **ADR-006 Service decomposition**

# **ADR-006** Service decomposition 

# **Context:**

The architecture does not require aggressive decomposition for scalability. However, one service boundary is unavoidable: delivery workers communicate with the regional document platform over HTTP. Therefore, even if the application API is implemented as a Monolith, the overall system is still distributed because document delivery crosses a real network boundary

# **Decision Matrix:** Is the API tier one deployable (modular monolith) or multiple services, and if multiple, how many?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Modular Monolith**  | • Simplest operational model with a single deployment pipeline and service to monitor. • In-process authorization and validation with no network latency between modules. • Supports ACID transactions across modules. • Lowest infrastructure and operational cost. | • Module boundaries rely on code discipline rather than infrastructure. • A faulty deployment can affect the entire API. • The document platform API is an internal interface rather than an independently deployable service. | Best for small to medium-scale systems where development simplicity, low operational overhead, and strong transactional consistency are more important than independent service deployment. |
| **2\. Three Services (Authentication, DocPost API, Document Platform)** *(Selected)* | • Clear service ownership with isolated credentials and databases. • Independent deployment and failure domains. • Authentication remains available even if other services fail. • The document platform exposes a genuine external API consumed by both the API and delivery workers. • Authentication logic is isolated in a small, stable service. | • Higher operational complexity with three deployment pipelines and services. • Authorization and membership validation require network calls. • Introduces distributed-system failure modes and higher request latency. | Best for large organizations with multiple development teams requiring independent deployments, strong service isolation, and clear API contracts. |
| **3\. Two Services (Authentication merged into DocPost API, Document Platform separate)** | • Preserves the required external boundary with the document platform. • Simpler than a three-service architecture with one fewer deployable component. • Lower operational overhead than Option 2\. | • Authentication becomes coupled with the largest and most frequently deployed service. • Increases the security surface by mixing credential management with application logic. • Provides limited operational savings compared to the three-service architecture. | Best for systems that require a separate document platform but do not benefit enough from isolating authentication into its own service. |

# **Decision:** Three Services

The system will use three independently deployable services:

* **Authentication Service**  
* **DocPost API**  
* **Document Platform Service**

The Document Platform boundary is required because document delivery already occurs through its HTTP API. Separating authentication adds relatively little operational cost while providing strong security isolation for passwords, tokens, and credential-handling logic.

**Refined By:** Rayane Ventura

# **ADR-007: Task status updates to the client**

# **ADR-007**: Delivering task status updates to the client

# **Context:**

One job generates up to 2,000 tasks, The job’s dashboard is a core feature, and update latency is user facing, although scale is modest with 200 concurrent users browsing a job

# **Decision Matrix:** How does the browser receive Tasks updates while the job is running?

| Options Evaluated |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Short Polling** | • Simplest implementation, using the existing job-status endpoint. • Requires no persistent connection state .• Works through the existing edge without infrastructure changes. • At 200 concurrent users, polling every 2–3 seconds produces roughly 70 requests per second, which is manageable for indexed status reads. | • Updates can be delayed by the polling interval. • The dashboard feels periodically refreshed rather than live. • Most requests return no new information. • Generates the highest request volume relative to the amount of useful data returned. | Best for modest-scale systems where simplicity and low implementation risk are more important than real-time updates. |
| **2\. Server-Sent Events (SSE)** | • Well suited to one-way status updates from server to browser. • Native browser support through `EventSource`. • Supports automatic reconnect and resume using `Last-Event-ID` .• Requires relatively little client and server code when the infrastructure supports streaming. | • Incompatible with the current API Gateway HTTP API path because responses may be buffered and connection duration is limited. • Requires a separate public-facing ingress, such as a public ALB. • Breaks the single-edge security model defined in ADR-001. • Authentication would need to be enforced across two public paths. | Best when the existing ingress supports long-lived streaming responses and one-way real-time updates are required without introducing WebSocket complexity. |
| **3\. WebSockets through API Gateway WebSocket API** *(Selected)* | • Provides true push updates with near-real-time dashboard changes. • Uses a managed public edge while application services remain private. • Preserves the ADR-001 security posture. • API Gateway manages persistent connections and exposes an API for sending messages to connected clients. • Application containers do not need to terminate or maintain sockets directly. | • Introduces bidirectional technology for a mostly one-way requirement. • Requires a connection registry that records which users and jobs each connection watches. • Requires additional push plumbing from task-status changes to API Gateway. • Adds a second gateway deployment to configure and monitor. • Clients must handle reconnecting and retrieving any updates missed while disconnected. | Best when near-real-time updates are a product requirement and the system must preserve a private service tier behind a managed AWS edge. |

# **Decision:** WebSockets

#  All three options are technically viable at the expected system scale. The decision is therefore based on architectural consistency and product experience rather than capacity.

# API Gateway WebSocket API provides near-real-time status updates while keeping all application services private. Both HTTP and WebSocket client traffic enter through AWS-managed edge services, preserving the security posture established in ADR-001.

# 

**Refined By:** Rayane Ventura

# **ADR-008: Queue ar






































































chitecture for job processing**

# **ADR-008**: Queue architecture for job processing (Topology)

# **Context:**

One job generates up to 2,000 tasks, and the job needs to be acknowledged in under 500 ms. Although creating the jobs and tasks in postgreSQL is completed in a single bulk transaction that completes within tens of milliseconds , publishing one SQS message per task is significantly slower, taking several seconds. So The API persists the Jobs and Tasks, publishes a single Job to the queue and returns immediately . A separate fan out component asynchronous expands the job into individual tasks for delivery

# **Decision Matrix:** How do persisted Tasks go to the Task queue? Does the API enqueue them before sending the HTTP response back to the client. Or does a job level fans out on a shared or separate queue?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Separate Job Queue and Task Queue** *(Selected)* | • Submission performs constant work regardless of batch size: one database transaction, one job message, then return. • Supports the **500 ms p99** submission target even when a job creates 2,000 tasks .• SQS retries the job message if fan-out fails partway through, preventing tasks from being silently stranded. • Each queue can have its own visibility timeout, retry limit, DLQ, and redrive policy. • Fan-out and delivery backlogs can be monitored and scaled independently. | • Requires an additional queue and DLQ to provision and monitor. • A brief period exists where task records are present in PostgreSQL but their messages have not yet reached the Task Queue .• The fan-out consumer must be idempotent because a job message may be delivered more than once. | Best for systems where a single submission creates many independent tasks, the API must respond quickly, and job expansion and task delivery require separate retry, scaling, and monitoring policies. |
| **2\. One Shared Queue for Job and Task Messages** | • Only one queue and DLQ need to be provisioned. • Retains the same retry protection for job fan-out as the two-queue design. | • One visibility timeout, retry limit, DLQ, and redrive policy must support two different workloads. • Job fan-out messages may wait behind thousands of delivery messages during traffic spikes. • Queue depth becomes difficult to interpret because it combines jobs waiting for expansion with tasks waiting for delivery. • Consumers must inspect each message and branch according to its type.• Provides no meaningful cost saving because SQS charges primarily per request rather than per queue. | Best only for very small systems where both message types have nearly identical processing characteristics and operational simplicity matters more than workload isolation. |
| **3\. API Enqueues All Task Messages Inline** | • Simplest message flow because no separate fan-out consumer is required. • Task records and task messages are created within the same submission flow, eliminating the temporary gap before messages are published. | • Violates the **500 ms p99** response target because publishing 2,000 task messages requires approximately 200 SQS batch requests. • Keeps the user request open while all task messages are sent. • A crash during publication can leave the remaining tasks in `pending` state without queue messages. • No independent retry mechanism exists to recover the unenqueued remainder. • Submission latency grows with the number of tasks. | Best only for small batches where the number of task messages is tightly limited and synchronous publication comfortably fits within the response-time target. |

# **Decision:** Separate Job Queue and Task Queue.

# On job submission, the API writes the job and all associated task records in a single database transaction, publishes a single job message to the Job Queue, and immediately returns the acknowledgement. A Fan out consumer processes the job message, retrieves the task IDs from the database, and publishes one message per task to the Task Queue using batched SQS sends.

# Using a dedicated Job Queue makes the fan-out stage independently retryable. If the fan-out consumer fails while publishing task messages, SQS redelivers the job message and fan-out resumes, ensuring that no work is silently lost before delivery begins.

# Task records are created as part of the submission transaction rather than by the fan-out consumer. As a result, the job dashboard can display the complete list of tasks in the Pending state immediately after the submission acknowledgement is returned. The fan-out component is therefore responsible only for enqueuing already-persisted work, making it a naturally idempotent operation.

**Refined By:** Rayane Ventura

# 

# **ADR-009: Database architecture across services**

# **ADR-009**: Database architecture across services (Topology)

# **Context:**

DocPost consists of three services with clear data ownership. The Auth service (users, credentials), The Document Platform service (teams, memberships, binders, folders, documents) and the DocPost API with async workers (JObs, Tasks, File Metadata). A stated requirement is that each service owns its data. Scale is modest 2,000 users 90,000 Tasks a day fits within a single database instance. The pending decision is how to physically and logically organize the company data?

# **Decision Matrix:** Do the three services share a single database schema, same instance with logically isolated databases or each runs their own database instances ?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. One Database Instance, One Shared Schema** | • Lowest infrastructure cost. • Simplest to provision, operate, and back up .• Cross-service queries are straightforward because all tables are in the same schema. | • Services become tightly coupled through a shared schema. • No database-level ownership boundaries; any service can read or modify any table. • Schema changes require coordination across multiple services. • Later decomposing into independently owned databases requires untangling cross-service joins and dependencies. | Best suited to a modular monolith where services are deployed together and independent ownership is not required. |
| **2\. One Database Instance, Separate Logical Databases per Service** *(Selected)* | • Enforces data ownership by granting each service access only to its own logical database. • Prevents cross-service joins, encouraging communication through service APIs. • Requires only a single PostgreSQL instance, reducing operational cost. • Each logical database can later be migrated to its own instance with minimal application changes. | • Cross-service data access requires API calls, introducing additional latency and failure modes. • All logical databases still share the same PostgreSQL instance, making CPU, memory, storage, and maintenance a shared resource. • A poorly performing workload in one logical database can affect the others. | Best suited to small or medium-scale microservice architectures that want strong ownership boundaries without the operational cost of multiple database instances. |
| **3\. Separate Database Instance per Service** | • Strongest isolation between services. • Independent scaling, backups, upgrades, maintenance windows, and failure domains. • Eliminates infrastructure-level resource contention between services. | • Highest infrastructure and operational cost. • More monitoring, patching, backups, and disaster recovery to manage. • Unnecessary complexity for workloads that comfortably fit within a single PostgreSQL instance. • Provides little immediate benefit over Option 2 at the expected scale. | Best suited to large-scale microservice systems where services have significantly different scaling characteristics, availability requirements, or compliance constraints. |

# **Decision:** One PostgreSQL instance with three isolated logical databases (Authentication, Platform, and DocPost), each accessible only through its owning service's credentials.

* # This approach enforces data ownership by preventing direct cross-service database access and eliminating cross-service joins. It also aligns infrastructure cost with the expected workload, avoiding the operational overhead of running a separate PostgreSQL instance for each service at the current scale.

* # The trade-off is accepted explicitly: when DocPost needs to authorize access to a destination, it calls the Platform service's API rather than querying its membership tables directly. This preserves service boundaries and ensures each service remains the sole owner of its data.

  # 

**Refined By:** Rayane Ventura

# 

# 

# **ADR-010: Database engine per service**

# **ADR-010**: Database engine per service

# **Context:**

With one instance and 3 separate logical databases, each one could use its own engine. Auth stores users and credentials (strongly relational), Document Platform stores a nested hierarchy , membership and documents record and DocPost stores Jobs, Tasks and file Metadatas with a burst-insert pattern (1 job \+ up to 2,000 rows) and dashboard queries all tasks per job

# **Decision Matrix:** Which database engine does each service use ?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. PostgreSQL for all three services** *(Selected)* | • All current workloads fit naturally within a relational model. • Authentication data is strongly relational. • The Platform hierarchy can be represented using a parent reference and queried with recursive CTEs. • Expanding a folder requires only an indexed query for its immediate children. • Job submission can atomically insert one job and up to 2,000 task records in a single transaction. • Job status can be calculated using a **`GROUP BY`** over indexed task status columns. • Only one database engine must be operated, monitored, tuned, backed up, and understood. • Provides strong transactional guarantees for atomic submission and consistent status reporting. • Fits the selected topology of one PostgreSQL instance with three isolated logical databases. | • At a substantially higher scale, a row-per-task model could create significant write volume and storage growth. • Recursive hierarchy queries require deliberate indexing and query design to remain efficient as hierarchy depth and size increase. | Best when relational consistency, transactional submission, straightforward aggregation, and low operational complexity matter more than extreme horizontal write scaling. |
| **2\. DynamoDB for jobs and tasks; PostgreSQL for Authentication and Platform** | • Provides very high write throughput for task creation and status updates. • On-demand pricing can accommodate irregular bursts without pre-provisioning capacity. • Scales horizontally without database sharding or instance resizing. | • Atomic submission becomes more difficult because one job plus 2,000 tasks exceeds DynamoDB transaction limits. • The system could no longer treat acceptance of the job and creation of every task as one atomic database fact without additional coordination. • Status aggregation must be implemented using counters, streams, or additional summary records rather than a straightforward relational aggregation. • Counter updates and event processing introduce distributed consistency and recovery concerns. • The expected workload of approximately 90,000 tasks per day averages close to one task per second, so DynamoDB's scaling advantages greatly exceed the demonstrated requirement. • Introduces a second persistence model and additional operational knowledge. | Best for systems with sustained or unpredictable write volumes that exceed relational database capacity and where eventual consistency and custom aggregation logic are acceptable. |
| **3\. DocumentDB or MongoDB for the Platform hierarchy; PostgreSQL elsewhere** | • Hierarchical structures can appear intuitive when represented as nested documents. • A complete subtree may be retrieved as a single document when the entire hierarchy is embedded. | • The actual access pattern is primarily expanding one hierarchy level at a time, which is handled efficiently by a relational adjacency-list model. • Moving subtrees becomes more complex when descendants are embedded or materialized inside documents. • Per-node permissions and memberships are easier to model as normalized relational entities. • Membership and hierarchy changes may require updates across multiple documents, weakening transactional simplicity. • Introduces a second database engine without a demonstrated performance or modelling benefit. • Requires separate monitoring, backup, tuning, patching, and operational expertise. | Best when aggregates are naturally stored and retrieved as self-contained documents, hierarchy updates are infrequent, and document-shaped access patterns dominate. |

# **Decision:** PostgreSQL for all three services.

# Every identified workload falls comfortably within PostgreSQL’s expected capabilities. The alternatives each require sacrificing a property the system currently needs:

* # DynamoDB weakens atomic job submission and makes status aggregation more complex.

* # A document database complicates subtree moves, permissions, and cross-entity consistency.

* # Using multiple database engines would add operational overhead without a measured benefit.

# File contents are explicitly outside the scope of the database. Uploaded files are stored in the encrypted S3 staging store, while PostgreSQL stores only their metadata, storage references, sizes, content types, and integrity checksums.

# 

# 

**Refined By:** Rayane Ventura

# 

# 

# **ADR-011: Workers compute model**

# **ADR-011**: Workers compute model

# **Context:**

Workers consume SQS messages: fan-out (one job, multiple tasks) and delivery (fetch staged file, verify checksum, deliver to platform, update status, push web socket update. Up to 90,000 tasks a day , burstly 2,000 tasks spike file sizes up to 1 GB.

# **Decision Matrix:** What compute runs the queue consumers ?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. AWS Lambda with SQS event source mappings** *(Selected)* | • Scales down to zero between bursts, avoiding idle compute cost for a workload of roughly 90,000 tasks per day. • Scales concurrency automatically as messages accumulate, without a separately configured worker autoscaling policy. • SQS retry, visibility timeout, partial batch failure, and DLQ behaviour integrate directly with Lambda. • Fan-out and delivery run as separate functions, allowing independent memory, timeout, concurrency, and retry configuration. • Removes the need to operate long-running worker infrastructure. | • Each invocation has a 15-minute execution limit, so the largest 1 GB delivery must complete within that window. • Large numbers of concurrent invocations can exhaust PostgreSQL connections, making RDS Proxy or another connection-management strategy necessary. • No long-lived process exists for durable in-memory batching, connection reuse, or local caches across invocations. • Cold starts add some latency when processing resumes after an idle period. | Best for bursty, event-driven workloads where tasks are independent, execution completes within 15 minutes, automatic scaling is valuable, and minimizing idle infrastructure cost is a priority. |
| **2\. ECS Fargate worker service long-polling SQS** | • No hard execution-time limit for individual tasks. • Long-running workers can maintain persistent PostgreSQL connection pools without requiring RDS Proxy. • Uses the same container packaging and deployment model as the API services. • Resident processes can batch, coalesce, cache, and reuse resources in memory. • Worker concurrency can be controlled more predictably. | • Incurs cost while workers are running, including during idle periods unless scaled fully to zero. • Queue-depth-based autoscaling must be configured, tested, and tuned. • Scaling reacts more slowly than Lambda concurrency scaling. • Requires more operational management than an SQS-triggered Lambda integration. | Best for long-running, CPU-heavy, connection-intensive, or continuously active workloads where persistent processes and predictable resource control justify the additional operational overhead. |
| **3\. EC2 Auto Scaling Group of SQS consumers** | • Lowest compute cost per hour when instances remain heavily utilized. • Full control over the operating system, runtime, networking, storage, and worker process. • Suitable for custom runtimes or workloads requiring specialised instance types. | • Slowest scale-out because new virtual machines must launch and initialise. • Requires operating-system patching, capacity planning, AMI maintenance, monitoring, and instance lifecycle management. • Scaling policies must be configured and tuned manually. • Economically attractive primarily under sustained high utilisation, which does not match the expected workload. | Best for sustained, high-volume processing where workers remain consistently busy and infrastructure control or specialised compute requirements outweigh operational complexity. |

# **Decision:** AWS Lambda with SQS event source mappings

* # Implemented as two independent functions: a Fan-out function consuming the (Job Queue) and a Delivery function consuming the (Task Queue). Small WebSocket lifecycle handlers (`$connect`, `$disconnect`, and `$default`/`subscribe`) will also be implemented as Lambda functions.

* # The workload consists of large numbers of short lived, independent messages, making it well suited to Lambda's event-driven execution model. Automatic scaling, pay-per-use pricing, and native integration with SQS retries and DLQ provide the simplest operational model while meeting the expected workload characteristics.

* 

#  d

**Refined By:** Rayane Ventura

# 

# 

# 

# **ADR-012: Infrastructure as code tooling**

# **ADR-012**: Infrastructure as code tooling

# **Context:**

All AWS resources for DocPost (VPC, RDS, ECS services, SQS, S3, KMS, API Gateway, Lambdas) must be managed as a code 

# **Decision Matrix:** Which tool defines and manages AWS infrastructure 

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Terraform using HCL** *(Selected)* | • Widely adopted across the infrastructure industry. • Declarative HCL maps closely to the underlying AWS resources, making infrastructure relationships explicit. • State is visible and inspectable, with built-in planning and drift detection. • Produces readable execution plans before changes are applied. • Skills transfer across AWS, Azure, Google Cloud, and other providers. • Encourages learning the actual infrastructure components rather than relying primarily on higher-level abstractions. | • Introduces HCL as a second language alongside TypeScript. • General-purpose programming constructs are limited, so complex conditional logic and abstraction can become awkward. • Requires a remote state backend and locking configuration for team use. • The state backend must normally be bootstrapped separately before the main infrastructure can be deployed. | Best when explicit infrastructure definitions, readable change plans, drift detection, and transferable multi-cloud skills are more important than using the application’s programming language. |
| **2\. AWS CDK using TypeScript** | • Uses the same language as the application stack. • Provides TypeScript types, functions, loops, reusable abstractions, and IDE support. • Higher-level constructs reduce boilerplate and can configure related resources together. • Integrates naturally with AWS services and development tooling. • Makes it easier to create reusable internal infrastructure components. | • Higher-level constructs can hide which AWS resources and permissions are generated. • Developers must inspect synthesized CloudFormation templates to understand the final infrastructure. • Deployment behaviour, limits, and rollback semantics are inherited from CloudFormation.•  Generated diffs can be less direct than Terraform plans. • Knowledge is primarily transferable within AWS rather than across cloud providers. | Best for AWS-only teams that prefer TypeScript, value reusable programming abstractions, and are comfortable with CloudFormation as the underlying deployment engine. |
| **3\. Raw AWS CloudFormation using YAML** | • Native AWS infrastructure-as-code format. • Requires no separate state backend because AWS manages stack state. • Supports AWS services directly without waiting for an external provider implementation. • Integrates with AWS deployment, permission, and change-set tooling. | • YAML templates become verbose and repetitive as the architecture grows. • Limited abstraction and reuse compared with Terraform modules or CDK constructs. • Slow feedback and deployment cycles for large stacks. • Failed stack updates and rollback states can be difficult to diagnose and recover from. • Change sets are often harder to read than Terraform execution plans .• AWS-specific and less transferable to other cloud platforms. | Best for small AWS-native environments, organisations standardised on CloudFormation, or teams that want AWS-managed state and minimal additional tooling. |

# **Decision:** Terraform using HCL 

# The deciding factors are the project’s learning objective and Terraform’s professional value. Terraform’s `plan` and `apply` workflow makes infrastructure changes explicit and reviewable: every proposed creation, update, or deletion can be inspected before it is applied.

# 

# 

# 

# 

# 

# **ADR-013: Worker authentication**

# **ADR-013**: Worker authentication to the platform 

# **Context:**

Delivery workers call the document platform POST /documents to ingest files . Every platform endpoints must reject unauthenticated requests. DocPost forwards users JWT, but workers run asynchronously , the users 15 minutes token must have been expired and storing user tokens in queue messages would leak bearer credentials in logs, SQS. Therefore, workers need their own identity, while the platform still needs to certify the initial user has permission to access the destination 

# **Decision Matrix:** How do delivery workers authenticate at the platform ?

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **1\. Service token issued by the Authentication service** *(Selected)* | • Uses one authentication model across the system: both users and services present JWTs validated against the same JWKS. • Reuses the Platform service’s existing JWT validation middleware. • Clearly separates the two identities involved: the service token proves that the caller is the Delivery worker, while `onBehalfOf` identifies the user whose authorization must be evaluated. • Supports short-lived credentials, scopes, expiry, issuer validation, and auditable service identities. • The Platform service remains responsible for rechecking the user’s current team membership and destination access at ingest time. • Works consistently in AWS and local Docker Compose environments. | • The Authentication service becomes a runtime dependency when the worker needs a new token. • Authentication outages can temporarily delay deliveries, although SQS retries and the DLQ provide recovery. • The worker requires a long-lived client credential stored in Secrets Manager and rotated periodically. • Requires implementation of a service-token endpoint, client authentication, scopes, and token caching across warm Lambda invocations. • The platform must ensure that `onBehalfOf` is trusted only when supplied by an appropriately scoped service identity. | Best when the system already uses JWT authentication and needs scoped, short-lived service identities that work consistently across cloud and local environments. |
| **2\. IAM-signed requests using AWS Signature Version 4** | • Uses the Lambda execution role as the worker’s identity. • No application secret needs to be stored or manually rotated. • Credentials are short-lived and managed automatically by AWS. • Integrates naturally with AWS IAM policies and audit tooling. | • Introduces a second authentication mechanism: JWT for users and SigV4 for internal services. • Requires separate validation, testing, authorization, and operational paths. • Verifying SigV4 directly inside the Platform service adds nontrivial custom security code. • Alternatively, it may require routing internal traffic through an AWS service that performs IAM authorization, changing the architecture. • Couples service authentication to AWS and complicates local development. • The represented user still requires an application-level `onBehalfOf` mechanism. | Best for AWS-native systems whose internal APIs are already fronted by services that support IAM authorization and where portability outside AWS is not required. |
| **3\. Mutual TLS between the worker and Platform service** | • Provides strong mutual authentication at the transport layer. • Both parties validate each other before application traffic is accepted. • Does not depend on bearer tokens or an authentication-service token endpoint. • Can be independent of the application’s authentication implementation. | • Requires certificate issuance, secure distribution, renewal, revocation, and rotation .• Adds significant load-balancer, trust-store, and deployment configuration for one internal communication path. • A certificate primarily proves possession of a private key; application scopes and fine-grained permissions require additional logic. • Does not solve user delegation, so `onBehalfOf` must still be represented and validated separately. • More operational complexity than the current risk and scale justify. | Best for environments with an established internal PKI, strict transport-level identity requirements, or many internal services already using mTLS. |
| **4\. Static shared API key stored in Secrets Manager** | • Simple to implement and test. • Requires no token issuance endpoint or certificate infrastructure. • Works in both AWS and local environments. | • Creates a long-lived bearer credential with no inherent expiry, audience, subject, or scopes. • Anyone obtaining the key receives the same ingest authority until it is manually rotated. • Rotation can disrupt clients unless multiple keys are supported during transition. • Provides weak attribution because all calls appear under the same shared identity. • Requires custom validation and audit conventions. • Conflicts with the system’s broader short-lived, identity-based authentication model. | Appropriate only for low-risk prototypes or temporary integrations where stronger identity mechanisms are not yet available. |

# **Decision:** Service token issued by the Authentication service.

# The Delivery worker authenticates with the Authentication service using its own client credential and receives a short-lived, scoped service JWT. It then sends that JWT to the Platform service together with the `onBehalfOf` user identifier.

# This preserves a single verification path in the Platform service: every caller, whether a user or an internal service, presents a JWT validated against the same JWKS. The service token provides the worker with a scoped, short-lived, and auditable identity while keeping service authentication separate from user authorization:

* # The service token answers **“Who is calling?”**

* # The `onBehalfOf` user and current membership check answer **“Is this delivery allowed?”**

# The Platform service does not treat `onBehalfOf` as authorization by itself. It accepts the value only from a trusted service token with the required scope and then revalidates the user’s access to the destination at delivery time. This preserves the required time-of-use authorization check.

The Authentication service becoming a runtime dependency is accepted. Delivery already has a transient-failure path through SQS retries and the DLQ, and Authentication is expected to be the smallest, most stable, and least frequently deployed service in the system.

# 

# 

# 

# 

# 

# 

# **ADR-014: Database access layer**

# **ADR-014**: Database access layer

# **Context:**

All three services and lambda workers read and write to their own PostgreSQL logical database, the stack is Node/Typescript. Several queries are not simple CRUD and require SQL semantics  that include:

* A single atomic transaction that inserts one job and up to 2,000 task rows while remaining within the 500 ms p99 submission target.  
* A conflict aware insert that enforces document ingest idempotency.  
* An aggregate query that calculates task counts by status for a page of jobs.  
* Two partial unique indexes on the `tasks` table, where a conventional unique constraint cannot express the required rule.

# **Decision Matrix:** What library the services use to build SQL queries ?

| Option | Advantages | Disadvantages | Recommended Use Case |
| ----- | ----- | ----- | ----- |
| **1\. Prisma** | • Generates strong TypeScript types from a central schema definition. • Has a large ecosystem, broad adoption, extensive documentation, and many integrations. • Includes schema management and migration tooling. • Provides a productive API for conventional CRUD operations and relationships. | • Complex PostgreSQL operations may require `$queryRaw`, including atomic conditional updates with `RETURNING`. • Raw queries lose much of Prisma’s generated type safety unless result types are maintained manually. • Several correctness-critical DocPost queries would bypass Prisma’s main abstraction. • Prisma manages its own connection pooling, which introduces an additional pooling layer in front of RDS Proxy and requires careful configuration in Lambda environments .• The abstraction is heavier than the system’s SQL-oriented access patterns require. | Best for applications dominated by conventional CRUD, relationships, and straightforward transactions, where developer productivity and ecosystem maturity matter more than direct access to advanced PostgreSQL semantics. |
| **2\. Drizzle ORM with Drizzle Kit** *(Selected)* | • Defines the schema directly in TypeScript and type-checks queries against it. • Keeps generated SQL close to handwritten SQL, making behaviour easy to inspect and reason about. • Supports typed multi-row inserts, **`UPDATE ... RETURNING`, and `ON CONFLICT ... RETURNING`** operations without dropping to an untyped escape hatch. • Supports PostgreSQL-specific schema features, including partial unique indexes. • Drizzle Kit provides migration generation and schema tooling alongside the query layer. • Uses the standard PostgreSQL driver rather than imposing its own connection pool. • Works cleanly with RDS Proxy in Lambda and standard `pg` connection pools in long-running services. | • Smaller ecosystem and fewer third-party integrations than Prisma. • Newer library with a shorter production track record. • Developers must understand SQL more directly because the abstraction intentionally exposes database behaviour rather than hiding it. | Best for TypeScript systems that rely on PostgreSQL-specific queries, atomic SQL operations, custom indexes, bulk writes, and direct control over generated SQL while still requiring compile-time type safety. |
| **3\. Knex.js with separate migration tooling** | • Provides a thin abstraction over SQL with predictable query generation. • Supports complex and PostgreSQL-specific queries without imposing an entity model. • Has a long production history and a stable API.• Makes it easy to fall back to handwritten SQL when necessary. | • The query builder is not compile-time linked to the database schema. • Column renames and type changes may not be detected until runtime. • Query definitions and migration definitions must be kept synchronized manually. • Requires combining and operating separate tools for query construction, schema typing, and migrations. • Provides less end-to-end TypeScript safety than Drizzle. | Best for teams that prioritize minimal abstraction and SQL control, and are willing to accept weaker compile-time schema guarantees or maintain their own generated database types. |
| **4\. TypeORM** | • Uses familiar entity classes and decorators. • Supports repositories, relationships, migrations, and multiple database engines. • Familiar to developers coming from Hibernate, Entity Framework, or similar object-oriented ORM ecosystems. | • Complex conditional updates, conflict-aware inserts, and optimized batch operations often require raw SQL or lower-level query-builder paths. • Correctness-critical queries may fall outside the primary entity abstraction. • Decorator-based entities can obscure the actual SQL and database access patterns. • Generated migrations can require careful manual review to ensure they accurately represent the intended schema changes.• The object-oriented data model provides limited benefit for this SQL-centric workload. | Best for entity-oriented applications where object mapping, decorators, and cross-database portability are more important than close control over PostgreSQL-specific SQL. |

# **Decision:** Dizzle ORM

* The system's core database operations rely heavily on PostgreSQL specific features such as conditional updates, conflict-aware inserts, batch inserts, transactions, and aggregations. It supports these as typed, first class operations without requiring raw SQL, preserving compile time type safety.  
* Using the standard PostgreSQL (`pg`) driver also allows Drizzle to integrate cleanly with the RDS Proxy architecture [(ADR-011)]() without introducing an additional connection pool.  
* Finally, Drizzle Kit provides a single toolchain for schema definitions, queries, and migrations. Each service maintains its own schema and migrations, aligning with the database ownership model defined in [ADR-009]().

**Refined By:** Rayane Ventura

# 

# 

# 

# 

# 

# 

# **ADR-015: Monorepo Setup**

# **ADR-015**: Monorepo build orchestration 

# **Context:**

* All microservices and SPA are handled in a single monorepo containing 9 packages React SPA, 3 Node.js services, 4 Lambda functions (fan-out, delivery, watchdog, WS lifecycle). And one shared package

**What orchestrate build, tests and task ordering across all the repositories**

| Options Considered |  |  |  |
| ----- | ----- | ----- | ----- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **npm workspaces only, explicit root scripts** | Zero extra tooling; order visible as literal script text; cheap to defer/retrofit later | No caching; no affected-package filtering; manual dependency ordering; manual Docker build context per service | Small repos where CI is already fast and the team wants to defer tooling decisions until growth actually demands them |
| **Turborepo on top of npm workspaces *(Selected)*** | Content-hash caching; declared task graph enforces build order; `turbo prune --docker` solves per-service build context | Second config/execution model to learn; caching gain is marginal at 7 packages/2-min pipeline; remote caching needs extra infra | Repos expecting to grow past a handful of packages, or where Docker build context per service is already a pain point worth solving now |
| **Nx** | Strongest dependency graph & affected-target analysis; generators/executors standardize new packages | Executor model abstracts the real build command away; built for much larger repos | Large, multi-team monorepos with many packages and a need for standardized scaffolding and affected-based CI |
| **Separate repo per service** | Full build/deploy isolation; Docker build context problem disappears | Shared package needs versioning/publishing; cross-service changes span multiple PRs/repos | Services with genuinely independent release cadences and few cross-cutting changes between them |

## 

# **Decision:** Turborepo

> * Option 2: npm workspaces with explicit root scripts, would solve the immediate need, but I want to explore turborepo.

>   
>   
>   
>   
>   
**Refined By:** Rayane Ventura  
> 

# **ADR-016: Fanout mechanism between Job and Task**

# **ADR-016**: Fanout mechanism between job submission and task delivery 

# **Context:**

* Fanout is triggered per file by an upload event. The worker loads the tasks related to that file and sends one message per destination. Capped at 20 per batch

**What is the mechanism to get the fanout tasks into the message queue ?**

> > 

| Options Considered |  |  |  |
| :---- | :---- | :---- | :---- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| Fan-out worker batch-sends directly to the task queue (SQS only) *(Selected)* | Fewest moving parts (1 producer, 1 queue, 1 consumer); `SendMessageBatch` returns per-message success/failure, so partial failures are visible and retried; nothing sits between producer and queue that can silently drop or reorder a message | Adding a second consumer later requires inserting a topic and repointing the producer; no message filtering layer if task classes diverge | Systems with exactly one consumer of task messages today, where simplicity and reliable batch delivery matter more than future flexibility |
| SNS topic between fan-out and task queue (SNS to SQS subscription) | Adding a second consumer later is just a new subscription, no producer change; filter policies could route task classes without producer logic; standard, well-understood AWS pattern | Only one consumer exists today, so indirection only buys future optionality; adds a hop that can fail independently; publish is per-message, not batched, so the fan-out worker loses its current batch success/failure signal | Systems that already know they'll need multiple consumers of the same fan-out event soon, and can tolerate losing per-batch delivery feedback |
| EventBridge bus with a rule routing job events to task queue | Content-based routing and schema registry if task events later feed other systems; native integration targets let a consumer be added with no code | Same objection as the SNS option, with more configuration surface; higher per-event cost and added latency for purely internal plumbing | Systems where task events need to feed multiple external systems with content-based routing, not just internal queue delivery |
| SNS as the fan-out primitive itself, replacing the fan-out worker | Would remove a Lambda function, if it worked | Doesn't actually work: SNS replicates one message to many subscribers, it doesn't split one message into many distinct payloads | Not applicable, this option doesn't solve the fan-out problem as stated |

> > 

# **Decision:** Fan-out worker batch-sends directly to the task queue (SQS only)

# Fanout batch publishes the messages directly to SQS queue. As there is only one subscriber, no need to for the extra overhead.

**Refined By:** Rayane Ventura

# **ADR-017: Job and Tasks creation post upload**

# **ADR-017**: Jobs and tasks creation order relative to upload

# **Context:**

* File uploads are directly handled through presigned URLs, so the platform needs a way to be notified that upload is complete and trigger tasks related to the file. Also if there is any failure during file upload, that needs to be registered and surfaced to users as part of initial requirements 

**Are jobs and tasks created after all files have been uploaded  ?**

| Options Considered |  |  |  |
| ----- | ----- | ----- | ----- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **Create at send, before upload** *(Selected)* | User's intent is durable from the moment expressed, the start of the riskiest step rather than the end; dashboard is live during upload so a stalled transfer is visible; partial upload failure needs no special mechanism, it just fails using the same surface as a delivery error; server never has to ask the client if upload finished | A task can exist before its bytes do, so readiness needs a storage signal (ADR-021); a job can end with tasks that failed for reasons unrelated to delivery; submission work is O(files) instead of constant | Systems that want durable intent and live progress visibility from the first moment, and are willing to add a storage-side completion signal to handle it correctly |
| **Create after upload completes** | Every task that exists is immediately runnable; "job created" and "job accepted" mean the same thing, so no extra aggregate status is needed | Upload progress is owned entirely by the browser with no server-side record, so a closed tab or crash loses the assembled work; server still needs the same storage signal anyway just to validate; adds a second endpoint and round trip for no user-visible gain | Systems where losing an in-progress upload on tab close is acceptable and simplicity of task state matters more than mid-upload visibility |
| **Create after upload, trusting a client-reported "upload complete" call** | Simplest to build; no storage-side signal needed at all | Reintroduces exactly the client trust ADR-002 exists to avoid; a buggy or hostile client produces thousands of tasks pointing at objects that don't exist; failure is discovered at the worst time, after fan-out has already spent the work | Not recommended here |

# **Decision:** Create at send, before upload

**What `POST /jobs` does:**

* Checks that the requested destinations belong to the user's team  
* In one database transaction, creates the files, job, and task records  
* Returns the job ID, how many tasks were created, and one upload link (presigned URL) per file

**Key design points:**

* **A file and its tasks aren't ready until the file actually exists.** Files start as "pending" and flip to "uploaded" only once storage confirms the bytes really arrived (see ADR-021). Tasks stay "pending" too, and only get queued for delivery once their file is confirmed uploaded. So "pending" always just means "created, nobody's worked on it yet."  
* Generating the upload links is just local cryptographic HMAC signing, no network calls, and it's capped at 100 files. Inserting up to 2,000 tasks is still one single database transaction. So the 500ms p99 target still holds.  
*  If a file doesn't show up by its deadline, its tasks fail with a clear `FILE_NOT_UPLOADED` error naming the file and destination. Files that did arrive on time have their tasks proceed normally, so one missing file doesn't sink the whole job.  
* The presigned URL's expiry [(from ADR-004)](https://doctoolchain.org/Bausteinsicht/arc42/ADRs/ADR-004-Sequence-Diagram-Export.html) controls how long that upload link/credential is valid to use. The staging deadline is different: it controls how long the job is willing to wait for the file's bytes before giving up on it.  
* If I ever need to build a batch across multiple sessions (attach a file today, actually send the job next week), files would need to be able to exist without being tied to a job yet, meaning `files.job_id` would need to become optional (nullable) instead of required.

**Refined By:** Rayane Ventura

# **ADR-018: Broswer session persistence**

# **ADR-018**: Browser session persistence 

# **Context:**

* SPA is hosted in ClaudFront and the gateway in another domain, so HTTP-Onçy cookie policy is not compliant and buying a domain for this is out of scope for v1.

**How to persist session when user refreshes the page ?**

Switching to **httpOnly** cookies would require me to purchase a domain.  My SPA is on a CloudFront domain and the API is on a separate `execute-api.amazonaws.com` domain. **That's a cross-site relationship from the browser's perspective,** and cookies don't cross site boundaries the way you'd want by default. Here's what you'd need to work through.

**1\. Custom domain for the API** 

To make the cookie a genuine first-party cookie, the API needs to live on a subdomain of the same registrable domain as your SPA, e.g. `app.yourdomain.com` for the frontend and `api.yourdomain.com` for the API. That means:

* An ACM certificate for the API custom domain  
* An API Gateway custom domain mapping to your HTTP API  
* DNS (Route 53 or wherever) pointing `api.yourdomain.com` to that mapping  
* Possibly routing both through the same CloudFront distribution with path-based behaviors (`/api/*` → API Gateway origin) so everything is under one domain, which sidesteps some of the cross-domain issues entirely

**Decision:** store the 15-minute access token in `sessionStorage`, issue no refresh token.

* Moving to httpOnly cookies is the architecturally correct long-term answer, but it requires a custom domain (to make the API first-party relative to the SPA), plus new CORS credential handling and CSRF protection. That's a meaningfully larger lift than what M3 calls for, and the underlying blocker (no custom domain in v1) hasn't changed.  
* A non-httpOnly cookie was considered and rejected: it inherits all the cookie-related complexity (SameSite, domain scoping, CORS) without gaining any XSS protection over

**Refined By:** Rayane Ventura

# **ADR-019: Deployment Artifact Identity**

# **ADR-019**: Deployment artifact identity

# **Context:**

* CI builds each service's image and pushes it under two tags, `:${git-sha}` and `:latest`, then triggers a redeploy via `ecs update-service --force-new-deployment` against a task definition that's pinned to the mutable `:latest` tag. Because `:latest` is overwritten on every build, the running ECS revision can't be traced back to the commit that produced it, and rolling back means either hoping the registry still resolves `:latest` to the desired prior image or manually editing the task definition. Compounding this, Terraform also manages the ECS service's `task_definition` field, so it and CI both act as competing sources of truth for the same attribute, and a later `terraform apply` can undo or conflict with whatever CI last deployed.

**How is the running ECS task bound to a git commit ?** 

| Options Considered |  |  |  |
| ----- | ----- | ----- | ----- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **Force-new-deployment on a mutable tag (Status Quo)** | One AWS API call; Terraform keeps a single task definition ARN in state | Two deploys minutes apart are indistinguishable in ECS; rollback is not a revision number; concurrent pushes race on the same tag | Not recommended: this is the setup causing the traceability, rollback, and ownership problems |
| **`terraform apply` per service deploy with `image_tag` set to the SHA** | Terraform remains the only writer of the task definition; the SHA is visible in state and in the plan | A service-only change waits on a full env plan/apply, including unrelated drift; apply holds the state lock for the duration of ECS stability waits; couples application rollout to infrastructure rollout | Teams where deploy frequency is low and keeping infrastructure and application rollout as a single, tightly coupled operation is acceptable |
| **CI registers a new task definition revision with the SHA-pinned image** *(Selected)* | `describe-services` shows which image digest/tag is running; rollback is `update-service --task-definition`; Terraform stops fighting CI via `lifecycle { ignore_changes }`; circuit breaker with rollback catches a bad revision | Terraform's registered revision is the bootstrap shape only; a human `terraform apply` will not revert an image | Teams that deploy frequently and need fast, traceable, independently rollback-able application deploys without coupling to infrastructure changes |
| **Full GitOps with a dedicated deploy repo** | Desired revision is a reviewed commit in a second repo; promotion between envs is a merge | A second repository and reconciliation loop for only three services; higher complexity overhead for current scale | Larger service counts or organizations already running GitOps tooling, where the reconciliation overhead is justified by scale |

# **Decision:** Create at send, before upload

CI describes the current task definition, substitutes the image reference with the GitHub SHA, registers a new task definition revision, and updates the ECS service to that revision  
Terraform relaxes its ownership of `task_definition` via `lifecycle { ignore_changes = [task_definition] }`, so it no longer fights CI over that field  
Terraform enables the ECS deployment circuit breaker with automatic rollback, so a bad revision is caught and reverted without manual intervention  
Manual rollback, when needed, is `aws ecs update-service --task-definition <previous-arn>` followed by a stability-wait command to confirm completion

**Refined By:** Rayane Ventura

# **ADR-020:  Where schema and bootstrap steps run**

# **ADR-20**:  Where schema and bootstrap steps run

# **Context:**

* `terraform apply` currently runs two `local-exec` provisioners that make it depend on bash, the AWS CLI, and network reachability: `terraform_data.bootstrap`, which runs an ECS task to create databases and roles, and `terraform_data.wait_oidc`, a 120-iteration curl loop plus an ECS stability wait so API Gateway can fetch OIDC discovery before creating the JWT authorizer. Neither is declarative or idempotent under Terraform's model, so repeated or interrupted applies can't be reasoned about the way normal Terraform resources can. Separately, Drizzle migrations run inside every ECS task at boot, which races when `desired_count = 2`, since multiple tasks can attempt migrations against the same database at the same time.

**Which lifecycle steps belong inside \`terraform apply\`, and which belong in the deploy pipeline?**

| Options Considered |  |  |  |
| ----- | ----- | ----- | ----- |
| **Option** | **Advantages** | **Disadvantages** | **Recommended Use Case** |
| **Provisioners (status quo**) | One command appears to produce a working environment; no extra scripts to remember | Apply is not declarative, success depends on curl, CLI, and task exit codes Terraform cannot plan; a provisioner that already ran won't re-run even if the database was destroyed under it; the OIDC wait is a disguised sleep loop that fails opaquely after 120 tries | Not recommended: this is the setup causing the non-idempotent, undebuggable apply behavior |
| **Lambda-backed custom resources** | Apply still "does everything" without a laptop bash dependency; Terraform/CloudFormation can wait on a resource that reports status | A Lambda shelling out to `ecs run-task` and polling is the same provisioner, just relocated; failure modes (task timeout, image missing) still aren't visible in the Terraform graph; another runtime and IAM role to maintain | Teams that need `apply` to remain fully self-contained and are willing to trade shell scripts for an equally imperative Lambda plus its own operational overhead |
| **Init containers / migrate-on-boot in every tas**k | No extra pipeline step; new tasks always see a migrated schema | Two tasks booting together can both see an unmigrated schema and race to migrate simultaneously; seed-on-boot repeats on every scale-out and every deploy | Not recommended when `desired_count > 1`: this makes the existing migration race worse, not better |
| **Explicit pipeline steps** *(Selected)* | Terraform only defines resources; bootstrap and migrate become a deploy step with a visible exit code; `wait_for_steady_state = true` already covers what the curl loop was waiting for; one-off ECS tasks match the existing bootstrap pattern; ordering lives in `aws-up.sh` and the infra workflow | `terraform apply` alone no longer produces a working environment; runbook order matters and must be documented | Teams that want a fully declarative Terraform apply and are willing to own an explicit, documented deploy sequence outside it |

# **Decision:** Explicit pipeline steps 

Terraform's job is  to just define resources (cluster, task definitions, services), not executing imperative setup logic.  
`wait_oidc` is replaced by `wait_for_steady_state = true` on `aws_ecs_service`, combined with a `depends_on` from the JWT authorizer module to the auth service. So instead of a curl loop polling for readiness, Terraform's own dependency graph and ECS's native stability check ensure the authorizer is only created once auth is actually healthy.  
Bootstrap and migration stay defined in Terraform as task definitions, but they're now *invoked* as one-off ECS tasks from the deploy pipeline (`scripts/db-bootstrap.sh`, `scripts/db-migrate.sh`), each waiting on exit 0, rather than being triggered from inside `apply` itself.

**Refined By:** Rayane Ventura

# **ADR-021:  Detecting file successfully uploaded**

# **ADR-21**:  Detecting file successfully uploaded

# **Context:**

* **Context:** `tasks.status` and `tasks.failure_reason` are overwritten in place, so a task that fails once and later succeeds reads as simply "completed" with no trace of the earlier failure. That's sufficient for the live dashboard (ADR-007), but insufficient for reconstructing what actually happened during a run. Four separate components write to task status (API, delivery worker, watchdog, DLQ consumer), and history that could drift from the row itself is worse than having no history at all, so any history write must commit atomically with the status write it's recording. Volume constraints rule out unbounded retention: 90,000 tasks/day at up to 2,000 tasks per job, running against a 20 GB `db.t4g.micro` with no autoscaling. Submit's current performance is also a hard constraint, it measures 427ms p99 against a 500ms budget, leaving no room to add a per-task history insert to that path.

**Where do we persist the sequence of task and job state transitions, how is that sequence kept consistent with tasks / jobs, and what is the retention rule given the 20 GB allocation?**  
 

| Option | Advantages | Disadvantages | Recommended Use Case |
| ----- | ----- | ----- | ----- |
| **Dedicated append-only status\_events table** *(Selected)* | Same commit as the row it describes, a crash cannot produce a status without a history row; multiple transitions per task (fail, retry, succeed) are natural rows; one job-scoped query serves the history view; writers stay on the SQL they already run | Extra writes on every transition; a second table to index and operate | Systems that need a reliable, queryable audit trail of every status transition and can absorb the cost of an additional table and writes |
| **History columns or JSONB array on tasks** | No extra table; same-row atomicity | A 2,000-task job history becomes 2,000 JSON blobs, a job-wide timeline requires a scan and merge; row bloat on hot tuples; job-level events like `completed_at` have no home | Smaller-scale systems where avoiding a new table matters more than efficient job-wide history queries |
| **Derive history from CloudWatch Logs** | No schema change; logs already exist for operations | Cannot join the log write to the status UPDATE, so the two systems can and will diverge; the SPA can't load-on-demand from CloudWatch under ADR-007 without a new privileged API; retention, indexing and access control are operations tools, not a product audit trail | Not recommended as a product-facing history source: fine for operational debugging, not for a trustworthy audit trail |

# **Decision:** Dedicated append-only status\_events table

**Refined By:** Rayane Ventura

# **Technical Design**

# **Technical Design for PAS-001: DocPost**

 **Blueprint:** [DocPost Blueprint]()

 **ADRs:** [DocPost ADRs (ADR-001 through ADR-014)]() 

**Owner:** Rayane Ventura

## **Rules for implementation**

* **Infrastructure as Code:** All resources are created by Terraform [(ADR-012)](). Console is used for reading, not writing.  
* **CI/CD:** Every service gets a GitHub Actions workflow when it's created.  
* **Local first:** Every part runs locally via Docker Compose (LocalStack for S3/SQS/KMS).  
* **Secrets:** Nothing sensitive in code. Secrets Manager \+ env variables.  
* **Decisions:** When a part hits a decision with real competing options, stop and write an ADR using the template before implementing. Decisions with one obvious answer get a one-line note in this doc, not an ADR.

## **Build philosophy**

Milestones follow the Blueprint's four user flows. Each of them ends with something a user can test in the browser.

**Within a milestone:** when a flow touches a service, build that service close to its full project scope.

## **Repository and Environment Structure**

**docpost/** (repo root \- **MONOREPO**)

* **services/**  
  * **auth/** : includes `services/auth/migrations/`  
  * **platform/** : includes `services/platform/migrations/`  
  * **docpost-api/** : includes `services/docpost-api/migrations/`  
* **workers/**  
  * **fanout/**  
  * **delivery/**  
  * **watchdog/**  
  * **ws/**  
* **web/**  
* **packages/shared/** : JWT validation middleware, error shapes, shared types  
* **infra/**  
  * **modules/** :  reusable Terraform: network, rds, ec \-service, sqs, s3, api gateway, lambda  
  * **envs/**  
    * **dev/** : thin config calling modules with dev variables  
    * **prod/** : thin config calling modules with prod variables  
* **bootstrap/**:  one time state backend creation [(ADR-012)]()  
* **docker-compose.yml**  
* **.github/workflows/**

**Two explicit rules:**

1. `infra/envs/*` never duplicates resource blocks, only calls `infra/modules/*` with different variables.  
2. Each service owns its own `migrations/` folder inside its directory, **consistent with each service owning its logical database** [(ADR-009)](). No central migrations folder.

## **Database Design**

Three isolated logical databases, one PostgreSQL instance, per service credentials ([ADR-009](), [ADR-010]()). No cross database foreign keys. Cross service references are plain UUIDs validated through service APIs. Access built with Drizzle ORM [(ADR-014)](), using the standard `pg` driver through RDS Proxy.

**Auth Database**

- **users** (  
-   id            uuid PRIMARY KEY DEFAULT gen\_random\_uuid(),  
-   email         text UNIQUE NOT NULL,  
-   password\_hash text NOT NULL,  
-   name          text NOT NULL,  
-   created\_at    timestampt NOT NULL DEFAULT now()  
- );

- **service\_clients** (  
-   id                 uuid PRIMARY KEY,  
-   client\_id          text UNIQUE NOT NULL,  \-- e.g. 'delivery-worker'  
-   client\_secret\_hash text NOT NULL,  
-   scopes             text\[\] NOT NULL,       \-- \['documents:ingest'\]  
-   created\_at         timestampt NOT NULL  
- );

**Note on DocPost access control:** `users` is authentication only ,  it proves who someone is, nothing more. Whether a user can use DocPost at all is not a user level flag. It's derived from two facts, both in the platform database: `team_members` (is this user on this team) and `teams.docpost_enabled` (does this team have DocPost turned on). A user's DocPost access is the intersection of those two, matching the Blueprint's stated model: team membership is the entire authorization model for v1, no per user overrides.

**Document Platform Database**

- **teams** (  
-   id              uuid PRIMARY KEY,  
-   name            text NOT NULL,  
-   region          text NOT NULL,      \--only used in v2  
-   docpost\_enabled boolean NOT NULL DEFAULT true,  
-   created\_at      timestampt NOT NULL  
- );

- **team\_members** (  
-   team\_id  uuid REFERENCES teams(id),  
-   user\_id  uuid NOT NULL,             \-- auth user id, no cross-db foreign key  
-   added\_at timestampt NOT NULL DEFAULT now(),  
-   PRIMARY KEY (team\_id, user\_id)  
- );

**CREATE INDEX idx\_team\_members\_user ON team\_members(user\_id);**

- **binders** (  
-   id         uuid PRIMARY KEY,  
-   team\_id    uuid NOT NULL REFERENCES teams(id),  
-   name       text NOT NULL,  
-   created\_at timestampt NOT NULL  
- );

**CREATE INDEX idx\_binders\_team ON binders(team\_id);**

- **folders** (  
-   id               uuid PRIMARY KEY,  
-   binder\_id        uuid NOT NULL REFERENCES binders(id),  
-   parent\_folder\_id uuid REFERENCES folders(id),  \-- NULL \= binder root  
-   name             text NOT NULL,  
-   created\_at       timestampt NOT NULL DEFAULT now()  
- );

**CREATE INDEX idx\_folders\_parent ON folders(binder\_id, parent\_folder\_id);**

- **documents** (  
-   id                  uuid PRIMARY KEY,  
-   binder\_id           uuid NOT NULL REFERENCES binders(id),  
-   folder\_id           uuid REFERENCES folders(id),  
-   name                text NOT NULL,  
-   size\_bytes          bigint NOT NULL,  
-   content\_type        text NOT NULL,  
-   checksum\_sha256     text NOT NULL,  
-   source\_task\_id      uuid UNIQUE,          \-- idempotency key for ingest  
-   uploaded\_by\_user\_id uuid NOT NULL,        \-- the onBehalfOf user  
-   created\_at          timestamptz NOT NULL  
- );

`source_task_id UNIQUE` ensures the ingest idempotency guarantee: the same task delivered twice inserts once (`ON CONFLICT DO NOTHING`, return the existing document).

Hierarchy access pattern is expand-one-level (indexed adjacency list), matching [ADR-010's]() decision to avoid recursive CTEs on the hot path.

**DocPost Database**

- **files** (  
-   id                  uuid PRIMARY KEY,  
-   owner\_user\_id       uuid NOT NULL,  
-   job\_id              uuid NOT NULL REFERENCES jobs(id),  
-   original\_name       text NOT NULL,  
-   size\_bytes          bigint NOT NULL,  
-   content\_type        text NOT NULL,  
-   checksum\_sha256     text NOT NULL,       \-- client-declared, verified by S3 \+ worker \+ platform  
-   s3\_key              text NOT NULL,       \-- staging/{owner\_user\_id}/{file\_id}  
-   status              text NOT NULL DEFAULT 'pending'  
-                       CHECK (status IN ('pending','uploaded','expired')),  
-   verification\_error  text,                \-- why the arrived bytes were rejected; NULL when clean  
-   uploaded\_at         timestampt,  
-   staging\_deadline\_at timestampt NOT NULL,  
-   created\_at          timestampt NOT NULL  
- );

**CREATE INDEX idx\_files\_pending ON files(staging\_deadline\_at) WHERE status \= 'pending';**

- **jobs** (  
-   id                   uuid PRIMARY KEY,  
-   submitted\_by\_user\_id uuid NOT NULL,  
-   task\_count           int NOT NULL,  
-   next\_check\_at        timestamptz,        \-- watchdog re-arm guard  
-   completed\_at         timestamptz,        \-- set when last task resolves; drives 30-day retention  
-   created\_at           timestamptz NOT NULL  
- );


**CREATE INDEX idx\_jobs\_user ON jobs(submitted\_by\_user\_id, created\_at DESC);**

- **tasks** (  
-   id                   uuid PRIMARY KEY,  
-   job\_id               uuid NOT NULL REFERENCES jobs(id),  
-   file\_id              uuid NOT NULL REFERENCES files(id),  
-   team\_id              uuid NOT NULL,  
-   binder\_id            uuid NOT NULL,  
-   folder\_id            uuid,              \-- NULL \= binder root  
-   region               text NOT NULL,  
-   status               text NOT NULL DEFAULT 'pending'  
-                        CHECK (status IN ('pending','in\_progress','completed','failed')),  
-   attempt\_count        int NOT NULL DEFAULT 0,  
-   failure\_reason       text,  
-   platform\_document\_id uuid,  
-   created\_at           timestampt NOT NULL,  
-   updated\_at           timestampt NOT NULL  
- );

**CREATE UNIQUE INDEX uq\_tasks\_dest ON tasks(file\_id, team\_id, binder\_id, folder\_id) WHERE folder\_id IS NOT NULL;**

**CREATE UNIQUE INDEX uq\_tasks\_dest\_root ON tasks(file\_id, team\_id, binder\_id) WHERE folder\_id IS NULL;**

**CREATE INDEX idx\_tasks\_job\_status ON tasks(job\_id, status);**

- **ws\_connections** (  
-   connection\_id text PRIMARY KEY,     \-- API Gateway connection id  
-   user\_id       uuid NOT NULL,  
-   job\_id        uuid,                 \-- currently subscribed job  
-   connected\_at  timestampt NOT NULL  
- );

**CREATE INDEX idx\_ws\_job ON ws\_connections(job\_id);**

Tasks are created **`pending`** at submission and enqueued only once their file reaches **`uploaded`**, so **`pending`** keeps its meaning of "created, no worker has touched it."

**`files.verification_error`** records why arrived bytes were rejected (`SIZE_MISMATCH: declared 2097152, actual 2097600`, `CHECKSUM_MISMATCH`). Fan out writes it in the same statement that leaves the row **`pending`**, and acks: a mismatch is permanent, not something to retry. A successful promotion clears it to NULL. It lives on **`files`** rather than on **`tasks`** because the failure is a property of the file, not of any one delivery, one bad upload bound for 20 destinations is one verification error, not twenty. When the watchdog fails that file's tasks at the deadline, it copies the text into each **`tasks.failure_reason`** alongside the file name and destination, so the user sees it on the same surface as every other task failure.

API Gateway's WebSocket API manages the raw connection only (accept, keep-alive, connection ID, **`PostToConnection`**). It has no built-in pub/sub and does not track which user is subscribed to which job. Without **`ws_connections`**, the only alternatives are broadcasting every update to every open connection (doesn't scale, leaks job data across teams) or building this exact state tracking some other way. Keep this table.

Partial indexes were chosen over a sentinel "binder root" UUID because a magic UUID leaks into application code, platform API calls, and every join against folders, while the index pair is invisible to the app. (If we pin PostgreSQL ≥15, `UNIQUE NULLS NOT DISTINCT` collapses both into one constraint; the partial index version works on any version, so it's the default.)

Job status is derived on read ([ADR-010's]() aggregation approach). Aggregate mapping: any **`failed`** and nothing **`pending`/`in_progress` → `completed_with_errors`**; all **`completed` → `completed`**; otherwise **`in_progress`** (or `pending` if nothing started).

Implementation note for **`GET /jobs`**: the paginated job list computes counts in one aggregate query across the whole page, never a per-job query in a loop:

**SELECT j.id, j.created\_at, j.task\_count,**

       **count(\*) FILTER (WHERE t.status \= 'pending')     AS pending,**

       **count(\*) FILTER (WHERE t.status \= 'in\_progress') AS in\_progress,**

       **count(\*) FILTER (WHERE t.status \= 'completed')   AS completed,**

       **count(\*) FILTER (WHERE t.status \= 'failed')      AS failed**

**FROM jobs j LEFT JOIN tasks t ON t.job\_id \= j.id**

**WHERE j.id \= ANY($pageOfJobIds)**

**GROUP BY j.id;**

**Audit note (Flow 3):** the Blueprint asks that users can see the audit of past jobs and tasks. No separate audit log table is needed for v1 ,  **`jobs`** and **`tasks`** rows are never deleted, only the underlying S3 object ages out after the 30 day staging window, so **`GET /jobs`** and **`GET /jobs/:id/tasks`** already serve as the full history surface. Worth flagging: this means job/task metadata (not file bytes) persists indefinitely by default in v1; if that needs a retention policy of its own later, that's a v2 decision, not something this design currently enforces.

**Multipart resume scope note:** resuming a multipart upload across sessions (close the tab, come back days later) is out of v1 scope. Within session resume works by holding the upload ID client side. If cross session resume is ever needed, the v2 upgrade path is a **`multipart_upload_id`** column on **`files`**.

## **API Design and Contracts**

All JSON. All routes require a JWT **except**

 `POST /auth/register`,  `POST /auth/login`,  `POST /auth/token`,  `GET /.well-known/jwks.json`, and `GET /.well-known/openid-configuration` [(ADR-001)](). 

**Global Error Shape:** `{ "error": { "code": "string", "message": "string" } }`.

### **Auth service**

| Method \+ path | Request | Response |
| ----- | ----- | ----- |
| `POST /auth/register` | `{email, password, name}` | `201 {id, email, name}` |
| `POST /auth/login` | `{email, password}` | `200 {accessToken, expiresIn: 900}` (15-min user JWT) |
| `POST /auth/token` | `{clientId, clientSecret, scope}` | `200 {accessToken, expiresIn: 900}` (service JWT, [ADR-013]()) |
| `GET /.well-known/jwks.json` | – | `200` JWKS (public keys, both services validate against this) |

User JWT claims: `sub` (user id), `email`, `exp`, `iat`. Service JWT claims: `sub` (client id), `scope`, `token_use: 'service'`.

**Refresh tokens:** deferred to v2, documented here so the path is known. v1 ships the single 15-minute access token; on expiry the SPA sends the user back to login. The v2 upgrade is one **`refresh_tokens`** table (`token_hash`, `user_id`, `expires_at`, `revoked` boolean), one `POST /auth/refresh` endpoint, and a client-side interceptor that catches a 401, refreshes once, and retries. When the refresh cookie lands, the access token moves back to memory rather than to `localStorage`, since the cookie re-mints it on boot. This is purely additive: the JWT authorizer at the edge and every service's auth middleware validate access tokens only and are untouched, so deferring costs no rework. Roughly 1 day when built. Token rotation and reuse detection are excluded from both v1 and this v2 note.

### **Document platform**

**User token routes (JWT forwarded by DocPost API or gateway):**

| Method \+ path | Response |
| ----- | ----- |
| `GET /teams?docPostEnabled=true` | Teams the token subject belongs to: `[{id, name, region}]` |
| `GET /teams/:teamId/binders` | `403` if not a member. `[{id, name}]` |
| `GET /binders/:binderId/contents` | One level: `{folders: [...], documents: [...]}` (`contents` because the response mixes two types; children implied one) |
| `GET /folders/:folderId/contents` | One level inside a folder: `{folders: [...], documents: [...]}` |

**Service token routes** (scope checked):

| Method \+ path | Request | Response |
| ----- | ----- | ----- |
| `GET /teams/:teamId/members/:userId` | – | `200 {addedAt, region}` if member, `404` if not. The status code carries the answer; no `{isMember}` body flag. `region` is the team's region, returned here because `tasks.region` is `NOT NULL` and this is the one call submission already makes per distinct team. (scope `memberships:read`) |
| `POST /documents` | multipart: metadata part `{taskId, binderId, folderId?, name, contentType, checksumSha256, onBehalfOf}` \+ file bytes | `201 {documentId}` / `200` if `taskId` already ingested / `403` if `onBehalfOf` user not a member at time of use / `422 CHECKSUM_MISMATCH` (scope `documents:ingest`, [ADR-013]()) |

Platform recomputes SHA-256 of received bytes and rejects on mismatch. End of the integrity chain: client declares → S3 verifies on write → worker verifies before send → platform verifies on receipt.

### **DocPost API**

| Method \+ path | Request | Response |
| ----- | ----- | ----- |
| `GET /destinations/teams` | – | Proxied from platform, filtered to DocPost-enabled |
| `GET /destinations/teams/:id/binders` | – | Proxied, authorized |
| `GET /destinations/binders/:id/contents` | – | Proxied, one level (lazy tree) |
| `GET /destinations/folders/:id/contents` | – | Proxied, one level (lazy tree) |
| `POST /jobs` | `{files: [{name, sizeBytes, contentType, sha256}] max 100, mappings: [{fileIndex, destinations: [{teamId, binderId, folderId?}]}]}` | `201 {jobId, taskCount, uploads: [{fileId, presignedPostFieldsOrMultipartPlan}]}` in \<500 ms. Note: `fileIndex`, not `fileId` — the client has no IDs yet, since this call mints them. `uploads` comes back in the same order as `files`. |
| `GET /jobs?page=&limit=` | – | `[{jobId, createdAt, taskCount, counts, aggregateStatus}]` (single aggregate query, see data model note) |
| `GET /jobs/:id` | – | Job \+ counts |
| `GET /jobs/:id/tasks?status=&page=&limit=100` | – | Paginated tasks with `failureReason` (2,000 tasks never in one response) |
| `POST /files/:fileId/multipart` | `{uploadId?, partNumbers?}` (body optional) | `{uploadId, parts: [{partNumber, url}], completeUrl, abortUrl}`. Body absent → `CreateMultipartUpload`, return everything. Body present → no initiation, re-sign only the listed parts against that `uploadId` plus a fresh `completeUrl`/`abortUrl`. Submitter-only, same as the job reads. |
| `POST /files/:fileId/download-url` | – | `{url, expiresIn: 120}` — stays `POST` deliberately: non-idempotent, mints a short-lived credential (ADR-002/004) |

Folder identity lives in the path; **`contents`** is the name because the response mixes folders and documents.

**Upload URL issuance rules ([ADR-002]()/[004]()):** presigned POST with content length range capped at declared size (hard ceiling 1 GB), exact `Content-Type` condition (allow-list: pdf, docx, xlsx, png, jpg), `x-amz-checksum-sha256` condition so S3 verifies on write. URLs expire in 15 minutes, all single request plans return in the one Send response.

Files over 100 MB get a multipart plan, but initiation is lazy. Send returns only `{fileId, multipart: true, partSize, partCount}`, because **`CreateMultipartUpload`** is a synchronous S3 round trip, not a signature, and up to 100 of them inside the submission path would break the 500 ms p99 that [ADR-008]() protects by asserting plan generation is "local HMAC signing with no network call." The client calls `POST /files/:fileId/multipart` when it actually starts that file, so initiations spread across the upload window.

Part URLs are re-signable. A 1 GB file at 16 MB parts mints 64 URLs at once, and S3 validates a signature at request start, which covers a part already in flight but not one that has yet to begin; at 5 Mbps that upload runs \~27 minutes, so the back half of the parts would expire unused. Re-calling the endpoint with `{uploadId, partNumbers}` re-signs just the remaining parts, plus a fresh `completeUrl` (which expires on the same clock). Re-signing never initiates, so no orphan upload is created, and it carries the same submitter-only check, single-object scope and 15-minute window, so it grants nothing the caller could not already obtain.

### **WebSocket API (API Gateway WebSocket, [ADR-007]())**

| Route | Behavior |
| ----- | ----- |
| `$connect` | JWT passed as query param (WS handshake can't set headers reliably); Lambda validates against JWKS, inserts `ws_connections` row. Reject → 401, no connection. |
| `subscribe` | `{action: 'subscribe', jobId}`; Lambda verifies the caller may view the job (same rule as `GET /jobs/:id`), sets `job_id` on the connection row |
| `$disconnect` | Delete the connection row |

Push message shape: **`{type: 'task_update', jobId, taskId, status, failureReason?, counts: {...}}`**. Counts ride along so the client updates the aggregate without refetching.

## 

## **Milestones** 

**Estimates assume AI assisted implementation**: AI writes most of the boilerplate, Terraform, and tests. 

| Milestone | Flow | Estimate | Demoable Unit |
| ----- | ----- | ----- | ----- |
| 1 | Foundations (no flow) | 7 days | Infra live, pipelines green, local env runs |
| 2 | Flow 1: Browse destinations | 10 days | Log in, browse the team/binder/folder tree in the browser |
| 3 | Flow 2: Distribute a batch | 10 days | Select files, watch uploads, map destinations, submit, get confirmation; documents land in the platform |
| 4 | Flow 3: Monitor a job | 7  days | Watch a job's tasks flip live on the dashboard, review job/task audit history |
| 5 | Flow 4: Download a staged file | 2 days | Download button returns the file |
| 6 | E2E verification | 2 days | Success metrics proven on the deployed system |
| **Total** |  | **38 days** |  |

### **Milestone 1: Foundations (7 days)**

**Step 0.1: Monorepo, local environment, shared package (1 day)** Repo layout as specified above. Shared TypeScript config, ESLint, `packages/shared` with the JWT validation middleware (one implementation, both services import it) and common error shapes. `docker-compose.yml`: 3 service containers, Postgres with an init script creating 3 logical databases \+ 3 roles, LocalStack (S3, SQS), workers runnable as local processes.

**Step 0.2: Terraform foundation (2.5 days)** `bootstrap/` script creates the state backend (S3 \+ DynamoDB lock), the single manual step ([ADR-012]()). `infra/modules/`: network (VPC, 2 AZs, private subnets for everything, NAT), rds (single Postgres instance, RDS Proxy, Secrets Manager secrets per logical DB role), ecr, s3 (staging bucket with SSE-KMS `aws/s3` \+ Bucket Keys per [ADR-003](), Block Public Access, TLS only policy, 30 day lifecycle expiry, 7 day multipart abort cleanup; plus SPA hosting bucket \+ CloudFront). `infra/envs/dev` and `infra/envs/prod` call the modules with per-environment variables. Bootstrap and migrate run as one-off ECS tasks from the pipeline, not from `terraform apply`; first boot is apply (count 0\) → bootstrap → migrate → apply (count 2, authorizer, steady state) → seed. Logical databases and per-service roles created by a migration bootstrap job, not by hand ([ADR-009]()).

**Step 0.3: CI/CD skeleton, GitHub Actions (1 day)** Per service workflow with path filters (`services/auth/**` only triggers auth): lint → test → docker build → push to ECR tagged with git SHA → deploy (task definition update). Worker workflow: esbuild bundle → update function code. Infra workflow: `terraform plan` as a PR comment, apply on merge, manual approval environment for prod. Rollback: `aws ecs update-service --task-definition <previous-arn>` followed by a stability wait.

### **Milestone 2: Flow 1, Browse destinations (10 days)**

**Demo at the end:** a member registers, logs in, and browses the team → binder → folder tree in the browser, filtered to their memberships, in under 500 ms per level (Blueprint's Flow 1 target).

**Step 1.1: Auth service, complete, deployed (2.5 days)** Full scope in one pass per the build philosophy: registration (bcrypt cost 12, generic duplicate email error), login (constant time compare), RS256 signing with keypair in Secrets Manager, JWKS endpoint with `kid`, and the service token endpoint (client credentials, scope validation, `token_use: 'service'`, ADR-013) even though nothing calls it until Milestone 3\. Seed the delivery-worker client via migration; secret in Secrets Manager. Deploy: ECS Fargate (2 tasks across AZs), internal ALB, health check, verified from inside the VPC ([ADR-001]()).

**Step 1.2: Platform hierarchy, membership route, deployed (1 day)** Schema, the three user-token read endpoints with membership enforcement in the query, `GET /teams/:teamId/members/:userId` for service callers, demo seed data (5 teams across regions, nested folders) for the ≤50-teams \<500 ms latency test. Deploy: second ECS service \+ ALB rule.

**Step 1.3: Platform ingest endpoint (1.5 days)** Built now, in Milestone 2, because it completes the platform's project scope; first exercised end to end by the delivery worker in Milestone 3\. Covered by integration tests until then. `POST /documents`: multipart stream, SHA-256 recomputed while streaming to the platform's own store, `onBehalfOf` membership checked at time of use (ADR-013), `ON CONFLICT (source_task_id) DO NOTHING` with the existing document returned on conflict, content-type allow-list (no executables).

**Step 1.4: Public edge (1.5 days)** API Gateway HTTP API, native JWT authorizer against the auth JWKS, VPC Link to the internal ALB, the gateway exposes auth's public routes, `.well-known/*`, and the authorized `/destinations/*` routes. The platform is internal-only, reached by the DocPost API and later the delivery worker over the internal ALB. Milestone 3 requires adding `POST /jobs` and `POST /files/:fileId/download-url` explicitly, since routes are enumerated per-route and GET-only today. CORS for the SPA origin, default throttling. Verify: unauthenticated request returns 401 at the gateway and never reaches the ALB. Minimal compression on this step: bounded by AWS propagation and debugging, not code.

**Step 1.5: DocPost API skeleton \+ browsing proxy, deployed (1 day)** Service, `docpost` logical DB, migrations. `/destinations/*` proxy the platform with the user's JWT forwarded (membership enforcement lives in the platform; DocPost API adds the DocPost-enabled filter). 5 s timeout, platform errors mapped to 502\.

**Step 1.6: Frontend chunk 1, browse destinations UI (1.5 days)** React \+ Vite SPA on the S3 \+ CloudFront hosting from Milestone 1\. Register/login screens, token in `sessionStorage`, so an in-tab refresh keeps the session. Lazy destination tree: teams → binders → one folder level per expand, matching the platform's one-level API so the \<500 ms target is per-level. Multi-select deferred to chunk 2 where mapping needs it.

### **Milestone 3: Flow 2, Distribute a batch (10 days)**

**Demo at the end:** a member selects up to 100 files, watches parallel uploads with progress, maps files to destinations, submits, and gets a confirmation with the task count. Deliveries land in the platform (verified via the platform API), including through kill-and-recover of the platform. The async pipeline steps below carry the lightest compression in the plan, deliberately.

**Step 2.1: Job submission transaction (2 days)** `POST /jobs`: validate destinations via `GET /teams/:teamId/members/:userId` (one call per distinct team, cached per request); write files, jobs and all task rows in one transaction; generate one presigned plan per file (local HMAC, no network call; multipart files get a `{multipart: true, partSize, partCount}` hint only; `CreateMultipartUpload` is lazy on `POST /files/:fileId/multipart`); publish one delayed watchdog message; return. Presigned POST conditions per the contract section; lazy multipart initiation for files over 100 MB. The watchdog message is published in the submission path, and a publish failure fails the submission, because a job without a watchdog has nothing guaranteeing it resolves.

**Step 2.2: Queues \+ fan-out worker (1.5 days)** Terraform: upload-events queue \+ DLQ, task queue \+ DLQ, job queue \+ DLQ, `maxReceiveCount` 3 (ADR-005). S3 bucket notification `ObjectCreated` → upload-events queue. Fan-out Lambda: on each event, load the `files` row by object key, compare actual size and checksum against the declared values, promote with `UPDATE ... WHERE status = 'pending'`, then `SendMessageBatch` that file's task messages (≤20). Body `{taskId}` only, no tokens in queues. A mismatch leaves the row `pending` and records the reason.

**Step 2.3: Delivery worker (2.5 days)** Built together with fan-out in this milestone; they're one pipeline, not two features. Claim: `UPDATE tasks SET status='in_progress', attempt_count=attempt_count+1 WHERE id=$1 AND status IN ('pending','in_progress') RETURNING *`; terminal status → ack and exit. HEAD the S3 object as a backstop; the file was verified uploaded before enqueue, so a miss means lifecycle deletion or a lost object → permanent `FILE_NOT_UPLOADED`. Service JWT via client credentials, cached across warm invocations, refreshed on expiry (ADR-013). Outcomes: 201/200 → completed \+ document id; 403 → permanent `NOT_AUTHORIZED_AT_DELIVERY` (membership revoked between submit and delivery, surfaced not retried); 422 → permanent `CHECKSUM_MISMATCH`; 5xx/timeout → throw, SQS retries via visibility timeout. Permanent failures ack; transient failures throw. `failure_reason` carries file name, destination, cause. On any terminal transition, set `jobs.completed_at` if no unresolved tasks remain (conditional UPDATE with `NOT EXISTS` subquery, race-safe). All DB access through RDS Proxy. Delivery reserved concurrency: 50 is the prod target (without a cap, a 2,000-task burst can exhaust the RDS Proxy pool); dev ships lower depending on account Lambda concurrency quota, tunable in Terraform.

**Step 2.4: Watchdog worker \+ DLQ consumers (1.5 days)** Watchdog Lambda on the job queue: HEAD files still pending (present → promote and enqueue; absent and past `staging_deadline_at` → fail that file's tasks `FILE_NOT_UPLOADED`), set `jobs.completed_at` if no unresolved tasks remain, then stop if terminal or re-arm with a fresh delay guarded by the conditional `next_check_at` update. DLQ consumer for all three DLQs: mark affected tasks `failed` with `RETRIES_EXHAUSTED` plus last error. This is the "+DLQ" clear-failure-reason requirement from the Blueprint's Flow 2\.

**Step 2.5: Frontend chunk 2, select, upload, map, submit (2 days)** File picker with 100 max and client-side allow-list, upload queue with bounded concurrency (4–6), per-file progress, multipart with within-session resume, mapping matrix with select-all shortcuts and a live task-count indicator. Uploads start after Send using the returned plans, with the dashboard already on screen.

### **Milestone 4: Flow 3, Monitor a job (7 days)**

**Demo at the end:** submit a job, watch the dashboard's task counts and rows flip live, see failure reasons inline, survive a page refresh mid-run, and review the audit list of past jobs and tasks.

**Step 3.1: Status endpoints (1 day)** Shared-team job authorization: a requester and submitter must share a team to access job details (verified via the membership route, cached 60 s). The base `GET /jobs` and task listing endpoints are shipped as part of the Milestone 3 project scope; this step adds the viewing rule for jobs submitted by other members. This is also where the audit requirement is satisfied: `GET /jobs` with pagination is the audit surface, since job/task rows are retained indefinitely (see Database Design note above).

**Step 3.2: WebSocket API \+ handlers (1.5 days)** API Gateway WebSocket API, `$connect`/`$disconnect`/`subscribe` Lambdas (`workers/ws`), `ws_connections` registry. RDS Proxy for all handler DB access.

**Step 3.3: Push plumbing \+ catch-up (1.5 days)** Delivery worker, after each status write: look up connections subscribed to the job, `PostToConnection`; 410 Gone deletes the stale row. Push failures are logged and swallowed, never fail a delivery. Client catch-up: on subscribe ack and every reconnect, refetch `GET /jobs/:id` once, then apply pushes. No server-side replay buffer needed.

**Step 3.4: Frontend chunk 3, dashboard \+ live status (2 days)** Job list with aggregate chips, job detail with virtualized 2,000-row task table, status filter, failure reasons inline, WS client with reconnect \+ refetch catch-up. Download button UI included here (per-file action on completed tasks); it's too small for its own chunk. It goes live when Milestone 5 ships the endpoint.

### **Milestone 5: Flow 4, Retrieve a file (2 days)**

**Demo at the end:** the download button from chunk 3 returns the file, and returns 404 for anyone outside the submitter's teams.

**Step 4.1: Team-scoped downloads (1 day)** `POST /files/:fileId/download-url`: resolve the file's job submitter, requester must share a team with them, 2-minute presigned GET scoped to the single object key (ADR-002/004). 404, not 403, outside scope, to avoid confirming existence. Bytes never touch application servers.

### **Milestone 6: End-to-end verification (2 days)**

Success-metric tests from the Blueprint, run against the deployed dev environment, gated before prod:

* Browse latency: destination hierarchy for a ≤50-team user renders under 500 ms per level (Flow 1).  
* p99 submission latency on a 100 × 20 job (2,000 tasks) holds \<500 ms (Flow 2).  
* Partial-failure isolation: one revoked-membership destination → 1 failed / 1,999 completed.  
* Kill the platform mid-run → retries drain the backlog on recovery, DLQ stays empty.  
* Never-uploaded file surfaces `FILE_NOT_UPLOADED`.  
* Security pass: unauthenticated 401s at the gateway, cross-team download 404s, expired presigned URLs fail, gitleaks clean.  
* Submit 3 files, upload only 2, confirm the third's tasks fail at the deadline while the rest complete.  
* Manual: throttled-connection upload UX, multipart within-session resume, WS reconnect.

**Total: 38 days.**

## 

## **Concurrency**

| Scenario | Handling |
| ----- | ----- |
| Same task message delivered twice (SQS at-least-once) | Conditional claim `UPDATE`; terminal statuses ack-and-exit. Platform `source_task_id` unique constraint is the backstop if both run anyway. Net effect: exactly-once outcome from at-least-once delivery. |
| Visibility timeout expires mid delivery on a slow 1 GB file, second worker picks it up | Both may deliver; platform dedupes on `source_task_id`; both write completed. Timeout sized at 6× function timeout to make this rare, not to prevent it. |
| Two tasks finish simultaneously, both try to close the job | `completed_at` set by one conditional `UPDATE` checking no unresolved tasks exist; row locking serializes it, both outcomes correct. |
| Fan out crashes mid batch | Upload-event message redelivered; the conditional promote is a no-op the second time and re-sent task messages are absorbed by per-task idempotency. |
| User submits while uploads still running | Submission always precedes upload. Tasks stay pending until storage confirms their file, so a task is never enqueued against bytes that do not exist. |
| Two browser tabs, same user | Stateless API, per-file rows, per-tab WS connection rows. Nothing shared to corrupt. |
| Membership revoked between browse and delivery | Time-of-use check at ingest (ADR-013): task fails `NOT_AUTHORIZED_AT_DELIVERY`, correctly. |
| Watchdog and fan out race on the same file | Both use `UPDATE ... WHERE status = 'pending'`; one wins, the other no-ops. |

## **Failure Modes**

| Dependency down | Effect | Recovery |
| ----- | ----- | ----- |
| Platform service | Deliveries throw, retried via visibility timeout, DLQ after 3; browsing and submission validation return 502 | Backlog drains when platform returns; DLQ consumer marks stragglers failed (visible, not silent) |
| Auth service | Logins fail; workers keep delivering on cached service tokens until expiry, then retry path applies | Smallest, most stable service ([ADR-013]()); ECS restarts unhealthy tasks |
| PostgreSQL | User-facing requests fail; SQS buffers messages (14 day retention) | Messages replay on recovery; idempotency makes replay safe |
| S3 / KMS | Uploads and deliveries fail transiently | Standard retry path; nothing acknowledged is lost |
| S3 event lost or delayed | Tasks sit pending; the watchdog HEADs at the deadline and promotes | Latency problem, not a correctness problem |
| User closes the tab mid-upload | Remaining files miss the deadline, their tasks fail **`FILE_NOT_UPLOADED`** with file name and destination | Already-uploaded files deliver normally |
| WebSocket push path | Dashboard stalls | Non-fatal by design; refetch on reconnect; deliveries unaffected |
| One Availability Zone | ECS runs 2 tasks across AZs behind the ALB; Lambda/SQS/S3 are multi-AZ managed | Meets 99.9% without extra machinery |

## **Security and Access**

* **Authentication:** JWT authorizer at the edge rejects unauthenticated traffic before the VPC (ADR-001); services re-validate (defense in depth; the platform must, since workers reach it without the gateway).  
* **Authorization:** platform checks membership on every read; DocPost API checks at submission; platform re-checks `onBehalfOf` at ingest time of use; downloads check requester-shares-team-with-submitter. Four checkpoints, no trust carried forward.  
* **Secrets:** DB credentials, JWT private key, worker client secret in Secrets Manager, injected at runtime. gitleaks in CI. Secrets referenced by ARN, never as Terraform values.  
* **Files:** SSE-KMS at rest (ADR-003), TLS everywhere, presigned URLs single-object \+ short expiry (ADR-004), content-type allow-list enforced in the POST policy and again at ingest, size ceiling in the POST policy.  
* **Sensitive data inventory:** password hashes (auth DB), clinical documents (staging \+ platform store), everything else metadata. No PHI in logs: task IDs and reasons only; file names appear only in failure reasons shown to authorized users.

## **Testing Strategy**

* **Unit:** token issuance/validation, presigned policy construction, task claim logic, aggregate status derivation, transient-vs-permanent failure classification. Every CI run.  
* **Integration (compose \+ LocalStack):** submit → fan-out → deliver locally, double-delivery of the same task message, DLQ path marks tasks failed; upload-event promotion; duplicate `ObjectCreated` promotes once; checksum mismatch leaves the row pending.  
* **E2E (deployed dev):** the Milestone 6 list, gated before any prod apply.

## **Launch Plan**

* **Migration:** none, greenfield. Each service's migrations run from its own folder as a deploy step (forward-only for v1).  
* **Rollout:** Milestone 1 → Milestone 6 as sequenced; each milestone verified in dev, then prod via the approval gate. Gateway routes added only after services verify internally (ADR-001).  
* **Feature flags:** none for v1, no existing users to protect. The approval gate is the control point.  
* **Rollback:** previous image SHA (application) or previous plan (infra). Non-backward-compatible migrations ship expand-then-contract across two deploys.  
* **Retention:** requirement says 30 days after job completion; the S3 lifecycle rule keys off object age, so the implemented guarantee is "≥30 days after completion" (uploads precede completion). Exact-to-completion deletion needs a per-object sweep off `jobs.completed_at`; deferred to v2 unless the compliance framing requires exactness. Worth confirming with the client.  
* **Monitoring:** v1 \= default CloudWatch per requirements, plus two cheap alarms that back success metrics directly: DLQ depth \> 0 on any DLQ, and delivery worker error rate. Everything else from default dashboards: gateway p99, ALB 5xx, RDS Proxy connections, age of oldest message.

**Open items to confirm against the Blueprint before ratifying**

1. **Naming:** this design assumes the public product name is "DocPost" throughout (services, DB, env vars).   
2. **`docPostEnabled` flag naming:** mirrors the Blueprint's "teams enabled for DocPost" language;   
3. **Job/task retention:** flagged above, v1 keeps job/task metadata indefinitely to satisfy the audit requirement, while only the S3 file bytes expire at 30 days. If that's not the intended compliance posture, this needs its own ADR before Milestone 1\.  
4. **Region source:** Flow 1's "list of available regions" is served from `teams.region`, not a separate region listing endpoint. If regions need to be browsable independently of team membership (e.g., before login), that's a new requirement not currently covered.

