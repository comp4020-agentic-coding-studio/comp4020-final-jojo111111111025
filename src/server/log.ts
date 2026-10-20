// Structured, server-side logging (C10). One JSON object per line on
// stdout, which `flyctl logs` (and `docker logs` in CI) captures as-is — no
// separate log file or service. Each line names an event and carries the
// server-resolved player_id where relevant — never a client-asserted one,
// and never the signed cookie value or SESSION_SECRET itself.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
