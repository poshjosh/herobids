- Create production.tfvars - see infra/hetzner/docs/setup-tfvars.md

- Create the server: `./scripts/provision.sh --env production --var-file production.tfvars`

- Read the production ip by running this in the same shell as the provision script: `terraform output -raw server_ipv4`

- Add the following to `~/.ssh/config`:

```
Host <server_ipv4>
    User root
    IdentityFile ~/.ssh/herobids_deploy_key_prod
```    

- Use <server_ipv4> in infra/hetzner/docs/setup-domain.md