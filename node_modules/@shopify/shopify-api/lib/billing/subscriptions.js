"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriptions = void 0;
const tslib_1 = require("tslib");
const error_1 = require("../error");
const graphql_client_1 = require("../clients/graphql/graphql_client");
const SUBSCRIPTION_QUERY = `
  query appSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        test
      }
  }
}
`;
function subscriptions(config) {
    return function ({ session, }) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!config.billing) {
                throw new error_1.BillingError({
                    message: 'Attempted to look for purchases without billing configs',
                    errorData: [],
                });
            }
            const GraphqlClient = (0, graphql_client_1.graphqlClientClass)({ config });
            const client = new GraphqlClient({ session });
            const response = yield client.query({
                data: {
                    query: SUBSCRIPTION_QUERY,
                },
            });
            return response.body.data.currentAppInstallation;
        });
    };
}
exports.subscriptions = subscriptions;
//# sourceMappingURL=subscriptions.js.map