const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Load certificate fixtures from the test/fixtures/certificates directory
 * @param {string} type - Certificate type: 'valid', 'expired', 'hostname-mismatch', 'invalid-chain'
 * @returns {{ key: Buffer, cert: Buffer, ca?: Buffer }} Certificate key and cert pair
 */
exports.loadCertificate = (type) => {
    const certDir = path.join(__dirname, '../fixtures/certificates', type);

    const result = {
        key: fs.readFileSync(path.join(certDir, type === 'invalid-chain' ? 'leaf-key.pem' : 'key.pem')),
        cert: fs.readFileSync(path.join(certDir, type === 'invalid-chain' ? 'leaf-cert.pem' : 'cert.pem')),
    };

    // For invalid-chain, also load the root CA (but not the intermediate, which is missing)
    if (type === 'invalid-chain') {
        result.ca = fs.readFileSync(path.join(certDir, 'root-ca.pem'));
    }

    return result;
};

/**
 * Verify certificate properties using Node.js crypto.X509Certificate
 * @param {Buffer|string} cert - Certificate in PEM format
 * @returns {Object} Certificate properties
 */
exports.verifyCertificate = (cert) => {
    const x509 = new crypto.X509Certificate(cert);

    return {
        subject: x509.subject,
        issuer: x509.issuer,
        validFrom: x509.validFrom,
        validTo: x509.validTo,
        subjectAltName: x509.subjectAltName,
        isExpired: Date.now() > new Date(x509.validTo),
        serialNumber: x509.serialNumber,
        fingerprint: x509.fingerprint,
        fingerprint256: x509.fingerprint256,
    };
};

/**
 * Check if certificate matches hostname
 * @param {Buffer|string} cert - Certificate in PEM format
 * @param {string} hostname - Hostname to check
 * @returns {boolean} True if certificate matches hostname
 */
exports.certificateMatchesHostname = (cert, hostname) => {
    const x509 = new crypto.X509Certificate(cert);
    // checkHost returns undefined if the certificate doesn't match
    // Returns the hostname if it matches
    return x509.checkHost(hostname) !== undefined;
};
