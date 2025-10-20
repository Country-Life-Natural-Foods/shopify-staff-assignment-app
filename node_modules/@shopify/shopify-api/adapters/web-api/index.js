"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const runtime_1 = require("../../runtime");
const adapter_1 = require("./adapter");
(0, runtime_1.setAbstractFetchFunc)(adapter_1.webApiFetch);
(0, runtime_1.setAbstractConvertRequestFunc)(adapter_1.webApiConvertRequest);
(0, runtime_1.setAbstractConvertResponseFunc)(adapter_1.webApiConvertResponse);
(0, runtime_1.setAbstractConvertHeadersFunc)(adapter_1.webApiConvertHeaders);
(0, runtime_1.setAbstractRuntimeString)(adapter_1.webApiRuntimeString);
//# sourceMappingURL=index.js.map