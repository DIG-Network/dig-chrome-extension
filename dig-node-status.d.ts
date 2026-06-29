// Type declarations for dig-node-status.mjs — the dig-node install prompt + error mapping.

export const DIG_INSTALLER_URL: string;

/** Stable, plain-language prompt shown when a local dig-node isn't reachable. */
export interface DigNodeInstallPrompt {
  title: string;
  body: string;
  installLabel: string;
  installUrl: string;
}
export function digNodeInstallPrompt(): DigNodeInstallPrompt;

/** True when a raw failure message indicates a local dig-node is required but unreachable. */
export function isDigNodeRequiredError(rawMessage: string | null | undefined): boolean;
