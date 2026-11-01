#!/usr/bin/env bash

set -euo pipefail

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 'docker builder prune -f'

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 'docker image prune -f'

ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'journalctl --disk-usage; du -sh /var/log/* 2>/dev/null | sort -h | tail -10'