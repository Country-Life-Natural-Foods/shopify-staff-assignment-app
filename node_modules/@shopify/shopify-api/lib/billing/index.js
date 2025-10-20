"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopifyBilling = void 0;
const check_1 = require("./check");
const request_1 = require("./request");
const cancel_1 = require("./cancel");
const subscriptions_1 = require("./subscriptions");
function shopifyBilling(config) {
    return {
        check: (0, check_1.check)(config),
        request: (0, request_1.request)(config),
        cancel: (0, cancel_1.cancel)(config),
        subscriptions: (0, subscriptions_1.subscriptions)(config),
    };
}
exports.shopifyBilling = shopifyBilling;
//# sourceMappingURL=index.js.map