import type { Page } from "puppeteer-core";
import type { VerifiedIdentity } from "../coordinator/types.js";
import type { ProxyRequest } from "../proxies/types.js";

export interface PolicyContext {
  inputs: Record<string, unknown>;
  runId: string;
  signal: AbortSignal;
}
export interface FlowPolicies {
  profiles: Record<
    string,
    (
      context: PolicyContext,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>
  >;
  proxies: Record<
    string,
    (
      context: PolicyContext,
    ) => ProxyRequest | undefined | Promise<ProxyRequest | undefined>
  >;
  identities: Record<
    string,
    (
      expected: string,
      context: { page: Page; runId: string; signal: AbortSignal },
    ) => Promise<VerifiedIdentity>
  >;
}
