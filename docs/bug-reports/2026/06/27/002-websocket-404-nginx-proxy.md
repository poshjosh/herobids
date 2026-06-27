# WebSocket /api/events Returns 404 Through Docker Nginx Proxy

**Date**: 2026-06-27
**Severity**: LOW
**Status**: Open

## Summary

The web UI's event stream WebSocket connection (`ws://localhost:5173/api/events?token=...`) fails with HTTP 404 when proxied through the Docker nginx container.

## Reproduction

1. Start the full stack: `docker compose up -d`
2. Open the web UI at `http://localhost:5173`
3. Log in
4. Check browser console — WebSocket errors appear

## Observed Behavior

```
WebSocket connection to 'ws://localhost:5173/api/events?token=...' failed: 
Error during WebSocket handshake: Unexpected response code: 404
```

## Expected Behavior

The WebSocket should connect successfully to receive real-time event updates.

## Impact

- Real-time event notifications in the web UI don't work in the Docker environment
- The UI falls back to polling (5-second interval)
- No functional impact on core features

## Notes

The nginx config (`docker/nginx.conf`) doesn't include WebSocket proxy configuration. Adding `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";` to the `/api/` location block may resolve this.
