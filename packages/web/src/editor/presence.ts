/** Deterministic, readable cursor colour from a stable id. */
export function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash}, 68%, 45%)`;
}

export interface PresenceUser {
  name: string;
  color: string;
  colorLight: string;
}

export function presenceFor(id: string, name: string): PresenceUser {
  const color = colorForUser(id);
  return { name, color, colorLight: color.replace('45%)', '85%)') };
}
