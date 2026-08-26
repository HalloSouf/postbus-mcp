const NON_ASCII = /[^\x20-\x7E]/;

export function encodeHeaderText(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function encodeAddressHeader(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(entry);
      if (!match) return entry;
      const [, name = "", address = ""] = match;
      const cleaned = name.replace(/^"|"$/g, "").trim();
      if (!cleaned) return `<${address}>`;
      return `${encodeHeaderText(cleaned)} <${address}>`;
    })
    .join(", ");
}

export interface MimeMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  html?: boolean;
}

export function buildMimeMessage(message: MimeMessage): string {
  const headers: string[] = [
    `From: ${encodeAddressHeader(message.from)}`,
    `To: ${encodeAddressHeader(message.to)}`,
  ];

  if (message.cc) headers.push(`Cc: ${encodeAddressHeader(message.cc)}`);
  if (message.bcc) headers.push(`Bcc: ${encodeAddressHeader(message.bcc)}`);
  if (message.replyTo) headers.push(`Reply-To: ${encodeAddressHeader(message.replyTo)}`);

  headers.push(`Subject: ${encodeHeaderText(message.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: text/${message.html ? "html" : "plain"}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: base64");

  const encodedBody = (
    Buffer.from(message.body, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${encodedBody}\r\n`;
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
