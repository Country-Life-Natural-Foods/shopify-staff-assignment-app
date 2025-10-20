"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.versionPriorTo = exports.versionCompatible = void 0;
const types_1 = require("../types");
function versionCompatible(config) {
    return (referenceVersion, currentVersion = config.apiVersion) => {
        // Return true if not using a dated version
        if (currentVersion === types_1.ApiVersion.Unstable) {
            return true;
        }
        const numericVersion = (version) => parseInt(version.replace('-', ''), 10);
        const current = numericVersion(currentVersion);
        const reference = numericVersion(referenceVersion);
        return current >= reference;
    };
}
exports.versionCompatible = versionCompatible;
function versionPriorTo(config) {
    return (referenceVersion, currentVersion = config.apiVersion) => {
        return !versionCompatible(config)(referenceVersion, currentVersion);
    };
}
exports.versionPriorTo = versionPriorTo;
//# sourceMappingURL=version-compatible.js.map