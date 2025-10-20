import { ConfigInterface } from '../base-types';
export declare function shopifyBilling(config: ConfigInterface): {
    check: <Params_1 extends import("./types").BillingCheckParams>({ session, plans, isTest, returnObject, }: Params_1) => Promise<import("./types").BillingCheckResponse<Params_1>>;
    request: <Params_2 extends import("./types").BillingRequestParams>({ session, plan, isTest, returnUrl: returnUrlParam, returnObject, ...overrides }: Params_2) => Promise<import("./types").BillingRequestResponse<Params_2>>;
    cancel: (subscriptionInfo: import("./types").BillingCancelParams) => Promise<import("./types").AppSubscription>;
    subscriptions: ({ session, }: import("./types").BillingSubscriptionParams) => Promise<import("./types").ActiveSubscriptions>;
};
export type ShopifyBilling = ReturnType<typeof shopifyBilling>;
//# sourceMappingURL=index.d.ts.map