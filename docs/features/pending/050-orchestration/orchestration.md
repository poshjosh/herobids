Given your constraints:

* **Lightweight isolated environments**
* **Already comfortable with Docker**
* **As simple as possible**
* **Near-zero orchestration cost**
* **Automatic server provisioning as capacity fills up**
* Example: *8 containers per server, then add another server*

I would not start with Kubernetes.

Kubernetes solves this problem, but it introduces significant operational complexity that often outweighs the benefits until you're managing hundreds of containers or need advanced scheduling.

## Option 1: Docker + Nomad (my recommendation)

Architecture:

```text
             +----------------+
             |  Nomad Server  |
             +--------+-------+
                      |
     +----------------+----------------+
     |                                 |
+----v-----+                    +------v----+
| Node 1   |                    | Node 2    |
| 8 ctrs   |                    | 8 ctrs    |
+----------+                    +-----------+
```

Use:

* Docker for container runtime
* HashiCorp Nomad for scheduling
* Optional: Consul for service discovery

Benefits:

* Extremely lightweight
* Single binary
* Much easier than Kubernetes
* Runs happily on small VPS instances
* No licensing cost

Nomad already knows:

* how many containers are running
* remaining CPU/RAM capacity
* where to place new workloads

You define:

```hcl
count = 1
resources {
  cpu    = 500
  memory = 512
}
```

and Nomad schedules automatically.

---

## Option 2: Docker Swarm (possibly even simpler)

Many people forget Docker Swarm still exists.

Architecture:

```bash
docker swarm init
docker node join
```

Deploy:

```bash
docker stack deploy
```

Benefits:

* Almost zero learning curve if you already know Docker
* Built into Docker
* No extra control plane complexity

Scaling:

```bash
docker service scale worker=20
```

For small deployments (10–100 containers) it's surprisingly effective.

The downside:

* Smaller ecosystem
* Less active development
* Fewer advanced scheduling features

But for "8 containers per server, add another server" it is perfectly adequate.

---

## Option 3: Kubernetes + Karpenter/Cluster Autoscaler

Only choose this if you expect:

* dozens of nodes
* many teams
* complex networking
* GPU workloads
* heavy autoscaling

Then:

```text
Kubernetes
     |
Cluster Autoscaler
     |
Cloud Provider
     |
New VM created
```

But operationally:

```text
Complexity: High
Cost: Higher
Maintenance: Higher
```

This does not match your "simple" requirement.

---

# The server provisioning problem

The interesting part is not container orchestration.

It's:

> When a server reaches capacity, create another server automatically.

You have two approaches.

## Approach A: Cloud Autoscaling Group

If you're on:

* AWS
* Azure
* GCP

Use:

* VM Auto Scaling Group
* Launch Templates

Then Nomad or Swarm simply sees:

```text
Node full
    ↓
Autoscaling Group creates VM
    ↓
VM joins cluster
    ↓
Scheduler places containers
```

This is the cleanest solution.

---

## Approach B: Terraform + Event Automation

For VPS providers:

* [Hetzner Cloud](https://www.hetzner.com/cloud?utm_source=chatgpt.com)
* [DigitalOcean](https://www.digitalocean.com?utm_source=chatgpt.com)
* [Linode (Akamai)](https://www.linode.com?utm_source=chatgpt.com)

You can:

1. Monitor cluster utilization
2. Detect >80% capacity
3. Trigger Terraform
4. Provision new VM
5. Cloud-init installs Docker + Nomad/Swarm
6. Node joins cluster automatically

Flow:

```text
Capacity > 80%
        ↓
Automation
        ↓
Terraform Apply
        ↓
Create VM
        ↓
Bootstrap
        ↓
Join Cluster
```

This is how many small SaaS companies scale without Kubernetes.

---

# What I would build today

For a small team wanting simplicity:

```text
Terraform
    +
Cloud-init
    +
Docker
    +
Nomad
```

Node size:

```text
4 vCPU
8 GB RAM
```

Capacity policy:

```text
Target:
8 containers/node

When:
node utilization > 80%

Then:
provision another node
```

This gives:

* Very low operational overhead
* No Kubernetes complexity
* Horizontal scaling
* Infrastructure-as-code
* Near-zero orchestration licensing costs

If you tell me:

1. Which cloud/VPS provider you're using,
2. Roughly how many containers you expect (20, 100, 1000?),
3. Whether containers are long-running services or short-lived jobs,

I can sketch the exact architecture and autoscaling workflow I'd use.
