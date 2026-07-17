import type { TreeResponse, TreeNodeDto, CreateNodeRequest, UpdateNodeRequest } from '@oc/shared';
import type { HttpClient } from './HttpClient';

export interface CachedTree {
  /** Absent when the server answered 304 Not Modified. */
  tree?: TreeResponse;
  etag: string | null;
  notModified: boolean;
}

/** REST client for the server-authoritative vault tree. */
export class TreeApi {
  constructor(private readonly http: HttpClient) {}

  getTree(): Promise<TreeResponse> {
    return this.http.get<TreeResponse>('/tree');
  }

  /** Conditional tree fetch: pass the previous ETag to get a cheap 304. */
  async getTreeCached(etag: string | null): Promise<CachedTree> {
    const res = await this.http.requestWithMeta<TreeResponse>('GET', '/tree', {
      headers: etag ? { 'If-None-Match': etag } : undefined,
    });
    const newTag = res.headers['etag'] ?? null;
    if (res.status === 304) return { etag: etag ?? newTag, notModified: true };
    return { tree: res.json, etag: newTag, notModified: false };
  }

  createNode(body: CreateNodeRequest): Promise<TreeNodeDto> {
    return this.http.post<TreeNodeDto>('/nodes', body);
  }

  updateNode(id: string, body: UpdateNodeRequest): Promise<TreeNodeDto> {
    return this.http.request<TreeNodeDto>('PATCH', `/nodes/${id}`, body);
  }

  deleteNode(id: string): Promise<void> {
    return this.http.request<void>('DELETE', `/nodes/${id}`);
  }
}
