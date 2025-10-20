"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancel = void 0;
const tslib_1 = require("tslib");
const graphql_client_1 = require("../clients/graphql/graphql_client");
const error_1 = require("../error");
const CANCEL_MUTATION = `
  mutation appSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        id
        name
        test
      }
      userErrors {
        field
        message
      }
    }
  }
`;
function cancel(config) {
    return function (subscriptionInfo) {
        var _a;
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const { session, subscriptionId, prorate = true } = subscriptionInfo;
            const GraphqlClient = (0, graphql_client_1.graphqlClientClass)({ config });
            const client = new GraphqlClient({ session });
            try {
                const response = yield client.query({
                    data: {
                        query: CANCEL_MUTATION,
                        variables: {
                            id: subscriptionId,
                            prorate,
                        },
                    },
                });
                if (response.body.data.appSubscriptionCancel.userErrors.length) {
                    throw new error_1.BillingError({
                        message: 'Error while canceling a subscription',
                        errorData: response.body.data.appSubscriptionCancel.userErrors,
                    });
                }
                return response.body.data.appSubscriptionCancel.appSubscription;
            }
            catch (error) {
                if (error instanceof error_1.GraphqlQueryError) {
                    throw new error_1.BillingError({
                        message: error.message,
                        errorData: (_a = error.response) === null || _a === void 0 ? void 0 : _a.errors,
                    });
                }
                else {
                    throw error;
                }
            }
        });
    };
}
exports.cancel = cancel;
//# sourceMappingURL=cancel.js.map