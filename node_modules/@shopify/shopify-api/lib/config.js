"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = void 0;
const tslib_1 = require("tslib");
const error_1 = require("./error");
const types_1 = require("./types");
const scopes_1 = require("./auth/scopes");
const logger_1 = require("./logger");
function validateConfig(params) {
    var _a;
    const config = {
        apiKey: '',
        apiSecretKey: '',
        scopes: new scopes_1.AuthScopes([]),
        hostName: '',
        hostScheme: 'https',
        apiVersion: types_1.LATEST_API_VERSION,
        isEmbeddedApp: true,
        isCustomStoreApp: false,
        logger: {
            log: defaultLogFunction,
            level: types_1.LogSeverity.Info,
            httpRequests: false,
            timestamps: false,
        },
        future: {},
    };
    // Make sure that the essential params actually have content in them
    const mandatory = ['apiSecretKey', 'hostName'];
    if (!('isCustomStoreApp' in params) || !params.isCustomStoreApp) {
        mandatory.push('apiKey');
        mandatory.push('scopes');
    }
    if ('isCustomStoreApp' in params && params.isCustomStoreApp) {
        if (!('adminApiAccessToken' in params) ||
            ((_a = params.adminApiAccessToken) === null || _a === void 0 ? void 0 : _a.length) === 0) {
            mandatory.push('adminApiAccessToken');
        }
    }
    const missing = [];
    mandatory.forEach((key) => {
        if (!notEmpty(params[key])) {
            missing.push(key);
        }
    });
    if (missing.length) {
        throw new error_1.ShopifyError(`Cannot initialize Shopify API Library. Missing values for: ${missing.join(', ')}`);
    }
    const { hostScheme, isCustomStoreApp, adminApiAccessToken, userAgentPrefix, logger, privateAppStorefrontAccessToken, customShopDomains, billing } = params, mandatoryParams = tslib_1.__rest(params, ["hostScheme", "isCustomStoreApp", "adminApiAccessToken", "userAgentPrefix", "logger", "privateAppStorefrontAccessToken", "customShopDomains", "billing"]);
    Object.assign(config, mandatoryParams, {
        hostName: params.hostName.replace(/\/$/, ''),
        scopes: params.scopes instanceof scopes_1.AuthScopes
            ? params.scopes
            : new scopes_1.AuthScopes(params.scopes),
        hostScheme: hostScheme !== null && hostScheme !== void 0 ? hostScheme : config.hostScheme,
        isCustomStoreApp: isCustomStoreApp !== null && isCustomStoreApp !== void 0 ? isCustomStoreApp : config.isCustomStoreApp,
        adminApiAccessToken: adminApiAccessToken !== null && adminApiAccessToken !== void 0 ? adminApiAccessToken : config.adminApiAccessToken,
        userAgentPrefix: userAgentPrefix !== null && userAgentPrefix !== void 0 ? userAgentPrefix : config.userAgentPrefix,
        logger: Object.assign(Object.assign({}, config.logger), (logger || {})),
        privateAppStorefrontAccessToken: privateAppStorefrontAccessToken !== null && privateAppStorefrontAccessToken !== void 0 ? privateAppStorefrontAccessToken : config.privateAppStorefrontAccessToken,
        customShopDomains: customShopDomains !== null && customShopDomains !== void 0 ? customShopDomains : config.customShopDomains,
        billing: billing !== null && billing !== void 0 ? billing : config.billing,
    });
    if (config.isCustomStoreApp &&
        params.adminApiAccessToken === params.apiSecretKey) {
        (0, logger_1.logger)(config).warning("adminApiAccessToken is set to the same value as apiSecretKey. adminApiAccessToken should be set to the Admin API access token for custom store apps; apiSecretKey should be set to the custom store app's API secret key.");
    }
    return config;
}
exports.validateConfig = validateConfig;
function notEmpty(value) {
    if (value == null) {
        return false;
    }
    return typeof value === 'string' || Array.isArray(value)
        ? value.length > 0
        : true;
}
function defaultLogFunction(severity, message) {
    switch (severity) {
        case types_1.LogSeverity.Debug:
            console.debug(message);
            break;
        case types_1.LogSeverity.Info:
            console.log(message);
            break;
        case types_1.LogSeverity.Warning:
            console.warn(message);
            break;
        case types_1.LogSeverity.Error:
            console.error(message);
            break;
    }
}
//# sourceMappingURL=config.js.map