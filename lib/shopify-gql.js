'use strict';

async function shopifyGraphql(client, query, variables, label) {
  const response = await client.request(query, { variables });
  const gql = response?.errors?.graphQLErrors;
  if (Array.isArray(gql) && gql.length > 0) {
    throw new Error(`${label}: ${gql.map((e) => e.message).join('; ')}`);
  }
  const errs = response?.errors;
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`${label}: ${errs.map((e) => e.message).join('; ')}`);
  }
  if (errs?.message) {
    throw new Error(`${label}: ${errs.message}`);
  }
  return response?.data;
}

function userErrorsMessage(userErrors) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) return '';
  return userErrors.map((e) => e.message).join('; ');
}

function isAccessDenied(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('access denied') ||
    message.includes('not authorized') ||
    message.includes('permission') ||
    message.includes("doesn't have a valid") ||
    message.includes('access scope')
  );
}

function isMissingDefinition(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('unknown type') ||
    message.includes('no metaobject definition') ||
    message.includes('does not exist') ||
    message.includes("doesn't exist")
  );
}

module.exports = {
  shopifyGraphql,
  userErrorsMessage,
  isAccessDenied,
  isMissingDefinition,
};
