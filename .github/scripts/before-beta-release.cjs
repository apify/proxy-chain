const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

// eslint-disable-next-line import/no-dynamic-require
const pkgJson = require(PKG_JSON_PATH);

const PACKAGE_NAME = pkgJson.name;
const VERSION = pkgJson.version;

const nextVersion = getNextVersion(VERSION);
// eslint-disable-next-line no-console
console.log(`before-deploy: Setting version to ${nextVersion}`);
pkgJson.version = nextVersion;

fs.writeFileSync(PKG_JSON_PATH, `${JSON.stringify(pkgJson, null, 2)}\n`);

function getNextVersion(version) {
    // Query the registry directly: `pnpm view` shells to `npm view` under the hood,
    // and npm 11+ enforces `devEngines.packageManager` even on read-only commands —
    // so any package-manager CLI here trips EBADDEVENGINES. curl bypasses both.
    const registryUrl = `https://registry.npmjs.org/${PACKAGE_NAME}`;
    const json = execSync(`curl -fsSL ${registryUrl}`, { encoding: 'utf8' });
    const versions = Object.keys(JSON.parse(json).versions);

    if (versions.some((v) => v === VERSION)) {
        // eslint-disable-next-line no-console
        console.error(`before-deploy: A release with version ${VERSION} already exists. Please increment version accordingly.`);
        process.exit(1);
    }

    const prereleaseNumbers = versions
        .filter((v) => (v.startsWith(VERSION) && v.includes('-')))
        .map((v) => Number(v.match(/\.(\d+)$/)[1]));
    const lastPrereleaseNumber = Math.max(-1, ...prereleaseNumbers);
    return `${version}-beta.${lastPrereleaseNumber + 1}`;
}
