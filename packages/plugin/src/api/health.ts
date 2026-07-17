import { requestUrl } from 'obsidian';
import { API_BASE } from '@oc/shared';

export type HealthResult = { ok: true } | { ok: false; message: string };

/** Check whether an Obsidian-Cloud backend answers at `url` (GET /api/health). */
export async function checkServerHealth(url: string): Promise<HealthResult> {
  if (!url) return { ok: false, message: 'No server URL configured.' };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: 'The server URL must start with http:// or https://.' };
  }
  try {
    const res = await requestUrl({ url: `${url}${API_BASE}/health`, throw: false });
    if (res.status === 200) return { ok: true };
    return { ok: false, message: `Server responded with HTTP ${res.status} — is the URL correct?` };
  } catch {
    return { ok: false, message: 'Server not reachable — check the URL.' };
  }
}
