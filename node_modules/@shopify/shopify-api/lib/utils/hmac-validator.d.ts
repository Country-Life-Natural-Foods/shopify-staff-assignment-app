import { ConfigInterface } from '../base-types';
import { AuthQuery } from '../auth/oauth/types';
export type HMACSignator = 'admin' | 'appProxy';
export declare function generateLocalHmac(config: ConfigInterface): (params: AuthQuery, signator?: HMACSignator) => Promise<string>;
export declare function validateHmac(config: ConfigInterface): (query: AuthQuery, { signator }?: {
    signator: HMACSignator;
}) => Promise<boolean>;
export declare function getCurrentTimeInSec(): number;
//# sourceMappingURL=hmac-validator.d.ts.map