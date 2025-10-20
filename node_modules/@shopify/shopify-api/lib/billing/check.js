"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.check = void 0;
const tslib_1 = require("tslib");
const graphql_client_1 = require("../clients/graphql/graphql_client");
const error_1 = require("../error");
function check(config) {
    return function check({ session, plans, isTest = true, returnObject = false, }) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!config.billing) {
                throw new error_1.BillingError({
                    message: 'Attempted to look for purchases without billing configs',
                    errorData: [],
                });
            }
            const GraphqlClient = (0, graphql_client_1.graphqlClientClass)({ config });
            const client = new GraphqlClient({ session });
            const plansArray = Array.isArray(plans) ? plans : [plans];
            return assessPayments({
                plans: plansArray,
                client,
                isTest,
                returnObject,
            });
        });
    };
}
exports.check = check;
function assessPayments({ plans, client, isTest, returnObject, }) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const returnValue = returnObject
            ? {
                hasActivePayment: false,
                oneTimePurchases: [],
                appSubscriptions: [],
            }
            : false;
        let installation;
        let endCursor = null;
        do {
            const currentInstallations = yield client.query({
                data: {
                    query: HAS_PAYMENTS_QUERY,
                    variables: { endCursor },
                },
            });
            installation = currentInstallations.body.data.currentAppInstallation;
            if (returnObject) {
                installation.activeSubscriptions.map((subscription) => {
                    if (subscriptionMeetsCriteria({ plans, isTest, subscription })) {
                        returnValue.hasActivePayment = true;
                        returnValue.appSubscriptions.push(subscription);
                    }
                });
                installation.oneTimePurchases.edges.map((purchase) => {
                    if (purchaseMeetsCriteria({ plans, isTest, purchase: purchase.node })) {
                        returnValue.hasActivePayment = true;
                        returnValue.oneTimePurchases.push(purchase.node);
                    }
                });
            }
            else {
                const params = { plans, isTest, installation };
                if (hasSubscription(params) || hasOneTimePayment(params)) {
                    return true;
                }
            }
            endCursor = installation.oneTimePurchases.pageInfo.endCursor;
        } while (installation === null || installation === void 0 ? void 0 : installation.oneTimePurchases.pageInfo.hasNextPage);
        return returnValue;
    });
}
function subscriptionMeetsCriteria({ plans, isTest, subscription, }) {
    return plans.includes(subscription.name) && (isTest || !subscription.test);
}
function purchaseMeetsCriteria({ plans, isTest, purchase, }) {
    return (plans.includes(purchase.name) &&
        (isTest || !purchase.test) &&
        purchase.status === 'ACTIVE');
}
function hasSubscription({ plans, isTest, installation, }) {
    return installation.activeSubscriptions.some((subscription) => subscriptionMeetsCriteria({ plans, isTest, subscription }));
}
function hasOneTimePayment({ plans, isTest, installation, }) {
    return installation.oneTimePurchases.edges.some((purchase) => purchaseMeetsCriteria({ plans, isTest, purchase: purchase.node }));
}
const HAS_PAYMENTS_QUERY = `
  query appSubscription($endCursor: String) {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        test
      }

      oneTimePurchases(first: 250, sortKey: CREATED_AT, after: $endCursor) {
        edges {
          node {
            id
            name
            test
            status
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
//# sourceMappingURL=check.js.map