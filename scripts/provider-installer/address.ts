/**
 * Installer public-address validation.
 *
 * Exports:
 * - `discoverPublicIpv4`: reaches independent observers and requires unanimous public IPv4 evidence.
 * - `normalizeSslipHostname`: derives the canonical sslip.io hostname.
 * - `validateCustomHostname`: normalizes a DNS hostname and verifies exact A-record agreement.
 */
import { isIP } from "node:net";

import type { PublicIpv4Source, ResolveIpv4 } from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const MINIMUM_INDEPENDENT_OBSERVATIONS = 2;
const HOSTNAME_MAX_LENGTH = 253;
const HOSTNAME_LABEL_MAX_LENGTH = 63;
const HOSTNAME_LABEL_PATTERN = /^(?!-)[a-z0-9-]+(?<!-)$/u;

interface Ipv4Range {
  address: number;
  prefix: number;
}

// Non-global ranges are rejected so a LAN, loopback, documentation, or multicast address cannot be published.
const NON_PUBLIC_IPV4_RANGES: readonly Ipv4Range[] = [
  { address: ipv4ToNumber("0.0.0.0"), prefix: 8 },
  { address: ipv4ToNumber("10.0.0.0"), prefix: 8 },
  { address: ipv4ToNumber("100.64.0.0"), prefix: 10 },
  { address: ipv4ToNumber("127.0.0.0"), prefix: 8 },
  { address: ipv4ToNumber("169.254.0.0"), prefix: 16 },
  { address: ipv4ToNumber("172.16.0.0"), prefix: 12 },
  { address: ipv4ToNumber("192.0.0.0"), prefix: 24 },
  { address: ipv4ToNumber("192.0.2.0"), prefix: 24 },
  { address: ipv4ToNumber("192.88.99.0"), prefix: 24 },
  { address: ipv4ToNumber("192.168.0.0"), prefix: 16 },
  { address: ipv4ToNumber("198.18.0.0"), prefix: 15 },
  { address: ipv4ToNumber("198.51.100.0"), prefix: 24 },
  { address: ipv4ToNumber("203.0.113.0"), prefix: 24 },
  { address: ipv4ToNumber("224.0.0.0"), prefix: 4 },
  { address: ipv4ToNumber("240.0.0.0"), prefix: 4 },
];

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function belongsToRange(address: string, range: Ipv4Range): boolean {
  const value = ipv4ToNumber(address);
  const mask = range.prefix === 0 ? 0 : (0xffffffff << (32 - range.prefix)) >>> 0;
  return (value & mask) >>> 0 === (range.address & mask) >>> 0;
}

function requirePublicIpv4(value: string): string {
  const address = value.trim();
  if (
    isIP(address) !== 4 ||
    NON_PUBLIC_IPV4_RANGES.some((range) => belongsToRange(address, range))
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_PUBLIC_IP_INVALID",
      `Источник вернул адрес, который не является публичным IPv4: ${address || "пустое значение"}`,
    );
  }
  return address;
}

export async function discoverPublicIpv4(
  sources: readonly PublicIpv4Source[],
): Promise<string> {
  const sourceIds = new Set(sources.map(({ id }) => id));
  if (sourceIds.size !== sources.length || sources.length < MINIMUM_INDEPENDENT_OBSERVATIONS) {
    throw new InstallerError(
      "OSINARA_INSTALL_PUBLIC_IP_SOURCES_INVALID",
      "Нужны как минимум два источника с уникальными идентификаторами",
    );
  }

  // Network failures remain unavailable evidence; a syntactically invalid observation is a hard failure.
  const settled = await Promise.allSettled(sources.map(({ observe }) => observe()));
  const observations = settled
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map(({ value }) => requirePublicIpv4(value));
  if (observations.length < MINIMUM_INDEPENDENT_OBSERVATIONS) {
    throw new InstallerError(
      "OSINARA_INSTALL_PUBLIC_IP_EVIDENCE_INSUFFICIENT",
      "Не удалось получить публичный IPv4 минимум от двух независимых источников",
    );
  }

  // Every available independent observation must agree; selecting a majority could publish the wrong host.
  const uniqueAddresses = new Set(observations);
  if (uniqueAddresses.size !== 1) {
    throw new InstallerError(
      "OSINARA_INSTALL_PUBLIC_IP_DISAGREEMENT",
      `Источники публичного IPv4 не согласны: ${[...uniqueAddresses].join(", ")}`,
    );
  }
  return observations[0] as string;
}

export function normalizeSslipHostname(publicIpv4: string): string {
  return `${requirePublicIpv4(publicIpv4).replaceAll(".", "-")}.sslip.io`;
}

function normalizeCustomHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  const labels = hostname.split(".");
  const valid =
    hostname.length <= HOSTNAME_MAX_LENGTH &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= HOSTNAME_LABEL_MAX_LENGTH &&
        HOSTNAME_LABEL_PATTERN.test(label),
    ) &&
    isIP(hostname) === 0;
  if (!valid) {
    throw new InstallerError(
      "OSINARA_INSTALL_CUSTOM_HOSTNAME_INVALID",
      "Укажите DNS-имя без протокола, пути, порта или недопустимых символов",
    );
  }
  return hostname;
}

export async function validateCustomHostname(
  value: string,
  publicIpv4: string,
  resolveIpv4: ResolveIpv4,
): Promise<string> {
  const hostname = normalizeCustomHostname(value);
  const expectedAddress = requirePublicIpv4(publicIpv4);
  let addresses: string[];
  try {
    addresses = await resolveIpv4(hostname);
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_CUSTOM_DNS_LOOKUP_FAILED",
      `Не удалось получить A-запись для ${hostname}. Проверьте DNS и повторите установку`,
      { cause: error },
    );
  }

  // Empty, malformed, or mixed A records are unsafe because requests may reach another server.
  if (
    addresses.length === 0 ||
    addresses.some((address) => isIP(address) !== 4 || address !== expectedAddress)
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_CUSTOM_DNS_MISMATCH",
      `Все A-записи ${hostname} должны указывать только на ${expectedAddress}`,
    );
  }
  return hostname;
}
