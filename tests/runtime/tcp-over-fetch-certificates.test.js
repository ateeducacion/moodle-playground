import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  certificateToPEM,
  generateCertificate,
  privateKeyToPEM,
} from "@php-wasm/web";
import { __testing } from "../../src/runtime/php-loader.js";

const CA_DN_PATTERN =
  /(?:Subject|Issuer): CN\s*=\s*Moodle Playground CA,\s*O\s*=\s*Moodle Playground,\s*C\s*=\s*US/u;
const LOCALHOST_DN_PATTERN =
  /Subject: CN\s*=\s*localhost,\s*O\s*=\s*localhost,\s*C\s*=\s*US/u;
const TEST_LOCALHOST_DN_PATTERN =
  /Subject: CN\s*=\s*localhost,\s*O\s*=\s*Moodle Playground Test,\s*C\s*=\s*US/u;

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "moodle-playground-cert-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("tcpOverFetch certificate generation", () => {
  it("creates a CA certificate that OpenSSL recognises as a CA", async () => {
    await withTempDir(async (dir) => {
      const { CAroot } = await __testing.getTcpOverFetchOptions(null);
      const caCertPath = join(dir, "ca.crt");

      await writeFile(caCertPath, `${certificateToPEM(CAroot.certificate)}\n`);

      const certText = execFileSync(
        "openssl",
        ["x509", "-in", caCertPath, "-text", "-noout"],
        { encoding: "utf8" },
      );

      assert.match(certText, CA_DN_PATTERN);
      assert.match(certText, /X509v3 Basic Constraints:.*CA:TRUE/su);
    });
  });

  it("creates a runtime-style leaf certificate that verifies against the generated CA", async () => {
    await withTempDir(async (dir) => {
      const { CAroot } = await __testing.getTcpOverFetchOptions(null);
      const siteCert = await generateCertificate(
        {
          subject: {
            commonName: "localhost",
            organizationName: "localhost",
            countryName: "US",
          },
          issuer: CAroot.tbsDescription.subject,
        },
        CAroot.keyPair,
      );

      const caCertPath = join(dir, "ca.crt");
      const siteCertPath = join(dir, "site.crt");

      await Promise.all([
        writeFile(caCertPath, `${certificateToPEM(CAroot.certificate)}\n`),
        writeFile(siteCertPath, `${certificateToPEM(siteCert.certificate)}\n`),
      ]);

      const verifyOutput = execFileSync(
        "openssl",
        ["verify", "-CAfile", caCertPath, siteCertPath],
        { encoding: "utf8", stdio: "pipe" },
      );
      const siteText = execFileSync(
        "openssl",
        ["x509", "-in", siteCertPath, "-text", "-noout"],
        { encoding: "utf8" },
      );

      assert.match(verifyOutput, /site\.crt: OK/u);
      assert.match(siteText, CA_DN_PATTERN);
      assert.match(siteText, LOCALHOST_DN_PATTERN);
    });
  });

  it("documents the upstream ASN.1 encoder bugs when keyUsage and SAN IP extensions are used", async () => {
    await withTempDir(async (dir) => {
      const { CAroot } = await __testing.getTcpOverFetchOptions(null);
      const siteCert = await generateCertificate(
        {
          subject: {
            commonName: "localhost",
            organizationName: "Moodle Playground Test",
            countryName: "US",
          },
          issuer: CAroot.tbsDescription.subject,
          keyUsage: {
            digitalSignature: true,
            keyEncipherment: true,
          },
          extKeyUsage: {
            serverAuth: true,
          },
          subjectAltNames: {
            dnsNames: ["localhost"],
            ipAddresses: ["127.0.0.1"],
          },
          nsCertType: {
            server: true,
          },
        },
        CAroot.keyPair,
      );

      const caCertPath = join(dir, "ca.crt");
      const siteCertPath = join(dir, "site.crt");
      const siteKeyPath = join(dir, "site.key");

      await Promise.all([
        writeFile(caCertPath, `${certificateToPEM(CAroot.certificate)}\n`),
        writeFile(siteCertPath, `${certificateToPEM(siteCert.certificate)}\n`),
        writeFile(
          siteKeyPath,
          await privateKeyToPEM(siteCert.keyPair.privateKey),
        ),
      ]);

      const siteText = execFileSync(
        "openssl",
        ["x509", "-in", siteCertPath, "-text", "-noout"],
        { encoding: "utf8" },
      );
      const modulusHash = execFileSync(
        "openssl",
        ["x509", "-noout", "-modulus", "-in", siteCertPath],
        { encoding: "utf8" },
      );
      const keyModulusHash = execFileSync(
        "openssl",
        ["rsa", "-noout", "-modulus", "-in", siteKeyPath],
        { encoding: "utf8" },
      );
      let verifyError = null;
      try {
        execFileSync(
          "openssl",
          ["verify", "-CAfile", caCertPath, siteCertPath],
          { encoding: "utf8", stdio: "pipe" },
        );
      } catch (error) {
        verifyError = error;
      }

      assert.ok(verifyError, "expected OpenSSL verification to fail");
      assert.match(
        `${verifyError.stdout || ""}\n${verifyError.stderr || ""}`,
        /ASN1|header too long|unable to get local issuer certificate/u,
      );
      assert.match(siteText, CA_DN_PATTERN);
      assert.match(siteText, TEST_LOCALHOST_DN_PATTERN);
      assert.match(
        siteText,
        /X509v3 Extended Key Usage:.*TLS Web Server Authentication/su,
      );
      assert.match(
        siteText,
        /X509v3 Key Usage:.*Certificate Sign, Encipher Only/su,
      );
      assert.match(
        siteText,
        /X509v3 Subject Alternative Name:.*IP Address:<invalid>/su,
      );
      assert.strictEqual(modulusHash.trim(), keyModulusHash.trim());
    });
  });
});
