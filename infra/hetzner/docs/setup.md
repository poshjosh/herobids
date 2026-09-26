# Setup Infrastructure

## Phase 0 - Prerequisites

- **Own the domain** (or have DNS access to it): e.g. `openaidom.com`. You'll add A (and optionally AAAA records) later.

- **Install the tools** if you don't have them: `terraform`, `jq`, `python3`, `docker`, `dig`, and `pnpm`. Check with `terraform -version`, `jq --version`, etc. (macOS: `brew install terraform jq python3 docker`.)

- **Get a Hetzner Cloud API token** (Hetzner Console → Security → API Tokens). You can use one token for multiple repos, if they are in the same hetzner account/project.

- **Get AWS S3 credentials** for Terraform state: an S3 bucket name, an AWS access key + secret, and a DynamoDB table (optional but recommended) name for state locking. Multiple repos can share the same bucket/table, if they use different state keys.

- **Verify Traderton is up**: `https://api.staging.traderton.com/health/ready` or `https://api.traderton.com/health/ready` should return HTTP 200.

## Phase 1 - Environment files

- **Create the backend environment file.** Copy `infra/hetzner/.env.backend.example` → `.env.backend`, fill in the values.

- **Create .env.<staging|production> file** 

- **Point Herobids at Traderton.** In `infra/hetzner/.env.staging`, set `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com` and values for: `BOUNDARY_CONSUMER_ID`, `BOUNDARY_KEY_ID` and `BOUNDARY_SIGNING_SECRET` that match Traderton's `infra/hetzner/.env.staging`.

## Phase 2 - Generate deploy key and use in tfvars

### Step 1: Generate the SSH key pair (on your local machine)

```sh
ssh-keygen -t ed25519 -C "herobids-deploy-prod" -f ~/.ssh/herobids_deploy_key_prod -N ""
```

This creates:
- `~/.ssh/herobids_deploy_key_prod` (private — goes into production.tfvars)
- `~/.ssh/herobids_deploy_key_prod.pub` (public — goes to GitHub)

### Step 2: Add the public key to GitHub

1. Go to **GitHub → herobids repo → Settings → Deploy keys**
2. Click **Add deploy key**
3. Paste the contents of `~/.ssh/herobids_deploy_key_prod.pub`
4. Check **Allow write access** (needed for `git push` if the server needs to push back)
5. Click **Add key**

### Step 3: Add the private key to terraform.tfvars

```sh
cat ~/.ssh/herobids_deploy_key_prod
```

Copy the output and replace the placeholder in Herobids' production.tfvars:

```hcl
deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (paste content here) ...
-----END OPENSSH PRIVATE KEY-----
EOT
```

Summary of what to put in Herobids' terraform.tfvars

```hcl
hcloud_token = "s2...sa"

ssh_public_key_path = "~/.ssh/herobids_deploy_key_prod.pub"  # or your actual key path

deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (new herobids deploy key) ...
-----END OPENSSH PRIVATE KEY-----
EOT

git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 4: Set git_repo_url to SSH format

```hcl
git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 5: Test connectivity (optional but recommended)

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod -T git@github.com
```

You should see: `Hi poshjosh/herobids! You've successfully authenticated...`

## Phase 3

- **Provision the server** `./scripts/provision.sh --env production --var-file production.tfvars`

- Read the production ip by running this in the same shell as the provision script: `terraform output -raw server_ipv4`

- Add the following to `~/.ssh/config`:

```
Host <server_ipv4>
    User root
    IdentityFile ~/.ssh/herobids_deploy_key_prod
```    

## Phase 4 - Setup Domain Records (A and AAAA)

### Check your domain `dig NS <domain> +short`

```sh
dig NS openaidom.com +short
# expected output format
# ns-2044.awsdns-63.co.uk.
# ns-457.awsdns-57.com.
# ns-867.awsdns-44.net.
# ns-1273.awsdns-31.org.
```

### Add DNS A record

Example:
- `staging.openaidom.com` → `A` → `<server_ipv4>`

Optional:
- add an `AAAA` record too if you want IPv6 and your server has a public IPv6

You do **not** need another `NS` record for `staging`.

After adding it, test with:
```sh
dig @8.8.8.8 staging.openaidom.com +short
# expected output format
# 78.46.192.37 -> staging
# 167.233.213.107 -> production
```

For AAAA record
```sh
dig @8.8.8.8 AAAA staging.openaidom.com +short
```

## Phase 5 - Verify

2. **Verify integration**: from a running Herobids container, `curl https://api.staging.traderton.com/health/ready` or `curl https://api.traderton.com/health/ready` → 200, and confirm an unsigned call returns `authentication.invalid_caller`.
