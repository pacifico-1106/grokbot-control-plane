# Security audit — 2026-10

Read-only code review of `grokbot-control-plane` (Staffpass). No production access, no migrations, no runtime-code changes.

| File | Purpose |
|------|---------|
| [REPORT.md](./REPORT.md) | Executive summary, architecture, attack surface, severity table, per-finding detail |
| [findings.json](./findings.json) | Machine-readable findings (`confirmed` / `needs_validation` / `rejected`) |
| [NEEDS-VALIDATION.md](./NEEDS-VALIDATION.md) | Read-only production/runtime checks that code review cannot close |
| [QUARTERLY-OPS-CHECKLIST.md](./QUARTERLY-OPS-CHECKLIST.md) | Quarterly operational items a code review cannot verify |

Audit SHA (branch base): see git history of this folder. Feature flags are environment variables; findings that depend on a flag being ON or OFF are marked in REPORT and `findings.json`.
