import { ConfigInterface } from '../base-types';
import { BillingCheckParams, BillingCheckResponse } from './types';
export declare function check(config: ConfigInterface): <Params_1 extends BillingCheckParams>({ session, plans, isTest, returnObject, }: Params_1) => Promise<BillingCheckResponse<Params_1>>;
//# sourceMappingURL=check.d.ts.map