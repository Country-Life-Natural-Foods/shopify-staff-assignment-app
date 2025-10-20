"use strict";
// The mutable export is the whole key to the adapter architecture.
Object.defineProperty(exports, "__esModule", { value: true });
exports.crypto = exports.setCrypto = void 0;
// eslint-disable-next-line import/no-mutable-exports
let cryptoVar;
exports.crypto = cryptoVar;
try {
    exports.crypto = cryptoVar = crypto;
}
catch (_e) {
    // This will fail for Node, but we're explicitly calling the below function to set it
}
function setCrypto(crypto) {
    exports.crypto = cryptoVar = crypto;
}
exports.setCrypto = setCrypto;
//# sourceMappingURL=crypto.js.map