**Memory management**
- `get_memory` / `list_memory_keys` / `delete_memory` — we have `set_memory` but no explicit read. The agent can't inspect or clean up its own persistent state.

**Time-based scheduling**
- `schedule_reminder` — fire an alert or action at a specific datetime. `watch_token` handles price triggers but nothing handles time triggers.

**Notification channels**
- `send_message` should be able to send emails — `send_message` goes through the platform inbox. External channels are critical for a PA use case (urgent alerts when the user isn't logged in).

**Document reading**
- `read_document` / `fetch_document` (planned) — `browse_url` only extracts readable HTML via Readability. PDFs (or docx?) (whitepapers, reports, filings) fall through silently.

**Task tracking**
- `create_task` / `list_tasks` / `complete_task` — lets the agent maintain a structured to-do list that survives ticks. Currently it would have to encode this into `set_memory` ad hoc.

**grouping**

| Skill | Tools |
|---|---|
| `base` (extended) | `set_memory`, `get_memory`, `list_memory_keys`, `delete_memory`, `send_message`, `publish_artifact` |
| `web-access` | `search_web`, `browse_url` |
| `task-management` | `create_task`, `list_tasks`, `complete_task`, `schedule_reminder` |