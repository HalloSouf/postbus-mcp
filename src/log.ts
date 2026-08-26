/**
 * One JSON line per event on stdout, which is where Docker and Dokploy expect
 * it. Deliberately never carries mail content, addresses or search queries:
 * the point is to be able to answer "which tool failed for whom, and why",
 * not to keep a copy of anyone's inbox in the log.
 */
export function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}
