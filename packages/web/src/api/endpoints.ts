import type {
  TreeResponse,
  TreeNodeDto,
  CreateNodeRequest,
  UpdateNodeRequest,
  AclListResponse,
  AclEntryDto,
  SetAclRequest,
  UserDto,
  CreateUserRequest,
  UpdateUserRequest,
  ChangePasswordRequest,
  AuthConfigDto,
  UpdateAuthConfigRequest,
  UserKeysDto,
  PublicKeyDto,
  DocumentKeyDto,
  GranteeKeyDto,
  RegisterKeysRequest,
  SetDocumentKeysRequest,
} from '@oc/shared';

export type AuthFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export const treeApi = (f: AuthFetch) => ({
  getTree: () => f<TreeResponse>('/tree'),
  create: (body: CreateNodeRequest) => f<TreeNodeDto>('/nodes', { method: 'POST', body }),
  update: (id: string, body: UpdateNodeRequest) =>
    f<TreeNodeDto>(`/nodes/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => f<void>(`/nodes/${id}`, { method: 'DELETE' }),
});

export const aclApi = (f: AuthFetch) => ({
  list: (nodeId: string) => f<AclListResponse>(`/nodes/${nodeId}/acl`),
  set: (nodeId: string, body: SetAclRequest) =>
    f<AclEntryDto>(`/nodes/${nodeId}/acl`, { method: 'PUT', body }),
  remove: (nodeId: string, userId: string) =>
    f<void>(`/nodes/${nodeId}/acl/${userId}`, { method: 'DELETE' }),
});

export const usersApi = (f: AuthFetch) => ({
  list: () => f<UserDto[]>('/users'),
  create: (body: CreateUserRequest) => f<UserDto>('/users', { method: 'POST', body }),
  update: (id: string, body: UpdateUserRequest) =>
    f<UserDto>(`/users/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => f<void>(`/users/${id}`, { method: 'DELETE' }),
});

export const accountApi = (f: AuthFetch) => ({
  changePassword: (body: ChangePasswordRequest) =>
    f<void>('/auth/change-password', { method: 'POST', body }),
});

export const authConfigApi = (f: AuthFetch) => ({
  get: () => f<AuthConfigDto>('/admin/auth-config'),
  update: (body: UpdateAuthConfigRequest) =>
    f<AuthConfigDto>('/admin/auth-config', { method: 'PUT', body }),
});

export const e2eeApi = (f: AuthFetch) => ({
  registerKeys: (body: RegisterKeysRequest) => f<void>('/e2ee/keys', { method: 'POST', body }),
  myKeys: () => f<UserKeysDto>('/e2ee/keys/me'),
  publicKeys: () => f<PublicKeyDto[]>('/e2ee/public-keys'),
  grantees: (docId: string) => f<GranteeKeyDto[]>(`/e2ee/grantees/${docId}`),
  adminKeys: () => f<GranteeKeyDto[]>('/e2ee/admin-keys'),
  myDocumentKeys: () => f<DocumentKeyDto[]>('/e2ee/document-keys'),
  documentKey: (docId: string) => f<DocumentKeyDto>(`/e2ee/document-keys/${docId}`),
  setDocumentKeys: (docId: string, body: SetDocumentKeysRequest) =>
    f<void>(`/e2ee/document-keys/${docId}`, { method: 'PUT', body }),
  removeDocumentKey: (docId: string, userId: string) =>
    f<void>(`/e2ee/document-keys/${docId}/${userId}`, { method: 'DELETE' }),
});
