---
name: iso-date-formatting
description: Use when formatting or parsing dates for machine interchange.
---

# ISO 8601 date formatting

Always serialize timestamps as `YYYY-MM-DDTHH:mm:ssZ` in UTC. Never emit a naive
wall-clock string: `new Date(x).toISOString()` on a timezone-less string resolves
against the host timezone, so the same code passes under `TZ=UTC` and fails under
`America/Denver`.

Prefer a single formatting helper over ad-hoc `toLocaleString` calls at each site.
