"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFactory = void 0;
const tslib_1 = require("tslib");
const http_1 = require("../../runtime/http");
const crypto_1 = require("../../runtime/crypto");
const types_1 = require("../../runtime/crypto/types");
const types_2 = require("../types");
const safe_compare_1 = require("../auth/oauth/safe-compare");
const logger_1 = require("../logger");
const types_3 = require("./types");
const registry_1 = require("./registry");
const HANDLER_PROPERTIES = {
    apiVersion: types_2.ShopifyHeader.ApiVersion,
    domain: types_2.ShopifyHeader.Domain,
    hmac: types_2.ShopifyHeader.Hmac,
    topic: types_2.ShopifyHeader.Topic,
    webhookId: types_2.ShopifyHeader.WebhookId,
};
function validateFactory(config) {
    return function validate(_a) {
        var { rawBody } = _a, adapterArgs = tslib_1.__rest(_a, ["rawBody"]);
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const request = yield (0, http_1.abstractConvertRequest)(adapterArgs);
            const log = (0, logger_1.logger)(config);
            const webhookCheck = checkWebhookRequest(rawBody, request.headers);
            if (!webhookCheck.valid) {
                yield log.debug('Received malformed webhook request', webhookCheck);
                return webhookCheck;
            }
            const { hmac, valid: _valid } = webhookCheck, loggingContext = tslib_1.__rest(webhookCheck, ["hmac", "valid"]);
            yield log.debug('Webhook request is well formed', loggingContext);
            if (yield checkWebhookHmac(config.apiSecretKey, rawBody, hmac)) {
                yield log.debug('Webhook request is valid', loggingContext);
                return webhookCheck;
            }
            else {
                yield log.debug("Webhook HMAC validation failed. Please note that events manually triggered from a store's Notifications settings will fail this validation. To test this, please use the CLI or trigger the actual event in a development store.");
                return {
                    valid: false,
                    reason: types_3.WebhookValidationErrorReason.InvalidHmac,
                };
            }
        });
    };
}
exports.validateFactory = validateFactory;
function checkWebhookRequest(rawBody, headers) {
    if (!rawBody.length) {
        return {
            valid: false,
            reason: types_3.WebhookValidationErrorReason.MissingBody,
        };
    }
    const missingHeaders = [];
    const entries = Object.entries(HANDLER_PROPERTIES);
    const headerValues = entries.reduce((acc, [property, headerName]) => {
        const headerValue = (0, http_1.getHeader)(headers, headerName);
        if (headerValue) {
            acc[property] = headerValue;
        }
        else {
            missingHeaders.push(headerName);
        }
        return acc;
    }, {});
    if (missingHeaders.length) {
        return {
            valid: false,
            reason: types_3.WebhookValidationErrorReason.MissingHeaders,
            missingHeaders,
        };
    }
    else {
        return Object.assign(Object.assign({ valid: true }, headerValues), { topic: (0, registry_1.topicForStorage)(headerValues.topic) });
    }
}
function checkWebhookHmac(secret, rawBody, hmac) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const generatedHash = yield (0, crypto_1.createSHA256HMAC)(secret, rawBody, types_1.HashFormat.Base64);
        return (0, safe_compare_1.safeCompare)(generatedHash, hmac);
    });
}
//# sourceMappingURL=validate.js.map