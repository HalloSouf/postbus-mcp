# postbus-mcp

[![Code quality](https://github.com/HalloSouf/postbus-mcp/actions/workflows/code-quality.yml/badge.svg)](https://github.com/HalloSouf/postbus-mcp/actions/workflows/code-quality.yml)
[![Docker](https://github.com/HalloSouf/postbus-mcp/actions/workflows/docker.yml/badge.svg)](https://github.com/HalloSouf/postbus-mcp/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted [MCP](https://modelcontextprotocol.io) server that lets you and a
handful of people around you work with your mailboxes from Claude or any other
MCP client: search, read whole conversations, and send mail.

Works with **any IMAP/SMTP provider** — Gmail, Outlook, Fastmail, your own mail
server — using a plain **app password**. No Google Cloud project, no OAuth
verification, no test-user limit.

One instance serves **multiple users**. Everyone gets their own API token and
sees only their own mailboxes. You host it, you hand out the tokens; there is no
open sign-up.

```
Claude / MCP client
        │  Authorization: Bearer <token>
        ▼
   POST /mcp  ──►  postbus-mcp  ──►  SQLite (users + encrypted app passwords)
                        │
                        ├──►  IMAP  (imapflow)      search, read, threads
                        └──►  SMTP  (nodemailer)    sending
```

---

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Users and tokens](#users-and-tokens)
- [Connecting your client](#connecting-your-client)
- [Linking a mailbox](#linking-a-mailbox)
- [Available tools](#available-tools)
- [Search syntax](#search-syntax)
- [Threading](#threading)
- [Deploying behind Traefik](#deploying-behind-traefik)
- [Security](#security)
- [Adding a provider](#adding-a-provider)
- [Optional: Gmail through the API instead of IMAP](#optional-gmail-through-the-api-instead-of-imap)
- [Development](#development)

---

## How it works

**Multi-tenant, but small.** One SQLite file with two tables: `users` (id plus a
hash of the API token) and `mail_accounts` (each user's mailboxes, with the app
password encrypted). No separate database service to run.

**Isolation lives in the query, not in a check afterwards.** Every MCP session
belongs to exactly one user, decided by the bearer token. The MCP server is
built per request around that user, and every database query carries the
`user_id` in its `WHERE`. Someone else's alias simply does not exist in your
session.

**Provider interface.** The tool layer talks to a generic `MailProvider` and
knows nothing about IMAP or Gmail. `ImapSmtpProvider` is the main
implementation, with an optional `GmailApiProvider` alongside it. Adding a third
takes no changes to the tools — see [Adding a provider](#adding-a-provider).

---

## Quick start

### With Docker (recommended)

```bash
git clone https://github.com/HalloSouf/postbus-mcp.git
cd postbus-mcp

cp .env.example .env
openssl rand -hex 32          # put the result in .env as MASTER_KEY

docker compose up -d --build
docker compose exec postbus node dist/cli/add-user.js "Soufiane"
```

That last command prints an API token exactly once. Save it right away.

### Locally with Node (20 or newer)

```bash
npm install
cp .env.example .env
openssl rand -hex 32          # put the result in .env as MASTER_KEY

npm run build
npm run add-user -- "Soufiane"
npm start
```

The server listens on `http://localhost:3000/mcp`. A `GET /health` returns
`{"status":"ok"}`, which is handy for an uptime check.

---

## Users and tokens

You hand out tokens yourself; there is no self-service registration.

| Command                        | What it does                                     |
| ------------------------------ | ------------------------------------------------ |
| `npm run add-user -- "Name"`   | Creates a user and prints the token (once)       |
| `npm run list-users`           | Shows users, mailbox counts and status           |
| `npm run rotate-token -- <id>` | New token; the old one stops working immediately |
| `npm run remove-user -- <id>`  | Deletes the user and all their mailboxes         |

In Docker, run the same scripts as `node dist/cli/<script>.js`:

```bash
docker compose exec postbus node dist/cli/list-users.js
docker compose exec postbus node dist/cli/rotate-token.js WvDnhafdM5yQ
```

Only a SHA-256 hash of each token is stored, so a lost token cannot be looked
up — rotate it instead.

---

## Connecting your client

### Claude Desktop

Claude Desktop speaks stdio, so put
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in between. In
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postbus": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header",
        "Authorization: Bearer pb_YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

That file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Restart Claude Desktop
after editing it.

### Claude Code

```bash
claude mcp add --transport http postbus https://mcp.example.com/mcp \
  --header "Authorization: Bearer pb_YOUR_TOKEN_HERE"
```

### Other clients

Anything that speaks **Streamable HTTP** works: endpoint `POST /mcp`, token as
`Authorization: Bearer <token>`. The server runs stateless — no session ids, no
server-side stream — so a `GET /mcp` deliberately returns `405`.

---

## Linking a mailbox

You do this in the conversation, with your own token. No terminal needed:

> Link my Gmail as "personal", address souf@gmail.com, app password abcd efgh ijkl mnop

Claude then calls `add_mail_account`. The connection is tested first (IMAP and
SMTP both); nothing is stored until both work.

### Creating an app password

| Provider                | Where                                                | Note                                       |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Gmail / Workspace       | <https://myaccount.google.com/apppasswords>          | Requires 2FA on the account                |
| Outlook / Microsoft 365 | <https://account.microsoft.com/security>             | Requires 2FA; an admin can block IMAP      |
| Fastmail                | Settings → Privacy & Security → App passwords        | Pick "Mail (IMAP/SMTP)"                    |
| iCloud                  | <https://account.apple.com> → App-specific passwords | Requires 2FA                               |
| Own server              | n/a                                                  | Your mail password, or a dedicated account |

Never use your normal password when the provider offers app passwords.

### Host and port

For known providers postbus-mcp fills these in — you only supply alias, email
and app password:

**Gmail, Google Workspace, Outlook, Hotmail, Microsoft 365, Fastmail, iCloud,
Yahoo, Zoho, Proton (via Bridge).**

For anything else, pass them yourself:

```
imap_host: imap.yourdomain.com    imap_port: 993   (TLS)
smtp_host: smtp.yourdomain.com    smtp_port: 465   (TLS) or 587 (STARTTLS)
```

Ports 993 and 465 use TLS from the first byte; on other ports STARTTLS is used
when the server offers it. If that assumption is wrong for your server, pass
`imap_secure` or `smtp_secure` explicitly.

---

## Available tools

| Tool                  | What it does                                                                   |
| --------------------- | ------------------------------------------------------------------------------ |
| `list_accounts`       | Lists your mailboxes with alias and email address                              |
| `add_mail_account`    | Links an IMAP/SMTP mailbox with an app password (tests the connection first)   |
| `remove_mail_account` | Unlinks a mailbox and wipes the stored app password                            |
| `search_emails`       | Searches with Gmail-style syntax; returns an `id` and a `threadId` per message |
| `get_message`         | Full content of one message: headers, body, attachment metadata                |
| `get_thread`          | Every message in a conversation, oldest first                                  |
| `send_email`          | Sends a new message straight away (cc, bcc, reply-to, html)                    |

Every tool only ever touches mailboxes belonging to the user behind the token.

---

## Search syntax

`search_emails` uses Gmail-style syntax. For **Gmail mailboxes** your query goes
to Gmail unchanged (via `X-GM-RAW`), so anything that works in the Gmail search
bar works here. For **other IMAP servers** it gets translated:

| Term                                                      | Gmail | Other IMAP                |
| --------------------------------------------------------- | ----- | ------------------------- |
| `from:`, `to:`, `cc:`, `bcc:`, `subject:`                 | ✅    | ✅                        |
| `is:unread`, `is:read`, `is:starred`, `is:answered`       | ✅    | ✅                        |
| `newer_than:7d`, `older_than:2w` (`d`/`w`/`m`/`y`)        | ✅    | ✅                        |
| `after:2026-01-01`, `before:2026/03/01`                   | ✅    | ✅                        |
| `larger:5M`, `smaller:100k`                               | ✅    | ✅                        |
| `has:attachment`                                          | ✅    | ✅ (filtered afterwards)  |
| `in:inbox`, `in:sent`, `in:archive`, `in:all`, `in:trash` | ✅    | ✅ (via SPECIAL-USE)      |
| `-from:someone` (exclude)                                 | ✅    | ✅                        |
| `"exact phrase"` and loose words                          | ✅    | ⚠️ one combined text term |
| `label:`, `filename:`, `category:`                        | ✅    | ❌ ignored                |

Examples:

```
from:boss@company.com is:unread newer_than:7d
subject:"march invoice" has:attachment
in:sent to:client@example.com older_than:1m
```

An empty query returns the newest messages in the inbox.

---

## Threading

Every `search_emails` result carries a `threadId`, and `get_thread` uses it to
pull the whole conversation — chronological, with sender, subject, date and body
per message.

There are two ways that happens, depending on what the server can do:

- **Gmail (`X-GM-THRID`) and RFC 8474 servers (`OBJECTID`)** hand out a stable
  thread id themselves. We use it directly, and the `threadId` looks like
  `srv:1829384756`.
- **Every other IMAP server** has no concept of threads. There we reconstruct
  the conversation from the standard `Message-ID`, `In-Reply-To` and
  `References` headers: the first id in that chain is the root of the thread.
  Those `threadId` values start with `ref:`.

When fetching, we look in the "all mail" folder if the server has one, and
otherwise across Inbox, Sent and Archive — so your own replies end up in the
conversation too.

---

## Deploying behind Traefik

`docker-compose.yml` in this repo is a working example. The core of it:

```yaml
services:
  postbus:
    build: .
    restart: unless-stopped
    environment:
      MASTER_KEY: ${MASTER_KEY:?set MASTER_KEY in .env}
      DATABASE_PATH: /data/postbus.db
      TRUST_PROXY: "true"
    volumes:
      - postbus-data:/data
    networks: [proxy]
    labels:
      traefik.enable: "true"
      traefik.docker.network: proxy
      traefik.http.routers.postbus.rule: Host(`${PUBLIC_HOST:-mcp.example.com}`)
      traefik.http.routers.postbus.entrypoints: websecure
      traefik.http.routers.postbus.tls.certresolver: letsencrypt
      traefik.http.services.postbus.loadbalancer.server.port: "3000"
```

Things to watch:

- Set `PUBLIC_HOST` in `.env` to your own hostname; that is the only place the
  domain appears, so the compose file itself stays untouched.
- The `proxy` network has to exist (`docker network create proxy`) and Traefik
  has to be on it.
- The container publishes no port of its own: only Traefik can reach it.
- `TRUST_PROXY=true` lets Express trust the `X-Forwarded-*` headers.
- Terminate TLS at Traefik. Tokens travel as bearer credentials; without HTTPS
  they are in the clear.
- The `postbus-data` volume holds the database with every encrypted app
  password. Back it up together with the `MASTER_KEY` — stored separately.

---

## Security

**MASTER_KEY.** App passwords and refresh tokens are stored with AES-256-GCM,
each with its own IV. The server refuses to start without the key. Lose it and
everyone has to link their mailboxes again, so keep it apart from the database
backup.

**Tokens.** Only the SHA-256 hash is stored. Share them over a channel you
trust and rotate when in doubt (`npm run rotate-token`).

**Isolation.** Every query on `mail_accounts` filters on `user_id`, and the MCP
server is built per request around a single user, so there is no session store
that could mix people up.

**What this is not.** No rate limiting, no audit log, no fine-grained
permissions. This is built for a handful of people you know, behind TLS. Do not
open it up to an unknown audience.

---

## Adding a provider

The tool layer only ever talks to `MailProvider` from `src/types.ts`:

```ts
interface MailProvider<A extends MailAccount = MailAccount> {
  readonly id: ProviderId;
  verify(account: A): Promise<void>;
  search(account: A, query: string, maxResults: number): Promise<MessageSummary[]>;
  getMessage(account: A, messageId: string): Promise<MessageDetail>;
  getThread(account: A, threadId: string): Promise<MessageDetail[]>;
  send(
    account: A,
    to: string,
    subject: string,
    body: string,
    options?: SendOptions,
  ): Promise<string>;
}
```

A provider receives a **fully resolved account**, credentials decrypted. Alias
lookup happens in the tool layer, so a provider cannot reach outside the
session's user.

To add one:

1. Extend `ProviderId` and the `MailAccount` union in `src/types.ts`.
2. Write `src/providers/<name>/provider.ts` with a class implementing the
   interface.
3. Add one line to the map in `src/providers/registry.ts`.
4. Make sure an account of that type can reach the database: a
   `save<Name>Account()` in `src/db/accounts.ts` (secrets go through
   `encryptSecret`), plus a way to link one — an extra tool next to
   `add_mail_account`, or a CLI script.

The existing tools (`search_emails`, `get_message`, `get_thread`, `send_email`)
need no changes. See also [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Optional: Gmail through the API instead of IMAP

The repo carries a second provider that reaches Gmail through the **Gmail API**
rather than IMAP/SMTP. You will almost never need it — IMAP with an app password
does the same job with far less ceremony. It is only useful when your
organisation blocks IMAP but allows the API.

<details>
<summary>Setting up Google Cloud and linking an account</summary>

1. Create a project at <https://console.cloud.google.com>.
2. **APIs & Services → Library** → search for "Gmail API" → **Enable**.
3. **APIs & Services → OAuth consent screen** → type **External** → fill in a
   name and support email.
4. Add the addresses you plan to link under **Test users**.
5. **Credentials → Create credentials → OAuth client ID** → type
   **Desktop app**.
6. Put the client id and secret in `.env`:

   ```
   GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
   OAUTH_CALLBACK_PORT=53682
   ```

7. Link a mailbox. This runs on the admin's machine, because Google sends the
   callback to `localhost`:

   ```bash
   npm run list-users                       # look up the user id
   npm run link-gmail -- <user-id> work
   ```

Scopes used: `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.labels`.

> **Note:** while the OAuth consent screen is set to **Testing**, refresh tokens
> expire after **7 days** and you have to link again. That only stops once the
> consent screen goes to **In production**, which for these scopes requires
> Google verification. This is exactly why IMAP with an app password is the main
> route.

</details>

---

## Development

```bash
npm install
npm run dev          # server with hot reload (tsx watch)
npm test             # unit tests (vitest)
npm run typecheck    # src + tests
npm run format       # prettier across the repo
npm run build        # into dist/
```

The tests in `tests/` run in half a second and touch nothing outside the
process: SQLite runs in memory and no connection leaves the machine. They cover
the logic that can go wrong quietly — search query translation, encoding message
and thread ids, parsing and composing MIME, encrypted storage, the separation
between users, and the bearer middleware.

What they do _not_ cover is talking to a real mail server. For that, run
[GreenMail](https://greenmail-mail-test.github.io/greenmail/) locally:

```bash
docker run -d --rm --name greenmail -p 3143:3143 -p 3025:3025 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp -Dgreenmail.users=souf:secret@postbus.test -Dgreenmail.hostname=0.0.0.0' \
  greenmail/standalone:2.1.0
```

Then link a mailbox with `imap_host: 127.0.0.1`, `imap_port: 3143`,
`smtp_host: 127.0.0.1`, `smtp_port: 3025`, `username: souf`,
`app_password: secret`.

> GreenMail speaks no Gmail extensions. The branch of the code that uses
> `X-GM-RAW` and `X-GM-THRID` can only be exercised against a real Gmail
> mailbox.

GitHub Actions runs the same checks on every push and pull request: formatting,
types, `npm audit` over the production dependencies, the tests on Node 20 and
22, and a docker build that boots the container and verifies that `/health`
answers and `/mcp` returns 401 without a token.

### Project layout

```
src/
├── index.ts              startup: check MASTER_KEY, open the db, listen
├── config.ts             environment configuration
├── crypto.ts             AES-256-GCM for secrets, hashing for tokens
├── types.ts              MailProvider plus every shared type
├── db/                   SQLite: migrations, users, mail_accounts
├── http/                 Express app, bearer auth, MCP transport per request
├── providers/
│   ├── registry.ts       account -> provider
│   ├── imap/             IMAP/SMTP: connections, search, threading, sending
│   └── gmail/            optional Gmail API provider (OAuth)
├── tools/                the MCP tools (they know no provider)
└── cli/                  admin scripts: users and tokens

tests/                    unit tests (vitest), mirroring the layout of src/
```

---

## License

MIT — see [LICENSE](LICENSE).
