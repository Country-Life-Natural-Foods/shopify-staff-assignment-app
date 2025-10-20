"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.process = void 0;
const tslib_1 = require("tslib");
const network_1 = require("@shopify/network");
const http_1 = require("../../runtime/http");
const ShopifyErrors = tslib_1.__importStar(require("../error"));
const logger_1 = require("../logger");
const types_1 = require("./types");
const validate_1 = require("./validate");
const STATUS_TEXT_LOOKUP = {
    [network_1.StatusCode.Ok]: 'OK',
    [network_1.StatusCode.BadRequest]: 'Bad Request',
    [network_1.StatusCode.Unauthorized]: 'Unauthorized',
    [network_1.StatusCode.NotFound]: 'Not Found',
    [network_1.StatusCode.InternalServerError]: 'Internal Server Error',
};
function process(config, webhookRegistry) {
    return function process(_a) {
        var { rawBody } = _a, adapterArgs = tslib_1.__rest(_a, ["rawBody"]);
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const response = {
                statusCode: network_1.StatusCode.Ok,
                statusText: STATUS_TEXT_LOOKUP[network_1.StatusCode.Ok],
                headers: {},
            };
            yield (0, logger_1.logger)(config).info('Receiving webhook request');
            const webhookCheck = yield (0, validate_1.validateFactory)(config)(Object.assign({ rawBody }, adapterArgs));
            let errorMessage = 'Unknown error while handling webhook';
            if (webhookCheck.valid) {
                const handlerResult = yield callWebhookHandlers(config, webhookRegistry, webhookCheck, rawBody);
                response.statusCode = handlerResult.statusCode;
                if (!(0, http_1.isOK)(response)) {
                    errorMessage = handlerResult.errorMessage || errorMessage;
                }
            }
            else {
                const errorResult = yield handleInvalidWebhook(config, webhookCheck);
                response.statusCode = errorResult.statusCode;
                response.statusText = STATUS_TEXT_LOOKUP[response.statusCode];
                errorMessage = errorResult.errorMessage;
            }
            const returnResponse = yield (0, http_1.abstractConvertResponse)(response, adapterArgs);
            if (!(0, http_1.isOK)(response)) {
                throw new ShopifyErrors.InvalidWebhookError({
                    message: errorMessage,
                    response: returnResponse,
                });
            }
            return Promise.resolve(returnResponse);
        });
    };
}
exports.process = process;
function callWebhookHandlers(config, webhookRegistry, webhookCheck, rawBody) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const log = (0, logger_1.logger)(config);
        const { hmac: _hmac, valid: _valid } = webhookCheck, loggingContext = tslib_1.__rest(webhookCheck, ["hmac", "valid"]);
        yield log.debug('Webhook request is valid, looking for HTTP handlers to call', loggingContext);
        const handlers = webhookRegistry[webhookCheck.topic] || [];
        const response = { statusCode: network_1.StatusCode.Ok };
        let found = false;
        for (const handler of handlers) {
            if (handler.deliveryMethod !== types_1.DeliveryMethod.Http) {
                continue;
            }
            if (!handler.callback) {
                response.statusCode = network_1.StatusCode.InternalServerError;
                response.errorMessage =
                    "Cannot call webhooks.process with a webhook handler that doesn't have a callback";
                throw new ShopifyErrors.MissingWebhookCallbackError({
                    message: response.errorMessage,
                    response,
                });
            }
            found = true;
            yield log.debug('Found HTTP handler, triggering it', loggingContext);
            try {
                yield handler.callback(webhookCheck.topic, webhookCheck.domain, rawBody, webhookCheck.webhookId, webhookCheck.apiVersion);
            }
            catch (error) {
                response.statusCode = network_1.StatusCode.InternalServerError;
                response.errorMessage = error.message;
            }
        }
        if (!found) {
            yield log.debug('No HTTP handlers found', loggingContext);
            response.statusCode = network_1.StatusCode.NotFound;
            response.errorMessage = `No HTTP webhooks registered for topic ${webhookCheck.topic}`;
        }
        return response;
    });
}
function handleInvalidWebhook(config, webhookCheck) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const response = {
            statusCode: network_1.StatusCode.InternalServerError,
            errorMessage: 'Unknown error while handling webhook',
        };
        switch (webhookCheck.reason) {
            case types_1.WebhookValidationErrorReason.MissingHeaders:
                response.statusCode = network_1.StatusCode.BadRequest;
                response.errorMessage = `Missing one or more of the required HTTP headers to process webhooks: [${webhookCheck.missingHeaders.join(', ')}]`;
                break;
            case types_1.WebhookValidationErrorReason.MissingBody:
                response.statusCode = network_1.StatusCode.BadRequest;
                response.errorMessage = 'No body was received when processing webhook';
                break;
            case types_1.WebhookValidationErrorReason.InvalidHmac:
                response.statusCode = network_1.StatusCode.Unauthorized;
                response.errorMessage = `Could not validate request HMAC`;
                break;
        }
        yield (0, logger_1.logger)(config).debug(`Webhook request is invalid, returning ${response.statusCode}: ${response.errorMessage}`);
        return response;
    });
}
//# sourceMappingURL=process.js.map