# Contributing to postbus-mcp

Glad to have you. This is a small, self-hosted project: keep contributions small
and focused and it stays that way.

## Getting started

```bash
npm install
cp .env.example .env
openssl rand -hex 32          # put the result in .env as MASTER_KEY

npm run dev                   # server with hot reload
npm test                      # unit tests (vitest)
npm run typecheck             # src + tests; has to be clean before you open a PR
npm run format                # prettier; CI checks this
npm run build                 # has to compile without errors
```

Test against a real mail server with GreenMail (see _Development_ in the README)
rather than against your own mailbox.

### About the tests

Tests live in `tests/` and mirror the layout of `src/`. They run in half a
second and should keep doing so: **no network, no files on disk, no
containers.** SQLite runs in memory (`DATABASE_PATH` is `:memory:` in
`vitest.config.ts`) and `MASTER_KEY` is a throwaway key.

When you add something, test the logic that can fail quietly rather than the
plumbing around it. What is there now, as a guide:

- **`query.test.ts`** — every operator that gets translated into IMAP criteria
- **`ids.test.ts`** — message and thread ids have to survive a round trip, odd
  folder names included
- **`parse.test.ts`** — taking a real MIME message apart, without a server
- **`compose.test.ts`** — that bcc lands in the envelope and not in the headers
- **`accounts.test.ts`** — that user A cannot reach user B's mailbox
- **`auth.test.ts`** — that only a valid token gets through

Does your change touch an IMAP server or the network? Pull the pure logic into a
separate function and test that, the way `parseQuery` and `composeMail` are
tested.

## Principles

- **The tool layer knows no providers.** `src/tools/` works only with the types
  from `src/types.ts`. The moment you import `imapflow` or `googleapis` in a
  tool, the logic is in the wrong place.
- **Isolation lives in the query.** Every database query on `mail_accounts`
  filters on `user_id`. Never add a path where an alias is looked up without
  one.
- **Secrets never reach the database in plain text.** Use `encryptSecret` /
  `decryptSecret` from `src/crypto.ts`, and add the field to `SECRET_FIELDS`
  when you introduce a new credential type.
- **Error messages are for humans.** Throw a `PostbusError` with a `hint` that
  says what to do next. Translate raw protocol errors inside the provider (see
  `translateImapError`).
- **Comments are short and scarce.** Only where the code does not answer the
  question itself: a protocol quirk, a deliberate trade-off, a security
  assumption. No comment that repeats what the line already says.
- **Everything user-facing is English** — tool descriptions, error messages, CLI
  output, docs.

## Adding a provider

Everything needed to add, say, Exchange Web Services or JMAP:

1. **Types.** Extend `ProviderId` and the `MailAccount` union in
   `src/types.ts` with your account shape, credentials included.
2. **Storage.** Add a `save<Name>Account()` to `src/db/accounts.ts` and extend
   `toAccount()` so a row maps onto your account type. Put the secret fields in
   `SECRET_FIELDS`.
3. **Provider.** Create `src/providers/<name>/provider.ts` with a class
   implementing `MailProvider`:

   | Method       | Expectation                                                                  |
   | ------------ | ---------------------------------------------------------------------------- |
   | `verify`     | Throws when the credentials fail; called before anything is stored           |
   | `search`     | Newest first, at most `maxResults`, every result with an `id` and `threadId` |
   | `getMessage` | Full body and attachment metadata                                            |
   | `getThread`  | Every message in the conversation, oldest first                              |
   | `send`       | Sends and returns the Message-ID                                             |

   `id` and `threadId` are opaque to the client: pick a shape you can decode
   later (see `src/providers/imap/ids.ts`).

4. **Registry.** One line in `src/providers/registry.ts`.
5. **Linking.** An extra tool next to `add_mail_account`, or a CLI script in
   `src/cli/` when the auth flow needs a browser.

The existing tools need no changes.

## Adding a tool

Tools live in `src/tools/` and are registered in `src/tools/index.ts`. A tool:

- receives the `ToolContext`, which carries the session's user;
- looks up a mailbox with `resolveAccount(context, alias)` — never straight
  from the database;
- wraps its handler in `guard()`, so failures come back as a clean tool error
  instead of a crash;
- describes concretely in `description` what it does, with an example, because
  that is what the model reads;
- sets `annotations` correctly: `readOnlyHint` for reading, `destructiveHint`
  for deleting.

For output formatting, see `src/tools/format.ts`. Plain text a human can read,
with the ids included so a follow-up tool can use them.

## Pull requests

- One subject per PR.
- CI has to be green: `npm run format:check`, `npm run typecheck`, `npm test`
  and `npm run build`. Run them locally, it saves a round trip.
- Describe how you tested it: which mail server, which provider.
- Changing behaviour that the README documents? Update the README in the same
  PR.

## Security

Found a vulnerability? Please do not open a public issue — contact the
maintainer of this repository directly.
