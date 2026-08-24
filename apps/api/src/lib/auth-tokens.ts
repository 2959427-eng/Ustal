import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";
import { loadEnv } from "@ustal/config";

export interface AccessTokenPayload {
  sub: string; // userId
}

export function signAccessToken(userId: string): string {
  const env = loadEnv();
  return jwt.sign({ sub: userId } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const env = loadEnv();
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

/**
 * Refresh-токены хранятся в БД только в виде хеша (SHA-256 достаточно —
 * это высокоэнтропийный случайный токен, не пароль пользователя, брутфорс
 * по хешу нецелесообразен) — так утечка БД не даёт валидных токенов.
 * Клиент хранит сырой токен в Keychain/Keystore через Expo SecureStore.
 */
export function generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
  const env = loadEnv();
  const token = randomBytes(48).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, hash, expiresAt };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
