/**
 * Google Workspace OAuth initiation service.
 *
 * Export:
 * - `createGoogleWorkspaceAuthorizationStarter`: injectable at-most-once link initiation boundary.
 * - `startGoogleWorkspaceAuthorization`: stores one-time state and privately delivers consent URL.
 */
import { randomBytes } from "node:crypto";

import {
  GOOGLE_OAUTH_STATE_TTL_MILLISECONDS,
  requireGoogleOAuthEnvironment,
} from "./google-workspace-config.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { googleIntegrationRepository } from "./google-integration-repository.js";
import { buildGoogleAuthorizationUrl } from "./google-oauth-client.js";
import { deliverGoogleAuthorizationLink } from "./google-oauth-delivery.js";

interface GoogleWorkspaceAuthorizationStarterDependencies {
  buildAuthorizationUrl: typeof buildGoogleAuthorizationUrl;
  completeAuthorizationDelivery: typeof googleIntegrationRepository.completeAuthorizationDelivery;
  createAuthorization: typeof googleIntegrationRepository.createAuthorization;
  deliverAuthorizationLink: typeof deliverGoogleAuthorizationLink;
  getConfig: typeof requireGoogleOAuthEnvironment;
  randomState(): string;
}

interface GoogleWorkspaceAuthorizationStartResult {
  expiresAt: string;
  notice: string;
  pending: boolean;
  ready: false;
}

export function createGoogleWorkspaceAuthorizationStarter(
  dependencies: GoogleWorkspaceAuthorizationStarterDependencies,
) {
  return async function startAuthorization(
    auth: GoogleIntegrationAuthorization,
    now = new Date(),
  ): Promise<GoogleWorkspaceAuthorizationStartResult> {
    // Required provider configuration is validated before any durable state or delivery side effect.
    const config = dependencies.getConfig();
    const rawState = dependencies.randomState();
    const expiresAt = new Date(now.getTime() + GOOGLE_OAUTH_STATE_TTL_MILLISECONDS);
    const authorization = await dependencies.createAuthorization(auth, { expiresAt, rawState });
    if (!authorization.created) {
      return {
        expiresAt: authorization.expiresAt,
        notice: authorization.deliveryCompleted
          ? auth.scope === "family"
            ? "Ссылка для подключения общего Google Workspace уже отправлена владельцу в личный чат."
            : "Ссылка для подключения Google Workspace уже отправлена в личный чат."
          : "Отправка ссылки Google Workspace уже начата, но её результат не подтверждён. Проверьте личный чат или повторите подключение после истечения ссылки.",
        pending: true,
        ready: false,
      };
    }

    // The row is marked started before transport. A crash or ambiguous Telegram failure leaves one
    // valid link and blocks duplicate delivery without falsely claiming that Telegram confirmed it.
    await dependencies.deliverAuthorizationLink(
      auth.telegramUserId,
      dependencies.buildAuthorizationUrl(config, rawState),
      expiresAt,
    );
    await dependencies.completeAuthorizationDelivery(auth, authorization.authorizationId);
    return {
      expiresAt: authorization.expiresAt,
      notice: auth.scope === "family"
        ? "Ссылка для подключения общего Google Workspace отправлена владельцу в личный чат."
        : "Ссылка для подключения Google Workspace отправлена в личный чат.",
      pending: true,
      ready: false,
    };
  };
}

export const startGoogleWorkspaceAuthorization = createGoogleWorkspaceAuthorizationStarter({
  buildAuthorizationUrl: buildGoogleAuthorizationUrl,
  completeAuthorizationDelivery: googleIntegrationRepository.completeAuthorizationDelivery,
  createAuthorization: googleIntegrationRepository.createAuthorization,
  deliverAuthorizationLink: deliverGoogleAuthorizationLink,
  getConfig: requireGoogleOAuthEnvironment,
  randomState: () => randomBytes(32).toString("base64url"),
});
