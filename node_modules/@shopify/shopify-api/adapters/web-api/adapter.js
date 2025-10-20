"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webApiRuntimeString = exports.webApiFetch = exports.webApiConvertResponse = exports.webApiConvertHeaders = exports.webApiConvertRequest = void 0;
const tslib_1 = require("tslib");
const runtime_1 = require("../../runtime");
function webApiConvertRequest(adapterArgs) {
    var _a;
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const request = adapterArgs.rawRequest;
        const headers = {};
        for (const [key, value] of request.headers.entries()) {
            (0, runtime_1.addHeader)(headers, key, value);
        }
        return {
            headers,
            method: (_a = request.method) !== null && _a !== void 0 ? _a : 'GET',
            url: new URL(request.url).toString(),
        };
    });
}
exports.webApiConvertRequest = webApiConvertRequest;
function webApiConvertHeaders(headers, _adapterArgs) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const remixHeaders = new Headers();
        (0, runtime_1.flatHeaders)(headers !== null && headers !== void 0 ? headers : {}).forEach(([key, value]) => remixHeaders.append(key, value));
        return Promise.resolve(remixHeaders);
    });
}
exports.webApiConvertHeaders = webApiConvertHeaders;
function webApiConvertResponse(resp, adapterArgs) {
    var _a;
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        return new Response(resp.body, {
            status: resp.statusCode,
            statusText: resp.statusText,
            headers: yield webApiConvertHeaders((_a = resp.headers) !== null && _a !== void 0 ? _a : {}, adapterArgs),
        });
    });
}
exports.webApiConvertResponse = webApiConvertResponse;
function webApiFetch({ headers, method, url, body, }) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const resp = yield fetch(url, {
            method,
            headers: (0, runtime_1.flatHeaders)(headers),
            body,
        });
        const respBody = yield resp.text();
        return {
            statusCode: resp.status,
            statusText: resp.statusText,
            body: respBody,
            headers: (0, runtime_1.canonicalizeHeaders)(Object.fromEntries(resp.headers.entries())),
        };
    });
}
exports.webApiFetch = webApiFetch;
function webApiRuntimeString() {
    return 'Web API';
}
exports.webApiRuntimeString = webApiRuntimeString;
//# sourceMappingURL=adapter.js.map