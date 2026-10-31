import type { AuthSource } from '../constants';

export interface LoginRequest {
  username: string;
  password: string;
  /** Optional provider hint when several are enabled (e.g. 'local' | 'ldap'). */
  provider?: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  /** May change vaults' Obsidian config (community plugins) in the cloud. */
  isPluginAdmin: boolean;
  authSource: AuthSource;
}

/** Response of `POST /api/auth/login` and `/refresh`. */
export interface AuthResponse {
  user: UserDto;
  tokens: TokenPair;
}

/** Response of `GET /api/auth/me`. */
export type MeResponse = UserDto;

/** Admin: create a local user. */
export interface CreateUserRequest {
  email: string;
  displayName: string;
  password: string;
  isAdmin?: boolean;
  isPluginAdmin?: boolean;
}

/** Admin: update a user (any subset). `password` resets a local password. */
export interface UpdateUserRequest {
  displayName?: string;
  isAdmin?: boolean;
  isPluginAdmin?: boolean;
  password?: string;
}

/** Self-service: change your own (local) password. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
