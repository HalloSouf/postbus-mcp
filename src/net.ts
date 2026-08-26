import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { PostbusError } from "./types.js";

// A mail server reached over loopback is a local bridge (Proton Mail Bridge is
// a shipped preset), which no network attacker sits in front of. Everything
// else has to prove it is on the public internet before we hand it a password.
const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

export function isLoopbackHost(host: string): boolean {
  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(cleaned)) return true;

  return isIP(cleaned) !== 0 && isLoopbackAddress(cleaned);
}

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalised = address.replace(/^::ffff:/i, "");
    if (normalised !== address) return isLoopbackAddress(normalised);
    return address === "::1";
  }

  return address.startsWith("127.");
}

// Ranges that only ever mean "somewhere inside our own infrastructure".
function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalised = address.toLowerCase().replace(/^::ffff:/i, "");
    if (normalised !== address.toLowerCase()) return isPrivateAddress(normalised);

    return (
      normalised === "::" ||
      normalised === "::1" ||
      normalised.startsWith("fe80:") || // link-local
      /^f[cd]/.test(normalised) // unique local
    );
  }

  const octets = address.split(".").map(Number);
  const [a = 0, b = 0] = octets;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224 // multicast and reserved
  );
}

/**
 * Refuses hosts that resolve into the private network. Without this,
 * add_mail_account is a port scanner: the caller picks any host and port and
 * reads the internal topology off the connection errors.
 */
export async function assertMailHostAllowed(host: string): Promise<void> {
  const cleaned = host.trim().replace(/^\[|\]$/g, "");

  if (!cleaned) {
    throw new PostbusError("A mail server hostname is required.", undefined, "invalid_input");
  }

  // A local bridge is the one legitimate private target.
  if (isLoopbackHost(cleaned)) return;

  const addresses =
    isIP(cleaned) !== 0
      ? [cleaned]
      : await resolveAll(cleaned).catch(() => {
          throw new PostbusError(
            `The mail server "${host}" cannot be found (DNS error).`,
            "Check the hostname you passed to add_mail_account.",
            "invalid_input",
          );
        });

  if (addresses.some(isPrivateAddress)) {
    throw new PostbusError(
      `"${host}" resolves to an address inside a private network.`,
      "postbus-mcp only connects to mail servers on the public internet, or to a local " +
        "bridge on 127.0.0.1 such as Proton Mail Bridge.",
      "invalid_input",
    );
  }
}

async function resolveAll(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}
