import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FlowPolicies } from "./managed/policies.js";
import { digest } from "./managed/storage.js";

type Session = {
  user: string;
  stage: "method" | "code" | "account";
  expires: number;
};
function signature(key: string, text: string) {
  return createHmac("sha256", key)
    .update(`fixture-v1:${text}`)
    .digest("base64url");
}
function seal(key: string, value: unknown) {
  const text = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${text}.${signature(key, text)}`;
}
function unseal<T>(key: string, token: string): T {
  const [text, sig] = token.split(".");
  if (!text || !sig) throw new Error("Missing fixture receipt");
  const a = Buffer.from(sig),
    b = Buffer.from(signature(key, text));
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new Error("Invalid fixture receipt");
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as T;
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const document = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Workbench test site</title><style>body{font:18px system-ui;max-width:620px;margin:80px auto}label{display:block;margin:18px 0}input,button{font:inherit;padding:10px}button{margin:8px}</style><main data-test="owned-app">${body}</main></html>`;

export async function registerFixture(app: FastifyInstance, key: string) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  const read = (cookie: string | undefined): Session | undefined => {
    try {
      const s = unseal<Session>(key, cookie ?? "");
      return s.expires > Date.now() ? s : undefined;
    } catch {
      return;
    }
  };
  app.get("/signin", async (request, reply) => {
    const session = read(request.cookies.fixture);
    if (session)
      return reply.redirect(
        session.stage === "account" ? "/account" : `/verify/${session.stage}`,
      );
    return reply
      .type("text/html")
      .send(
        document(
          '<h1>Test sign-in</h1><p>Use any test username, password test-password, and code 123456.</p><form action="/fixture/signin" method="post" data-test="signin" data-ready="true"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>',
        ),
      );
  });
  app.post<{ Body: { username?: string; password?: string } }>(
    "/fixture/signin",
    async (request, reply) => {
      if (
        !request.body.username ||
        request.body.username.length > 150 ||
        request.body.password !== "test-password"
      )
        return reply
          .type("text/html")
          .send(
            document(
              '<p data-test="auth-error">Check the test credentials.</p>',
            ),
          );
      reply.setCookie(
        "fixture",
        seal(key, {
          user: request.body.username,
          stage: "method",
          expires: Date.now() + 86400_000,
        }),
        { path: "/", httpOnly: true, sameSite: "strict", maxAge: 86400 },
      );
      return reply.redirect("/verify/method");
    },
  );
  app.get("/verify/method", async (request, reply) => {
    if (!read(request.cookies.fixture)) return reply.redirect("/signin");
    return reply
      .type("text/html")
      .send(
        document(
          '<h1>Verification</h1><form method="post" action="/fixture/method" data-test="verification-methods"><button name="method" value="authenticator" data-choice-id="authenticator" data-choice-label="Authenticator" data-available="true">Authenticator</button><button name="method" value="email" data-choice-id="email" data-choice-label="Email" data-available="false" disabled>Email unavailable</button><button name="method" value="sms-1" data-choice-id="sms-1" data-choice-label="SMS" data-available="true">SMS</button></form>',
        ),
      );
  });
  app.post<{ Body: { method?: string } }>(
    "/fixture/method",
    async (request, reply) => {
      const session = read(request.cookies.fixture);
      if (!session || request.body.method !== "authenticator")
        return reply.redirect("/signin");
      reply.setCookie("fixture", seal(key, { ...session, stage: "code" }), {
        path: "/",
        httpOnly: true,
        sameSite: "strict", maxAge: 86400,
      });
      return reply.redirect("/verify/code");
    },
  );
  app.get("/verify/code", async (request, reply) => {
    if (!read(request.cookies.fixture)) return reply.redirect("/signin");
    return reply
      .type("text/html")
      .send(
        document(
          '<h1>Enter test code</h1><form method="post" action="/fixture/code" data-test="verify-code"><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Continue</button></form>',
        ),
      );
  });
  app.post<{ Body: { code?: string } }>(
    "/fixture/code",
    async (request, reply) => {
      const session = read(request.cookies.fixture);
      if (!session || session.stage !== "code")
        return reply.redirect("/signin");
      if (request.body.code !== "123456")
        return reply
          .type("text/html")
          .send(document('<p data-test="auth-error">Incorrect test code.</p>'));
      reply.setCookie("fixture", seal(key, { ...session, stage: "account" }), {
        path: "/",
        httpOnly: true,
        sameSite: "strict", maxAge: 86400,
      });
      return reply.redirect("/account");
    },
  );
  app.get("/account", async (request, reply) => {
    const session = read(request.cookies.fixture);
    if (session?.stage !== "account") return reply.redirect("/signin");
    return reply
      .type("text/html")
      .send(
        document(
          `<section data-test="account-home" data-authenticated="true"><h1>Test account</h1><p data-test="account-label">${escape(session.user)}</p><p>The flow can now bind and save this profile.</p></section>`,
        ),
      );
  });
  app.get<{ Querystring: { run?: string } }>(
    "/fixture/receipt",
    async (request, reply) => {
      const session = read(request.cookies.fixture);
      if (
        session?.stage !== "account" ||
        !/^[a-f0-9-]{36}$/.test(request.query.run ?? "")
      )
        return reply
          .code(401)
          .send({ error: "No authenticated fixture session" });
      return {
        receipt: seal(key, {
          user: session.user,
          runId: request.query.run,
          nonce: randomUUID(),
          expires: Date.now() + 300_000,
        }),
      };
    },
  );
}

export function fixturePolicies(key: string, origin: string): FlowPolicies {
  return {
    profiles: { "owned-fixture-profile": () => ({}) },
    proxies: { "owned-fixture-direct": () => undefined },
    identities: {
      "owned-session-receipt": async (expected, { page, runId, signal }) => {
        signal.throwIfAborted();
        if (new URL(page.url()).origin !== origin)
          throw new Error("Fixture origin changed");
        const token = await page.evaluate(async (run: string) => {
          const response = await fetch(
            `/fixture/receipt?run=${encodeURIComponent(run)}`,
          );
          if (!response.ok) throw new Error("No receipt");
          return ((await response.json()) as { receipt: string }).receipt;
        }, runId);
        const receipt = unseal<{
          user: string;
          runId: string;
          nonce: string;
          expires: number;
        }>(key, token);
        if (
          receipt.user !== expected ||
          receipt.runId !== runId ||
          receipt.expires <= Date.now()
        )
          throw new Error("Fixture identity mismatch");
        return {
          issuer: origin,
          subjectKey: createHmac("sha256", key)
            .update(`identity:${origin}:${receipt.user}`)
            .digest("hex"),
          hmacKeyVersion: 1,
          nonceDigest: digest(receipt.nonce),
          assertionDigest: digest(token),
          verifiedAt: new Date().toISOString(),
          expiresAt: new Date(receipt.expires).toISOString(),
        };
      },
    },
  };
}
