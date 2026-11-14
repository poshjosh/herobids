# **OpenAIdom hosting research**

## **1. Executive finding**

The most promising direction is **self-managed container orchestration on rented Linux servers, with Hetzner Cloud as the initial infrastructure candidate and HashiCorp Nomad as the container scheduler**.

This is a preliminary recommendation, not yet the final verdict. The key distinction is that OpenAIdom needs to pay primarily for the compute capacity hosting its agents, rather than pay a separate premium for every managed container.

The published prices already illustrate why this matters:

| Platform         | Published monthly compute price per agent        |
| ---------------- | ------------------------------------------------ |
| Hetzner Cloud    | Shared host capacity; agents are packed together |
| Fly.io Machines  | $2.19 at 256 MB; $4.39 at 512 MB                 |
| Northflank Cloud | $2.70 at 256 MB; $5.40 at 512 MB                 |

At 10,000 agents, the indicative container-level charges alone would be:

- Fly.io: $21,900/month at 256 MB or $43,900/month at 512 MB.
- Northflank: $27,000/month at 256 MB or $54,000/month at 512 MB.

These are published compute rates, not complete bills: storage, networking, monitoring and other charges may be additional. Hetzner's economics are different because many agent containers can share one host. Its June 2026 German/Finland pricing lists shared-CPU CX servers from €5.49/month excluding VAT, although actual host requirements and operational overhead must be included.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://fly.io\&sz=32)

Fly Docs+3



The most important architectural conclusion is that **the 10-second requirement should be met by having spare capacity already running**, not by expecting a cloud provider to provision a new VM in under 10 seconds. Agent containers can then start on warm hosts while infrastructure autoscaling replenishes the capacity buffer.

## **2. Ranked shortlist**

The ranking below considers the actual OpenAIdom workload, not just how easily a platform can run a Docker image.

| Rank | Solution                  | Best reason to choose it                                              | Main drawback                                      |
| ---- | ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| 1    | **Hetzner Cloud + Nomad** | Lowest projected infrastructure cost and flexible container placement | Requires operating the infrastructure              |
| 2    | **AWS ECS on EC2**        | Managed orchestration with mature autoscaling and operational tooling | Considerably more expensive                        |
| 3    | **Fly.io Machines**       | Excellent per-agent machine abstraction and microVM isolation         | High cost at tens of thousands of agents           |
| 4    | **Northflank**            | Easiest managed platform to evaluate and operate                      | Per-agent pricing becomes expensive                |
| 5    | **Kubernetes on Hetzner** | Flexible ecosystem and broad orchestration capabilities               | More complexity than this workload initially needs |

### **1. Hetzner Cloud + HashiCorp Nomad**

Best overall economics

**Proposed setup:** CX53 cloud servers in a German or nearby European location, with Nomad managing Docker containers.

A CX53 provides 16 shared vCPUs, 32 GB RAM and 320 GB NVMe storage. Its published monthly price is €29.49 excluding VAT. It includes 20 TB of traffic per server.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs+2



Advantages:

- Very low cost per GB of host memory.
- Full control over container creation, placement, restart and deletion.
- Nomad supports Docker as a task driver and provides resource reservations and hard memory limits.
- Nomad can scale both application allocations and the underlying number of client nodes.
- A community-supported Hetzner Cloud target exists for the Nomad Autoscaler, so infrastructure scaling does not necessarily require writing a complete custom integration.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://developer.hashicorp.com\&sz=32)

  HashiCorp Developer+3



Disadvantages:

- You operate the Nomad servers, workers, monitoring, security and upgrades.
- Hetzner uses shared CPU on CX servers. A memory-efficient configuration does not guarantee that all agents will receive sufficient CPU during busy periods.
- New infrastructure is not instant. You need warm capacity.
- Hetzner’s default API and resource quotas need to be considered when scaling to hundreds or thousands of servers.
- Ordinary Docker containers share the host kernel. They are not equivalent to separate virtual machines.

**Startup:** A new container can plausibly become ready within 10 seconds on an already-running server, with the image cached and the application starting quickly. There is no published end-to-end guarantee for that target.

**Scalability:** I would use multiple independent Nomad clusters rather than one enormous cluster. For example, five clusters of approximately 10,000 agents each at the 50,000-agent stage. This is a proposed sharding strategy, not a demonstrated benchmark of 10,000 allocations per cluster.

### **2. AWS ECS on EC2**

Best managed alternative

This is the strongest alternative if minimising infrastructure operations is worth paying more.

Use ECS with EC2 capacity providers and Auto Scaling Groups. ECS handles task placement, service health and container restarts. EC2 supplies the hosts.

Advantages:

- Managed orchestration and a mature API.
- Capacity providers can scale the EC2 fleet based on cluster resource utilisation.
- Multiple clusters can be used to distribute the 50,000 agents.
- AWS has mature monitoring, networking, IAM, load balancing and security services.
- You can reserve spare capacity by configuring capacity-provider target utilisation below 100%.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://docs.aws.amazon.com\&sz=32)

  Amazon Elastic Container Service+1



Disadvantages:

- EC2 compute is significantly more expensive than the Hetzner model.
- You still need to operate task definitions, cluster configuration, networking, IAM, deployment pipelines and autoscaling policies.
- ECS quotas require careful design when managing tens of thousands of independent services or tasks.
- EC2 instances take much longer than 10 seconds to provision and join a cluster. Warm EC2 capacity is still necessary.

AWS documents limits including 5,000 services and 5,000 container instances per cluster. Its RunTask API also has request-rate and per-request task limits. A design with one ECS service per agent would therefore need cluster sharding; another approach is a smaller set of ECS services with a dedicated lifecycle controller managing tasks.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.aws.amazon.com\&sz=32)

AWS General Reference+2



**Important:** I would choose ECS on EC2 rather than Fargate for this workload. ECS on EC2 permits much smaller task memory limits and packs containers onto shared machines.

### **3. Fly.io Machines**

Best per-agent machine abstraction

Fly Machines are attractive because the basic unit is already close to what OpenAIdom wants: an independently managed machine with a programmatic lifecycle API.

Advantages:

- Create, start, stop and destroy individual machines through an API.
- Machine boot is very fast; Fly has reported approximately 300 ms for the VM boot process.
- Machines use Firecracker microVM technology, providing a stronger isolation boundary than ordinary shared-kernel Docker containers.
- Images can be cached, reducing the work required at startup.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://www.fly.io\&sz=32)

  The Fly Blog+1



Disadvantages:

- Every agent is a separately billed machine.
- This makes the economics unattractive at 10,000–50,000 continuously running agents.
- API throughput and machine-count limits need to be confirmed with Fly before a large deployment. Support discussions indicate default machine limits and API request-rate restrictions that would need to be raised or contractually addressed.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://community.fly.io\&sz=32)

  Fly.io+1



Current published machine rates include approximately $2.19 per 30 days for a 256 MB shared-CPU machine and $4.39 for a 512 MB machine.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://fly.io\&sz=32)

Fly



The 300 ms figure is VM boot time, **not** a guarantee that an agent, its browser and all required dependencies will be operational in 300 ms.

Fly is an excellent candidate for a small high-isolation deployment or a premium isolation tier. I would not choose it as the default infrastructure for every OpenAIdom agent at 50,000 agents unless Fly provides substantially different commercial pricing.

### **4. Northflank**

Best managed-platform simplicity

Northflank is worth evaluating because its pricing model supports small, continuously running workloads and it provides APIs and client libraries for programmatic management.

Published pay-as-you-go pricing includes:

- 256 MB with 0.1 shared vCPU: approximately $2.70/month.
- 512 MB with 0.2 shared vCPU: approximately $5.40/month.
- Storage and network transfer are additional.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://northflank.com\&sz=32)

  Northflank+1



Its advantages are ease of deployment, less infrastructure management and a managed platform experience.

Its principal disadvantage is the per-agent price. At 10,000 agents, the monthly compute-only cost reaches $27,000 or $54,000, depending on memory allocation.

I would ask Northflank for written confirmation of:

- Maximum concurrent workloads and services.
- API provisioning throughput.
- Whether 50,000 continuously running workloads are supported.
- Container readiness time under load.
- Isolation guarantees between customer workloads.
- Enterprise pricing at 10,000 and 50,000 workloads.

Without those confirmations, I would not select it as the foundation of the platform.

### **5. Kubernetes on Hetzner**

Kubernetes is technically capable of running this workload, and it offers a large ecosystem for monitoring, networking, deployment and workload management.

However, Kubernetes does not automatically make this cheaper or faster than Nomad. On Hetzner, you would still need to operate the control plane, worker nodes, network plugins, autoscaling and upgrades.

For an environment whose primary responsibility is scheduling independent agent containers, Nomad is the simpler starting point.

I would select Kubernetes instead if OpenAIdom expects to operate a much wider range of workloads, has an established Kubernetes skillset, or needs the broader Kubernetes ecosystem.

## **3. Solutions I would not choose as the primary platform**

### **AWS Fargate**

Fargate is convenient, but its minimum Linux x86 configuration is 0.25 vCPU and 512 MiB RAM. It cannot accommodate the preferred 256 MB allocation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.aws.amazon.com\&sz=32)

Amazon Elastic Container Service+1



At 512 MB, using the Frankfurt published compute rates, a continuously running 0.25-vCPU task costs approximately $10.36/month before networking, logs and other charges.

That is too expensive for the default OpenAIdom agent runtime.

### **Google Cloud Run**

Cloud Run is designed around request-serving services and managed instance lifecycles. It supports minimum instance settings, but instances can still be terminated, including idle instances. Worker pools are more relevant to continuous background workloads, but their scaling model requires additional infrastructure and does not give OpenAIdom the straightforward per-agent lifecycle that it needs.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.cloud.google.com\&sz=32)

docs.cloud.google.com+2



I would not use it as the primary scheduler for 50,000 independent, always-running agents.

### **Azure Container Apps**

Azure Container Apps supports minimum replicas and background workloads, but its scaling behaviour includes polling and cooldown periods. It also has a maximum of 1,000 replicas per revision.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://learn.microsoft.com\&sz=32)

Microsoft Learn+2



It is a credible managed container platform, but the per-agent model and provisioning requirement make it less attractive than the leading options.

### **Scaleway and OVHcloud**

Both are viable European infrastructure providers, but neither currently presents a sufficiently compelling advantage over Hetzner for this particular memory-heavy, cost-sensitive workload.

For example, Scaleway's DEV1-L configuration is approximately €31.27/month for 8 GB RAM, while Hetzner CX53 provides 32 GB RAM for €29.49/month. OVHcloud's comparable 32 GB B3-32 offer is considerably more expensive in the published pricing I reviewed.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.scaleway.com\&sz=32)

Scaleway+2



They remain useful alternatives to evaluate for regional diversification or if Hetzner capacity becomes difficult to obtain.

## **4. Comparative matrix**

| Requirement                       | Hetzner + Nomad               | AWS ECS EC2                            | Fly.io                              | Northflank                          | Kubernetes + Hetzner              |
| --------------------------------- | ----------------------------- | -------------------------------------- | ----------------------------------- | ----------------------------------- | --------------------------------- |
| 256 MB task                       | Yes                           | Yes, on EC2                            | Yes                                 | Yes                                 | Yes                               |
| 512 MB task                       | Yes                           | Yes                                    | Yes                                 | Yes                                 | Yes                               |
| One agent per container           | Yes                           | Yes                                    | One machine per agent               | Yes                                 | Yes                               |
| Always running                    | Yes                           | Yes                                    | Yes                                 | Yes                                 | Yes                               |
| Individual lifecycle API          | Nomad API                     | ECS API                                | Machines API                        | Platform API                        | Kubernetes API                    |
| Under 10 seconds on warm capacity | Plausible                     | Plausible                              | Plausible                           | Must verify                         | Plausible                         |
| New host under 10 seconds         | No guarantee                  | No guarantee                           | Not necessary for existing capacity | Not established                     | No guarantee                      |
| Host autoscaling                  | Additional autoscaler         | Managed capacity providers             | Provider-managed                    | Provider-managed, subject to limits | Additional autoscaler             |
| Isolation                         | Container; gVisor recommended | Container; additional isolation needed | Firecracker microVM                 | Confirm with provider               | Container; sandbox runtime needed |
| Operations                        | Medium–high                   | Medium                                 | Low                                 | Low                                 | High                              |
| Cost at scale                     | Excellent                     | High                                   | High                                | High                                | Excellent                         |
| 50,000-agent design               | Multiple Nomad clusters       | Multiple ECS clusters                  | Requires provider agreement         | Requires enterprise confirmation    | Multiple Kubernetes clusters      |

A crucial distinction in this comparison: **a platform supporting a 256 MB container does not mean that the complete agent process, including its browser, fits comfortably inside 256 MB.** That requires measurement using the actual OpenAIdom agent image.

## **5. Cost projections**

The most important cost distinction is between a provider charging for every individual agent and a provider charging for the shared compute capacity on which agents run.

The Hetzner calculation below is a capacity model, not a benchmark or a quotation. It is intended to show the likely economics before running a real workload test.

### **5.1 Hetzner + Nomad cost model**

**Host configuration:** CX53, 16 shared vCPUs, 32 GB RAM, 320 GB NVMe, €29.49/month excluding VAT.

I use these assumptions:

| Assumption                           | Value            | Reason                                                  |
| ------------------------------------ | ---------------- | ------------------------------------------------------- |
| Host RAM reserved for infrastructure | 25%              | OS, Docker, Nomad, monitoring, kernel and safety margin |
| RAM available for agent limits       | 75%              | 24 GB per 32 GB host                                    |
| Additional worker capacity           | 20%              | Spare capacity for new agents and host failures         |
| Minimum worker hosts                 | 3                | Avoid relying on a single worker                        |
| Agent state                          | External storage | Avoid one persistent disk per agent                     |
| CPU                                  | Shared           | Matches your stated requirement                         |

At 24 GB available for agent memory limits, the theoretical memory density is:

- **96 agents per host** at 256 MB each.
- **48 agents per host** at 512 MB each.

These numbers are based on memory limits, not on an assumption that every agent consumes exactly that amount of total host memory. Container runtime overhead, per-container processes and actual application memory must be measured.

The worker count is calculated as:

\\[ \text{Workers} = \max\left(3,\left\lceil \frac{\text{Agents}}{\text{Agents per host}}\times1.2 \right\rceil\right) \\]

The calculation rounds up to whole hosts. The 20% factor is additional host capacity, not an extra 20% RAM allocation inside each host.

**Required worker infrastructure**

| Agents | Workers at 256 MB | Workers at 512 MB | Worker cost at 256 MB | Worker cost at 512 MB |
| ------ | ----------------- | ----------------- | --------------------- | --------------------- |
| 100    | 3                 | 4                 | €88.47                | €117.96               |
| 1,000  | 14                | 26                | €412.86               | €766.74               |
| 10,000 | 126               | 251               | €3,715.74             | €7,401.99             |
| 50,000 | 626               | 1,251             | €18,460.74            | €36,891.99            |

Worker compute only; calculated at €29.49 per CX53 per month, excluding VAT. Prices based on Hetzner's published pricing.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs+1



**Adding the Nomad control plane**

Nomad recommends three or five servers for a production cluster. Three can tolerate one server failure; five can tolerate two. These are separate from the worker hosts in this estimate.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://developer.hashicorp.com\&sz=32)

HashiCorp Developer+1



For planning purposes, I would use three smaller servers at 100 and 1,000 agents, three larger servers at 10,000, and five independent 10,000-agent clusters at 50,000.

| Scale         | Nomad server configuration  | Control-plane cost |
| ------------- | --------------------------- | ------------------ |
| 100 agents    | 3 × CX33                    | €25.47             |
| 1,000 agents  | 3 × CX43                    | €47.97             |
| 10,000 agents | 3 × CX53                    | €88.47             |
| 50,000 agents | 15 × CX53 across 5 clusters | €442.35            |

The server sizes are planning choices, not provider-mandated minimums. Actual Nomad server capacity should be adjusted after measuring scheduling activity and cluster state.

**Estimated Hetzner monthly total**

Lowest-cost model in this comparison

| Agents | 256 MB per agent | 512 MB per agent |
| ------ | ---------------- | ---------------- |
| 100    | **€113.94**      | **€143.43**      |
| 1,000  | **€460.83**      | **€814.71**      |
| 10,000 | **€3,804.21**    | **€7,490.46**    |
| 50,000 | **€18,903.09**   | **€37,334.34**   |

These totals include the estimated worker and Nomad server compute, but exclude the following:

- A database and object storage for persistent agent state.
- Centralised logs, metrics retention and alerting infrastructure.
- Egress gateways or NAT infrastructure, if required.
- Backup and disaster-recovery storage.
- Any additional network or storage charges.
- Engineering and operational labour.

This is therefore a **compute infrastructure estimate**, not a fully loaded OpenAIdom operating cost.

Hetzner includes 20 TB of traffic per eligible Cloud server in the EU, with additional traffic charged beyond the included amount. A Primary IPv4 address is separately priced at €0.50/month per server.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs+1



For example, giving every worker a Primary IPv4 would add approximately €63/month at 10,000 agents in the 256 MB scenario, or €125.50 in the 512 MB scenario. You can reduce this requirement by using private networking and a shared, controlled egress arrangement. Do not assume that IPv6 alone will work for every website your agents need to visit.

**VAT:** The Hetzner figures are excluding VAT. Germany's standard VAT rate is 19%, where applicable. Whether that VAT is charged or recoverable depends on the contracting entity, its VAT status and the supplier's invoicing treatment. The other providers' prices are shown in USD, generally before applicable taxes.

### **5.2 Fly.io cost projections**

Fly's 2026 published rates used here are $2.19 per month for 256 MB and $4.39 for 512 MB, per continuously running Machine.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://fly.io\&sz=32)

Fly



| Agents | 256 MB   | 512 MB   |
| ------ | -------- | -------- |
| 100    | $219     | $439     |
| 1,000  | $2,190   | $4,390   |
| 10,000 | $21,900  | $43,900  |
| 50,000 | $109,500 | $219,500 |

This is the machine compute baseline. It excludes additional storage, network transfer and any optional services.

The pricing is easy to understand and budget, but the premium for an independently managed machine per agent becomes significant.

### **5.3 Northflank cost projections**

Using its published compute rates for the two relevant resource allocations:&#x20;

[image](https://www.google.com/s2/favicons?domain=https://northflank.com\&sz=32)

Northflank



| Agents | 256 MB   | 512 MB   |
| ------ | -------- | -------- |
| 100    | $270     | $540     |
| 1,000  | $2,700   | $5,400   |
| 10,000 | $27,000  | $54,000  |
| 50,000 | $135,000 | $270,000 |

These figures exclude storage and networking. They also assume that Northflank will approve the required concurrent workload at the listed rates; that needs confirmation from the provider.

### **5.4 AWS ECS on EC2 cost projections**

For comparison, I model an AWS EC2 worker as an m7a.2xlarge with 8 vCPUs and 32 GB RAM in Frankfurt.

The indicative price used is approximately $0.5554/hour, or $405.44 per 730-hour month. This is a third-party pricing reference, rather than a binding AWS quotation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://ec2db.com\&sz=32)

EC2 Instance Details



I use the same 75% task-memory allocation and 20% additional worker capacity as the Hetzner model. This is a memory-based comparison; it is not a claim that the two instance types provide equivalent CPU performance.

| Agents | Workers at 256 MB | Workers at 512 MB | EC2 compute at 256 MB | EC2 compute at 512 MB |
| ------ | ----------------- | ----------------- | --------------------- | --------------------- |
| 100    | 3                 | 4                 | $1,216                | $1,622                |
| 1,000  | 14                | 26                | $5,676                | $10,541               |
| 10,000 | 126               | 251               | $51,086               | $101,766              |
| 50,000 | 626               | 1,251             | $253,807              | $507,208              |

This excludes EBS volumes, NAT Gateway, CloudWatch logs, network transfer, load balancing and other AWS services. It also excludes operational labour.

AWS ECS itself does not have the same per-container compute charge as Fargate when using EC2 capacity; the EC2 instances are the main compute cost.

### **5.5 AWS Fargate cost projections**

Fargate's 512 MiB minimum prevents the 256 MB scenario. At 0.25 vCPU and 0.5 GB, the Frankfurt compute-rate estimate is approximately $10.36 per continuously running task per month.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.aws.amazon.com\&sz=32)

Amazon Elastic Container Service+3



| Agents | 512 MB Fargate compute |
| ------ | ---------------------- |
| 100    | $1,036                 |
| 1,000  | $10,362                |
| 10,000 | $103,624               |
| 50,000 | $518,118               |

This is before additional networking, logs and storage. Attaching a separate public IPv4 address to every task would be particularly expensive; a shared network egress design is preferable.

### **5.6 Cost comparison at 10,000 agents**

| Solution        | 256 MB scenario  | 512 MB scenario  |
| --------------- | ---------------- | ---------------- |
| Hetzner + Nomad | **€3,804/month** | **€7,490/month** |
| Fly.io          | $21,900/month    | $43,900/month    |
| Northflank      | $27,000/month    | $54,000/month    |
| AWS ECS on EC2  | $51,086/month    | $101,766/month   |
| AWS Fargate     | Not supported    | $103,624/month   |

The currencies are intentionally not converted: EUR and USD prices should be compared using the exchange rate at the time of a purchasing decision.

**What this comparison tells us:** the economics of shared infrastructure are compelling. However, the Hetzner figures only remain valid if the actual application fits the memory and CPU assumptions. It would be a mistake to select a 256 MB limit based on this table and discover later that the browser and agent runtime need 700 MB.

### **5.7 Sensitivity to actual agent resource use**

The 256 MB and 512 MB scenarios are resource-limit scenarios, not measured OpenAIdom consumption.

The largest uncertainty is browser activity. A browser, multiple tabs, page scripts, screenshots and automation libraries can consume substantial memory. A 256 MB limit may be unrealistic for an agent actively operating a browser; 512 MB also needs testing.

There is another source of overhead: each container creates runtime and process-management overhead outside the application memory limit. With tens of thousands of containers, even a small additional amount per container becomes material.

For example, an additional 8 MB of host-level overhead per container would amount to approximately 80 GB across 10,000 agents and 400 GB across 50,000 agents. This is an illustration of the sensitivity, not a measured Docker overhead figure.

I would therefore not commit to the projected density until a load test measures:

1. Idle memory per agent.
2. Memory while using the browser.
3. Memory during a typical MCP/tool call.
4. Peak memory during concurrent activity.
5. Host-level memory overhead as container density increases.
6. CPU usage during both idle and active periods.

If the real workload needs 1 GB per agent, the cost model changes substantially.

## **6. Recommended architecture**

I would separate **agent lifecycle management** from **infrastructure capacity management**. They are related, but they should not be the same component.

**Layer 1 — Agent control plane**

Owns each agent's identity, configuration, desired state, secrets, lifecycle requests and status.

**Layer 2 — Container orchestration**

Nomad schedules one Docker container per agent, restarts failed containers and moves workloads when worker hosts fail.

**Layer 3 — Infrastructure management**

Nomad Autoscaler and a Hetzner integration add or remove worker servers. Warm worker capacity protects the 10-second startup requirement.

### **6.1 Architecture diagram**

\#chatgpt-mermaid-\_r_l0\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(13, 13, 13);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_l0\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_l0\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_l0\_ .error-icon{fill:rgb(243, 243, 243);}#chatgpt-mermaid-\_r_l0\_ .error-text{fill:rgb(13, 13, 13);stroke:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_l0\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_l0\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_l0\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_l0\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_l0\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_l0\_ .marker.cross{stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_l0\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_l0\_ p{margin:0;}#chatgpt-mermaid-\_r_l0\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .cluster-label text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .cluster-label span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_l0\_ .label text,#chatgpt-mermaid-\_r_l0\_ span{fill:rgb(13, 13, 13);color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .node rect,#chatgpt-mermaid-\_r_l0\_ .node circle,#chatgpt-mermaid-\_r_l0\_ .node ellipse,#chatgpt-mermaid-\_r_l0\_ .node polygon,#chatgpt-mermaid-\_r_l0\_ .node path{fill:rgb(222, 234, 251);stroke:rgb(83, 154, 248);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .rough-node .label text,#chatgpt-mermaid-\_r_l0\_ .node .label text,#chatgpt-mermaid-\_r_l0\_ .image-shape .label,#chatgpt-mermaid-\_r_l0\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_l0\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .rough-node .label,#chatgpt-mermaid-\_r_l0\_ .node .label,#chatgpt-mermaid-\_r_l0\_ .image-shape .label,#chatgpt-mermaid-\_r_l0\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_l0\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_l0\_ .root .anchor path{fill:rgb(143, 143, 143)!important;stroke-width:0;stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_l0\_ .arrowheadPath{fill:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_l0\_ .edgePath .path{stroke:rgb(143, 143, 143);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .flowchart-link{stroke:rgb(143, 143, 143);fill:none;}#chatgpt-mermaid-\_r_l0\_ .edgeLabel{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_l0\_ .edgeLabel p{background-color:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_l0\_ .edgeLabel rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_l0\_ .labelBkg{background-color:rgba(252, 252, 252, 0.5);}#chatgpt-mermaid-\_r_l0\_ .cluster rect{fill:rgb(243, 243, 243);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .cluster text{fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ .cluster span{color:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(243, 243, 243);border:1px solid rgba(0, 0, 0, 0.1);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_l0\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(13, 13, 13);}#chatgpt-mermaid-\_r_l0\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_l0\_ .icon-shape,#chatgpt-mermaid-\_r_l0\_ .image-shape{background-color:rgb(252, 252, 252);text-align:center;}#chatgpt-mermaid-\_r_l0\_ .icon-shape p,#chatgpt-mermaid-\_r_l0\_ .image-shape p{background-color:rgb(252, 252, 252);padding:2px;}#chatgpt-mermaid-\_r_l0\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_l0\_ .image-shape .label rect{opacity:0.5;background-color:rgb(252, 252, 252);fill:rgb(252, 252, 252);}#chatgpt-mermaid-\_r_l0\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_l0\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_l0\_ .node .neo-node{stroke:rgb(83, 154, 248);}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_l0\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_l0\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node .neo-line path{stroke:rgb(83, 154, 248);filter:none;}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_l0\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_l0\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_l0\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_l0\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_l0\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_l0\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(0, 79, 153);}#chatgpt-mermaid-\_r_l0\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_l0\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_l0\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .node rect,#chatgpt-mermaid-\_r_l0\_ .node circle,#chatgpt-mermaid-\_r_l0\_ .node ellipse,#chatgpt-mermaid-\_r_l0\_ .node polygon,#chatgpt-mermaid-\_r_l0\_ .node path{fill:rgb(229, 243, 255);stroke:rgba(0, 0, 0, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_l0\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_l0\_ .mermaid-decision .label-container{fill:rgb(245, 250, 255);stroke:rgb(206, 219, 229);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_l0\_ .edgePaths .flowchart-link{stroke:rgb(143, 143, 143);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_l0\_ .marker{fill:rgb(143, 143, 143);stroke:rgb(143, 143, 143);}#chatgpt-mermaid-\_r_l0\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}User / OpenAIdom APIAgent Control PlaneAgent Registry and DesiredStateLifecycle QueueAgent OrchestratorNomad Cluster ShardsWarm Hetzner Worker PoolDocker with gVisor RuntimeOne Isolated Container perAgentSecret BrokerPostgreSQLObject StorageControlled Internet EgressHost and Nomad MetricsMonitoring and AlertingNomad AutoscalerHetzner Cloud API

The architecture has these components:

| Component           | Responsibility                                                   |
| ------------------- | ---------------------------------------------------------------- |
| Agent Control Plane | User-facing lifecycle API and desired state                      |
| Agent Registry      | Agent ID, owner, configuration, status and cluster assignment    |
| Lifecycle Queue     | Reliable create, restart, update and delete requests             |
| Agent Orchestrator  | Translates lifecycle requests into Nomad jobs                    |
| Nomad               | Container scheduling, placement, health and restart              |
| Worker servers      | Host the actual agent containers                                 |
| Secret Broker       | Supplies only the credentials belonging to the relevant agent    |
| PostgreSQL          | Durable configuration and application state                      |
| Object Storage      | Files and larger persistent artefacts                            |
| Monitoring          | Host health, agent heartbeats, resource consumption and alerting |
| Nomad Autoscaler    | Adjusts worker capacity based on demand                          |
| Hetzner API         | Provisions and deletes cloud servers                             |

### **6.2 Agent creation lifecycle**

I would implement the lifecycle as follows:

1. A user creates an agent through OpenAIdom.
2. The control plane writes its identity and desired state to the database.
3. A lifecycle event is placed in the queue.
4. The orchestrator selects a Nomad cluster and submits a job for that agent.
5. Nomad selects an appropriate worker with sufficient reserved memory and CPU.
6. The worker starts a container from a cached agent image.
7. The container receives its agent ID, configuration and securely injected credentials.
8. It connects to the relevant messaging and tool services.
9. A readiness check confirms the agent is operational.
10. The control plane changes the agent's status to `RUNNING`.

The orchestrator should make requests idempotent. A repeated create request must not accidentally create multiple containers for the same agent.

I would use one Nomad job per agent, with one task in its task group. That preserves the desired independent lifecycle without requiring a separate VM per agent.

### **6.3 How to achieve the 10-second startup target**

This is the most important design decision.

Do **not** wait for the infrastructure autoscaler to create a VM when a user creates an agent.

Instead:

- Maintain an always-running pool of worker servers.
- Keep at least 20% additional capacity available, adjusting it using observed creation rates.
- Pre-pull the current agent image onto worker nodes.
- Keep the standard agent image identical across agents.
- Supply agent-specific configuration at startup rather than building a separate image for every agent.
- Avoid synchronous database migrations or expensive external setup during container startup.
- Use a lightweight readiness check to determine when the agent can accept work.

The startup time is then mostly the scheduling, container creation and agent initialisation time on an existing machine, rather than VM provisioning time.

**What can be claimed:** starting a container on a warm host with a cached image is a realistic way to target less than 10 seconds.

**What cannot currently be claimed:** that Hetzner + Nomad guarantees less than 10 seconds from user request to operational agent, under all conditions, at tens of thousands of agents. That must be demonstrated with an end-to-end load test. In particular, test P95 and P99, not just the average.

I would define the target as:

- P95 agent readiness: under 10 seconds.
- P99 agent readiness: under 10 seconds, if this is a hard product requirement.
- New host provisioning: allowed to take minutes, provided enough warm capacity remains available.

### **6.4 Infrastructure autoscaling**

Nomad has two distinct autoscaling concerns:

1. **Allocation scaling:** scheduling more or fewer containers.
2. **Client-node scaling:** adding or removing the machines that host those containers.

Nomad Autoscaler supports both concepts. Hetzner Cloud is listed among the community-supported infrastructure scaling targets, but this is not the same as a first-party managed autoscaling service. I would validate the plugin's maintenance status and behaviour before relying on it in production.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://developer.hashicorp.com\&sz=32)

HashiCorp Developer+2



A suitable scaling policy would be:

| Condition                                          | Action                                          |
| -------------------------------------------------- | ----------------------------------------------- |
| Available worker memory falls below target reserve | Provision additional workers                    |
| Worker CPU remains saturated                       | Add workers or move to higher-performance hosts |
| New agents arrive in a burst                       | Schedule immediately on warm capacity           |
| Worker becomes unhealthy                           | Mark unavailable and reschedule its agents      |
| Worker has low utilisation                         | Begin a controlled drain                        |
| All agents have moved successfully                 | Remove the worker                               |

For scale-in, never terminate a worker simply because its CPU usage is low. First drain it, relocate its agents, verify their health and then delete the machine.

At 50,000 agents, I would use multiple Nomad clusters, each with its own control plane and worker group. This limits the blast radius of an orchestration or scheduling problem.

### **6.5 Persistent state**

I would avoid using each container's writable filesystem as the permanent store for agent data.

Instead:

- Store agent metadata and durable structured state in PostgreSQL.
- Store uploaded files and generated artefacts in S3-compatible object storage.
- Store credentials in a secret-management service.
- Treat the container filesystem as disposable.
- Reconstruct the agent from its database record after a restart.

This makes it possible to restart or relocate an agent without depending on the original worker's disk.

Per-agent persistent volumes may be necessary for some workloads, but I would not make them the default. They add storage costs, lifecycle complexity and potential startup delays.

### **6.6 Monitoring and recovery**

At this scale, host health alone is not enough.

You need to monitor both the infrastructure and the agents:

| Level          | What to monitor                                                   |
| -------------- | ----------------------------------------------------------------- |
| Host           | CPU, RAM, disk, networking, load and availability                 |
| Container      | Memory limit, restarts, OOM kills, CPU and uptime                 |
| Agent          | Heartbeat, readiness, processing state and errors                 |
| Orchestrator   | Scheduling latency, pending jobs and failed deployments           |
| Infrastructure | Available capacity, provisioning failures and autoscaler activity |

Prometheus, Grafana, Node Exporter, Nomad metrics and centralised structured logs are a reasonable starting combination.

At 50,000 agents, avoid creating an excessively high-cardinality monitoring system that stores every metric for every agent indefinitely. Use aggregation for fleet-wide health and retain detailed per-agent information where it is operationally useful.

## **7. Multi-tenant isolation and security**

This is a significant design risk because agents are able to browse arbitrary websites, interact with external tools and process potentially untrusted content.

A conventional Docker container provides useful separation through namespaces and cgroups, but it still shares the host kernel. It should not be treated as an independent virtual machine.

HashiCorp's Docker driver documentation and isolation guidance distinguish resource management from a strong security boundary.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hashicorp.com\&sz=32)

HashiCorp Developer+1



### **Recommended isolation**

I would use **gVisor as the default sandbox runtime**, subject to compatibility and performance testing.

gVisor provides a user-space application kernel and integrates with container runtimes such as Docker. It adds isolation between workloads and the host kernel, but also adds memory and performance overhead.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://gvisor.dev\&sz=32)

gVisor+2



For higher-risk workloads, consider a Firecracker-based microVM approach. Fly Machines are an example of the latter model.

| Approach               | Isolation                 | Cost/overhead                              | Suitability                |
| ---------------------- | ------------------------- | ------------------------------------------ | -------------------------- |
| Standard Docker        | Shared host kernel        | Lowest                                     | Trusted workloads only     |
| Docker + gVisor        | Stronger sandbox boundary | Additional memory and performance overhead | Good candidate for default |
| Firecracker microVM    | Separate VM boundary      | More expensive                             | Higher-risk agents         |
| Dedicated VM per agent | Strong isolation          | Very expensive at scale                    | Special cases              |

### **Security measures I would require**

- No agent receives access to the Docker socket or host filesystem.
- Each agent receives only its own secrets and credentials.
- Agent containers cannot read the environment variables of other agents.
- East-west network access is denied by default.
- Access to databases and internal services is restricted by identity and permissions.
- Outbound requests are controlled to prevent access to cloud metadata endpoints and internal infrastructure.
- User-controlled MCP servers and tools are treated as potentially untrusted.
- Container images are immutable, scanned and updated through controlled releases.
- Agent deletion revokes credentials and removes associated secrets.

The outbound networking requirement deserves particular attention: an agent that browses arbitrary websites must have internet access, but it must not be able to use that access to reach internal services or sensitive metadata endpoints.

Do not expose the Nomad API, host Docker daemon or internal service network to agent containers.

## **8. Risks and limitations**

| Risk                        | Why it matters                                                       | Mitigation                                                     |
| --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Agent memory underestimated | Browser activity may exceed 256 or 512 MB                            | Measure real workloads before finalising container limits      |
| Shared CPU contention       | Many idle agents can become active simultaneously                    | Monitor CPU demand and provision against observed concurrency  |
| Container runtime overhead  | Thousands of containers create host-level overhead                   | Measure actual memory per container and increase host reserves |
| Host failure                | Many agents can be lost together                                     | Nomad rescheduling, spare capacity and external state          |
| Control-plane overload      | Scheduling tens of thousands of allocations creates operational load | Shard clusters and load-test scheduling throughput             |
| Provisioning delays         | New VMs cannot reliably appear within 10 seconds                     | Keep warm worker capacity                                      |
| Security boundary           | Containers share the host kernel                                     | gVisor by default; microVMs for higher-risk workloads          |
| Provider resource quotas    | Large-scale provisioning may require approval                        | Request quota increases early and monitor limits               |
| Regional outage             | Multiple servers in one location may fail together                   | Disaster recovery across locations and regions                 |
| Monitoring costs            | Logs and metrics can become expensive at high volume                 | Retention policies, aggregation and selective detailed logging |

### **8.1 Hetzner-specific operational risks**

There are two limitations I would address before committing to Hetzner at scale.

**API rate and resource limits**

Hetzner's default Cloud API limit is 3,600 requests/hour per project. Resource limits are separate and may require a manual increase request.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.cloud\&sz=32)

docs.hetzner.cloud+2



At 1,251 worker servers, provisioning all workers one by one at the default average request rate would take approximately 21 minutes, even before considering server boot and Nomad registration.

This is not a problem for the proposed architecture because the workers should be provisioned ahead of demand. However, I would ask Hetzner for written confirmation of the resource limits and scaling arrangements needed for the 10,000- and 50,000-agent scenarios.

**Availability**

Hetzner documents a 99.9% monthly availability commitment for Cloud Servers. That is an individual infrastructure service commitment, not a guarantee that the complete OpenAIdom platform will achieve the same availability.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs



The design must tolerate a worker failure without losing agent state or requiring manual intervention.

### **8.2 Shared CPU versus dedicated CPU**

The cost model uses shared-CPU CX servers. That is a reasonable initial assumption for agents that spend much of their time waiting for messages, external APIs or scheduled work.

However, browser automation can produce bursts of CPU consumption.

If testing reveals CPU contention, I would evaluate:

- Larger shared-CPU instances.
- Dedicated-vCPU cloud instances.
- Hetzner dedicated servers.

For example, Hetzner's published AX102-1 configuration has 128 GB RAM and a dedicated AMD Ryzen 9 7950X3D processor, with a substantially higher monthly price than a CX53. Such servers could make sense for CPU-heavy workloads, but I would not introduce them before measuring actual agent CPU utilisation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs+1



### **8.3 Resource sizing could change the entire decision**

The biggest unknown is not whether Nomad can run 50,000 container allocations. It is whether the real OpenAIdom agent can run comfortably inside a 256 MB or 512 MB memory limit.

The browser requirement makes this particularly important.

I would test at least these configurations:

| Configuration                          | What it establishes                           |
| -------------------------------------- | --------------------------------------------- |
| Agent only, 256 MB                     | Lowest possible memory baseline               |
| Agent + browser, 256 MB                | Whether the preferred allocation is realistic |
| Agent + browser, 512 MB                | Whether this is a practical default           |
| Agent + browser + active tools, 512 MB | Typical workload safety                       |
| Multiple agents on one host            | Real host-level resource overhead             |

Do not use the theoretical maximum container density as the production density. Use the measured density with enough headroom for concurrent activity and failures.

## **9. Implementation strategy**

I would implement this incrementally rather than build the final 50,000-agent architecture immediately.

### **Phase 0 — Workload validation**

Do this before choosing the production host size

Deploy the actual OpenAIdom agent image onto one or two CX53 servers.

Run representative workloads, including browser navigation, MCP calls, messaging and idle operation.

Measure memory, CPU, process count, file descriptors, network connections, container startup time and host-level runtime overhead.

The important result is a realistic resource profile for an agent, not simply a successful deployment of one Docker container.

### **Phase 1 — 100 agents**

Build the first production-like environment:

- Three worker hosts for the 256 MB scenario, or four for the 512 MB scenario.
- Three separate Nomad server nodes.
- Agent lifecycle API and database.
- Lifecycle queue.
- Central logs and monitoring.
- Image pre-pulling.
- Container restart and failure recovery.
- Basic gVisor evaluation.

Test the entire create-to-ready lifecycle and deliberately terminate worker containers and hosts to verify recovery.

### **Phase 2 — 1,000 agents**

Introduce:

- Automated worker provisioning.
- Nomad Autoscaler.
- Hetzner Cloud integration.
- Warm capacity management.
- Agent placement and cluster assignment.
- Automated worker draining.
- Centralised secret injection.
- Network isolation.

At this stage, test mass creation and deletion, failure recovery and rolling updates.

### **Phase 3 — 10,000 agents**

Move to independently managed Nomad clusters if the measurements justify it.

I would introduce cluster sharding at this stage rather than waiting until the control plane becomes a bottleneck.

Test:

- Scheduling throughput.
- Cluster recovery.
- Host failure.
- Creation bursts.
- Image deployments.
- Metrics and logging volume.
- Resource fragmentation.
- Multi-tenant security.

Also confirm Hetzner's resource quotas and infrastructure provisioning arrangements.

### **Phase 4 — 50,000 agents**

At this scale:

- Operate multiple independent Nomad shards.
- Distribute clusters across appropriate failure domains.
- Establish a disaster-recovery strategy.
- Introduce capacity forecasting.
- Evaluate dedicated servers for CPU-heavy agent groups.
- Review commercial pricing with Hetzner.
- Perform regular load and recovery testing.

I would also reassess whether five 10,000-agent shards or ten 5,000-agent shards provide the better operational trade-off. The cost model uses five shards; ten would require another 15 Nomad server nodes if using three servers per shard.

## **10. Final verdict**

### **1. Which solution would I choose if I were building OpenAIdom?**

**Hetzner Cloud + HashiCorp Nomad + Docker, with gVisor evaluated as the default container runtime.**

It provides the best projected economics while retaining independent lifecycle management for every agent.

The infrastructure is more complicated to operate than a fully managed platform, but the financial difference becomes substantial at 10,000 agents and beyond.

I would not start with Kubernetes unless there were already a strong operational reason to use it.

### **2. Which solution is easiest to operate?**

**Northflank or Fly.io.**

Northflank offers a managed platform experience. Fly Machines have a particularly natural per-agent lifecycle abstraction and stronger machine-level isolation.

For the easiest overall managed experience, I would evaluate Northflank first. For independently managed, isolated agent machines, I would evaluate Fly first.

Neither is my preferred solution for the complete 50,000-agent workload because of the projected costs and the need to confirm large-scale quotas.

### **3. Which solution offers the lowest realistic cost at 10,000 agents?**

**Hetzner + Nomad**, assuming the actual agent resource profile fits the model.

The estimated monthly compute infrastructure is:

- 256 MB: approximately €3,804.
- 512 MB: approximately €7,490.

These totals include the estimated Nomad control plane, but exclude database, object storage, monitoring, networking extras and operational labour.

### **4. Which solution offers the best balance of cost, simplicity and scalability?**

**Hetzner + Nomad**, with AWS ECS on EC2 as the alternative for a team prioritising managed infrastructure.

AWS is more expensive, but it reduces the amount of infrastructure orchestration OpenAIdom must operate itself.

The deciding factor is whether the savings from Hetzner justify maintaining the Nomad and infrastructure autoscaling layers. At 10,000–50,000 agents, they probably do.

### **5. Can the recommended solution reliably meet the less-than-10-second startup requirement?**

**It is a realistic target, but not something I would promise without a performance test.**

The recommended architecture avoids provisioning a new VM during an individual agent creation request.

With warm workers, cached images, a lightweight startup sequence and enough available capacity, a container can plausibly become ready within 10 seconds.

The requirement becomes much harder when workers are full, images need to be pulled, external dependencies are slow or large numbers of agents are created simultaneously.

The acceptance test should measure end-to-end readiness at P95 and P99 under realistic load.

### **6. What would I implement first?**

I would start with a **100-agent Nomad proof of concept on Hetzner**, using the actual OpenAIdom agent image, including the browser.

The first experiment should answer five questions:

1. Does an idle agent fit within 256 MB?
2. Does an agent actively using its browser fit within 512 MB?
3. What is the real host-level overhead per container?
4. Can a new agent reach readiness within 10 seconds on a warm host?
5. Can Nomad recover an agent after the worker hosting it disappears?

Those results will determine whether the cost projections are realistic and whether gVisor introduces an acceptable overhead.

## **Overall recommendation**

**Recommended starting architecture**

My choice

# **Hetzner + Nomad**

European cloud infrastructure · Independent Docker containers · Warm worker pool · Automated node scaling

# **€3.8k**

Monthly compute estimate, 10k agents at 256 MB

# **€7.5k**

Monthly compute estimate, 10k agents at 512 MB

**First milestone:** 100 real agents, actual browser workloads, gVisor evaluation and end-to-end startup measurement.

**One final qualification:** I would not make a long-term infrastructure commitment based solely on the 256 MB or 512 MB figures. For OpenAIdom, browser memory consumption and concurrent activity are the two measurements most likely to change the financial outcome. The infrastructure choice is relatively clear; validating the workload density is the next critical decision.

## **Principal sources**

The research prioritised provider documentation and published pricing, with third-party pricing references identified where applicable.

- [Hetzner Cloud pricing and server configurations](https://www.hetzner.com/cloud/?utm_source=chatgpt.com)
- [HashiCorp Nomad documentation](https://developer.hashicorp.com/nomad/docs?utm_source=chatgpt.com)
- [Nomad Autoscaler documentation](https://developer.hashicorp.com/nomad/tools/autoscaling?utm_source=chatgpt.com)
- [gVisor documentation](https://gvisor.dev/docs/?utm_source=chatgpt.com)
- [Fly Machines documentation](https://fly.io/docs/machines/?utm_source=chatgpt.com)
- [Northflank pricing](https://northflank.com/pricing?utm_source=chatgpt.com)
- [AWS ECS pricing](https://aws.amazon.com/ecs/pricing/?utm_source=chatgpt.com)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/?utm_source=chatgpt.com)
- [Google Cloud Run pricing](https://cloud.google.com/run/pricing?utm_source=chatgpt.com)
- [Azure Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/?utm_source=chatgpt.com)