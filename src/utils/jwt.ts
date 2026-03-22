import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type UserRole = 'super_admin' | 'admin' | 'manager' | 'lead' | 'worker';

export interface JwtPayload {
  sub: string;       // user id
  email: string;
  name: string;
  role: UserRole;
  orgId?: string;       // null for super_admin
  orgSchema?: string;   // null for super_admin (e.g. "org_acmeseed")
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwt.secret) as JwtPayload;
}
