# Setup tfvars

---

## Steps to generate deploy key for Herobids

### Step 1: Generate the SSH key pair (on your local machine)

```bash
ssh-keygen -t ed25519 -C "herobids-deploy" -f ~/.ssh/herobids_deploy_key -N ""
```

This creates:
- `~/.ssh/herobids_deploy_key` (private — goes into terraform.tfvars)
- `~/.ssh/herobids_deploy_key.pub` (public — goes to GitHub)

### Step 2: Add the public key to GitHub

1. Go to **GitHub → herobids repo → Settings → Deploy keys**
2. Click **Add deploy key**
3. Paste the contents of `~/.ssh/herobids_deploy_key.pub`
4. Check **Allow write access** (needed for `git push` if the server needs to push back)
5. Click **Add key**

### Step 3: Add the private key to terraform.tfvars

```bash
cat ~/.ssh/herobids_deploy_key
```

Copy the output and replace the placeholder in Herobids' terraform.tfvars:

```hcl
deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (paste content here) ...
-----END OPENSSH PRIVATE KEY-----
EOT
```

### Step 4: Update your ~/.ssh/config

Add the following:

```
Host 91.99.144.212
    User root
    IdentityFile ~/.ssh/herobids_deploy_key
```    

### Step 5: Set git_repo_url to SSH format

```hcl
git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 6: Test connectivity (optional but recommended)

```bash
ssh -i ~/.ssh/herobids_deploy_key -T git@github.com
```

You should see: `Hi poshjosh! You've successfully authenticated...`

---

## Summary of what to put in Herobids' terraform.tfvars

```hcl
hcloud_token = "s2...sa"

ssh_public_key_path = "~/.ssh/herobids_deploy_key.pub"  # or your actual key path

deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (new herobids deploy key) ...
-----END OPENSSH PRIVATE KEY-----
EOT

git_repo_url = "git@github.com:poshjosh/herobids.git"
```