# Test Certificates

⚠️ **TEST CERTIFICATES ONLY - DO NOT USE IN PRODUCTION** ⚠️

This directory contains self-signed test certificates for automated testing purposes only. These certificates are NOT trusted by any Certificate Authority and should NEVER be used in production environments.

## Directory Structure

```
certificates/
├── valid/                   # Valid self-signed certificate for testing
│   ├── key.pem
│   └── cert.pem
├── expired/                 # Backdated certificate (expired in 2021)
│   ├── key.pem
│   └── cert.pem
├── hostname-mismatch/       # Certificate for "example.com" (hostname mismatch)
│   ├── key.pem
│   └── cert.pem
└── invalid-chain/           # Certificate chain with missing intermediate
    ├── root-ca.pem
    ├── root-ca-key.pem
    ├── leaf-cert.pem
    ├── leaf-key.pem
    └── leaf-csr.pem
```

## Certificate Details

### Valid Certificate
- **Subject:** CN=localhost
- **Valid From:** Generated date
- **Valid To:** Generated date + 365 days
- **Purpose:** Testing successful TLS connections

### Expired Certificate
- **Subject:** CN=localhost
- **Valid From:** 2020-01-01
- **Valid To:** 2020-01-02 (expired)
- **Purpose:** Testing expired certificate handling

### Hostname Mismatch Certificate
- **Subject:** CN=example.com
- **Usage:** Connect to 127.0.0.1 (triggers hostname mismatch)
- **Purpose:** Testing certificate hostname validation

### Invalid Chain Certificate
- **Structure:** Root CA → Leaf (missing intermediate)
- **Purpose:** Testing incomplete certificate chain handling

## Generation Commands

### Valid Certificate
```bash
openssl req -x509 -newkey rsa:2048 -keyout valid/key.pem -out valid/cert.pem \
    -days 365 -nodes -subj "/CN=localhost"
```

### Expired Certificate
```bash
# Requires faketime (install: brew install libfaketime on macOS)
faketime '2020-01-01' openssl req -x509 -newkey rsa:2048 \
    -keyout expired/key.pem -out expired/cert.pem \
    -days 1 -nodes -subj "/CN=localhost"
```

### Hostname Mismatch Certificate
```bash
openssl req -x509 -newkey rsa:2048 -keyout hostname-mismatch/key.pem \
    -out hostname-mismatch/cert.pem -days 365 -nodes \
    -subj "/CN=example.com"
```

### Invalid Chain Certificate
```bash
# 1. Generate root CA
openssl req -x509 -newkey rsa:2048 -keyout invalid-chain/root-ca-key.pem \
    -out invalid-chain/root-ca.pem -days 365 -nodes \
    -subj "/CN=Test Root CA"

# 2. Generate leaf certificate signing request
openssl req -newkey rsa:2048 -keyout invalid-chain/leaf-key.pem \
    -out invalid-chain/leaf-csr.pem -nodes \
    -subj "/CN=localhost"

# 3. Sign leaf with root (skipping intermediate)
openssl x509 -req -in invalid-chain/leaf-csr.pem \
    -CA invalid-chain/root-ca.pem -CAkey invalid-chain/root-ca-key.pem \
    -CAcreateserial -out invalid-chain/leaf-cert.pem -days 365
```

## Security Warnings

⚠️ **IMPORTANT SECURITY NOTICES:**

1. **Private Keys Exposed:** All private keys in this directory are committed to version control for testing purposes. These certificates must NEVER be used in production.

2. **Self-Signed:** These certificates are self-signed and not trusted by any Certificate Authority or browser.

3. **Test Only:** These certificates are solely for automated testing of TLS error handling, certificate validation, and edge cases.

4. **No Real Security:** These certificates provide NO real security and should only be used in isolated test environments.

## Regeneration

If certificates need to be regenerated (e.g., valid certificate expired), run the generation commands above from the `test/fixtures/certificates/` directory.

## Usage in Tests

These certificates are loaded by `test/utils/certificate_generator.js` and used in `test/https_edge_cases.js` for testing various TLS scenarios.
