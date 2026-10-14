import path from "path";
import { getConfigDir } from "../../config/store.js";
import { hostKeyFingerprint, isNewHostKeyAccepted, knownHostId, readKnownHosts, writeKnownHosts } from "../knownHosts.js";

/**
 * Trust for TN5250 TLS server certificates.
 *
 * A certificate that chains to a trusted CA and matches the host name is
 * accepted as is. Any other certificate (typically self-signed on IBM i) is
 * trusted on first use: its SHA-256 fingerprint is pinned per host:port in
 * known_tls_certs.json, and a different certificate later is refused unless
 * explicitly accepted.
 */

export const ACCEPT_NEW_TLS_CERT_ENV = "MCP_FOR_I_ACCEPT_NEW_TLSCERT";

export type TlsCertStatus = "ca-verified" | "trusted" | "added" | "replaced";

export class TlsCertificateMismatchError extends Error {
  constructor(
    public readonly hostKey: string,
    public readonly expected: string,
    public readonly presented: string,
    public readonly filePath: string
  ) {
    super(
      `TLS certificate for ${hostKey} has changed. Stored ${expected}, server presented ${presented}. ` +
      `This can mean a man-in-the-middle attack, so the connection was refused. ` +
      `If the change is expected (for example the certificate was renewed), ` +
      `set ${ACCEPT_NEW_TLS_CERT_ENV}=${hostKey} (or =${presented}) and connect again, ` +
      `or remove the "${hostKey}" entry from ${filePath}.`
    );
    this.name = "TlsCertificateMismatchError";
  }
}

export function getKnownTlsCertsPath() {
  return path.join(getConfigDir(), "known_tls_certs.json");
}

export type TlsCertCheckOptions = {
  host: string;
  port: number;
  /** DER-encoded leaf certificate. */
  certificate: Buffer;
  /** True when Node verified the chain and host name. */
  authorized: boolean;
  filePath?: string;
  acceptNew?: string;
};

let queue: Promise<unknown> = Promise.resolve();

export function checkTlsCertificate(options: TlsCertCheckOptions): Promise<{ status: TlsCertStatus; fingerprint: string }> {
  const fingerprint = hostKeyFingerprint(options.certificate);
  if (options.authorized) return Promise.resolve({ status: "ca-verified", fingerprint });
  const run = async () => {
    const filePath = options.filePath || getKnownTlsCertsPath();
    const acceptNew = options.acceptNew ?? process.env[ACCEPT_NEW_TLS_CERT_ENV];
    const id = knownHostId(options.host, options.port);
    const data = await readKnownHosts(filePath);
    const existing = data.hosts[id];
    const now = new Date().toISOString();
    if (existing && existing.fingerprint === fingerprint) return { status: "trusted" as const, fingerprint };
    if (existing && !isNewHostKeyAccepted(acceptNew, options.host, options.port, fingerprint)) {
      throw new TlsCertificateMismatchError(id, existing.fingerprint, fingerprint, filePath);
    }
    data.hosts[id] = { fingerprint, keyType: "x509", addedAt: existing ? existing.addedAt : now, updatedAt: now };
    await writeKnownHosts(filePath, data);
    return { status: existing ? "replaced" as const : "added" as const, fingerprint };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
