# ZhiyiPDF Account-Password Check-in Design

## Goal

Replace cookie-based ZhiyiPDF check-in with account-password login while keeping:

- multiple account support
- Feishu notifications
- failure email notifications in GitHub Actions

The legacy `ZHIYI_COOKIE` and `ZHIYI_COOKIES` secrets will be removed from active use.

## Constraints

- The login flow goes through `https://www.zhiyipdf.com/login` and redirects into the Casdoor-based auth flow on `https://www.zhiyipdf.cc`.
- Cookie values expire frequently, so the workflow must establish a fresh authenticated session on every run.
- Existing SMTP and Feishu secrets should remain reusable without reconfiguration.
- The account may already be checked in for the day, which should still count as success.

## Chosen Approach

Use a Playwright-driven Node script that:

1. parses a new `ZHIYI_ACCOUNTS_JSON` secret
2. logs in each account in an isolated browser context
3. reuses the authenticated page session to call the existing check-in API
4. reports success or failure per account

This approach is preferred over a pure HTTP reverse-engineering flow because it is more resilient to OAuth and login-page changes.

## Secret Format

Add one new GitHub Actions secret:

```json
[
  { "name": "main", "username": "16670526557", "password": "example" }
]
```

Environment variable name:

- `ZHIYI_ACCOUNTS_JSON`

Secrets that continue unchanged:

- `FEISHU_WEBHOOK`
- `MAIL_FROM`
- `MAIL_TO`
- `SMTP_HOST`
- `SMTP_PASSWORD`
- `SMTP_PORT`
- `SMTP_USERNAME`

Secrets to deprecate:

- `ZHIYI_COOKIE`
- `ZHIYI_COOKIES`

## Runtime Flow

For each configured account:

1. open the ZhiyiPDF login page
2. fill in username and password
3. submit the login form
4. wait for a logged-in dashboard signal such as `个人中心`, `今日已签到`, or a dashboard URL
5. call `https://www.zhiyipdf.com/api/points/checkin` within the authenticated browser session
6. treat these as success:
   - HTTP 2xx
   - HTTP 409
   - response messages that indicate already checked in

Each account uses its own browser context to avoid state leakage across accounts.

## Notification Rules

- success: Feishu notification only
- failure: Feishu notification and workflow failure email

The workflow email step remains `if: failure()`, so the script only needs to exit non-zero when any account fails.

## Error Handling

- validate that `ZHIYI_ACCOUNTS_JSON` is a non-empty array
- record failures by account `name`
- do not log plaintext passwords
- include useful phase-level reasons such as login timeout, dashboard not detected, or check-in API failure

## Implementation Scope

- update `scripts/zhiyipdf-checkin.mjs`
- update `.github/workflows/zhiyipdf-checkin.yml`
- add a minimal `package.json` and lockfile for Playwright-based execution
