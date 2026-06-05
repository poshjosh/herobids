# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- API/worker: pino-pretty dev logging (LOG_FORMAT=pretty or NODE_ENV=development)
- docker-compose: API healthcheck; web depends on api:service_healthy
- docker-compose.dev: LOG_FORMAT=pretty for dev services
- scripts/seed-admin: seeds first admin user; requires ADMIN_EMAIL + ADMIN_PASSWORD;
  ADMIN_PLAN_ID optional (defaults to 'free')
- scripts/rate-limit-load-test: concurrent load test scaffold; ENDPOINT_IS_RATE_LIMITED env flag
- Functional tests: auth + agents API (apps/api/src/__tests__/functional/)
- Worker integration tests: session lifecycle (apps/worker/src/__tests__/integration/)
- E2E: Playwright setup + 6 journey specs (tests/e2e/)
- Web: responsive layout — mobile topbar, sidebar overlay, auth-card, page-shell classes
- vitest: exclude tests/e2e/** from vitest run
- root package.json: test:functional script"
- Initial commit