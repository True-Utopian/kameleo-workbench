import { randomBytes, timingSafeEqual } from 'node:crypto';

export class AccessControl {
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private token: string, private now = Date.now) {}
  matches(candidate: string): boolean {
    const actual = Buffer.from(candidate);
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  login(token: string, address: string): string {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until < now) this.attempts.delete(key);
    const bucket = this.attempts.get(address) ?? { count: 0, until: now + 60_000 };
    if (bucket.count >= 10 || this.attempts.size > 10_000) throw Object.assign(new Error('Too many sign-in attempts. Try again in a minute.'), { statusCode: 429 });
    bucket.count++; this.attempts.set(address, bucket);
    if (!this.matches(token)) throw Object.assign(new Error('Invalid access token.'), { statusCode: 401 });
    this.attempts.delete(address);
    for (const [id, expiry] of this.sessions) if (expiry < now) this.sessions.delete(id);
    if (this.sessions.size >= 1000) throw Object.assign(new Error('Too many active sessions.'), { statusCode: 429 });
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, now + 12 * 60 * 60 * 1000);
    return id;
  }
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const expiry = this.sessions.get(id);
    if (expiry === undefined) return false;
    if (expiry < this.now()) { this.sessions.delete(id); return false; }
    return true;
  }
  logout(id: string | undefined): void { if (id) this.sessions.delete(id); }
}
