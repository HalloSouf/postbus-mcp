import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountExists, listAccounts, removeAccount, saveImapAccount } from "../db/accounts.js";
import { ImapSmtpProvider } from "../providers/imap/provider.js";
import { findPreset } from "../providers/imap/presets.js";
import { release } from "../providers/imap/connection.js";
import { assertMailHostAllowed, isLoopbackHost } from "../net.js";
import { PostbusError, type ImapAccount } from "../types.js";
import type { ToolContext } from "./context.js";
import { formatAccounts } from "./format.js";
import { guard } from "./guard.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function registerAccountTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List your mailboxes",
      description:
        "Lists the mailboxes linked to your token, with alias and email address. " +
        "Pass an alias as `account` to the other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => formatAccounts(listAccounts(context.user.id))),
  );

  server.registerTool(
    "add_mail_account",
    {
      title: "Link a mailbox",
      description:
        "Links an IMAP/SMTP mailbox to your account using an app password. " +
        "For known providers (Gmail, Outlook, Fastmail, iCloud, Yahoo, Zoho) only alias, email " +
        "and app_password are needed — host and port are filled in automatically. " +
        "Never use a normal account password: create an app password instead " +
        "(Gmail: https://myaccount.google.com/apppasswords). " +
        "The connection is tested before anything is stored.",
      inputSchema: {
        alias: z
          .string()
          .min(1)
          .describe('Short name for this mailbox, e.g. "personal" or "work".'),
        email: z.string().min(3).describe("The email address of the mailbox."),
        app_password: z
          .string()
          .min(1)
          .describe("The app password. Stored encrypted, never in plain text."),
        imap_host: z.string().optional().describe("IMAP host, e.g. imap.gmail.com."),
        imap_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("IMAP port, usually 993."),
        smtp_host: z.string().optional().describe("SMTP host, e.g. smtp.gmail.com."),
        smtp_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("SMTP port: 465 (TLS) or 587 (STARTTLS)."),
        imap_secure: z
          .boolean()
          .optional()
          .describe(
            "Implicit TLS on the IMAP port. Defaults to on for port 993, off (STARTTLS) otherwise.",
          ),
        smtp_secure: z
          .boolean()
          .optional()
          .describe(
            "Implicit TLS on the SMTP port. Defaults to on for port 465, off (STARTTLS) otherwise.",
          ),
        username: z
          .string()
          .optional()
          .describe("Login name, if it differs from the email address."),
        display_name: z.string().optional().describe("Sender name shown on outgoing mail."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const alias = input.alias.trim();
        if (!ALIAS_PATTERN.test(alias)) {
          throw new PostbusError(
            `Invalid alias "${alias}".`,
            "Use letters, digits, dot, dash or underscore (32 characters max).",
          );
        }

        const settings = resolveSettings(input);
        await assertMailTargetAllowed(settings);
        const replaced = accountExists(context.user.id, alias);

        // Verify first, store second: a broken mailbox helps nobody.
        const candidate: ImapAccount = {
          id: `probe-${alias}`,
          userId: context.user.id,
          alias,
          email: input.email.trim(),
          displayName: input.display_name?.trim() || undefined,
          createdAt: new Date().toISOString(),
          provider: "imap",
          ...settings,
          username: input.username?.trim() || input.email.trim(),
          password: input.app_password,
        };

        await new ImapSmtpProvider().verify(candidate);

        const saved = saveImapAccount({
          userId: context.user.id,
          alias,
          email: candidate.email,
          displayName: candidate.displayName,
          imapHost: candidate.imapHost,
          imapPort: candidate.imapPort,
          imapSecure: candidate.imapSecure,
          smtpHost: candidate.smtpHost,
          smtpPort: candidate.smtpPort,
          smtpSecure: candidate.smtpSecure,
          username: candidate.username,
          password: candidate.password,
        });

        return [
          `${replaced ? "Relinked" : "Linked"}: "${saved.alias}" → ${saved.email}`,
          `IMAP ${candidate.imapHost}:${candidate.imapPort} · SMTP ${candidate.smtpHost}:${candidate.smtpPort}`,
          "Both connections were tested and the app password is stored encrypted.",
          "",
          `Try it: search_emails with account "${saved.alias}" and query "is:unread newer_than:7d".`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "remove_mail_account",
    {
      title: "Unlink a mailbox",
      description:
        "Removes one of your mailboxes from postbus-mcp, including the stored app password. " +
        "Nothing changes in the mailbox itself.",
      inputSchema: {
        alias: z.string().min(1).describe("Alias of the mailbox to unlink."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ alias }) =>
      guard(async () => {
        const removedId = removeAccount(context.user.id, alias);
        if (!removedId) {
          const known = listAccounts(context.user.id).map((a) => a.alias);
          throw new PostbusError(
            `You have no mailbox with alias "${alias}".`,
            known.length ? `Available: ${known.join(", ")}.` : undefined,
          );
        }

        release(removedId);
        return `Mailbox "${alias}" is unlinked and its stored app password is gone.`;
      }),
  );
}

// Host and port come straight from the caller, so without this the tool is a
// port scanner for whatever network the container sits in: aim it at an
// internal range and read the topology off the connection errors.
const PUBLIC_IMAP_PORTS = new Set([143, 993]);
const PUBLIC_SMTP_PORTS = new Set([25, 465, 587, 2525]);

export async function assertMailTargetAllowed(settings: {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}): Promise<void> {
  await assertMailHostAllowed(settings.imapHost);
  await assertMailHostAllowed(settings.smtpHost);

  assertPort("IMAP", settings.imapHost, settings.imapPort, PUBLIC_IMAP_PORTS);
  assertPort("SMTP", settings.smtpHost, settings.smtpPort, PUBLIC_SMTP_PORTS);
}

// A local bridge picks its own ports (Proton Mail Bridge uses 1143 and 1025),
// so only public hosts are held to the standard ones.
function assertPort(protocol: string, host: string, port: number, allowed: Set<number>): void {
  if (isLoopbackHost(host) || allowed.has(port)) return;

  throw new PostbusError(
    `Port ${port} is not a ${protocol} port.`,
    `Use one of: ${[...allowed].join(", ")}.`,
    "invalid_input",
  );
}

export interface SettingsInput {
  email: string;
  imap_host?: string | undefined;
  imap_port?: number | undefined;
  imap_secure?: boolean | undefined;
  smtp_host?: string | undefined;
  smtp_port?: number | undefined;
  smtp_secure?: boolean | undefined;
}

const IMPLICIT_TLS_IMAP_PORT = 993;
const IMPLICIT_TLS_SMTP_PORT = 465;

export function resolveSettings(input: SettingsInput): {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
} {
  const preset = findPreset(input.email);

  const imapHost = input.imap_host?.trim() || preset?.imapHost;
  const smtpHost = input.smtp_host?.trim() || preset?.smtpHost;

  if (!imapHost || !smtpHost) {
    throw new PostbusError(
      `I do not know the mail server for "${input.email}".`,
      "Pass imap_host and smtp_host explicitly. Your provider lists them under 'IMAP settings', " +
        "typically imap.yourdomain.com (port 993) and smtp.yourdomain.com (port 465 or 587).",
    );
  }

  const imapPort = input.imap_port ?? preset?.imapPort ?? IMPLICIT_TLS_IMAP_PORT;
  const smtpPort = input.smtp_port ?? preset?.smtpPort ?? IMPLICIT_TLS_SMTP_PORT;

  return {
    imapHost,
    imapPort,
    // Implicit TLS on the standard ports; elsewhere imapflow and nodemailer
    // still negotiate STARTTLS when the server offers it.
    imapSecure: input.imap_secure ?? imapPort === IMPLICIT_TLS_IMAP_PORT,
    smtpHost,
    smtpPort,
    smtpSecure: input.smtp_secure ?? smtpPort === IMPLICIT_TLS_SMTP_PORT,
  };
}
