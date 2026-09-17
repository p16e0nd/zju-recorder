# Security Policy

## Network boundary

The HTTP server binds to `127.0.0.1`. Do not expose it through a public reverse proxy, LAN binding, SSH remote forwarding, or container port publishing. The application does not bypass authentication and must only be used with accounts and courses the operator is authorized to access.

The HLS proxy accepts only `*.zju.edu.cn` hosts.

## Sensitive local state

Runtime state is stored in the current user's home directory:

| Path | Contents |
| --- | --- |
| `~/.zju_credentials` | account identifier and password for optional automatic login |
| `~/.zju_jwt` | JWT bearer token |
| `~/.zju_marks.json` | scheduled recordings |
| `~/.zju_stars.json` | starred courses, rooms, and teachers |
| `~/.zju_stream_cache.json` | signed stream URLs and course metadata |
| `~/.zju_chalaoshi.json` | manually synchronized teacher ratings |
| `~/ZJU-Recordings-ai/` | card covers and local UI state |
| `~/ZJU-Recordings-diag/` | playback and recording diagnostics |

The server requests owner-only file permissions where the platform supports POSIX modes. Windows access control follows the current user profile configuration. Automatic login stores the password locally in plaintext JSON; use manual JWT mode when that risk is unacceptable.

Do not publish these files, recordings, logs, request headers, raw API payloads, account identifiers, JWTs, cookies, or signed stream URLs. Review diagnostic reports before sharing because course titles and identifiers may be present.

## Vulnerability reports

Use a private GitHub security advisory when the repository enables it. Do not include live credentials, tokens, signed URLs, or unredacted personal data in a public issue.
