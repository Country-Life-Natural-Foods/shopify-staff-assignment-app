"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enableCodeAfterVersion = void 0;
const compare_versions_1 = require("compare-versions");
const version_1 = require("../version");
function enableCodeAfterVersion(version, fn) {
    if ((0, compare_versions_1.compare)(version_1.SHOPIFY_API_LIBRARY_VERSION, version, '>=')) {
        fn();
    }
}
exports.enableCodeAfterVersion = enableCodeAfterVersion;
//# sourceMappingURL=versioned-codeblocks.js.map