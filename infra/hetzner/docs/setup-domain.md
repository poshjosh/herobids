### Check your domain `dig NS <domain> +short`

```
dig NS openaidom.com +short
ns-2044.awsdns-63.co.uk.
ns-457.awsdns-57.com.
ns-867.awsdns-44.net.
ns-1273.awsdns-31.org.
```

### Add DNS A record

Example:
- `staging.openaidom.com` → `A` → `your-staging-server-ip`

Optional:
- add an `AAAA` record too if you want IPv6 and your server has a public IPv6

You do **not** need another `NS` record for `staging`.

After adding it, test with:
```bash
dig staging.openaidom.com +short
78.46.192.37 -> staging
167.233.213.107 -> production
```

For AAAA record
```bash
dig AAAA staging.openaidom.com +short
```