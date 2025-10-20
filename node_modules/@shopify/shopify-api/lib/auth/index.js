"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopifyAuth = void 0;
const oauth_1 = require("./oauth/oauth");
const nonce_1 = require("./oauth/nonce");
const safe_compare_1 = require("./oauth/safe-compare");
const get_embedded_app_url_1 = require("./get-embedded-app-url");
const token_exchange_1 = require("./oauth/token-exchange");
function shopifyAuth(config) {
    var _a;
    const shopify = {
        begin: (0, oauth_1.begin)(config),
        callback: (0, oauth_1.callback)(config),
        nonce: nonce_1.nonce,
        safeCompare: safe_compare_1.safeCompare,
        getEmbeddedAppUrl: (0, get_embedded_app_url_1.getEmbeddedAppUrl)(config),
        buildEmbeddedAppUrl: (0, get_embedded_app_url_1.buildEmbeddedAppUrl)(config),
    };
    if ((_a = config.future) === null || _a === void 0 ? void 0 : _a.unstable_tokenExchange) {
        shopify.tokenExchange = (0, token_exchange_1.tokenExchange)(config);
    }
    return shopify;
}
exports.shopifyAuth = shopifyAuth;
//# sourceMappingURL=index.js.map