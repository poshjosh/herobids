# Setup tfvars

---

## Steps to generate deploy key for Herobids

### Step 1: Generate the SSH key pair (on your local machine)

```bash
ssh-keygen -t ed25519 -C "herobids-deploy" -f ~/.ssh/herobids_deploy_key -N ""
```

```bash
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

```bash
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

### Step 4: Set git_repo_url to SSH format

```hcl
git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 5: Test connectivity (optional but recommended)

```bash
ssh -i ~/.ssh/herobids_deploy_key_prod -T git@github.com
```

You should see: `Hi poshjosh/herobids! You've successfully authenticated...`

---

## Summary of what to put in Herobids' terraform.tfvars

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