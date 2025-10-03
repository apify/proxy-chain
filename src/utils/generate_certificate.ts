import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GenerateCertificateOptions {
    /**
     * Common Name for the certificate (e.g., 'localhost', '*.example.com')
     * @default 'localhost'
     */
    commonName?: string;

    /**
     * Number of days the certificate is valid for
     * @default 365
     */
    validityDays?: number;

    /**
     * Key size in bits
     * @default 2048
     */
    keySize?: number;

    /**
     * Organization name
     * @default 'Development'
     */
    organization?: string;

    /**
     * Country code (2 letters)
     * @default 'US'
     */
    countryCode?: string;
}

export interface GeneratedCertificate {
    /**
     * Private key in PEM format
     */
    key: string;

    /**
     * Certificate in PEM format
     */
    cert: string;
}

/**
 * Generates a self-signed certificate for development/testing purposes.
 * Requires OpenSSL to be installed on the system.
 *
 * @param options - Configuration options for certificate generation
 * @returns Object containing the private key and certificate in PEM format
 * @throws Error if OpenSSL is not available or certificate generation fails
 *
 * @example
 * ```typescript
 * import { generateCertificate, Server } from 'proxy-chain';
 *
 * // Generate a self-signed certificate
 * const { key, cert } = generateCertificate({
 *     commonName: 'localhost',
 *     validityDays: 365,
 * });
 *
 * // Create HTTPS proxy server
 * const server = new Server({
 *     port: 8443,
 *     serverType: 'https',
 *     httpsOptions: { key, cert },
 * });
 * ```
 */
export function generateCertificate(options: GenerateCertificateOptions = {}): GeneratedCertificate {
    const {
        commonName = 'localhost',
        validityDays = 365,
        keySize = 2048,
        organization = 'Development',
        countryCode = 'US',
    } = options;

    // Check if OpenSSL is available
    try {
        execSync('openssl version', { stdio: 'pipe' });
    } catch {
        throw new Error(
            'OpenSSL is not available. Please install OpenSSL to generate certificates.\n'
            + 'macOS: brew install openssl\n'
            + 'Ubuntu/Debian: apt-get install openssl\n'
            + 'Windows: https://slproweb.com/products/Win32OpenSSL.html',
        );
    }

    // Create temporary directory for certificate generation
    const tempDir = mkdtempSync(join(tmpdir(), 'proxy-chain-cert-'));

    try {
        const keyPath = join(tempDir, 'key.pem');
        const certPath = join(tempDir, 'cert.pem');

        // Build subject string
        const subject = `/C=${countryCode}/O=${organization}/CN=${commonName}`;

        // Generate private key and certificate in one command
        const command = `openssl req -x509 -newkey rsa:${keySize} -nodes -keyout "${keyPath}" -out "${certPath}" -days ${validityDays} -subj "${subject}"`;

        execSync(command, { stdio: 'pipe' });

        // Read generated files
        const key = readFileSync(keyPath, 'utf8');
        const cert = readFileSync(certPath, 'utf8');

        return { key, cert };
    } catch (error) {
        throw new Error(`Failed to generate certificate: ${(error as Error).message}`);
    } finally {
        // Clean up temporary directory
        rmSync(tempDir, { recursive: true, force: true });
    }
}
