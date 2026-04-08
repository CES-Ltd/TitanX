# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TitanX, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email **security@cesltd.com** with details
3. Include steps to reproduce and potential impact
4. We will acknowledge within 48 hours and provide a fix timeline

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.9.x   | Yes       |
| < 1.9   | No        |

## Security Features

TitanX includes enterprise-grade security:

- **AES-256-GCM** encrypted secrets vault
- **SHA-256 hashed** credential access tokens with timing-safe comparison
- **HMAC-SHA256 signed** immutable audit logs
- **Runtime IAM policy enforcement** on every tool call
- **Deny-by-default network egress** policies (NemoClaw-inspired)
- **SSRF protection** — private IP blocking, DNS rebinding detection
- **Session tokens** with auto-revocation on agent completion
- **10 configurable security feature toggles**
- **4 agent security blueprints** (sandboxed, developer, researcher, CI)
