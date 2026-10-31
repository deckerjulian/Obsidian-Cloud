import { requestUrl } from 'obsidian';
import { API_BASE } from '@oc/shared';
import { t } from '../i18n';

export type HealthResult = { ok: true } | { ok: false; message: string };

/** Check whether an Obsidian-Cloud backend answers at `url` (GET /api/health). */
export async function checkServerHealth(url: string): Promise<HealthResult> {
  if (!url) return { ok: false, message: t('settings.server.empty') };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: t('health.scheme') };
  }
  try {
    const res = await requestUrl({ url: `${url}${API_BASE}/health`, throw: false });
    if (res.status === 200) return { ok: true };
    return { ok: false, message: t('health.status', { status: res.status }) };
  } catch {
    return { ok: false, message: t('health.unreachable') };
  }
}
